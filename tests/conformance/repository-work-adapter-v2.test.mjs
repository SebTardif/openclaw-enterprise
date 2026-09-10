import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { GitHubMediationService } from "../../packages/occ/src/github-mediation-v2/service.ts";
import { RepositoryWorkOperationOwnerV2 } from "../../packages/occ/src/lifecycle/repository-work-v2.ts";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";
import {
  RepositoryWorkStateAdapterV2,
  compareRepositoryWorkStateReadsetV2,
} from "../../packages/occ/src/lifecycle/repository-work-state-v2.ts";
import {
  createPostgresRepositoryWorkBindingV2,
  canonicalRepositoryWorkV2,
} from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import { CredentialInventoryOwnerPhaseV1 } from "../../packages/occ/src/ports/platform-unit-of-work.ts";
import {
  githubMetadataDigest,
  githubGitReadDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { repositoryWorkPolicyDigestV2 } from "../../packages/occ/src/lifecycle/repository-work-policy-v2.ts";

// Actual Work adapter + actual State private binding/phase/query repository.
// The outer transaction, SQL transport, policy/native/custody peers are controlled
// protocol fixtures. These cases do not prove PostgreSQL COMMIT, real policy,
// protected material, native identity or a passing production GitHub flow.
const copy = (value) => structuredClone(value);
const test = (name, body) => nodeTest(name, { timeout: 5000 }, body);
const open = Object.freeze({
  version: 2,
  sequence: 1,
  method: "open-read",
  request_ref: "1".repeat(32),
  attachment_ref: "attachment/one",
  repository_owner: "example",
  repository_name: "project",
  request_sha256: githubMetadataDigest("example", "project"),
});

// Actual bytes used only to form the controlled request declaration. These tests
// do not establish native retention, upstream transmission, or Git object output.
const gitBody = Buffer.from("0014command=ls-refs\n00010009peel\n000csymrefs\n0000");
function gitOpen(operation = "upload-pack") {
  const body = operation === "discovery" ? Buffer.alloc(0) : gitBody;
  const bodySha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return Object.freeze({
    ...open,
    version: 3,
    git_operation: operation,
    git_protocol: "version=2",
    body_bytes: body.length,
    body_sha256: bodySha,
    request_sha256: githubGitReadDigest(
      open.repository_owner,
      open.repository_name,
      operation,
      body.length,
      bodySha,
    ),
  });
}
function gitBinding(request) {
  return {
    version: 3,
    operation: "git:read",
    gitOperation: request.git_operation,
    gitProtocol: request.git_protocol,
    bodyBytes: request.body_bytes,
    bodySha256: request.body_sha256,
    requestDigest: request.request_sha256,
  };
}
const metadataOpen = open;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function values(canonical = false, open = metadataOpen) {
  const context = Object.freeze({ controlled: "context" });
  const transportBinding = Object.freeze({ controlled: "transport" });
  const origin = Object.freeze({ controlled: "origin" });
  const preparation = Object.freeze({ controlled: "State preparation" });
  const token = Object.freeze({ controlled: "token handle, no material" });
  const commit = Object.freeze({ controlled: "COMMIT receipt" });
  const end = new Date(Date.now() + 9_000).toISOString();
  const scope = {
    installationRef: canonical ? "ins_11111111-1111-4111-8111-111111111111" : "installation/one",
    namespaceRef: canonical ? "ns_22222222-2222-4222-8222-222222222222" : "namespace/one",
    agentRef: canonical ? "agt_33333333-3333-4333-8333-333333333333" : "agent/one",
    revisionRef: "revision/one",
  };
  const profile = { ref: "profile/one", revision: "1" };
  const work = { workRef: "work/one", revision: 1 };
  const service = {
    kind: "service_principal",
    id: "service/one",
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  };
  const execution = {
    attempt: {
      installationRef: scope.installationRef,
      namespaceRef: scope.namespaceRef,
      agentRef: scope.agentRef,
      conversationRef: "conversation/one",
      turnRef: "turn/one",
      attemptRef: "attempt/one",
      reservationRef: "reservation/one",
    },
    assignmentRef: "assignment/one",
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation/one",
    executionGeneration: "1",
    receiverRef: "receiver/one",
    protectedOriginRef: "origin/one",
    executionProfile: profile,
    predecessor: { kind: "none" },
  };
  const current = {
    original: {
      operationRef: "operation/one",
      requestDigest: open.request_sha256,
      invocationRef: "invocation/one",
      scope,
    },
    work,
    execution,
    lineage: {
      scope,
      own: { work, originalHorizon: end, state: "open", withdrawalRevision: 0 },
      membershipProfile: profile,
      kind: "root",
      rootWorkRef: work.workRef,
      parentWorkRef: null,
      ancestors: [],
    },
    withdrawals: [{ kind: "not-withdrawn-at-cut", revision: 0 }],
    service,
    originalHorizon: end,
    repository: { id: "repository/one", owner: "example", name: "project", profile },
    policy: {
      operation: "work.repository.use",
      service,
      repositoryId: "repository/one",
      profile,
      ...(open.version === 3
        ? {
            repositoryOperation: "git:read",
            requiredPermissions: ["contents:read", "metadata:read"],
          }
        : { permission: "metadata:read" }),
    },
    ...(open.version === 3 ? { repositoryRequest: gitBinding(open) } : {}),
    attachmentRef: open.attachment_ref,
    dnsBindingRef: "dns/one",
    upstreamIpv4: "140.82.114.5",
    validUntil: end,
  };
  const native = {
    context,
    transportBinding,
    receiverRef: execution.receiverRef,
    attachmentRef: open.attachment_ref,
    execution: copy(execution),
    service: copy(service),
  };

  return {
    context,
    transportBinding,
    origin,
    token,
    commit,
    current,
    native,
    scope,
    execution,
    end,
  };
}

// Controlled storage peer, not PostgreSQL/durability proof. It applies only raw
// key/CAS persistence and reports the exact effects of the REAL V2 transition;
// it does not manufacture operation outcomes or State COMMIT witnesses.
function inventoryStorage(db, owner, commitRef, hooks) {
  const get = async (table, key) => {
    owner.assertActive();
    return db[table].get(key);
  };
  const put = (table, key, value, effect) => {
    owner.assertWriting();
    assert.equal(db[table].has(key), false);
    db[table].set(key, copy(value));
    owner.recordEffect(effect);
  };
  return {
    commitRef,
    assertActive: owner.assertActive,
    findLease: (ref) => get("leases", ref),
    findRecord: async (ref) =>
      hooks.inventoryRecord?.(await get("records", ref)) ?? (await get("records", ref)),
    findOperation: async (ref) =>
      hooks.inventoryOperation?.(await get("inventoryOperations", ref)) ??
      (await get("inventoryOperations", ref)),
    findMintClaim: (ref) => get("mintClaims", ref),
    findRevocationClaim: (ref) => get("revocationClaims", ref),
    async insertLease(lease) {
      put("leases", lease.accessLeaseRef, lease, { kind: "repository-lease-inserted", lease });
    },
    async listLeaseRecords(ref) {
      owner.assertActive();
      return [...db.records.values()].filter((r) => r.issuance.lease.accessLeaseRef === ref);
    },
    async capacity(target, leaseRef) {
      owner.assertActive();
      return {
        installationLive: db.records.size,
        leaseLive: [...db.records.values()].filter(
          (r) => r.issuance.lease.accessLeaseRef === leaseRef,
        ).length,
        mintActive: db.mintClaims.size > 0,
        targetHeld: [...db.records.values()].some(
          (r) => r.issuance.lease.accessLeaseRef !== leaseRef,
        ),
        freeSlot: 1,
      };
    },
    async insertRecord(record) {
      put("records", record.target.recordRef, record, {
        kind: "repository-record-inserted",
        record,
      });
    },
    async replaceRecord(version, record) {
      owner.assertWriting();
      assert.equal(db.records.get(record.target.recordRef).inventoryVersion, version);
      db.records.set(record.target.recordRef, copy(record));
      owner.recordEffect({ kind: "repository-record-replaced", expectedVersion: version, record });
    },
    async appendOperation(operation) {
      put("inventoryOperations", operation.input.operationRef, operation, {
        kind: "repository-operation-appended",
        operation,
      });
    },
    async insertMintClaim(claim) {
      put("mintClaims", claim.recordRef, claim, { kind: "repository-mint-claim-inserted", claim });
    },
    async appendRevocationClaim(claim) {
      put("revocationClaims", claim.claimRef, claim, {
        kind: "repository-revocation-claim-appended",
        claim,
      });
    },
  };
}

function fixture(options = {}) {
  const open = options.request ?? metadataOpen;
  const version = options.version ?? open.version;
  const v = values(options.inventory, open),
    events = [],
    hooks = {},
    selected = Object.freeze({ controlled: "selection" }),
    receiver = Object.freeze({ controlled: "receiver" }),
    session = Object.freeze({ controlled: "session" });
  v.current.repository.id = "789";
  v.current.policy.repositoryId = "789";
  const db = {
    heads: new Map(),
    operations: new Map(),
    releases: new Map(),
    leases: new Map(),
    records: new Map(),
    inventoryOperations: new Map(),
    mintClaims: new Map(),
    revocationClaims: new Map(),
  };
  const sqlScope = {
    installationId: v.scope.installationRef,
    namespaceId: v.scope.namespaceRef,
    agentId: v.scope.agentRef,
    revisionRef: v.scope.revisionRef,
  };
  const original = (name) => ({ ...copy(v.current.original), operationRef: `operation/${name}` });
  const target = {
    installationId: v.scope.installationRef,
    githubHost: "github.com",
    appId: "123",
    githubInstallationId: "456",
    repositoryId: "789",
  };
  const policy = {
    schemaVersion: 2,
    policyRef: "policy/one",
    version: 1,
    status: "enabled",
    scope: sqlScope,
    servicePrincipalId: v.current.service.id,
    repository: {
      target,
      owner: v.current.repository.owner,
      name: v.current.repository.name,
      profile: v.current.repository.profile,
    },
    executionProfile: v.execution.executionProfile,
    operations:
      options.policyOperations ??
      (version === 3 ? ["metadata:read", "git:read"] : ["metadata:read"]),
    bounds: {
      notBefore: new Date(Date.now() - 60000).toISOString(),
      notAfter: new Date(Date.now() + 60000).toISOString(),
      maximumWorkMilliseconds: 10000,
    },
  };
  // Policy scope has no AgentRevision field; execution admission carries it.
  policy.scope = {
    installationId: sqlScope.installationId,
    namespaceId: sqlScope.namespaceId,
    agentId: sqlScope.agentId,
  };
  const record = {
    scope: sqlScope,
    workRef: v.current.work.workRef,
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: v.current.work.workRef,
    originalHorizon: v.current.originalHorizon,
    state: "open",
    execution: copy(v.execution),
    policy: copy(v.current.policy),
    originalAdmission: { operationRef: "operation/admission" },
  };
  const admission = {
    ...original("admission"),
    scope: sqlScope,
    commitRef: "initial/commit",
    kind: "admission",
    document: { record },
  };
  const data = {
    current: v.current,
    preparation: original("preparation"),
    observation: original("observation"),
    admission: options.initial
      ? { kind: "new", original: original("admission"), record: { record } }
      : { kind: "existing", originalAdmission: admission },
    sessionRef: `github-native/${"a".repeat(32)}`,
    repositoryTarget: target,
    workBeganAt: new Date().toISOString(),
    policyAdmission: {
      policyRef: policy.policyRef,
      policyVersion: policy.version,
      policyDigest: repositoryWorkPolicyDigestV2(policy),
      execution: copy(v.execution),
      originalHorizon: v.current.originalHorizon,
    },
    observationRef: "observation/one",
    observationEvidenceRef: "evidence/one",
  };
  // Controlled original source owns this private set. Shape-equivalent copies
  // are rejected by actual adapter calls to its retained participant.
  const issuedSelectionOriginals = new WeakSet([
    data.preparation,
    data.current.original,
    data.observation,
    ...(data.admission.kind === "new" ? [data.admission.original] : []),
  ]);
  if (!options.initial) {
    db.heads.set(record.workRef, canonicalRepositoryWorkV2(record));
    db.operations.set(admission.operationRef, canonicalRepositoryWorkV2(admission));
  }
  let initialReadset = true,
    handoff = false,
    fullCurrent = false;
  const enter = async (scope, bounds, execution, body) => {
    if (options.strictTransfer)
      assert.equal(initialReadset, false, "old SQL owner retired before entry");
    events.push(["outer-enter"]);
    assert.equal(bounds.signal.aborted, false);
    const local = Object.fromEntries(Object.entries(db).map(([k, v]) => [k, new Map(v)]));
    // Controlled outer SQL owner models the original backend's accepted-work
    // drain, not its authority. Actual State context membership/phase checks
    // still decide whether Work can register a continuation.
    const accepted = new Set();
    // Model the selected outer transaction bound while preserving its drain.
    // This is a controlled clock/SQL peer, not a real database timeout result.
    const timer = setTimeout(() => {
      execution.phase.poison(new Error("Controlled transaction deadline."));
      events.push(["outer-timeout"]);
    }, bounds.timeoutMs);
    let enrollmentClosed = false;
    const drainAccepted = async () => {
      while (accepted.size) await Promise.all([...accepted]);
    };
    const context = {
      scope,
      transaction: {
        assertActive() {
          execution.phase.assertOperationActive();
        },
      },
      query: {
        async query(sql, args) {
          execution.phase.assertOperationActive();
          events.push(["query", sql]);
          await hooks.query?.(sql, args);
          if (sql.startsWith("SELECT id FROM occ."))
            return { rows: [{ id: args.at(-1) }], rowCount: 1 };
          if (
            options.currentPolicy &&
            sql.startsWith("SELECT v.canonical_document FROM occ.repository_work_policy_heads_v2")
          ) {
            assert.deepEqual(args, [
              sqlScope.installationId,
              sqlScope.namespaceId,
              sqlScope.agentId,
              policy.policyRef,
            ]);
            // Only the SQL transport is controlled. The original State policy
            // repository decodes this envelope and the Work adapter decides use.
            return {
              rows: [
                {
                  canonical_document: canonicalRepositoryWorkV2({
                    ...policy.scope,
                    policyRef: policy.policyRef,
                    version: policy.version,
                    status: policy.status,
                    servicePrincipalId: policy.servicePrincipalId,
                    repositoryId: policy.repository.target.repositoryId,
                    document: policy,
                  }),
                },
              ],
              rowCount: 1,
            };
          }
          let table = sql.includes("repository_work_heads_v2")
            ? local.heads
            : sql.includes("repository_work_operations_v2")
              ? local.operations
              : sql.includes("repository_work_releases_v2")
                ? local.releases
                : undefined;
          assert.ok(table, "controlled SQL transport handles only named repository tables");
          if (sql.startsWith("SELECT canonical_document")) {
            const text = table.get(args[4]);
            return {
              rows: text === undefined ? [] : [{ canonical_document: text }],
              rowCount: text === undefined ? 0 : 1,
            };
          }
          if (sql.startsWith("INSERT INTO ")) {
            assert.equal(table.has(args[4]), false, "controlled unique-key conflict");
            const text = args.at(-1);
            table.set(args[4], text);
            return { rows: [{ canonical_document: text }], rowCount: 1 };
          }
          throw new Error("Unselected controlled SQL statement.");
        },
      },
    };
    try {
      const result = await body({
        context,
        joinAccepted(pending) {
          const settled = pending.then(
            () => undefined,
            (error) => execution.phase.poison(error),
          );
          accepted.add(settled);
          void settled.then(() => accepted.delete(settled));
          events.push(["outer-join-accepted"]);
          if (enrollmentClosed)
            execution.phase.poison(new Error("Controlled late Work enrollment."));
          return undefined;
        },
        inventory(owner) {
          if (options.inventory) return inventoryStorage(local, owner, execution.commitRef, hooks);
          const unused = async () => {
            throw new Error("Unselected controlled inventory write.");
          };
          const access = {
            accessLeaseRef: "lease/one",
            target,
            work: v.current.work,
            execution: v.execution,
            original: v.current.original,
            notAfter: v.current.originalHorizon,
          };
          const inventoryRecord = {
            inventoryVersion: 1,
            state: "outstanding",
            disposition: "current-check-required",
            issuance: { lease: access },
            expiry: { kind: "provider-expiry", expiresAt: v.current.originalHorizon },
          };
          return Object.freeze({
            commitRef: execution.commitRef,
            async findRecord(ref) {
              assert.equal(ref, "inventory/one");
              return hooks.inventory?.(inventoryRecord) ?? inventoryRecord;
            },
            async findLease(ref) {
              assert.equal(ref, "lease/one");
              return access;
            },
            insertLease: unused,
            findOperation: unused,
            listLeaseRecords: unused,
            capacity: unused,
            insertRecord: unused,
            replaceRecord: unused,
            appendOperation: unused,
            findMintClaim: unused,
            insertMintClaim: unused,
            findRevocationClaim: unused,
            appendRevocationClaim: unused,
          });
        },
        async appendAudit(actor, operation, kind) {
          events.push(["audit", kind, operation]);
        },
      });
      await execution.phase.drainAccepted();
      await drainAccepted();
      await execution.phase.runFinalization(() => execution.prepareCommit());
      await execution.phase.drainAccepted();
      await drainAccepted();
      execution.phase.assertCommitReady();
      execution.assertCommitReady();
      execution.disposition = "sent";
      await hooks.commit?.(local);
      for (const key of Object.keys(db)) db[key] = local[key];
      execution.observeAcknowledgment();
      execution.disposition = "acknowledged";
      events.push(["ack"]);
      return result;
    } finally {
      enrollmentClosed = true;
      await drainAccepted();
      execution.close();
      execution.phase.close();
      clearTimeout(timer);
      events.push(["outer-closed"]);
    }
  };
  const binding = createPostgresRepositoryWorkBindingV2(
    enter,
    () => new CredentialInventoryOwnerPhaseV1(),
  );
  const native = {
    async acquire() {
      return v.origin;
    },
    async inspect(o, c) {
      if (options.strictTransfer)
        assert.equal(initialReadset, true, "no later initial-readset refresh");
      events.push(["native-inspect"]);
      assert.equal(o, v.origin);
      assert.equal(c.context, v.context);
      return v.native;
    },
    async inspectNative(o, c) {
      assert.equal(o, v.origin);
      assert.equal(c.context, v.context);
      events.push(["native-enroll", c.deadline]);
      return (await hooks.enroll?.(c)) ?? v.native;
    },
    assertNativeCurrent(o, c) {
      assert.equal(o, v.origin);
      assert.equal(c.signal.aborted, false);
      events.push(["native-only"]);
      return hooks.nativeOnly?.(c) ?? hooks.nativeCurrent?.(c);
    },
    assertCurrent(o, c) {
      if (options.strictTransfer)
        assert.equal(fullCurrent, true, "full fence requires same-unit State hold");
      events.push(["native-and-state"]);
      assert.equal(o, v.origin);
      assert.equal(c.signal.aborted, false);
      return hooks.nativeCurrent?.();
    },
    async release() {
      events.push(["native-release"]);
    },
  };
  const call = () => ({
    context: v.context,
    signal: new AbortController().signal,
    requestRef: open.request_ref,
    recipientRef: v.native.receiverRef,
    deadline: new Date(Date.now() + 8000).toISOString(),
  });
  const issuedInventoryOriginals = new WeakSet();
  const reservation = {
    schemaVersion: 2,
    method: "reserveRepositoryToken",
    operationRef: "inventory/reserve",
    scope: policy.scope,
    createdAt: new Date().toISOString(),
    lease: {
      schemaVersion: 2,
      accessLeaseRef: "lease/one",
      target,
      original: copy(v.current.original),
      work: copy(v.current.work),
      execution: copy(v.execution),
      createdAt: new Date().toISOString(),
      notAfter: v.current.originalHorizon,
    },
    bindingRef: "credential/binding",
    permissionProfile: copy(v.current.repository.profile),
    requestedPermissions:
      version === 3 ? { contents: "read", metadata: "read" } : { metadata: "read" },
    deadline: v.current.originalHorizon,
  };
  const reservationOriginal = {
    ...original("inventory-reserve"),
    operationRef: reservation.operationRef,
  };
  issuedInventoryOriginals.add(reservationOriginal);
  const inventorySelection = {
    reservation: { original: reservationOriginal, input: reservation },
    async selectOperation(input) {
      await hooks.selectInventory?.(input);
      const o = { ...original(input.method), operationRef: input.operationRef };
      issuedInventoryOriginals.add(o);
      return o;
    },
    async retainIssue(context, o, input, c) {
      assert.ok(issuedInventoryOriginals.has(o), "retain actual State-issued original identity");
      if (hooks.issueResult) return hooks.issueResult();
      return held(context, selected, o, c, "issue");
    },
    async retainObservation(context, o, input, c) {
      assert.ok(issuedInventoryOriginals.has(o));
      return held(context, selected, o, c, "inventory-history");
    },
    async observationCall() {
      events.push(["inventory-observer-call"]);
      const c = call();
      hooks.lastInventoryCall = c;
      return c;
    },
    async release() {
      events.push(["inventory-selection-release"]);
      await hooks.inventoryRelease?.();
    },
  };
  const source = {
    ...(options.inventory
      ? {
          async acquireInventory(s, o, c) {
            assert.equal(s, selected);
            assert.equal(o, v.origin);
            await hooks.openInventory?.();
            return hooks.inventorySelection?.(inventorySelection) ?? inventorySelection;
          },
        }
      : {}),
    async acquire(o) {
      hooks.selectionAcquire?.();
      assert.equal(o, v.origin);
      return selected;
    },
    async inspect(s, o) {
      assert.equal(s, selected);
      assert.equal(o, v.origin);
      return hooks.inspect?.(data) ?? data;
    },
    async prepareStateUse(s, o, c) {
      assert.equal(s, selected);
      assert.equal(o, v.origin);
      if (options.strictTransfer) {
        assert.equal(handoff, false);
        assert.equal(fullCurrent, false);
      }
      events.push(["handoff-enter"]);
      await hooks.handoff?.(c);
      initialReadset = false;
      handoff = true;
      events.push(["readset-retired"]);
    },
    async retainPolicy(context, s, o, c) {
      if (options.strictTransfer) assert.equal(handoff, true);
      if (options.currentPolicy) {
        assert.equal(s, selected);
        assert.ok(issuedSelectionOriginals.has(o) || issuedInventoryOriginals.has(o));
        events.push(["held", "policy", o.operationRef]);
        const lease = await binding.participant.acquireCurrentPolicy(
          context,
          o,
          c,
          policy.policyRef,
        );
        await hooks.acquiredCurrentPolicy?.(lease, c);
        if (options.strictTransfer) {
          const rows = await binding.participant.acquireCurrentReadset(
            context,
            o,
            c,
            v.current.work,
            v.execution,
          );
          compareRepositoryWorkStateReadsetV2(rows.readset, v.current);
          fullCurrent = true;
          const check = lease.assertCurrent.bind(lease),
            release = lease.release.bind(lease);
          return {
            policy: lease.policy,
            assertCurrent() {
              rows.assertCurrent();
              return check();
            },
            async prepareCommit() {
              rows.assertCurrent();
              check();
            },
            async release() {
              fullCurrent = false;
              handoff = false;
              await release();
            },
          };
        }
        return lease;
      }
      return held(context, s, o, c, "policy");
    },
    async retainObservation(context, s, o, c) {
      return held(context, s, o, c, "history");
    },
    async observationCall(s) {
      assert.equal(s, selected);
      return call();
    },
    async release(s) {
      assert.equal(s, selected);
      events.push(["selection-release"]);
    },
  };
  async function held(context, s, o, c, kind) {
    binding.participant.assertOriginal(context, o, c);
    assert.equal(s, selected);
    assert.ok(
      issuedSelectionOriginals.has(o) || issuedInventoryOriginals.has(o),
      "original State selection privately recognizes the actual operation object",
    );
    events.push(["held", kind, o.operationRef]);
    await hooks.acquire?.(kind, c);
    let live = true;
    if (kind === "policy") fullCurrent = true;
    const lease = {
      policy,
      assertCurrent() {
        assert.equal(live, true);
        return hooks.current?.(kind);
      },
      async prepareCommit() {
        events.push(["policy-prepare", kind]);
        await hooks.prepare?.(kind);
      },
      async release() {
        live = false;
        if (kind === "policy") {
          fullCurrent = false;
          handoff = false;
        }
        events.push(["policy-release", kind]);
      },
    };
    return hooks.heldResult?.(kind, lease) ?? lease;
  }
  const tokenBinding = {
    source: {
      async acquire(context, o, c) {
        binding.participant.assertOriginal(context, o, c);
        events.push(["custody-acquire", o.operationRef]);
        await hooks.custodyAcquire?.(context, o, c);
        let live = true;
        return {
          receiver,
          session,
          receiverRef: v.native.receiverRef,
          sessionRef: data.sessionRef,
          assertCurrent() {
            assert.equal(live, true);
            return undefined;
          },
          async prepareCommit() {},
          async release() {
            live = false;
            events.push(["custody-release"]);
          },
          ...(options.inventory
            ? {
                inventoryClock: {
                  read() {
                    return { now: Date.now(), uncertaintyMs: 1 };
                  },
                },
                async qualifyInventory(facts) {
                  await hooks.custodyInventory?.(facts);
                },
                async qualifyInventoryRead(op) {
                  await hooks.custodyInventoryRead?.(op);
                },
                async qualifyMintUse(op, record, rows) {
                  await hooks.custodyMint?.(op, record, rows);
                },
                async qualifyRevocationUse(op, record) {
                  await hooks.custodyRevocation?.(op, record);
                },
              }
            : {}),
          async stageRelease(input) {
            events.push(["stage-release"]);
            assert.deepEqual(copy(input.repositoryTarget), target);
            await hooks.stageRelease?.(input);
          },
        };
      },
    },
    inspect(token, s) {
      assert.equal(token, v.token);
      assert.equal(s, selected);
      const answer = {
        accessLeaseRef: "lease/one",
        inventoryRecordRef: "inventory/one",
        inventoryVersion: 1,
        releaseRef: "release/one",
        repositoryTarget: target,
        receiver,
        session,
      };
      return hooks.token?.(answer) ?? answer;
    },
  };
  const sourceLeases = [];
  // A controlled construction observer forwards to the actual original binding
  // and returns each exact Work-created lease unchanged. It grants no authority.
  const observedBinding = options.inspectSource
    ? {
        participant: binding.participant,
        bindOriginalSources(work, custody) {
          const acquire = work.acquire.bind(work);
          return binding.bindOriginalSources(
            {
              async acquire(context, original, call) {
                hooks.sourceAcquire?.(context, original, call);
                const lease = await acquire(context, original, call);
                sourceLeases.push(lease);
                events.push(["source-acquired", original.operationRef]);
                return lease;
              },
            },
            custody,
          );
        },
      }
    : binding;
  const adapter = new RepositoryWorkStateAdapterV2(
    observedBinding,
    native,
    source,
    tokenBinding,
    options.transactionMilliseconds ?? 2000,
    {
      protocolVersion: version,
    },
  );
  const dispatch = () => ({
    version,
    sequence: 2,
    method: "dispatch-read",
    request_ref: open.request_ref,
    session_ref: "2".repeat(32),
    effect_ref: data.preparation.operationRef,
    request_sha256: open.request_sha256,
    dns_binding_ref: data.current.dnsBindingRef,
    upstream_ipv4: data.current.upstreamIpv4,
    work_binding_sha256: `sha256:${"3".repeat(64)}`,
    peer_certificate_sha256: `sha256:${"4".repeat(64)}`,
  });
  const prepare = () => adapter.state.prepare(v.origin, open, call());
  const release = async (p) => {
    const current = await adapter.state.readCurrent(p, v.origin, call());
    return adapter.state.commitDispatch(p, v.origin, v.token, dispatch(), current, call());
  };
  return {
    ...v,
    open,
    version,
    db,
    events,
    hooks,
    data,
    record,
    sqlScope,
    source,
    binding,
    adapter,
    prepare,
    release,
    call,
    dispatch,
    receiver,
    session,
    tokenBinding,
    policy,
    nativeSource: native,
    reservation,
    inventorySelection,
    selected,
    sourceLeases,
  };
}

const policyRead = (event) =>
  event[0] === "query" &&
  event[1].startsWith("SELECT v.canonical_document FROM occ.repository_work_policy_heads_v2");
test("Work completion acquires actual State policy after custody and all parents before a Work read", async () => {
  const f = fixture({ currentPolicy: true, inspectSource: true });
  f.hooks.custodyAcquire = async () => {
    assert.equal(f.events.some(policyRead), false);
    const lease = f.sourceLeases.at(-1);
    assert.equal(lease.assertCurrent(), undefined);
    await assert.rejects(lease.prepareCommit());
    await assert.rejects(lease.qualifyReadset({}));
  };
  const p = await f.prepare();
  assert.ok(p);
  const custody = f.events.findIndex((e) => e[0] === "custody-acquire");
  const policy = f.events.findIndex(policyRead);
  const parents = f.events.flatMap((e, i) =>
    e[0] === "query" && e[1].startsWith("SELECT id FROM occ.") ? [i] : [],
  );
  const work = f.events.findIndex(
    (e) => e[0] === "query" && e[1].includes("repository_work_heads_v2"),
  );
  assert.equal(parents.length, 3);
  assert.ok(custody >= 0 && custody < parents[0]);
  assert.ok(parents.every((i) => i < policy) && policy < work);
  assert.equal(f.events.filter(policyRead).length, 1);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});

test("each original admission and preparation completes its own policy phase", async () => {
  const f = fixture({ initial: true, currentPolicy: true, inspectSource: true });
  const p = await f.prepare();
  assert.ok(p);
  assert.equal(f.sourceLeases.length, 2);
  assert.notEqual(f.sourceLeases[0], f.sourceLeases[1]);
  assert.equal(f.events.filter(policyRead).length, 2);
  assert.deepEqual(
    f.events.filter((e) => e[0] === "audit").map((e) => e[1]),
    ["admission", "preparation"],
  );
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});

test("policy changed during custody wait is read later and refuses before a unit write", async () => {
  const f = fixture({ currentPolicy: true });
  f.hooks.custodyAcquire = async () => {
    f.policy.status = "disabled";
  };
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.events.filter(policyRead).length, 1);
  assert.equal(
    f.events.some((e) => e[0] === "audit" || e[0] === "ack"),
    false,
  );
});

test("abort in custody prevents policy acquisition and joins the entered source", async () => {
  const f = fixture({ currentPolicy: true, inspectSource: true });
  const gate = deferred(),
    entered = deferred(),
    controller = new AbortController();
  f.hooks.custodyAcquire = async () => {
    entered.resolve();
    await gate.promise;
  };
  const result = f.adapter.state.prepare(f.origin, f.open, {
    ...f.call(),
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  assert.equal(f.events.some(policyRead), false);
  assert.equal(
    f.events.some((e) => e[0] === "outer-closed"),
    false,
  );
  gate.resolve();
  assert.equal(await result, undefined);
  assert.equal(f.events.some(policyRead), false);
  assert.equal(f.events.filter((e) => e[0] === "custody-release").length, 1);
  assert.throws(() => f.sourceLeases[0].assertCurrent());
});

for (const cancellation of ["abort", "timeout"])
  test(`pending original policy read is joined through ${cancellation} before outer cleanup`, async () => {
    const f = fixture({
      currentPolicy: true,
      inspectSource: true,
      transactionMilliseconds: cancellation === "timeout" ? 30 : 2000,
    });
    const gate = deferred(),
      entered = deferred(),
      controller = new AbortController();
    f.hooks.query = async (sql) => {
      if (sql.startsWith("SELECT v.canonical_document FROM occ.repository_work_policy_heads_v2")) {
        entered.resolve();
        await gate.promise;
      }
    };
    const result = f.adapter.state.prepare(f.origin, f.open, {
      ...f.call(),
      signal: controller.signal,
    });
    await entered.promise;
    if (cancellation === "abort") controller.abort();
    else await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(
      f.events.some((e) => e[0] === "outer-closed" || e[0] === "ack"),
      false,
    );
    gate.resolve();
    assert.equal(await result, undefined);
    assert.equal(f.events.filter(policyRead).length, 1);
    assert.equal(
      f.events.some((e) => e[0] === "audit" || e[0] === "ack"),
      false,
    );
    assert.throws(() => f.sourceLeases[0].assertCurrent());
  });

test("late policy lease transfers release before its policy accessor is rejected", async () => {
  const f = fixture({ inspectSource: true });
  let getterCalls = 0;
  f.hooks.heldResult = (kind, lease) => {
    if (kind === "policy")
      Object.defineProperty(lease, "policy", {
        get() {
          getterCalls++;
          throw new Error("unselected policy getter");
        },
      });
    return lease;
  };
  assert.equal(await f.prepare(), undefined);
  assert.equal(getterCalls, 0);
  assert.equal(f.events.filter((e) => e[0] === "policy-release" && e[1] === "policy").length, 1);
  assert.equal(
    f.events.some((e) => e[0] === "audit" || e[0] === "ack"),
    false,
  );
});

test("a policy lease resolving after abort remains owned and released once", async () => {
  const f = fixture({ inspectSource: true });
  const gate = deferred(),
    entered = deferred(),
    controller = new AbortController();
  f.hooks.acquire = async (kind) => {
    if (kind === "policy") {
      entered.resolve();
      await gate.promise;
    }
  };
  const result = f.adapter.state.prepare(f.origin, f.open, {
    ...f.call(),
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  assert.equal(
    f.events.some((e) => e[0] === "outer-closed"),
    false,
  );
  gate.resolve();
  assert.equal(await result, undefined);
  assert.equal(f.events.filter((e) => e[0] === "policy-release" && e[1] === "policy").length, 1);
  assert.throws(() => f.sourceLeases[0].assertCurrent());
});

test("historical completion retains its own observer after current Work policy and native use close", async () => {
  const f = fixture({ currentPolicy: true });
  const p = await f.prepare(),
    r = await f.release(p);
  assert.equal(r.kind, "committed");
  const policyReads = f.events.filter(policyRead).length;
  f.policy.status = "disabled";
  f.hooks.nativeCurrent = () => {
    throw new Error("old live native use closed");
  };
  assert.equal(await f.adapter.state.settle(p, r.receipt, "unknown"), "recorded");
  assert.equal(f.events.filter(policyRead).length, policyReads);
  assert.equal(
    JSON.parse(f.db.operations.get(f.data.observation.operationRef)).document.outcome,
    "unknown",
  );
});

test("fresh committed use acquires and completes a new original policy source lease", async () => {
  const f = fixture({ currentPolicy: true, inspectSource: true });
  const p = await f.prepare(),
    r = await f.release(p);
  assert.equal(r.kind, "committed");
  const old = [...f.sourceLeases],
    reads = f.events.filter(policyRead).length;
  const held = await f.binding.participant.acquireCommittedRelease(
    r.receipt,
    f.call(),
    f.receiver,
    f.session,
  );
  assert.ok(held);
  const fresh = f.sourceLeases.at(-1);
  assert.equal(old.includes(fresh), false);
  assert.equal(f.sourceLeases.length, old.length + 1);
  assert.equal(f.events.filter(policyRead).length, reads + 1);
  held.assertCurrent();
  await held.release();
  assert.throws(() => fresh.assertCurrent());
  await f.adapter.state.settle(p, r.receipt, "completed");
});

test("reentrant prepareUse refuses without repeating original policy acquisition", async () => {
  const f = fixture({ inspectSource: true });
  f.hooks.acquire = async (kind) => {
    if (kind === "policy") assert.throws(() => f.sourceLeases.at(-1).prepareUse());
  };
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.events.filter((e) => e[0] === "held" && e[1] === "policy").length, 1);
  assert.equal(f.events.filter((e) => e[0] === "policy-release" && e[1] === "policy").length, 1);
  assert.equal(
    f.events.some((e) => e[0] === "ack"),
    false,
  );
});

// These regressions fault a declared synchronous peer with an actual entered
// Promise. The real Work adapter and State context must refuse and enroll it in
// the controlled outer owner's drain; a local source-release join is too late.
for (const site of [
  "native acquisition",
  "native pre-completion fence",
  "policy completion",
  "policy later fence",
])
  for (const outcome of ["fulfilled", "rejected"])
    test(
      "asynchronous " + site + " joins before transaction retirement (" + outcome + ")",
      async () => {
        const f = fixture({ inspectSource: true }),
          gate = deferred(),
          entered = deferred();
        let called = false,
          finished = false;
        const assertion = () => {
          if (called) return undefined;
          called = true;
          entered.resolve();
          return gate.promise.then(() => {
            finished = true;
            if (outcome === "rejected") throw new Error("Controlled assertion rejection.");
          });
        };
        if (site === "native acquisition")
          f.hooks.sourceAcquire = () => {
            f.hooks.nativeCurrent = assertion;
          };
        else if (site === "native pre-completion fence")
          f.hooks.custodyAcquire = async () => {
            f.hooks.nativeCurrent = assertion;
          };
        else {
          let ready = site === "policy completion";
          f.hooks.query = async (sql) => {
            if (sql.includes("repository_work_heads_v2")) ready = true;
          };
          f.hooks.current = (kind) => (kind === "policy" && ready ? assertion() : undefined);
        }
        const result = f.prepare();
        try {
          await entered.promise;
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(finished, false);
          assert.ok(f.events.some((e) => e[0] === "outer-join-accepted"));
          assert.equal(
            f.events.some((e) =>
              [
                "outer-closed",
                "policy-release",
                "custody-release",
                "selection-release",
                "ack",
              ].includes(e[0]),
            ),
            false,
            "the transaction and entered dependent leases survive refused currentness",
          );
          if (f.sourceLeases.length) assert.throws(() => f.sourceLeases.at(-1).assertCurrent());
        } finally {
          gate.resolve();
        }
        assert.equal(await result, undefined);
        assert.equal(finished, true);
        assert.equal(f.events.filter((e) => e[0] === "outer-closed").length, 1);
        assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
        assert.equal(
          f.events.some((e) => e[0] === "ack"),
          false,
        );
        assert.equal(f.db.operations.has(f.data.preparation.operationRef), false);
        for (const kind of ["custody-release", "policy-release"])
          assert.ok(f.events.filter((e) => e[0] === kind).length <= 1);
      },
    );

for (const responsibility of ["issue", "history"])
  test(
    "asynchronous " + responsibility + " assertion retains its original phase until settlement",
    async () => {
      const f = fixture({ inventory: responsibility === "issue" }),
        p = await f.prepare(),
        gate = deferred(),
        entered = deferred();
      assert.ok(p);
      let inventory;
      if (responsibility === "issue") {
        inventory = await f.adapter.inventory.acquire(p, f.origin, f.call());
        assert.ok(inventory);
      }
      const committed = responsibility === "history" ? await f.release(p) : undefined;
      if (committed) assert.equal(committed.kind, "committed");
      const start = f.events.length;
      let called = false;
      f.hooks.current = (kind) => {
        if (kind !== responsibility || called) return undefined;
        called = true;
        entered.resolve();
        return gate.promise;
      };
      const result =
        responsibility === "issue"
          ? f.adapter.inventory.transition(
              inventory,
              f.adapter.inventory.reservation(inventory),
              f.call(),
            )
          : f.adapter.state.settle(p, committed.receipt, "unknown");
      try {
        await entered.promise;
        await new Promise((resolve) => setImmediate(resolve));
        const pendingEvents = f.events.slice(start);
        assert.ok(pendingEvents.some((e) => e[0] === "outer-join-accepted"));
        assert.equal(
          pendingEvents.some((e) =>
            [
              "outer-closed",
              "policy-release",
              "custody-release",
              "selection-release",
              "ack",
            ].includes(e[0]),
          ),
          false,
        );
      } finally {
        gate.resolve();
      }
      const refused = await result;
      assert.equal(
        responsibility === "issue" ? refused.kind : refused,
        responsibility === "issue" ? "not-committed" : "unavailable",
      );
      const settledEvents = f.events.slice(start);
      assert.equal(settledEvents.filter((e) => e[0] === "outer-closed").length, 1);
      assert.equal(
        settledEvents.filter((e) => e[0] === "policy-release" && e[1] === responsibility).length,
        1,
      );
      assert.equal(
        settledEvents.some((e) => e[0] === "ack"),
        false,
      );
      if (inventory) {
        await f.adapter.state.settle(p, undefined, "not-dispatched");
        await f.adapter.inventory.release(inventory);
      }
    },
  );

test("existing admission is preserved and a distinct preparation is actually staged", async () => {
  const f = fixture(),
    p = await f.prepare();
  assert.ok(p);
  assert.equal(JSON.parse(f.db.operations.get("operation/admission")).commitRef, "initial/commit");
  const prepared = JSON.parse(f.db.operations.get("operation/preparation"));
  assert.equal(prepared.kind, "preparation");
  assert.equal(prepared.document.sessionRef, f.data.sessionRef);
  assert.deepEqual(
    f.events.filter((e) => e[0] === "audit").map((e) => e[1]),
    ["preparation"],
  );
  assert.equal(await f.adapter.state.settle(p, undefined, "not-dispatched"), "recorded");
});
test("initial Work admission and preparation use distinct acknowledged transactions", async () => {
  const f = fixture({ initial: true }),
    p = await f.prepare();
  assert.ok(p);
  assert.deepEqual(
    f.events.filter((e) => e[0] === "audit").map((e) => e[1]),
    ["admission", "preparation"],
  );
  assert.equal(f.events.filter((e) => e[0] === "ack").length, 2);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
for (const [field, change] of [
  [
    "horizon",
    (r) => {
      r.originalHorizon = new Date(Date.parse(r.originalHorizon) + 60000).toISOString();
    },
  ],
  [
    "Work",
    (r) => {
      r.workRef = "work/other";
      r.rootWorkRef = "work/other";
    },
  ],
  [
    "execution",
    (r) => {
      r.execution.assignmentRef = "assignment/other";
    },
  ],
  [
    "policy",
    (r) => {
      r.policy.profile.revision = "other";
    },
  ],
  [
    "scope",
    (r) => {
      r.scope.agentId = "agent/other";
    },
  ],
  [
    "revision",
    (r) => {
      r.revision = 2;
    },
  ],
  [
    "withdrawal",
    (r) => {
      r.withdrawalRevision = 1;
    },
  ],
  [
    "state",
    (r) => {
      r.state = "closed";
    },
  ],
  [
    "parent",
    (r) => {
      r.parentWorkRef = "work/parent";
    },
  ],
  [
    "root",
    (r) => {
      r.rootWorkRef = "work/other";
    },
  ],
])
  test(`initial admission rejects a changed ${field} before any transaction`, async () => {
    const f = fixture({ initial: true });
    change(f.data.admission.record.record);
    assert.equal(await f.prepare().catch(() => undefined), undefined);
    assert.equal(f.db.heads.size, 0);
    assert.equal(f.db.operations.size, 0);
    assert.equal(f.db.releases.size, 0);
    assert.equal(
      f.events.some((e) => ["query", "audit", "ack", "outer-closed"].includes(e[0])),
      false,
    );
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  });
test("copied preparation and receiver cannot recognize the actual State commit", async () => {
  const f = fixture(),
    p = await f.prepare();
  assert.ok(p);
  await assert.rejects(f.adapter.state.readCurrent({ ...p }, f.origin, f.call()));
  const r = await f.release(p);
  assert.equal(r.kind, "committed");
  assert.equal(f.adapter.state.inspectCommitted(r.receipt, p, f.token).releaseRef, "release/one");
  assert.throws(() =>
    f.binding.participant.recognizeCommittedRelease(
      { ...r.receipt },
      "release/one",
      f.receiver,
      f.session,
    ),
  );
  assert.throws(() =>
    f.binding.participant.recognizeCommittedRelease(
      r.receipt,
      "release/one",
      { ...f.receiver },
      f.session,
    ),
  );
  await f.adapter.state.settle(p, r.receipt, "unknown");
});
test("State fresh committed-use acquisition recognizes the retained Work operation outside transient ALS", async () => {
  const f = fixture(),
    p = await f.prepare(),
    r = await f.release(p);
  assert.equal(r.kind, "committed");
  const held = await f.binding.participant.acquireCommittedRelease(
    r.receipt,
    f.call(),
    f.receiver,
    f.session,
  );
  assert.ok(held);
  assert.equal(held.assertCurrent(), undefined);
  await held.release();
  assert.throws(() => held.assertCurrent());
  assert.equal(await f.adapter.state.settle(p, r.receipt, "unknown"), "recorded");
});
test("known dispatch and later outcome remain separate and recovery does not require an open Work", async () => {
  const f = fixture(),
    p = await f.prepare(),
    r = await f.release(p);
  assert.equal(r.kind, "committed");
  const old = f.db.operations.get(f.current.original.operationRef),
    closed = { ...f.record, state: "closed", revision: 2, withdrawalRevision: 1 };
  f.db.heads.set(closed.workRef, canonicalRepositoryWorkV2(closed));
  await assert.rejects(f.adapter.state.readCurrent(p, f.origin, f.call()));
  f.hooks.nativeCurrent = () => {
    throw new Error("controlled native closure");
  };
  const a = f.adapter.state.settle(p, r.receipt, "unknown"),
    b = f.adapter.state.settle(p, r.receipt, "unknown");
  assert.equal(a, b);
  assert.equal(await a, "recorded");
  assert.equal(f.db.operations.get(f.current.original.operationRef), old);
  assert.equal(JSON.parse(f.db.operations.get("operation/observation")).kind, "observation");
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  assert.ok(f.events.some((e) => e[0] === "held" && e[1] === "history"));
});
test("unknown dispatch cannot mint a Work release and remains distinct from noncommit", async () => {
  const f = fixture(),
    p = await f.prepare();
  f.hooks.commit = async (local) => {
    if (local.operations.has(f.current.original.operationRef))
      throw new Error("controlled lost outer acknowledgment");
  };
  const r = await f.release(p);
  assert.equal(r.kind, "unknown");
  assert.equal(f.events.filter((e) => e[0] === "stage-release").length, 1);
  assert.throws(() => f.adapter.state.inspectCommitted({}, p, f.token));
  delete f.hooks.commit;
  assert.equal(await f.adapter.state.settle(p, undefined, "unknown"), "unavailable");
});
test("a policy failure at final prepare refuses the transaction and joins original cleanup", async () => {
  const f = fixture();
  f.hooks.prepare = () => {
    throw new Error("controlled current policy change");
  };
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.db.operations.has("operation/preparation"), false);
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  assert.equal(f.events.filter((e) => e[0] === "policy-release").length, 1);
});
test("late policy acquisition is retained before currentness failure and released once", async () => {
  const f = fixture(),
    gate = deferred(),
    entered = deferred();
  f.hooks.acquire = async () => {
    entered.resolve();
    await gate.promise;
  };
  f.hooks.current = () => {
    throw new Error("controlled late currentness refusal");
  };
  let done = false;
  const pending = f.prepare().then((x) => {
    done = true;
    return x;
  });
  await entered.promise;
  assert.equal(done, false);
  gate.resolve();
  assert.equal(await pending, undefined);
  assert.equal(f.events.filter((e) => e[0] === "policy-release").length, 1);
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
});
test("each borrowed policy participant prepares once despite the source lease", async () => {
  const f = fixture(),
    p = await f.prepare();
  assert.ok(p);
  assert.equal(f.events.filter((e) => e[0] === "policy-prepare").length, 1);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("copied selection data with a reused phase operation refuses before any transaction", async () => {
  const f = fixture();
  f.data.preparation.operationRef = f.data.current.original.operationRef;
  assert.equal(await f.prepare().catch(() => undefined), undefined);
  assert.equal(
    f.events.some((e) => e[0] === "query"),
    false,
  );
});
test("the original readset rejects changed policy, ancestor or execution data", () => {
  const f = fixture(),
    rows = { scope: f.sqlScope, lineage: [f.record] };
  compareRepositoryWorkStateReadsetV2(rows, f.current);
  for (const mutate of [
    (x) => (x.lineage[0].policy.permission = "contents:write"),
    (x) => (x.lineage[0].parentWorkRef = "missing/parent"),
    (x) => (x.lineage[0].execution.receiverRef = "other"),
  ]) {
    const changed = copy(rows);
    mutate(changed);
    assert.throws(() => compareRepositoryWorkStateReadsetV2(changed, f.current));
  }
});

for (const field of ["repositoryTarget", "receiver"])
  test(`mismatching custody ${field} cannot stage a release`, async () => {
    const f = fixture(),
      p = await f.prepare();
    let getter = 0;
    f.hooks.token = (value) => {
      if (field === "repositoryTarget")
        return { ...value, repositoryTarget: { ...value.repositoryTarget, appId: "other" } };
      const changed = { ...value };
      Object.defineProperty(changed, "receiver", {
        get() {
          getter++;
          return value.receiver;
        },
        enumerable: true,
      });
      return changed;
    };
    await assert.rejects(f.release(p));
    assert.equal(getter, 0);
    assert.equal(
      f.events.some((e) => e[0] === "stage-release"),
      false,
    );
    await f.adapter.state.settle(p, undefined, "not-dispatched");
  });
test("beginning settlement closes new committed-use admission before historical cleanup awaits", async () => {
  const f = fixture(),
    p = await f.prepare(),
    r = await f.release(p),
    gate = deferred(),
    entered = deferred();
  f.hooks.acquire = async (kind) => {
    if (kind === "history") {
      entered.resolve();
      await gate.promise;
    }
  };
  const settlement = f.adapter.state.settle(p, r.receipt, "unknown");
  await entered.promise;
  assert.equal(
    await f.binding.participant.acquireCommittedRelease(r.receipt, f.call(), f.receiver, f.session),
    undefined,
  );
  gate.resolve();
  assert.equal(await settlement, "recorded");
});

test("the actual Work evaluator refuses a changed held policy even if its controlled fence returns normally", async () => {
  const f = fixture(),
    p = await f.prepare();
  assert.ok(p);
  f.policy.version = 2;
  await assert.rejects(f.adapter.state.readCurrent(p, f.origin, f.call()));
  assert.equal(f.db.operations.has(f.current.original.operationRef), false);
  assert.equal(await f.adapter.state.settle(p, undefined, "not-dispatched"), "recorded");
});

test("State stores the native diagnostic and preparation effect separately from the later broker nonce", async () => {
  const f = fixture(),
    p = await f.prepare();
  assert.ok(p);
  const original = await f.adapter.state.readPreparationOriginal(p, f.origin, f.call());
  assert.equal(original.operationRef, f.data.preparation.operationRef);
  await assert.rejects(f.adapter.state.readPreparationOriginal({ ...p }, f.origin, f.call()));
  for (const changed of [{ context: {} }, { recipientRef: "other" }, { requestRef: "other" }])
    await assert.rejects(
      f.adapter.state.readPreparationOriginal(p, f.origin, { ...f.call(), ...changed }),
    );
  const prepared = JSON.parse(f.db.operations.get(original.operationRef));
  assert.equal(prepared.document.sessionRef, `github-native/${"a".repeat(32)}`);
  assert.notEqual(prepared.document.sessionRef, f.dispatch().session_ref);
  const r = await f.release(p);
  assert.equal(r.kind, "committed");
  const dispatched = JSON.parse(f.db.operations.get(f.current.original.operationRef));
  assert.equal(dispatched.document.sessionRef, prepared.document.sessionRef);
  assert.equal(dispatched.document.preparationOperationRef, original.operationRef);
  assert.equal(
    f.binding.participant.recognizeCommittedRelease(r.receipt, "release/one", f.receiver, f.session)
      .operationRef,
    f.current.original.operationRef,
  );
  await f.adapter.state.settle(p, r.receipt, "completed");
});
for (const [name, change] of [
  ["native diagnostic in wire nonce", (d, f) => ({ ...d, session_ref: f.data.sessionRef })],
  [
    "dispatch original as wire effect",
    (d, f) => ({ ...d, effect_ref: f.current.original.operationRef }),
  ],
])
  test(`State adapter refuses ${name} before staging dispatch`, async () => {
    const f = fixture(),
      p = await f.prepare();
    const current = await f.adapter.state.readCurrent(p, f.origin, f.call());
    await assert.rejects(
      f.adapter.state.commitDispatch(
        p,
        f.origin,
        f.token,
        change(f.dispatch(), f),
        current,
        f.call(),
      ),
    );
    assert.equal(
      f.events.some((e) => e[0] === "stage-release"),
      false,
    );
    assert.equal(f.db.operations.has(f.current.original.operationRef), false);
    await f.adapter.state.settle(p, undefined, "not-dispatched");
  });
test("broker nonce cannot be supplied as the preexisting native session identity", async () => {
  const f = fixture();
  f.data.sessionRef = "2".repeat(32);
  await assert.rejects(f.prepare());
  assert.equal(
    f.events.some((e) => e[0] === "query"),
    false,
  );
});

for (const profile of ["metadata", "discovery", "upload-pack"])
  test(`actual broker, Work owner and State adapter preserve ${profile} request through committed use`, async (t) => {
    const request = profile === "metadata" ? metadataOpen : gitOpen(profile);
    const f = fixture({ request }),
      replies = [],
      writes = [];
    const limits = {
      maximumPreparations: 4,
      maximumOperationMilliseconds: 10000,
      maximumLeaseMilliseconds: 5000,
      clockAllowanceMilliseconds: 0,
    };
    const owner = new RepositoryWorkOperationOwnerV2(
      {
        native: f.nativeSource,
        state: f.adapter.state,
        custody: {
          async prepareToken(p, origin, call) {
            assert.equal(
              (await f.adapter.state.readPreparationOriginal(p, origin, call)).operationRef,
              f.data.preparation.operationRef,
            );
            return f.token;
          },
          async writeCommitted(commit, metadata, call) {
            const known = f.binding.participant.recognizeCommittedRelease(
              commit,
              "release/one",
              f.receiver,
              f.session,
            );
            assert.equal(known.operationRef, f.current.original.operationRef);
            assert.equal(known.dispatch.preparationOperationRef, f.data.preparation.operationRef);
            assert.equal(known.dispatch.sessionRef, f.data.sessionRef);
            const held = await f.binding.participant.acquireCommittedRelease(
              commit,
              call,
              f.receiver,
              f.session,
            );
            assert.ok(held);
            try {
              held.assertCurrent();
              // Controlled metadata-only custody peer. No credential or native write
              // is simulated as production success by this component test.
              writes.push(JSON.parse(Buffer.from(metadata).toString()));
              f.events.push(["custody-write"]);
            } finally {
              await held.release();
            }
          },
          async settleToken(token) {
            assert.equal(token, f.token);
            f.events.push(["token-release"]);
          },
        },
      },
      limits,
      { protocolVersion: f.version },
    );
    const observation = {
      configuration: { ...trust(), permittedRecipientRef: "receiver/one" },
      authenticatedAt: new Date(Date.now() - 100).toISOString(),
      expiresAt: new Date(Date.now() + 20000).toISOString(),
      peerEvidenceRef: "evidence/controlled",
      transportBinding: f.native.transportBinding,
    };
    const broker = new GitHubMediationService({
      operations: owner,
      protocolVersion: f.version,
      limits: { maximumSessions: 4, maximumCallMilliseconds: 2000, ...limits },
      transport: {
        async inspect(call) {
          assert.equal(call.context, f.context);
          return observation;
        },
        async writeMetadata(bytes) {
          const reply = JSON.parse(Buffer.from(bytes).toString());
          replies.push(reply);
          f.events.push(["wire", reply.phase ?? reply.code]);
        },
        async close() {
          f.events.push(["transport-close"]);
        },
      },
    });
    t.after(async () => {
      await broker.join();
      await owner.stop();
    });
    const send = (request) => broker.handle(Buffer.from(JSON.stringify(request)), f.call());
    await send(f.open);
    const opened = replies.at(-1);
    assert.equal(opened.phase, "opened");
    assert.equal(opened.effect_ref, f.data.preparation.operationRef);
    assert.notEqual(opened.effect_ref, f.current.original.operationRef);
    assert.match(opened.session_ref, /^[a-f0-9]{32}$/);
    assert.notEqual(opened.session_ref, f.data.sessionRef);
    const prepared = JSON.parse(f.db.operations.get(f.data.preparation.operationRef));
    assert.equal(prepared.document.sessionRef, `github-native/${"a".repeat(32)}`);
    const binding = {
      version: f.version,
      request_ref: f.open.request_ref,
      session_ref: opened.session_ref,
      effect_ref: opened.effect_ref,
      work_binding_sha256: opened.work_binding_sha256,
      request_sha256: f.open.request_sha256,
    };
    await send({
      ...binding,
      sequence: 2,
      method: "dispatch-read",
      dns_binding_ref: opened.dns_binding_ref,
      upstream_ipv4: opened.upstream_ipv4,
      peer_certificate_sha256: `sha256:${"3".repeat(64)}`,
    });
    assert.equal(writes.length, 1);
    const sent = writes[0];
    assert.equal(sent.phase, "dispatch-once");
    assert.equal(sent.effect_ref, opened.effect_ref);
    assert.equal(sent.session_ref, opened.session_ref);
    assert.equal(sent.release_ref, "release/one");
    await send({ ...binding, sequence: 3, method: "check-read", release_ref: sent.release_ref });
    assert.equal(replies.at(-1).phase, "current");
    await send({
      ...binding,
      sequence: 4,
      method: "complete-read",
      release_ref: sent.release_ref,
      outcome: "completed",
    });
    assert.deepEqual(
      replies.map((r) => r.phase),
      ["opened", "current", "recorded"],
    );
    const dispatch = JSON.parse(f.db.operations.get(f.current.original.operationRef));
    const outcome = JSON.parse(f.db.operations.get(f.data.observation.operationRef));
    assert.equal(dispatch.kind, "dispatch");
    if (f.version === 3) {
      assert.deepEqual(prepared.document.repositoryRequest, gitBinding(f.open));
      assert.deepEqual(dispatch.document.repositoryRequest, gitBinding(f.open));
    } else {
      assert.equal(Object.hasOwn(prepared.document, "repositoryRequest"), false);
      assert.equal(Object.hasOwn(dispatch.document, "repositoryRequest"), false);
    }
    assert.ok([...replies, ...writes].every((reply) => reply.version === f.version));
    assert.equal(outcome.kind, "observation");
    assert.equal(outcome.document.dispatchOperationRef, dispatch.operationRef);
    const index = (kind, value) =>
      f.events.findIndex((e) => e[0] === kind && (value === undefined || e[1] === value));
    const firstAck = index("ack"),
      dispatchAudit = index("audit", "dispatch"),
      write = index("custody-write");
    assert.ok(index("audit", "preparation") < firstAck && firstAck < index("wire", "opened"));
    assert.ok(dispatchAudit >= 0 && dispatchAudit < write);
    assert.ok(f.events.slice(dispatchAudit + 1, write).some((e) => e[0] === "ack"));
    await broker.join();
    assert.ok(index("wire", "recorded") < index("transport-close"));
    for (const kind of ["selection-release", "token-release", "native-release"])
      assert.equal(f.events.filter((e) => e[0] === kind).length, 1);
  });

async function inventoryFixture() {
  const f = fixture({ inventory: true });
  f.p = await f.prepare();
  assert.ok(f.p);
  f.i = await f.adapter.inventory.acquire(f.p, f.origin, f.call());
  assert.ok(f.i);
  f.reserve = () =>
    f.adapter.inventory.transition(f.i, f.adapter.inventory.reservation(f.i), f.call());
  f.phase = (method, record, more = {}, ref = method) => ({
    schemaVersion: 2,
    method,
    operationRef: `inventory/${ref}`,
    scope: copy(f.policy.scope),
    createdAt: new Date().toISOString(),
    target: copy(record.target),
    expectedInventoryVersion: record.inventoryVersion,
    ...more,
  });
  f.claim = (record) =>
    f.phase("claimRepositoryMint", record, {
      providerAttemptRef: "provider/one",
      custodyIdentity: {
        lease: copy(f.reservation.lease),
        key: {
          clientId: "client-one",
          bindingRef: f.reservation.bindingRef,
          immutableVersion: "key/version-1",
        },
        providerAttemptRef: "provider/one",
        tokenRef: "token/one",
        protectedRevocationRef: "revoke/one",
      },
    });
  f.done = async () => {
    await f.adapter.state.settle(f.p, undefined, "not-dispatched");
    await f.adapter.inventory.release(f.i);
  };
  return f;
}
test("inventory reserve/claim use actual State transitions and preserve exact original operation membership", async () => {
  const f = await inventoryFixture();
  const reserved = await f.reserve();
  assert.equal(reserved.kind, "committed");
  assert.equal(reserved.operation.record.state, "reserved");
  const claimed = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  assert.equal(claimed.kind, "committed");
  assert.ok(claimed.claim);
  assert.equal(claimed.operation.record.state, "mint-unknown");
  assert.equal(f.db.mintClaims.size, 1);
  const use = await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call());
  assert.ok(use);
  assert.equal(use.assertCurrent(), undefined);
  assert.equal(use.beginSubmittedUse(), undefined);
  assert.equal(
    use.assertCurrent(),
    undefined,
    "postsubmission check remains valid while original authority remains current",
  );
  assert.throws(() => use.beginSubmittedUse());
  await use.release();
  await assert.rejects(f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call()));
  assert.ok(f.events.some((e) => e[0] === "held" && e[1] === "issue"));
  await f.done();
  assert.equal(f.events.filter((e) => e[0] === "inventory-selection-release").length, 1);
});
test("inventory responsibility cannot be manufactured from copied P, origin, I or claim", async () => {
  const f = await inventoryFixture();
  await assert.rejects(f.adapter.inventory.acquire({}, f.origin, f.call()));
  await assert.rejects(f.adapter.inventory.acquire(f.p, {}, f.call()));
  assert.throws(() => f.adapter.inventory.reservation({}));
  await assert.rejects(f.adapter.inventory.acquireMint(f.i, {}, f.call()));
  await assert.rejects(f.adapter.inventory.recover(f.i, "arbitrary/operation"));
  await f.done();
});
for (const [label, change] of [
  ["permission widening", (r) => (r.requestedPermissions.contents = "write")],
  ["other Work", (r) => (r.lease.work.workRef = "work/other")],
  ["other execution", (r) => (r.lease.execution.assignmentRef = "assignment/other")],
  ["other repository", (r) => (r.lease.target.repositoryId = "999")],
  ["other profile", (r) => (r.permissionProfile.revision = "2")],
  [
    "extended horizon",
    (r) => (r.lease.notAfter = new Date(Date.parse(r.lease.notAfter) + 10000).toISOString()),
  ],
])
  test(`inventory original plan refuses ${label} before reserve`, async () => {
    const f = fixture({ inventory: true });
    const p = await f.prepare();
    change(f.reservation);
    assert.equal(await f.adapter.inventory.acquire(p, f.origin, f.call()), undefined);
    assert.equal(f.db.inventoryOperations.size, 0);
    assert.equal(f.events.filter((e) => e[0] === "inventory-selection-release").length, 1);
    await f.adapter.state.settle(p, undefined, "not-dispatched");
  });
test("token-issue denial blocks reserve despite matching repository-use policy", async () => {
  const f = await inventoryFixture();
  f.hooks.current = (kind) => {
    if (kind === "issue") throw new Error("controlled original issue denial");
  };
  assert.equal((await f.reserve()).kind, "not-committed");
  assert.equal(f.db.inventoryOperations.size, 0);
  await f.done();
});
test("retained phase refs cannot rebind evidence or replay a provider claim", async () => {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  await assert.rejects(f.reserve());
  const input = f.claim(reserved.operation.record);
  const claimed = await f.adapter.inventory.transition(f.i, input, f.call());
  assert.ok(claimed.claim);
  await assert.rejects(
    f.adapter.inventory.transition(
      f.i,
      { ...input, providerAttemptRef: "provider/other" },
      f.call(),
    ),
  );
  const read = await f.adapter.inventory.recover(f.i, input.operationRef);
  assert.equal(read.kind, "recorded");
  assert.equal(Object.hasOwn(read, "claim"), false);
  await assert.rejects(f.adapter.inventory.acquireMint(f.i, read.operation, f.call()));
  await f.done();
});
test("unknown claim COMMIT retains exact recovery but creates no mint authority", async () => {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  f.hooks.commit = (local) => {
    for (const k of Object.keys(f.db)) f.db[k] = local[k];
    throw new Error("controlled lost outer ACK");
  };
  const input = f.claim(reserved.operation.record),
    result = await f.adapter.inventory.transition(f.i, input, f.call());
  assert.equal(result.kind, "unknown");
  assert.equal(Object.hasOwn(result, "claim"), false);
  delete f.hooks.commit;
  const read = await f.adapter.inventory.recover(f.i, input.operationRef);
  assert.equal(read.kind, "recorded");
  await assert.rejects(f.adapter.inventory.acquireMint(f.i, read, f.call()));
  await f.done();
});
test("late mint evidence and same-table cleanup survive old Work/native closure", async () => {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  const claimed = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  await f.adapter.state.settle(f.p, undefined, "not-dispatched");
  const head = JSON.parse(f.db.heads.get(f.current.work.workRef));
  head.state = "closed";
  head.revision++;
  f.db.heads.set(head.workRef, canonicalRepositoryWorkV2(head));
  f.hooks.nativeCurrent = () => {
    throw new Error("old native permission closed");
  };
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 0);
  await assert.rejects(f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call()));
  const unknownInput = f.phase(
    "recordRepositoryMint",
    claimed.operation.record,
    {
      providerAttemptRef: "provider/one",
      evidenceRef: "evidence/unknown",
      outcome: "unknown",
      expiry: { kind: "expiry-unproven" },
    },
    "mint-unknown-result",
  );
  const unknown = await f.adapter.inventory.transition(f.i, unknownInput);
  assert.equal(unknown.kind, "committed");
  assert.equal(unknown.operation.record.state, "mint-unknown");
  const observed = await f.adapter.inventory.transition(
    f.i,
    f.phase("recordRepositoryMint", unknown.operation.record, {
      providerAttemptRef: "provider/one",
      evidenceRef: "evidence/accepted",
      outcome: "accepted",
      tokenRef: "token/one",
      protectedRevocationRef: "revoke/one",
      expiry: {
        kind: "provider-expiry",
        expiresAt: f.end,
        observedAt: new Date().toISOString(),
        evidenceRef: "evidence/expiry",
      },
      returnedPermissions: { metadata: "read" },
      scopeAccepted: true,
    }),
  );
  assert.equal(observed.kind, "committed");
  const retired = await f.adapter.inventory.transition(
    f.i,
    f.phase("retireRepositoryToken", observed.operation.record, {
      evidenceRef: "evidence/retired",
    }),
  );
  assert.equal(retired.kind, "committed");
  const cleanup = await f.adapter.inventory.transition(
    f.i,
    f.phase("claimRepositoryRevocation", retired.operation.record, {
      tokenRef: "token/one",
      protectedRevocationRef: "revoke/one",
      revocationOperationRef: "revocation/one",
      expectedRevocationVersion: 0,
      previousAttempt: { kind: "none" },
    }),
  );
  assert.equal(cleanup.kind, "committed");
  const c = cleanup.operation.record.revocation;
  const resolved = await f.adapter.inventory.transition(
    f.i,
    f.phase("recordRepositoryRevocation", cleanup.operation.record, {
      tokenRef: "token/one",
      protectedRevocationRef: "revoke/one",
      revocationOperationRef: "revocation/one",
      claimRef: c.claimRef,
      claimVersion: c.claimVersion,
      providerAttemptRef: c.providerAttemptRef,
      outcome: "confirmed",
      evidenceRef: "evidence/revoked",
      observedAt: new Date().toISOString(),
    }),
  );
  assert.equal(resolved.kind, "committed");
  assert.equal(resolved.operation.record.state, "resolved-without-token");
  assert.ok(f.events.some((e) => e[0] === "held" && e[1] === "inventory-history"));
  await f.adapter.inventory.release(f.i);
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  await assert.rejects(f.adapter.inventory.recover(f.i, f.reservation.operationRef));
});
test("inventory release joins submitted mint lease before destroying observer or selection", async () => {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  const claimed = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  const use = await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call());
  assert.ok(use);
  use.beginSubmittedUse();
  await f.adapter.state.settle(f.p, undefined, "not-dispatched");
  const closing = f.adapter.inventory.release(f.i);
  let ended = false;
  void closing.then(() => (ended = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  assert.equal(f.events.filter((e) => e[0] === "inventory-selection-release").length, 0);
  await use.release();
  await closing;
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  await f.adapter.inventory.release(f.i);
});
test("late inventory acquisition transfers cleanup despite Work settlement during await", async () => {
  const f = fixture({ inventory: true }),
    p = await f.prepare(),
    gate = deferred(),
    entered = deferred();
  f.hooks.openInventory = async () => {
    entered.resolve();
    await gate.promise;
  };
  const acquiring = f.adapter.inventory.acquire(p, f.origin, f.call());
  await entered.promise;
  await f.adapter.state.settle(p, undefined, "not-dispatched");
  gate.resolve();
  assert.equal(await acquiring, undefined);
  assert.equal(f.events.filter((e) => e[0] === "inventory-selection-release").length, 1);
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
});

for (const kind of ["policy", "issue"])
  test(`fresh mint-use refuses ${kind} withdrawal after claim acknowledgment`, async () => {
    const f = await inventoryFixture(),
      reserved = await f.reserve();
    const claimed = await f.adapter.inventory.transition(
      f.i,
      f.claim(reserved.operation.record),
      f.call(),
    );
    f.hooks.current = (k) => {
      if (k === kind) throw new Error("controlled original withdrawal");
    };
    assert.equal(await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call()), undefined);
    delete f.hooks.current;
    await f.done();
  });
test("fresh mint-use refuses changed inventory instead of treating known claim as current permission", async () => {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  const claimed = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  const old = f.db.records.get(reserved.operation.record.target.recordRef);
  f.db.records.set(old.target.recordRef, { ...old, inventoryVersion: old.inventoryVersion + 1 });
  assert.equal(await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call()), undefined);
  await f.done();
});
test("missing selected inventory source refuses without a new State entry", async () => {
  const f = fixture(),
    p = await f.prepare(),
    before = f.events.length;
  assert.equal(await f.adapter.inventory.acquire(p, f.origin, f.call()), undefined);
  assert.equal(f.events.length, before);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("inventory cleanup is captured before a later source getter fails", async () => {
  const f = fixture({ inventory: true }),
    p = await f.prepare();
  f.hooks.inventorySelection = (source) => ({
    release: source.release,
    get reservation() {
      throw new Error("controlled getter loss");
    },
  });
  assert.equal(await f.adapter.inventory.acquire(p, f.origin, f.call()), undefined);
  assert.equal(f.events.filter((e) => e[0] === "inventory-selection-release").length, 1);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("inventory source acquisition refuses and joins an unexpected asynchronous native assertion", async () => {
  const f = fixture({ inventory: true }),
    p = await f.prepare(),
    gate = deferred();
  f.hooks.nativeCurrent = () => gate.promise;
  const opening = f.adapter.inventory.acquire(p, f.origin, f.call());
  let returned = false;
  void opening.then(() => (returned = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  gate.resolve();
  assert.equal(await opening, undefined);
  delete f.hooks.nativeCurrent;
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});

for (const missing of [undefined, null]) {
  for (const phase of ["reserve", "claim", "mint-use"])
    test(`missing ${String(missing)} original issue lease refuses ${phase}`, async () => {
      const f = await inventoryFixture();
      let reserved, claimed;
      if (phase !== "reserve") reserved = await f.reserve();
      if (phase === "mint-use")
        claimed = await f.adapter.inventory.transition(
          f.i,
          f.claim(reserved.operation.record),
          f.call(),
        );
      const before = f.db.inventoryOperations.size;
      f.hooks.issueResult = () => missing;
      if (phase === "reserve") assert.equal((await f.reserve()).kind, "not-committed");
      else if (phase === "claim")
        assert.equal(
          (await f.adapter.inventory.transition(f.i, f.claim(reserved.operation.record), f.call()))
            .kind,
          "not-committed",
        );
      else
        assert.equal(
          await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call()),
          undefined,
        );
      assert.equal(f.db.inventoryOperations.size, before);
      await f.done();
    });
}

for (const throws of [false, true])
  test(`inventory source cleanup finishes before concurrent Work selection release (throws=${throws})`, async () => {
    const f = await inventoryFixture(),
      entered = deferred(),
      gate = deferred();
    f.hooks.inventoryRelease = async () => {
      entered.resolve();
      await gate.promise;
      if (throws) throw new Error("controlled cleanup failure");
    };
    const release = f.adapter.inventory.release(f.i);
    const outcome = release.then(
      () => "ok",
      () => "failed",
    );
    await entered.promise;
    await f.adapter.state.settle(f.p, undefined, "not-dispatched");
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 0);
    gate.resolve();
    assert.equal(await outcome, throws ? "failed" : "ok");
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  });
for (const throws of [false, true])
  test(`refused inventory acquisition joins source cleanup before selection release (throws=${throws})`, async () => {
    const f = fixture({ inventory: true }),
      p = await f.prepare(),
      entered = deferred(),
      gate = deferred();
    f.hooks.inventorySelection = (source) => ({
      release: source.release,
      get reservation() {
        throw new Error("controlled acquisition refusal");
      },
    });
    f.hooks.inventoryRelease = async () => {
      entered.resolve();
      await gate.promise;
      if (throws) throw new Error("controlled cleanup failure");
    };
    const opening = f.adapter.inventory.acquire(p, f.origin, f.call());
    const outcome = opening.then(
      (v) => (v === undefined ? "refused" : "accepted"),
      () => "failed",
    );
    await entered.promise;
    await f.adapter.state.settle(p, undefined, "not-dispatched");
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 0);
    gate.resolve();
    assert.equal(await outcome, throws ? "failed" : "refused");
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
  });

async function cleanupFixture() {
  const f = await inventoryFixture(),
    reserved = await f.reserve();
  const minted = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  const accepted = await f.adapter.inventory.transition(
    f.i,
    f.phase("recordRepositoryMint", minted.operation.record, {
      providerAttemptRef: "provider/one",
      evidenceRef: "evidence/accepted",
      outcome: "accepted",
      tokenRef: "token/one",
      protectedRevocationRef: "revoke/one",
      expiry: {
        kind: "provider-expiry",
        expiresAt: f.end,
        observedAt: new Date().toISOString(),
        evidenceRef: "evidence/expiry",
      },
      returnedPermissions: { metadata: "read" },
      scopeAccepted: true,
    }),
  );
  assert.equal(accepted.kind, "committed");
  const retired = await f.adapter.inventory.transition(
    f.i,
    f.phase("retireRepositoryToken", accepted.operation.record, {
      evidenceRef: "evidence/retired",
    }),
  );
  const input = f.phase("claimRepositoryRevocation", retired.operation.record, {
    tokenRef: "token/one",
    protectedRevocationRef: "revoke/one",
    revocationOperationRef: "revocation/one",
    expectedRevocationVersion: 0,
    previousAttempt: { kind: "none" },
  });
  f.cleanup = await f.adapter.inventory.transition(f.i, input);
  assert.ok(f.cleanup.cleanupClaim);
  f.minted = minted;
  f.cleanupInput = input;
  return f;
}
test("known cleanup claim acquires actual State use with original observer call after Work/native closure", async () => {
  const f = await cleanupFixture();
  await f.adapter.state.settle(f.p, undefined, "not-dispatched");
  f.hooks.nativeCurrent = () => {
    throw new Error("old native closed");
  };
  const head = JSON.parse(f.db.heads.get(f.current.work.workRef));
  head.state = "closed";
  f.db.heads.set(head.workRef, canonicalRepositoryWorkV2(head));
  const lease = await f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim);
  assert.ok(lease);
  assert.equal(
    lease.call,
    f.hooks.lastInventoryCall,
    "same original observer call, no new deadline/signal",
  );
  assert.equal(lease.operation.input.method, "claimRepositoryRevocation");
  assert.equal(
    lease.operation.record.revocation.providerAttemptRef,
    f.cleanup.operation.record.revocation.providerAttemptRef,
  );
  lease.assertCurrent();
  lease.beginSubmittedUse();
  lease.assertCurrent();
  const pending = f.adapter.inventory.release(f.i);
  let closed = false;
  void pending.then(() => (closed = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 0);
  await lease.release();
  await pending;
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
});
test("cleanup admission rejects copied, recovered, mint-family and already consumed claim handles", async () => {
  const f = await cleanupFixture();
  await assert.rejects(f.adapter.inventory.acquireRevocation(f.i, {}));
  await assert.rejects(f.adapter.inventory.acquireRevocation(f.i, f.minted.claim));
  const read = await f.adapter.inventory.recover(f.i, f.cleanupInput.operationRef);
  assert.equal(read.kind, "recorded");
  await assert.rejects(f.adapter.inventory.acquireRevocation(f.i, read.operation));
  const lease = await f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim);
  assert.ok(lease);
  lease.beginSubmittedUse();
  assert.throws(() => lease.beginSubmittedUse());
  await lease.release();
  await assert.rejects(f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim));
  await f.done();
});
test("fresh cleanup use refuses changed claim version instead of rebasing the provider attempt", async () => {
  const f = await cleanupFixture(),
    record = f.cleanup.operation.record;
  f.db.records.set(record.target.recordRef, {
    ...record,
    revocation: { ...record.revocation, claimVersion: record.revocation.claimVersion + 1 },
  });
  assert.equal(await f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim), undefined);
  await f.done();
});
test("fresh cleanup use requires the independent observer lease and custody qualifier", async () => {
  const f = await cleanupFixture();
  f.hooks.custodyRevocation = () => {
    throw new Error("controlled protected cleanup refusal");
  };
  assert.equal(await f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim), undefined);
  await f.done();
});
test("cleanup refuses a changed original observer call before fixed provider submission", async () => {
  const f = await cleanupFixture(),
    lease = await f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim);
  assert.ok(lease);
  lease.call.requestRef = "changed/observer-request";
  assert.throws(() => lease.beginSubmittedUse());
  await lease.release();
  await f.done();
});
test("late cleanup-use acquisition is joined when inventory release wins before return", async () => {
  const f = await cleanupFixture(),
    entered = deferred(),
    gate = deferred();
  f.hooks.acquire = async (kind) => {
    if (kind === "inventory-history") {
      entered.resolve();
      await gate.promise;
    }
  };
  const acquisition = f.adapter.inventory.acquireRevocation(f.i, f.cleanup.cleanupClaim);
  const result = acquisition.then(
    (v) => v,
    () => undefined,
  );
  await entered.promise;
  const closing = f.adapter.inventory.release(f.i);
  let done = false;
  void closing.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  gate.resolve();
  assert.equal(await result, undefined);
  await closing;
  await f.adapter.state.settle(f.p, undefined, "not-dispatched");
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
});

for (const initial of [false, true])
  test(`original selection objects survive preparation, fresh dispatch and late observation (initial=${initial})`, async () => {
    const f = fixture({ initial });
    const p = await f.prepare();
    assert.ok(p);
    const committed = await f.release(p);
    assert.equal(committed.kind, "committed");
    const use = await f.binding.participant.acquireCommittedRelease(
      committed.receipt,
      f.call(),
      f.receiver,
      f.session,
    );
    assert.ok(use);
    use.assertCurrent();
    await use.release();
    assert.equal(await f.adapter.state.settle(p, committed.receipt, "completed"), "recorded");
    const held = f.events.filter((e) => e[0] === "held");
    assert.ok(held.some((e) => e[1] === "policy" && e[2] === "operation/preparation"));
    assert.ok(held.some((e) => e[1] === "history" && e[2] === "operation/observation"));
    if (initial) assert.ok(held.some((e) => e[2] === "operation/admission"));
  });
test("copied operation projection cannot replace original selection enrollment", async () => {
  const f = fixture();
  f.hooks.inspect = (data) => copy(data);
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.db.operations.has("operation/preparation"), false);
  assert.ok(f.events.some((e) => e[0] === "selection-release"));
});
test("a later copied selection cannot rebind the original phase identities", async () => {
  const f = fixture();
  const p = await f.prepare();
  assert.ok(p);
  f.hooks.inspect = (data) => copy(data);
  await assert.rejects(f.adapter.state.readCurrent(p, f.origin, f.call()));
  assert.equal(f.db.operations.has(f.data.current.original.operationRef), false);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("mutation of an original during policy currentness refuses detached comparison drift", async () => {
  const f = fixture();
  f.hooks.current = (kind) => {
    if (kind === "policy") f.data.preparation.invocationRef = "invocation/changed";
  };
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.db.operations.has("operation/preparation"), false);
  assert.ok(f.events.some((e) => e[0] === "policy-release"));
});

test("V3 inventory requests exactly contents and metadata under separate issue authority", async () => {
  const f = fixture({ inventory: true, request: gitOpen() }),
    p = await f.prepare();
  assert.ok(p);
  const i = await f.adapter.inventory.acquire(p, f.origin, f.call());
  assert.ok(i);
  assert.deepEqual(f.adapter.inventory.reservation(i).requestedPermissions, {
    contents: "read",
    metadata: "read",
  });
  const result = await f.adapter.inventory.transition(
    i,
    f.adapter.inventory.reservation(i),
    f.call(),
  );
  assert.equal(result.kind, "committed");
  assert.ok(f.events.some((e) => e[0] === "held" && e[1] === "issue"));
  await f.adapter.state.settle(p, undefined, "not-dispatched");
  await f.adapter.inventory.release(i);
});
test("metadata under Git-capable policy does not gain contents permission", async () => {
  const f = fixture({ inventory: true, policyOperations: ["metadata:read", "git:read"] }),
    p = await f.prepare();
  assert.ok(p);
  const i = await f.adapter.inventory.acquire(p, f.origin, f.call());
  assert.ok(i);
  assert.deepEqual(f.adapter.inventory.reservation(i).requestedPermissions, { metadata: "read" });
  await f.adapter.state.settle(p, undefined, "not-dispatched");
  await f.adapter.inventory.release(i);
});
for (const [name, change] of [
  ["missing contents", (r) => delete r.requestedPermissions.contents],
  ["missing metadata", (r) => delete r.requestedPermissions.metadata],
  ["extra provider permission", (r) => (r.requestedPermissions.issues = "read")],
  ["write permission", (r) => (r.requestedPermissions.contents = "write")],
])
  test(`V3 inventory refuses ${name}`, async () => {
    const f = fixture({ inventory: true, request: gitOpen() }),
      p = await f.prepare();
    assert.ok(p);
    change(f.reservation);
    assert.equal(await f.adapter.inventory.acquire(p, f.origin, f.call()), undefined);
    assert.equal(f.db.inventoryOperations.size, 0);
    await f.adapter.state.settle(p, undefined, "not-dispatched");
  });
test("V3 adapter refuses metadata-only policy before preparation COMMIT", async () => {
  const f = fixture({ request: gitOpen(), policyOperations: ["metadata:read"] });
  assert.equal(await f.prepare(), undefined);
  assert.equal(f.db.operations.has(f.data.preparation.operationRef), false);
});
for (const version of [2, 3])
  test(`adapter ${version} refuses crossed incoming protocol before selection`, async () => {
    const f = fixture({ version, request: version === 2 ? gitOpen() : metadataOpen });
    let acquisitions = 0;
    f.hooks.selectionAcquire = () => {
      acquisitions++;
    };
    await assert.rejects(f.prepare());
    assert.equal(acquisitions, 0);
    assert.equal(
      f.events.some((e) => e[0] === "query"),
      false,
    );
  });
test("V3 changed request projection after preparation cannot be staged as dispatch", async () => {
  const f = fixture({ request: gitOpen() }),
    p = await f.prepare();
  assert.ok(p);
  f.current.repositoryRequest.bodySha256 = `sha256:${"7".repeat(64)}`;
  await assert.rejects(f.release(p));
  assert.equal(f.db.operations.has(f.current.original.operationRef), false);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});

// Real Work + real State phase/readset/policy parsing with controlled original
// assignment/native/SQL peers. No production admission or provider is implied.
for (const version of [2, 3])
  test(`adapter ${version} retires initial readset and reenters actual same-unit policy/readset`, async () => {
    const f = fixture({
      version,
      ...(version === 3 ? { request: gitOpen() } : {}),
      currentPolicy: true,
      strictTransfer: true,
      inspectSource: true,
    });
    const originalRetirement = f.source.prepareStateUse;
    f.source.prepareStateUse = () => {
      throw new Error("replacement retirement");
    };
    f.nativeSource.assertNativeCurrent = () => {
      throw new Error("replacement native fence");
    };
    const p = await f.prepare(),
      r = await f.release(p);
    assert.ok(p);
    assert.equal(r.kind, "committed");
    assert.equal(f.events.filter((e) => e[0] === "native-inspect").length, 1);
    const firstEntry = f.events.findIndex((e) => e[0] === "outer-enter");
    assert.ok(f.events.findIndex((e) => e[0] === "readset-retired") < firstEntry);
    const prior = f.sourceLeases.length;
    const held = await f.binding.participant.acquireCommittedRelease(
      r.receipt,
      f.call(),
      f.receiver,
      f.session,
    );
    assert.ok(held);
    held.assertCurrent();
    assert.equal(f.sourceLeases.length, prior + 1);
    await held.release();
    assert.throws(() => f.sourceLeases.at(-1).assertCurrent());
    const handoffs = f.events.filter((e) => e[0] === "handoff-enter").length;
    f.hooks.nativeCurrent = () => {
      throw new Error("closed live origin");
    };
    assert.equal(await f.adapter.state.settle(p, r.receipt, "completed"), "recorded");
    assert.equal(f.events.filter((e) => e[0] === "handoff-enter").length, handoffs);
    assert.equal(typeof originalRetirement, "function");
  });

for (const result of ["resolve", "reject"])
  test(`readset retirement ${result} after cancellation joins before any State entry`, async () => {
    const f = fixture({ strictTransfer: true }),
      gate = deferred(),
      entered = deferred(),
      abort = new AbortController();
    f.hooks.handoff = async () => {
      entered.resolve();
      await gate.promise;
      if (result === "reject") throw new Error("controlled retirement failure");
    };
    let settled = false;
    const pending = f.adapter.state.prepare(f.origin, f.open, {
      ...f.call(),
      signal: abort.signal,
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await entered.promise;
    abort.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(
      f.events.some((e) => e[0] === "outer-enter" || e[0] === "selection-release"),
      false,
    );
    gate.resolve();
    await assert.rejects(pending);
    assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
    assert.equal(
      f.events.some((e) => e[0] === "outer-enter" || e[0] === "ack"),
      false,
    );
  });

for (const missing of ["inspectNative", "assertNativeCurrent", "prepareStateUse"])
  test(`adapter refuses missing original ${missing} instead of falling back`, () => {
    const f = fixture();
    const native = { ...f.nativeSource },
      selection = { ...f.source };
    if (missing === "inspectNative") native.inspectNative = undefined;
    else if (missing === "assertNativeCurrent") native.assertNativeCurrent = undefined;
    else selection.prepareStateUse = undefined;
    assert.throws(
      () => new RepositoryWorkStateAdapterV2(f.binding, native, selection, f.tokenBinding, 2000),
    );
  });

// Real adapter/State phases with controlled native/assignment/SQL peers; no live proof.
for (const version of [2, 3])
  test("adapter " + version + " enrolls direct entries and fresh committed use", async () => {
    const f = fixture({ version, ...(version === 3 ? { request: gitOpen() } : {}) });
    let enrolled;
    f.hooks.enroll = (c) => {
      enrolled = c.deadline;
    };
    f.hooks.nativeOnly = (c) => assert.equal(c.deadline, enrolled);
    f.nativeSource.inspectNative = () => {
      throw new Error("replacement");
    };
    const p = await f.prepare();
    assert.ok(p);
    const fresh = (offset) => ({
      ...f.call(),
      deadline: new Date(Date.now() + offset).toISOString(),
    });
    const current = await f.adapter.state.readCurrent(p, f.origin, fresh(7500));
    const r = await f.adapter.state.commitDispatch(
      p,
      f.origin,
      f.token,
      f.dispatch(),
      current,
      fresh(7100),
    );
    assert.equal(r.kind, "committed");
    const use = await f.binding.participant.acquireCommittedRelease(
      r.receipt,
      fresh(6800),
      f.receiver,
      f.session,
    );
    assert.ok(use);
    use.assertCurrent();
    await use.release();
    const count = f.events.filter((e) => e[0] === "native-enroll").length;
    f.hooks.enroll = () => {
      throw new Error("history must not enroll live RPC");
    };
    assert.equal(await f.adapter.state.settle(p, r.receipt, "completed"), "recorded");
    assert.equal(f.events.filter((e) => e[0] === "native-enroll").length, count);
    assert.equal(f.events.filter((e) => e[0] === "native-inspect").length, 1);
  });
for (const outcome of ["resolve", "reject"])
  test(
    "adapter settlement joins late native " + outcome + " before selection release",
    async () => {
      const f = fixture(),
        p = await f.prepare(),
        gate = deferred(),
        entered = deferred();
      assert.ok(p);
      f.hooks.enroll = async () => {
        entered.resolve();
        await gate.promise;
        if (outcome === "reject") throw new Error("late original refusal");
      };
      const reading = f.adapter.state.readCurrent(p, f.origin, f.call());
      const refused = assert.rejects(reading);
      await entered.promise;
      let settled = false;
      const closing = f.adapter.state.settle(p, undefined, "not-dispatched").then((r) => {
        settled = true;
        return r;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(
        f.events.some((e) => e[0] === "selection-release"),
        false,
      );
      gate.resolve();
      await refused;
      assert.equal(await closing, "recorded");
      assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
    },
  );
test("adapter refuses original call mutation during enrollment before State entry", async () => {
  const f = fixture(),
    p = await f.prepare(),
    c = f.call();
  const entered = f.events.filter((e) => e[0] === "outer-enter").length;
  f.hooks.enroll = (original) => {
    assert.equal(original, c);
    original.deadline = new Date(Date.now() + 9000).toISOString();
  };
  await assert.rejects(f.adapter.state.readCurrent(p, f.origin, c));
  assert.equal(f.events.filter((e) => e[0] === "outer-enter").length, entered);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("adapter refuses changed native transport before token or State entry", async () => {
  const f = fixture(),
    p = await f.prepare();
  const current = await f.adapter.state.readCurrent(p, f.origin, f.call());
  f.hooks.enroll = () => ({ ...f.native, transportBinding: {} });
  const entered = f.events.filter((e) => e[0] === "outer-enter").length;
  await assert.rejects(
    f.adapter.state.commitDispatch(p, f.origin, f.token, f.dispatch(), current, f.call()),
  );
  assert.equal(f.events.filter((e) => e[0] === "outer-enter").length, entered);
  assert.equal(f.db.operations.has(current.original.operationRef), false);
  await f.adapter.state.settle(p, undefined, "not-dispatched");
});
test("inventory reservation, mint claim and fresh use enroll before live fences", async () => {
  const f = await inventoryFixture();
  let enrolled;
  f.hooks.enroll = (c) => {
    enrolled = c.deadline;
  };
  f.hooks.nativeOnly = (c) => assert.equal(c.deadline, enrolled);
  const reserved = await f.reserve();
  assert.equal(reserved.kind, "committed");
  const claimed = await f.adapter.inventory.transition(
    f.i,
    f.claim(reserved.operation.record),
    f.call(),
  );
  assert.equal(claimed.kind, "committed");
  const use = await f.adapter.inventory.acquireMint(f.i, claimed.claim, f.call());
  assert.ok(use);
  use.assertCurrent();
  await use.release();
  f.hooks.enroll = () => {
    throw new Error("no live enrollment during observer cleanup");
  };
  await f.done();
});
test("inventory opening retains late native enrollment through original release", async () => {
  const f = fixture({ inventory: true }),
    p = await f.prepare();
  const entered = deferred(),
    gate = deferred();
  f.hooks.enroll = async () => {
    entered.resolve();
    await gate.promise;
  };
  let ended = false;
  const opening = f.adapter.inventory.acquire(p, f.origin, f.call()).then((v) => {
    ended = true;
    return v;
  });
  await entered.promise;
  const closing = f.adapter.state.settle(p, undefined, "not-dispatched");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  assert.equal(
    f.events.some((e) => e[0] === "selection-release"),
    false,
  );
  gate.resolve();
  assert.equal(await opening, undefined);
  await closing;
  assert.equal(f.events.filter((e) => e[0] === "selection-release").length, 1);
});
