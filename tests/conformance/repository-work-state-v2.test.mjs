import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { canonicalRepositoryWorkV2 } from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import { repositoryInventoryDigestV2 } from "../../packages/occ/src/credential-inventory-v1/repository-lease-v2.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

// These are owner/transport protocol tests. Controlled source hooks exercise
// lifetime and private membership; they do not establish an admitted Work,
// a real database, native authority, custody, or a passing GitHub flow.
const scope = {
  installationRef: "ins_11111111-1111-4111-8111-111111111111",
  namespaceRef: "ns_11111111-1111-4111-8111-111111111111",
  agentRef: "agt_11111111-1111-4111-8111-111111111111",
  revisionRef: "r",
};
const original = () =>
  Object.freeze({
    operationRef: "operation",
    invocationRef: "invocation",
    requestDigest: `sha256:${"1".repeat(64)}`,
    scope,
  });
function protocol(hooks = {}) {
  const queries = [];
  const events = [];
  const client = {
    on() {},
    removeListener() {},
    async query(statement, parameters) {
      queries.push(statement);
      hooks.query?.(statement, parameters);
      if (statement === "COMMIT")
        return hooks.commit ? hooks.commit() : { command: "COMMIT", rows: [], rowCount: 0 };
      if (statement === "ROLLBACK") return { command: "ROLLBACK", rows: [], rowCount: 0 };
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET LOCAL ") ||
        statement.startsWith("SELECT set_config(")
      )
        return { command: "", rows: [], rowCount: 0 };
      if (statement === "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2")
        return {
          rows: [
            {
              id: scope.installationRef,
              name: "installation",
              created_at: "2026-09-10T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      if (statement.startsWith("SELECT id FROM occ."))
        return { rows: [{ id: parameters.at(-1) }], rowCount: 1 };
      if (hooks.storage) {
        const stored = await hooks.storage(statement, parameters);
        if (stored !== undefined) return stored;
      }
      if (statement.startsWith("SELECT canonical_document FROM occ.repository_work_operations_v2"))
        return { rows: [], rowCount: 0 };
      throw new Error("This controlled protocol fixture does not implement persistence.");
    },
    release(destroy) {
      events.push(["client-release", destroy]);
      hooks.release?.();
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return client;
    },
    async end() {},
  });
  const binding = state.repositoryWorkBindingV2();
  const receiver = Object.freeze({});
  const session = Object.freeze({});
  const lease = (name) => ({
    assertCurrent() {
      hooks.current?.(name);
      return undefined;
    },
    async prepareCommit() {
      events.push(["prepare", name]);
      await hooks.prepare?.(name);
    },
    async release() {
      events.push(["release", name]);
      await hooks.sourceRelease?.(name);
    },
  });
  const work = {
    async acquire(context, operation, call) {
      binding.participant.assertOriginal(context, operation, call);
      await hooks.acquireWork?.(context, operation, call, binding);
      return {
        ...lease("work"),
        actorId: "service",
        async qualifyReadset() {},
        async qualifyAdmission() {},
        async qualifyClosure() {},
        async qualifyObservation() {},
        qualifyInventory: hooks.qualifyInventory,
        qualifyInventoryRead: hooks.qualifyInventoryRead,
        qualifyMintUse: hooks.qualifyMintUse,
        qualifyRevocationUse: hooks.qualifyRevocationUse,
      };
    },
  };
  const custody = {
    async acquire(context, operation, call) {
      binding.participant.assertOriginal(context, operation, call);
      await hooks.acquireCustody?.(context, operation, call, binding);
      return {
        ...lease("custody"),
        receiver,
        session,
        receiverRef: "receiver",
        sessionRef: "session",
        async stageRelease(input) {
          await hooks.stageRelease?.(input);
        },
        qualifyInventory: hooks.custodyInventory,
        qualifyInventoryRead: hooks.custodyInventoryRead,
        inventoryClock: hooks.inventoryClock,
        qualifyMintUse: hooks.custodyMintUse,
        qualifyRevocationUse: hooks.custodyRevocationUse,
      };
    },
  };
  const store = binding.bindOriginalSources(work, custody);
  function run(
    body = (unit) => unit.readExactOperation(),
    abort = new AbortController(),
    owned = original(),
  ) {
    const call = {
      context: Object.freeze({}),
      requestRef: "call",
      recipientRef: "recipient",
      deadline: new Date(Date.now() + 2000).toISOString(),
      signal: abort.signal,
    };
    return store.run(owned, call, { signal: abort.signal, timeoutMs: 1000 }, body);
  }
  return { state, store, binding, run, events, queries, receiver, session };
}

test("plain canonical data keeps the request digest prefix and rejects accessors", () => {
  assert.equal(
    JSON.parse(canonicalRepositoryWorkV2(original())).requestDigest,
    `sha256:${"1".repeat(64)}`,
  );
  let called = false;
  assert.throws(
    () =>
      canonicalRepositoryWorkV2({
        get value() {
          called = true;
          return 1;
        },
      }),
    ScopeViolationError,
  );
  assert.equal(called, false);
});

test("missing original construction source fails before any checkout", () => {
  let connects = 0;
  const state = new PostgresPlatformState({
    async connect() {
      connects++;
      throw new Error();
    },
    async end() {},
  });
  assert.throws(
    () => state.repositoryWorkBindingV2().bindOriginalSources(undefined, undefined),
    ScopeViolationError,
  );
  assert.equal(connects, 0);
});

test("original State phase acknowledges a read only after both cleanup owners", async () => {
  const fixture = protocol();
  const result = await fixture.run();
  assert.equal(result.kind, "committed");
  assert.deepEqual(result.value, { kind: "absent" });
  assert.deepEqual(
    fixture.events.filter((e) => e[0] === "release"),
    [
      ["release", "custody"],
      ["release", "work"],
    ],
  );
  assert.throws(
    () =>
      fixture.binding.participant.recognizeCommittedRelease(
        result.commit,
        "release",
        fixture.receiver,
        fixture.session,
      ),
    ScopeViolationError,
    "a committed read is not a release",
  );
});

test("copied original context poisons even when the source catches refusal", async () => {
  const fixture = protocol({
    acquireWork(context, operation, call, binding) {
      assert.throws(
        () => binding.participant.assertOriginal({ ...context }, operation, call),
        ScopeViolationError,
      );
    },
  });
  assert.equal((await fixture.run()).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

test("nested State transaction poisons the actual outer Work phase", async () => {
  let fixture;
  fixture = protocol({
    async acquireWork() {
      await assert.rejects(
        fixture.state.transact(async () => 1),
        ScopeViolationError,
      );
    },
  });
  assert.equal((await fixture.run()).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

test("post-callback synchronous fence rejects attempted unit admission", async () => {
  let unit,
    armed = false,
    attempted;
  const fixture = protocol({
    current() {
      if (armed) {
        armed = false;
        attempted = unit.readExactOperation();
        void attempted.catch(() => {});
      }
    },
  });
  const result = await fixture.run(async (actual) => {
    unit = actual;
    await unit.readExactOperation();
    armed = true;
    return "refusal";
  });
  assert.ok(attempted, "the actual final currentness hook attempted the operation");
  await assert.rejects(attempted, ScopeViolationError);
  assert.equal(result.kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

for (const [name, code, expected] of [
  ["definite rejection", "23514", "not-committed"],
  ["unknown completion", "40003", "unknown"],
  ["lost acknowledgment", "ECONNRESET", "unknown"],
]) {
  test(`original ${name} preserves its outer COMMIT classification`, async () => {
    const fixture = protocol({
      commit() {
        throw Object.assign(new Error("controlled"), { code });
      },
    });
    assert.equal((await fixture.run()).kind, expected);
    assert.equal(fixture.events.filter((e) => e[0] === "release").length, 2);
  });
}

test("post-COMMIT custody cleanup failure cannot claim not committed", async () => {
  const fixture = protocol({
    sourceRelease(name) {
      if (name === "custody") throw new Error("controlled cleanup");
    },
  });
  assert.equal((await fixture.run()).kind, "unknown");
  assert.equal(fixture.events.filter((e) => e[0] === "release").length, 2);
});

test("cancellation joins deferred acquisition and releases its late lease once", async () => {
  let resolve, entered;
  const deferred = new Promise((r) => {
    resolve = r;
  });
  const acquired = new Promise((r) => {
    entered = r;
  });
  const abort = new AbortController();
  const fixture = protocol({
    async acquireCustody() {
      entered();
      await deferred;
    },
  });
  let settled = false;
  const result = fixture.run(undefined, abort).then((value) => {
    settled = true;
    return value;
  });
  await acquired;
  abort.abort();
  await Promise.resolve();
  assert.equal(settled, false);
  resolve();
  assert.equal((await result).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
  assert.deepEqual(
    fixture.events.filter((e) => e[0] === "release"),
    [
      ["release", "custody"],
      ["release", "work"],
    ],
  );
});

test("ended unit remains revoked for later captured calls", async () => {
  let captured;
  const fixture = protocol();
  assert.equal(
    (
      await fixture.run(async (unit) => {
        captured = unit;
        return unit.readExactOperation();
      })
    ).kind,
    "committed",
  );
  await assert.rejects(captured.readExactOperation(), ScopeViolationError);
});

test("fresh committed release refuses copied or read-only witnesses before checkout", async () => {
  const fixture = protocol();
  const result = await fixture.run();
  assert.equal(result.kind, "committed");
  const count = fixture.queries.length;
  const call = {
    context: Object.freeze({}),
    requestRef: "next",
    recipientRef: "recipient",
    deadline: new Date(Date.now() + 1000).toISOString(),
    signal: new AbortController().signal,
  };
  assert.equal(
    await fixture.binding.participant.acquireCommittedRelease(
      result.commit,
      call,
      fixture.receiver,
      fixture.session,
    ),
    undefined,
  );
  assert.equal(
    await fixture.binding.participant.acquireCommittedRelease(
      { commitRef: result.commit.commitRef },
      call,
      fixture.receiver,
      fixture.session,
    ),
    undefined,
  );
  assert.equal(fixture.queries.length, count);
});

// A controlled wire peer supplies exact valid retained rows to the REAL State
// owner and REAL repository codecs. This is a protocol/cleanup test, not a real
// PostgreSQL, authentic policy, external provider or composed-flow acceptance.
function releaseProtocol(hooks = {}) {
  const dataScope = {
    installationId: scope.installationRef,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
    revisionRef: scope.revisionRef,
  };
  const owner = original(),
    work = { workRef: "work", revision: 1 };
  const execution = {
    attempt: {
      installationRef: scope.installationRef,
      namespaceRef: scope.namespaceRef,
      agentRef: scope.agentRef,
      conversationRef: "conversation",
      turnRef: "turn",
      attemptRef: "attempt",
      reservationRef: "reservation",
    },
    assignmentRef: "assignment",
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation",
    executionGeneration: "1",
    receiverRef: "receiver",
    protectedOriginRef: "origin",
    executionProfile: { ref: "execution-profile", revision: "1" },
    predecessor: { kind: "none" },
  };
  const future = new Date(Date.now() + 60000).toISOString(),
    now = new Date().toISOString();
  let head = {
    scope: dataScope,
    workRef: "work",
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: "work",
    originalHorizon: future,
    state: "open",
    execution,
    policy: {},
    originalAdmission: {},
  };
  const target = {
    installationId: scope.installationRef,
    githubHost: "github.com",
    appId: "100",
    githubInstallationId: "200",
    repositoryId: "300",
  };
  const access = {
    schemaVersion: 2,
    accessLeaseRef: "lease",
    target,
    original: owner,
    work,
    execution,
    createdAt: now,
    notAfter: future,
  };
  const issuance = {
    schemaVersion: 2,
    method: "reserveRepositoryToken",
    operationRef: "reserve",
    scope: {
      installationId: scope.installationRef,
      namespaceId: scope.namespaceRef,
      agentId: scope.agentRef,
    },
    createdAt: now,
    lease: access,
    bindingRef: "binding",
    permissionProfile: { ref: "repository-profile", revision: "1" },
    requestedPermissions: { metadata: "read" },
    deadline: future,
  };
  let inventory = {
    schemaVersion: 2,
    target: {
      issuanceOperationRef: "reserve",
      recordRef: "record",
      intentDigest: repositoryInventoryDigestV2(issuance),
    },
    inventoryVersion: 3,
    issuance,
    updatedAt: now,
    expiry: { kind: "provider-expiry", expiresAt: future, observedAt: now, evidenceRef: "expiry" },
    state: "outstanding",
    disposition: "current-check-required",
    providerAttemptRef: "provider-attempt",
    tokenRef: "token-metadata",
    protectedRevocationRef: "revoke-metadata",
    returnedPermissions: { metadata: "read" },
    evidenceRef: "provider-evidence",
  };
  const prepared = {
    workRef: "work",
    workRevision: 1,
    requestDigest: owner.requestDigest,
    receiverRef: "receiver",
    sessionRef: "session",
    dnsBindingRef: "dns",
    repositoryTarget: target,
  };
  const dispatch = {
    ...prepared,
    preparationOperationRef: "preparation",
    accessLeaseRef: "lease",
    inventoryRecordRef: "record",
    inventoryVersion: 3,
    releaseRef: "release",
  };
  const operations = new Map([
    [
      "preparation",
      {
        ...owner,
        operationRef: "preparation",
        scope: dataScope,
        commitRef: "old-commit",
        kind: "preparation",
        document: prepared,
      },
    ],
  ]);
  const canonicalRow = (document) => ({
    rows: [{ canonical_document: canonicalRepositoryWorkV2(document) }],
    rowCount: 1,
  });
  const fixture = protocol({
    ...hooks,
    async storage(statement, parameters) {
      if (hooks.storage) {
        const result = await hooks.storage(statement, parameters);
        if (result !== undefined) return result;
      }
      if (statement.startsWith("SELECT canonical_document FROM occ.repository_work_heads_v2"))
        return canonicalRow(head);
      if (
        statement.startsWith("SELECT canonical_document FROM occ.repository_work_operations_v2")
      ) {
        const result = operations.get(parameters[4]);
        return result ? canonicalRow(result) : { rows: [], rowCount: 0 };
      }
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_records"))
        return { rows: [{ document: inventory }], rowCount: 1 };
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_access_leases"))
        return { rows: [{ document: access }], rowCount: 1 };
      if (statement.startsWith("INSERT INTO occ.repository_work_operations_v2")) {
        const value = JSON.parse(parameters.at(-1));
        operations.set(value.operationRef, value);
        return canonicalRow(value);
      }
      if (statement.startsWith("INSERT INTO occ.repository_work_releases_v2"))
        return canonicalRow(JSON.parse(parameters.at(-1)));
      if (statement.startsWith("INSERT INTO occ.audit_events")) return { rows: [], rowCount: 1 };
      return undefined;
    },
  });
  const call = (signal = new AbortController().signal) => ({
    context: Object.freeze({}),
    requestRef: "fresh",
    recipientRef: "recipient",
    deadline: new Date(Date.now() + 1500).toISOString(),
    signal,
  });
  return {
    ...fixture,
    dispatch,
    call,
    access,
    work,
    execution,
    issuance,
    invalidateWork() {
      head = { ...head, state: "closed", revision: 2 };
    },
    invalidateInventory() {
      inventory = { ...inventory, disposition: "mitigation-only" };
    },
    async commit() {
      return fixture.run(async (unit) => {
        await unit.readForMutation(work, execution);
        await unit.stageDispatchAndRelease(dispatch);
      });
    },
  };
}

test("known commit recognizes original receiver and session, never same-field copies", async () => {
  const fixture = releaseProtocol();
  const result = await fixture.commit();
  assert.equal(result.kind, "committed");
  assert.equal(
    fixture.binding.participant.recognizeCommittedRelease(
      result.commit,
      "release",
      fixture.receiver,
      fixture.session,
    ).dispatch.releaseRef,
    "release",
  );
  assert.throws(
    () =>
      fixture.binding.participant.recognizeCommittedRelease(
        result.commit,
        "release",
        { ...fixture.receiver },
        fixture.session,
      ),
    ScopeViolationError,
  );
  assert.throws(
    () =>
      fixture.binding.participant.recognizeCommittedRelease(
        result.commit,
        "release",
        fixture.receiver,
        { ...fixture.session },
      ),
    ScopeViolationError,
  );
});

test("fresh release holds the actual State read until immediate write and ACK cleanup", async () => {
  const fixture = releaseProtocol();
  const result = await fixture.commit();
  assert.equal(result.kind, "committed");
  const before = fixture.queries.filter((q) => q === "COMMIT").length;
  const lease = await fixture.binding.participant.acquireCommittedRelease(
    result.commit,
    fixture.call(),
    fixture.receiver,
    fixture.session,
  );
  assert.ok(lease);
  assert.equal(fixture.queries.filter((q) => q === "COMMIT").length, before);
  const order = [];
  lease.assertCurrent();
  order.push("assert");
  order.push("decrypt");
  lease.beginSubmittedUse();
  const ack = new Promise((resolve) => {
    order.push("write-started");
    resolve();
  });
  assert.deepEqual(order, ["assert", "decrypt", "write-started"]);
  await ack;
  lease.assertCurrent();
  await lease.release();
  assert.throws(() => lease.assertCurrent(), ScopeViolationError);
  assert.equal(
    await fixture.binding.participant.acquireCommittedRelease(
      result.commit,
      fixture.call(),
      fixture.receiver,
      fixture.session,
    ),
    undefined,
  );
  assert.equal(fixture.events.filter((e) => e[0] === "release").length, 4);
});

for (const invalidate of ["invalidateWork", "invalidateInventory"])
  test(`fresh release refuses ${invalidate} after historical COMMIT`, async () => {
    const fixture = releaseProtocol();
    const result = await fixture.commit();
    assert.equal(result.kind, "committed");
    fixture[invalidate]();
    assert.equal(
      await fixture.binding.participant.acquireCommittedRelease(
        result.commit,
        fixture.call(),
        fixture.receiver,
        fixture.session,
      ),
      undefined,
    );
    assert.equal(fixture.queries.filter((q) => q === "COMMIT").length, 1);
    assert.equal(fixture.events.filter((e) => e[0] === "release").length, 4);
  });

test("fresh release cancellation revokes the write fence and joins owned cleanup", async () => {
  const fixture = releaseProtocol();
  const result = await fixture.commit();
  assert.equal(result.kind, "committed");
  const abort = new AbortController();
  const lease = await fixture.binding.participant.acquireCommittedRelease(
    result.commit,
    fixture.call(abort.signal),
    fixture.receiver,
    fixture.session,
  );
  assert.ok(lease);
  abort.abort();
  assert.throws(() => lease.assertCurrent(), ScopeViolationError);
  await lease.release();
  assert.equal(fixture.queries.filter((q) => q === "COMMIT").length, 1);
  assert.equal(fixture.events.filter((e) => e[0] === "release").length, 4);
});

for (const reason of ["abort", "deadline"])
  test(`submitted use ${reason} invalidates permission but retains SQL/source cleanup until actual settlement`, async () => {
    const fixture = releaseProtocol();
    const result = await fixture.commit();
    assert.equal(result.kind, "committed");
    const abort = new AbortController();
    const call = fixture.call(abort.signal);
    if (reason === "deadline") call.deadline = new Date(Date.now() + 150).toISOString();
    const lease = await fixture.binding.participant.acquireCommittedRelease(
      result.commit,
      call,
      fixture.receiver,
      fixture.session,
    );
    assert.ok(lease);
    lease.assertCurrent();
    lease.beginSubmittedUse();
    const beforeReleases = fixture.events.filter((e) => e[0] === "client-release").length;
    const beforeRollbacks = fixture.queries.filter((q) => q === "ROLLBACK").length;
    if (reason === "abort") abort.abort();
    else await new Promise((resolve) => setTimeout(resolve, 180));
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => lease.assertCurrent(), ScopeViolationError);
    assert.equal(fixture.events.filter((e) => e[0] === "client-release").length, beforeReleases);
    assert.equal(fixture.events.filter((e) => e[0] === "release").length, 2);
    assert.equal(fixture.queries.filter((q) => q === "ROLLBACK").length, beforeRollbacks);
    assert.ok(
      fixture.queries.includes(
        "SELECT set_config('transaction_timeout','0',true), set_config('idle_in_transaction_session_timeout','0',true)",
      ),
    );
    // This call stands for the custody owner's already-observed ACK/actual child
    // retirement; timeout above is deliberately not treated as that observation.
    await lease.release();
    assert.equal(
      fixture.events.filter((e) => e[0] === "client-release").length,
      beforeReleases + 1,
    );
    assert.equal(fixture.events.filter((e) => e[0] === "release").length, 4);
    assert.equal(fixture.queries.filter((q) => q === "ROLLBACK").length, beforeRollbacks + 1);
  });

function inventoryProtocol(hooks = {}) {
  const records = new Map(),
    operations = new Map(),
    claims = new Map(),
    revocations = new Map(),
    leases = new Map(),
    originals = new Map(),
    qualifications = [];
  const row = (document) =>
    document === undefined ? { rows: [], rowCount: 0 } : { rows: [{ document }], rowCount: 1 };
  const fixture = releaseProtocol({
    inventoryClock: { read: () => ({ now: Date.now(), uncertaintyMs: 0 }) },
    async qualifyInventory(facts) {
      qualifications.push(["work", facts]);
    },
    async custodyInventory(facts) {
      qualifications.push(["custody", facts]);
    },
    async qualifyInventoryRead(found) {
      qualifications.push(["work-read", found]);
    },
    async custodyInventoryRead(found) {
      qualifications.push(["custody-read", found]);
    },
    async qualifyMintUse(operation, record, readset) {
      qualifications.push(["mint-work", operation, record, readset]);
    },
    async custodyMintUse(operation, record, readset) {
      qualifications.push(["mint-custody", operation, record, readset]);
    },
    async qualifyRevocationUse(operation, record) {
      qualifications.push(["revocation-work", operation, record]);
    },
    async custodyRevocationUse(operation, record) {
      qualifications.push(["revocation-custody", operation, record]);
    },
    ...hooks,
    async storage(statement, values) {
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_records"))
        return row(records.get(values[3]));
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_operations"))
        return row(operations.get(values[3]));
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_mint_claims"))
        return row(claims.get(values[3]));
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_revocation_claims"))
        return row(revocations.get(values[3]));
      if (
        statement.startsWith(
          "SELECT installation_id,namespace_id,agent_id,document FROM occ.credential_inventory_mint_claims",
        )
      ) {
        const document = claims.get(values[3]);
        return document
          ? {
              rows: [
                {
                  installation_id: values[0],
                  namespace_id: values[1],
                  agent_id: values[2],
                  document,
                },
              ],
              rowCount: 1,
            }
          : row(undefined);
      }
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_access_leases"))
        return row(leases.get(values[1]));
      if (statement.startsWith("SELECT count(*)::int AS installation_live"))
        return {
          rows: [
            {
              installation_live: 0,
              lease_live: 0,
              mint_active: false,
              target_held: false,
              slot_one: false,
              slot_two: false,
            },
          ],
          rowCount: 1,
        };
      if (statement.startsWith("INSERT INTO occ.credential_inventory_access_leases")) {
        const document = JSON.parse(values.at(-1));
        leases.set(document.accessLeaseRef, document);
        return { rows: [{ access_lease_ref: document.accessLeaseRef }], rowCount: 1 };
      }
      if (
        statement.startsWith("INSERT INTO occ.credential_inventory_records") ||
        statement.startsWith("UPDATE occ.credential_inventory_records")
      ) {
        const text = values.find(
          (x) =>
            typeof x === "string" &&
            x.startsWith('{"schemaVersion":2') &&
            x.includes('"inventoryVersion"'),
        );
        assert.ok(text, statement);
        const document = JSON.parse(text);
        records.set(document.target.recordRef, document);
        return { rows: [{ record_ref: document.target.recordRef }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO occ.credential_inventory_operations")) {
        const document = JSON.parse(values.at(-1));
        operations.set(document.input.operationRef, document);
        return { rows: [{ operation_ref: document.input.operationRef }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO occ.credential_inventory_mint_claims")) {
        const document = JSON.parse(values.at(-1));
        claims.set(document.recordRef, document);
        return { rows: [{ record_ref: document.recordRef }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO occ.credential_inventory_revocation_claims")) {
        const document = JSON.parse(values.at(-1));
        assert.equal(revocations.has(document.claimRef), false);
        revocations.set(document.claimRef, document);
        return { rows: [{ claim_ref: document.claimRef }], rowCount: 1 };
      }
      return undefined;
    },
  });
  const execute = (input) => {
    const owned =
      originals.get(input.operationRef) ??
      Object.freeze({ ...original(), operationRef: input.operationRef });
    originals.set(input.operationRef, owned);
    return fixture.run(
      async (unit) => {
        if (input.method === "reserveRepositoryToken" || input.method === "claimRepositoryMint")
          await unit.readForMutation(fixture.work, fixture.execution);
        return unit.stageRepositoryInventory(input);
      },
      new AbortController(),
      owned,
    );
  };
  return {
    ...fixture,
    records,
    operations,
    claims,
    revocations,
    originals,
    qualifications,
    execute,
    reserve: () => execute(fixture.issuance),
  };
}

test("first inventory reservation uses real transition and same audit/COMMIT without a dispatch row", async () => {
  const fixture = inventoryProtocol();
  const result = await fixture.reserve();
  assert.equal(result.kind, "committed");
  assert.equal(result.value.kind, "staged");
  assert.equal(result.value.operation.input.method, "reserveRepositoryToken");
  assert.equal(fixture.qualifications.length, 2);
  assert.equal(fixture.qualifications[0][1], fixture.qualifications[1][1]);
  assert.equal(
    fixture.queries.some((q) => q.startsWith("INSERT INTO occ.repository_work_releases_v2")),
    false,
  );
  assert.equal(fixture.operations.size, 1);
  assert.equal(fixture.records.size, 1);
  assert.ok(
    fixture.queries.findIndex((q) => q.startsWith("INSERT INTO occ.audit_events")) <
      fixture.queries.indexOf("COMMIT"),
  );
});
test("inventory exact replay remains reconcile-only and creates no second operation", async () => {
  const fixture = inventoryProtocol();
  assert.equal((await fixture.reserve()).kind, "committed");
  const result = await fixture.reserve();
  assert.equal(result.kind, "committed");
  assert.equal(result.value.kind, "existing");
  assert.equal(result.value.nextAction, "reconcile-only");
  assert.equal(fixture.operations.size, 1);
});
test("inventory requires both original qualification sources before any write", async () => {
  const fixture = inventoryProtocol({ custodyInventory: undefined });
  assert.equal((await fixture.reserve()).kind, "not-committed");
  assert.equal(fixture.records.size, 0);
  assert.equal(fixture.queries.includes("COMMIT"), false);
});
test("caught inventory qualifier failure cannot publish or commit", async () => {
  const fixture = inventoryProtocol({
    async custodyInventory() {
      throw new Error("controlled custody refusal");
    },
  });
  const result = await fixture.run(
    async (unit) => {
      await unit.readForMutation(fixture.work, fixture.execution);
      await unit.stageRepositoryInventory(fixture.issuance).catch(() => {});
    },
    new AbortController(),
    { ...original(), operationRef: "reserve" },
  );
  assert.equal(result.kind, "not-committed");
  assert.equal(fixture.records.size, 0);
  assert.equal(fixture.queries.includes("COMMIT"), false);
});
test("exact inventory operation readback uses its original journal after Work closure", async () => {
  const fixture = inventoryProtocol();
  assert.equal((await fixture.reserve()).kind, "committed");
  fixture.invalidateWork();
  const result = await fixture.run(
    (unit) => unit.readRepositoryInventoryOperation(),
    new AbortController(),
    { ...original(), operationRef: "reserve" },
  );
  assert.equal(result.kind, "committed");
  assert.equal(result.value.input.operationRef, "reserve");
  assert.equal(fixture.qualifications.at(-1)[0], "custody-read");
});

async function reserveAndClaim(fixture) {
  const reserved = await fixture.reserve();
  assert.equal(reserved.kind, "committed");
  const row = reserved.value.operation.record;
  const claim = {
    schemaVersion: 2,
    method: "claimRepositoryMint",
    operationRef: "claim",
    scope: row.issuance.scope,
    createdAt: new Date().toISOString(),
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    providerAttemptRef: "provider-attempt",
    custodyIdentity: {
      lease: row.issuance.lease,
      key: {
        clientId: "client",
        bindingRef: row.issuance.bindingRef,
        immutableVersion: "key-version",
      },
      providerAttemptRef: "provider-attempt",
      tokenRef: "token-metadata",
      protectedRevocationRef: "revoke-metadata",
    },
  };
  return { claim, result: await fixture.execute(claim) };
}
test("inventory mint claim has a distinct original outer COMMIT and no credential release", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  assert.equal(
    result.kind,
    "committed",
    JSON.stringify({
      queries: fixture.queries,
      qualifications: fixture.qualifications.map((x) => x[0]),
    }),
  );
  assert.equal(result.value.kind, "staged");
  assert.equal(result.value.operation.record.state, "mint-unknown");
  assert.equal(fixture.claims.size, 1);
  assert.equal(fixture.operations.size, 2);
  assert.throws(
    () =>
      fixture.binding.participant.recognizeCommittedRelease(
        result.commit,
        "release",
        fixture.receiver,
        fixture.session,
      ),
    ScopeViolationError,
  );
});
test("late original inventory result uses a fresh operation after Work closes and preserves claim history", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  fixture.invalidateWork();
  const row = result.value.operation.record;
  const outcome = {
    schemaVersion: 2,
    method: "recordRepositoryMint",
    operationRef: "outcome",
    scope: row.issuance.scope,
    createdAt: new Date().toISOString(),
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    providerAttemptRef: "provider-attempt",
    evidenceRef: "late-evidence",
    outcome: "unknown",
    expiry: { kind: "expiry-unproven" },
  };
  const recorded = await fixture.execute(outcome);
  assert.equal(recorded.kind, "committed");
  assert.equal(recorded.value.operation.record.state, "mint-unknown");
  assert.equal(fixture.claims.size, 1);
  assert.equal(fixture.operations.size, 3);
  assert.equal(fixture.operations.get("claim").record.inventoryVersion, 2);
  assert.equal(fixture.qualifications.at(-1)[1].readset, undefined);
});
test("unknown claim COMMIT does not become a known release or authorize replay", async () => {
  let commits = 0;
  const fixture = inventoryProtocol({
    commit() {
      if (++commits === 2) throw new Error("controlled missing commit acknowledgement");
      return { command: "COMMIT", rows: [], rowCount: 0 };
    },
  });
  const { result, claim } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "unknown");
  assert.equal(result.operationRef, "claim");
  const replay = await fixture.execute(claim);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.value.kind, "existing");
  assert.equal(replay.value.nextAction, "reconcile-only");
  assert.equal(fixture.claims.size, 1);
});
test("inventory has no implicit zero-uncertainty clock", async () => {
  const fixture = inventoryProtocol({ inventoryClock: undefined });
  assert.equal((await fixture.reserve()).kind, "not-committed");
  assert.equal(fixture.records.size, 0);
});

test("known inventory commit recognizes exact original phase and rejects copied witnesses or replay", async () => {
  const fixture = inventoryProtocol();
  const { result, claim } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  const original = fixture.originals.get("claim");
  assert.equal(
    fixture.binding.participant.recognizeCommittedInventory(result.commit, original),
    result.value.operation,
  );
  assert.throws(
    () => fixture.binding.participant.recognizeCommittedInventory({ ...result.commit }, original),
    ScopeViolationError,
  );
  assert.throws(
    () => fixture.binding.participant.recognizeCommittedInventory(result.commit, { ...original }),
    ScopeViolationError,
  );
  const replay = await fixture.execute(claim);
  assert.equal(replay.kind, "committed");
  assert.throws(
    () => fixture.binding.participant.recognizeCommittedInventory(replay.commit, original),
    ScopeViolationError,
  );
});
test("fresh mint use reacquires the real Work/inventory readset and holds submitted cleanup", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  const abort = new AbortController();
  const lease = await fixture.binding.participant.acquireCommittedMint(
    result.commit,
    fixture.call(abort.signal),
  );
  assert.ok(lease);
  assert.equal(lease.operation.input.method, "claimRepositoryMint");
  assert.equal(fixture.qualifications.at(-1)[0], "mint-custody");
  lease.assertCurrent();
  lease.beginSubmittedUse();
  // The provider rechecks authority after capture; this does not grant another send.
  lease.assertCurrent();
  const releases = fixture.events.filter((e) => e[0] === "client-release").length;
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => lease.assertCurrent());
  assert.equal(fixture.events.filter((e) => e[0] === "client-release").length, releases);
  await lease.release();
  assert.equal(fixture.events.filter((e) => e[0] === "client-release").length, releases + 1);
  assert.equal(
    await fixture.binding.participant.acquireCommittedMint(result.commit, fixture.call()),
    undefined,
  );
});
test("historical mint claim cannot acquire fresh use after actual Work closure", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  fixture.invalidateWork();
  assert.equal(
    await fixture.binding.participant.acquireCommittedMint(result.commit, fixture.call()),
    undefined,
  );
});
test("mint submission is one way while post-capture currentness remains check-only", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  const lease = await fixture.binding.participant.acquireCommittedMint(
    result.commit,
    fixture.call(),
  );
  assert.ok(lease);
  lease.beginSubmittedUse();
  lease.assertCurrent();
  lease.assertCurrent();
  const releases = fixture.events.filter((e) => e[0] === "client-release").length;
  assert.throws(() => lease.beginSubmittedUse(), ScopeViolationError);
  assert.throws(() => lease.assertCurrent(), ScopeViolationError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.events.filter((e) => e[0] === "client-release").length, releases);
  await lease.release();
  assert.equal(fixture.events.filter((e) => e[0] === "client-release").length, releases + 1);
});
test("fresh mint use requires original current issue authority in both sources", async () => {
  const fixture = inventoryProtocol({ custodyMintUse: undefined });
  const { result } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  assert.equal(
    await fixture.binding.participant.acquireCommittedMint(result.commit, fixture.call()),
    undefined,
  );
});

async function acceptMint(fixture, row) {
  const result = await fixture.execute({
    schemaVersion: 2,
    method: "recordRepositoryMint",
    operationRef: "accepted-mint",
    scope: row.issuance.scope,
    createdAt: new Date().toISOString(),
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    providerAttemptRef: row.providerAttemptRef,
    evidenceRef: "original-captured-response",
    outcome: "accepted",
    tokenRef: "token-metadata",
    protectedRevocationRef: "revoke-metadata",
    returnedPermissions: { metadata: "read" },
    scopeAccepted: true,
    expiry: {
      kind: "provider-expiry",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      observedAt: new Date().toISOString(),
      evidenceRef: "original-expiry",
    },
  });
  assert.equal(result.kind, "committed");
  assert.equal(result.value.kind, "staged");
  return result.value.operation.record;
}
function cleanupInput(row, operationRef = "cleanup-claim") {
  return {
    schemaVersion: 2,
    method: "claimRepositoryRevocation",
    operationRef,
    scope: row.issuance.scope,
    createdAt: new Date().toISOString(),
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    tokenRef: row.tokenRef,
    protectedRevocationRef: row.protectedRevocationRef,
    revocationOperationRef: "original-revocation",
    expectedRevocationVersion: row.revocation?.version ?? 0,
    previousAttempt: row.revocation
      ? {
          kind: "reconcile",
          providerAttemptRef: row.revocation.providerAttemptRef,
          providerOutcome: row.revocation.state === "claimed" ? "unknown" : row.revocation.state,
        }
      : { kind: "none" },
  };
}
test("late accepted mint retains exact presend custody identity and immutable unknown history", async () => {
  const fixture = inventoryProtocol();
  const { result, claim } = await reserveAndClaim(fixture);
  assert.equal(result.kind, "committed");
  const originalClaim = fixture.claims.values().next().value;
  assert.equal(
    canonicalRepositoryWorkV2(originalClaim.custodyIdentity),
    canonicalRepositoryWorkV2(claim.custodyIdentity),
  );
  fixture.invalidateWork();
  const row = await acceptMint(fixture, result.value.operation.record);
  assert.equal(row.state, "outstanding");
  assert.equal(fixture.claims.values().next().value, originalClaim);
  assert.equal(fixture.operations.get("claim").record.state, "mint-unknown");
  assert.equal(fixture.qualifications.at(-1)[1].readset, undefined);
  assert.equal(
    fixture.qualifications.at(-1)[1].mintClaim.custodyIdentity.key.immutableVersion,
    "key-version",
  );
});
test("cleanup claim and confirmed result share the original inventory audit owner after Work closure", async () => {
  const fixture = inventoryProtocol();
  const { result } = await reserveAndClaim(fixture);
  let row = await acceptMint(fixture, result.value.operation.record);
  fixture.invalidateWork();
  const cleanup = await fixture.execute(cleanupInput(row));
  assert.equal(cleanup.kind, "committed");
  assert.equal(cleanup.value.kind, "staged");
  row = cleanup.value.operation.record;
  assert.equal(row.revocation.state, "claimed");
  assert.equal(fixture.revocations.size, 1);
  assert.equal(fixture.qualifications.at(-1)[1].readset, undefined);
  const claimed = fixture.revocations.get(row.revocation.claimRef);
  const observed = await fixture.execute({
    schemaVersion: 2,
    method: "recordRepositoryRevocation",
    operationRef: "cleanup-outcome",
    scope: row.issuance.scope,
    createdAt: new Date().toISOString(),
    target: row.target,
    expectedInventoryVersion: row.inventoryVersion,
    tokenRef: row.tokenRef,
    protectedRevocationRef: row.protectedRevocationRef,
    revocationOperationRef: "original-revocation",
    claimRef: claimed.claimRef,
    claimVersion: claimed.claimVersion,
    providerAttemptRef: claimed.providerAttemptRef,
    outcome: "confirmed",
    evidenceRef: "original-cleanup-response",
    observedAt: new Date().toISOString(),
  });
  assert.equal(observed.kind, "committed");
  assert.equal(observed.value.operation.record.state, "resolved-without-token");
  assert.equal(fixture.revocations.get(claimed.claimRef), claimed);
  assert.equal(fixture.qualifications.at(-1)[1].revocationClaim.claimRef, claimed.claimRef);
  assert.equal(
    fixture.queries.filter((q) => q.startsWith("INSERT INTO occ.audit_events")).length,
    5,
  );
  assert.equal(fixture.queries.filter((q) => q === "COMMIT").length, 5);
});
test("unknown cleanup claim COMMIT retains exact replay without another claim or committed witness", async () => {
  let commits = 0;
  const fixture = inventoryProtocol({
    commit() {
      if (++commits === 4) throw new Error("controlled cleanup acknowledgement lost");
      return { command: "COMMIT", rows: [], rowCount: 0 };
    },
  });
  const { result } = await reserveAndClaim(fixture);
  const row = await acceptMint(fixture, result.value.operation.record);
  const input = cleanupInput(row);
  assert.equal((await fixture.execute(input)).kind, "unknown");
  const replay = await fixture.execute(input);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.value.kind, "existing");
  assert.equal(replay.value.nextAction, "reconcile-only");
  assert.equal(fixture.revocations.size, 1);
  assert.throws(
    () =>
      fixture.binding.participant.recognizeCommittedInventory(
        replay.commit,
        fixture.originals.get(input.operationRef),
      ),
    ScopeViolationError,
  );
});
test("cleanup takeover keeps the same provider attempt and complete original claim history", async () => {
  let time = Date.now();
  const fixture = inventoryProtocol({
    inventoryClock: { read: () => ({ now: time, uncertaintyMs: 0 }) },
  });
  const { result } = await reserveAndClaim(fixture);
  const accepted = await acceptMint(fixture, result.value.operation.record);
  const first = await fixture.execute(cleanupInput(accepted));
  assert.equal(first.kind, "committed");
  const row = first.value.operation.record;
  const next = cleanupInput(row, "cleanup-reconcile");
  const early = await fixture.execute(next);
  assert.equal(early.kind, "committed");
  assert.equal(early.value.kind, "conflict");
  time = Date.parse(row.revocation.claimNotAfter) + 1;
  const resumed = await fixture.execute(next);
  assert.equal(resumed.kind, "committed");
  assert.equal(resumed.value.kind, "staged");
  assert.equal(
    resumed.value.operation.record.revocation.providerAttemptRef,
    row.revocation.providerAttemptRef,
  );
  assert.notEqual(resumed.value.operation.record.revocation.claimRef, row.revocation.claimRef);
  assert.equal(fixture.revocations.size, 2);
  assert.equal(fixture.operations.get("cleanup-claim").record.revocation.claimVersion, 1);
});
test("borrowed cleanup reader uses the original custody operation and refuses after that operation closes", async () => {
  let context, participant, borrowed;
  const fixture = inventoryProtocol({
    async acquireCustody(originalContext, operation, call, binding) {
      context = originalContext;
      participant = binding.participant;
    },
    async custodyInventory(facts) {
      if (facts.input.method !== "recordRepositoryRevocation") return;
      borrowed = participant.inventory(context);
      const read = await borrowed.findRevocationClaim(facts.input.claimRef);
      assert.equal(
        canonicalRepositoryWorkV2(read),
        canonicalRepositoryWorkV2(facts.revocationClaim),
      );
    },
  });
  const { result } = await reserveAndClaim(fixture);
  const row = await acceptMint(fixture, result.value.operation.record);
  const cleanup = await fixture.execute(cleanupInput(row));
  const record = cleanup.value.operation.record,
    claim = record.revocation;
  const observed = await fixture.execute({
    schemaVersion: 2,
    method: "recordRepositoryRevocation",
    operationRef: "borrowed-cleanup-outcome",
    scope: record.issuance.scope,
    createdAt: new Date().toISOString(),
    target: record.target,
    expectedInventoryVersion: record.inventoryVersion,
    tokenRef: record.tokenRef,
    protectedRevocationRef: record.protectedRevocationRef,
    revocationOperationRef: claim.revocationOperationRef,
    claimRef: claim.claimRef,
    claimVersion: claim.claimVersion,
    providerAttemptRef: claim.providerAttemptRef,
    outcome: "unknown",
    evidenceRef: "original-cleanup-unknown",
    observedAt: new Date().toISOString(),
  });
  assert.equal(observed.kind, "committed");
  assert.ok(borrowed);
  await assert.rejects(borrowed.findRevocationClaim(claim.claimRef), ScopeViolationError);
  await assert.rejects(
    borrowed.appendRevocationClaim(fixture.revocations.get(claim.claimRef)),
    ScopeViolationError,
  );
  assert.equal(fixture.revocations.size, 1);
});

// Exercise the real borrowed custody repository during dispatch, rather than the
// normal transition helper. The controlled peer accepts valid storage envelopes;
// State must independently refuse an inconsistent completed transition.
function borrowedInventoryDispatch(mode, corrupt = "none") {
  let context,
    participant,
    stored,
    mintClaim,
    appended = false,
    fixture;
  const recordRef = "borrowed-record";
  fixture = releaseProtocol({
    async acquireCustody(originalContext, operation, call, binding) {
      context = originalContext;
      participant = binding.participant;
    },
    async storage(statement, values) {
      if (
        statement.startsWith("SELECT document FROM occ.credential_inventory_records") &&
        values[3] === recordRef
      )
        return { rows: [{ document: stored }], rowCount: 1 };
      if (statement.startsWith("SELECT document FROM occ.credential_inventory_mint_claims"))
        return { rows: mintClaim ? [{ document: mintClaim }] : [], rowCount: mintClaim ? 1 : 0 };
      if (statement.startsWith("INSERT INTO occ.credential_inventory_mint_claims")) {
        mintClaim = JSON.parse(values.at(-1));
        return { rows: [{ record_ref: recordRef }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO occ.credential_inventory_revocation_claims"))
        return { rows: [{ claim_ref: "cleanup-claim" }], rowCount: 1 };
      if (
        statement.startsWith("UPDATE occ.credential_inventory_records") ||
        statement.startsWith("INSERT INTO occ.credential_inventory_records")
      ) {
        stored = JSON.parse(
          values.find((value) => typeof value === "string" && value.includes('"inventoryVersion"')),
        );
        return { rows: [{ record_ref: recordRef }], rowCount: 1 };
      }
      if (statement.startsWith("INSERT INTO occ.credential_inventory_operations")) {
        appended = true;
        return { rows: [{ operation_ref: "borrowed-operation" }], rowCount: 1 };
      }
      return undefined;
    },
    async stageRelease() {
      const tx = participant.inventory(context);
      const issuance = fixture.issuance,
        now = new Date().toISOString();
      const target = {
        issuanceOperationRef: issuance.operationRef,
        recordRef,
        intentDigest: repositoryInventoryDigestV2(issuance),
      };
      const identity = {
        lease: issuance.lease,
        key: {
          clientId: "client",
          bindingRef: issuance.bindingRef,
          immutableVersion: "key-version",
        },
        providerAttemptRef: "mint-attempt",
        tokenRef: "token",
        protectedRevocationRef: "protected-token",
      };
      const reserved = {
        schemaVersion: 2,
        target,
        inventoryVersion: 1,
        issuance,
        updatedAt: now,
        expiry: { kind: "expiry-unproven" },
        state: "reserved",
        disposition: "scope-held",
      };
      const outstanding = {
        ...reserved,
        inventoryVersion: 3,
        state: "outstanding",
        disposition: "mitigation-only",
        providerAttemptRef: "mint-attempt",
        tokenRef: "token",
        protectedRevocationRef: "protected-token",
        returnedPermissions: { metadata: "read" },
        evidenceRef: "mint-evidence",
      };
      stored =
        mode === "mint" || mode === "replace-for-insert" || mode === "insert-for-replace"
          ? reserved
          : outstanding;
      let input, result;
      if (mode === "mint") {
        input = {
          schemaVersion: 2,
          method: "claimRepositoryMint",
          operationRef: "borrowed-operation",
          scope: issuance.scope,
          createdAt: now,
          target,
          expectedInventoryVersion: 1,
          providerAttemptRef: identity.providerAttemptRef,
          custodyIdentity: identity,
        };
        await tx.insertMintClaim({
          schemaVersion: 2,
          custodyIdentity: identity,
          issuanceOperationRef: issuance.operationRef,
          recordRef,
          issuanceIntentDigest: target.intentDigest,
          useOperationRef: input.operationRef,
          useIntentDigest: repositoryInventoryDigestV2(input),
          providerAttemptRef: identity.providerAttemptRef,
          inventoryVersion: 2,
        });
        result = {
          ...reserved,
          inventoryVersion: 2,
          state: "mint-unknown",
          providerAttemptRef: identity.providerAttemptRef,
        };
        if (corrupt === "attempt") result.providerAttemptRef = "another-attempt";
        if (corrupt === "state") {
          result.state = "reserved";
          delete result.providerAttemptRef;
        }
        await tx.replaceRecord(1, result);
      } else if (mode === "cleanup") {
        mintClaim = {
          schemaVersion: 2,
          custodyIdentity: identity,
          issuanceOperationRef: issuance.operationRef,
          recordRef,
          issuanceIntentDigest: target.intentDigest,
          useOperationRef: "mint-operation",
          useIntentDigest: `sha256:${"a".repeat(64)}`,
          providerAttemptRef: identity.providerAttemptRef,
          inventoryVersion: 2,
        };
        input = {
          schemaVersion: 2,
          method: "claimRepositoryRevocation",
          operationRef: "borrowed-operation",
          scope: issuance.scope,
          createdAt: now,
          target,
          expectedInventoryVersion: 3,
          tokenRef: identity.tokenRef,
          protectedRevocationRef: identity.protectedRevocationRef,
          revocationOperationRef: "original-cleanup",
          expectedRevocationVersion: 0,
          previousAttempt: { kind: "none" },
        };
        const claim = {
          schemaVersion: 2,
          input,
          claimRef: "cleanup-claim",
          claimVersion: 1,
          providerAttemptRef: "cleanup-attempt",
          claimedAt: now,
          claimNotAfter: new Date(Date.now() + 1000).toISOString(),
        };
        await tx.appendRevocationClaim(claim);
        result = {
          ...outstanding,
          inventoryVersion: 4,
          revocation: {
            state: "claimed",
            version: 1,
            revocationOperationRef: input.revocationOperationRef,
            providerAttemptRef: claim.providerAttemptRef,
            claimRef: claim.claimRef,
            claimVersion: claim.claimVersion,
            claimedAt: claim.claimedAt,
            claimNotAfter: claim.claimNotAfter,
            priorOutcome: "none",
          },
        };
        if (corrupt === "cleanup-operation")
          result.revocation.revocationOperationRef = "another-cleanup";
        if (corrupt === "token") result.tokenRef = "another-token";
        if (corrupt === "protected-token")
          result.protectedRevocationRef = "another-protected-token";
        await tx.replaceRecord(3, result);
      } else if (mode === "cas") {
        input = {
          schemaVersion: 2,
          method: "retireRepositoryToken",
          operationRef: "borrowed-operation",
          scope: issuance.scope,
          createdAt: now,
          target,
          expectedInventoryVersion: 2,
          evidenceRef: "retire-evidence",
        };
        result = { ...outstanding, inventoryVersion: 4, evidenceRef: input.evidenceRef };
        await tx.replaceRecord(3, result);
      } else if (mode === "replace-for-insert") {
        input = issuance;
        result = { ...reserved, inventoryVersion: 2 };
        await tx.replaceRecord(1, result);
      } else {
        input = {
          schemaVersion: 2,
          method: "resolveRepositoryToken",
          operationRef: "borrowed-operation",
          scope: issuance.scope,
          createdAt: now,
          target,
          expectedInventoryVersion: 1,
          evidenceRef: "no-send",
          outcome: "definitely-not-dispatched",
        };
        result = reserved;
        await tx.insertRecord(result, 1);
      }
      await tx.appendOperation({
        input,
        digest: repositoryInventoryDigestV2(input),
        record: result,
        commitRef: tx.commitRef,
        recordedAt: now,
        state: "effect-unknown",
      });
    },
  });
  return { ...fixture, appended: () => appended };
}
for (const mode of ["mint", "cleanup"])
  test(`valid borrowed ${mode} completion remains accepted with dispatch`, async () => {
    const fixture = borrowedInventoryDispatch(mode);
    assert.equal((await fixture.commit()).kind, "committed");
    assert.equal(fixture.appended(), true);
  });

async function prepareCleanupUse(fixture) {
  const { result } = await reserveAndClaim(fixture);
  const record = await acceptMint(fixture, result.value.operation.record);
  const input = cleanupInput(record);
  const cleanup = await fixture.execute(input);
  assert.equal(cleanup.kind, "committed");
  assert.equal(cleanup.value.kind, "staged");
  return { cleanup, input };
}
test("known cleanup use holds independent observation after Work closure through actual settlement", async () => {
  const fixture = inventoryProtocol();
  const { cleanup } = await prepareCleanupUse(fixture);
  fixture.invalidateWork();
  const before = fixture.queries.length;
  const abort = new AbortController(),
    call = fixture.call(abort.signal);
  const lease = await fixture.binding.participant.acquireCommittedRevocation(cleanup.commit, call);
  assert.ok(lease);
  assert.equal(lease.operation, cleanup.value.operation);
  assert.equal(fixture.qualifications.at(-1)[0], "revocation-custody");
  assert.equal(
    fixture.queries
      .slice(before)
      .some((q) => q.startsWith("SELECT canonical_document FROM occ.repository_work_heads_v2")),
    false,
  );
  lease.assertCurrent();
  lease.beginSubmittedUse();
  lease.assertCurrent();
  const releases = fixture.events.filter((event) => event[0] === "client-release").length;
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => lease.assertCurrent(), ScopeViolationError);
  assert.equal(fixture.events.filter((event) => event[0] === "client-release").length, releases);
  // Original provider.settleAttempt(exactResult) has completed at this cut.
  await lease.release();
  assert.equal(
    fixture.events.filter((event) => event[0] === "client-release").length,
    releases + 1,
  );
  assert.equal(
    await fixture.binding.participant.acquireCommittedRevocation(cleanup.commit, fixture.call()),
    undefined,
  );
});
for (const missing of ["qualifyRevocationUse", "custodyRevocationUse"])
  test(`cleanup use refuses missing original ${missing}`, async () => {
    const fixture = inventoryProtocol({ [missing]: undefined });
    const { cleanup } = await prepareCleanupUse(fixture);
    fixture.invalidateWork();
    assert.equal(
      await fixture.binding.participant.acquireCommittedRevocation(cleanup.commit, fixture.call()),
      undefined,
    );
  });
test("copied or replay cleanup commits cannot enroll a provider use", async () => {
  const fixture = inventoryProtocol();
  const { cleanup, input } = await prepareCleanupUse(fixture);
  const before = fixture.queries.length;
  assert.equal(
    await fixture.binding.participant.acquireCommittedRevocation(
      { ...cleanup.commit },
      fixture.call(),
    ),
    undefined,
  );
  assert.equal(fixture.queries.length, before);
  const replay = await fixture.execute(input);
  assert.equal(replay.kind, "committed");
  assert.equal(replay.value.kind, "existing");
  assert.equal(
    await fixture.binding.participant.acquireCommittedRevocation(replay.commit, fixture.call()),
    undefined,
  );
});
test("known cleanup claim cannot submit after its actual retained attempt changes", async () => {
  const fixture = inventoryProtocol();
  const { cleanup } = await prepareCleanupUse(fixture);
  const record = cleanup.value.operation.record;
  fixture.records.set(record.target.recordRef, {
    ...record,
    revocation: { ...record.revocation, providerAttemptRef: "different-original-attempt" },
  });
  assert.equal(
    await fixture.binding.participant.acquireCommittedRevocation(cleanup.commit, fixture.call()),
    undefined,
  );
});
test("cleanup submission cannot repeat while currentness checks remain available", async () => {
  const fixture = inventoryProtocol();
  const { cleanup } = await prepareCleanupUse(fixture);
  const lease = await fixture.binding.participant.acquireCommittedRevocation(
    cleanup.commit,
    fixture.call(),
  );
  assert.ok(lease);
  lease.beginSubmittedUse();
  lease.assertCurrent();
  assert.throws(() => lease.beginSubmittedUse(), ScopeViolationError);
  await lease.release();
});
for (const [mode, corrupt] of [
  ["mint", "attempt"],
  ["mint", "state"],
  ["cleanup", "cleanup-operation"],
  ["cleanup", "token"],
  ["cleanup", "protected-token"],
  ["cas", "expected-version"],
  ["replace-for-insert", "method"],
  ["insert-for-replace", "method"],
])
  test(`borrowed ${mode}/${corrupt} correspondence refuses before COMMIT`, async () => {
    const fixture = borrowedInventoryDispatch(mode, corrupt);
    const result = await fixture.commit();
    assert.equal(
      fixture.appended(),
      true,
      "the real borrowed repository reached appendOperation before finalization",
    );
    assert.equal(result.kind, "not-committed");
    assert.equal(fixture.queries.includes("COMMIT"), false);
    assert.equal(fixture.queries.includes("ROLLBACK"), true);
    assert.equal(fixture.events.filter((event) => event[0] === "release").length, 2);
  });
