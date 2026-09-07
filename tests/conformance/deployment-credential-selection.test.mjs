import assert from "node:assert/strict";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";
import { decodeCredentialWorkloadSelectionV1 } from "../../packages/contracts/src/credential-workload-selection-v1.ts";
import { DeploymentService } from "../../packages/occ/src/services/deployment/service.ts";
import { deriveAdmittedConfigurationV1 } from "../../packages/occ/src/workload-profiles/admitted-configuration.ts";
import { exampleCredentialWorkloadSelectionV1 } from "../fixtures/credential-workload-selection-v1/producer.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

// These controlled repositories and owner participants exercise the real service's
// orchestration only. They supply no authenticated producer/currentness evidence,
// durable persistence, transaction isolation, COMMIT acknowledgement or runtime.
// The audit predicate is a controlled accepting participant; this suite observes
// its exact operands but does not invoke or qualify the production audit predicate.
// In particular, unknown COMMIT requires the original storage integration suite.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const clone = (value) => structuredClone(value);
const time = "2026-09-07T06:00:00.000Z";
const installationId = id("ins", 1);
const namespaceId = id("ns", 2);
const agentId = id("agt", 3);
const revisionId = id("rev", 4);
const principalId = id("prn", 25);
const servicePrincipalId = id("prn", 26);
const configurationId = id("cfg", 27);
const serviceAccountId = id("sa", 28);
const secretId = id("sec", 29);
const transitionRef = uuid(30);
const requestId = id("req", 31);
const auditId = id("aud", 32);
const digest = (character) => `sha256:${character.repeat(64)}`;
const storePolicyBindings = () => [
  {
    component: "harness",
    name: "state",
    path: "/state/harness",
    store: { ref: "harness-state-policy", version: 2, contentDigest: digest("b") },
    access: "read-write",
  },
  {
    component: "gateway",
    name: "state",
    path: "/state/gateway",
    store: { ref: "gateway-state-policy", version: 1, contentDigest: digest("c") },
    access: "read-write",
  },
];

function configurationProjection(revision, record, stores) {
  return {
    manifestDigest: record.association.selection.manifestDigest,
    configurationRef: revision.configurationId,
    configurationGeneration: revision.configurationGeneration,
    immutableConfigurationContent: {
      kind: revision.configurationKind,
      values: revision.configuration,
      secretBindings: revision.secretBindings ?? {},
    },
    resolvedProfileBindingParameters: {
      installationId,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      serviceAccountAssociation: {
        servicePrincipalId: revision.servicePrincipalId,
        serviceAccount: revision.serviceAccount,
      },
      storePolicyBindings: stores,
      roleBindings: record.association.profileRefs,
    },
  };
}

function sandboxValues(values) {
  return { ...clone(values), tools: { allow: ["read"], fs: { workspaceOnly: true } } };
}

function fixture(settings = {}) {
  const events = [];
  const poison = [];
  const inserts = [];
  const authorization = [];
  const retained = [];
  const preparedContexts = [];
  const retainedContexts = [];
  const calls = {
    prepare: 0,
    verify: 0,
    release: 0,
    assertion: 0,
    validate: [],
    auditComparisons: [],
  };
  const source = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 3,
    values: createHarnessConfiguration("codex", "gpt-4.1"),
    secretBindings: {
      DATA_TOKEN: { source: { kind: "secret", namespaceId, id: secretId } },
    },
    createdAt: time,
  };
  const serviceAccount = {
    id: serviceAccountId,
    namespaceId,
    name: "model-account",
    credential: { kind: "api_key", secretRef: { name: "model-credential", key: "api-key" } },
  };
  const agent = {
    id: agentId,
    namespaceId,
    name: "agent",
    providerId: "provider/model",
    configurationId,
    serviceAccountId,
    servicePrincipalId,
    executionMode: "dedicated",
    createdAt: time,
  };
  const secret = {
    id: secretId,
    namespaceId,
    name: "data-token",
    driverId: "secret/example",
    backendRef: { name: "data-token", key: "api-key" },
  };
  const currentError = new Error("controlled original owner became unavailable");
  const control = {
    current: true,
    currentError,
    events,
    poison,
    inserts,
    authorization,
    retained,
    preparedContexts,
    retainedContexts,
    calls,
    source,
    serviceAccount,
    agent,
    secret,
    prepared: undefined,
    record: undefined,
  };
  async function point(name, value) {
    events.push(`${name}:start`);
    await settings.hooks?.[name]?.(control, value);
    events.push(`${name}:end`);
    return value;
  }
  const state = {
    namespaces: {
      async lockNamespace(target) {
        assert.equal(target, namespaceId);
        return point("namespace.lock", {
          id: namespaceId,
          name: "namespace",
          status: "ready",
          createdAt: time,
        });
      },
    },
    agents: {
      async findAgent(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, agentId);
        return point("agent.find", agent);
      },
      async lockAgent(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, agentId);
        return point("agent.lock", agent);
      },
    },
    configurations: {
      async lockConfiguration(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, configurationId);
        return point("configuration.lock", source);
      },
    },
    serviceAccounts: {
      async lockServiceAccount(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, serviceAccountId);
        return point("account.lock", serviceAccount);
      },
      async findServiceAccountProviderBinding() {
        assert.fail("API-key fixture does not invoke managed access-token binding");
      },
    },
    secrets: {
      async lockSecret(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, secretId);
        return point("secret.lock", secret);
      },
    },
    revisions: {
      async listRevisions(namespace, target) {
        assert.equal(namespace, namespaceId);
        assert.equal(target, agentId);
        return point("revision.list", []);
      },
      async createRevision(...operands) {
        // Capture the first INSERT operand without implementing storage validation.
        // Assertions below therefore observe what the real service passed.
        inserts.push(operands);
        return point("revision.insert", settings.returnRevision?.(operands[0]) ?? operands[0]);
      },
    },
    runtimeAssignments: {
      async findRuntimeIntentHead(target) {
        assert.deepEqual(target, { namespaceId, agentId });
        return point("intent.find", undefined);
      },
      async initializeRuntimeIntent(target, selectedRevision, operation, attribution) {
        assert.deepEqual(target, { namespaceId, agentId });
        assert.equal(selectedRevision, revisionId);
        assert.equal(operation, transitionRef);
        assert.deepEqual(attribution, { actorId: principalId, requestId });
        return point("intent.initialize", {
          installationId,
          ...target,
          generation: 1,
          transitionRef: operation,
          revisionId: selectedRevision,
          desiredMode: "running",
          ...attribution,
          createdAt: time,
        });
      },
      async advanceRuntimeIntent() {
        assert.fail("Fixture starts from no lifecycle head");
      },
    },
    audit: { append: async (value) => point("audit.append", value) },
    runtimeAdmissions: { recordAdmission: async (value) => point("admission.record", value) },
    operations: { append: async (value) => point("work.append", value) },
  };
  control.state = state;
  const producer = {
    async prepare(context) {
      calls.prepare++;
      preparedContexts.push(context);
      await point("selection.prepare", context);
      const record = exampleCredentialWorkloadSelectionV1();
      record.revisionId = context.revision.id;
      const stores = storePolicyBindings();
      record.association.admittedConfigurationDigest = deriveAdmittedConfigurationV1(
        configurationProjection(context.revision, record, stores),
      ).admittedConfigurationDigest;
      settings.changeRecord?.(record, context);
      settings.changeStores?.(stores);
      control.record = record;
      const prepared = {
        record,
        storePolicyBindings: stores,
        assertCurrent() {
          calls.assertion++;
          events.push("selection.assert");
          if (settings.assertCurrent) return settings.assertCurrent(control);
          if (!control.current) throw currentError;
          return undefined;
        },
        async verifyInserted() {
          calls.verify++;
          // This controlled participant reports success/failure only. It does not
          // reproduce the original producer's protected persistence comparison.
          await point("selection.verify", undefined);
        },
        async release() {
          calls.release++;
          await point("selection.release", undefined);
        },
      };
      control.prepared = prepared;
      settings.changePrepared?.(prepared, control);
      return prepared;
    },
    retain(context, guard) {
      events.push("selection.retain");
      // A refused synchronous enrollment must leave no registered participant.
      if (Object.hasOwn(settings, "retainFailure")) throw settings.retainFailure;
      retainedContexts.push(context);
      retained.push(guard);
      settings.onRetain?.(control, guard);
      return undefined;
    },
  };
  const secretDriver = {
    id: secret.driverId,
    implementation: "controlled-secret",
    async resolve(value) {
      assert.equal(value, secret);
      return point("secret.resolve", { ...secret.backendRef });
    },
  };
  const service = new DeploymentService({
    installationId,
    repositories: {
      async mutate(work) {
        events.push("callback:start");
        try {
          return await work(state);
        } finally {
          events.push("callback:end");
        }
      },
    },
    async recoveryRead() {
      assert.fail("Fresh admission does not invoke recovery");
    },
    hasActiveTransaction: () => true,
    poisonAdmission(error) {
      poison.push(error);
      events.push("owner.poison");
    },
    authorization: {
      async authorize(actor, action, resource) {
        authorization.push({ actor, action, resource: clone(resource) });
        await point("authorize", { actor, action, resource });
      },
    },
    computeDriver: () => ({ id: "compute/example", implementation: "controlled-compute" }),
    configurationDriver: () => ({
      id: "configuration/example",
      async read(target) {
        assert.deepEqual(target, { id: configurationId, namespaceId });
        return point("configuration.read", source);
      },
      async validate(value) {
        calls.validate.push(clone(value));
        await point("configuration.validate", value);
      },
    }),
    secretDriver: (expected) => {
      if (expected !== undefined) assert.equal(expected, secret.driverId);
      return secretDriver;
    },
    sandboxDriver: () => ({
      id: "sandbox/example",
      configureAgent(values) {
        events.push("sandbox.configure");
        return sandboxValues(values);
      },
    }),
    configurationOperation: async (operation) => operation(),
    secretOperation: async (operation) => operation(),
    providers: new Map([
      [
        "provider/model",
        {
          id: "provider/model",
          type: "chatgpt",
          configuration: { workspaceId: uuid(33), apiKeyPath: "/operator/model-key" },
          drivers: { service_account: "account/example" },
        },
      ],
    ]),
    loggingLevel: "warn",
    createId: () => revisionId,
    now: () => time,
    isRuntimeAdmissionAudit(event, intent) {
      // Observe service forwarding only; do not reproduce the production evaluator.
      calls.auditComparisons.push({ event: clone(event), intent: clone(intent) });
      return true;
    },
    ...(settings.noProducer ? {} : { credentialSelection: producer }),
  });
  control.service = service;
  control.admission = {
    transitionRef,
    requestId,
    ...(settings.legacy ? {} : { requireCredentialSelection: true }),
    createAuditEvent(revision) {
      events.push("audit.create");
      settings.onAudit?.(control);
      if (settings.auditError) throw settings.auditError;
      return {
        id: auditId,
        installationId,
        namespaceId,
        occurredAt: time,
        kind: "mutation",
        actorId: principalId,
        requestId,
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revision.id, namespaceId },
        outcome: "success",
      };
    },
  };
  control.deploy = () =>
    service.deployAgent(
      principalId,
      { namespaceId, agentId, expectedLifecycleGeneration: null },
      (harness, mode) => {
        assert.equal(harness, "codex");
        assert.equal(mode, "dedicated");
        return { id: "codex", version: "test-version" };
      },
      control.admission,
    );
  // An explicit controlled original-owner terminal participant. Tests invoke this
  // after callback return; it is not a substitute for an actual transaction runner.
  control.finish = async () => {
    events.push("owner.terminal:start");
    try {
      for (const guard of retained) guard.assertCurrent();
    } finally {
      for (const guard of retained) await guard.release();
      events.push("owner.terminal:end");
    }
  };
  return control;
}

function precedes(events, first, second) {
  assert.notEqual(events.indexOf(first), -1, first);
  assert.notEqual(events.indexOf(second), -1, second);
  assert.ok(events.indexOf(first) < events.indexOf(second), `${first} precedes ${second}`);
}
function noEvent(control, name) {
  assert.equal(control.events.includes(name), false, name);
}
async function finishRefused(control) {
  // A poisoned/unverified participant may also refuse its terminal fence. The
  // cleanup obligation remains testable independently of that original refusal.
  await Promise.allSettled([control.finish()]);
  assert.equal(control.calls.release, 1);
}

function retarget(record, field, value) {
  for (const scope of [
    record.scope,
    record.model.scope,
    record.model.profile.scope,
    record.model.binding.scope,
    record.repository.profile.scope,
    record.repository.binding.scope,
  ]) {
    scope[field] = value;
  }
  assert.equal(decodeCredentialWorkloadSelectionV1(record).kind, "valid");
}

test("required selection is complete in the first immutable INSERT operand with normalized configuration and exact current operands", async () => {
  const control = fixture();
  const revision = await control.deploy();
  assert.equal(control.inserts.length, 1);
  const [candidate, record] = control.inserts[0];
  assert.equal(control.inserts[0].length, 2);
  assert.equal(candidate, revision);
  assert.deepEqual(record, control.record);
  assert.notEqual(record, control.record);
  assert.equal(decodeCredentialWorkloadSelectionV1(record).kind, "valid");
  assert.deepEqual(record.scope, { installationId, namespaceId, agentId });
  assert.equal(record.revisionId, candidate.id);
  assert.equal(Object.hasOwn(candidate, "credentialWorkloadSelection"), false);
  assert.equal(Object.hasOwn(candidate, "credential_workload_selection"), false);
  const expectedValues = admitLoggingConfiguration(sandboxValues(control.source.values), "warn");
  assert.deepEqual(candidate.configuration, expectedValues);
  assert.deepEqual(control.calls.validate[0].values, expectedValues);
  assert.equal(control.source.values.logging, undefined);
  assert.equal(candidate.configuration.logging.consoleStyle, "json");
  assert.equal(candidate.configuration.diagnostics.otel.logs, false);
  assert.deepEqual(candidate.serviceAccount, {
    id: serviceAccountId,
    credential: control.serviceAccount.credential,
  });
  assert.equal(candidate.secretBindings.DATA_TOKEN.delivery.type, "env");
  const expectedProjection = configurationProjection(
    {
      configurationId,
      configurationGeneration: 3,
      configurationKind: "agent",
      configuration: expectedValues,
      secretBindings: candidate.secretBindings,
      namespaceId,
      agentId,
      servicePrincipalId,
      serviceAccount: { id: serviceAccountId, credential: control.serviceAccount.credential },
    },
    exampleCredentialWorkloadSelectionV1(),
    storePolicyBindings(),
  );
  assert.equal(
    record.association.admittedConfigurationDigest,
    deriveAdmittedConfigurationV1(expectedProjection).admittedConfigurationDigest,
  );
  assert.notEqual(
    record.association.admittedConfigurationDigest,
    record.association.selection.manifestDigest,
  );
  assert.deepEqual(record.materialSelection, { recordRef: "selection/example", recordVersion: 1 });
  assert.equal(record.channels.length, 2);
  assert.deepEqual(Object.keys(record.association.profileRefs), [
    "provider",
    "runtime",
    "identity",
    "containment",
    "storage",
  ]);
  assert.deepEqual(control.authorization, [
    { actor: principalId, action: "deploy", resource: { kind: "agent", id: agentId, namespaceId } },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "service_account", id: serviceAccountId, namespaceId },
    },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "configuration", id: configurationId, namespaceId },
    },
    {
      actor: principalId,
      action: "operate",
      resource: { kind: "secret", namespaceId, id: secretId },
    },
    {
      actor: servicePrincipalId,
      action: "operate",
      resource: { kind: "secret", id: secretId, namespaceId },
    },
  ]);
  const context = control.preparedContexts[0];
  assert.deepEqual(
    {
      installationId: context.installationId,
      principalId: context.principalId,
      transitionRef: context.transitionRef,
      requestId: context.requestId,
    },
    { installationId, principalId, transitionRef, requestId },
  );
  assert.equal(context.revision, candidate);
  assert.equal(context.repositories, control.state);
  assert.equal(control.retainedContexts[0], context);
  assert.equal(control.retained.length, 1);
  assert.equal(control.calls.verify, 1);
  assert.equal(control.calls.release, 0);
  assert.deepEqual(control.poison, []);
  assert.deepEqual(control.calls.auditComparisons, [
    {
      event: {
        id: auditId,
        installationId,
        namespaceId,
        occurredAt: time,
        kind: "mutation",
        actorId: principalId,
        requestId,
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revisionId, namespaceId },
        outcome: "success",
      },
      intent: {
        installationId,
        namespaceId,
        agentId,
        generation: 1,
        transitionRef,
        revisionId,
        desiredMode: "running",
        actorId: principalId,
        requestId,
        createdAt: time,
      },
    },
  ]);
  for (const [first, second] of [
    ["configuration.validate:end", "selection.prepare:start"],
    ["selection.retain", "revision.insert:start"],
    ["revision.insert:end", "selection.verify:start"],
    ["selection.verify:end", "audit.create"],
    ["selection.verify:end", "intent.initialize:start"],
    ["intent.initialize:end", "audit.append:start"],
    ["audit.append:end", "admission.record:start"],
    ["admission.record:end", "work.append:start"],
  ])
    precedes(control.events, first, second);
  control.record.model.accountLink.version++;
  control.record.channels[0].bot.version++;
  assert.equal(record.model.accountLink.version, 1);
  assert.equal(record.channels[0].bot.version, 1);
  for (const value of [
    candidate,
    candidate.configuration,
    candidate.serviceAccount,
    record,
    record.association,
    record.association.profileRefs,
    record.model,
    record.channels,
  ]) {
    assert.ok(Object.isFrozen(value));
  }
  await control.finish();
  assert.equal(control.calls.release, 1);
  precedes(control.events, "callback:end", "owner.terminal:start");
  precedes(control.events, "owner.terminal:start", "selection.release:start");
});

test("bodyless legacy omission needs no selection producer and keeps its original INSERT signature", async () => {
  for (const noProducer of [true, false]) {
    const control = fixture({ legacy: true, noProducer });
    await control.deploy();
    assert.equal(control.inserts.length, 1);
    assert.equal(control.inserts[0].length, 1);
    assert.deepEqual(control.poison, []);
    assert.equal(control.calls.prepare, 0);
    assert.equal(control.retained.length, 0);
    noEvent(control, "selection.verify:start");
  }
});

test("missing required producer and malformed trusted requirements poison before INSERT", async () => {
  const missing = fixture({ noProducer: true });
  await assert.rejects(missing.deploy());
  assert.equal(missing.inserts.length, 0);
  assert.ok(missing.poison.length > 0);
  for (const value of [false, null, 1, "true", undefined]) {
    const control = fixture();
    control.admission.requireCredentialSelection = value;
    await assert.rejects(control.deploy());
    assert.equal(control.inserts.length, 0);
    assert.ok(control.poison.length > 0);
    assert.equal(control.calls.prepare, 0);
  }
});

test("malformed records, valid foreign scope or revision, and unrelated digest domains deny before INSERT", async () => {
  const mutations = [
    (record) => {
      record.extra = true;
    },
    (record) => {
      record.schemaVersion = 2;
    },
    (record) => {
      record.revisionId = id("rev", 40);
    },
    (record) => retarget(record, "installationId", id("ins", 40)),
    (record) => retarget(record, "namespaceId", id("ns", 40)),
    (record) => retarget(record, "agentId", id("agt", 40)),
    (record) => {
      record.association.profileRefs.storage.ref = record.association.profileRefs.runtime.ref;
    },
    (record) => {
      record.association.admittedConfigurationDigest = record.association.selection.manifestDigest;
    },
    (record) => {
      record.association.admittedConfigurationDigest = digest("f");
    },
    (record) => {
      record.association.selection.manifestDigest = digest("f");
    },
    (record) => {
      record.association.profileRefs.storage.version++;
    },
    (record) => {
      record.model.binding.account.version++;
    },
  ];
  for (const changeRecord of mutations) {
    const control = fixture({ changeRecord });
    await assert.rejects(control.deploy());
    assert.equal(control.inserts.length, 0);
    assert.ok(control.poison.length > 0);
    assert.equal(control.calls.verify, 0);
    assert.equal(control.calls.release, 0);
    await finishRefused(control);
  }
});

test("valid foreign model provider and managed-token setup cannot substitute for actual API-key ServiceAccount operands", async () => {
  for (const changeRecord of [
    (record) => {
      record.model.profile.providerId = "provider/other";
      record.model.binding.providerId = "provider/other";
      assert.equal(decodeCredentialWorkloadSelectionV1(record).kind, "valid");
    },
    (record) => {
      record.model.profile.credentialClass = "trusted-login";
      record.model.setup = {
        kind: "trusted-login",
        invocationMaterial: "access-token-and-account-context",
        refreshOwnerRef: "refresh/example",
        lifecycleProfile: { ref: "lifecycle/model", version: 1, digest: digest("a") },
      };
      assert.equal(decodeCredentialWorkloadSelectionV1(record).kind, "valid");
    },
  ]) {
    const control = fixture({ changeRecord });
    await assert.rejects(control.deploy());
    assert.equal(control.inserts.length, 0);
    assert.ok(control.poison.length > 0);
    await finishRefused(control);
  }
});

test("logical store bindings and actual ServiceAccount association contribute to the original configuration digest", async () => {
  for (const changeStores of [
    (stores) => {
      stores[0].store.version++;
    },
    (stores) => {
      stores[0].path = "/state/changed";
    },
    (stores) => {
      stores[0].physicalVolume = "not-a-logical-binding";
    },
  ]) {
    const control = fixture({ changeStores });
    await assert.rejects(control.deploy());
    assert.equal(control.inserts.length, 0);
    assert.ok(control.poison.length > 0);
    await finishRefused(control);
  }
  const control = fixture({
    changeRecord(record, context) {
      const changed = clone(context.revision);
      changed.serviceAccount.credential.secretRef.key = "different-key";
      record.association.admittedConfigurationDigest = deriveAdmittedConfigurationV1(
        configurationProjection(changed, record, storePolicyBindings()),
      ).admittedConfigurationDigest;
    },
  });
  await assert.rejects(control.deploy());
  assert.equal(control.inserts.length, 0);
  await finishRefused(control);
});

test("failed provisional INSERT verification poisons even a caught service error and precedes all admission writes", async () => {
  const failure = new Error("controlled original protected row comparison failed");
  const control = fixture({
    hooks: {
      "selection.verify": () => {
        throw failure;
      },
    },
  });
  let caught;
  try {
    await control.deploy();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(control.inserts.length, 1);
  assert.equal(control.calls.verify, 1);
  assert.ok(control.poison.length > 0);
  assert.equal(control.poison[0], caught);
  for (const event of [
    "audit.create",
    "intent.initialize:start",
    "audit.append:start",
    "admission.record:start",
    "work.append:start",
  ])
    noEvent(control, event);
  assert.equal(control.calls.release, 0);
  await finishRefused(control);
});

test("loss of currentness before INSERT is fenced and retained for terminal cleanup", async () => {
  const control = fixture({
    onRetain(value) {
      value.current = false;
    },
  });
  await assert.rejects(control.deploy());
  assert.equal(control.inserts.length, 0);
  assert.equal(control.calls.verify, 0);
  assert.ok(control.poison.length > 0);
  assert.equal(control.calls.release, 0);
  await assert.rejects(control.finish());
  assert.equal(control.calls.release, 1);
});

test("currentness lost during the synchronous audit factory is refused before the next intent await", async () => {
  const control = fixture({
    onAudit(value) {
      value.current = false;
    },
  });
  await assert.rejects(control.deploy());
  assert.equal(control.inserts.length, 1);
  assert.equal(control.calls.verify, 1);
  assert.ok(control.poison.length > 0);
  noEvent(control, "intent.initialize:start");
  assert.equal(control.calls.release, 0);
  await assert.rejects(control.finish());
  assert.equal(control.calls.release, 1);
});

test("current authorization and normalized configuration validation failures precede selection preparation", async () => {
  for (const hooks of [
    {
      authorize(_control, request) {
        if (request.actor === principalId && request.resource.kind === "configuration")
          throw new Error("controlled current authorization denial");
      },
    },
    {
      "configuration.validate": () => {
        throw new Error("controlled native validation failure");
      },
    },
  ]) {
    const control = fixture({ hooks });
    await assert.rejects(control.deploy());
    assert.ok(control.poison.length > 0);
    assert.equal(control.calls.prepare, 0);
    assert.equal(control.inserts.length, 0);
    assert.equal(control.retained.length, 0);
  }
});

test("every later await is followed by a currentness fence before advancing admission", async () => {
  for (const [boundary, forbidden] of [
    ["revision.insert", "selection.verify:start"],
    ["selection.verify", "audit.create"],
    ["intent.initialize", "audit.append:start"],
    ["audit.append", "admission.record:start"],
    ["admission.record", "work.append:start"],
    ["work.append", "owner.terminal:start"],
  ]) {
    const control = fixture({
      hooks: {
        [boundary]: (value) => {
          value.current = false;
        },
      },
    });
    await assert.rejects(control.deploy());
    assert.ok(control.poison.length > 0);
    noEvent(control, forbidden);
    assert.equal(control.calls.release, 0);
    await assert.rejects(control.finish());
    assert.equal(control.calls.release, 1);
  }
});

test("retained final guard refuses currentness loss in the callback-to-terminal gap", async () => {
  const control = fixture();
  await control.deploy();
  assert.equal(control.calls.release, 0);
  assert.equal(control.retained.length, 1);
  control.current = false;
  await assert.rejects(control.finish());
  assert.equal(control.calls.release, 1);
  // Invoke the enrolled service guard again to observe release-once semantics.
  await control.retained[0].release();
  assert.equal(control.calls.release, 1);
});

test("original admission callback and participant errors still poison after caller catch", async () => {
  for (const settings of [
    { auditError: new Error("controlled audit factory failed") },
    {
      hooks: {
        "revision.insert": () => {
          throw new Error("controlled insert failure");
        },
      },
    },
    {
      hooks: {
        "work.append": () => {
          throw new Error("controlled work failure");
        },
      },
    },
  ]) {
    const control = fixture(settings);
    let caught;
    await control.deploy().catch((error) => {
      caught = error;
    });
    assert.ok(caught);
    assert.ok(control.poison.length > 0);
    assert.ok(control.poison.every((error) => error === caught));
    assert.equal(control.calls.release, 0);
    await finishRefused(control);
  }
});

test("missing or throwing prepared method preserves known local acquisition cleanup before refusal", async () => {
  for (const changePrepared of [
    (prepared) => {
      delete prepared.verifyInserted;
    },
    (prepared) => {
      Object.defineProperty(prepared, "verifyInserted", {
        get() {
          throw new Error("controlled method acquisition failure");
        },
      });
    },
  ]) {
    const control = fixture({ changePrepared });
    await assert.rejects(control.deploy());
    assert.equal(control.inserts.length, 0);
    assert.equal(control.retained.length, 0);
    assert.equal(control.calls.release, 1);
    assert.ok(control.poison.length > 0);
    await control.finish();
    assert.equal(control.calls.release, 1);
  }
});

test("local cleanup rejection preserves the original acquisition or refused-retention failure", async () => {
  for (const failurePoint of ["verify-getter", "verify-method", "retain"]) {
    for (const cleanupFailure of [new Error("controlled cleanup rejection"), undefined]) {
      const originalFailure = new Error(`controlled ${failurePoint} rejection`);
      const control = fixture({
        ...(failurePoint === "retain" ? { retainFailure: originalFailure } : {}),
        changePrepared(prepared) {
          const release = prepared.release;
          prepared.release = async function () {
            // Execute the actual fixture cleanup exactly once, then report its
            // separate failure. This does not manufacture a successful cleanup.
            await release.call(this);
            throw cleanupFailure;
          };
          if (failurePoint === "verify-getter") {
            Object.defineProperty(prepared, "verifyInserted", {
              get() {
                throw originalFailure;
              },
            });
          } else if (failurePoint === "verify-method") {
            prepared.verifyInserted = undefined;
          }
        },
      });
      let outwardFailure;
      await assert.rejects(control.deploy(), (error) => {
        outwardFailure = error;
        return true;
      });
      // The first poison observation is the acquisition failure, before release.
      // A missing method creates that original error inside the real service.
      assert.ok(outwardFailure instanceof Error);
      assert.equal(outwardFailure, control.poison[0]);
      if (failurePoint !== "verify-method") assert.equal(outwardFailure, originalFailure);
      assert.notEqual(outwardFailure, cleanupFailure);
      assert.ok(control.poison.includes(outwardFailure));
      assert.ok(control.poison.includes(cleanupFailure));
      assert.equal(control.inserts.length, 0);
      assert.equal(control.calls.verify, 0);
      assert.equal(control.retained.length, 0);
      assert.equal(control.retainedContexts.length, 0);
      assert.equal(control.calls.release, 1);
      assert.equal(control.events.includes("selection.retain"), failurePoint === "retain");
      await control.finish();
      assert.equal(control.calls.release, 1);
    }
  }
});

test("a returned public revision with an injected protected sibling is refused before intent", async () => {
  const control = fixture({
    returnRevision(candidate) {
      return { ...candidate, credentialWorkloadSelection: exampleCredentialWorkloadSelectionV1() };
    },
  });
  await assert.rejects(control.deploy());
  assert.equal(control.inserts.length, 1);
  assert.ok(control.poison.length > 0);
  assert.equal(control.calls.verify, 0);
  noEvent(control, "audit.create");
  noEvent(control, "intent.initialize:start");
  assert.equal(control.calls.release, 0);
  await finishRefused(control);
});

for (const rejectingAssertion of [1, 2]) {
  test(`invalid asynchronous assertion ${rejectingAssertion} drains under the current cleanup owner`, async () => {
    let settle;
    let observed;
    let settled = false;
    const started = new Promise((resolve) => {
      observed = resolve;
    });
    const assertion = new Promise((_, reject) => {
      settle = () => {
        settled = true;
        reject(new Error("controlled late assertion failure"));
      };
    });
    const control = fixture({
      assertCurrent(value) {
        if (value.calls.assertion !== rejectingAssertion) return undefined;
        observed();
        return assertion;
      },
    });
    const refused = assert.rejects(control.deploy());
    await started;
    assert.equal(control.inserts.length, 0);
    assert.equal(control.calls.release, 0);
    if (rejectingAssertion === 1) {
      // Before transfer, deploy rejection waits for the locally owned release.
      assert.equal(control.retained.length, 0);
      settle();
      await refused;
    } else {
      // After transfer, callback rejection leaves pending work with terminal cleanup.
      await refused;
      assert.equal(control.retained.length, 1);
      const cleanup = assert.rejects(control.finish());
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(control.calls.release, 0);
      settle();
      await cleanup;
    }
    assert.equal(settled, true);
    assert.ok(control.poison.length > 0);
    assert.equal(control.calls.release, 1);
  });
}
