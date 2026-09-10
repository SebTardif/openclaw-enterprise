import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { freezeAgentRevision } from "../../packages/contracts/src/resources/agent.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";
import { JsonValue } from "../../packages/contracts/src/api/common.ts";
import {
  CreateAgentBody,
  UpdateAgentBody,
  AgentSchema,
  AgentRevisionSchema,
} from "../../packages/contracts/src/api/agent/resources.ts";
import { agentApiRoutes } from "../../packages/contracts/src/api/agent/routes.ts";
import {
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV2,
} from "../../packages/contracts/src/workload-profile-v1.ts";
import { AgentService } from "../../packages/occ/src/services/agent/service.ts";
import { frozenRevision } from "../../packages/occ/src/services/deployment/configuration.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

// The real schemas, freezers, service and handler projections run with bounded
// declared data and controlled repository/authority participants. These tests do
// not establish an authenticated active profile, durable admission or runtime use.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const clone = (value) => structuredClone(value);
const installationId = id("ins", 1);
const namespaceId = id("ns", 2);
const agentId = id("agt", 3);
const revisionId = id("rev", 4);
const configurationId = id("cfg", 5);
const principalId = id("prn", 6);
const servicePrincipalId = id("prn", 7);
const serviceAccountId = id("sa", 8);
const nextServiceAccountId = id("sa", 9);
const secretId = id("sec", 10);
const requestId = id("req", 11);
const time = "2026-09-07T08:00:00.000Z";
const selection = (version = 1) => ({
  manifestRef: uuid(20),
  manifestDigest: digest("a"),
  admissionRef: uuid(21),
  admissionVersion: version,
});
function use() {
  const value = {
    schemaVersion: 2,
    installationId,
    namespaceId,
    component: "gateway-harness-pair",
    ...selection(),
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    profileRefs: Object.fromEntries(
      ["provider", "runtime", "identity", "containment", "storage"].map((role, index) => [
        role,
        { ref: uuid(30 + index), version: index + 1, contentDigest: digest(String(index + 1)) },
      ]),
    ),
    admittedConfigurationDigest: digest("b"),
  };
  assert.equal(decodeWorkloadProfileUseV2(value).kind, "valid");
  return value;
}
function revision(withUse = true) {
  return {
    id: revisionId,
    namespaceId,
    agentId,
    revision: 1,
    maximumExecutionMs: null,
    providerId: null,
    configurationId,
    configurationKind: "agent",
    configurationGeneration: 3,
    configuration: admitLoggingConfiguration(
      createHarnessConfiguration("codex", "gpt-4.1"),
      "info",
    ),
    harness: { id: "codex", version: "test-version", mode: "dedicated" },
    compute: { id: "compute/example", implementation: "controlled-compute" },
    servicePrincipalId,
    ...(withUse ? { workloadProfileUse: use() } : {}),
    createdAt: time,
  };
}
function agent(withSelection = true) {
  return {
    id: agentId,
    namespaceId,
    name: "agent",
    configurationId,
    providerId: null,
    serviceAccountId,
    executionMode: "dedicated",
    maximumExecutionMs: null,
    servicePrincipalId,
    activeRevisionId: revisionId,
    ...(withSelection ? { workloadProfileSelection: selection() } : {}),
    createdAt: time,
  };
}
const check = (schema, value) => Check({ SafeJsonValue: JsonValue }, schema, value);

test("Agent receiver preserves the selected update operand across its callback", async (t) => {
  const { createAgentOperationHandlers } =
    await import("../../apps/controller/src/routes/agent.ts");
  const operation = agentApiRoutes.find((route) => route.operationId === "updateAgent");
  const stop = new Error("controlled service observation ends before profile enrollment");
  for (const selected of [true, false]) {
    const control = fixture();
    const body = {
      configurationId,
      providerId: null,
      executionMode: "dedicated",
      serviceAccountId: null,
      ...(selected ? { workloadProfileSelection: selection() } : {}),
    };
    const expected = clone({ namespaceId, agentId, ...body });
    let entered = 0,
      serviceCalls = 0,
      selectedOperand;
    t.mock.method(control.service, "updateAgent", async (actor, input) => {
      serviceCalls += 1;
      assert.equal(actor, principalId);
      assert.deepEqual(clone(input), expected);
      assert.ok(Object.isFrozen(input));
      if (selected) {
        assert.equal(input, selectedOperand);
        assert.ok(Object.isFrozen(input.workloadProfileSelection));
      }
      throw stop;
    });
    const context = { actorId: principalId };
    const request = { id: requestId, params: { namespaceId, agentId }, body };
    const handlers = createAgentOperationHandlers({
      resolveAgentService: () => control.service,
      requestContext: () => context,
      async runAgentMutation(actual, route, actor, mutate, _resource, _project, selectedUpdate) {
        entered += 1;
        assert.equal(actual, request);
        assert.equal(route, operation);
        assert.equal(actor, context);
        selectedOperand = selectedUpdate;
        assert.deepEqual(clone(selectedUpdate), selected ? expected : undefined);
        body.configurationId = id("cfg", 90);
        body.providerId = "provider-mutated";
        body.serviceAccountId = id("sa", 91);
        if (selected) body.workloadProfileSelection.admissionVersion = 999;
        await Promise.resolve();
        return mutate();
      },
      async runDeployment() {
        assert.fail("update cannot enter deployment");
      },
    });
    const reply = {
      send() {
        assert.fail("observed service failure cannot send success");
      },
    };
    await assert.rejects(
      handlers.updateAgent(request, reply, operation),
      (error) => error === stop,
    );
    assert.equal(entered, 1);
    assert.equal(serviceCalls, 1);
    request.body = { configurationId, workloadProfileSelection: null };
    await assert.rejects(handlers.updateAgent(request, reply, operation));
    assert.equal(entered, 1, "malformed selection must fail before the mutation wrapper");
    assert.equal(serviceCalls, 1);
  }
});

for (const [name, freeze] of [
  ["contract", freezeAgentRevision],
  ["deployment", frozenRevision],
]) {
  test(`${name} revision freezer detaches all nested original Use V2 roles and preserves absence`, () => {
    const source = revision();
    const expected = clone(source.workloadProfileUse);
    const result = freeze(source);
    assert.deepEqual(result.workloadProfileUse, expected);
    assert.notEqual(result.workloadProfileUse, source.workloadProfileUse);
    assert.notEqual(result.workloadProfileUse.profileRefs, source.workloadProfileUse.profileRefs);
    for (const role of Object.keys(expected.profileRefs)) {
      assert.notEqual(
        result.workloadProfileUse.profileRefs[role],
        source.workloadProfileUse.profileRefs[role],
      );
      assert.ok(Object.isFrozen(result.workloadProfileUse.profileRefs[role]));
      source.workloadProfileUse.profileRefs[role].version++;
    }
    source.workloadProfileUse.admissionVersion++;
    source.workloadProfileUse.admittedConfigurationDigest = digest("c");
    assert.deepEqual(result.workloadProfileUse, expected);
    assert.ok(Object.isFrozen(result.workloadProfileUse));
    assert.ok(Object.isFrozen(result.workloadProfileUse.profileRefs));
    assert.throws(() => {
      result.workloadProfileUse.profileRefs.runtime.version++;
    }, TypeError);
    assert.equal(decodeWorkloadProfileUseV2(result.workloadProfileUse).kind, "valid");
    const historical = freeze(revision(false));
    assert.equal(Object.hasOwn(historical, "workloadProfileUse"), false);
  });
}

test("Agent update schema carries only optional original Selection while create retains its narrower contract", () => {
  const body = { configurationId, workloadProfileSelection: selection() };
  assert.equal(check(UpdateAgentBody, body), true);
  assert.equal(decodeWorkloadProfileSelectionV1(body.workloadProfileSelection).kind, "valid");
  assert.equal(check(UpdateAgentBody, { configurationId }), true);
  const create = { name: "new-agent", configurationId };
  assert.equal(check(CreateAgentBody, create), true);
  assert.equal(check(CreateAgentBody, { ...create, workloadProfileSelection: selection() }), false);
  for (const value of [
    null,
    {},
    { ...selection(), admissionVersion: 0 },
    { ...selection(), profileRef: uuid(40) },
  ]) {
    assert.equal(check(UpdateAgentBody, { ...body, workloadProfileSelection: value }), false);
  }
  for (const field of [
    "installationId",
    "namespaceId",
    "agentId",
    "workloadProfileUse",
    "credentialWorkloadSelection",
  ]) {
    assert.equal(check(UpdateAgentBody, { ...body, [field]: {} }), false);
  }
  const updateRoute = agentApiRoutes.find((route) => route.operationId === "updateAgent");
  assert.equal(updateRoute.method, "PATCH");
  assert.equal(updateRoute.path, "/namespaces/:namespaceId/agents/:agentId");
  assert.equal(updateRoute.schema.body, UpdateAgentBody);
  assert.equal(updateRoute.iamAction, "update");
});

test("public Agent and revision wire schemas include exact Selection or Use and reject protected credential siblings", () => {
  const { servicePrincipalId: _agentPrincipal, ...agentWire } = agent();
  const { servicePrincipalId: _revisionPrincipal, ...revisionWire } = revision();
  assert.equal(check(AgentSchema, agentWire), true);
  assert.equal(check(AgentRevisionSchema, revisionWire), true);
  assert.deepEqual(revisionWire.workloadProfileUse, use());
  for (const [schema, value] of [
    [AgentSchema, agentWire],
    [AgentRevisionSchema, revisionWire],
  ]) {
    for (const field of [
      "credentialWorkloadSelection",
      "credential_workload_selection",
      "servicePrincipalId",
      "selected",
    ]) {
      assert.equal(check(schema, { ...value, [field]: {} }), false);
    }
  }
  for (const wrong of [
    { ...use(), schemaVersion: 1, component: "harness" },
    { ...use(), component: "harness" },
    { ...use(), materialSelection: { recordRef: "selection/example", recordVersion: 1 } },
  ]) {
    assert.equal(check(AgentRevisionSchema, { ...revisionWire, workloadProfileUse: wrong }), false);
  }
  const { workloadProfileUse: _use, ...historicalWire } = revisionWire;
  assert.equal(check(AgentRevisionSchema, historicalWire), true);
  assert.equal(Object.hasOwn(historicalWire, "workloadProfileUse"), false);
});

function fixture(settings = {}) {
  const calls = {
    authorize: [],
    canRead: [],
    update: [],
    create: [],
    secretOwners: [],
    events: [],
  };
  const stored = agent(settings.selected !== false);
  const returned = settings.returnedAgent ?? stored;
  const declaredRevision = revision();
  const configuration = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 3,
    createdAt: time,
    secretBindings: {
      DATA_TOKEN: { source: { kind: "secret", namespaceId, id: secretId } },
    },
  };
  const namespace = { id: namespaceId, name: "namespace", status: "ready", createdAt: time };
  const state = {
    namespaces: {
      async lockNamespace(target) {
        calls.events.push("namespace.lock");
        return target === namespaceId && !settings.missingNamespace ? namespace : undefined;
      },
      async findNamespace(target) {
        return target === namespaceId && !settings.missingNamespace ? namespace : undefined;
      },
    },
    agents: {
      async lockAgent(targetNamespace, targetAgent) {
        calls.events.push("agent.lock");
        return targetNamespace === namespaceId && targetAgent === agentId && !settings.missingAgent
          ? stored
          : undefined;
      },
      async findAgent(targetNamespace, targetAgent) {
        return targetNamespace === namespaceId && targetAgent === agentId && !settings.missingAgent
          ? stored
          : undefined;
      },
      async listAgents(targetNamespace) {
        assert.equal(targetNamespace, namespaceId);
        return [stored];
      },
      async updateConfiguration(...operands) {
        calls.events.push("agent.update");
        calls.update.push(operands);
        // This declared repository response does not implement storage replacement
        // or omission semantics. Tests inspect the actual service's write operands.
        return settings.updateMissing ? undefined : returned;
      },
      async createAgent(value) {
        calls.events.push("agent.create");
        calls.create.push(value);
        return value;
      },
    },
    configurations: {
      async findConfiguration(targetNamespace, target) {
        calls.events.push("configuration.find");
        return targetNamespace === namespaceId &&
          target === configurationId &&
          !settings.missingConfiguration
          ? configuration
          : undefined;
      },
    },
    serviceAccounts: {
      async findServiceAccount(targetNamespace, target) {
        calls.events.push(`account.find:${target}`);
        return targetNamespace === namespaceId &&
          [serviceAccountId, nextServiceAccountId].includes(target) &&
          settings.missingAccount !== target
          ? { id: target, namespaceId, name: "service-account" }
          : undefined;
      },
    },
    secrets: {
      async lockSecret(targetNamespace, target) {
        calls.events.push("secret.lock");
        return targetNamespace === namespaceId && target === secretId && !settings.missingSecret
          ? {
              id: secretId,
              namespaceId,
              name: "data-token",
              driverId: "secret/example",
              backendRef: { name: "data-token", key: "token" },
              createdAt: time,
            }
          : undefined;
      },
    },
    revisions: {
      async listRevisions(targetNamespace, targetAgent) {
        assert.equal(targetNamespace, namespaceId);
        assert.equal(targetAgent, agentId);
        return [declaredRevision];
      },
      async findRevision(targetNamespace, targetAgent, targetRevision) {
        return targetNamespace === namespaceId &&
          targetAgent === agentId &&
          targetRevision === revisionId
          ? declaredRevision
          : undefined;
      },
    },
  };
  const options = {
    installationId,
    repositories: {
      async mutate(work) {
        return work(state);
      },
      async read(work) {
        return work(state);
      },
    },
    authorization: {
      async authorize(actor, action, resource) {
        calls.authorize.push({ actor, action, resource: clone(resource) });
        if (settings.deny?.({ actor, action, resource }))
          throw new Error("controlled exact authorization denied");
      },
      async canRead(actor, resource) {
        calls.canRead.push({ actor, resource: clone(resource) });
        return !settings.denyRead?.({ actor, resource });
      },
    },
    providers: new Map(),
    assertSecretDriverOwner(expected) {
      calls.secretOwners.push(expected);
      assert.equal(expected, "secret/example");
    },
    createId: () => id("agt", 50),
    now: () => time,
    ...settings.serviceOptions,
  };
  const service = new AgentService(options);
  return { service, options, calls, state, stored, returned, declaredRevision, configuration };
}

const updateInput = () => ({ namespaceId, agentId, configurationId });

function selectionFixture(settings = {}) {
  const selected = settings.selection ?? selection(2);
  const control = fixture({
    ...settings,
    returnedAgent: settings.returnedAgent ?? {
      ...agent(),
      workloadProfileSelection: clone(selected),
    },
  });
  const profileCalls = {
    invocation: 0,
    bindings: [],
    validation: [],
    retain: [],
    released: 0,
    assertion: 0,
    poison: [],
    mutationScope: 0,
    fallbackAccess: 0,
  };
  // This identity-bearing sentinel is accepted only by this controlled enrollment.
  // It is not an authenticated handle minted by the accepting HTTP service.
  const invocation = Object.freeze({});
  const controller = new AbortController();
  const stale = new Error("controlled held Selection is no longer current");
  const inactive = new Error("controlled original IO is no longer active");
  let current = true;
  let active = true;
  let poisoned = false;
  let firstFailure;
  let terminalCleanup;
  const retained = [];
  const io = {
    assertActive() {
      if (poisoned) throw firstFailure;
      if (!active || controller.signal.aborted) throw inactive;
    },
    poison(error) {
      profileCalls.poison.push(error);
      if (!poisoned) {
        poisoned = true;
        firstFailure = error;
      }
    },
    async query() {
      assert.fail("Agent Selection orchestration must use the enrolled repositories");
    },
  };
  const lease = {
    assertCurrent() {
      profileCalls.assertion++;
      if (!current) throw stale;
      if (settings.assertionResult) return settings.assertionResult();
      return undefined;
    },
    async release() {
      profileCalls.released++;
      await settings.onRelease?.();
    },
  };
  // Only the exercised repository methods are declared. This fixture does not
  // manufacture a recognized Platform owner, transaction, active head or reader.
  const unit = {
    kind: "agent-selection",
    installationId,
    namespaceId,
    agentId,
    platform: control.state,
    signal: controller.signal,
    retain(participant) {
      profileCalls.retain.push(participant);
      if (settings.retainFailure) throw settings.retainFailure;
      retained.push(participant);
      return undefined;
    },
    ...settings.unitOverrides,
  };
  const workloadProfiles = {
    invocations: {
      async forCurrentInvocation() {
        profileCalls.invocation++;
        if (settings.invocationFailure) throw settings.invocationFailure;
        await settings.onInvocation?.();
        return invocation;
      },
    },
    enrollment: {
      async withDraft(actualInvocation, binding, work) {
        assert.equal(actualInvocation, invocation);
        profileCalls.bindings.push(binding);
        if (settings.enrollmentFailure) throw settings.enrollmentFailure;
        return work(unit, io);
      },
    },
    use: {
      async validateSelectionLocked(request, actualUnit, actualIo) {
        profileCalls.validation.push({ request, unit: actualUnit, io: actualIo });
        assert.equal(actualUnit, unit);
        assert.equal(actualIo, io);
        if (settings.validationFailure) throw settings.validationFailure;
        await settings.onValidation?.();
        if (settings.staleOnValidationReturn) current = false;
        return lease;
      },
      async prepareUseLocked() {
        assert.fail("Updating an Agent Selection does not prepare a revision Use");
      },
    },
  };
  control.options.workloadProfiles = workloadProfiles;
  const selectedProjection = Object.fromEntries(
    Object.entries(control.state).map(([name, methods]) => [
      name,
      Object.fromEntries(
        Object.keys(methods).map((method) => [
          method,
          () => {
            profileCalls.fallbackAccess++;
            assert.fail("Selected updates must use the enrolled original Platform unit");
          },
        ]),
      ),
    ]),
  );
  control.options.repositories.mutate = async (work) => {
    profileCalls.mutationScope++;
    return work(selectedProjection);
  };
  const originalUpdate = control.state.agents.updateConfiguration;
  control.state.agents.updateConfiguration = async (...operands) => {
    assert.equal(profileCalls.released, 0, "the held Selection must survive the write await");
    const result = await originalUpdate(...operands);
    if (settings.staleOnUpdateReturn) current = false;
    if (settings.inactiveOnUpdateReturn) active = false;
    if (settings.updateFailure) throw settings.updateFailure;
    return result;
  };
  const originalFindConfiguration = control.state.configurations.findConfiguration;
  control.state.configurations.findConfiguration = async (...operands) => {
    const result = await originalFindConfiguration(...operands);
    if (settings.inactiveOnConfigurationReturn) active = false;
    return result;
  };
  return {
    ...control,
    profileCalls,
    workloadProfiles,
    unit,
    io,
    lease,
    retained,
    stale,
    inactive,
    invalidateSelection() {
      current = false;
    },
    invalidateIo() {
      active = false;
    },
    abort() {
      controller.abort();
    },
    finish() {
      // Deliberate terminal handling by the controlled owner. Calling this helper
      // establishes no COMMIT result or production owner's participant recognition.
      terminalCleanup ??= (async () => {
        for (const participant of retained) await participant.release();
      })();
      return terminalCleanup;
    },
  };
}

test("omission sends no replacement Selection and retains the repository's selected or historical Agent response", async () => {
  for (const selected of [true, false]) {
    const control = fixture({ selected });
    const result = await control.service.updateAgent(principalId, updateInput());
    assert.equal(result, control.returned);
    assert.equal(control.calls.update.length, 1);
    const operands = control.calls.update[0];
    assert.deepEqual(operands.slice(0, 6), [
      namespaceId,
      agentId,
      configurationId,
      undefined,
      undefined,
      undefined,
    ]);
    assert.equal(operands[6], undefined);
    assert.equal(Object.hasOwn(result, "workloadProfileSelection"), selected);
    if (selected) assert.deepEqual(result.workloadProfileSelection, selection());
  }
});

test("installed profile participants remain unused for omitted Selection and ordinary Agent creation", async () => {
  const selected = selectionFixture();
  const control = fixture({ serviceOptions: { workloadProfiles: selected.workloadProfiles } });
  await control.service.updateAgent(principalId, updateInput());
  const created = await control.service.createAgent(principalId, {
    namespaceId,
    name: "ordinary-agent",
    configurationId,
  });
  assert.equal(control.calls.update[0][6], undefined);
  assert.equal(Object.hasOwn(created, "workloadProfileSelection"), false);
  assert.equal(selected.profileCalls.invocation, 0);
  assert.equal(selected.profileCalls.bindings.length, 0);
  assert.equal(selected.profileCalls.validation.length, 0);
  assert.equal(selected.retained.length, 0);
});

test("explicit null, undefined and malformed Selection operands cannot become an omitted update", async () => {
  const missingRef = selection();
  delete missingRef.manifestRef;
  for (const workloadProfileSelection of [
    null,
    undefined,
    {},
    missingRef,
    { ...selection(), admissionVersion: 0 },
    { ...selection(), admissionVersion: 1.5 },
    { ...selection(), manifestRef: id("cfg", 20) },
    { ...selection(), manifestDigest: "not-a-manifest-digest" },
    { ...selection(), namespaceId: id("ns", 60) },
    { ...selection(), authorized: true },
    use(),
  ]) {
    assert.equal(decodeWorkloadProfileSelectionV1(workloadProfileSelection).kind, "invalid");
    const control = fixture();
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection,
      }),
    );
    assert.equal(control.calls.update.length, 0);
  }
});

test("a changed well-formed Selection remains unavailable without its current original validator", async () => {
  const control = fixture();
  const candidate = selection(2);
  assert.equal(decodeWorkloadProfileSelectionV1(candidate).kind, "valid");
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: candidate,
    }),
  );
  assert.equal(control.calls.update.length, 0);
});

test("missing invocation, enrollment or validator participants cannot fall back to an ordinary selected update", async () => {
  for (const missing of ["invocations", "enrollment", "use"]) {
    const control = selectionFixture();
    delete control.workloadProfiles[missing];
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection: selection(2),
      }),
    );
    assert.equal(control.calls.update.length, 0);
    assert.equal(control.profileCalls.fallbackAccess, 0);
    assert.equal(control.retained.length, 0);
  }
  for (const point of ["invocationFailure", "enrollmentFailure"]) {
    const refusal = new Error(`controlled ${point}`);
    const control = selectionFixture({ [point]: refusal });
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection: selection(2),
      }),
      (error) => error === refusal,
    );
    assert.equal(control.calls.update.length, 0);
    assert.equal(control.profileCalls.validation.length, 0);
    assert.equal(control.retained.length, 0);
  }
});

test("explicit Agent Selection uses the original enrolled unit and retains current validation through terminal handling", async () => {
  // An explicitly resubmitted existing Selection still needs current validation.
  for (const candidate of [selection(), selection(2)]) {
    const control = selectionFixture({
      selection: candidate,
      returnedAgent: {
        ...agent(),
        serviceAccountId: nextServiceAccountId,
        workloadProfileSelection: clone(candidate),
      },
    });
    const input = {
      ...updateInput(),
      serviceAccountId: nextServiceAccountId,
      providerId: null,
      executionMode: "dedicated",
      workloadProfileSelection: candidate,
    };
    const expected = clone(input);
    const result = await control.service.updateAgent(principalId, input);
    assert.equal(result, control.returned);
    assert.equal(control.profileCalls.invocation, 1);
    assert.equal(control.profileCalls.bindings.length, 1);
    const binding = control.profileCalls.bindings[0];
    assert.deepEqual(clone(binding), [principalId, expected]);
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding[1]));
    assert.ok(Object.isFrozen(binding[1].workloadProfileSelection));
    assert.notEqual(binding[1], input);
    assert.notEqual(binding[1].workloadProfileSelection, candidate);
    assert.equal(control.profileCalls.validation.length, 1);
    const validation = control.profileCalls.validation[0];
    assert.deepEqual(clone(validation.request), {
      installationId,
      namespaceId,
      agentId,
      selection: candidate,
    });
    assert.equal(validation.unit, control.unit);
    assert.equal(validation.unit.platform, control.state);
    assert.equal(validation.io, control.io);
    assert.deepEqual(control.calls.authorize, [
      {
        actor: principalId,
        action: "update",
        resource: { kind: "agent", id: agentId, namespaceId },
      },
      {
        actor: principalId,
        action: "read",
        resource: { kind: "configuration", id: configurationId, namespaceId },
      },
      {
        actor: principalId,
        action: "read",
        resource: { kind: "service_account", id: serviceAccountId, namespaceId },
      },
      {
        actor: principalId,
        action: "read",
        resource: { kind: "service_account", id: nextServiceAccountId, namespaceId },
      },
      {
        actor: principalId,
        action: "operate",
        resource: { kind: "secret", namespaceId, id: secretId },
      },
    ]);
    assert.deepEqual(control.calls.secretOwners, ["secret/example"]);
    assert.deepEqual(clone(control.calls.update), [
      [
        namespaceId,
        agentId,
        configurationId,
        "dedicated",
        nextServiceAccountId,
        null,
        candidate,
        undefined,
      ],
    ]);
    assert.equal(control.profileCalls.mutationScope, 1);
    assert.equal(control.profileCalls.fallbackAccess, 0);
    assert.equal(control.retained.length, 1);
    assert.equal(control.profileCalls.released, 0);
    assert.equal(control.retained[0].assertCurrent(), undefined);
    assert.deepEqual(control.profileCalls.poison, []);
    await control.finish();
    await control.finish();
    assert.equal(control.profileCalls.released, 1);
  }
});

test("caller edits during invocation lookup cannot replace the frozen original Agent update binding", async () => {
  const input = { ...updateInput(), workloadProfileSelection: selection(2) };
  const expected = clone(input);
  const control = selectionFixture({
    onInvocation() {
      input.configurationId = id("cfg", 60);
      input.workloadProfileSelection.admissionVersion = 99;
    },
  });
  await control.service.updateAgent(principalId, input);
  assert.deepEqual(clone(control.profileCalls.bindings[0]), [principalId, expected]);
  assert.deepEqual(
    clone(control.profileCalls.validation[0].request.selection),
    expected.workloadProfileSelection,
  );
  assert.equal(control.calls.update[0][2], configurationId);
  assert.deepEqual(clone(control.calls.update[0][6]), expected.workloadProfileSelection);
  assert.equal(input.configurationId, id("cfg", 60));
  assert.equal(input.workloadProfileSelection.admissionVersion, 99);
  await control.finish();
});

test("a well-formed foreign Selection reaches the current validator and its refusal prevents the write", async () => {
  const foreign = { ...selection(2), manifestRef: uuid(60), admissionRef: uuid(61) };
  assert.equal(decodeWorkloadProfileSelectionV1(foreign).kind, "valid");
  const refusal = new Error("controlled active reader refuses a foreign Selection");
  const control = selectionFixture({ selection: foreign, validationFailure: refusal });
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: foreign,
    }),
    (error) => error === refusal,
  );
  assert.deepEqual(clone(control.profileCalls.validation[0].request), {
    installationId,
    namespaceId,
    agentId,
    selection: foreign,
  });
  assert.equal(control.calls.update.length, 0);
  assert.equal(control.retained.length, 0);
  assert.equal(control.profileCalls.released, 0);
  assert.ok(control.profileCalls.poison.includes(refusal));
});

test("a selected update cannot replace the enrolled draft kind, Namespace or Agent scope", async () => {
  for (const unitOverrides of [
    { namespaceId: id("ns", 60) },
    { agentId: id("agt", 60) },
    { kind: "deployment" },
  ]) {
    const control = selectionFixture({ unitOverrides });
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection: selection(2),
      }),
    );
    assert.equal(control.calls.update.length, 0);
    assert.equal(control.profileCalls.validation.length, 0);
    assert.equal(control.retained.length, 0);
    assert.equal(control.profileCalls.fallbackAccess, 0);
  }
});

test("Selection validation receives the owner-supplied Installation and propagates its foreign-scope refusal", async () => {
  const foreignInstallationId = id("ins", 60);
  const refusal = new Error("controlled original validator refuses this Installation");
  const control = selectionFixture({
    unitOverrides: { installationId: foreignInstallationId },
    validationFailure: refusal,
  });
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: selection(2),
    }),
    (error) => error === refusal,
  );
  assert.equal(control.profileCalls.validation[0].request.installationId, foreignInstallationId);
  assert.equal(control.profileCalls.validation[0].unit, control.unit);
  assert.equal(control.calls.update.length, 0);
  assert.equal(control.retained.length, 0);
});

test("selected updates keep exact current resource checks before acquiring a Selection lease", async () => {
  for (const settings of [
    { missingNamespace: true },
    { missingAgent: true },
    { missingConfiguration: true },
    { missingAccount: serviceAccountId },
    { missingAccount: nextServiceAccountId },
    { missingSecret: true },
    ...["agent", "configuration", "service_account", "secret"].map((kind) => ({
      deny: ({ resource }) => resource.kind === kind,
    })),
  ]) {
    const control = selectionFixture(settings);
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        serviceAccountId: nextServiceAccountId,
        workloadProfileSelection: selection(2),
      }),
    );
    assert.equal(control.calls.update.length, 0);
    assert.equal(control.profileCalls.validation.length, 0);
    assert.equal(control.retained.length, 0);
  }
});

test("inactive original IO before and after repository awaits refuses the selected update", async () => {
  for (const point of ["before", "aborted", "configuration", "update"]) {
    const control = selectionFixture({
      inactiveOnConfigurationReturn: point === "configuration",
      inactiveOnUpdateReturn: point === "update",
    });
    if (point === "before") control.invalidateIo();
    if (point === "aborted") control.abort();
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection: selection(2),
      }),
    );
    assert.equal(control.calls.update.length, point === "update" ? 1 : 0);
    if (point !== "update") assert.equal(control.profileCalls.validation.length, 0);
    await control.finish();
    assert.equal(control.profileCalls.released, point === "update" ? 1 : 0);
  }
});

test("lost Selection currentness before the write and across its await cannot return success", async () => {
  for (const point of ["validation", "update"]) {
    const control = selectionFixture({
      staleOnValidationReturn: point === "validation",
      staleOnUpdateReturn: point === "update",
    });
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        workloadProfileSelection: selection(2),
      }),
    );
    assert.equal(control.calls.update.length, point === "update" ? 1 : 0);
    assert.ok(control.profileCalls.poison.includes(control.stale));
    await control.finish();
    assert.equal(control.profileCalls.released, 1);
  }
});

test("refused synchronous retention releases the acquired lease without enrollment or a write", async () => {
  const refusal = new Error("controlled draft owner refuses retention");
  const control = selectionFixture({ retainFailure: refusal });
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: selection(2),
    }),
  );
  assert.equal(control.profileCalls.validation.length, 1);
  assert.equal(control.profileCalls.retain.length, 1);
  assert.equal(control.retained.length, 0);
  assert.equal(control.calls.update.length, 0);
  assert.equal(control.profileCalls.released, 1);
  assert.ok(control.profileCalls.poison.includes(refusal));
  await control.finish();
  assert.equal(control.profileCalls.released, 1);
});

test("Agent Selection joins acquired cleanup when poison reporting throws", async () => {
  for (const point of ["assertion", "retention"]) {
    for (const firstFailure of [new Error(`controlled ${point} failure`), undefined]) {
      const reporterFailure = new Error("controlled poison reporter failure");
      const reported = [];
      let announceRelease;
      let completeRelease;
      let releaseFinished = false;
      let outwardSettled = false;
      let retentionAttempts = 0;
      const releaseStarted = new Promise((resolve) => {
        announceRelease = resolve;
      });
      const releaseGate = new Promise((resolve) => {
        completeRelease = resolve;
      });
      const control = selectionFixture({
        async onRelease() {
          announceRelease();
          await releaseGate;
          releaseFinished = true;
        },
      });
      // Observe attempted reporting only. A throwing reporter does not establish
      // that the production transaction owner successfully received a poison.
      control.io.poison = (error) => {
        reported.push(error);
        throw reporterFailure;
      };
      if (point === "assertion") {
        control.lease.assertCurrent = () => {
          throw firstFailure;
        };
      } else {
        control.unit.retain = () => {
          retentionAttempts++;
          throw firstFailure;
        };
      }
      const outcome = control.service
        .updateAgent(principalId, {
          ...updateInput(),
          workloadProfileSelection: selection(2),
        })
        .then(
          (value) => {
            outwardSettled = true;
            return { kind: "returned", value };
          },
          (error) => {
            outwardSettled = true;
            return { kind: "rejected", error };
          },
        );
      try {
        assert.equal(
          await Promise.race([releaseStarted.then(() => "release"), outcome.then(() => "outward")]),
          "release",
          "acquired cleanup must start before the failure escapes",
        );
        await new Promise(setImmediate);
        assert.equal(outwardSettled, false, "the service must join the deferred release");
        assert.equal(releaseFinished, false);
        assert.equal(control.profileCalls.released, 1);
        assert.equal(control.retained.length, 0);
        assert.equal(control.calls.update.length, 0);
      } finally {
        completeRelease();
      }
      const result = await outcome;
      assert.equal(result.kind, "rejected");
      assert.equal(result.error, firstFailure);
      assert.equal(releaseFinished, true);
      assert.ok(reported.length > 0);
      assert.equal(reported[0], firstFailure);
      assert.equal(retentionAttempts, point === "retention" ? 1 : 0);
      await control.finish();
      assert.equal(control.profileCalls.released, 1);
    }
  }
});

test("a malformed asynchronous Selection assertion is observed before acquired-lease cleanup", async () => {
  let settled = false;
  const asynchronousFailure = new Error("controlled malformed asynchronous assertion");
  const control = selectionFixture({
    assertionResult() {
      return Promise.resolve().then(() => {
        settled = true;
        throw asynchronousFailure;
      });
    },
    onRelease() {
      assert.equal(settled, true, "cleanup must await the malformed assertion result");
    },
  });
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: selection(2),
    }),
  );
  assert.equal(settled, true);
  assert.equal(control.calls.update.length, 0);
  assert.equal(control.retained.length, 0);
  assert.equal(control.profileCalls.released, 1);
  assert.ok(control.profileCalls.poison.length > 0);
  await control.finish();
  assert.equal(control.profileCalls.released, 1);
});

test("a retained Selection guard still refuses withdrawal in the callback-to-terminal gap", async () => {
  const control = selectionFixture();
  await control.service.updateAgent(principalId, {
    ...updateInput(),
    workloadProfileSelection: selection(2),
  });
  assert.equal(control.retained.length, 1);
  assert.equal(control.profileCalls.released, 0);
  control.invalidateSelection();
  assert.throws(() => control.retained[0].assertCurrent());
  assert.ok(control.profileCalls.poison.includes(control.stale));
  await control.finish();
  await control.finish();
  assert.equal(control.profileCalls.released, 1);
});

test("a repository failure remains poisoned after a selected update is caught", async () => {
  const failure = new Error("controlled selected draft write failed");
  const control = selectionFixture({ updateFailure: failure });
  await assert.rejects(
    control.service.updateAgent(principalId, {
      ...updateInput(),
      workloadProfileSelection: selection(2),
    }),
    (error) => error === failure,
  );
  assert.equal(control.calls.update.length, 1);
  assert.ok(control.profileCalls.poison.includes(failure));
  assert.throws(
    () => control.io.assertActive(),
    (error) => error === failure,
  );
  assert.equal(control.profileCalls.released, 0);
  await control.finish();
  assert.equal(control.profileCalls.released, 1);
});

test("ordinary updates preserve exact current Agent, Configuration, both ServiceAccount and Secret checks", async () => {
  const control = fixture();
  await control.service.updateAgent(principalId, {
    ...updateInput(),
    serviceAccountId: nextServiceAccountId,
    providerId: null,
    executionMode: "dedicated",
  });
  assert.deepEqual(control.calls.authorize, [
    { actor: principalId, action: "update", resource: { kind: "agent", id: agentId, namespaceId } },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "configuration", id: configurationId, namespaceId },
    },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "service_account", id: serviceAccountId, namespaceId },
    },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "service_account", id: nextServiceAccountId, namespaceId },
    },
    {
      actor: principalId,
      action: "operate",
      resource: { kind: "secret", namespaceId, id: secretId },
    },
  ]);
  assert.deepEqual(control.calls.secretOwners, ["secret/example"]);
  assert.deepEqual(control.calls.update[0].slice(0, 6), [
    namespaceId,
    agentId,
    configurationId,
    "dedicated",
    nextServiceAccountId,
    null,
  ]);
});

test("current authorization and exact foreign or unavailable references refuse update before the write", async () => {
  for (const settings of [
    { missingNamespace: true },
    { missingAgent: true },
    { missingConfiguration: true },
    { missingAccount: serviceAccountId },
    { missingAccount: nextServiceAccountId },
    { missingSecret: true },
    ...["agent", "configuration", "service_account", "secret"].map((kind) => ({
      deny: ({ resource }) => resource.kind === kind,
    })),
  ]) {
    const control = fixture(settings);
    await assert.rejects(
      control.service.updateAgent(principalId, {
        ...updateInput(),
        serviceAccountId: nextServiceAccountId,
      }),
    );
    assert.equal(control.calls.update.length, 0);
  }
  for (const extra of [
    { namespaceId: id("ns", 60) },
    { agentId: id("agt", 60) },
    { configurationId: id("cfg", 60) },
    { serviceAccountId: id("sa", 60) },
  ]) {
    const control = fixture();
    await assert.rejects(control.service.updateAgent(principalId, { ...updateInput(), ...extra }));
    assert.equal(control.calls.update.length, 0);
  }
});

test("Agent creation stays unselected and keeps its existing exact reference authorization", async () => {
  const control = fixture();
  const result = await control.service.createAgent(principalId, {
    namespaceId,
    name: "created-agent",
    configurationId,
    serviceAccountId,
  });
  assert.equal(control.calls.create.length, 1);
  assert.equal(result.id, id("agt", 50));
  assert.equal(result.executionMode, "embedded");
  assert.equal(result.providerId, null);
  assert.equal(Object.hasOwn(control.calls.create[0], "workloadProfileSelection"), false);
  assert.equal(Object.hasOwn(result, "workloadProfileSelection"), false);
  assert.deepEqual(
    control.calls.authorize.map(({ action, resource }) => [action, resource.kind, resource.id]),
    [
      ["create", "agent", namespaceId],
      ["read", "configuration", configurationId],
      ["read", "service_account", serviceAccountId],
      ["operate", "secret", secretId],
    ],
  );
});

test("public Agent and revision reads keep independent current resource authorization", async () => {
  const control = fixture();
  const result = await control.service.getRevision(principalId, namespaceId, agentId, revisionId);
  assert.equal(result, control.declaredRevision);
  assert.deepEqual(result.workloadProfileUse, use());
  assert.deepEqual(control.calls.authorize, [
    { actor: principalId, action: "read", resource: { kind: "agent", id: agentId, namespaceId } },
    {
      actor: principalId,
      action: "read",
      resource: { kind: "agent_revision", id: revisionId, namespaceId },
    },
  ]);
  const denied = fixture({ deny: ({ resource }) => resource.kind === "agent_revision" });
  await assert.rejects(denied.service.getRevision(principalId, namespaceId, agentId, revisionId));
  assert.deepEqual(await denied.service.getAgent(principalId, namespaceId, agentId), denied.stored);
});

async function handlerFixture(control) {
  // Load the actual handler only for these projection tests. Its production HTTP
  // dependency graph is required; no copied error classes or substitute evaluator.
  const { createAgentOperationHandlers } =
    await import("../../apps/controller/src/routes/agent.ts");
  const context = { actorId: principalId };
  const mutations = [];
  const handlers = createAgentOperationHandlers({
    resolveAgentService: () => control.service,
    requestContext: () => context,
    async runAgentMutation(request, operation, actualContext, mutate, resource, project) {
      assert.equal(actualContext, context);
      const result = await mutate();
      mutations.push({ operationId: operation.operationId, resource: resource(result) });
      return project(result);
    },
    async runDeployment() {
      assert.fail("Projection tests do not admit or deploy a revision");
    },
  });
  async function invoke(operationId, body) {
    let response;
    let status = 200;
    const request = {
      id: requestId,
      params: { namespaceId, agentId, revisionId },
      ...(body === undefined ? {} : { body }),
    };
    const reply = {
      status(value) {
        status = value;
        return this;
      },
      send(value) {
        response = value;
        return this;
      },
    };
    const operation = agentApiRoutes.find((route) => route.operationId === operationId);
    assert.ok(operation);
    await handlers[operationId](request, reply, operation);
    return { status, response };
  }
  return { invoke, mutations };
}

test("actual read handlers project public Selection and Use while omitting protected credential siblings", async () => {
  const control = fixture();
  // Extra backend fields test the explicit public projection. This does not claim
  // that a supported repository exposes these protected fields to its reader.
  control.stored.credentialWorkloadSelection = { marker: "protected-declaration" };
  control.stored.credential_workload_selection = { marker: "protected-declaration" };
  control.declaredRevision.credentialWorkloadSelection = { marker: "protected-declaration" };
  control.declaredRevision.credential_workload_selection = { marker: "protected-declaration" };
  const handlers = await handlerFixture(control);
  for (const operationId of ["getAgent", "listAgents", "getAgentRevision", "listAgentRevisions"]) {
    const { status, response } = await handlers.invoke(operationId);
    assert.equal(status, 200);
    assert.deepEqual(response.meta, { requestId });
    const value = Array.isArray(response.data) ? response.data[0] : response.data;
    assert.equal(Object.hasOwn(value, "credentialWorkloadSelection"), false);
    assert.equal(Object.hasOwn(value, "credential_workload_selection"), false);
    assert.equal(Object.hasOwn(value, "servicePrincipalId"), false);
    if (operationId === "getAgent" || operationId === "listAgents") {
      assert.deepEqual(value.workloadProfileSelection, selection());
      assert.equal(check(AgentSchema, value), true);
    } else {
      assert.deepEqual(value.workloadProfileUse, use());
      assert.equal(check(AgentRevisionSchema, value), true);
    }
  }
  delete control.stored.workloadProfileSelection;
  delete control.declaredRevision.workloadProfileUse;
  const historicalAgent = await handlers.invoke("getAgent");
  const historicalRevision = await handlers.invoke("getAgentRevision");
  assert.equal(Object.hasOwn(historicalAgent.response.data, "workloadProfileSelection"), false);
  assert.equal(Object.hasOwn(historicalRevision.response.data, "workloadProfileUse"), false);
});

test("actual update and create handlers preserve omission and their existing mutation projection", async () => {
  const control = fixture();
  const handlers = await handlerFixture(control);
  const updated = await handlers.invoke("updateAgent", { configurationId });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.response.data.workloadProfileSelection, selection());
  assert.equal(control.calls.update[0][6], undefined);
  const created = await handlers.invoke("createAgent", { name: "new-agent", configurationId });
  assert.equal(created.status, 201);
  assert.equal(Object.hasOwn(created.response.data, "workloadProfileSelection"), false);
  assert.equal(check(AgentSchema, created.response.data), true);
  assert.deepEqual(handlers.mutations, [
    { operationId: "updateAgent", resource: { kind: "agent", id: agentId, namespaceId } },
    { operationId: "createAgent", resource: { kind: "agent", id: id("agt", 50), namespaceId } },
  ]);
});
