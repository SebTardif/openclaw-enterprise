import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createDeploymentCandidateNormalizerV2 } from "../../packages/occ/src/services/deployment/candidate-normalization.ts";
import { makeTrackedCandidateOperations } from "../../packages/occ/src/state/postgres/workload-profile-candidate.ts";
import { createWorkloadProfileUseResolverV2 } from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import {
  workloadProfileAdmissionFixture,
  profileAcceptedAt,
} from "../fixtures/workload-profile-admission-v2.mjs";

// Real original state/repositories, DriverSelection, native IAM, normalizer and
// owner protocol. SQL replies, account authorization and Driver implementations
// are controlled. This does not qualify PostgreSQL locks or native/store/role
// producers. A supplied Use below is explicitly controlled storage data.
const copy = structuredClone;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const noop = async () => {};
function protocol(options = {}) {
  const profile = workloadProfileAdmissionFixture();
  const agentId = `agt_${randomUUID()}`,
    configurationId = `cfg_${randomUUID()}`;
  const serviceAccountId = options.missingAccount ? null : `sa_${randomUUID()}`;
  const revisionId = `rev_${randomUUID()}`;
  const trace = [],
    sql = [],
    held = [];
  const principal = {
    id: profile.actor.principalRef,
    kind: "principal",
    issuer: "controlled",
    subject: "account",
  };
  const secretIds = [`sec_${randomUUID()}`, `sec_${randomUUID()}`];
  const bindings = options.secrets
    ? Object.fromEntries(
        [
          ["EXTERNAL_B", 1],
          ["EXTERNAL_A", 0],
          ["EXTERNAL_B_AGAIN", 1],
        ].map(([key, index]) => [
          key,
          {
            source: { kind: "secret", namespaceId: profile.namespaceId, id: secretIds[index] },
            delivery: { type: "env" },
          },
        ]),
      )
    : {};
  const secretRows = secretIds.map((id, index) => ({
    id,
    namespace_id: profile.namespaceId,
    name: `source-${index}`,
    driver_id: "controlled-secret",
    backend_namespace_name: "controlled",
    backend_name: `source-${index}`,
    backend_key: "value",
    backend_uid: `uid-${index}`,
    created_at: profileAcceptedAt,
  }));
  const credential = { kind: "api_key", secretRef: { name: "credential", key: "value" } };
  const metadata = {
    id: configurationId,
    namespaceId: profile.namespaceId,
    kind: "agent",
    generation: 1,
    createdAt: profileAcceptedAt,
    ...(options.secrets ? { secretBindings: bindings } : {}),
  };
  const configurationDocument = {
    ...metadata,
    values: {
      agents: { defaults: { model: "codex/gpt-test" } },
      models: { providers: { codex: { agentRuntime: { id: "codex" } } } },
    },
  };
  const agentRow = {
    id: agentId,
    namespace_id: profile.namespaceId,
    name: "controlled-agent",
    configuration_id: configurationId,
    provider_id: null,
    execution_mode: "dedicated",
    service_principal_id: "controlled/service-principal",
    service_account_id: serviceAccountId,
    workload_profile_selection: profile.head.selection,
    created_at: profileAcceptedAt,
  };
  const command = {
    schemaVersion: 2,
    operationRef: randomUUID(),
    expectedLifecycleGeneration: null,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId,
      configurationGeneration: 1,
      providerId: null,
      executionMode: "dedicated",
      serviceAccountId,
      workloadProfileSelection: profile.head.selection,
    },
  };
  const binding = [principal.id, { namespaceId: profile.namespaceId, agentId, command }];
  const request = {
    schemaVersion: 2,
    installationId: profile.installationId,
    namespaceId: profile.namespaceId,
    agentId,
    revisionId,
    configurationRef: configurationId,
    configurationVersion: 1,
    selection: profile.head.selection,
  };
  let inserts = 0,
    connects = 0,
    savedRow,
    actualUnit,
    actualIO,
    capturedOperations;
  const response = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  const client = {
    on() {},
    removeListener() {},
    release() {
      trace.push("release-client");
    },
    async query(statement, parameters = []) {
      sql.push({ statement, parameters: copy(parameters) });
      if (statement === "COMMIT") {
        for (const lease of held) lease.assertCurrent(); // Acquisition IO has closed; owner is still live.
        options.atCommit?.();
        trace.push("COMMIT");
        return response([], "COMMIT");
      }
      if (statement === "ROLLBACK") {
        trace.push("ROLLBACK");
        return response([], "ROLLBACK");
      }
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET ") ||
        statement.startsWith("SELECT set_config")
      )
        return response();
      if (statement.includes("FROM occ.installation "))
        return response([
          { id: profile.installationId, name: "Controlled", created_at: profileAcceptedAt },
        ]);
      if (statement.includes("lock_workload_profile_iam")) {
        trace.push("policy");
        return response();
      }
      if (statement.includes("FROM occ.iam_identities ")) return response([principal]);
      if (statement.includes("FROM occ.iam_roles "))
        return response([
          {
            id: "controlled-role",
            permissions: ["agent", "configuration", "service_account", "secret"].flatMap(
              (resourceKind) =>
                ["read", "deploy", "operate"].map((action) => ({ action, resourceKind })),
            ),
          },
        ]);
      if (statement.includes("FROM occ.iam_access_bindings "))
        return response([
          { id: "binding", identity_subject_id: principal.id, role_id: "controlled-role" },
        ]);
      if (statement.includes("FROM occ.iam_")) return response();
      if (statement.includes("FROM occ.namespaces")) {
        trace.push(statement.includes("FOR UPDATE") ? "lock-namespace" : "read-namespace");
        return response([
          {
            id: profile.namespaceId,
            name: "controlled",
            status: "ready",
            created_at: profileAcceptedAt,
          },
        ]);
      }
      if (statement.includes("FROM occ.agents")) {
        trace.push(statement.includes("FOR UPDATE") ? "lock-agent" : "read-agent");
        return response([agentRow]);
      }
      if (statement.includes("FROM occ.agent_runtime_intents")) {
        trace.push("lifecycle-head");
        return response();
      }
      if (statement.includes("FROM occ.service_accounts")) {
        trace.push("lock-account");
        return response([
          {
            id: serviceAccountId,
            namespace_id: profile.namespaceId,
            name: "controlled-account",
            credential,
          },
        ]);
      }
      if (statement.includes("FROM occ.configurations")) {
        trace.push("lock-configuration");
        return response([
          {
            id: metadata.id,
            namespace_id: metadata.namespaceId,
            kind: "agent",
            generation: 1,
            created_at: metadata.createdAt,
            secret_bindings: options.secrets ? bindings : null,
          },
        ]);
      }
      if (statement.includes("FROM occ.secrets")) {
        if (statement.includes("ANY(")) return response(parameters[1].map((id) => ({ id })));
        trace.push(`lock-secret:${parameters[1]}`);
        return response(secretRows.filter((row) => row.id === parameters[1]));
      }
      if (statement.includes("pg_advisory_xact_lock_shared")) {
        trace.push("head-gate");
        return response();
      }
      if (statement.includes("SELECT admission_ref FROM occ.workload_profile_admissions")) {
        trace.push("head-share");
        return response([{ admission_ref: profile.head.selection.admissionRef }]);
      }
      if (statement.includes("SELECT record FROM occ.workload_profile_admissions"))
        return response([{ record: profile.head }]);
      if (statement.includes("INSERT INTO occ.agent_revisions")) {
        trace.push("insert");
        inserts++;
        savedRow = {
          id: parameters[0],
          namespace_id: parameters[1],
          agent_id: parameters[2],
          revision_number: parameters[3],
          provider_id: parameters[4],
          admitted_spec: JSON.parse(parameters[5]),
          admitted_at: parameters[6],
          service_principal_id: agentRow.service_principal_id,
        };
        return response([], "INSERT");
      }
      if (statement.includes("FROM occ.agent_revisions")) {
        trace.push(savedRow ? "verify-insert" : "revision-list");
        return response(savedRow ? [savedRow] : []);
      }
      throw new Error(`Unexpected controlled SQL: ${statement}`);
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      connects++;
      return client;
    },
    async end() {},
  });
  const selection = new DriverSelection();
  const iam = new NativeIAMDriver(state);
  selection.registerDriver(iam);
  selection.selectDriver("iam", iam.id);
  const configurationDriver = {
    id: "controlled-configuration",
    capability: "configuration",
    implementation: "controlled-configuration-v1",
    create: noop,
    update: noop,
    delete: noop,
    async read() {
      trace.push("configuration-read");
      options.readEntered?.resolve();
      if (options.readGate) await options.readGate.promise;
      return copy(configurationDocument);
    },
    async validate(value) {
      trace.push("configuration-validate");
      if (options.validationFailure) throw options.validationFailure;
      assert.equal(value.values.logging.level, "info");
    },
  };
  const compute = {
    id: "controlled-compute",
    capability: "compute",
    implementation: "controlled-compute-v1",
    ensureNamespace: noop,
    deleteNamespace: noop,
    prepareRevision: noop,
    retireRevision: noop,
  };
  const secretDriver = {
    id: "controlled-secret",
    capability: "secret",
    implementation: "controlled-secret-v1",
    create: noop,
    update: noop,
    delete: noop,
    async resolve(value) {
      trace.push(`resolve:${value.id}`);
      return copy(value.backendRef);
    },
  };
  for (const driver of [configurationDriver, compute, ...(options.secrets ? [secretDriver] : [])]) {
    selection.registerDriver(driver);
    selection.selectDriver(driver.capability, driver.id);
  }
  if (options.sandbox) {
    const sandbox = {
      id: "controlled-sandbox",
      capability: "sandbox",
      implementation: "controlled-sandbox-v1",
      facets: ["filesystem"],
      cleanup: noop,
      configureAgent(values) {
        trace.push("sandbox-normalize");
        if (options.asyncSandbox) {
          options.sandboxEntered.resolve();
          return options.asyncSandbox.promise;
        }
        return { ...values, sandboxed: true };
      },
    };
    selection.registerDriver(sandbox);
    selection.selectDriver("sandbox", sandbox.id);
  }
  const invocation = Object.freeze({ controlled: true });
  const account = {
    async consume(original, input, unit) {
      assert.strictEqual(original, invocation);
      assert.equal(input.purpose, "workload-profile-deployment");
      trace.push("account");
      unit.retainSecurityCleanup(() => {
        trace.push("release-security");
      });
      return {
        principal,
        accountRef: profile.actor.accountRef,
        requestId: "controlled/request",
        admissionDecisionId: "controlled/decision",
        assertCurrent() {},
        release() {
          trace.push("release-account");
        },
      };
    },
  };
  const originalNormalizer = createDeploymentCandidateNormalizerV2({
    authorization: {
      async authorize() {
        trace.push("authorize");
      },
    },
    providers: new Map(),
    loggingLevel: "info",
    async configurationOperation(operation) {
      trace.push("configuration-wrapper");
      return operation();
    },
    async secretOperation(operation) {
      trace.push("secret-wrapper");
      return operation();
    },
  });
  const normalizer = options.wrapNormalizer
    ? options.wrapNormalizer(originalNormalizer, (value) => {
        capturedOperations = value;
      })
    : originalNormalizer;
  const candidate = state.workloadProfileCandidateContextV2(selection, normalizer, {
    createId() {
      trace.push("allocate-id");
      return revisionId;
    },
    now() {
      trace.push("allocate-time");
      return profileAcceptedAt;
    },
  });
  const profileOwner = state.workloadProfileMutationEnrollmentV2(selection, account);
  const harness = () => ({ id: "codex", version: "controlled" });
  const run = (work) =>
    state.transact(async (platform) => {
      const value = await profileOwner.enrollment.withDeployment(
        invocation,
        binding,
        async (unit, io) => {
          assert.strictEqual(unit.platform, platform);
          actualUnit = unit;
          actualIO = io;
          return work({ unit, io });
        },
      );
      options.afterOperation?.({ selection, configurationDriver });
      return value;
    });
  const capture = (owner, work) =>
    candidate.candidates.withCandidate(owner.unit, owner.io, harness, work);
  const read = async (owner, result, changed = result.candidate) => {
    const before = sql.length;
    const observation = await candidate.contexts.readLocked(request, changed, owner.unit, owner.io);
    assert.equal(sql.length, before, "context read must not issue post-head SQL");
    held.push(observation);
    owner.unit.retain(observation);
    return observation;
  };
  const head = (owner) => profileOwner.activeReader.readLocked(request, owner.unit, owner.io);
  return {
    ...profile,
    admissionHead: profile.head,
    state,
    selection,
    configurationDriver,
    run,
    capture,
    read,
    head,
    candidate,
    request,
    binding,
    harness,
    trace,
    sql,
    secretIds,
    configurationDocument,
    get inserts() {
      return inserts;
    },
    get connects() {
      return connects;
    },
    get io() {
      return actualIO;
    },
    get unit() {
      return actualUnit;
    },
    get operations() {
      return capturedOperations;
    },
  };
}

test("real state and original normalizer capture once before head, copied data reads without SQL and final fence survives IO closure", async () => {
  const f = protocol({ sandbox: true });
  let lease;
  const revision = await f.run((owner) =>
    f.capture(owner, async (result) => {
      await f.head(owner);
      lease = await f.read(owner, result, copy(result.candidate));
      assert.equal(lease.configuration.configurationRef, result.candidate.configurationId);
      assert.deepEqual(
        lease.configuration.immutableConfigurationContent.values,
        result.candidate.configuration,
      );
      assert.deepEqual(result.candidate.secretBindings, {});
      const use = {
        schemaVersion: 2,
        installationId: f.installationId,
        namespaceId: f.namespaceId,
        component: "gateway-harness-pair",
        ...f.request.selection,
        canonicalFormat: "oce.workload-profile.canonical-json.v1",
        profileRefs: f.admissionHead.profileRefs,
        admittedConfigurationDigest: `sha256:${"a".repeat(64)}`,
      };
      // Controlled Use data exercises the real first INSERT and own-row reader;
      // this is not an independent capability/H/definition qualification.
      const inserted = await owner.unit.platform.revisions.createRevision({
        ...result.candidate,
        workloadProfileUse: use,
      });
      const retained = await owner.unit.platform.revisions.findRevision(
        f.namespaceId,
        result.candidate.agentId,
        inserted.id,
      );
      assert.deepEqual(retained, inserted);
      assert.deepEqual(inserted.secretBindings, {});
      assert.deepEqual(retained.secretBindings, {});
      assert.deepEqual(
        JSON.parse(
          f.sql.find((value) => value.statement.includes("INSERT INTO occ.agent_revisions"))
            .parameters[5],
        ).secret_bindings,
        {},
      );
      return inserted;
    }),
  );
  assert.equal(f.connects, 1);
  assert.equal(f.inserts, 1);
  for (const name of [
    "configuration-wrapper",
    "configuration-read",
    "sandbox-normalize",
    "configuration-validate",
    "allocate-id",
    "allocate-time",
  ])
    assert.equal(f.trace.filter((x) => x === name).length, 1, name);
  assert.ok(f.trace.indexOf("account") < f.trace.indexOf("policy"));
  assert.ok(f.trace.indexOf("configuration-validate") < f.trace.indexOf("head-share"));
  assert.ok(f.trace.indexOf("head-share") < f.trace.indexOf("insert"));
  assert.ok(f.trace.indexOf("COMMIT") < f.trace.indexOf("release-security"));
  assert.equal(revision.workloadProfileUse.schemaVersion, 2);
  assert.throws(() => lease.assertCurrent());
});

test("actual repeated binding locks preserve B,A,B and distinct resolve B,A without sorted reordering", async () => {
  const f = protocol({ secrets: true });
  await f.run((owner) =>
    f.capture(owner, async (result) => {
      await f.head(owner);
      await f.read(owner, result);
    }),
  );
  assert.deepEqual(
    f.trace.filter((x) => x.startsWith("lock-secret:")),
    [f.secretIds[1], f.secretIds[0], f.secretIds[1]].map((x) => `lock-secret:${x}`),
  );
  assert.deepEqual(
    f.trace.filter((x) => x.startsWith("resolve:")),
    [f.secretIds[1], f.secretIds[0]].map((x) => `resolve:${x}`),
  );
  assert.equal(f.trace.filter((x) => x === "secret-wrapper").length, 2);
});

for (const [name, amend] of [
  ["configuration", (value) => ({ ...value, configuration: { changed: true } })],
  ["generation", (value) => ({ ...value, configurationGeneration: 2 })],
  ["bindings", (value) => ({ ...value, secretBindings: [] })],
  ["identity", (value) => ({ ...value, id: `rev_${randomUUID()}` })],
])
  test(`copied ${name} alteration is refused and caught failure poisons the original transaction`, async () => {
    const f = protocol();
    await assert.rejects(
      f.run((owner) =>
        f.capture(owner, async (result) => {
          await f.head(owner);
          await f.read(owner, result, amend(copy(result.candidate))).catch(() => {});
        }),
      ),
    );
    assert.ok(f.trace.includes("ROLLBACK"));
    assert.equal(f.inserts, 0);
  });

test("missing selected ServiceAccount refuses before Configuration or head", async () => {
  const f = protocol({ missingAccount: true });
  await assert.rejects(f.run((owner) => f.capture(owner, async () => {})));
  assert.equal(f.trace.includes("configuration-read"), false);
  assert.equal(f.trace.includes("head-share"), false);
});

for (const [name, secretBindings] of [
  ["missing", undefined],
  ["malformed", []],
])
  test(`normalizer ${name} bindings are refused before publishing candidate context`, async () => {
    const f = protocol({
      wrapNormalizer:
        (original) =>
        async (...args) => {
          const result = await original(...args);
          return { ...result, candidate: { ...result.candidate, secretBindings } };
        },
    });
    let published = false;
    await assert.rejects(
      f.run(async (owner) => {
        await f
          .capture(owner, async () => {
            published = true;
            await f.head(owner);
          })
          .catch(() => {});
      }),
    );
    assert.equal(published, false);
    assert.equal(f.trace.includes("head-share"), false);
    assert.equal(f.trace.includes("COMMIT"), false);
    assert.ok(f.trace.includes("ROLLBACK"));
    assert.equal(f.inserts, 0);
  });

test("head-before-capture and duplicate candidate attempts cannot be caught into COMMIT", async () => {
  for (const early of [true, false]) {
    const f = protocol();
    await assert.rejects(
      f.run(async (owner) => {
        if (early) {
          await f.head(owner).catch(() => {});
          return;
        }
        await f.capture(owner, async () => {});
        try {
          await f.capture(owner, async () => {});
        } catch {}
      }),
    );
    assert.equal(f.trace.includes("COMMIT"), false);
  }
});

test("copied unit and foreign IO cannot enter the actual original capture", async () => {
  for (const kind of ["unit", "io"]) {
    const f = protocol();
    await assert.rejects(
      f.run((owner) =>
        f.capture(
          {
            unit: kind === "unit" ? { ...owner.unit } : owner.unit,
            io: kind === "io" ? { ...owner.io } : owner.io,
          },
          async () => {},
        ),
      ),
    );
    assert.equal(f.trace.includes("configuration-read"), false);
  }
});

test("a method change after the operation poisons retained currentness before COMMIT", async () => {
  const f = protocol({
    afterOperation({ configurationDriver }) {
      configurationDriver.validate = async () => {};
    },
  });
  await assert.rejects(
    f.run((owner) =>
      f.capture(owner, async (result) => {
        await f.head(owner);
        await f.read(owner, result);
      }),
    ),
  );
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("unawaited candidate work is joined and cannot acquire authority after its operation closes", async () => {
  const entered = deferred(),
    gate = deferred();
  const f = protocol({ readEntered: entered, readGate: gate });
  let settled = false;
  const run = f.run(async (owner) => {
    void f.capture(owner, async () => {}).catch(() => {});
    await entered.promise;
  });
  void run.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.trace.includes("COMMIT"), false);
  gate.resolve();
  await assert.rejects(run);
  assert.ok(f.trace.includes("ROLLBACK"));
});

test("post-normalization operations are immediately observed and poison even when not awaited", async () => {
  let operations;
  const f = protocol({
    wrapNormalizer(original) {
      return async (...args) => {
        operations = args[2];
        return original(...args);
      };
    },
  });
  await assert.rejects(
    f.run((owner) =>
      f.capture(owner, async () => {
        void operations.repositories.revisions.listRevisions(f.namespaceId, f.binding[1].agentId);
      }),
    ),
  );
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("builder is inert before owner registration; no getters are evaluated", () => {
  let getters = 0;
  const owner = new Proxy(
    {},
    {
      get() {
        getters++;
        throw new Error("early getter");
      },
    },
  );
  const capture = makeTrackedCandidateOperations(owner);
  assert.equal(getters, 0);
  assert.equal(typeof capture.operations.drivers.compute, "function");
});

test("actual controller constructs one original normalizer before factory with no eager Driver or SQL lookup", () => {
  const f = workloadProfileAdmissionFixture();
  let calls = 0,
    context;
  const state = new PostgresPlatformState({
    async connect() {
      throw new Error("constructor SQL");
    },
    async end() {},
  });
  const unavailable = () => {
    throw new Error("controlled missing input");
  };
  new OpenClawController(
    { id: f.installationId, name: "Controlled", createdAt: profileAcceptedAt },
    {
      state,
      workloadProfiles: {
        invocations: { forCurrentInvocation: unavailable },
        create(value) {
          context = value;
          calls++;
          const source = state.workloadProfileCandidateContextV2(
            value.selection,
            value.candidateNormalizer,
            value.candidateOperations,
          );
          const profile = state.workloadProfileMutationEnrollmentV2(value.selection);
          return {
            candidates: source.candidates,
            enrollment: profile.enrollment,
            use: createWorkloadProfileUseResolverV2(profile.activeReader),
          };
        },
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(typeof context.candidateNormalizer, "function");
  assert.equal(Object.isFrozen(context.candidateOperations), true);
});

test("Driver method getter reentry refuses before recursive validation and retains the first failure", async () => {
  let operations,
    getterCalls = 0;
  const f = protocol({
    wrapNormalizer(original) {
      return async (...args) => {
        operations = args[2];
        return original(...args);
      };
    },
  });
  const validate = f.configurationDriver.validate;
  Object.defineProperty(f.configurationDriver, "validate", {
    configurable: true,
    get() {
      getterCalls++;
      if (operations) {
        try {
          operations.drivers.configuration();
        } catch {}
      }
      return validate;
    },
  });
  await assert.rejects(f.run((owner) => f.capture(owner, async () => {})));
  assert.ok(getterCalls > 0 && getterCalls < 20);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("an acquired original Driver hold is released when cleanup transfer refuses", async () => {
  const selection = new DriverSelection();
  const compute = {
    id: "one",
    capability: "compute",
    implementation: "one",
    ensureNamespace: noop,
    deleteNamespace: noop,
    prepareRevision: noop,
    retireRevision: noop,
  };
  selection.registerDriver(compute);
  selection.selectDriver("compute", compute.id);
  const failure = new Error("controlled cleanup transfer refusal");
  // Focused negative collaborator: no positive owner/context is claimed here.
  const capture = makeTrackedCandidateOperations({
    unit: {
      platform: {
        namespaces: {
          async lockNamespace() {
            return { id: "ns" };
          },
        },
        agents: {
          async findAgent() {
            return { id: "agent", namespaceId: "ns" };
          },
        },
      },
      retain() {
        throw failure;
      },
    },
    selection,
    operands: ["actor", { namespaceId: "ns", agentId: "agent" }, {}],
    original: {},
    assertAcquiring() {},
    assertOwner() {},
    track(work) {
      return Promise.resolve().then(work);
    },
    poison(error) {
      throw error;
    },
  });
  await capture.operations.repositories.namespaces.lockNamespace("ns");
  await capture.operations.repositories.agents.findAgent("ns", "agent");
  assert.throws(
    () => capture.operations.drivers.compute(),
    (error) => error === failure,
  );
  const next = { ...compute, id: "two" };
  selection.registerDriver(next);
  assert.strictEqual(selection.selectDriver("compute", next.id), next);
});

test("original revision omission remains omitted without a V2 Use", async () => {
  const f = protocol();
  await f.run((owner) =>
    f.capture(owner, async (result) => {
      const { secretBindings: _omitted, ...legacy } = result.candidate;
      const inserted = await owner.unit.platform.revisions.createRevision(legacy);
      assert.equal(Object.hasOwn(inserted, "secretBindings"), false);
      const spec = JSON.parse(
        f.sql.find((value) => value.statement.includes("INSERT INTO occ.agent_revisions"))
          .parameters[5],
      );
      assert.equal(Object.hasOwn(spec, "secret_bindings"), false);
    }),
  );
});

test("malformed asynchronous sandbox work is observed and joined before cleanup", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = protocol({ sandbox: true, asyncSandbox: gate, sandboxEntered: entered });
  let settled = false;
  const result = f.run((owner) => f.capture(owner, async () => {}));
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.trace.includes("release-security"), false);
  gate.resolve({});
  await assert.rejects(result);
  assert.ok(f.trace.includes("ROLLBACK"));
  assert.ok(f.trace.includes("release-security"));
});
