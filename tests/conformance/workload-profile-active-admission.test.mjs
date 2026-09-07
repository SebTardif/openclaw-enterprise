import assert from "node:assert/strict";
import test from "node:test";
import { createWorkloadProfileAdmissionRepositoryV2 } from "../../packages/occ/src/services/workload-profile/acceptance.ts";
import {
  createWorkloadProfileAdmittedHeadV2,
  decodeWorkloadProfileAdmissionHeadV2,
  decodeWorkloadProfileAdmissionHistoryV2,
  workloadProfileAdmissionHistoryV2,
} from "../../packages/occ/src/workload-profiles/admission-record.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import {
  PROFILE_ALLOCATION_KINDS,
  createProfilePreparationV2,
  normalizeProfilePreparationV2,
  profileOperationKey,
} from "../../packages/occ/src/workload-profiles/types.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";

// Actual Runtime codecs/repository/guard, with controlled storage and definition
// completion. This is not production account/IAM/capability, SQL locking, outbox
// delivery, resource measurement, or transaction-COMMIT qualification.
const copy = structuredClone;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (n) => `sha256:${n.repeat(64)}`;
const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
const preparedAt = "2026-09-07T08:00:00.000Z";
const acceptedAt = "2026-09-07T08:01:00.000Z";
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
// The same maintained pair fixture vocabulary as admitted-selection coverage;
// importing a test entry would launch unrelated cases, so only data is repeated.
function manifest() {
  const accounting = envelope();
  for (const component of ["gateway", "harness"])
    accounting.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: ref(`${name}-environment`),
    runtimeClass: "selected-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: [
      {
        name: `${name}-state`,
        path: `/state/${name}`,
        store: ref(`${name}-store`),
        access: "read-write",
      },
    ],
  });
  return {
    schemaVersion: 2,
    target: {
      component: "gateway-harness-pair",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      placement: "dedicated",
      fallback: "none",
      subject: "installation-namespace-agent",
    },
    profileRefs: workloadProfileManifestFixture().profileRefs,
    artifactSet: { gateway: image("gateway"), harness: image("harness") },
    launchConfiguration: {
      gateway: process("gateway"),
      harness: process("harness"),
      modules: ["identity", "channel", "harness", "persistence"].map((kind) => ({
        id: kind,
        kind,
        definition: ref(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: ref("cluster"), namespaceAllocation: ref("allocation") },
      runtime: { implementation: ref("runsc"), handler: "selected-runsc", platform: "systrap" },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope: accounting } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: ref("materials"),
        pathCustody: ref("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: ref("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: ref("identity"),
      modelMediator: ref("mediator"),
      repositoryIssuer: ref("issuer"),
      harnessTransport: ref("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: ref(id),
      })),
    },
  };
}

function fixture() {
  const installationId = `ins_${uuid(9000)}`;
  const namespaceId = `ns_${uuid(9001)}`;
  const actor = { accountRef: "controlled/account", principalRef: "controlled/principal" };
  const trace = [];
  let id = 1;
  let clockReads = 0;
  let snapshot = {
    preparations: new Map(),
    heads: new Map(),
    history: new Map(),
    primary: new Map(),
    audits: new Map(),
    invalidations: new Map(),
    capacity: { ordinaryOperations: 0, pendingOrdinaryOperations: 0, terminalSlots: 0 },
  };
  const locator = (record, acting = actor) => ({
    installationId,
    actor: acting,
    operationRef: record.operationRef,
  });
  const attribution = (operationRef, acting = actor) => ({
    actor: acting,
    operationRef,
    requestRef: "request/original",
    decisionRef: "decision/original",
  });
  const headKey = (ns, admission) => `${ns}/${admission}`;
  const prepare = (expected = null) => {
    const derived = deriveWorkloadProfileManifestV2(
      new TextEncoder().encode(JSON.stringify(manifest())),
    );
    const request = {
      schemaVersion: 2,
      component: "gateway-harness-pair",
      namespaceId,
      operationRef: uuid(id++),
      action: expected === null ? "admit" : "replace",
      expectedAdmission: expected,
      manifest: {
        format: "oce.workload-profile.canonical-json.v1",
        canonicalUtf8: new TextDecoder().decode(derived.canonicalBytes),
        manifestDigest: derived.digests.manifestDigest,
      },
    };
    const allocated = Object.fromEntries(PROFILE_ALLOCATION_KINDS.map((key) => [key, uuid(id++)]));
    const record = createProfilePreparationV2(
      installationId,
      actor,
      normalizeProfilePreparationV2(request),
      allocated,
      preparedAt,
    );
    snapshot.preparations.set(profileOperationKey(locator(record)), copy(record));
    snapshot.capacity.ordinaryOperations++;
    snapshot.capacity.pendingOrdinaryOperations++;
    return record;
  };
  const transact = async (work, overrides = {}) => {
    const working = copy(snapshot);
    const guard = new WorkloadProfileTransactionGuard();
    const backend = {
      installationId: () => installationId,
      lockCapacity: async () => {
        trace.push("capacity-lock");
      },
      capacity: async () => {
        trace.push("capacity-read");
        return copy(working.capacity);
      },
      lockOperation: async () => {
        trace.push("operation-lock");
      },
      namespaceExists: async (ns) => {
        trace.push("namespace");
        return ns === namespaceId;
      },
      operation: async (loc) => {
        trace.push("preparation-read");
        return copy(working.preparations.get(profileOperationKey(loc)));
      },
      acceptedOperation: async (loc) => {
        trace.push("history-read");
        return copy(working.primary.get(profileOperationKey(loc)));
      },
      lockHeads: async (ns, refs, mode) => {
        trace.push(`heads:${mode}:${refs.join(",")}`);
        assert.deepEqual(refs, [...refs].sort());
        assert.equal(ns, namespaceId);
      },
      head: async (ns, admission) => {
        trace.push("head-read");
        return copy(working.heads.get(headKey(ns, admission)));
      },
      insertAdmission: async (head, history) => {
        trace.push("insert-admission");
        const key = headKey(head.scope.namespaceId, head.selection.admissionRef);
        assert.equal(working.heads.has(key), false);
        working.heads.set(key, copy(head));
        working.history.set(history.historyRef, copy(history));
        working.primary.set(
          profileOperationKey({
            installationId,
            actor: head.acceptance.actor,
            operationRef: head.acceptance.operationRef,
          }),
          copy(history),
        );
      },
      withdrawAdmission: async (expected, head, history, invalidation) => {
        trace.push("withdraw-admission");
        const key = headKey(head.scope.namespaceId, head.selection.admissionRef);
        assert.deepEqual(working.heads.get(key), copy(expected));
        working.heads.set(key, copy(head));
        working.history.set(history.historyRef, copy(history));
        working.invalidations.set(invalidation.requestRef, copy(invalidation));
        // The primary replacing result is its new admission. The old terminal
        // history stays in history without shadowing that command's result.
        if (head.withdrawal.reason === "withdrawn")
          working.primary.set(
            profileOperationKey({
              installationId,
              actor: head.withdrawal.actor,
              operationRef: head.withdrawal.operationRef,
            }),
            copy(history),
          );
      },
      updateCapacity: async (expected, next) => {
        trace.push("capacity-update");
        assert.deepEqual(working.capacity, copy(expected));
        working.capacity = copy(next);
      },
      appendAudit: async (attributed, history) => {
        trace.push("audit");
        const head = history.head;
        const ref = head.state === "admitted" ? head.acceptance.auditRef : head.terminal.auditRef;
        assert.equal(working.audits.has(ref), false);
        working.audits.set(ref, copy({ attributed, historyRef: history.historyRef }));
      },
      ...overrides,
    };
    const repository = createWorkloadProfileAdmissionRepositoryV2(backend, guard, () => {
      clockReads++;
      return acceptedAt;
    });
    try {
      const value = await work(repository, guard);
      await guard.finish();
      snapshot = working;
      return value;
    } catch (error) {
      try {
        await guard.finish();
      } catch {
        /* original failure remains primary */
      }
      throw error;
    }
  };
  return {
    installationId,
    namespaceId,
    actor,
    trace,
    locator,
    attribution,
    prepare,
    transact,
    nextOperation: () => uuid(id++),
    qualify: async (request) => {
      trace.push("definition");
      assert.equal(request.scope.installationId, installationId);
      assert.equal(request.scope.namespaceId, namespaceId);
      assert.equal(request.selection.manifestDigest, request.manifest.digests.manifestDigest);
      assert.equal(Object.hasOwn(request, "use"), false);
      assert.equal(Object.hasOwn(request, "revision"), false);
      assert.equal(Object.hasOwn(request, "admittedConfigurationDigest"), false);
      return undefined;
    },
    get snapshot() {
      return copy(snapshot);
    },
    get clockReads() {
      return clockReads;
    },
    corrupt(work) {
      work(snapshot);
    },
  };
}
async function admitted(f) {
  const prepared = f.prepare();
  const result = await f.transact((repo) =>
    repo.accept(f.locator(prepared), f.attribution(prepared.operationRef), f.qualify),
  );
  return { prepared, result, head: result.history.head };
}

test("fresh acceptance uses actual retained preparation and original capacity/head sequence", async () => {
  const f = fixture();
  const { prepared, result, head } = await admitted(f);
  assert.equal(result.action, "admit");
  assert.equal(head.state, "admitted");
  assert.equal(head.selection.admissionRef, prepared.allocated.admissionRef);
  assert.equal(head.acceptance.historyRef, prepared.allocated.historyRef);
  assert.equal(head.terminal.invalidationRef, prepared.allocated.terminalInvalidationRef);
  assert.equal(Object.hasOwn(head, "use"), false);
  assert.equal(Object.hasOwn(head, "admittedConfigurationDigest"), false);
  assert.deepEqual(f.snapshot.capacity, {
    ordinaryOperations: 1,
    pendingOrdinaryOperations: 0,
    terminalSlots: 1,
  });
  assert.equal(f.snapshot.audits.size, 1);
  assert.equal(f.snapshot.history.size, 1);
  const order = [
    "capacity-lock",
    "operation-lock",
    "namespace",
    `heads:update:${head.selection.admissionRef}`,
    "definition",
    "insert-admission",
    "audit",
    "capacity-update",
  ];
  const positions = order.map((name) => f.trace.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
});

test("accept replay returns immutable original action/history without fresh capability or time", async () => {
  const f = fixture();
  const { prepared, result } = await admitted(f);
  const before = f.snapshot;
  const clock = f.clockReads;
  f.trace.length = 0;
  const replay = await f.transact((repo) =>
    repo.accept(f.locator(prepared), {
      ...f.attribution(prepared.operationRef),
      requestRef: "fresh/readback",
      decisionRef: "fresh/decision",
    }),
  );
  assert.deepEqual(replay, result);
  assert.deepEqual(f.snapshot, before);
  assert.equal(f.clockReads, clock);
  assert.equal(f.trace.includes("namespace"), false);
  assert.equal(
    f.trace.some((name) => name.startsWith("heads:")),
    false,
  );
  assert.equal(f.trace.includes("definition"), false);
});

test("replacement atomically withdraws old head and creates distinct new primary history", async () => {
  const f = fixture();
  const { head: old } = await admitted(f);
  const prepared = f.prepare(old.selection);
  const result = await f.transact((repo) =>
    repo.accept(f.locator(prepared), f.attribution(prepared.operationRef), f.qualify),
  );
  assert.equal(result.action, "replace");
  const retainedOld = f.snapshot.heads.get(`${f.namespaceId}/${old.selection.admissionRef}`);
  assert.equal(retainedOld.state, "withdrawn");
  assert.equal(retainedOld.withdrawal.reason, "replaced");
  assert.equal(retainedOld.selection.admissionVersion, 2);
  assert.equal(result.history.head.state, "admitted");
  assert.notEqual(result.history.head.selection.admissionRef, old.selection.admissionRef);
  assert.deepEqual(f.snapshot.capacity, {
    ordinaryOperations: 3,
    pendingOrdinaryOperations: 0,
    terminalSlots: 1,
  });
  assert.equal(f.snapshot.history.size, 3);
  assert.equal(f.snapshot.audits.size, 3);
  const invalidation = f.snapshot.invalidations.get(old.terminal.invalidationRef);
  assert.equal(invalidation.namespaceId, f.namespaceId);
  assert.equal(invalidation.installationId, f.installationId);
  assert.equal(invalidation.component, "gateway-harness-pair");
  assert.equal(Object.hasOwn(invalidation, "scope"), false);
  assert.equal(invalidation.previousVersion, 1);
  assert.equal(invalidation.currentVersion, 2);
  const replay = await f.transact((repo) =>
    repo.accept(f.locator(prepared), f.attribution(prepared.operationRef)),
  );
  assert.deepEqual(replay, result);
});

test("withdraw uses reserved terminal capacity even with 32 unrelated pending preparations", async () => {
  const f = fixture();
  const { head } = await admitted(f);
  for (let i = 0; i < 32; i++) f.prepare();
  const operation = f.nextOperation();
  const result = await f.transact((repo) =>
    repo.withdraw(f.namespaceId, head.selection, f.attribution(operation)),
  );
  assert.equal(result.head.state, "withdrawn");
  assert.equal(result.historyRef, head.terminal.historyRef);
  assert.deepEqual(f.snapshot.capacity, {
    ordinaryOperations: 34,
    pendingOrdinaryOperations: 32,
    terminalSlots: 0,
  });
  assert.equal(f.snapshot.invalidations.size, 1);
  const before = f.snapshot;
  f.trace.length = 0;
  const replay = await f.transact((repo) =>
    repo.withdraw(f.namespaceId, head.selection, f.attribution(operation)),
  );
  assert.deepEqual(replay, result);
  assert.deepEqual(f.snapshot, before);
  assert.equal(
    f.trace.some((entry) => entry.startsWith("heads:")),
    false,
  );
});

test("original accept history is still replayable after terminal withdrawal", async () => {
  const f = fixture();
  const { prepared, result, head } = await admitted(f);
  await f.transact((repo) =>
    repo.withdraw(f.namespaceId, head.selection, f.attribution(f.nextOperation())),
  );
  f.trace.length = 0;
  assert.deepEqual(
    await f.transact((repo) =>
      repo.accept(f.locator(prepared), f.attribution(prepared.operationRef)),
    ),
    result,
  );
  assert.equal(
    f.trace.some((entry) => entry.startsWith("heads:")),
    false,
  );
});

for (const mode of ["missing-source", "foreign-actor", "foreign-installation", "damaged-operation"])
  test(`fresh ${mode} cannot produce an active admission`, async () => {
    const f = fixture();
    const prepared = f.prepare();
    const locator = f.locator(prepared);
    const attributed = f.attribution(prepared.operationRef);
    if (mode === "foreign-actor")
      locator.actor = attributed.actor = { ...f.actor, accountRef: "foreign" };
    if (mode === "foreign-installation") locator.installationId = `ins_${uuid(9990)}`;
    if (mode === "damaged-operation")
      f.corrupt((state) => {
        state.preparations.get(profileOperationKey(locator)).operationDigest = digest("0");
      });
    const before = f.snapshot;
    await assert.rejects(
      f.transact((repo) =>
        repo.accept(locator, attributed, mode === "missing-source" ? undefined : f.qualify),
      ),
    );
    assert.deepEqual(f.snapshot, before);
    assert.equal(f.trace.includes("insert-admission"), false);
  });

for (const mode of [
  "stale-replace",
  "withdrawn-replace",
  "stale-withdraw",
  "pending-operation",
  "foreign-withdraw-actor",
])
  test(`${mode} conflicts without rewriting terminal history or capacity`, async () => {
    const f = fixture();
    const { head } = await admitted(f);
    let prepared;
    let operation = f.nextOperation();
    let expected = head.selection;
    if (mode === "stale-replace") prepared = f.prepare({ ...head.selection, admissionVersion: 2 });
    if (mode === "withdrawn-replace") {
      await f.transact((repo) =>
        repo.withdraw(f.namespaceId, head.selection, f.attribution(operation)),
      );
      prepared = f.prepare(head.selection);
    }
    if (mode === "stale-withdraw") expected = { ...head.selection, admissionVersion: 2 };
    if (mode === "pending-operation") operation = f.prepare().operationRef;
    if (mode === "foreign-withdraw-actor")
      await f.transact((repo) =>
        repo.withdraw(f.namespaceId, head.selection, f.attribution(operation)),
      );
    const before = f.snapshot;
    await assert.rejects(
      f.transact((repo) =>
        prepared
          ? repo.accept(f.locator(prepared), f.attribution(prepared.operationRef), f.qualify)
          : repo.withdraw(
              f.namespaceId,
              expected,
              f.attribution(
                operation,
                mode === "foreign-withdraw-actor"
                  ? { accountRef: "different", principalRef: f.actor.principalRef }
                  : f.actor,
              ),
            ),
      ),
    );
    assert.deepEqual(f.snapshot, before);
  });

for (const failure of [new Error("original failure"), undefined])
  test(`caught qualifier rejection stays rollback-only (${failure === undefined ? "undefined" : "Error"})`, async () => {
    const f = fixture();
    const prepared = f.prepare();
    const before = f.snapshot;
    await assert.rejects(
      f.transact(async (repo) => {
        await repo
          .accept(f.locator(prepared), f.attribution(prepared.operationRef), async () => {
            throw failure;
          })
          .catch(() => {});
      }),
      (reason) => reason === failure,
    );
    assert.deepEqual(f.snapshot, before);
  });

test("non-undefined definition completion is rejected rather than interpreted as a permit", async () => {
  const f = fixture();
  const prepared = f.prepare();
  await assert.rejects(
    f.transact((repo) =>
      repo.accept(f.locator(prepared), f.attribution(prepared.operationRef), async () => true),
    ),
  );
  assert.equal(f.snapshot.heads.size, 0);
});

for (const mode of ["accept-audit", "replace-audit", "withdraw-audit", "capacity-write"])
  test(`${mode} failure rolls back complete controlled working state even when caught`, async () => {
    const f = fixture();
    let old;
    if (mode === "replace-audit" || mode === "withdraw-audit") old = (await admitted(f)).head;
    const prepared = mode === "withdraw-audit" ? undefined : f.prepare(old?.selection ?? null);
    const failure = new Error(mode);
    const before = f.snapshot;
    const override =
      mode === "capacity-write"
        ? {
            updateCapacity: async () => {
              throw failure;
            },
          }
        : {
            appendAudit: async () => {
              throw failure;
            },
          };
    await assert.rejects(
      f.transact(async (repo) => {
        const operation = prepared
          ? repo.accept(f.locator(prepared), f.attribution(prepared.operationRef), f.qualify)
          : repo.withdraw(f.namespaceId, old.selection, f.attribution(f.nextOperation()));
        await operation.catch(() => {});
      }, override),
      (reason) => reason === failure,
    );
    assert.deepEqual(f.snapshot, before);
  });

test("ignored accepted work is drained and its failure prevents snapshot publication", async () => {
  const f = fixture();
  const prepared = f.prepare();
  const gate = deferred();
  const reached = deferred();
  const failure = new Error("late definition rejection");
  let finished = false;
  const command = f
    .transact(async (repo) => {
      void repo
        .accept(f.locator(prepared), f.attribution(prepared.operationRef), async () => {
          reached.resolve();
          await gate.promise;
          throw failure;
        })
        .catch(() => {});
    })
    .finally(() => {
      finished = true;
    });
  const rejection = assert.rejects(command, (reason) => reason === failure);
  await reached.promise;
  assert.equal(finished, false);
  assert.equal(f.snapshot.heads.size, 0);
  gate.resolve();
  await rejection;
  assert.equal(f.snapshot.heads.size, 0);
});

test("data is captured before queued admission and malformed accessor failure poisons guard", async () => {
  const f = fixture();
  const prepared = f.prepare();
  const loc = copy(f.locator(prepared));
  const attributed = copy(f.attribution(prepared.operationRef));
  await f.transact((repo) => {
    const pending = repo.accept(loc, attributed, f.qualify);
    loc.actor.accountRef = "changed-after-call";
    attributed.requestRef = "changed-after-call";
    return pending;
  });
  let calls = 0;
  const malformed = { ...f.attribution(f.nextOperation()) };
  Object.defineProperty(malformed, "requestRef", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("getter invoked");
    },
  });
  await assert.rejects(
    f.transact(async (repo) => {
      await repo
        .withdraw(f.namespaceId, f.snapshot.heads.values().next().value.selection, malformed)
        .catch(() => {});
    }),
  );
  assert.equal(calls, 0);
});

test("head SHARE read and conflicting UPDATE mutation honor the backend wait before effect", async () => {
  const f = fixture();
  const { head } = await admitted(f);
  f.trace.length = 0;
  await f.transact((repo) => repo.readProfile(f.namespaceId, head.selection.admissionRef));
  assert.ok(
    f.trace.indexOf("namespace") < f.trace.indexOf(`heads:share:${head.selection.admissionRef}`),
  );
  const gate = deferred();
  const reached = deferred();
  f.trace.length = 0;
  const command = f.transact(
    (repo) => repo.withdraw(f.namespaceId, head.selection, f.attribution(f.nextOperation())),
    {
      lockHeads: async (ns, refs, mode) => {
        assert.equal(mode, "update");
        assert.equal(ns, f.namespaceId);
        assert.deepEqual(refs, [head.selection.admissionRef]);
        reached.resolve();
        await gate.promise;
      },
    },
  );
  await reached.promise;
  assert.equal(f.trace.includes("withdraw-admission"), false);
  assert.equal(f.snapshot.heads.values().next().value.state, "admitted");
  gate.resolve();
  await command;
  assert.equal(f.snapshot.heads.values().next().value.state, "withdrawn");
});

test("escaped repository cannot read or mutate after original guard completion", async () => {
  const f = fixture();
  const { head } = await admitted(f);
  let escaped;
  await f.transact(async (repo) => {
    escaped = repo;
  });
  await assert.rejects(escaped.readProfile(f.namespaceId, head.selection.admissionRef));
  await assert.rejects(
    escaped.withdraw(f.namespaceId, head.selection, f.attribution(f.nextOperation())),
  );
});

for (const [name, change] of [
  [
    "extra-use",
    (head) => {
      head.use = {};
    },
  ],
  [
    "global-H",
    (head) => {
      head.admittedConfigurationDigest = digest("1");
    },
  ],
  [
    "foreign-component",
    (head) => {
      head.scope.component = "harness";
    },
  ],
  [
    "role-version",
    (head) => {
      head.profileRefs.runtime.version = 0;
    },
  ],
  [
    "role-digest",
    (head) => {
      head.profileRefs.runtime.contentDigest = digest("0");
    },
  ],
  [
    "duplicate-reserved-ID",
    (head) => {
      head.terminal.auditRef = head.acceptance.auditRef;
    },
  ],
  [
    "head-version",
    (head) => {
      head.selection.admissionVersion = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "canonical-manifest",
    (head) => {
      head.canonicalManifest += " ";
    },
  ],
])
  test(`closed head codec rejects ${name}`, () => {
    const f = fixture();
    const prepared = f.prepare();
    const head = copy(
      createWorkloadProfileAdmittedHeadV2(
        prepared,
        f.attribution(prepared.operationRef),
        acceptedAt,
      ),
    );
    change(head);
    assert.throws(() => decodeWorkloadProfileAdmissionHeadV2(head));
  });

test("closed history codec detaches complete roles/attribution and rejects foreign history ref", () => {
  const f = fixture();
  const prepared = f.prepare();
  const original = copy(
    workloadProfileAdmissionHistoryV2(
      createWorkloadProfileAdmittedHeadV2(
        prepared,
        f.attribution(prepared.operationRef),
        acceptedAt,
      ),
    ),
  );
  const decoded = decodeWorkloadProfileAdmissionHistoryV2(original);
  original.head.profileRefs.runtime.ref = uuid(8888);
  original.head.acceptance.actor.accountRef = "changed";
  assert.equal(decoded.head.profileRefs.runtime.ref, prepared.allocated.runtimeRef);
  assert.equal(decoded.head.acceptance.actor.accountRef, f.actor.accountRef);
  assert.ok(Object.isFrozen(decoded.head.profileRefs.runtime));
  assert.ok(Object.isFrozen(decoded.head.acceptance.actor));
  assert.throws(() =>
    decodeWorkloadProfileAdmissionHistoryV2({ ...decoded, historyRef: uuid(8889) }),
  );
});
