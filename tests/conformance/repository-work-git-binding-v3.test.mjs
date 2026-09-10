// The protocol fixture below is copied from the original owned Work test f506d63a.
// It delegates to the genuine State owner/codecs with a controlled SQL peer;
// no native Work/key/physical body authority or real PostgreSQL is claimed.
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

function gitDeclaration() {
  return {
    version: 3,
    operation: "git:read",
    gitOperation: "discovery",
    gitProtocol: "version=2",
    bodyBytes: 0,
    bodySha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    requestDigest: original().requestDigest,
  };
}
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
    policy: hooks.git
      ? { repositoryOperation: "git:read", requiredPermissions: ["contents:read", "metadata:read"] }
      : {},
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
    ...(hooks.git ? { repositoryRequest: gitDeclaration() } : {}),
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
    operations,
    prepared,
    setPolicy(policy) {
      head = { ...head, policy };
    },
    changeRecordedRequest(request) {
      const prior = operations.get("operation");
      operations.set("operation", {
        ...prior,
        document: { ...prior.document, repositoryRequest: request },
      });
    },
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

test("V2 keeps its original preparation/dispatch shape without a Git declaration", async () => {
  const fixture = releaseProtocol();
  const result = await fixture.commit();
  assert.equal(result.kind, "committed");
  const stored = fixture.operations.get("operation");
  assert.equal(Object.hasOwn(stored.document, "repositoryRequest"), false);
});

test("V3 declaration survives original preparation, dispatch and private fresh known use", async () => {
  const fixture = releaseProtocol({ git: true });
  const prepared = await fixture.run(
    async (unit) => {
      await unit.readForMutation(fixture.work, fixture.execution);
      await unit.stagePreparation(fixture.prepared);
    },
    new AbortController(),
    { ...original(), operationRef: "new-preparation" },
  );
  assert.equal(prepared.kind, "committed");
  assert.deepEqual(
    fixture.operations.get("new-preparation").document.repositoryRequest,
    gitDeclaration(),
  );
  fixture.dispatch.preparationOperationRef = "new-preparation";
  const result = await fixture.commit();
  assert.equal(result.kind, "committed");
  const receipt = fixture.binding.participant.recognizeCommittedRelease(
    result.commit,
    "release",
    fixture.receiver,
    fixture.session,
  );
  assert.equal(
    canonicalRepositoryWorkV2(receipt.dispatch.repositoryRequest),
    canonicalRepositoryWorkV2(gitDeclaration()),
  );
  const lease = await fixture.binding.participant.acquireCommittedRelease(
    result.commit,
    fixture.call(),
    fixture.receiver,
    fixture.session,
  );
  assert.ok(lease);
  try {
    lease.assertCurrent();
    assert.equal(
      canonicalRepositoryWorkV2(lease.committed.dispatch.repositoryRequest),
      canonicalRepositoryWorkV2(gitDeclaration()),
    );
  } finally {
    await lease.release();
  }
});

test("held Git policy requires the exact declaration at first preparation", async () => {
  const fixture = releaseProtocol({ git: true });
  const { repositoryRequest: _request, ...missing } = fixture.prepared;
  const result = await fixture.run(
    async (unit) => {
      await unit.readForMutation(fixture.work, fixture.execution);
      await unit.stagePreparation(missing);
    },
    new AbortController(),
    { ...original(), operationRef: "missing-preparation" },
  );
  assert.equal(result.kind, "not-committed");
  assert.equal(fixture.operations.has("missing-preparation"), false);
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

test("held metadata policy cannot be expanded by adding a Git declaration", async () => {
  const fixture = releaseProtocol();
  fixture.dispatch.repositoryRequest = gitDeclaration();
  assert.equal((await fixture.commit()).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

const malformed = [
  ["version", { version: 2 }],
  ["operation", { operation: "metadata:read" }],
  ["protocol", { gitProtocol: "version=1" }],
  ["Git operation", { gitOperation: "receive-pack" }],
  ["nonempty discovery", { bodyBytes: 1 }],
  ["different empty digest", { bodySha256: `sha256:${"a".repeat(64)}` }],
  ["empty upload-pack", { gitOperation: "upload-pack" }],
  ["oversized body", { gitOperation: "upload-pack", bodyBytes: 4194305 }],
  ["fractional body", { gitOperation: "upload-pack", bodyBytes: 1.5 }],
  ["unprefixed body digest", { bodySha256: "a".repeat(64) }],
  ["different semantic request", { requestDigest: `sha256:${"2".repeat(64)}` }],
  ["unknown field", { callerApproved: true }],
];
for (const [label, delta] of malformed) {
  test(`V3 ${label} refuses before any release or COMMIT`, async () => {
    const fixture = releaseProtocol({ git: true });
    fixture.dispatch.repositoryRequest = { ...gitDeclaration(), ...delta };
    assert.equal((await fixture.commit()).kind, "not-committed");
    assert.equal(
      fixture.queries.some((q) => q.startsWith("INSERT INTO occ.repository_work_releases_v2")),
      false,
    );
    assert.equal(fixture.queries.includes("COMMIT"), false);
  });
}

test("V3 declaration accessors are never evaluated", async () => {
  const fixture = releaseProtocol({ git: true });
  let reads = 0;
  fixture.dispatch.repositoryRequest = {
    ...gitDeclaration(),
    get bodyBytes() {
      reads++;
      return 0;
    },
  };
  assert.equal((await fixture.commit()).kind, "not-committed");
  assert.equal(reads, 0);
});

test("omitting a stored Git declaration at dispatch cannot convert it to metadata", async () => {
  const fixture = releaseProtocol({ git: true });
  delete fixture.dispatch.repositoryRequest;
  assert.equal((await fixture.commit()).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

test("a changed valid Git declaration cannot differ from its immutable preparation", async () => {
  const fixture = releaseProtocol({ git: true });
  fixture.dispatch.repositoryRequest = {
    ...gitDeclaration(),
    gitOperation: "upload-pack",
    bodyBytes: 1,
    bodySha256: `sha256:${"a".repeat(64)}`,
  };
  assert.equal((await fixture.commit()).kind, "not-committed");
  assert.equal(fixture.queries.includes("COMMIT"), false);
});

test("fresh known-use refuses changed stored Git request bytes", async () => {
  const fixture = releaseProtocol({ git: true });
  const committed = await fixture.commit();
  assert.equal(committed.kind, "committed");
  fixture.changeRecordedRequest({
    ...gitDeclaration(),
    gitOperation: "upload-pack",
    bodyBytes: 1,
    bodySha256: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(
    await fixture.binding.participant.acquireCommittedRelease(
      committed.commit,
      fixture.call(),
      fixture.receiver,
      fixture.session,
    ),
    undefined,
  );
});

test("fresh known-use refuses a changed retained Work policy arm", async () => {
  const fixture = releaseProtocol({ git: true });
  const committed = await fixture.commit();
  assert.equal(committed.kind, "committed");
  fixture.setPolicy({ permission: "metadata:read" });
  assert.equal(
    await fixture.binding.participant.acquireCommittedRelease(
      committed.commit,
      fixture.call(),
      fixture.receiver,
      fixture.session,
    ),
    undefined,
  );
});
