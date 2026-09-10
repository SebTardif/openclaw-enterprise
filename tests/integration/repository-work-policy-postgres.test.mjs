import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { canonicalRepositoryWorkV2 } from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import { createPostgresRepositoryWorkPolicyV2 } from "../../packages/occ/src/state/postgres/repository-work-policy-v2.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

// Real PostgreSQL, original State owners, NativeIAM and inventory transitions.
// Work/native/account/custody admission boundaries are explicit fixture sources;
// these tests establish no native Session, key custody, provider or GitHub flow.
// The custodian provisions one dedicated, migrated, seeded database. This file
// never creates/drops databases, installs DDL, changes roles or resets a fixture.
const configPath = process.env.OCC_REPOSITORY_WORK_PG_CONFIG;
const canonical = canonicalRepositoryWorkV2;
const same = (actual, expected) => assert.equal(canonical(actual), canonical(expected));
const digest = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const ref = (label) => `${label}-${randomUUID()}`;
const textOf = (statement) => (typeof statement === "string" ? statement : statement.text);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function configuration() {
  const metadata = await stat(configPath);
  assert.ok(
    metadata.isFile() && (metadata.mode & 0o077) === 0,
    "The custodian configuration must be an owner-only regular file.",
  );
  assert.equal(metadata.uid, process.getuid());
  const value = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.ok(Date.parse(value.expiresAt) > Date.now(), "The fixture allocation expired.");
  const url = new URL(value.connectionString);
  assert.equal(url.protocol, "postgresql:");
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.username), "occ_app");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), value.database);
  assert.match(value.database, /^(oce|openclaw)_state_[a-z0-9_]+$/);
  for (const key of ["installationId", "namespaceId", "agentId"])
    assert.match(value.scope[key], /^(ins|ns|agt)_[0-9a-f-]{36}$/);
  assert.equal(typeof value.servicePrincipalId, "string");
  assert.equal(typeof value.operatorPrincipalId, "string");
  return value;
}

// A per-State wrapper delegates EVERY statement to the real client. Its sole
// fault injection discards one *actual completed* COMMIT response, never its SQL.
function wire(pool) {
  const events = [];
  let loseNextCommit = false;
  return {
    events,
    loseCommitAcknowledgment() {
      loseNextCommit = true;
    },
    source: {
      options: pool.options,
      async connect() {
        const client = await pool.connect();
        return {
          on: client.on.bind(client),
          removeListener: client.removeListener.bind(client),
          async query(statement, values) {
            const text = textOf(statement);
            events.push({ kind: "sent", text, pid: client.processID });
            const result = await client.query(statement, values);
            events.push({ kind: "ack", text, pid: client.processID });
            if (text === "COMMIT" && loseNextCommit) {
              loseNextCommit = false;
              throw Object.assign(new Error("Injected loss after real COMMIT acknowledgment"), {
                code: "08006",
              });
            }
            return result;
          },
          release(destroy) {
            events.push({ kind: "release", destroy, pid: client.processID });
            client.release(destroy);
          },
        };
      },
      async end() {},
    },
  };
}

function fixture(pool, config) {
  const transport = wire(pool);
  const state = new PostgresPlatformState(transport.source);
  const binding = state.repositoryWorkBindingV2();
  const members = new WeakMap();
  const receiver = Object.freeze({ fixture: ref("receiver") });
  const session = Object.freeze({ fixture: ref("session") });
  const receiverRef = ref("receiver"),
    sessionRef = ref("session");
  const scope = { ...config.scope, revisionRef: ref("revision") };
  const originalScope = {
    installationRef: scope.installationId,
    namespaceRef: scope.namespaceId,
    agentRef: scope.agentId,
    revisionRef: scope.revisionRef,
  };
  const requestDigest = digest({ fixture: ref("request"), scope });
  const originals = new Map();
  const heads = new Map();
  const releases = [];
  let prepareFailure;
  let failureAfterAudit;
  function original(label, expected = {}) {
    const value = Object.freeze({
      operationRef: ref(label),
      invocationRef: ref("invocation"),
      requestDigest,
      scope: originalScope,
    });
    originals.set(value.operationRef, value);
    members.set(value, { ...expected, calls: new WeakSet() });
    return value;
  }
  function callFor(value) {
    assert.ok(members.has(value), "Fixture must enroll the original operation identity.");
    const call = Object.freeze({
      context: Object.freeze({}),
      requestRef: ref("request"),
      recipientRef: "state-pg-fixture",
      deadline: new Date(Date.now() + 15000).toISOString(),
      signal: new AbortController().signal,
    });
    members.get(value).calls.add(call);
    return call;
  }
  function acquire(context, value, call, kind) {
    binding.participant.assertOriginal(context, value, call);
    const registered = members.get(value);
    assert.ok(registered && registered.calls.has(call));
    let live = true;
    const held = {
      assertCurrent() {
        assert.ok(live && !call.signal.aborted && Date.parse(call.deadline) > Date.now());
        if (
          failureAfterAudit &&
          transport.events
            .slice(failureAfterAudit.since)
            .some((e) => e.kind === "ack" && e.text.startsWith("INSERT INTO occ.audit_events"))
        )
          throw failureAfterAudit.error;
        return undefined;
      },
      async prepareCommit() {
        if (prepareFailure) throw prepareFailure;
      },
      async release() {
        assert.ok(live);
        live = false;
        releases.push(kind);
      },
    };
    const inventory = async (facts) => {
      same(facts.input, registered.inventory);
      if (["reserveRepositoryToken", "claimRepositoryMint"].includes(facts.input.method))
        assert.ok(facts.readset?.lineage.length);
    };
    if (kind === "custody")
      return {
        ...held,
        receiver,
        session,
        receiverRef,
        sessionRef,
        inventoryClock: { read: () => ({ now: Date.now(), uncertaintyMs: 1 }) },
        qualifyInventory: inventory,
        async qualifyInventoryRead(operation) {
          if (operation) assert.equal(operation.input.operationRef, value.operationRef);
        },
        async stageRelease(input) {
          same(input, registered.dispatch);
        },
      };
    return {
      ...held,
      actorId: config.servicePrincipalId,
      async qualifyAdmission(input) {
        same(input, registered.admission);
      },
      async qualifyReadset(readset) {
        same(readset.scope, scope);
        assert.ok(readset.lineage.length);
        for (const record of readset.lineage) same(record, heads.get(record.workRef));
      },
      async qualifyClosure(readset, input) {
        same(input, registered.closure);
        assert.equal(readset.lineage.at(-1).workRef, input.workRef);
      },
      async qualifyObservation(operation, input) {
        same(input, registered.observation);
        assert.equal(operation.operationRef, input.dispatchOperationRef);
      },
      qualifyInventory: inventory,
      async qualifyInventoryRead(operation) {
        if (operation) assert.equal(operation.input.operationRef, value.operationRef);
      },
    };
  }
  const store = binding.bindOriginalSources(
    {
      async acquire(...args) {
        return acquire(...args, "work");
      },
    },
    {
      async acquire(...args) {
        return acquire(...args, "custody");
      },
    },
  );
  const run = (value, body) => {
    const call = callFor(value);
    return store.run(value, call, { signal: call.signal, timeoutMs: 3000 }, body);
  };
  const recover = (value) => {
    const call = callFor(value);
    return store.recoverAfterUnwind(value, call, { signal: call.signal, timeoutMs: 3000 });
  };
  const execution = {
    attempt: {
      ...originalScope,
      conversationRef: ref("conversation"),
      turnRef: ref("turn"),
      attemptRef: ref("attempt"),
      reservationRef: ref("reservation"),
    },
    assignmentRef: ref("assignment"),
    assignmentVersion: "1",
    executionIncarnationRef: ref("incarnation"),
    executionGeneration: "1",
    receiverRef,
    protectedOriginRef: ref("origin"),
    executionProfile: { ref: "execution-profile", revision: "1" },
    predecessor: { kind: "none" },
  };
  // ExactAttempt has no revisionRef member; the operation scope retains it.
  delete execution.attempt.revisionRef;
  const target = {
    installationId: scope.installationId,
    githubHost: "github.com",
    appId: "100",
    githubInstallationId: "200",
    repositoryId: String(100000 + Math.floor(Math.random() * 900000000)),
  };
  async function admit(parent) {
    const workRef = ref("work");
    const record = {
      scope,
      workRef,
      revision: 1,
      withdrawalRevision: 0,
      parentWorkRef: parent?.workRef ?? null,
      rootWorkRef: parent?.rootWorkRef ?? workRef,
      originalHorizon: parent?.originalHorizon ?? new Date(Date.now() + 300000).toISOString(),
      state: "open",
      execution,
      policy: { fixturePolicyRef: ref("policy") },
      originalAdmission: { fixtureAdmissionRef: ref("admission"), execution },
    };
    const value = original("admission", { admission: { record } });
    const result = await run(value, (unit) => unit.stageAdmission({ record }));
    assert.equal(result.kind, "committed");
    heads.set(workRef, record);
    return { ...record, original: value };
  }
  const workOf = (record) => ({ workRef: record.workRef, revision: record.revision });
  async function prepare(record) {
    const input = {
      workRef: record.workRef,
      workRevision: record.revision,
      requestDigest,
      receiverRef,
      sessionRef,
      dnsBindingRef: ref("dns"),
      repositoryTarget: target,
    };
    const value = original("preparation");
    const result = await run(value, async (unit) => {
      await unit.readForMutation(workOf(record), execution);
      await unit.stagePreparation(input);
    });
    assert.equal(result.kind, "committed");
    return { input, original: value, result };
  }
  async function inventory(input, record, value) {
    value ??= original(input.method, { inventory: input });
    // An operation ref is generated before its immutable mutation is enrolled.
    if (input.operationRef !== value.operationRef)
      input = { ...input, operationRef: value.operationRef };
    members.get(value).inventory = input;
    const result = await run(value, async (unit) => {
      if (["reserveRepositoryToken", "claimRepositoryMint"].includes(input.method))
        await unit.readForMutation(workOf(record), execution);
      return unit.stageRepositoryInventory(input);
    });
    return { original: value, input, result };
  }
  async function reserve(record, businessOriginal) {
    const now = new Date().toISOString();
    return inventory(
      {
        schemaVersion: 2,
        method: "reserveRepositoryToken",
        operationRef: "unassigned",
        scope: config.scope,
        createdAt: now,
        lease: {
          schemaVersion: 2,
          accessLeaseRef: ref("lease"),
          target,
          original: businessOriginal,
          work: workOf(record),
          execution,
          createdAt: now,
          notAfter: record.originalHorizon,
        },
        bindingRef: ref("binding"),
        permissionProfile: { ref: "repository-profile", revision: "1" },
        requestedPermissions: { metadata: "read" },
        deadline: record.originalHorizon,
      },
      record,
    );
  }
  async function minted(record, businessOriginal) {
    const reserved = await reserve(record, businessOriginal);
    assert.equal(reserved.result.kind, "committed");
    assert.equal(reserved.result.value.kind, "staged");
    const stored = reserved.result.value.operation.record;
    const providerAttemptRef = ref("provider-attempt");
    const tokenRef = ref("token"),
      protectedRevocationRef = ref("revocation");
    const claimed = await inventory(
      {
        schemaVersion: 2,
        method: "claimRepositoryMint",
        operationRef: "unassigned",
        scope: config.scope,
        createdAt: new Date().toISOString(),
        target: stored.target,
        expectedInventoryVersion: stored.inventoryVersion,
        providerAttemptRef,
        custodyIdentity: {
          lease: stored.issuance.lease,
          key: {
            clientId: "client",
            bindingRef: stored.issuance.bindingRef,
            immutableVersion: "key-1",
          },
          providerAttemptRef,
          tokenRef,
          protectedRevocationRef,
        },
      },
      record,
    );
    assert.equal(claimed.result.kind, "committed");
    assert.equal(claimed.result.value.operation.record.state, "mint-unknown");
    // This is fixture evidence, never an HTTP request or real captured token.
    const accepted = await inventory(
      {
        schemaVersion: 2,
        method: "recordRepositoryMint",
        operationRef: "unassigned",
        scope: config.scope,
        createdAt: new Date().toISOString(),
        target: stored.target,
        expectedInventoryVersion: claimed.result.value.operation.record.inventoryVersion,
        providerAttemptRef,
        outcome: "accepted",
        evidenceRef: ref("response"),
        tokenRef,
        protectedRevocationRef,
        returnedPermissions: { metadata: "read" },
        scopeAccepted: true,
        expiry: {
          kind: "provider-expiry",
          expiresAt: record.originalHorizon,
          observedAt: new Date().toISOString(),
          evidenceRef: ref("expiry"),
        },
      },
      record,
    );
    assert.equal(accepted.result.kind, "committed");
    assert.equal(accepted.result.value.operation.record.state, "outstanding");
    return { reserved, claimed, accepted, row: accepted.result.value.operation.record };
  }
  async function ready() {
    const record = await admit();
    const preparation = await prepare(record);
    const businessOriginal = original("dispatch");
    const token = await minted(record, businessOriginal);
    const input = {
      ...preparation.input,
      preparationOperationRef: preparation.original.operationRef,
      accessLeaseRef: token.row.issuance.lease.accessLeaseRef,
      inventoryRecordRef: token.row.target.recordRef,
      inventoryVersion: token.row.inventoryVersion,
      releaseRef: ref("release"),
    };
    members.get(businessOriginal).dispatch = input;
    const dispatch = () =>
      run(businessOriginal, async (unit) => {
        await unit.readForMutation(workOf(record), execution);
        await unit.stageDispatchAndRelease(input);
      });
    return { record, preparation, token, input, businessOriginal, dispatch };
  }
  async function close(record, cause = "withdrawn") {
    const input = {
      workRef: record.workRef,
      expectedRevision: record.revision,
      expectedWithdrawalRevision: record.withdrawalRevision,
      cause,
      evidenceRef: ref("closure"),
    };
    const value = original("closure", { closure: input });
    const result = await run(value, async (unit) => {
      await unit.readForMutation(workOf(record), execution);
      await unit.stageClosure(input);
    });
    return { original: value, result };
  }
  return {
    state,
    binding,
    store,
    transport,
    members,
    originals,
    original,
    callFor,
    run,
    recover,
    scope,
    heads,
    execution,
    target,
    receiver,
    session,
    releases,
    workOf,
    admit,
    prepare,
    reserve,
    inventory,
    minted,
    ready,
    close,
    failPreparation(error) {
      prepareFailure = error;
    },
    failAfterAudit(error) {
      failureAfterAudit = { error, since: transport.events.length };
    },
  };
}

async function transaction(pool, scope, work) {
  const client = await pool.connect();
  let active = true;
  const context = {
    scope,
    transaction: {
      assertActive() {
        assert.ok(active);
      },
    },
    query: { query: client.query.bind(client) },
  };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const value = await work(client, context);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    active = false;
    client.release();
  }
}

async function waitForBlocking(pool, pid) {
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    const result = await pool.query("SELECT pg_blocking_pids($1) AS blockers", [pid]);
    if (result.rows[0]?.blockers.length) return;
    await delay(10);
  }
  assert.fail(
    "Expected the actual PostgreSQL transaction to wait on the held closure/policy lock.",
  );
}

test(
  "repository Work and policy use the real isolated PostgreSQL owner",
  {
    skip: configPath ? false : "OCC_REPOSITORY_WORK_PG_CONFIG is not selected",
    timeout: 110000,
  },
  async (t) => {
    const config = await configuration();
    const pool = new pg.Pool({
      connectionString: config.connectionString,
      max: 6,
      connectionTimeoutMillis: 250,
      statement_timeout: 8000,
      application_name: "repository-work-policy-component",
    });
    pool.on("error", () => {});
    t.after(() => pool.end());
    const keys = [config.scope.installationId, config.scope.namespaceId, config.scope.agentId];
    const scoped = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3";
    const operation = async (value) =>
      (
        await pool.query(
          `SELECT canonical_document FROM occ.repository_work_operations_v2 WHERE ${scoped} AND operation_ref=$4`,
          [...keys, value.operationRef],
        )
      ).rows;
    const audit = async (value) =>
      (
        await pool.query(
          "SELECT actor_id,action,details FROM occ.audit_events WHERE namespace_id=$1 AND details->>'operationRef'=$2",
          [config.scope.namespaceId, value.operationRef],
        )
      ).rows;

    await t.test("fixture identity, application role and required schema are real", async () => {
      const result = await pool.query(`SELECT current_database() AS database,current_user AS role,
      r.rolsuper,r.rolcreatedb,r.rolcreaterole FROM pg_roles r WHERE r.rolname=current_user`);
      same(result.rows[0], {
        database: config.database,
        role: "occ_app",
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const timeout = await pool.query(
        "SELECT current_setting('transaction_timeout',true) AS configured",
      );
      assert.notEqual(
        timeout.rows[0].configured,
        null,
        "The selected original State owner uses transaction_timeout; the fixture must support that actual server setting.",
      );
      const owner = await pool.query(
        `SELECT a.service_principal_id FROM occ.agents a
      JOIN occ.namespaces n ON n.id=a.namespace_id CROSS JOIN occ.installation i
      WHERE i.id=$1 AND n.id=$2 AND a.id=$3`,
        keys,
      );
      assert.equal(owner.rows.length, 1);
      assert.equal(owner.rows[0].service_principal_id, config.servicePrincipalId);
      for (const table of [
        "repository_work_heads_v2",
        "repository_work_operations_v2",
        "repository_work_releases_v2",
        "repository_work_policy_versions_v2",
        "repository_work_policy_heads_v2",
        "repository_work_policy_operations_v2",
        "credential_inventory_mint_claims",
        "credential_inventory_revocation_claims",
      ]) {
        const found = await pool.query("SELECT to_regclass($1)::text AS relation", [
          `occ.${table}`,
        ]);
        assert.equal(found.rows[0].relation, `occ.${table}`);
      }
    });

    await t.test(
      "admission and mandatory audit become visible only after real outer COMMIT",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const rows = await operation(record.original);
        assert.equal(rows.length, 1);
        const stored = JSON.parse(rows[0].canonical_document);
        assert.equal(stored.kind, "admission");
        const events = await audit(record.original);
        assert.equal(events.length, 1);
        assert.equal(events[0].actor_id, config.servicePrincipalId);
        assert.equal(events[0].details.commitRef, stored.commitRef);
        assert.equal(
          f.transport.events.filter((e) => e.kind === "ack" && e.text === "COMMIT").length,
          1,
        );
        same(f.releases.sort(), ["custody", "work"]);
      },
    );

    await t.test(
      "complete parent chain is stored and stale/execution substitutions refuse",
      async () => {
        const f = fixture(pool, config),
          root = await f.admit(),
          child = await f.admit(root);
        const result = await f.run(f.original("read"), (u) =>
          u.readForMutation(f.workOf(child), f.execution),
        );
        assert.equal(result.kind, "committed");
        same(
          result.value.lineage.map((r) => r.workRef),
          [root.workRef, child.workRef],
        );
        for (const [work, execution] of [
          [{ workRef: child.workRef, revision: 2 }, f.execution],
          [f.workOf(child), { ...f.execution, assignmentRef: ref("foreign") }],
        ]) {
          const denied = await f.run(f.original("stale"), (u) =>
            u.readForMutation(work, execution),
          );
          assert.equal(denied.kind, "not-committed");
        }
      },
    );

    await t.test(
      "finalizer failure rolls back real Work row, operation and audit together",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const prepared = await f.prepare(record);
        const before = f.transport.events.length;
        f.failPreparation(new Error("fixture final fence failure"));
        const value = f.original("preparation-rollback");
        const result = await f.run(value, async (unit) => {
          await unit.readForMutation(f.workOf(record), f.execution);
          await unit.stagePreparation(prepared.input);
        });
        assert.equal(result.kind, "not-committed");
        const events = f.transport.events.slice(before);
        assert.ok(
          events.some(
            (e) =>
              e.kind === "ack" &&
              e.text.startsWith("INSERT INTO occ.repository_work_operations_v2"),
          ),
        );
        assert.ok(
          events.some((e) => e.kind === "ack" && e.text.startsWith("INSERT INTO occ.audit_events")),
        );
        assert.equal(
          events.some((e) => e.kind === "sent" && e.text === "COMMIT"),
          false,
        );
        assert.equal((await operation(value)).length, 0);
        assert.equal((await audit(value)).length, 0);
      },
    );

    await t.test(
      "real committed dispatch has atomic release and private object-bound witness",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        const result = await ready.dispatch();
        assert.equal(result.kind, "committed");
        const receipt = f.binding.participant.recognizeCommittedRelease(
          result.commit,
          ready.input.releaseRef,
          f.receiver,
          f.session,
        );
        assert.equal(receipt.operationRef, ready.businessOriginal.operationRef);
        const joined = await pool.query(
          `SELECT o.commit_ref,r.commit_ref AS release_commit,
      r.release_ref FROM occ.repository_work_operations_v2 o
      JOIN occ.repository_work_releases_v2 r USING
        (installation_id,namespace_id,agent_id,revision_ref,operation_ref)
      WHERE o.installation_id=$1 AND o.namespace_id=$2 AND o.agent_id=$3 AND o.operation_ref=$4`,
          [...keys, ready.businessOriginal.operationRef],
        );
        assert.equal(joined.rows.length, 1);
        assert.equal(joined.rows[0].commit_ref, joined.rows[0].release_commit);
        assert.equal((await audit(ready.businessOriginal)).length, 1);
        assert.throws(
          () =>
            f.binding.participant.recognizeCommittedRelease(
              result.commit,
              ready.input.releaseRef,
              { ...f.receiver },
              f.session,
            ),
          ScopeViolationError,
        );
        assert.throws(
          () =>
            f.binding.participant.recognizeCommittedRelease(
              { ...result.commit },
              ready.input.releaseRef,
              f.receiver,
              f.session,
            ),
          ScopeViolationError,
        );
      },
    );

    await t.test(
      "lost real COMMIT acknowledgment returns unknown and exact recovery never mints a witness",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        f.transport.loseCommitAcknowledgment();
        const result = await ready.dispatch();
        assert.equal(result.kind, "unknown");
        assert.equal(Object.hasOwn(result, "commit"), false);
        const recovered = await f.recover(ready.businessOriginal);
        assert.equal(recovered.kind, "recorded");
        assert.equal(recovered.operation.kind, "dispatch");
        assert.equal((await operation(ready.businessOriginal)).length, 1);
        assert.equal((await audit(ready.businessOriginal)).length, 1);
        assert.throws(
          () =>
            f.binding.participant.recognizeCommittedRelease(
              recovered,
              ready.input.releaseRef,
              f.receiver,
              f.session,
            ),
          ScopeViolationError,
        );
      },
    );

    await t.test(
      "second release from the same preparation is rejected by actual unique constraint",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        assert.equal((await ready.dispatch()).kind, "committed");
        const input = { ...ready.input, releaseRef: ref("second-release") };
        const value = f.original("second-dispatch", { dispatch: input });
        const result = await f.run(value, async (u) => {
          await u.readForMutation(f.workOf(ready.record), f.execution);
          await u.stageDispatchAndRelease(input);
        });
        assert.equal(result.kind, "not-committed");
        assert.equal((await operation(value)).length, 0);
        assert.equal((await audit(value)).length, 0);
      },
    );

    await t.test(
      "withdrawal serializes behind a held real Work readset then closes future dispatch",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        const entered = deferred(),
          release = deferred();
        const holding = f.run(f.original("held-read"), async (u) => {
          await u.readForMutation(f.workOf(ready.record), f.execution);
          entered.resolve();
          await release.promise;
        });
        await Promise.race([
          entered.promise,
          holding.then(() =>
            assert.fail("The original State read failed before holding the requested readset."),
          ),
        ]);
        const before = f.transport.events.length;
        const closing = f.close(ready.record);
        try {
          const until = Date.now() + 1000;
          let event;
          while (!event && Date.now() < until) {
            event = f.transport.events
              .slice(before)
              .find((e) => e.kind === "sent" && e.text.includes("SELECT id FROM occ.installation"));
            if (!event) await delay(10);
          }
          assert.ok(
            event,
            "The second real transaction reached its closure-conflicting parent lock.",
          );
          await waitForBlocking(pool, event.pid);
        } finally {
          release.resolve();
        }
        assert.equal((await holding).kind, "committed");
        assert.equal((await closing).result.kind, "committed");
        assert.equal((await ready.dispatch()).kind, "not-committed");
        const row = await pool.query(
          `SELECT revision,withdrawal_revision,state
      FROM occ.repository_work_heads_v2 WHERE ${scoped} AND work_ref=$4`,
          [...keys, ready.record.workRef],
        );
        same(row.rows[0], { revision: "2", withdrawal_revision: "1", state: "closed" });
      },
    );

    await t.test(
      "late append-only observation survives closure without altering dispatch",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        assert.equal((await ready.dispatch()).kind, "committed");
        const before = (await operation(ready.businessOriginal))[0].canonical_document;
        assert.equal((await f.close(ready.record)).result.kind, "committed");
        const input = {
          observationRef: ref("observation"),
          dispatchOperationRef: ready.businessOriginal.operationRef,
          outcome: "unknown",
          evidenceRef: ref("late-evidence"),
        };
        const value = f.original("observation", { observation: input });
        assert.equal((await f.run(value, (u) => u.appendObservation(input))).kind, "committed");
        assert.equal((await operation(ready.businessOriginal))[0].canonical_document, before);
        assert.equal(
          JSON.parse((await operation(value))[0].canonical_document).kind,
          "observation",
        );
      },
    );

    await t.test(
      "real inventory reservation shares outer commit/audit and replay is reconcile-only",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const reserved = await f.reserve(record, f.original("business"));
        assert.equal(reserved.result.kind, "committed");
        const row = reserved.result.value.operation.record;
        const found = await pool.query(
          `SELECT document FROM occ.credential_inventory_operations
      WHERE ${scoped} AND operation_ref=$4`,
          [...keys, reserved.original.operationRef],
        );
        assert.equal(found.rows.length, 1);
        assert.equal((await audit(reserved.original)).length, 1);
        const replay = await f.inventory(reserved.input, record, reserved.original);
        assert.equal(replay.result.kind, "committed");
        assert.equal(replay.result.value.kind, "existing");
        assert.equal(replay.result.value.nextAction, "reconcile-only");
        assert.equal((await audit(reserved.original)).length, 1);
        assert.equal(row.state, "reserved");
      },
    );

    await t.test(
      "failed final preparation rolls back actual inventory and mandatory audit",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const before = f.transport.events.length;
        f.failAfterAudit(new Error("fixture currentness refuses after the actual inventory audit"));
        const reserved = await f.reserve(record, f.original("business"));
        assert.equal(reserved.result.kind, "not-committed");
        const events = f.transport.events.slice(before);
        assert.ok(
          events.some(
            (e) =>
              e.kind === "ack" && e.text.startsWith("INSERT INTO occ.credential_inventory_records"),
          ),
        );
        assert.ok(
          events.some((e) => e.kind === "ack" && e.text.startsWith("INSERT INTO occ.audit_events")),
        );
        assert.equal(
          events.some((e) => e.kind === "sent" && e.text === "COMMIT"),
          false,
        );
        for (const table of ["credential_inventory_operations", "credential_inventory_records"])
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::int AS n FROM occ.${table}
        WHERE ${scoped} AND document->'${table.endsWith("operations") ? "input" : "issuance"}'->>'operationRef'=$4`,
                [...keys, reserved.original.operationRef],
              )
            ).rows[0].n,
            0,
          );
        assert.equal((await audit(reserved.original)).length, 0);
        assert.equal(
          (
            await pool.query(
              "SELECT access_lease_ref FROM occ.credential_inventory_access_leases WHERE installation_id=$1 AND access_lease_ref=$2",
              [config.scope.installationId, reserved.input.lease.accessLeaseRef],
            )
          ).rows.length,
          0,
        );
      },
    );

    await t.test(
      "unknown mint-claim COMMIT is retained and exact replay never creates another attempt",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const reserved = await f.reserve(record, f.original("business"));
        assert.equal(reserved.result.kind, "committed");
        const row = reserved.result.value.operation.record;
        const providerAttemptRef = ref("provider-attempt");
        const input = {
          schemaVersion: 2,
          method: "claimRepositoryMint",
          operationRef: "unassigned",
          scope: config.scope,
          createdAt: new Date().toISOString(),
          target: row.target,
          expectedInventoryVersion: row.inventoryVersion,
          providerAttemptRef,
          custodyIdentity: {
            lease: row.issuance.lease,
            key: {
              clientId: "client",
              bindingRef: row.issuance.bindingRef,
              immutableVersion: "key-1",
            },
            providerAttemptRef,
            tokenRef: ref("token"),
            protectedRevocationRef: ref("cleanup"),
          },
        };
        f.transport.loseCommitAcknowledgment();
        const claim = await f.inventory(input, record);
        assert.equal(claim.result.kind, "unknown");
        assert.equal(Object.hasOwn(claim.result, "commit"), false);
        const retained = await f.run(claim.original, (u) => u.readRepositoryInventoryOperation());
        assert.equal(retained.kind, "committed");
        assert.equal(retained.value.record.state, "mint-unknown");
        assert.equal(retained.value.record.providerAttemptRef, providerAttemptRef);
        assert.throws(
          () => f.binding.participant.recognizeCommittedInventory(retained.commit, claim.original),
          ScopeViolationError,
        );
        const replay = await f.inventory(claim.input, record, claim.original);
        assert.equal(replay.result.kind, "committed");
        assert.equal(replay.result.value.kind, "existing");
        assert.equal(replay.result.value.nextAction, "reconcile-only");
        const claims = await pool.query(
          `SELECT document FROM occ.credential_inventory_mint_claims
      WHERE ${scoped} AND record_ref=$4`,
          [...keys, row.target.recordRef],
        );
        assert.equal(claims.rows.length, 1);
        assert.equal(claims.rows[0].document.providerAttemptRef, providerAttemptRef);
        assert.equal((await audit(claim.original)).length, 1);
      },
    );

    await t.test(
      "application role cannot update immutable history or fabricate a deferred release",
      async () => {
        const f = fixture(pool, config),
          ready = await f.ready();
        assert.equal((await ready.dispatch()).kind, "committed");
        const before = (await operation(ready.businessOriginal))[0].canonical_document;
        await assert.rejects(
          pool.query(
            `UPDATE occ.repository_work_operations_v2 SET commit_ref=commit_ref
      WHERE ${scoped} AND operation_ref=$4`,
            [...keys, ready.businessOriginal.operationRef],
          ),
          (e) => ["23514", "42501"].includes(e.code),
        );
        assert.equal((await operation(ready.businessOriginal))[0].canonical_document, before);
        // A valid row body cannot replace the missing referenced dispatch operation.
        const orphan = ref("orphan"),
          releaseRef = ref("orphan-release");
        const prepared = await f.prepare(ready.record);
        const document = {
          ...ready.input,
          preparationOperationRef: prepared.original.operationRef,
          releaseRef,
        };
        await assert.rejects(
          transaction(pool, config.scope, async (client) => {
            await client.query(
              `INSERT INTO occ.repository_work_releases_v2
        (installation_id,namespace_id,agent_id,revision_ref,operation_ref,preparation_operation_ref,
         release_ref,receiver_ref,inventory_record_ref,inventory_version,commit_ref,canonical_document)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                ...keys,
                f.scope.revisionRef,
                orphan,
                prepared.original.operationRef,
                releaseRef,
                document.receiverRef,
                document.inventoryRecordRef,
                document.inventoryVersion,
                ref("commit"),
                canonical(document),
              ],
            );
          }),
          (e) => e.code === "23503",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT release_ref FROM occ.repository_work_releases_v2 WHERE installation_id=$1 AND release_ref=$2",
              [config.scope.installationId, releaseRef],
            )
          ).rows.length,
          0,
        );
      },
    );

    await t.test(
      "request-digest SQL domain rejects bare hashes without changing other digest domains",
      async () => {
        const f = fixture(pool, config),
          record = await f.admit();
        const source = JSON.parse((await operation(record.original))[0].canonical_document);
        const invalid = {
          ...source,
          operationRef: ref("invalid-digest"),
          requestDigest: "a".repeat(64),
        };
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.repository_work_operations_v2
      (installation_id,namespace_id,agent_id,revision_ref,operation_ref,request_digest,
       invocation_ref,commit_ref,kind,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              ...keys,
              f.scope.revisionRef,
              invalid.operationRef,
              invalid.requestDigest,
              invalid.invocationRef,
              invalid.commitRef,
              invalid.kind,
              canonical(invalid),
            ],
          ),
          (e) => e.code === "23514",
        );
        assert.equal((await operation(invalid)).length, 0);
      },
    );

    // Account recognition is a fixed fixture boundary. Authorization itself uses
    // the real NativeIAM driver and seeded persisted Agent-administer grant.
    const policyTransport = wire(pool),
      policyState = new PostgresPlatformState(policyTransport.source);
    const selection = new DriverSelection();
    selection.registerDriver(new NativeIAMDriver(policyState));
    selection.selectDriver("iam", "occ-native-iam");
    const policyBinding = policyState.repositoryWorkPolicyBindingV2(selection);
    const iam = await policyState.loadNativeIAMState();
    const principal = iam.identities.find(
      (i) => i.id === config.operatorPrincipalId && i.kind === "principal",
    );
    assert.ok(principal, "The custodian must seed the actual operator IAM principal.");
    const policyInvocations = new WeakSet();
    const policyStore = policyBinding.bindOriginalAccount({
      async consume(invocation, request, unit) {
        assert.ok(policyInvocations.has(invocation));
        assert.equal(request.purpose, "repository-work-policy-operator");
        const owner = policyBinding.accountOwner.bind(unit, () => {});
        return {
          principal,
          accountRef: ref("fixture-account"),
          requestId: ref("request"),
          admissionDecisionId: ref("decision"),
          assertCurrent() {
            owner.assertCurrent();
          },
          release() {},
        };
      },
    });
    const policyRef = ref("policy"),
      repositoryId = String(1000000000 + Math.floor(Math.random() * 1000000000));
    const policy = (version) => ({
      schemaVersion: 2,
      policyRef,
      version,
      status: "enabled",
      scope: config.scope,
      servicePrincipalId: config.servicePrincipalId,
      repository: {
        target: {
          installationId: config.scope.installationId,
          githubHost: "github.com",
          appId: "100",
          githubInstallationId: "200",
          repositoryId,
        },
        owner: "fixture-owner",
        name: "fixture-repository",
        profile: { ref: "repository-profile", revision: "1" },
      },
      executionProfile: { ref: "execution-profile", revision: "1" },
      operations: ["metadata:read"],
      bounds: {
        notBefore: new Date(Date.now() - 60000).toISOString(),
        notAfter: new Date(Date.now() + 3600000).toISOString(),
        maximumWorkMilliseconds: 60000,
      },
    });
    const mutate = (command) => {
      const invocation = Object.freeze({});
      policyInvocations.add(invocation);
      return policyStore.mutate(invocation, command, {
        signal: new AbortController().signal,
        timeoutMs: 3000,
      });
    };
    const firstPolicy = {
      operationRef: ref("policy-operation"),
      expectedVersion: null,
      policy: policy(1),
    };

    await t.test(
      "actual policy owner authorizes Agent administer then commits version/head/audit",
      async () => {
        const result = await mutate(firstPolicy);
        assert.equal(result.kind, "committed");
        const head = await pool.query(
          `SELECT version FROM occ.repository_work_policy_heads_v2
      WHERE ${scoped} AND policy_ref=$4`,
          [...keys, policyRef],
        );
        assert.equal(head.rows[0].version, "1");
        const events = await audit(firstPolicy);
        assert.equal(events.length, 1);
        assert.equal(events[0].actor_id, config.operatorPrincipalId);
        assert.equal(events[0].action, "work.repository.policy.mutate");
      },
    );

    await t.test("policy exact replay is immutable and stale head compare refuses", async () => {
      assert.equal((await mutate(firstPolicy)).kind, "committed");
      assert.equal((await audit(firstPolicy)).length, 1);
      const second = {
        operationRef: ref("policy-operation"),
        expectedVersion: 1,
        policy: policy(2),
      };
      assert.equal((await mutate(second)).kind, "committed");
      const stale = { ...second, operationRef: ref("policy-stale") };
      assert.equal((await mutate(stale)).kind, "conflict");
      assert.equal((await audit(stale)).length, 0);
      const versions = await pool.query(
        `SELECT version FROM occ.repository_work_policy_versions_v2
      WHERE ${scoped} AND policy_ref=$4 ORDER BY version`,
        [...keys, policyRef],
      );
      same(
        versions.rows.map((v) => v.version),
        ["1", "2"],
      );
    });

    await t.test("held real current policy head conflicts with a version replacement", async () => {
      const entered = deferred(),
        release = deferred();
      const reading = transaction(pool, config.scope, async (_client, context) => {
        const repository = createPostgresRepositoryWorkPolicyV2(
          context,
          config.scope,
          ref("read-commit"),
        );
        assert.equal((await repository.find(policyRef)).version, 2);
        entered.resolve();
        await release.promise;
      });
      await Promise.race([
        entered.promise,
        reading.then(() =>
          assert.fail("The original policy repository read failed before holding the head."),
        ),
      ]);
      const before = policyTransport.events.length;
      const changing = mutate({
        operationRef: ref("policy-operation"),
        expectedVersion: 2,
        policy: policy(3),
      });
      try {
        const until = Date.now() + 1000;
        let event;
        while (!event && Date.now() < until) {
          event = policyTransport.events
            .slice(before)
            .find(
              (e) =>
                e.kind === "sent" &&
                e.text.startsWith("UPDATE occ.repository_work_policy_heads_v2"),
            );
          if (!event) await delay(10);
        }
        assert.ok(event, "The actual version writer reached its head CAS.");
        await waitForBlocking(pool, event.pid);
      } finally {
        release.resolve();
      }
      await reading;
      assert.equal((await changing).kind, "committed");
    });

    await t.test("application role cannot rewrite a retained policy version", async () => {
      await assert.rejects(
        pool.query(
          `UPDATE occ.repository_work_policy_versions_v2 SET status='disabled'
      WHERE ${scoped} AND policy_ref=$4 AND version=1`,
          [...keys, policyRef],
        ),
        (e) => ["23514", "42501"].includes(e.code),
      );
      const result = await pool.query(
        `SELECT status FROM occ.repository_work_policy_versions_v2
      WHERE ${scoped} AND policy_ref=$4 AND version=1`,
        [...keys, policyRef],
      );
      assert.equal(result.rows[0].status, "enabled");
    });

    await t.test(
      "policy lost COMMIT acknowledgment preserves exact immutable operation and one audit",
      async () => {
        const command = {
          operationRef: ref("policy-unknown"),
          expectedVersion: 3,
          policy: policy(4),
        };
        policyTransport.loseCommitAcknowledgment();
        assert.equal((await mutate(command)).kind, "unknown");
        const stored = await transaction(pool, config.scope, async (_client, context) =>
          createPostgresRepositoryWorkPolicyV2(
            context,
            config.scope,
            ref("readback"),
          ).readOperation(command.operationRef),
        );
        assert.equal(stored.policy.version, 4);
        assert.equal(stored.operationRef, command.operationRef);
        assert.equal((await audit(command)).length, 1);
        assert.equal((await mutate(command)).kind, "committed");
        assert.equal((await audit(command)).length, 1);
      },
    );
  },
);
