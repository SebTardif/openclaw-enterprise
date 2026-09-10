import assert from "node:assert/strict";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";
import { normalizeSecretBindings } from "../../packages/contracts/src/secret-bindings.ts";
import { bindLifecycleDeployCommandV2 } from "../../packages/contracts/src/lifecycle-deploy-v2.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import { createDeploymentCandidateNormalizerV2 } from "../../packages/occ/src/services/deployment/candidate-normalization.ts";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";

// Actual normalization and service behavior with controlled repositories and
// Driver effects. These observations establish no selected-owner membership,
// protected profile context, database transaction, credential authority or Use.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const installationId = id("ins", 1);
const namespaceId = id("ns", 2);
const agentId = id("agt", 3);
const principalId = id("prn", 4);
const servicePrincipalId = id("prn", 5);
const configurationId = id("cfg", 6);
const serviceAccountId = id("sa", 7);
const revisionId = id("rev", 8);
const secretA = id("sec", 9);
const secretB = id("sec", 10);
const operationRef = uuid(11);
const requestId = id("req", 12);
const auditId = id("aud", 13);
const createdAt = "2026-09-07T08:00:00.000Z";
const admittedAt = "2026-09-07T08:01:00.000Z";
const providerId = "provider/model";
const runtimeScope = { namespaceId, agentId };
const plain = (value) => JSON.parse(JSON.stringify(value));
const selection = () => ({
  manifestRef: uuid(14),
  manifestDigest: `sha256:${"a".repeat(64)}`,
  admissionRef: uuid(15),
  admissionVersion: 2,
});
const command = () => ({
  schemaVersion: 2,
  operationRef,
  expectedLifecycleGeneration: null,
  revisionSource: "saved-draft",
  expectedDraft: {
    configurationId,
    configurationGeneration: 3,
    providerId,
    executionMode: "dedicated",
    maximumExecutionMs: null,
    serviceAccountId,
    workloadProfileSelection: selection(),
  },
});
const secretReference = (target) => ({ source: { kind: "secret", namespaceId, id: target } });

function fixture() {
  const calls = [],
    poison = [],
    inserts = [],
    failures = new Map();
  function record(name, ...args) {
    calls.push({ name, args });
    if (failures.has(name)) throw failures.get(name);
  }
  const namespace = { id: namespaceId, name: "namespace", status: "ready", createdAt };
  const agent = {
    id: agentId,
    namespaceId,
    name: "agent",
    providerId,
    configurationId,
    serviceAccountId,
    servicePrincipalId,
    executionMode: "dedicated",
    maximumExecutionMs: null,
    createdAt,
    workloadProfileSelection: selection(),
  };
  const account = {
    id: serviceAccountId,
    namespaceId,
    name: "model-account",
    credential: { kind: "api_key", secretRef: { name: "model-key", key: "api-key" } },
  };
  const metadata = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 3,
    values: createHarnessConfiguration("codex", "gpt-4.1"),
    createdAt,
  };
  const secrets = new Map(
    [secretA, secretB].map((target, index) => [
      target,
      {
        id: target,
        namespaceId,
        name: `data-${index}`,
        driverId: "secret/example",
        backendRef: { name: `data-${index}`, key: "value" },
      },
    ]),
  );
  const f = {
    calls,
    poison,
    inserts,
    failures,
    record,
    namespace,
    agent,
    account,
    metadata,
    secrets,
    document: structuredClone(metadata),
    head: undefined,
    previous: [],
    retained: undefined,
    providerBinding: {
      providerId,
      driverId: "account/example",
      workspaceId: uuid(16),
      credentialIssued: true,
    },
    named(name) {
      return calls.filter((call) => call.name === name);
    },
  };
  const repositories = {
    namespaces: {
      async lockNamespace(target) {
        record("namespace.lock", target);
        return f.namespace;
      },
    },
    agents: {
      async findAgent(...args) {
        record("agent.find", ...args);
        return f.agent;
      },
      async lockAgent(...args) {
        record("agent.lock", ...args);
        return f.agent;
      },
    },
    runtimeAssignments: {
      async findRuntimeIntentHead(...args) {
        record("head.find", ...args);
        return f.head;
      },
      async findRuntimeIntent(...args) {
        record("intent.find", ...args);
        return f.retainedIntent;
      },
      async initializeRuntimeIntent(scope, selectedRevision, transition, attribution) {
        record("intent.initialize", scope, selectedRevision, transition, attribution);
        return {
          installationId,
          ...scope,
          revisionId: selectedRevision,
          transitionRef: transition,
          ...attribution,
          desiredMode: "running",
          generation: 1,
          createdAt: admittedAt,
        };
      },
      async advanceRuntimeIntent(scope, generation, desired, transition, attribution) {
        record("intent.advance", scope, generation, desired, transition, attribution);
        return {
          installationId,
          ...scope,
          ...desired,
          transitionRef: transition,
          ...attribution,
          generation: generation + 1,
          createdAt: admittedAt,
        };
      },
    },
    serviceAccounts: {
      async lockServiceAccount(...args) {
        record("account.lock", ...args);
        return f.account;
      },
      async findServiceAccountProviderBinding(...args) {
        record("account.provider", ...args);
        return f.providerBinding;
      },
    },
    configurations: {
      async lockConfiguration(...args) {
        record("configuration.lock", ...args);
        return f.metadata;
      },
    },
    secrets: {
      async lockSecret(namespace, target) {
        record("secret.lock", namespace, target);
        return f.secrets.get(target);
      },
    },
    revisions: {
      async listRevisions(...args) {
        record("revision.list", ...args);
        return f.previous;
      },
      async createRevision(...args) {
        record("revision.insert", ...args);
        inserts.push(args);
        return args[0];
      },
    },
    runtimeAdmissions: {
      async lockDeployCommand(...args) {
        record("command.lock", ...args);
      },
      async findCommittedDeployCommand(...args) {
        record("command.read", ...args);
        return f.retained;
      },
      async recordAdmission(...args) {
        record("admission.record", ...args);
      },
    },
    audit: {
      async append(...args) {
        record("audit.append", ...args);
      },
    },
    operations: {
      async append(...args) {
        record("work.append", ...args);
      },
    },
  };
  f.repositories = repositories;
  f.compute = { id: "compute/example", implementation: "controlled-compute" };
  f.sandbox = {
    id: "sandbox/example",
    configureAgent(values) {
      record("sandbox.configure", values);
      return {
        ...structuredClone(values),
        tools: { allow: ["read"], fs: { workspaceOnly: true } },
      };
    },
  };
  f.secret = {
    id: "secret/example",
    async resolve(value) {
      record("secret.resolve", value);
      return f.resolvedSecret ?? { ...value.backendRef };
    },
  };
  f.configuration = {
    id: "configuration/example",
    async read(...args) {
      record("configuration.read", ...args);
      return f.document;
    },
    async validate(...args) {
      record("configuration.validate", ...args);
    },
  };
  f.options = {
    installationId,
    repositories: {
      async mutate(work) {
        record("mutation.enter");
        return work(repositories);
      },
    },
    async recoveryRead() {
      assert.fail("Fresh normalization cannot open recovery");
    },
    hasActiveTransaction: () => true,
    poisonAdmission(error) {
      poison.push(error);
    },
    authorization: {
      async authorize(...args) {
        record("authorize", ...args);
      },
    },
    computeDriver() {
      record("driver.compute");
      return f.compute;
    },
    sandboxDriver() {
      record("driver.sandbox");
      return f.sandbox;
    },
    secretDriver(expected) {
      record("driver.secret", expected);
      if (expected !== undefined && expected !== f.secret.id)
        throw new DependencyUnavailableError("Controlled selected Secret Driver mismatch");
      return f.secret;
    },
    configurationDriver() {
      record("driver.configuration");
      return f.configuration;
    },
    async configurationOperation(work) {
      record("configuration.operation");
      return work();
    },
    async secretOperation(work) {
      record("secret.operation");
      return work();
    },
    providers: new Map([
      [
        providerId,
        {
          id: providerId,
          type: "chatgpt",
          configuration: { workspaceId: uuid(16), apiKeyPath: "/operator/model-key" },
          drivers: { service_account: "account/example" },
        },
      ],
    ]),
    loggingLevel: "warn",
    createId() {
      record("revision.id");
      return revisionId;
    },
    now() {
      record("clock.now");
      return admittedAt;
    },
    isRuntimeAdmissionAudit(...args) {
      // This accepting participant observes forwarding only, not audit authority.
      record("audit.compare", ...args);
      return true;
    },
  };
  f.harness = (harness, mode) => {
    record("harness.resolve", harness, mode);
    return f.approvedHarness;
  };
  f.approvedHarness = { id: "codex", version: "test-version" };
  f.admission = {
    transitionRef: operationRef,
    requestId,
    createAuditEvent(revision) {
      record("audit.create", revision);
      return {
        id: auditId,
        installationId,
        namespaceId,
        occurredAt: admittedAt,
        kind: "mutation",
        actorId: principalId,
        requestId,
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revision.id, namespaceId },
        outcome: "success",
      };
    },
  };
  return f;
}

function noCandidate(f) {
  for (const name of [
    "revision.id",
    "clock.now",
    "revision.insert",
    "intent.initialize",
    "intent.advance",
    "audit.create",
    "audit.append",
    "admission.record",
    "work.append",
  ])
    assert.equal(f.named(name).length, 0, name);
}

function runningHead(generation) {
  return {
    installationId,
    ...runtimeScope,
    generation,
    desiredMode: "running",
    revisionId: id("rev", 17),
    transitionRef: uuid(18),
    actorId: principalId,
    requestId: id("req", 19),
    createdAt,
  };
}

async function deployV1(f, input = runtimeScope, admission = f.admission) {
  return new DeploymentService(f.options).deployAgent(principalId, input, f.harness, admission);
}

function directOperations(f) {
  // Inputs to the real normalizer, not the protected state's observation writer.
  return {
    repositories: f.repositories,
    drivers: {
      compute: () => f.options.computeDriver(),
      sandbox: () => f.options.sandboxDriver(),
      secret: (expected) => f.options.secretDriver(expected),
      configuration: () => f.options.configurationDriver(),
    },
    nextRevisionId: () => f.options.createId(),
    now: () => f.options.now(),
  };
}

function canonicalCommand(value = command()) {
  return bindLifecycleDeployCommandV2({ installationId, ...runtimeScope }, value).command;
}

async function normalizeV2(f, value = command()) {
  const captured = canonicalCommand(value);
  return createDeploymentCandidateNormalizerV2(f.options)(
    [
      principalId,
      { ...runtimeScope, expectedLifecycleGeneration: captured.expectedLifecycleGeneration },
      captured,
    ],
    f.harness,
    directOperations(f),
  );
}

test("deployment normalization preserves V1 omitted generation and omitted optional revision fields", async () => {
  const previous = await deployV1(fixture());
  const f = fixture();
  f.head = runningHead(7);
  f.previous = [
    { ...previous, id: id("rev", 17), revision: 1, createdAt },
    { ...previous, id: id("rev", 20), revision: 2, createdAt },
  ];
  delete f.agent.serviceAccountId;
  f.sandbox = undefined;
  // An inherited value is not the original caller's explicit CAS operand.
  const input = Object.assign(Object.create({ expectedLifecycleGeneration: null }), runtimeScope);
  const revision = await deployV1(f, input);
  assert.equal(revision.id, revisionId);
  assert.equal(revision.revision, 3);
  assert.equal(revision.createdAt, admittedAt);
  for (const property of [
    "secretBindings",
    "secretDriverId",
    "sandboxDriverId",
    "serviceAccount",
    "workloadProfileUse",
  ])
    assert.equal(Object.hasOwn(revision, property), false, property);
  assert.equal(revision.servicePrincipalId, servicePrincipalId);
  assert.equal(f.named("account.lock").length, 0);
  assert.equal(f.named("driver.secret").length, 0);
  assert.equal(f.named("sandbox.configure").length, 0);
  assert.equal(f.named("intent.advance")[0].args[1], 7);
  assert.equal(f.inserts.length, 1);
  assert.equal(f.inserts[0].length, 1, "V1 keeps its original single INSERT operand");
  assert.equal(f.inserts[0][0], revision);
  for (const name of ["revision.id", "clock.now", "configuration.read", "configuration.validate"])
    assert.equal(f.named(name).length, 1, name);
  assert.deepEqual(f.poison, []);
});

test("deployment normalization preserves explicit V1 lifecycle CAS and rejects malformed own operands before reads", async () => {
  for (const expected of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", false]) {
    const f = fixture();
    await assert.rejects(
      deployV1(f, { ...runtimeScope, expectedLifecycleGeneration: expected }),
      ScopeViolationError,
    );
    assert.equal(f.named("namespace.lock").length, 0);
    assert.equal(f.named("driver.compute").length, 0);
    assert.ok(f.poison.some((error) => error instanceof ScopeViolationError));
    noCandidate(f);
  }
  for (const [generation, expected, accepted] of [
    [undefined, null, true],
    [4, 4, true],
    [4, null, false],
    [undefined, 4, false],
    [4, 3, false],
  ]) {
    const f = fixture();
    f.head = generation === undefined ? undefined : runningHead(generation);
    const pending = deployV1(f, { ...runtimeScope, expectedLifecycleGeneration: expected });
    if (accepted) {
      await pending;
      assert.equal(f.inserts.length, 1);
    } else {
      await assert.rejects(pending, ResourceConflictError);
      assert.equal(f.named("configuration.lock").length, 0);
      noCandidate(f);
    }
  }
});

test("deployment normalization preserves duplicate Secret lock order and resolves each source once", async () => {
  const f = fixture();
  f.metadata.secretBindings = {
    FIRST_DATA: secretReference(secretB),
    SECOND_DATA: secretReference(secretA),
    REPEATED_DATA: secretReference(secretB),
  };
  const revision = await deployV1(f);
  assert.deepEqual(
    f.named("secret.lock").map(({ args }) => args),
    [
      [namespaceId, secretB],
      [namespaceId, secretA],
      [namespaceId, secretB],
    ],
  );
  assert.deepEqual(
    f.named("secret.resolve").map(({ args }) => args[0].id),
    [secretB, secretA],
  );
  assert.deepEqual(
    f.named("authorize").map(({ args }) => args),
    [
      [principalId, "deploy", { kind: "agent", id: agentId, namespaceId }],
      [principalId, "read", { kind: "service_account", id: serviceAccountId, namespaceId }],
      [principalId, "read", { kind: "configuration", id: configurationId, namespaceId }],
      [principalId, "operate", { kind: "secret", namespaceId, id: secretB }],
      [principalId, "operate", { kind: "secret", namespaceId, id: secretA }],
      [principalId, "operate", { kind: "secret", namespaceId, id: secretB }],
      [servicePrincipalId, "operate", { kind: "secret", id: secretB, namespaceId }],
      [servicePrincipalId, "operate", { kind: "secret", id: secretA, namespaceId }],
    ],
  );
  const ordered = f.calls.map(({ name }) => name).filter((name) => name !== "mutation.enter");
  assert.deepEqual(ordered.slice(0, 33), [
    "namespace.lock",
    "agent.find",
    "authorize",
    "driver.compute",
    "driver.sandbox",
    "agent.lock",
    "head.find",
    "authorize",
    "account.lock",
    "authorize",
    "configuration.lock",
    "authorize",
    "secret.lock",
    "driver.secret",
    "authorize",
    "secret.lock",
    "driver.secret",
    "authorize",
    "secret.lock",
    "driver.secret",
    "driver.secret",
    "authorize",
    "secret.operation",
    "secret.resolve",
    "authorize",
    "secret.operation",
    "secret.resolve",
    "driver.configuration",
    "configuration.operation",
    "configuration.read",
    "sandbox.configure",
    "configuration.validate",
    "harness.resolve",
  ]);
  assert.deepEqual(
    plain(revision.secretBindings),
    plain(normalizeSecretBindings(f.metadata.secretBindings)),
  );
  assert.equal(revision.secretDriverId, f.secret.id);
  assert.equal(f.named("configuration.read").length, 1);
  assert.equal(f.named("configuration.validate").length, 1);
  assert.equal(f.named("sandbox.configure").length, 1);
  assert.equal(f.named("revision.id").length, 1);
  assert.equal(f.named("clock.now").length, 1);
  const validated = f.named("configuration.validate")[0].args[0];
  assert.deepEqual(
    plain(validated.values),
    plain(
      admitLoggingConfiguration(
        {
          ...f.document.values,
          tools: { allow: ["read"], fs: { workspaceOnly: true } },
        },
        "warn",
      ),
    ),
  );
  assert.deepEqual(plain(revision.configuration), plain(validated.values));
  assert.ok(Object.isFrozen(f.named("sandbox.configure")[0].args[0]));
  assert.ok(Object.isFrozen(revision));
  assert.ok(Object.isFrozen(revision.secretBindings.FIRST_DATA.source));
  assert.ok(Object.isFrozen(revision.serviceAccount.credential.secretRef));
  assert.ok(Object.isFrozen(revision.configuration.tools.fs));
  f.document.values.agents.defaults.model = "codex/changed";
  f.account.credential.secretRef.name = "changed";
  f.metadata.secretBindings.FIRST_DATA.source.id = secretA;
  assert.equal(revision.configuration.agents.defaults.model, "codex/gpt-4.1");
  assert.equal(revision.serviceAccount.credential.secretRef.name, "model-key");
  assert.equal(revision.secretBindings.FIRST_DATA.source.id, secretB);
});

test("deployment normalization propagates original operation failures before allocating or publishing a revision", async () => {
  for (const operation of [
    "namespace.lock",
    "agent.find",
    "authorize",
    "driver.sandbox",
    "agent.lock",
    "head.find",
    "account.lock",
    "configuration.lock",
    "secret.lock",
    "secret.resolve",
    "configuration.read",
    "sandbox.configure",
    "configuration.validate",
    "harness.resolve",
    "revision.list",
  ]) {
    for (const failure of [new Error(`controlled ${operation} refusal`), undefined]) {
      const f = fixture();
      f.metadata.secretBindings = { DATA_TOKEN: secretReference(secretA) };
      f.failures.set(operation, failure);
      let rejected = false;
      try {
        await deployV1(f);
      } catch (error) {
        rejected = true;
        assert.equal(error, failure);
      }
      assert.equal(rejected, true, operation);
      assert.ok(
        f.poison.some((error) => error === failure),
        operation,
      );
      noCandidate(f);
    }
  }
  const f = fixture();
  f.failures.set("driver.compute", new Error("unavailable selected Compute"));
  await assert.rejects(deployV1(f), DependencyUnavailableError);
  assert.equal(f.named("agent.lock").length, 0);
  noCandidate(f);
});

test("deployment normalization keeps original namespace, lifecycle, credential and Secret refusals", async () => {
  for (const [change, ErrorType, excluded] of [
    [
      (f) => {
        f.namespace.status = "provisioning";
      },
      NamespaceNotReadyError,
      "driver.compute",
    ],
    [
      (f) => {
        f.head = { ...runningHead(1), desiredMode: "stopped" };
      },
      ResourceConflictError,
      "account.lock",
    ],
    [
      (f) => {
        f.head = runningHead(Number.MAX_SAFE_INTEGER);
      },
      ResourceConflictError,
      "account.lock",
    ],
    [
      (f) => {
        f.account = undefined;
      },
      ScopeViolationError,
      "configuration.lock",
    ],
    [
      (f) => {
        delete f.account.credential;
      },
      ResourceConflictError,
      "configuration.lock",
    ],
    [
      (f) => {
        f.account.credential.kind = "oauth";
      },
      ResourceConflictError,
      "configuration.lock",
    ],
    [
      (f) => {
        f.metadata.secretBindings = {
          DATA_TOKEN: { source: { kind: "secret", namespaceId: id("ns", 21), id: secretA } },
        };
      },
      ScopeViolationError,
      "secret.lock",
    ],
    [
      (f) => {
        f.metadata.secretBindings = { DATA_TOKEN: secretReference(secretA) };
        f.resolvedSecret = { name: "different-backend", key: "value" };
      },
      DependencyUnavailableError,
      "configuration.read",
    ],
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(deployV1(f), ErrorType);
    assert.equal(f.named(excluded).length, 0, excluded);
    noCandidate(f);
  }
});

test("deployment normalization validates locked Configuration correspondence and approved native Harness before allocation", async () => {
  for (const [key, value] of [
    ["id", id("cfg", 22)],
    ["namespaceId", id("ns", 23)],
    ["kind", "other"],
    ["generation", 4],
    ["createdAt", admittedAt],
  ]) {
    const f = fixture();
    f.document[key] = value;
    await assert.rejects(deployV1(f), DependencyUnavailableError);
    assert.equal(f.named("configuration.read").length, 1);
    assert.equal(f.named("configuration.validate").length, 0);
    noCandidate(f);
  }
  for (const [harness, ErrorType] of [
    [undefined, DependencyUnavailableError],
    [{ id: "codex", version: "" }, DependencyUnavailableError],
    [{ id: "openclaw", version: "test-version" }, ScopeViolationError],
  ]) {
    const f = fixture();
    f.approvedHarness = harness;
    await assert.rejects(deployV1(f), ErrorType);
    assert.equal(f.named("configuration.validate").length, 1);
    assert.equal(f.named("revision.list").length, 0);
    noCandidate(f);
  }
});

test("deployment normalization preserves managed ServiceAccount provider correspondence", async () => {
  const f = fixture();
  f.account.credential.kind = "access_token";
  const revision = await deployV1(f);
  assert.equal(revision.serviceAccount.credential.kind, "access_token");
  assert.deepEqual(f.named("account.provider")[0].args, [namespaceId, serviceAccountId]);
  const sequence = f.calls.map(({ name }) => name);
  assert.ok(sequence.indexOf("account.lock") < sequence.indexOf("account.provider"));
  assert.ok(sequence.indexOf("account.provider") < sequence.indexOf("configuration.lock"));
  for (const [field, value] of [
    ["providerId", "provider/foreign"],
    ["driverId", "account/foreign"],
    ["workspaceId", uuid(24)],
    ["credentialIssued", false],
  ]) {
    const denied = fixture();
    denied.account.credential.kind = "access_token";
    denied.providerBinding[field] = value;
    await assert.rejects(deployV1(denied), ResourceConflictError);
    assert.equal(denied.named("configuration.lock").length, 0);
    noCandidate(denied);
  }
});

test("deployment normalization does not move trusted credential availability behind fresh reads", async () => {
  for (const requirement of [false, undefined, true]) {
    const f = fixture();
    await assert.rejects(
      deployV1(f, runtimeScope, { ...f.admission, requireCredentialSelection: requirement }),
      requirement === true ? DependencyUnavailableError : ScopeViolationError,
    );
    assert.equal(f.named("namespace.lock").length, 0);
    assert.equal(f.named("driver.compute").length, 0);
    noCandidate(f);
  }
});

test("deployment normalization does not retry failed original revision ID or clock allocation", async () => {
  for (const operation of ["revision.id", "clock.now"]) {
    const f = fixture();
    const failure = new Error(`controlled ${operation} failure`);
    f.failures.set(operation, failure);
    await assert.rejects(deployV1(f), (error) => error === failure);
    assert.equal(f.named("configuration.read").length, 1);
    assert.equal(f.named("configuration.validate").length, 1);
    assert.equal(f.named("sandbox.configure").length, 1);
    assert.equal(f.named("revision.list").length, 1);
    assert.equal(f.named("revision.id").length, 1);
    assert.equal(f.named("clock.now").length, operation === "clock.now" ? 1 : 0);
    assert.equal(f.inserts.length, 0);
    assert.equal(f.named("audit.create").length, 0);
    assert.ok(f.poison.includes(failure));
  }
});

test("deployment normalizer construction is inert and the service captures the supplied original function", async () => {
  const f = fixture();
  f.sandbox = undefined;
  const normalizer = createDeploymentCandidateNormalizerV2({ ...f.options, loggingLevel: "error" });
  const options = { ...f.options, candidateNormalizer: normalizer };
  const service = new DeploymentService(options);
  assert.deepEqual(
    f.calls,
    [],
    "constructors must not select Drivers, authorize, read or allocate",
  );
  f.compute = { id: "compute/registered-later", implementation: "controlled-later" };
  options.candidateNormalizer = () =>
    assert.fail("The original constructor reference must be retained");
  const revision = await service.deployAgent(principalId, runtimeScope, f.harness, f.admission);
  assert.deepEqual(plain(revision.compute), f.compute);
  assert.deepEqual(
    plain(revision.configuration),
    plain(admitLoggingConfiguration(f.document.values, "error")),
  );
  assert.equal(f.named("driver.compute").length, 1);
  assert.equal(f.named("configuration.read").length, 1);
  assert.equal(f.named("configuration.validate").length, 1);
  assert.equal(f.named("revision.id").length, 1);
  assert.equal(f.named("clock.now").length, 1);
  assert.equal(f.inserts.length, 1);
});

test("deployment normalization retains original V1 generation capture across asynchronous mutation entry", async () => {
  for (const explicit of [false, true]) {
    const f = fixture();
    f.head = runningHead(7);
    const input = { ...runtimeScope, ...(explicit ? { expectedLifecycleGeneration: 7 } : {}) };
    f.options.repositories.mutate = async (work) => {
      f.record("mutation.enter");
      input.expectedLifecycleGeneration = null;
      await Promise.resolve();
      return work(f.repositories);
    };
    await deployV1(f, input);
    assert.equal(input.expectedLifecycleGeneration, null);
    assert.equal(f.named("intent.advance")[0].args[1], 7);
    assert.equal(f.inserts.length, 1);
    assert.deepEqual(f.poison, []);
  }
});

test("deployment normalizer distinguishes V1 omission from V2 explicit empty bindings without a Secret Driver", async () => {
  for (const explicitBindings of [false, true]) {
    const f = fixture();
    if (explicitBindings) f.metadata.secretBindings = {};
    const normalized = await normalizeV2(f);
    const { candidate } = normalized;
    assert.equal(normalized.namespace, f.namespace);
    assert.equal(normalized.lockedAgent, f.agent);
    assert.equal(normalized.head, undefined);
    assert.equal(normalized.providerId, providerId);
    assert.equal(Object.hasOwn(candidate, "secretBindings"), true);
    assert.deepEqual(plain(candidate.secretBindings), {});
    assert.ok(Object.isFrozen(candidate.secretBindings));
    assert.equal(Object.hasOwn(candidate, "secretDriverId"), false);
    assert.equal(Object.hasOwn(candidate, "workloadProfileUse"), false);
    assert.deepEqual(plain(candidate.serviceAccount), {
      id: serviceAccountId,
      credential: f.account.credential,
    });
    assert.equal(candidate.configurationGeneration, 3);
    assert.equal(f.named("driver.secret").length, 0);
    for (const name of [
      "namespace.lock",
      "agent.find",
      "agent.lock",
      "head.find",
      "account.lock",
      "configuration.lock",
      "configuration.read",
      "configuration.validate",
      "sandbox.configure",
      "revision.list",
      "revision.id",
      "clock.now",
    ])
      assert.equal(f.named(name).length, 1, name);
    assert.equal(f.inserts.length, 0, "normalization never performs the revision INSERT");
    const legacy = fixture();
    if (explicitBindings) legacy.metadata.secretBindings = {};
    const v1 = await deployV1(legacy);
    assert.equal(Object.hasOwn(v1, "secretBindings"), false);
    assert.equal(legacy.named("driver.secret").length, 0);
  }
});

test("deployment normalizer requires the actual V2 ServiceAccount before Configuration work", async () => {
  for (const associationMissing of [false, true]) {
    const f = fixture();
    const value = command();
    if (associationMissing) {
      delete f.agent.serviceAccountId;
      value.expectedDraft.serviceAccountId = null;
    } else f.account = undefined;
    await assert.rejects(normalizeV2(f, value), ScopeViolationError);
    assert.equal(f.named("configuration.lock").length, 0);
    assert.equal(f.named("driver.secret").length, 0);
    noCandidate(f);
  }
});

test("deployment normalizer compares every retained V2 draft operand before creating a candidate", async () => {
  for (const change of [
    (expected) => {
      expected.configurationId = id("cfg", 25);
    },
    (expected) => {
      expected.providerId = "provider/other";
    },
    (expected) => {
      expected.executionMode = "embedded";
    },
    (expected) => {
      expected.maximumExecutionMs = 7_200_000;
    },
    (expected) => {
      expected.serviceAccountId = id("sa", 26);
    },
    (expected) => {
      expected.workloadProfileSelection.manifestRef = uuid(27);
    },
    (expected) => {
      expected.workloadProfileSelection.manifestDigest = `sha256:${"b".repeat(64)}`;
    },
    (expected) => {
      expected.workloadProfileSelection.admissionRef = uuid(28);
    },
    (expected) => {
      expected.workloadProfileSelection.admissionVersion++;
    },
  ]) {
    const f = fixture();
    const value = command();
    change(value.expectedDraft);
    await assert.rejects(normalizeV2(f, value), ResourceConflictError);
    assert.equal(f.named("agent.lock").length, 1);
    assert.equal(f.named("head.find").length, 0);
    noCandidate(f);
  }
  const f = fixture();
  const value = command();
  value.expectedDraft.configurationGeneration++;
  await assert.rejects(normalizeV2(f, value), ResourceConflictError);
  assert.equal(f.named("configuration.lock").length, 1);
  assert.equal(f.named("configuration.read").length, 0);
  noCandidate(f);
});

function selectedService(f) {
  // Controlled original-interface participants exercise service call ordering.
  // No account/session or PostgreSQL ownership is established by this fixture.
  const invocation = Object.freeze({});
  const normalizer = createDeploymentCandidateNormalizerV2(f.options);
  const unit = {
    kind: "deployment",
    installationId,
    ...runtimeScope,
    operationRef,
    platform: f.repositories,
    signal: new AbortController().signal,
    retain() {
      assert.fail("This fixture refuses before acquiring a profile lease");
    },
  };
  const io = {
    assertActive() {
      f.record("io.assert");
    },
    poison(error) {
      f.record("io.poison", error);
    },
    async query() {
      assert.fail("Normalizer conformance does not execute SQL");
    },
  };
  const failure = new DependencyUnavailableError(
    "Controlled independent profile source is unavailable",
  );
  f.prepareFailure = failure;
  f.options.candidateNormalizer = normalizer;
  f.options.workloadProfiles = {
    invocations: {
      async forCurrentInvocation() {
        f.record("invocation");
        return invocation;
      },
    },
    enrollment: {
      async withDeployment(actual, binding, work) {
        f.record("enrollment", actual, binding);
        assert.equal(actual, invocation);
        f.binding = binding;
        return work(unit, io);
      },
      async withRecovery() {
        assert.fail("Original replay does not invoke recovery");
      },
    },
    candidates: {
      async withCandidate(actualUnit, actualIo, resolveHarness, work) {
        f.record("candidate.enter", actualUnit, actualIo, resolveHarness);
        assert.equal(actualUnit, unit);
        assert.equal(actualIo, io);
        assert.equal(resolveHarness, f.harness);
        const [actor, captured] = f.binding;
        f.normalized = await normalizer(
          [
            actor,
            {
              namespaceId: captured.namespaceId,
              agentId: captured.agentId,
              expectedLifecycleGeneration: captured.command.expectedLifecycleGeneration,
            },
            captured.command,
          ],
          resolveHarness,
          directOperations(f),
        );
        f.record("candidate.normalized", f.normalized);
        try {
          return await work(f.normalized);
        } finally {
          f.record("candidate.exit");
        }
      },
    },
    use: {
      async validateSelectionLocked() {
        assert.fail("Deployment requires candidate preparation");
      },
      async prepareUseLocked(...args) {
        f.record("use.prepare", ...args);
        throw f.prepareFailure;
      },
    },
  };
  f.service = new DeploymentService(f.options);
  f.deploy = (value = command(), admission = f.admission) =>
    f.service.deployAgentCommand(
      principalId,
      { ...runtimeScope, command: value },
      f.harness,
      admission,
    );
  return f;
}

test("deployment normalization continuation supplies its actual once-normalized candidate to profile preparation", async () => {
  const f = selectedService(fixture());
  await assert.rejects(f.deploy(), (error) => error === f.prepareFailure);
  assert.ok(Object.isFrozen(f.binding));
  assert.ok(Object.isFrozen(f.binding[1]));
  assert.deepEqual(plain(f.binding), [principalId, { ...runtimeScope, command: command() }]);
  const [request, candidate, unit, io] = f.named("use.prepare")[0].args;
  const [enteredUnit, enteredIo] = f.named("candidate.enter")[0].args;
  assert.equal(unit, enteredUnit);
  assert.equal(io, enteredIo);
  assert.equal(
    candidate,
    f.normalized.candidate,
    "The service must use the continuation's original candidate",
  );
  assert.deepEqual(plain(request), {
    schemaVersion: 2,
    installationId,
    ...runtimeScope,
    revisionId,
    configurationRef: configurationId,
    configurationVersion: 3,
    selection: selection(),
  });
  assert.equal(Object.hasOwn(candidate, "workloadProfileUse"), false);
  assert.deepEqual(plain(candidate.secretBindings), {});
  assert.equal(candidate.serviceAccount.id, serviceAccountId);
  for (const name of [
    "candidate.enter",
    "candidate.normalized",
    "candidate.exit",
    "namespace.lock",
    "agent.find",
    "agent.lock",
    "head.find",
    "account.lock",
    "configuration.lock",
    "configuration.read",
    "configuration.validate",
    "sandbox.configure",
    "revision.list",
    "revision.id",
    "clock.now",
    "use.prepare",
  ])
    assert.equal(f.named(name).length, 1, name);
  assert.equal(f.inserts.length, 0);
  assert.equal(f.named("audit.create").length, 0);
  const sequence = f.calls.map(({ name }) => name);
  assert.ok(sequence.indexOf("command.read") < sequence.indexOf("candidate.enter"));
  assert.ok(sequence.indexOf("configuration.validate") < sequence.indexOf("candidate.normalized"));
  assert.ok(sequence.indexOf("candidate.normalized") < sequence.indexOf("use.prepare"));
  assert.ok(sequence.indexOf("candidate.exit") < sequence.indexOf("io.poison"));
  assert.ok(f.poison.includes(f.prepareFailure));
});

test("deployment normalization continuation is required for a fresh V2 command and never falls back to direct operations", async () => {
  const f = selectedService(fixture());
  delete f.options.workloadProfiles.candidates;
  await assert.rejects(f.deploy(), DependencyUnavailableError);
  assert.equal(f.named("command.read").length, 1);
  assert.equal(f.named("namespace.lock").length, 0);
  assert.equal(f.named("driver.compute").length, 0);
  assert.equal(f.named("use.prepare").length, 0);
  noCandidate(f);
});

test("deployment normalization failure cannot enter profile preparation or publish a revision", async () => {
  const f = selectedService(fixture());
  const failure = new Error("controlled Configuration validation failure");
  f.failures.set("configuration.validate", failure);
  await assert.rejects(f.deploy(), (error) => error === failure);
  assert.equal(f.named("candidate.enter").length, 1);
  assert.equal(f.named("candidate.normalized").length, 0);
  assert.equal(f.named("use.prepare").length, 0);
  assert.ok(f.named("io.poison").some(({ args }) => args[0] === failure));
  assert.ok(f.poison.includes(failure));
  noCandidate(f);
});

test("deployment normalization stays bypassed by the original committed-command replay", async () => {
  const original = fixture();
  const normalized = await normalizeV2(original);
  const f = selectedService(fixture());
  // The original repository's correspondence decision is a controlled input.
  // A complete normalizer-produced AgentRevision keeps the operand realistic;
  // this test does not qualify committed command, Use or credential persistence.
  f.retained = normalized.candidate;
  f.retainedIntent = {
    ...runningHead(8),
    revisionId,
    transitionRef: operationRef,
    requestId: id("req", 29),
    createdAt: admittedAt,
  };
  delete f.options.workloadProfiles.candidates;
  f.options.providers.clear();
  delete f.agent.workloadProfileSelection;
  f.metadata.generation = 99;
  for (const name of [
    "namespace.lock",
    "agent.find",
    "agent.lock",
    "head.find",
    "account.lock",
    "configuration.lock",
    "configuration.read",
    "configuration.validate",
    "driver.compute",
    "driver.sandbox",
    "driver.secret",
    "driver.configuration",
    "harness.resolve",
    "candidate.enter",
    "use.prepare",
    "revision.id",
    "clock.now",
    "revision.insert",
    "audit.create",
  ])
    f.failures.set(name, new Error(`Replay attempted fresh ${name}`));
  const receipt = await f.deploy(command(), { ...f.admission, requireCredentialSelection: true });
  assert.deepEqual(plain(receipt), {
    disposition: "accepted",
    operation: {
      operationRef,
      lifecycleGeneration: 8,
      acceptedAt: admittedAt,
      kind: "deploy",
      revisionSource: "saved-draft",
      desiredMode: "running",
    },
  });
  assert.deepEqual(f.named("command.lock")[0].args, [runtimeScope, operationRef]);
  assert.deepEqual(plain(f.named("command.read")[0].args), [runtimeScope, command(), principalId]);
  assert.deepEqual(f.named("intent.find")[0].args, [runtimeScope, operationRef]);
  assert.deepEqual(f.named("authorize")[0].args, [
    principalId,
    "deploy",
    { kind: "agent", id: agentId, namespaceId },
  ]);
  assert.equal(f.named("authorize").length, 1);
  assert.equal(f.named("candidate.enter").length, 0);
  assert.equal(f.named("use.prepare").length, 0);
  noCandidate(f);
  assert.deepEqual(f.poison, []);
});

test("deployment normalization never retries an original command-replay conflict", async () => {
  const f = selectedService(fixture());
  const conflict = new ResourceConflictError("Controlled original command identity conflict");
  f.failures.set("command.read", conflict);
  await assert.rejects(f.deploy(), (error) => error === conflict);
  assert.equal(f.named("command.lock").length, 1);
  assert.equal(f.named("command.read").length, 1);
  assert.equal(f.named("candidate.enter").length, 0);
  assert.equal(f.named("namespace.lock").length, 0);
  assert.ok(f.poison.includes(conflict));
  noCandidate(f);
});

test("deployment normalization preserves the original nullable ProviderRef with an API-key ServiceAccount", async () => {
  for (const path of ["normalizer", "service"]) {
    const f = fixture();
    f.agent.providerId = null;
    f.options.providers.clear();
    let revision;
    if (path === "normalizer") {
      const result = await createDeploymentCandidateNormalizerV2(f.options)(
        [principalId, runtimeScope],
        f.harness,
        directOperations(f),
      );
      assert.equal(result.providerId, null);
      revision = result.candidate;
    } else revision = await deployV1(f);
    assert.equal(revision.providerId, null, path);
    assert.equal(revision.serviceAccount.id, serviceAccountId);
    assert.equal(revision.serviceAccount.credential.kind, "api_key");
    assert.equal(f.named("account.provider").length, 0);
    for (const name of ["configuration.read", "configuration.validate", "revision.id", "clock.now"])
      assert.equal(f.named(name).length, 1, `${path}: ${name}`);
    assert.equal(f.inserts.length, path === "service" ? 1 : 0);
  }
});
