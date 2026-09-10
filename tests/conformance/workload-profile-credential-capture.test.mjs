import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createDeploymentCandidateNormalizerV2 } from "../../packages/occ/src/services/deployment/candidate-normalization.ts";
import { decodeWorkloadProfileSelectionRequestV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import {
  workloadProfileAdmissionFixture,
  profileAcceptedAt,
} from "../fixtures/workload-profile-admission-v2.mjs";

// Real State, repository, DriverSelection, native IAM and original normalizer
// protocol, derived from the existing candidate-context fixture. SQL/account/
// Driver replies and credential facts are controlled. These cases establish
// capture and cleanup correspondence, not WIF, installed credential policy,
// PostgreSQL locking, material custody or provider authority.
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
  const credential = {
    kind: options.managed ? "access_token" : "api_key",
    secretRef: { name: "credential", key: "value" },
  };
  const provider = {
    id: "controlled-provider",
    type: "chatgpt",
    drivers: { service_account: "controlled-account-driver" },
    configuration: { workspaceId: "controlled-workspace", apiKeyPath: "/controlled/provider-key" },
  };
  const providerRow = {
    provider_id: provider.id,
    driver_id: provider.drivers.service_account,
    workspace_id: provider.configuration.workspaceId,
    credential_issued: true,
  };
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
    provider_id: options.managed ? provider.id : null,
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
      providerId: agentRow.provider_id,
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
      if (statement.includes("FROM occ.service_account_driver_bindings")) {
        trace.push("provider-binding");
        return response(options.missingProviderBinding ? [] : [providerRow]);
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
      assert.equal(
        input.purpose,
        options.recovery ? "workload-profile-deployment-recovery" : "workload-profile-deployment",
      );
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
    providers: new Map(options.managed ? [[provider.id, provider]] : []),
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
  let sourceCalls = 0,
    methodReads = 0,
    sourceReleases = 0,
    capturedRequest;
  const facts = {
    model: { controlled: "model" },
    backend: { controlled: "backend" },
    named: { controlled: "named" },
  };
  const sourceEnrollment = state.workloadProfileSourceEnrollmentV2(selection);
  const source = {};
  const originalAcquire = async function (input, captured, unit, io) {
    assert.strictEqual(this, source);
    sourceCalls++;
    capturedRequest = input;
    trace.push("credential-acquire");
    const expectedRequest = decodeWorkloadProfileSelectionRequestV2(request);
    assert.deepEqual(input, expectedRequest);
    assert.equal(Object.hasOwn(captured, "head"), false);
    assert.equal(captured.configuration.configurationRef, configurationId);
    assert.equal(captured.serviceAccount.id, serviceAccountId);
    assert.deepEqual(
      captured.secrets.map((entry) => entry.id),
      options.secrets ? [secretIds[1], secretIds[0], secretIds[1]] : [],
    );
    const original = sourceEnrollment.revision(input, unit, io);
    const lease = {
      get assertCurrent() {
        if (options.currentGetterFailure) throw options.currentGetterFailure;
        return () => {
          original.assertCurrent();
          trace.push("credential-current");
          return options.sourceCurrent?.();
        };
      },
      get facts() {
        trace.push("credential-facts");
        if (options.factsGetterFailure) throw options.factsGetterFailure;
        return facts;
      },
      async release() {
        sourceReleases++;
        trace.push("credential-release");
        await options.releaseGate?.promise;
        await original.release();
      },
    };
    // Actual original enrollment is callable before candidate completion/head.
    original.assertCurrent();
    assert.equal(trace.includes("head-share"), false);
    if (options.earlyRetain) unit.retain(lease);
    options.acquired?.resolve();
    if (options.acquisitionGate) await options.acquisitionGate.promise;
    if (options.acquisitionFailure) throw options.acquisitionFailure;
    return lease;
  };
  Object.defineProperty(source, "acquireCapturedLocked", {
    get() {
      methodReads++;
      if (methodReads !== 1) throw new Error("The original source method was observed again");
      return originalAcquire;
    },
  });
  const candidate = state.workloadProfileCandidateContextV2(
    selection,
    normalizer,
    {
      createId() {
        trace.push("allocate-id");
        return revisionId;
      },
      now() {
        trace.push("allocate-time");
        return profileAcceptedAt;
      },
    },
    options.missingSource ? undefined : source,
  );
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
  const readRecords = async (owner, result, changed = result.candidate) => {
    const before = sql.length;
    const observation = await candidate.records.readLocked(request, changed, owner.unit, owner.io);
    assert.equal(sql.length, before, "records read must not issue post-head SQL");
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
    readRecords,
    head,
    candidate,
    request,
    binding,
    harness,
    trace,
    sql,
    secretIds,
    configurationDocument,
    source,
    facts,
    normalizer,
    profileOwner,
    invocation,
    get sourceCalls() {
      return sourceCalls;
    },
    get methodReads() {
      return methodReads;
    },
    get sourceReleases() {
      return sourceReleases;
    },
    get capturedRequest() {
      return capturedRequest;
    },
    transportRows: { agentRow, credential, providerRow, secretRows },
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

async function borrowed(f, owner, result, alter = (value) => value, consumer = f.candidate) {
  await f.head(owner);
  const records = await f.readRecords(owner, result);
  const view = Object.freeze({
    sourceIdentity: records.sourceIdentity,
    records: records.records,
    assertCurrent: records.assertCurrent,
  });
  const args = alter([f.request, view, owner.unit, owner.io]);
  const before = f.sql.length;
  const resultView = await consumer.consumeCapturedCredentialV1(...args);
  assert.equal(f.sql.length, before, "Borrowed recognition has no post-head SQL");
  return resultView;
}

test("credential source is captured once at construction and acquired after original observations before head", async () => {
  const f = protocol({ secrets: true });
  assert.equal(f.methodReads, 1);
  assert.equal(f.sourceCalls, 0);
  await f.run((owner) =>
    f.capture(owner, async (result) => {
      const value = await borrowed(f, owner, result);
      assert.strictEqual(
        value.facts,
        f.facts,
        "Original policy keeps its genuine facts object identity",
      );
      assert.deepEqual(Object.keys(value).sort(), ["assertCurrent", "facts"]);
      assert.equal(value.assertCurrent(), undefined);
    }),
  );
  assert.equal(f.methodReads, 1);
  assert.equal(f.sourceCalls, 1);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.filter((event) => event === "credential-facts").length, 1);
  assert.ok(f.trace.indexOf("configuration-validate") < f.trace.indexOf("credential-acquire"));
  assert.ok(f.trace.indexOf("credential-acquire") < f.trace.indexOf("head-share"));
  assert.ok(f.trace.indexOf("COMMIT") < f.trace.indexOf("release-client"));
  assert.ok(f.trace.indexOf("release-client") < f.trace.indexOf("credential-release"));
});

test("borrowed currentness survives acquisition IO closure through actual final COMMIT fence", async () => {
  let value;
  const f = protocol({
    atCommit() {
      assert.throws(() => f.io.assertActive());
      assert.equal(value.assertCurrent(), undefined);
    },
  });
  await f.run((owner) =>
    f.capture(owner, async (result) => {
      value = await borrowed(f, owner, result);
    }),
  );
  assert.throws(() => value.assertCurrent());
  assert.equal(f.sourceReleases, 1);
});

test("managed account capture preserves the original optional provider-binding record", async () => {
  const f = protocol({ managed: true });
  await f.run((owner) =>
    f.capture(owner, async (result) => {
      const value = await borrowed(f, owner, result);
      assert.strictEqual(value.facts, f.facts);
    }),
  );
  assert.ok(f.trace.indexOf("provider-binding") < f.trace.indexOf("credential-acquire"));
  assert.equal(f.sourceCalls, 1);
  assert.equal(f.sourceReleases, 1);
});

for (const [name, change] of [
  ["request", ([request, ...rest]) => [{ ...request, revisionId: `rev_${randomUUID()}` }, ...rest]],
  [
    "selection",
    ([request, ...rest]) => [
      {
        ...request,
        selection: {
          ...request.selection,
          admissionVersion: request.selection.admissionVersion + 1,
        },
      },
      ...rest,
    ],
  ],
  [
    "source identity",
    ([request, view, ...rest]) => [
      request,
      { ...view, sourceIdentity: Object.freeze({}) },
      ...rest,
    ],
  ],
  [
    "record data",
    ([request, view, ...rest]) => [
      request,
      {
        ...view,
        records: {
          ...view.records,
          agent: { ...view.records.agent, servicePrincipalId: "foreign" },
        },
      },
      ...rest,
    ],
  ],
  ["copied unit", ([request, view, unit, io]) => [request, view, { ...unit }, io]],
  [
    "other variant",
    ([request, view, unit, io]) => [request, view, { ...unit, kind: "deployment-recovery" }, io],
  ],
  ["copied IO", ([request, view, unit, io]) => [request, view, unit, { ...io }]],
]) {
  test(`credential borrowed recognition refuses wrong ${name}`, async () => {
    const f = protocol();
    await assert.rejects(
      f.run((owner) => f.capture(owner, (result) => borrowed(f, owner, result, change))),
    );
    assert.equal(f.trace.includes("COMMIT"), false);
    assert.equal(f.sourceReleases, 1);
  });
}

test("a different fixed credential source cannot consume the original captured slot", async () => {
  const f = protocol();
  let foreignCalls = 0;
  const foreign = f.state.workloadProfileCandidateContextV2(
    f.selection,
    f.normalizer,
    { createId: () => "unused", now: () => profileAcceptedAt },
    {
      async acquireCapturedLocked() {
        foreignCalls++;
        throw new Error("Must not acquire");
      },
    },
  );
  await assert.rejects(
    f.run((owner) =>
      f.capture(owner, (result) => borrowed(f, owner, result, (value) => value, foreign)),
    ),
  );
  assert.equal(foreignCalls, 0);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("missing credential source refuses consumption without inventing a capture", async () => {
  const f = protocol({ missingSource: true });
  await assert.rejects(f.run((owner) => f.capture(owner, (result) => borrowed(f, owner, result))));
  assert.equal(f.methodReads, 0);
  assert.equal(f.sourceCalls, 0);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("an actual original recovery unit cannot consume a deployment credential capture", async () => {
  const f = protocol({ recovery: true });
  let entered = false;
  await assert.rejects(
    f.state.read(async () =>
      f.profileOwner.enrollment.withRecovery(f.invocation, f.binding, async (unit, io) => {
        entered = true;
        assert.equal(unit.kind, "deployment-recovery");
        return f.candidate.consumeCapturedCredentialV1(
          f.request,
          { sourceIdentity: Object.freeze({}), records: {}, assertCurrent() {} },
          unit,
          io,
        );
      }),
    ),
  );
  assert.equal(entered, true);
  assert.equal(f.sourceCalls, 0);
  assert.equal(f.trace.includes("head-share"), false);
  assert.equal(f.trace.includes("COMMIT"), false);
});

for (const field of ["currentGetterFailure", "factsGetterFailure"]) {
  test(`returned cleanup is retained before throwing ${field}`, async () => {
    const failure = new Error(`controlled ${field}`);
    const f = protocol({ [field]: failure });
    let entered = false;
    await assert.rejects(
      f.run((owner) =>
        f.capture(owner, async () => {
          entered = true;
        }),
      ),
      (error) => error === failure,
    );
    assert.equal(entered, false);
    assert.equal(f.sourceReleases, 1);
    assert.equal(f.trace.includes("head-share"), false);
    assert.equal(f.trace.includes("COMMIT"), false);
  });
}

test("partial acquisition failure joins original early-retained cleanup before rejection", async () => {
  const failure = new Error("controlled acquisition failure");
  const gate = deferred();
  const f = protocol({ earlyRetain: true, acquisitionFailure: failure, releaseGate: gate });
  let settled = false;
  const running = f.run((owner) => f.capture(owner, async () => assert.fail("No continuation")));
  const rejection = assert.rejects(running, (error) => error === failure);
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!f.trace.includes("credential-release"))
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gate.resolve();
  await rejection;
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("changed original facts poison the owner even when borrower catches its currentness failure", async () => {
  const f = protocol();
  let rejected = false;
  await assert.rejects(
    f.run((owner) =>
      f.capture(owner, async (result) => {
        const value = await borrowed(f, owner, result);
        f.facts.model.controlled = "changed";
        assert.throws(() => value.assertCurrent());
        rejected = true;
      }),
    ),
  );
  assert.equal(rejected, true);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("malformed asynchronous source currentness is joined before terminal cleanup", async () => {
  const gate = deferred();
  const entered = deferred();
  const f = protocol({
    sourceCurrent() {
      entered.resolve();
      return gate.promise;
    },
  });
  let settled = false;
  const running = f.run((owner) => f.capture(owner, async () => assert.fail("No continuation")));
  const rejection = assert.rejects(running);
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.sourceReleases, 0);
  gate.resolve();
  await rejection;
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("caught recursive source currentness still poisons the original owner", async () => {
  let caught = false;
  const f = protocol({
    sourceCurrent() {
      // This deliberately invalid source calls the composite IO fence from its
      // own retained assertion, then attempts to swallow the recursive refusal.
      try {
        f.io.assertActive();
      } catch {
        caught = true;
      }
    },
  });
  await assert.rejects(
    f.run((owner) => f.capture(owner, async () => assert.fail("No continuation"))),
  );
  assert.equal(caught, true);
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("head-share"), false);
  assert.equal(f.trace.includes("COMMIT"), false);
});

test("acquisition is joined after original operation closure and late returned cleanup is released once", async () => {
  const acquired = deferred();
  const gate = deferred();
  const f = protocol({ acquired, acquisitionGate: gate });
  let settled = false;
  const running = f.run(async (owner) => {
    void f.capture(owner, async () => assert.fail("No continuation")).catch(() => {});
    await acquired.promise;
  });
  const rejection = assert.rejects(running);
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await acquired.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => f.io.assertActive(), "The original callback has closed its IO");
  assert.equal(settled, false);
  assert.equal(f.sourceReleases, 0);
  gate.resolve();
  await rejection;
  assert.equal(f.sourceReleases, 1);
  assert.equal(f.trace.includes("COMMIT"), false);
});
