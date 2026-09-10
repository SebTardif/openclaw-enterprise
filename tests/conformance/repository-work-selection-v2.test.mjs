// The protocol fixture below is copied from the original owned Work test f506d63a.
// It delegates to the genuine State owner/codecs with a controlled SQL peer;
// no native Work/key/physical body authority or real PostgreSQL is claimed.
import assert from "node:assert/strict";
import test from "node:test";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { canonicalRepositoryWorkV2 } from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import {
  repositoryInventoryDigestV2,
  repositoryRecordLiveV2,
} from "../../packages/occ/src/credential-inventory-v1/repository-lease-v2.ts";
import { transitionRepositoryInventoryV2 } from "../../packages/occ/src/credential-inventory-v1/repository-lease-transactions-v2.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { CREDENTIAL_STORAGE_LIMITS_V1 } from "@openclaw-enterprise/contracts/credential-storage-v1";

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
  const fixtureScope = hooks.scope ?? scope;
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
              id: fixtureScope.installationRef,
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
      const result = {
        ...lease("work"),
        actorId: "service",
        ...(hooks.noPrepareUse
          ? {}
          : {
              async prepareUse() {
                events.push(["prepare-use"]);
                await hooks.prepareUse?.(context, operation, call, binding);
              },
            }),
        async qualifyReadset(rows) {
          await hooks.qualifyReadset?.(rows);
        },
        async qualifyAdmission() {},
        async qualifyClosure() {},
        async qualifyObservation() {},
        qualifyInventory: hooks.qualifyInventory,
        qualifyInventoryRead: hooks.qualifyInventoryRead,
        qualifyInventoryCurrent: hooks.qualifyInventoryCurrent,
        qualifyMintUse: hooks.qualifyMintUse,
        qualifyRevocationUse: hooks.qualifyRevocationUse,
      };
      hooks.workLease?.(result);
      return result;
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
        qualifyInventoryCurrent: hooks.custodyInventoryCurrent,
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

const canon = canonicalRepositoryWorkV2;
const dataScope = {
  installationId: scope.installationRef,
  namespaceId: scope.namespaceRef,
  agentId: scope.agentRef,
  revisionRef: scope.revisionRef,
};
const policyDocument = () => ({
  schemaVersion: 2,
  policyRef: "policy",
  version: 1,
  status: "enabled",
  scope: {
    installationId: scope.installationRef,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  },
  servicePrincipalId: "service",
  repository: {
    target: {
      installationId: scope.installationRef,
      githubHost: "github.com",
      appId: "100",
      githubInstallationId: "200",
      repositoryId: "42",
    },
    owner: "owner",
    name: "name",
    profile: { ref: "repository-profile", revision: "1" },
  },
  executionProfile: { ref: "execution-profile", revision: "1" },
  operations: ["metadata:read"],
  bounds: {
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
    maximumWorkMilliseconds: 60000,
  },
});
function policyRow() {
  const document = policyDocument();
  return {
    ...document.scope,
    policyRef: document.policyRef,
    version: document.version,
    status: document.status,
    servicePrincipalId: document.servicePrincipalId,
    repositoryId: document.repository.target.repositoryId,
    document,
  };
}
const policyStorage = (statement) =>
  statement.startsWith("SELECT v.canonical_document")
    ? { rows: [{ canonical_document: canon(policyRow()) }], rowCount: 1 }
    : undefined;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("policy acquisition uses original completion after custody and all parents, then holds through the final fence", async () => {
  let held,
    f,
    custody = false;
  f = protocol({
    storage: policyStorage,
    acquireCustody() {
      custody = true;
    },
    async prepareUse(context, operation, call, binding) {
      assert.equal(custody, true);
      assert.ok(
        f.queries.includes(
          "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR NO KEY UPDATE",
        ),
      );
      held = await binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
      assert.equal(canon(held.policy), canon(policyDocument()));
      held.assertCurrent();
    },
    current(name) {
      if (name === "work" && held) held.assertCurrent();
    },
  });
  const result = await f.run((unit) => unit.readExactOperation());
  assert.equal(result.kind, "committed");
  assert.ok(
    f.queries.indexOf(
      "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR NO KEY UPDATE",
    ) < f.queries.findIndex((s) => s.startsWith("SELECT v.canonical_document")),
  );
  assert.throws(() => held.assertCurrent(), ScopeViolationError);
  assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
  assert.throws(
    () =>
      f.binding.participant.recognizeCommittedRelease(
        result.commit,
        "release",
        f.receiver,
        f.session,
      ),
    ScopeViolationError,
  );
});

test("a missing completion never admits the unit body", async () => {
  let entered = false;
  const f = protocol({ noPrepareUse: true });
  assert.equal(
    (
      await f.run(async () => {
        entered = true;
      })
    ).kind,
    "not-committed",
  );
  assert.equal(entered, false);
  assert.equal(f.queries.includes("COMMIT"), false);
  assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
});

for (const wrong of ["prefix", "context", "original", "second"]) {
  test(`policy ${wrong} acquisition poisons the exact original transaction even when caught`, async () => {
    let attempted;
    const acquire = async (context, operation, call, binding) => {
      if (wrong === "second")
        await binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
      attempted = binding.participant.acquireCurrentPolicy(
        wrong === "context" ? { ...context } : context,
        wrong === "original" ? { ...operation } : operation,
        call,
        "policy",
      );
      await assert.rejects(attempted, ScopeViolationError);
    };
    const f = protocol({
      storage: policyStorage,
      ...(wrong === "prefix" ? { acquireWork: acquire } : { prepareUse: acquire }),
    });
    assert.equal((await f.run()).kind, "not-committed");
    assert.ok(attempted);
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(
      f.queries.filter((s) => s.startsWith("SELECT v.canonical_document")).length,
      wrong === "second" ? 1 : 0,
    );
  });
}

test("missing current policy refuses before the unit is exposed", async () => {
  let entered = false;
  const f = protocol({
    storage: (s) =>
      s.startsWith("SELECT v.canonical_document") ? { rows: [], rowCount: 0 } : undefined,
    async prepareUse(c, o, call, b) {
      await b.participant.acquireCurrentPolicy(c, o, call, "policy");
    },
  });
  assert.equal(
    (
      await f.run(async () => {
        entered = true;
      })
    ).kind,
    "not-committed",
  );
  assert.equal(entered, false);
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("cancellation joins an entered completion before releasing the original sources", async () => {
  const entered = deferred(),
    resume = deferred(),
    abort = new AbortController();
  let body = false,
    settled = false;
  const f = protocol({
    async prepareUse() {
      entered.resolve();
      await resume.promise;
    },
  });
  const pending = f
    .run(async () => {
      body = true;
    }, abort)
    .then((v) => {
      settled = true;
      return v;
    });
  await entered.promise;
  abort.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(
    f.events.some((e) => e[0] === "release"),
    false,
  );
  resume.resolve();
  assert.equal((await pending).kind, "not-committed");
  assert.equal(body, false);
  assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("completion method capture preserves one observation and the original receiver", async () => {
  let observed = 0,
    calls = 0;
  const f = protocol({
    workLease(lease) {
      const method = async function () {
        assert.strictEqual(this, lease);
        calls++;
      };
      Object.defineProperty(lease, "prepareUse", {
        get() {
          observed++;
          return method;
        },
      });
    },
  });
  assert.equal((await f.run()).kind, "committed");
  assert.equal(observed, 1);
  assert.equal(calls, 1);
});

function inventoryFixture(options = {}) {
  const now = new Date().toISOString(),
    future = new Date(Date.now() + 60000).toISOString();
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
    executionProfile: { ref: "profile", revision: "1" },
    predecessor: { kind: "none" },
  };
  const access = {
    schemaVersion: 2,
    accessLeaseRef: "lease",
    target: {
      installationId: scope.installationRef,
      githubHost: "github.com",
      appId: "100",
      githubInstallationId: "200",
      repositoryId: "42",
    },
    original: original(),
    work: { workRef: "work", revision: 1 },
    execution,
    createdAt: now,
    notAfter: future,
  };
  const issuance = {
    schemaVersion: 2,
    method: "reserveRepositoryToken",
    operationRef: "reserve",
    scope: policyDocument().scope,
    createdAt: now,
    lease: access,
    bindingRef: "binding",
    permissionProfile: { ref: "repository-profile", revision: "1" },
    requestedPermissions: { metadata: "read" },
    deadline: future,
  };
  const target = {
    issuanceOperationRef: "reserve",
    recordRef: "record",
    intentDigest: repositoryInventoryDigestV2(issuance),
  };
  let record = {
    schemaVersion: 2,
    target,
    inventoryVersion: 1,
    issuance,
    updatedAt: now,
    expiry: { kind: "expiry-unproven" },
    state: "reserved",
    disposition: "scope-held",
  };
  let mint, cleanup;
  if (options.minted || options.cleanup || options.terminal) {
    mint = {
      schemaVersion: 2,
      recordRef: target.recordRef,
      issuanceOperationRef: target.issuanceOperationRef,
      issuanceIntentDigest: target.intentDigest,
      useOperationRef: "mint",
      useIntentDigest: `sha256:${"2".repeat(64)}`,
      providerAttemptRef: "mint-attempt",
      inventoryVersion: 2,
      custodyIdentity: {
        lease: access,
        key: { clientId: "client", bindingRef: "binding", immutableVersion: "key-version" },
        providerAttemptRef: "mint-attempt",
        tokenRef: "token",
        protectedRevocationRef: "cleanup-material",
      },
    };
    Object.assign(record, {
      inventoryVersion: 3,
      state: "outstanding",
      disposition: "current-check-required",
      providerAttemptRef: "mint-attempt",
      tokenRef: "token",
      protectedRevocationRef: "cleanup-material",
      returnedPermissions: { metadata: "read" },
      evidenceRef: "accepted",
      expiry: {
        kind: "provider-expiry",
        expiresAt: future,
        observedAt: now,
        evidenceRef: "expiry",
      },
    });
  }
  if (options.cleanup || options.terminal) {
    cleanup = {
      schemaVersion: 2,
      input: {
        schemaVersion: 2,
        method: "claimRepositoryRevocation",
        operationRef: "cleanup-claim",
        scope: issuance.scope,
        createdAt: now,
        target,
        expectedInventoryVersion: 3,
        tokenRef: "token",
        protectedRevocationRef: "cleanup-material",
        revocationOperationRef: "cleanup-effect",
        expectedRevocationVersion: 0,
        previousAttempt: { kind: "none" },
      },
      claimRef: "claim",
      claimVersion: 1,
      providerAttemptRef: "cleanup-attempt",
      claimedAt: now,
      claimNotAfter: new Date(
        Date.parse(now) + CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
      ).toISOString(),
    };
    Object.assign(record, {
      inventoryVersion: 4,
      disposition: "mitigation-only",
      revocation: {
        state: "claimed",
        version: 1,
        revocationOperationRef: "cleanup-effect",
        providerAttemptRef: "cleanup-attempt",
        claimRef: "claim",
        claimVersion: 1,
        claimedAt: cleanup.claimedAt,
        claimNotAfter: cleanup.claimNotAfter,
        priorOutcome: "none",
      },
    });
  }
  if (options.terminal) {
    Object.assign(record, {
      inventoryVersion: 5,
      state: "resolved-without-token",
      disposition: "resolved-no-live-token",
      evidenceRef: "terminal",
    });
    delete record.tokenRef;
    delete record.protectedRevocationRef;
    delete record.returnedPermissions;
  }
  options.change?.(record, mint, cleanup);
  let observed,
    context,
    operation,
    call,
    sourceCalls = 0,
    custodyCalls = 0,
    f;
  const storage = (statement, parameters) => {
    if (statement.includes("FROM occ.credential_inventory_access_leases"))
      return { rows: [{ document: access }], rowCount: 1 };
    if (statement.includes("FROM occ.credential_inventory_mint_claims"))
      return { rows: mint ? [{ document: mint }] : [], rowCount: mint ? 1 : 0 };
    if (statement.includes("FROM occ.credential_inventory_revocation_claims"))
      return { rows: cleanup ? [{ document: cleanup }] : [], rowCount: cleanup ? 1 : 0 };
    if (statement.includes("FROM occ.credential_inventory_records")) {
      const records =
        options.absent ||
        (statement.includes("AND live ORDER BY") && !repositoryRecordLiveV2(record))
          ? []
          : [record];
      return { rows: records.map((document) => ({ document })), rowCount: records.length };
    }
  };
  f = protocol({
    storage,
    acquireWork(c, o, actualCall) {
      context = c;
      operation = o;
      call = actualCall;
    },
    qualifyInventoryCurrent: options.noObserver
      ? undefined
      : async (facts) => {
          sourceCalls++;
          f.binding.participant.assertInventoryCurrent(context, operation, call, facts);
          observed = facts;
          if (options.copied)
            assert.throws(
              () =>
                f.binding.participant.assertInventoryCurrent(
                  context,
                  operation,
                  call,
                  structuredClone(facts),
                ),
              ScopeViolationError,
            );
          if (options.refuse) throw new Error("independent observation refused");
        },
    custodyInventoryCurrent: options.noCustody
      ? undefined
      : async (facts) => {
          custodyCalls++;
          assert.strictEqual(facts, observed);
          f.binding.participant.assertInventoryCurrent(context, operation, call, facts);
        },
  });
  return {
    ...f,
    target,
    get record() {
      return record;
    },
    access,
    get mintClaim() {
      return mint;
    },
    get revocationClaim() {
      return cleanup;
    },
    replaceRecord(expectedVersion, next) {
      assert.equal(expectedVersion, record.inventoryVersion);
      record = next;
    },
    counts: () => ({ sourceCalls, custodyCalls }),
    selected: () => ({ context, operation, call, observed }),
  };
}

test("fresh exact inventory tuple uses both original observers after parents without an open Work or new claim", async () => {
  const f = inventoryFixture();
  const result = await f.run((u) => u.readRepositoryInventoryCurrent(f.target));
  assert.equal(result.kind, "committed");
  assert.equal(result.value.kind, "current");
  assert.equal(canon(result.value.record), canon(f.record));
  assert.equal(canon(result.value.lease), canon(f.access));
  assert.equal(result.value.mintClaim, undefined);
  assert.equal(result.value.revocationClaim, undefined);
  assert.equal(result.value.liveRecords.length, 1);
  assert.deepEqual(f.counts(), { sourceCalls: 1, custodyCalls: 1 });
  assert.equal(
    f.queries.some((s) => /repository_work_(heads|versions)/.test(s)),
    false,
  );
  assert.equal(
    f.queries.some((s) => s.startsWith("INSERT") || s.startsWith("UPDATE")),
    false,
  );
  assert.throws(
    () => f.binding.participant.recognizeCommittedInventory(result.commit, f.selected().operation),
    ScopeViolationError,
  );
  assert.throws(
    () =>
      f.binding.participant.assertInventoryCurrent(
        f.selected().context,
        f.selected().operation,
        f.selected().call,
        result.value,
      ),
    ScopeViolationError,
  );
});

test("exact absent inventory is qualified by both observers without adopting any live record", async () => {
  const f = inventoryFixture({ absent: true });
  const result = await f.run((u) => u.readRepositoryInventoryCurrent(f.target));
  assert.equal(result.kind, "committed");
  assert.deepEqual(result.value, { kind: "absent", target: f.target });
  assert.deepEqual(f.counts(), { sourceCalls: 1, custodyCalls: 1 });
});

for (const option of ["noObserver", "noCustody", "copied", "refuse"]) {
  test(`fresh current inventory refuses ${option} without a publication or witness`, async () => {
    const f = inventoryFixture({ [option]: true });
    assert.equal(
      (await f.run((u) => u.readRepositoryInventoryCurrent(f.target))).kind,
      "not-committed",
    );
    assert.equal(f.queries.includes("COMMIT"), false);
    if (option.startsWith("no"))
      assert.equal(
        f.queries.some((s) => s.includes("credential_inventory_records")),
        false,
      );
    assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
  });
}

test("a fresh unit cannot read two independently selected inventory targets", async () => {
  const f = inventoryFixture();
  assert.equal(
    (
      await f.run(async (u) => {
        await u.readRepositoryInventoryCurrent(f.target);
        await u.readRepositoryInventoryCurrent(f.target);
      })
    ).kind,
    "not-committed",
  );
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("exact current inventory rejects an immutable target digest mismatch", async () => {
  const f = inventoryFixture();
  assert.equal(
    (
      await f.run((u) =>
        u.readRepositoryInventoryCurrent({ ...f.target, intentDigest: `sha256:${"f".repeat(64)}` }),
      )
    ).kind,
    "not-committed",
  );
  assert.equal(f.counts().sourceCalls, 0);
  assert.equal(f.queries.includes("COMMIT"), false);
});

for (const mode of ["minted", "cleanup", "terminal"]) {
  test(`fresh ${mode} inventory retains exact original mint/key and current cleanup attempt without remint authority`, async () => {
    const f = inventoryFixture({ [mode]: true });
    const result = await f.run((u) => u.readRepositoryInventoryCurrent(f.target));
    assert.equal(result.kind, "committed");
    assert.equal(result.value.kind, "current");
    assert.equal(result.value.mintClaim.providerAttemptRef, "mint-attempt");
    assert.equal(result.value.mintClaim.custodyIdentity.key.immutableVersion, "key-version");
    if (mode !== "minted")
      assert.equal(result.value.revocationClaim.providerAttemptRef, "cleanup-attempt");
    assert.equal(result.value.liveRecords.length, mode === "terminal" ? 0 : 1);
    assert.throws(
      () =>
        f.binding.participant.recognizeCommittedInventory(result.commit, f.selected().operation),
      ScopeViolationError,
    );
    assert.equal(
      f.queries.some((s) => s.startsWith("INSERT") || s.startsWith("UPDATE")),
      false,
    );
  });
}
for (const [name, change] of [
  [
    "mint attempt",
    (record, mint) => {
      mint.providerAttemptRef = "different";
      mint.custodyIdentity.providerAttemptRef = "different";
    },
  ],
  [
    "mint key binding",
    (record, mint) => {
      mint.custodyIdentity.key.bindingRef = "different";
    },
  ],
  [
    "cleanup attempt",
    (record, mint, cleanup) => {
      cleanup.providerAttemptRef = "different";
    },
  ],
  [
    "cleanup effect",
    (record, mint, cleanup) => {
      cleanup.input.revocationOperationRef = "different";
    },
  ],
  [
    "cleanup token",
    (record, mint, cleanup) => {
      cleanup.input.tokenRef = "different";
    },
  ],
]) {
  test(`fresh inventory refuses a mismatched ${name} in the current tuple`, async () => {
    const f = inventoryFixture({ cleanup: true, change });
    assert.equal(
      (await f.run((u) => u.readRepositoryInventoryCurrent(f.target))).kind,
      "not-committed",
    );
    assert.equal(f.counts().sourceCalls, 0);
    assert.equal(f.queries.includes("COMMIT"), false);
  });
}

test("entered detached policy acquisition drains before State exposes the unit", async () => {
  const entered = deferred(),
    resume = deferred();
  let body = false,
    acquisition;
  const f = protocol({
    async storage(statement) {
      if (!statement.startsWith("SELECT v.canonical_document")) return undefined;
      entered.resolve();
      await resume.promise;
      return policyStorage(statement);
    },
    prepareUse(context, operation, call, binding) {
      acquisition = binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
      void acquisition.catch(() => {});
    },
  });
  const pending = f.run(async (unit) => {
    body = true;
    return unit.readExactOperation();
  });
  await entered.promise;
  await new Promise((r) => setImmediate(r));
  assert.equal(body, false);
  resume.resolve();
  assert.equal((await pending).kind, "committed");
  assert.equal(canon((await acquisition).policy), canon(policyDocument()));
  assert.equal(body, true);
});

// Use the original accepted transition to produce the current record. This
// controlled storage peer stages its CAS/history; it is not a new production
// inventory enrollment or a claimed outer business COMMIT.
async function recordCleanupOutcome(f, outcome) {
  const before = f.record,
    claim = f.revocationClaim;
  const instant = new Date(Date.parse(before.updatedAt) + 1).toISOString();
  const input = {
    schemaVersion: 2,
    method: "recordRepositoryRevocation",
    operationRef: `record-cleanup-${before.inventoryVersion}-${outcome}`,
    scope: before.issuance.scope,
    createdAt: instant,
    target: f.target,
    expectedInventoryVersion: before.inventoryVersion,
    tokenRef: claim.input.tokenRef,
    protectedRevocationRef: claim.input.protectedRevocationRef,
    revocationOperationRef: claim.input.revocationOperationRef,
    claimRef: claim.claimRef,
    claimVersion: claim.claimVersion,
    providerAttemptRef: claim.providerAttemptRef,
    outcome,
    evidenceRef: `cleanup-evidence-${before.inventoryVersion}-${outcome}`,
    observedAt: instant,
  };
  let replacements = 0;
  const appended = [],
    events = [];
  const tx = {
    commitRef: "controlled-outcome-commit",
    assertActive() {
      events.push("active");
    },
    async findOperation(ref) {
      assert.equal(ref, input.operationRef);
      return undefined;
    },
    async findRecord(ref) {
      assert.equal(ref, f.target.recordRef);
      return f.record;
    },
    async findRevocationClaim(ref) {
      assert.equal(ref, claim.claimRef);
      return claim;
    },
    async replaceRecord(version, next) {
      assert.equal(version, before.inventoryVersion);
      replacements++;
      f.replaceRecord(version, next);
      events.push("replace");
    },
    async appendOperation(operation) {
      assert.strictEqual(operation.record, f.record);
      assert.equal(operation.digest, repositoryInventoryDigestV2(input));
      appended.push(operation);
      events.push("append");
    },
  };
  const result = await transitionRepositoryInventoryV2(tx, input, {
    read: () => ({ now: Date.parse(instant), uncertaintyMs: 0 }),
  });
  assert.equal(result.kind, "staged");
  assert.equal(replacements, 1);
  assert.equal(appended.length, 1);
  assert.strictEqual(result.operation, appended[0]);
  assert.strictEqual(f.revocationClaim, claim);
  assert.equal(f.record.inventoryVersion, before.inventoryVersion + 1);
  assert.equal(f.record.revocation.version, before.revocation.version + 1);
  assert.equal(f.record.revocation.claimVersion, claim.claimVersion);
  assert.equal(f.record.revocation.state, outcome);
  assert.equal(result.operation.state, outcome === "confirmed" ? "completed" : "effect-unknown");
  assert.ok(events.indexOf("replace") < events.indexOf("append"));
  return result.operation;
}

for (const outcome of ["unknown", "not-dispatched", "confirmed"]) {
  test(`current inventory reads the original transition's recorded ${outcome} cleanup outcome`, async () => {
    const f = inventoryFixture({ cleanup: true });
    const claimBefore = canon(f.revocationClaim);
    const staged = await recordCleanupOutcome(f, outcome);
    assert.equal(f.record.revocation.version, 2);
    assert.equal(f.record.revocation.claimVersion, 1);
    assert.equal(canon(f.revocationClaim), claimBefore);
    const result = await f.run((unit) => unit.readRepositoryInventoryCurrent(f.target));
    assert.equal(result.kind, "committed");
    assert.equal(result.value.kind, "current");
    assert.equal(canon(result.value.record), canon(staged.record));
    assert.equal(canon(result.value.revocationClaim), claimBefore);
    assert.equal(
      result.value.record.state,
      outcome === "confirmed" ? "resolved-without-token" : "outstanding",
    );
    assert.equal(result.value.liveRecords.length, outcome === "confirmed" ? 0 : 1);
    assert.deepEqual(f.counts(), { sourceCalls: 1, custodyCalls: 1 });
    assert.equal(
      f.queries.some((s) => s.startsWith("INSERT") || s.startsWith("UPDATE")),
      false,
    );
    assert.equal(f.queries.filter((s) => s === "COMMIT").length, 1);
    assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
    assert.throws(
      () =>
        f.binding.participant.recognizeCommittedInventory(result.commit, f.selected().operation),
      ScopeViolationError,
    );
  });
}

test("later original confirmation preserves the same immutable cleanup claim across current versions", async () => {
  const f = inventoryFixture({ cleanup: true });
  const claimBefore = canon(f.revocationClaim);
  const unknown = await recordCleanupOutcome(f, "unknown");
  const oldOutcome = canon(unknown);
  const confirmed = await recordCleanupOutcome(f, "confirmed");
  assert.equal(canon(unknown), oldOutcome);
  assert.equal(canon(f.revocationClaim), claimBefore);
  assert.equal(f.record.revocation.version, 3);
  assert.equal(f.record.revocation.claimVersion, 1);
  const result = await f.run((unit) => unit.readRepositoryInventoryCurrent(f.target));
  assert.equal(result.kind, "committed");
  assert.equal(canon(result.value.record), canon(confirmed.record));
  assert.equal(result.value.liveRecords.length, 0);
  assert.deepEqual(f.counts(), { sourceCalls: 1, custodyCalls: 1 });
  assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
});

for (const mismatch of ["claim reference", "immutable claim version"]) {
  test(`recorded cleanup still refuses a mismatched ${mismatch}`, async () => {
    const f = inventoryFixture({ cleanup: true });
    const staged = await recordCleanupOutcome(f, "unknown");
    const validRecord = canon(staged.record);
    if (mismatch === "claim reference") f.revocationClaim.claimRef = "different-claim";
    else {
      // Keep the returned claim parser-valid while contradicting the exact
      // immutable claimVersion in the genuinely transitioned current record.
      f.revocationClaim.claimVersion = 2;
      f.revocationClaim.input.expectedRevocationVersion = 1;
    }
    assert.equal(canon(f.record), validRecord);
    assert.equal(
      (await f.run((unit) => unit.readRepositoryInventoryCurrent(f.target))).kind,
      "not-committed",
    );
    assert.deepEqual(f.counts(), { sourceCalls: 0, custodyCalls: 0 });
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
  });
}

// Assignment producer extension: actual State owner, preparation decoder and
// retained repositories; the external native/admission sources and SQL peer are
// explicitly controlled. No source callback below is production authority.
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import { githubMetadataDigest } from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { repositoryWorkPolicyDigestV2 } from "../../packages/occ/src/lifecycle/repository-work-policy-v2.ts";

function readsetRow(execution = { fixtureExecution: "original" }) {
  return {
    scope: dataScope,
    workRef: "work",
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: "work",
    originalHorizon: new Date(Date.now() + 60000).toISOString(),
    state: "open",
    execution,
    policy: {},
    originalAdmission: {},
  };
}
function readsetStorage(row, hook) {
  return async (statement, values) => {
    const p = policyStorage(statement);
    if (p) return p;
    if (statement.includes("FROM occ.repository_work_heads_v2")) {
      await hook?.(statement, values);
      return { rows: [{ canonical_document: canon(row) }], rowCount: 1 };
    }
  };
}

test("same-unit current readset is acquired once after policy and still requires the original qualifier", async () => {
  const row = readsetRow();
  let borrowed,
    qualified = 0;
  const f = protocol({
    storage: readsetStorage(row),
    qualifyReadset(rows) {
      qualified++;
      assert.equal(canon(rows.lineage), canon([row]));
    },
    async prepareUse(context, operation, call, binding) {
      await binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
      borrowed = await binding.participant.acquireCurrentReadset(
        context,
        operation,
        call,
        { workRef: row.workRef, revision: 1 },
        row.execution,
      );
      borrowed.assertCurrent();
    },
  });
  const result = await f.run((unit) =>
    unit.readForMutation({ workRef: row.workRef, revision: 1 }, row.execution),
  );
  assert.equal(result.kind, "committed");
  assert.equal(qualified, 1);
  assert.equal(f.queries.filter((s) => s.includes("FROM occ.repository_work_heads_v2")).length, 2);
  assert.throws(() => borrowed.assertCurrent(), ScopeViolationError);
});

for (const wrong of ["before-policy", "copied-context", "wrong-execution", "duplicate-entered"]) {
  test(`current readset ${wrong} cannot enter or bypass the original unit`, async () => {
    const row = readsetRow();
    let attempted, first;
    const f = protocol({
      storage: readsetStorage(row),
      async prepareUse(context, operation, call, binding) {
        if (wrong !== "before-policy")
          await binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
        if (wrong === "duplicate-entered") {
          first = binding.participant.acquireCurrentReadset(
            context,
            operation,
            call,
            { workRef: "work", revision: 1 },
            row.execution,
          );
          void first.catch(() => {});
        }
        attempted = binding.participant.acquireCurrentReadset(
          wrong === "copied-context" ? { ...context } : context,
          operation,
          call,
          { workRef: "work", revision: 1 },
          wrong === "wrong-execution" ? { different: true } : row.execution,
        );
        await assert.rejects(attempted, ScopeViolationError);
        if (first) await Promise.allSettled([first]);
      },
    });
    assert.equal((await f.run()).kind, "not-committed");
    assert.ok(attempted);
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
  });
}

async function assignmentProtocol(hooks = {}) {
  const seed = await seedPreparation(new InMemoryPlatformState());
  await seed.append(seed.plan);
  await seed.append(seed.child);
  const history = await seed.history();
  const sc = {
    installationRef: seed.scope.installationId,
    namespaceRef: seed.scope.namespaceId,
    agentRef: seed.scope.agentId,
    revisionRef: seed.allocation.revisionId,
  };
  const dbScope = { ...seed.scope, revisionRef: sc.revisionRef };
  const request = {
    version: 2,
    sequence: 1,
    request_ref: "1".repeat(32),
    method: "open-read",
    attachment_ref: "attachment/original",
    repository_owner: "owner",
    repository_name: "name",
    request_sha256: githubMetadataDigest("owner", "name"),
  };
  const deadline = new Date(Date.now() + 2500).toISOString(),
    horizon = new Date(Date.now() + 30000).toISOString();
  const op = (name) =>
    Object.freeze({
      operationRef: name,
      invocationRef: "invocation/original",
      requestDigest: request.request_sha256,
      scope: sc,
    });
  const preparation = op("preparation/original"),
    dispatch = op("dispatch/original"),
    observation = op("observation/original");
  const execution = {
    attempt: {
      installationRef: sc.installationRef,
      namespaceRef: sc.namespaceRef,
      agentRef: sc.agentRef,
      conversationRef: "conversation",
      turnRef: "turn",
      attemptRef: "attempt",
      reservationRef: "reservation",
    },
    assignmentRef: seed.allocation.assignmentRef,
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation",
    executionGeneration: "1",
    receiverRef: "receiver",
    protectedOriginRef: "origin",
    executionProfile: { ref: "execution-profile", revision: "1" },
    predecessor: { kind: "none" },
  };
  const service = {
    kind: "service_principal",
    id: seed.allocation.servicePrincipalId,
    namespaceId: sc.namespaceRef,
    agentId: sc.agentRef,
  };
  const document = policyDocument();
  document.scope = seed.scope;
  document.servicePrincipalId = service.id;
  document.repository.target.installationId = sc.installationRef;
  const policy = {
    operation: "work.repository.use",
    service,
    repositoryId: "42",
    profile: document.repository.profile,
    permission: "metadata:read",
  };
  const work = { workRef: "work/original", revision: 1 };
  const member = { work, originalHorizon: horizon, state: "open", withdrawalRevision: 0 };
  const current = {
    original: dispatch,
    work,
    execution,
    service,
    originalHorizon: horizon,
    repository: { id: "42", owner: "owner", name: "name", profile: document.repository.profile },
    policy,
    lineage: {
      scope: sc,
      own: member,
      membershipProfile: { ref: "lineage", revision: "1" },
      kind: "root",
      rootWorkRef: work.workRef,
      parentWorkRef: null,
      ancestors: [],
    },
    withdrawals: [{ work, revision: 0, withdrawn: false }],
    attachmentRef: request.attachment_ref,
    dnsBindingRef: "dns/original",
    upstreamIpv4: "192.0.2.1",
    validUntil: deadline,
  };
  const row = {
    scope: dbScope,
    workRef: work.workRef,
    revision: 1,
    withdrawalRevision: 0,
    parentWorkRef: null,
    rootWorkRef: work.workRef,
    originalHorizon: horizon,
    state: "open",
    execution,
    policy,
    originalAdmission: { operationRef: "admission/original" },
  };
  const admissionOperation = {
    ...op("admission/original"),
    scope: dbScope,
    commitRef: "commit/original",
    kind: "admission",
    document: { record: row },
  };
  const data = {
    selection: {
      current,
      preparation,
      observation,
      admission: { kind: "existing", originalAdmission: admissionOperation },
      sessionRef: "github-native/original",
      repositoryTarget: document.repository.target,
      policyAdmission: {
        policyRef: document.policyRef,
        policyVersion: 1,
        policyDigest: repositoryWorkPolicyDigestV2(document),
        execution,
        originalHorizon: horizon,
      },
      workBeganAt: new Date().toISOString(),
      observationRef: "observation/ref",
      observationEvidenceRef: "observation/evidence",
    },
    runtime: {
      target: seed.target,
      preparationRef: seed.plan.preparationRef,
      preparationVersion: 2,
      childEffectRef: seed.child.child.effect.effectRef,
    },
  };
  const allocationRow = {
    installation_id: sc.installationRef,
    namespace_id: sc.namespaceRef,
    agent_id: sc.agentRef,
    assignment_ref: seed.allocation.assignmentRef,
    create_effect_ref: seed.allocation.createEffectRef,
    revision_id: sc.revisionRef,
    service_principal_id: service.id,
    lifecycle_generation: seed.allocation.lifecycleGeneration,
    component: seed.allocation.component,
    runtime_generation: seed.allocation.runtimeGeneration,
    provider_profile_ref: seed.allocation.providerProfileRef,
    runtime_profile_ref: seed.allocation.runtimeProfileRef,
    identity_profile_ref: seed.allocation.identityProfileRef,
    binding_condition: "unbound",
    created_at: seed.allocation.createdAt,
  };
  const sourceEvents = [],
    nativeLifetime = new AbortController(),
    abort = new AbortController();
  const session = Object.freeze({}),
    admitted = Object.freeze({}),
    origin = Object.freeze({});
  const call = {
    context: Object.freeze({}),
    requestRef: request.request_ref,
    recipientRef: "recipient/occ",
    deadline,
    signal: abort.signal,
  };
  const observerCall = {
    context: Object.freeze({}),
    requestRef: "observer/request",
    recipientRef: "recipient/observer",
    deadline,
    signal: new AbortController().signal,
  };
  let pairing,
    binding,
    handle,
    selection,
    sourceChecks = 0,
    sourceReleases = 0,
    observationHeld = 0;
  const source = {
    bindState(value) {
      assert.equal(pairing, undefined);
      pairing = value;
    },
    async acquire(input, n, c) {
      assert.equal(n, session);
      assert.equal(c.context, call.context);
      assert.equal(canon(input), canon(request));
      sourceEvents.push("source-acquire");
      return hooks.acquire ? hooks.acquire(input, admitted) : admitted;
    },
    async inspect(a, n) {
      assert.equal(a, admitted);
      assert.equal(n, session);
      sourceEvents.push("source-inspect");
      return hooks.inspect ? hooks.inspect(data) : data;
    },
    assertCurrent(a, n, c) {
      assert.equal(a, admitted);
      assert.equal(n, session);
      assert.equal(c.signal.aborted, false);
      sourceChecks++;
      return hooks.current?.();
    },
    async retainUse(context, a, n, c) {
      pairing.assertOriginal(context, a, n, c);
      sourceEvents.push("retain-source-prefix");
      await hooks.retainEntered?.(context, a, n, c, pairing);
      const lease = {
        assertCurrent() {
          return hooks.retainedCurrent?.();
        },
        async prepareCommit() {
          sourceEvents.push("source-prepare");
          await hooks.prepare?.();
        },
        async release() {
          sourceEvents.push("source-lease-release");
          await hooks.leaseRelease?.();
        },
      };
      return hooks.lease ? hooks.lease(lease) : lease;
    },
    async retainObservation(context, a, originalOperation, c) {
      pairing.assertObservationOriginal(context, a, originalOperation, c);
      assert.equal(c, observerCall);
      observationHeld++;
      return {
        assertCurrent() {
          assert.equal(c.signal.aborted, false);
        },
        async prepareCommit() {},
        async release() {
          sourceEvents.push("observer-release");
        },
      };
    },
    async observationCall(a) {
      assert.equal(a, admitted);
      return observerCall;
    },
    async acquireInventory(a, n, c) {
      assert.equal(a, admitted);
      assert.equal(n, session);
      assert.equal(c, call);
      return hooks.inventory?.({ data, pairing, admitted, session });
    },
    async release(a) {
      assert.equal(a, admitted);
      sourceReleases++;
      await hooks.release?.();
    },
  };
  hooks.source?.(source);
  const native = {
    async inspect(n, c) {
      assert.equal(n, session);
      assert.equal(c.context, call.context);
      return {
        context: c.context,
        sessionRef: data.selection.sessionRef,
        lifetime: nativeLifetime.signal,
        verified: {
          configuration: {
            role: "repository-issuer",
            allowedScope: { kind: "agent", ...seed.scope },
          },
        },
      };
    },
    assertCurrent(n, c) {
      assert.equal(n, session);
      assert.equal(c.context, call.context);
      assert.equal(nativeLifetime.signal.aborted, false);
    },
  };
  const f = protocol({
    scope: sc,
    async acquireWork(context, operation, c) {
      await hooks.acquireWork?.(context, operation, c);
    },
    storage: async (statement, values) => {
      const override = await hooks.storage?.(statement, values, { data, row, document });
      if (override !== undefined) return override;
      if (statement.includes("FROM occ.runtime_preparation_submissions"))
        return { rows: [], rowCount: 0 };
      if (statement.includes("FROM occ.runtime_preparation_operations")) {
        if (statement.includes("child_effect_ref")) {
          assert.deepEqual(values, [
            seed.child.child.effect.effectRef,
            sc.installationRef,
            sc.namespaceRef,
            sc.agentRef,
          ]);
          return { rows: [{ record: history[1] }], rowCount: 1 };
        }
        assert.ok(statement.includes("local_version<=$5"));
        return { rows: history.map((record) => ({ record })), rowCount: history.length };
      }
      if (statement.includes("FROM occ.runtime_assignment_allocations"))
        return { rows: [allocationRow], rowCount: 1 };
      if (statement.startsWith("SELECT v.canonical_document")) {
        const stored = {
          ...seed.scope,
          policyRef: document.policyRef,
          version: 1,
          status: document.status,
          servicePrincipalId: service.id,
          repositoryId: "42",
          document,
        };
        return { rows: [{ canonical_document: canon(stored) }], rowCount: 1 };
      }
      if (statement.includes("FROM occ.repository_work_operations_v2"))
        return { rows: [{ canonical_document: canon(admissionOperation) }], rowCount: 1 };
      if (statement.includes("FROM occ.repository_work_heads_v2"))
        return { rows: [{ canonical_document: canon(row) }], rowCount: 1 };
    },
    async prepareUse(context, operation, c) {
      if (hooks.prepareUse) return hooks.prepareUse(context, operation, c, binding, selection);
      if (operation === observation)
        await binding.selection.retainObservation(context, selection, operation, c);
      else await binding.selection.retainPolicy(context, selection, operation, c);
    },
    qualifyReadset(rows) {
      assert.equal(canon(rows.lineage), canon([row]));
    },
  });
  binding = f.state.repositoryWorkSelectionBindingV2(f.binding, {
    protocolVersion: 2,
    maximumAssignments: 4,
    native,
    selected: source,
  });
  binding.assignments.bindOrigins({
    recognize(value) {
      assert.equal(value, origin);
      assert.ok(handle);
      return handle;
    },
  });
  return {
    ...f,
    binding,
    source,
    native,
    pairing,
    data,
    row,
    document,
    request,
    call,
    observerCall,
    session,
    admitted,
    origin,
    nativeLifetime,
    abort,
    sourceEvents,
    get sourceReleases() {
      return sourceReleases;
    },
    get sourceChecks() {
      return sourceChecks;
    },
    get observationHeld() {
      return observationHeld;
    },
    async acquire() {
      handle = await binding.assignments.acquire(request, session, call);
      return handle;
    },
    async select() {
      selection = await binding.selection.acquire(origin, request, call);
      return selection;
    },
    async use(body) {
      return f.store.run(preparation, call, { signal: call.signal, timeoutMs: 1000 }, body);
    },
    async observe() {
      return f.store.run(
        observation,
        observerCall,
        { signal: observerCall.signal, timeoutMs: 1000 },
        () => undefined,
      );
    },
  };
}

test("assignment holds exact retained reads, transfers no cached authority, and reacquires in the original Work unit", async () => {
  const f = await assignmentProtocol();
  const handle = await f.acquire();
  let selection;
  try {
    assert.ok(handle);
    f.binding.assignments.assertCurrent(handle);
    assert.throws(() => f.binding.assignments.assertCurrent({ ...handle }), ScopeViolationError);
    const actual = await f.binding.assignments.inspect(handle, f.call);
    assert.equal(canon(actual.execution), canon(f.data.selection.current.execution));
    selection = await f.select();
    assert.equal(
      (await f.binding.selection.inspect(selection, f.origin, f.call)).preparation,
      f.data.selection.preparation,
    );
    await f.binding.selection.prepareStateUse(selection, f.origin, f.call);
    assert.ok(f.queries.includes("ROLLBACK"));
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.throws(() => f.binding.assignments.assertCurrent(handle), ScopeViolationError);
    const result = await f.use((unit) => {
      f.binding.assignments.assertCurrent(handle);
      return unit.readForMutation(
        f.data.selection.current.work,
        f.data.selection.current.execution,
      );
    });
    assert.equal(result.kind, "committed");
    assert.throws(() => f.binding.assignments.assertCurrent(handle), ScopeViolationError);
    await f.binding.assignments.release(handle);
    assert.equal(f.sourceReleases, 0);
    assert.equal(await f.binding.selection.observationCall(selection), f.observerCall);
    assert.equal((await f.observe()).kind, "committed");
    assert.equal(f.observationHeld, 1);
    await f.binding.selection.release(selection);
    selection = undefined;
    assert.equal(f.sourceReleases, 1);
    await f.binding.assignments.release(handle);
    assert.equal(f.sourceReleases, 1);
  } finally {
    if (selection) await f.binding.selection.release(selection);
    await f.binding.close();
  }
});

test("unavailable original admission returns no assignment and checks out no State transaction", async () => {
  const f = await assignmentProtocol({ acquire: () => undefined });
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.queries.length, 0);
  assert.equal(f.sourceReleases, 0);
  await f.binding.close();
});

test("constructor shutdown joins late original acquisition and releases its custody once", async () => {
  const entered = deferred(),
    late = deferred(),
    released = deferred();
  const f = await assignmentProtocol({
    acquire: async (_request, a) => {
      entered.resolve();
      await late.promise;
      return a;
    },
    async release() {
      released.resolve();
    },
  });
  const pending = f.acquire();
  void pending.catch(() => {});
  await entered.promise;
  let closed = false;
  const closing = f.binding.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  late.resolve();
  await assert.rejects(pending, ScopeViolationError);
  await closing;
  await released.promise;
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.queries.length, 0);
});

test("duplicate original admission cannot release another live assignment", async () => {
  const f = await assignmentProtocol();
  const handle = await f.acquire();
  try {
    await assert.rejects(
      f.binding.assignments.acquire(f.request, f.session, f.call),
      ScopeViolationError,
    );
    assert.equal(f.sourceReleases, 0);
    f.binding.assignments.assertCurrent(handle);
  } finally {
    await f.binding.assignments.release(handle);
    await f.binding.close();
  }
  assert.equal(f.sourceReleases, 1);
});

test("captured source methods are observed once with their original receiver", async () => {
  let reads = 0;
  const f = await assignmentProtocol({
    source(source) {
      const method = source.acquire;
      Object.defineProperty(source, "acquire", {
        get() {
          reads++;
          return function (...args) {
            assert.equal(this, source);
            return method.apply(this, args);
          };
        },
      });
    },
  });
  const handle = await f.acquire();
  await f.binding.assignments.release(handle);
  await f.binding.close();
  assert.equal(reads, 1);
  assert.equal(f.sourceReleases, 1);
});

for (const wrong of ["scope", "policy", "closed-work", "original-object"]) {
  test(`assignment refuses ${wrong} drift while joining exact original cleanup`, async () => {
    let inspections = 0;
    const f = await assignmentProtocol({
      inspect(data) {
        inspections++;
        if (wrong === "original-object" && inspections > 1)
          return {
            ...data,
            selection: { ...data.selection, preparation: { ...data.selection.preparation } },
          };
        if (wrong === "scope")
          data.runtime.target = { ...data.runtime.target, agentId: "agt_wrong" };
        return data;
      },
      storage(statement, _values, { row, document }) {
        if (wrong === "policy" && statement.startsWith("SELECT v.canonical_document"))
          document.status = "disabled";
        if (wrong === "closed-work" && statement.includes("FROM occ.repository_work_heads_v2"))
          row.state = "closed";
      },
    });
    if (wrong === "original-object") {
      const h = await f.acquire();
      await assert.rejects(f.binding.assignments.inspect(h, f.call), ScopeViolationError);
      await f.binding.assignments.release(h);
    } else await assert.rejects(f.acquire());
    await f.binding.close();
    assert.equal(f.sourceReleases, 1);
    assert.equal(f.queries.includes("COMMIT"), false);
  });
}

test("returned source cleanup is owned before a later malformed currentness getter", async () => {
  const f = await assignmentProtocol({
    lease(value) {
      Object.defineProperty(value, "assertCurrent", {
        get() {
          throw new ScopeViolationError("malformed original lease");
        },
      });
      return value;
    },
  });
  await assert.rejects(f.acquire(), ScopeViolationError);
  await f.binding.close();
  assert.equal(f.sourceEvents.filter((x) => x === "source-lease-release").length, 1);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("malformed asynchronous assertion is refused and joined before original source release", async () => {
  const entered = deferred(),
    late = deferred();
  let armed = true;
  const f = await assignmentProtocol({
    retainedCurrent() {
      if (!armed) return undefined;
      armed = false;
      entered.resolve();
      return late.promise;
    },
  });
  const pending = f.acquire();
  void pending.catch(() => {});
  await entered.promise;
  await Promise.resolve();
  assert.equal(f.sourceReleases, 0);
  assert.equal(f.queries.includes("ROLLBACK"), false);
  assert.equal(f.sourceEvents.includes("source-lease-release"), false);
  late.resolve();
  await assert.rejects(pending, ScopeViolationError);
  await f.binding.close();
  assert.equal(f.sourceReleases, 1);
});

test("retained currentness cannot queue a nested assignment operation and hide the refusal", async () => {
  let attempted,
    armed = false,
    handle,
    f;
  f = await assignmentProtocol({
    retainedCurrent() {
      if (armed) {
        armed = false;
        attempted = f.binding.assignments.inspect(handle, f.call);
        void attempted.catch(() => {});
      }
    },
  });
  handle = await f.acquire();
  armed = true;
  assert.throws(() => f.binding.assignments.assertCurrent(handle), ScopeViolationError);
  await assert.rejects(attempted, ScopeViolationError);
  await f.binding.assignments.release(handle);
  await f.binding.close();
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("cancellation joins an accepted source lease before releasing its original admission", async () => {
  const entered = deferred(),
    late = deferred();
  const f = await assignmentProtocol({
    async retainEntered() {
      entered.resolve();
      await late.promise;
    },
  });
  const pending = f.acquire();
  void pending.catch(() => {});
  await entered.promise;
  f.abort.abort();
  await Promise.resolve();
  assert.equal(f.sourceReleases, 0);
  late.resolve();
  await assert.rejects(pending);
  await f.binding.close();
  assert.equal(f.sourceEvents.filter((x) => x === "source-lease-release").length, 1);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("readset acquisition cannot overtake an entered but unresolved policy head read", async () => {
  const row = readsetRow(),
    entered = deferred(),
    late = deferred();
  let attempted, policy;
  const f = protocol({
    storage: async (statement, values) => {
      if (statement.startsWith("SELECT v.canonical_document")) {
        entered.resolve();
        await late.promise;
        return policyStorage(statement);
      }
      return readsetStorage(row)(statement, values);
    },
    async prepareUse(context, operation, call, binding) {
      policy = binding.participant.acquireCurrentPolicy(context, operation, call, "policy");
      void policy.catch(() => {});
      await entered.promise;
      attempted = binding.participant.acquireCurrentReadset(
        context,
        operation,
        call,
        { workRef: "work", revision: 1 },
        row.execution,
      );
      await assert.rejects(attempted, ScopeViolationError);
      late.resolve();
      await Promise.allSettled([policy]);
    },
  });
  assert.equal((await f.run()).kind, "not-committed");
  assert.ok(attempted);
  assert.equal(
    f.queries.some((s) => s.includes("FROM occ.repository_work_heads_v2")),
    false,
  );
  assert.equal(f.queries.includes("COMMIT"), false);
});

test("selection retirement joins an already-entered independent observation call before original admission release", async () => {
  const entered = deferred(),
    late = deferred();
  const f = await assignmentProtocol({
    source(source) {
      const originalCall = source.observationCall;
      source.observationCall = async (...args) => {
        entered.resolve();
        await late.promise;
        return originalCall.apply(source, args);
      };
    },
  });
  const handle = await f.acquire(),
    selection = await f.select();
  const observed = f.binding.selection.observationCall(selection);
  await entered.promise;
  const retiring = f.binding.assignments.release(handle);
  let settled = false;
  const releasing = f.binding.selection.release(selection).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.sourceReleases, 0);
  late.resolve();
  assert.equal(await observed, f.observerCall);
  await Promise.all([retiring, releasing]);
  await f.binding.close();
  assert.equal(f.sourceReleases, 1);
});

for (const at of ["source", "unit", "final-fence"]) {
  test(`joinAccepted drains the original ${at} Promise before rollback and dependent cleanup`, async () => {
    const entered = deferred(),
      late = deferred();
    let context,
      armed = false,
      f;
    f = protocol({
      storage: policyStorage,
      acquireWork(c) {
        context = c;
      },
      acquireCustody() {
        if (at === "source") armed = true;
      },
      async prepareUse(c, operation, call, binding) {
        await binding.participant.acquireCurrentPolicy(c, operation, call, "policy");
      },
      current(name) {
        if (name === "work" && armed) {
          armed = false;
          context.joinAccepted(late.promise);
          entered.resolve();
          // The State fence must poison even if a bad source catches its own
          // asynchronous assertion failure and returns undefined afterwards.
          return undefined;
        }
      },
    });
    const run = f.run((unit) => {
      if (at !== "source") armed = true;
      if (at === "unit") unit.assertCurrent();
    });
    await entered.promise;
    await Promise.resolve();
    assert.equal(f.queries.includes("ROLLBACK"), false);
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(
      f.events.some((e) => e[0] === "release" || e[0] === "client-release"),
      false,
    );
    late.resolve();
    assert.equal((await run).kind, "not-committed");
    assert.equal(f.queries.includes("ROLLBACK"), true);
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
    assert.throws(() => context.joinAccepted(Promise.resolve()), ScopeViolationError);
  });
}

test("joinAccepted rejects a copied receiver without executing an arbitrary thenable", async () => {
  let reads = 0,
    attempted = false;
  const f = protocol({
    acquireWork(context) {
      const pending = Promise.resolve();
      assert.throws(() => ({ ...context }).joinAccepted(pending), ScopeViolationError);
      attempted = true;
      assert.throws(
        () =>
          context.joinAccepted({
            get then() {
              reads++;
              return () => {};
            },
          }),
        ScopeViolationError,
      );
    },
  });
  assert.equal((await f.run()).kind, "not-committed");
  assert.equal(attempted, true);
  assert.equal(reads, 0);
  assert.equal(f.queries.includes("COMMIT"), false);
});

// R4 regressions enter the two selection paths omitted by the original generic
// Work-fence cases. Promise settlement must precede original SQL retirement.
function deferredCurrentness() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

for (const assertion of ["source", "retained"]) {
  for (const outcome of ["fulfilled", "rejected"]) {
    test(
      "returned Assignment " + assertion + " assertion " + outcome + " joins before SQL retirement",
      async () => {
        const late = deferredCurrentness();
        let armed = false,
          entered = 0;
        const current = () => {
          if (!armed) return undefined;
          armed = false;
          entered++;
          return late.promise;
        };
        const f = await assignmentProtocol(
          assertion === "source" ? { current } : { retainedCurrent: current },
        );
        const handle = await f.acquire();
        let retiring,
          retired = false;
        try {
          // Acquisition has returned: this call has the consumer's ALS, not the
          // still-held State transaction's execution context.
          armed = true;
          assert.throws(() => f.binding.assignments.assertCurrent(handle), ScopeViolationError);
          assert.equal(entered, 1);
          retiring = f.binding.assignments.release(handle).then(() => {
            retired = true;
          });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(retired, false);
          assert.equal(f.queries.includes("ROLLBACK"), false);
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.equal(
            f.events.some((e) => e[0] === "client-release"),
            false,
          );
          assert.equal(f.sourceEvents.includes("source-lease-release"), false);
          assert.equal(f.sourceReleases, 0);
          if (outcome === "rejected")
            late.reject(new ScopeViolationError("late original assertion"));
          else late.resolve();
          await retiring;
          assert.equal(retired, true);
          assert.equal(f.queries.filter((q) => q === "ROLLBACK").length, 1);
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.equal(f.events.filter((e) => e[0] === "client-release").length, 1);
          assert.equal(f.sourceEvents.filter((e) => e === "source-lease-release").length, 1);
          assert.equal(f.sourceReleases, 1);
          assert.throws(() => f.binding.assignments.assertCurrent(handle), ScopeViolationError);
        } finally {
          late.resolve();
          await f.binding.assignments.release(handle);
          await f.binding.close();
        }
      },
    );
  }
}

for (const outcome of ["fulfilled", "rejected"]) {
  test(
    "first independent observer assertion " +
      outcome +
      " joins its Work transaction after Assignment retirement",
    async () => {
      const late = deferredCurrentness(),
        entered = deferred();
      let assertions = 0,
        originalReceiver;
      const f = await assignmentProtocol({
        source(source) {
          const originalRetain = source.retainObservation;
          source.retainObservation = async function (...args) {
            assert.equal(this, source);
            const held = await originalRetain.apply(this, args);
            originalReceiver = held;
            const check = held.assertCurrent;
            held.assertCurrent = function () {
              assert.equal(this, originalReceiver);
              check.call(this);
              assertions++;
              if (assertions === 1) {
                entered.resolve();
                return late.promise;
              }
              return undefined;
            };
            return held;
          };
        },
      });
      const handle = await f.acquire(),
        selection = await f.select();
      let observing,
        completed = false;
      try {
        await f.binding.assignments.release(handle);
        assert.equal(f.sourceReleases, 0);
        assert.equal(f.queries.filter((q) => q === "ROLLBACK").length, 1);
        assert.equal(await f.binding.selection.observationCall(selection), f.observerCall);
        const queryStart = f.queries.length,
          eventStart = f.events.length;
        observing = f.observe().then((result) => {
          completed = true;
          return result;
        });
        await entered.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(assertions, 1);
        assert.equal(f.observationHeld, 1);
        assert.equal(completed, false);
        assert.equal(f.queries.slice(queryStart).includes("ROLLBACK"), false);
        assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
        assert.equal(
          f.events.slice(eventStart).some((e) => e[0] === "client-release" || e[0] === "release"),
          false,
        );
        assert.equal(f.sourceEvents.includes("observer-release"), false);
        assert.equal(f.sourceReleases, 0);
        if (outcome === "rejected")
          late.reject(new ScopeViolationError("late independent observer"));
        else late.resolve();
        assert.equal((await observing).kind, "not-committed");
        assert.equal(f.queries.slice(queryStart).filter((q) => q === "ROLLBACK").length, 1);
        assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
        assert.equal(f.events.slice(eventStart).filter((e) => e[0] === "client-release").length, 1);
        assert.equal(f.events.slice(eventStart).filter((e) => e[0] === "release").length, 2);
        assert.equal(f.sourceEvents.filter((e) => e === "observer-release").length, 1);
        assert.equal(f.sourceReleases, 0);
      } finally {
        late.resolve();
        if (observing) await observing;
        await f.binding.selection.release(selection);
        await f.binding.close();
      }
      assert.equal(f.sourceReleases, 1);
      assert.equal(f.sourceEvents.filter((e) => e === "source-lease-release").length, 1);
      assert.equal(f.sourceEvents.filter((e) => e === "observer-release").length, 1);
    },
  );
}

// R5 observes the genuine phase close method without substituting its behavior.
// The immediate abort transport release is permitted; phase/custody retirement
// must still wait for the original registered completion.
import { CredentialInventoryOwnerPhaseV1 } from "../../packages/occ/src/ports/platform-unit-of-work.ts";
function observeOriginalPhaseRetirement() {
  const prototype = CredentialInventoryOwnerPhaseV1.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "close");
  const retired = [];
  Object.defineProperty(prototype, "close", {
    ...descriptor,
    value: function (...args) {
      retired.push(this);
      return Reflect.apply(descriptor.value, this, args);
    },
  });
  return {
    retired,
    restore() {
      Object.defineProperty(prototype, "close", descriptor);
    },
  };
}

for (const site of ["completion", "fence"]) {
  for (const outcome of ["fulfilled", "rejected"]) {
    test(
      "Work " +
        site +
        " abort inside currentness joins " +
        outcome +
        " completion before phase retirement",
      async () => {
        const late = deferredCurrentness(),
          entered = deferred(),
          abort = new AbortController();
        let context,
          armed = false,
          bodyCalls = 0;
        const current = () => {
          abort.abort(new Error("original callback cancellation"));
          entered.resolve();
          return late.promise;
        };
        const f = protocol({
          acquireWork(c) {
            context = c;
          },
          acquireCustody() {
            if (site === "fence") armed = true;
          },
          async prepareUse(c) {
            if (site === "completion") c.joinAccepted(current());
          },
          current(name) {
            if (site === "fence" && name === "work" && armed) {
              armed = false;
              context.joinAccepted(current());
            }
          },
        });
        const phase = observeOriginalPhaseRetirement();
        let completed = false;
        const run = f
          .run(() => {
            bodyCalls++;
          }, abort)
          .then((result) => {
            completed = true;
            return result;
          });
        try {
          await entered.promise;
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(abort.signal.aborted, true);
          assert.equal(bodyCalls, 0);
          assert.equal(completed, false);
          assert.equal(phase.retired.length, 0);
          assert.equal(
            f.events.some((e) => e[0] === "release"),
            false,
          );
          assert.deepEqual(
            f.events.filter((e) => e[0] === "client-release"),
            [["client-release", true]],
          );
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.throws(() => context.assertActive());
          if (outcome === "rejected") late.reject(new Error("late original callback rejection"));
          else late.resolve();
          assert.equal((await run).kind, "not-committed");
          assert.equal(phase.retired.length, 1);
          assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
          assert.equal(f.events.filter((e) => e[0] === "client-release").length, 1);
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.throws(() => context.joinAccepted(Promise.resolve()), ScopeViolationError);
        } finally {
          late.resolve();
          await run;
          phase.restore();
        }
      },
    );
  }
}

for (const site of ["acquisition-context", "returned-retained-fence"]) {
  for (const outcome of ["fulfilled", "rejected"]) {
    test(
      "Assignment " +
        site +
        " abort joins " +
        outcome +
        " completion before original phase retirement",
      async () => {
        const lateFailure = new Error("late selected callback rejection");
        let expectedRefusal;
        const late = deferredCurrentness(),
          entered = deferred();
        let f,
          context,
          armed = false,
          handle,
          pending,
          completed = false;
        const current = () => {
          f.abort.abort(new Error("selected callback cancellation"));
          entered.resolve();
          return late.promise;
        };
        f = await assignmentProtocol({
          retainEntered(c) {
            context = c;
            if (site === "acquisition-context") c.joinAccepted(current());
          },
          retainedCurrent() {
            if (site === "returned-retained-fence" && armed) {
              armed = false;
              return current();
            }
            return undefined;
          },
        });
        if (site === "returned-retained-fence") handle = await f.acquire();
        const phase = observeOriginalPhaseRetirement();
        try {
          if (site === "acquisition-context") {
            pending = f.acquire().then(
              (value) => {
                completed = true;
                return value;
              },
              (error) => {
                completed = true;
                throw error;
              },
            );
            void pending.catch(() => {});
          } else {
            armed = true;
            assert.throws(
              () => f.binding.assignments.assertCurrent(handle),
              (error) => {
                expectedRefusal = error;
                return true;
              },
            );
            pending = f.binding.assignments.release(handle).then(() => {
              completed = true;
            });
          }
          await entered.promise;
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(f.abort.signal.aborted, true);
          assert.equal(completed, false);
          assert.equal(phase.retired.length, 0);
          assert.equal(f.sourceReleases, 0);
          assert.equal(f.sourceEvents.includes("source-lease-release"), false);
          assert.deepEqual(
            f.events.filter((e) => e[0] === "client-release"),
            [["client-release", true]],
          );
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.throws(() => context.assertActive());
          if (outcome === "rejected") late.reject(lateFailure);
          else late.resolve();
          if (site === "acquisition-context")
            await assert.rejects(pending, (error) => {
              // The selector preserves its first failure. A late rejection can
              // latch before the acquisition's outward database classification.
              expectedRefusal = outcome === "rejected" ? lateFailure : error;
              return true;
            });
          else await pending;
          assert.equal(phase.retired.length, 1);
          assert.equal(f.sourceReleases, 1);
          assert.equal(
            f.sourceEvents.filter((e) => e === "source-lease-release").length,
            site === "acquisition-context" ? 0 : 1,
          );
          assert.equal(f.events.filter((e) => e[0] === "client-release").length, 1);
          assert.equal(f.queries.includes("COMMIT"), false);
          assert.ok(expectedRefusal instanceof Error);
          assert.throws(
            () => context.joinAccepted(Promise.resolve()),
            (error) => error === expectedRefusal,
          );
        } finally {
          late.resolve();
          if (pending) await Promise.allSettled([pending]);
          if (handle) await f.binding.assignments.release(handle);
          await f.binding.close();
          phase.restore();
        }
      },
    );
  }
}

test("current inventory rejects a cleanup claim beyond the original lease bound", async () => {
  const f = inventoryFixture({ cleanup: true });
  const invalidUntil = new Date(
    Date.parse(f.revocationClaim.claimedAt) +
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs +
      1,
  ).toISOString();
  f.revocationClaim.claimNotAfter = invalidUntil;
  f.record.revocation.claimNotAfter = invalidUntil;
  assert.equal(
    (await f.run((unit) => unit.readRepositoryInventoryCurrent(f.target))).kind,
    "not-committed",
  );
  assert.deepEqual(f.counts(), { sourceCalls: 0, custodyCalls: 0 });
  assert.equal(f.queries.includes("COMMIT"), false);
  assert.equal(f.events.filter((e) => e[0] === "release").length, 2);
});

test("assignment compares the retained child effect target before reading allocation", async () => {
  const f = await assignmentProtocol({
    inspect(data) {
      data.runtime.target = { ...data.runtime.target, createEffectRef: "different-owner-create" };
      return data;
    },
  });
  try {
    await assert.rejects(f.acquire(), ScopeViolationError);
    assert.equal(
      f.queries.some((q) => q.includes("FROM occ.runtime_preparation_operations")),
      true,
    );
    assert.equal(
      f.queries.some((q) => q.includes("FROM occ.runtime_assignment_allocations")),
      false,
    );
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(f.sourceReleases, 1);
    assert.equal(f.sourceEvents.filter((e) => e === "source-lease-release").length, 1);
  } finally {
    await f.binding.close();
  }
});

// R7 preserves the complete original policy association and lets the original
// Work extractor remove only its four common fields. Extra arm data must still
// reach the exact evaluator and refuse before a logical Work read or COMMIT.
for (const wrong of ["wrong-permission", "extra-arm-field"]) {
  test("assignment refuses " + wrong + " after the original policy head read", async () => {
    const f = await assignmentProtocol({
      inspect(data) {
        if (wrong === "wrong-permission")
          data.selection.current.policy.permission = "contents:read";
        else data.selection.current.policy.extraPermission = "contents:read";
        return data;
      },
    });
    await assert.rejects(f.acquire(), ScopeViolationError);
    await f.binding.close();
    assert.ok(f.queries.some((statement) => statement.startsWith("SELECT v.canonical_document")));
    assert.equal(
      f.queries.some((statement) => statement.includes("FROM occ.repository_work_operations_v2")),
      false,
    );
    assert.equal(f.queries.includes("COMMIT"), false);
    assert.equal(f.sourceEvents.filter((event) => event === "source-lease-release").length, 1);
    assert.equal(f.sourceReleases, 1);
  });
}

// R8 controlled original supplier paired to the actual State selection/units.
// These cases exercise enrollment and lifetime; no live native/issue grant is made.
async function dynamicInventoryProtocol(hooks = {}) {
  let raw, inventory, currentPhase, currentInput, prefixMode;
  const issued = new Map();
  const calls = [];
  let inventoryReleases = 0,
    prefixReleases = 0;
  const f = await assignmentProtocol({
    inventory({ data, pairing, admitted, session }) {
      const c = data.selection.current;
      const now = new Date().toISOString();
      const input = {
        schemaVersion: 2,
        method: "reserveRepositoryToken",
        operationRef: "dynamic/reserve",
        scope: {
          installationId: c.original.scope.installationRef,
          namespaceId: c.original.scope.namespaceRef,
          agentId: c.original.scope.agentRef,
        },
        createdAt: now,
        lease: {
          schemaVersion: 2,
          accessLeaseRef: "dynamic/lease",
          target: data.selection.repositoryTarget,
          original: c.original,
          work: c.work,
          execution: c.execution,
          createdAt: now,
          notAfter: c.originalHorizon,
        },
        bindingRef: "dynamic/binding",
        permissionProfile: c.repository.profile,
        requestedPermissions: { metadata: "read" },
        deadline: c.originalHorizon,
      };
      const operation = (value) => {
        const original = { ...c.original, operationRef: value.operationRef };
        issued.set(value.operationRef, original);
        return original;
      };
      const lease = (context, original, value, call, issue) => {
        assert.equal(original, issued.get(value.operationRef));
        if (issue) pairing.assertOriginal(context, admitted, session, call);
        else pairing.assertObservationOriginal(context, admitted, original, call);
        calls.push(issue ? "issue" : "observer");
        return {
          assertCurrent() {
            assert.equal(call.signal.aborted, false);
            return hooks.current?.(context, original, issue);
          },
          async prepareCommit() {},
          async release() {
            prefixReleases++;
            await hooks.releasePrefix?.();
          },
        };
      };
      raw = {
        reservation: { original: operation(input), input },
        async selectOperation(value, call) {
          assert.equal(this, raw);
          assert.equal(call, value.method === "claimRepositoryMint" ? f.call : f.observerCall);
          calls.push("select");
          await hooks.select?.(value);
          return operation(value);
        },
        async retainIssue(context, original, value, call) {
          assert.equal(this, raw);
          return lease(context, original, value, call, true);
        },
        async retainObservation(context, original, value, call) {
          assert.equal(this, raw);
          assert.equal(call, f.observerCall);
          return lease(context, original, value, call, false);
        },
        async observationCall() {
          assert.equal(this, raw);
          return f.observerCall;
        },
        async release() {
          assert.equal(this, raw);
          inventoryReleases++;
        },
      };
      hooks.raw?.(raw);
      return raw;
    },
    async acquireWork(context, original, call) {
      if (!currentPhase) return;
      assert.equal(original, currentPhase);
      await inventory[prefixMode === "issue" ? "retainIssue" : "retainObservation"](
        context,
        original,
        currentInput,
        call,
      );
    },
    async prepareUse(context, original, call, binding, selection) {
      if (prefixMode === "observer") return;
      await binding.selection.retainPolicy(context, selection, original, call);
    },
  });
  const handle = await f.acquire();
  const selection = await f.select();
  inventory = await f.binding.selection.acquireInventory(selection, f.origin, f.call);
  assert.ok(inventory);
  const reservation = inventory.reservation;
  const claim = {
    schemaVersion: 2,
    method: "claimRepositoryMint",
    operationRef: "dynamic/mint",
    scope: reservation.input.scope,
    createdAt: reservation.input.createdAt,
    target: {
      issuanceOperationRef: reservation.input.operationRef,
      recordRef: "dynamic/record",
      intentDigest: repositoryInventoryDigestV2(reservation.input),
    },
    expectedInventoryVersion: 1,
    providerAttemptRef: "dynamic/attempt",
    custodyIdentity: {
      lease: reservation.input.lease,
      key: { clientId: "client", bindingRef: "dynamic/binding", immutableVersion: "key" },
      providerAttemptRef: "dynamic/attempt",
      tokenRef: "dynamic/token",
      protectedRevocationRef: "dynamic/revocation",
    },
  };
  return {
    ...f,
    inventory,
    raw,
    reservation,
    claim,
    handle,
    selection,
    calls,
    get sourceReleases() {
      return f.sourceReleases;
    },
    get inventoryReleases() {
      return inventoryReleases;
    },
    get prefixReleases() {
      return prefixReleases;
    },
    async beginIssue() {
      await f.binding.selection.prepareStateUse(selection, f.origin, f.call);
    },
    runInventory(original, input, mode = "issue", body) {
      currentPhase = original;
      currentInput = input;
      prefixMode = mode;
      const call = mode === "issue" ? f.call : f.observerCall;
      return f.store.run(
        original,
        call,
        { signal: call.signal, timeoutMs: 1000 },
        body ??
          ((unit) =>
            mode === "issue"
              ? unit.readForMutation(
                  f.data.selection.current.work,
                  f.data.selection.current.execution,
                )
              : undefined),
      );
    },
    async closeInventory() {
      await inventory.release();
      await f.binding.assignments.release(handle);
      await f.binding.selection.release(selection);
      await f.binding.close();
    },
  };
}

test("dynamic reservation and mint originals acquire the same State policy/readset through their owned prefix", async () => {
  const f = await dynamicInventoryProtocol();
  try {
    assert.equal(f.inventory.reservation.original, f.raw.reservation.original);
    await f.beginIssue();
    assert.equal(
      (await f.runInventory(f.reservation.original, f.reservation.input)).kind,
      "committed",
    );
    const mint = await f.inventory.selectOperation(f.claim, f.call);
    assert.notEqual(mint, f.reservation.original);
    await f.beginIssue();
    assert.equal((await f.runInventory(mint, f.claim)).kind, "committed");
    assert.deepEqual(f.calls, ["issue", "select", "issue"]);
    assert.equal(f.prefixReleases, 2);
  } finally {
    await f.closeInventory();
  }
  assert.equal(f.inventoryReleases, 1);
  assert.equal(f.sourceReleases, 1);
});

for (const wrong of ["copied-original", "changed-input", "changed-original-digest"]) {
  test("dynamic inventory refuses " + wrong + " before custody use or COMMIT", async () => {
    const f = await dynamicInventoryProtocol();
    try {
      let original = await f.inventory.selectOperation(f.claim, f.call);
      let input = f.claim;
      if (wrong === "copied-original") original = { ...original };
      if (wrong === "changed-input") input = { ...input, expectedInventoryVersion: 2 };
      if (wrong === "changed-original-digest") original.requestDigest = "sha256:" + "9".repeat(64);
      await f.beginIssue();
      const queryStart = f.queries.length;
      assert.equal((await f.runInventory(original, input)).kind, "not-committed");
      assert.equal(f.calls.includes("issue"), false);
      assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
      assert.equal(f.prefixReleases, 0);
    } finally {
      await f.closeInventory();
    }
    assert.equal(f.inventoryReleases, 1);
  });
}

test("an original inventory operation from another private admission cannot enter this State issue context", async () => {
  const a = await dynamicInventoryProtocol();
  const b = await dynamicInventoryProtocol();
  try {
    const crossed = await a.inventory.selectOperation(a.claim, a.call);
    await b.beginIssue();
    assert.equal((await b.runInventory(crossed, b.claim)).kind, "not-committed");
    assert.equal(b.calls.includes("issue"), false);
    assert.equal(b.queries.includes("COMMIT"), false);
  } finally {
    await Promise.all([a.closeInventory(), b.closeInventory()]);
  }
  assert.equal(a.inventoryReleases, 1);
  assert.equal(b.inventoryReleases, 1);
});

test("inventory observation cannot supply live policy even for an originally issued reservation", async () => {
  const f = await dynamicInventoryProtocol();
  try {
    await f.beginIssue();
    const queryStart = f.queries.length;
    let bodyEntered = false;
    const result = await f.runInventory(
      f.reservation.original,
      f.reservation.input,
      "observer-policy",
      () => {
        bodyEntered = true;
      },
    );
    assert.equal(result.kind, "not-committed");
    assert.equal(bodyEntered, false);
    assert.equal(f.calls.includes("observer"), true);
    assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
    assert.equal(f.calls.includes("issue"), false);
  } finally {
    await f.closeInventory();
  }
});

test("closed inventory refuses new enrollment without entering its original source again", async () => {
  const f = await dynamicInventoryProtocol();
  await f.inventory.release();
  const before = f.calls.length;
  await assert.rejects(f.inventory.selectOperation(f.claim, f.call), ScopeViolationError);
  assert.equal(f.calls.length, before);
  await f.closeInventory();
  assert.equal(f.inventoryReleases, 1);
});

for (const outcome of ["fulfilled", "rejected"]) {
  test(
    "dynamic original prefix joins " + outcome + " assertion before State rollback and cleanup",
    async () => {
      const entered = deferred();
      const late = deferredCurrentness();
      let armed = true;
      const f = await dynamicInventoryProtocol({
        current() {
          if (!armed) return undefined;
          armed = false;
          entered.resolve();
          return late.promise;
        },
      });
      let pending;
      try {
        await f.beginIssue();
        const queryStart = f.queries.length;
        pending = f.runInventory(f.reservation.original, f.reservation.input);
        await entered.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.prefixReleases, 0);
        assert.equal(f.inventoryReleases, 0);
        assert.equal(f.queries.slice(queryStart).includes("ROLLBACK"), false);
        assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
        if (outcome === "rejected") late.reject(new Error("original inventory assertion"));
        else late.resolve();
        assert.equal((await pending).kind, "not-committed");
        assert.equal(f.prefixReleases, 1);
        assert.equal(f.queries.slice(queryStart).includes("COMMIT"), false);
      } finally {
        late.resolve();
        if (pending) await pending;
        await f.closeInventory();
      }
      assert.equal(f.inventoryReleases, 1);
      assert.equal(f.sourceReleases, 1);
    },
  );
}

test("original inventory cleanup is captured before a later reservation getter fails", async () => {
  let releases = 0;
  const f = await assignmentProtocol({
    inventory() {
      return {
        async release() {
          releases++;
        },
        get reservation() {
          throw new ScopeViolationError("malformed inventory reservation");
        },
      };
    },
  });
  const handle = await f.acquire();
  const selection = await f.select();
  try {
    await assert.rejects(
      f.binding.selection.acquireInventory(selection, f.origin, f.call),
      ScopeViolationError,
    );
    assert.equal(releases, 1);
    assert.equal(f.queries.includes("COMMIT"), false);
  } finally {
    await f.binding.assignments.release(handle);
    await f.binding.selection.release(selection);
    await f.binding.close();
  }
  assert.equal(releases, 1);
  assert.equal(f.sourceReleases, 1);
});

test("every retained dispatch recovers after closure before the distinct observation original is enrolled", async () => {
  const observed = [];
  let recovering = false;
  const f = await assignmentProtocol({
    source(source) {
      const retain = source.retainObservation;
      source.retainObservation = async function (...args) {
        observed.push(args[2]);
        return retain.apply(this, args);
      };
    },
    prepareUse(context, original, call, binding, selection) {
      return binding.selection.retainObservation(context, selection, original, call);
    },
    storage(statement, _values, { data }) {
      if (recovering && statement.includes("FROM occ.repository_work_operations_v2")) {
        const original = data.selection.current.original;
        return {
          rows: [
            {
              canonical_document: canon({
                ...original,
                scope: {
                  installationId: original.scope.installationRef,
                  namespaceId: original.scope.namespaceRef,
                  agentId: original.scope.agentRef,
                  revisionRef: original.scope.revisionRef,
                },
                commitRef: "dispatch/known-outer-commit",
                kind: "dispatch",
                document: { releaseRef: "retained/release" },
              }),
            },
          ],
          rowCount: 1,
        };
      }
    },
  });
  const handle = await f.acquire(),
    selection = await f.select();
  try {
    await f.binding.assignments.release(handle);
    f.nativeLifetime.abort();
    recovering = true;
    const dispatch = f.data.selection.current.original;
    const recovered = await f.store.recoverAfterUnwind(dispatch, f.observerCall, {
      signal: f.observerCall.signal,
      timeoutMs: 1000,
    });
    assert.equal(recovered.kind, "recorded");
    assert.equal(recovered.operation.operationRef, dispatch.operationRef);
    assert.equal((await f.observe()).kind, "committed");
    assert.deepEqual(observed, [dispatch, f.data.selection.observation]);
    assert.equal(f.sourceEvents.filter((event) => event === "observer-release").length, 2);
    assert.equal(f.sourceReleases, 0);
  } finally {
    await f.binding.selection.release(selection);
    await f.binding.close();
  }
  assert.equal(f.sourceReleases, 1);
});

test("historical recovery rejects a preparation original or a copied dispatch original", async () => {
  for (const wrong of ["preparation", "copied-dispatch"]) {
    const f = await assignmentProtocol({
      prepareUse(context, original, call, binding, selection) {
        return binding.selection.retainObservation(context, selection, original, call);
      },
    });
    const handle = await f.acquire(),
      selection = await f.select();
    try {
      await f.binding.assignments.release(handle);
      const original =
        wrong === "preparation"
          ? f.data.selection.preparation
          : { ...f.data.selection.current.original };
      const start = f.queries.length;
      const result = await f.store.run(
        original,
        f.observerCall,
        { signal: f.observerCall.signal, timeoutMs: 1000 },
        () => undefined,
      );
      assert.equal(result.kind, "not-committed");
      assert.equal(f.observationHeld, 0);
      assert.equal(f.queries.slice(start).includes("COMMIT"), false);
    } finally {
      await f.binding.selection.release(selection);
      await f.binding.close();
    }
  }
});
