import assert from "node:assert/strict";
import test from "node:test";

// These cases exercise actual Fastify transport, registration, catalog and raw
// command decoding. Admission, identity and operation handlers are controlled
// participants; their accepted receipt does not establish a durable deployment.
// Direct service cases below use the original producer/recovery interfaces with
// controlled participants. They establish no active-profile or durable replay proof.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const plain = (value) => JSON.parse(JSON.stringify(value));
const installationId = id("ins", 1);
const namespaceId = id("ns", 2);
const agentId = id("agt", 3);
const configurationId = id("cfg", 5);
const acceptedAt = "2026-09-07T08:00:00.000Z";
const scope = { installationId, namespaceId, agentId };
const command = () => ({
  schemaVersion: 2,
  operationRef: uuid(4),
  expectedLifecycleGeneration: null,
  revisionSource: "saved-draft",
  expectedDraft: {
    configurationId,
    configurationGeneration: 7,
    providerId: null,
    executionMode: "embedded",
    serviceAccountId: null,
    workloadProfileSelection: {
      manifestRef: uuid(6),
      manifestDigest: `sha256:${"a".repeat(64)}`,
      admissionRef: uuid(7),
      admissionVersion: 9,
    },
  },
});
const acceptedReceipt = (operationRef) => ({
  disposition: "accepted",
  operation: {
    operationRef,
    lifecycleGeneration: 1,
    acceptedAt,
    kind: "deploy",
    revisionSource: "saved-draft",
    desiredMode: "running",
  },
});

async function httpFixture(t) {
  // Keep the real HTTP dependency graph: no loader replacement, copied error
  // mapper or parsed-object injection may stand in for this boundary.
  const [transport, registration, registry, catalog, common, secret, errors, codec] =
    await Promise.all([
      import("../../apps/controller/src/http/transport.ts"),
      import("../../apps/controller/src/http/register.ts"),
      import("../../apps/controller/src/http/operation-registry.ts"),
      import("../../packages/contracts/src/api/routes.ts"),
      import("../../packages/contracts/src/api/common.ts"),
      import("../../packages/contracts/src/api/secret/resources.ts"),
      import("../../apps/controller/src/http/errors.ts"),
      import("../../packages/contracts/src/lifecycle-deploy-v2.ts"),
    ]);
  const maxJsonBytes = codec.LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes;
  const app = transport.createHttpTransport({
    bodyLimit: maxJsonBytes * 2,
    developmentEnabled: false,
  });
  t.after(() => app.close());
  const events = [];
  const identities = [];
  const deliveries = [];
  let admissionFailure;
  const handlers = Object.fromEntries(
    registry.ordinaryOperations.map((operation) => [
      operation.operationId,
      async (request, reply, selected) => {
        events.push(`handler:${operation.operationId}`);
        deliveries.push({ operation: selected, body: request.body, params: request.params });
        assert.equal(selected, operation);
        assert.equal(identities.at(-1)?.body, request.body);
        if (operation.operationId === "deployAgent") {
          reply.status(202).send({
            data: acceptedReceipt(request.body.operationRef),
            meta: { requestId: request.id },
          });
          return;
        }
        if (operation.operationId === "createAgent") {
          reply.status(201).send({
            data: {
              id: agentId,
              namespaceId: request.params.namespaceId,
              name: request.body.name,
              configurationId: request.body.configurationId,
              providerId: null,
              executionMode: "embedded",
              createdAt: acceptedAt,
            },
            meta: { requestId: request.id },
          });
          return;
        }
        assert.fail(`Unexpected operation dispatch: ${operation.operationId}`);
      },
    ]),
  );
  const infrastructure = {
    async admit(request, operation, profile) {
      events.push(`admit:start:${operation.operationId}`);
      assert.equal(profile, "ordinary");
      assert.equal(request.body, undefined, "admission must precede body parsing");
      await Promise.resolve();
      if (admissionFailure !== undefined) throw admissionFailure;
      assert.equal(request.body, undefined, "parsing must await admission completion");
      events.push(`admit:end:${operation.operationId}`);
    },
    async resolveIdentity(request, operation) {
      events.push(`identity:${operation.operationId}`);
      identities.push({ operation, body: request.body });
    },
  };
  app.setErrorHandler(async (error, _request, reply) => {
    errors.canonicalFailure(reply, errors.requestFailure(error));
  });
  app.register(async (routes) => {
    routes.addSchema(common.ErrorResponse);
    routes.addSchema(secret.SecretResponse);
    registration.registerProtectedOperations(routes, handlers, infrastructure);
  });
  await app.ready();
  const deployOperation = catalog.occApiRoutes.find(
    ({ operationId }) => operationId === "deployAgent",
  );
  const createOperation = catalog.occApiRoutes.find(
    ({ operationId }) => operationId === "createAgent",
  );
  assert.ok(deployOperation);
  assert.ok(createOperation);
  const urlFor = (operation) =>
    operation.path.replace(":namespaceId", namespaceId).replace(":agentId", agentId);
  return {
    app,
    events,
    identities,
    deliveries,
    codec,
    maxJsonBytes,
    deployOperation,
    createOperation,
    registry,
    handlers,
    reset() {
      events.length = 0;
      identities.length = 0;
      deliveries.length = 0;
      admissionFailure = undefined;
    },
    refuseAdmission() {
      admissionFailure = errors.failure(403, "FORBIDDEN", "Controlled admission refusal.");
    },
    inject(payload, operation = deployOperation, headers = { "content-type": "application/json" }) {
      assert.ok(payload === undefined || typeof payload === "string" || Buffer.isBuffer(payload));
      return app.inject({
        method: operation.method,
        url: urlFor(operation),
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    },
  };
}

function assertRejectedBeforeIdentity(fixture, response, status = 400, code = "INVALID_REQUEST") {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().error.code, code);
  assert.deepEqual(fixture.events, ["admit:start:deployAgent", "admit:end:deployAgent"]);
  assert.deepEqual(fixture.identities, []);
  assert.deepEqual(fixture.deliveries, []);
}

test("deployment raw HTTP ingestion uses the actual protected catalog and scoped parser", async (t) => {
  const fixture = await httpFixture(t);
  const raw = JSON.stringify(command());

  await t.test("registry retains the V2 body and refuses its removal", () => {
    const entries = fixture.registry.createOperationRegistry(
      fixture.registry.ordinaryOperations,
      fixture.handlers,
    );
    const entry = entries.find(({ operation }) => operation.operationId === "deployAgent");
    assert.equal(entry.operation, fixture.deployOperation);
    assert.equal(entry.schema.body, fixture.codec.LifecycleDeployCommandSchemaV2);
    assert.equal(entry.schema.response, fixture.deployOperation.schema.response);
    const schema = { ...fixture.deployOperation.schema };
    delete schema.body;
    assert.throws(
      () =>
        fixture.registry.createOperationRegistry([{ ...fixture.deployOperation, schema }], {
          deployAgent: fixture.handlers.deployAgent,
        }),
      /Missing HTTP request or response schema for deployAgent/,
    );
  });

  await t.test(
    "valid canonical V2 bytes reach identity and dispatch with every operand intact",
    async () => {
      fixture.reset();
      const expected = command();
      const response = await fixture.inject(Buffer.from(raw));
      assert.equal(response.statusCode, 202, response.body);
      assert.deepEqual(fixture.events, [
        "admit:start:deployAgent",
        "admit:end:deployAgent",
        "identity:deployAgent",
        "handler:deployAgent",
      ]);
      assert.equal(fixture.deliveries.length, 1);
      assert.equal(fixture.identities.length, 1);
      const delivered = fixture.deliveries[0];
      assert.equal(delivered.operation, fixture.deployOperation);
      assert.deepEqual({ ...delivered.params }, { namespaceId, agentId });
      assert.deepEqual(plain(delivered.body), expected);
      assert.equal(delivered.body, fixture.identities[0].body);
      assert.equal(Object.getPrototypeOf(delivered.body), null);
      assert.equal(Object.getPrototypeOf(delivered.body.expectedDraft), null);
      assert.ok(Object.isFrozen(delivered.body));
      assert.ok(Object.isFrozen(delivered.body.expectedDraft));
      assert.ok(Object.isFrozen(delivered.body.expectedDraft.workloadProfileSelection));
      assert.equal(
        fixture.codec.canonicalLifecycleDeployCommandV2(scope, delivered.body),
        fixture.codec.canonicalLifecycleDeployCommandV2(scope, expected),
      );
      assert.deepEqual(response.json().data, acceptedReceipt(expected.operationRef));
      assert.deepEqual(Object.keys(response.json()).sort(), ["data", "meta"]);
      assert.deepEqual(Object.keys(response.json().data).sort(), ["disposition", "operation"]);
    },
  );

  await t.test(
    "escaped strings and insignificant whitespace retain the same command identity",
    async () => {
      fixture.reset();
      const expected = command();
      expected.expectedDraft.providerId = "provider/é😀";
      const encoded = ` \n${JSON.stringify(expected, null, 2)}\t`.replace(
        "é😀",
        "\\u00e9\\ud83d\\ude00",
      );
      const response = await fixture.inject(Buffer.from(encoded));
      assert.equal(response.statusCode, 202, response.body);
      assert.deepEqual(plain(fixture.deliveries[0].body), expected);
      assert.equal(
        fixture.codec.canonicalLifecycleDeployCommandV2(scope, fixture.deliveries[0].body),
        fixture.codec.canonicalLifecycleDeployCommandV2(scope, expected),
      );
    },
  );

  await t.test(
    "duplicate decoded operationRef and nested keys reject before identity",
    async () => {
      const variants = [
        raw.replace('"operationRef":', `"operationRef":"${uuid(4)}","operationRef":`),
        raw.replace('"operationRef":', `"operation\\u0052ef":"${uuid(40)}","operationRef":`),
        raw.replace('"operationRef":', `"operationRef":"${uuid(40)}","operation\\u0052ef":`),
        raw.replace(
          '"configurationGeneration":7',
          '"configurationGeneration":7,"configuration\\u0047eneration":8',
        ),
        raw.replace('"admissionVersion":9', '"admissionVersion":9,"admission\\u0056ersion":9'),
      ];
      for (const payload of variants) {
        fixture.reset();
        assert.notEqual(payload, raw);
        assertRejectedBeforeIdentity(fixture, await fixture.inject(Buffer.from(payload)));
      }
    },
  );

  await t.test(
    "integer aliases cannot be rounded or normalized by an earlier JSON parser",
    async () => {
      for (const [original, replacement] of [
        ['"schemaVersion":2', '"schemaVersion":2.0'],
        ['"configurationGeneration":7', '"configurationGeneration":7e0'],
        ['"configurationGeneration":7', '"configurationGeneration":7.0000000000000001'],
        ['"admissionVersion":9', '"admissionVersion":9.0'],
        ['"expectedLifecycleGeneration":null', '"expectedLifecycleGeneration":-0'],
      ]) {
        fixture.reset();
        const payload = raw.replace(original, replacement);
        assert.notEqual(payload, raw);
        assertRejectedBeforeIdentity(fixture, await fixture.inject(Buffer.from(payload)));
      }
    },
  );

  await t.test("malformed UTF-8 inside an otherwise valid provider string rejects", async () => {
    const [before, after] = raw.split('"providerId":null');
    assert.equal(typeof after, "string");
    for (const invalid of [
      [0xc0, 0xaf],
      [0xe2, 0x28, 0xa1],
      [0xf0, 0x9f],
    ]) {
      fixture.reset();
      const payload = Buffer.concat([
        Buffer.from(`${before}"providerId":"provider/`),
        Buffer.from(invalid),
        Buffer.from(`"${after}`),
      ]);
      assertRejectedBeforeIdentity(fixture, await fixture.inject(payload));
    }
  });

  await t.test(
    "the deployment byte limit accepts its boundary and rejects one extra byte",
    async () => {
      fixture.reset();
      const exact = Buffer.from(raw.padEnd(fixture.maxJsonBytes, " "));
      assert.equal(exact.byteLength, fixture.maxJsonBytes);
      const accepted = await fixture.inject(exact);
      assert.equal(accepted.statusCode, 202, accepted.body);
      assert.deepEqual(plain(fixture.deliveries[0].body), command());
      fixture.reset();
      assertRejectedBeforeIdentity(
        fixture,
        await fixture.inject(Buffer.concat([exact, Buffer.from(" ")])),
        413,
        "PAYLOAD_TOO_LARGE",
      );
    },
  );

  await t.test("missing, empty and null bodies cannot select an implicit saved draft", async () => {
    for (const [payload, headers] of [
      [undefined, {}],
      [undefined, { "content-type": "application/json" }],
      [Buffer.alloc(0), { "content-type": "application/json" }],
      [Buffer.from("null"), { "content-type": "application/json" }],
      [Buffer.from("{}"), { "content-type": "application/json" }],
    ]) {
      fixture.reset();
      assertRejectedBeforeIdentity(
        fixture,
        await fixture.inject(payload, fixture.deployOperation, headers),
      );
    }
  });

  await t.test(
    "unknown authority fields and omitted nullable operands reject unchanged raw input",
    async () => {
      const variants = [
        { ...command(), installationId },
        { ...command(), agentId },
        { ...command(), authorized: true },
        { ...command(), workloadProfileUse: {} },
        { ...command(), credentialWorkloadSelection: {} },
        { ...command(), schemaVersion: 1 },
      ];
      for (const field of ["providerId", "serviceAccountId"]) {
        const input = command();
        delete input.expectedDraft[field];
        variants.push(input);
      }
      for (const input of variants) {
        fixture.reset();
        assertRejectedBeforeIdentity(
          fixture,
          await fixture.inject(Buffer.from(JSON.stringify(input))),
        );
      }
    },
  );

  await t.test(
    "admission refusal wins over a malformed raw body before identity or dispatch",
    async () => {
      fixture.reset();
      fixture.refuseAdmission();
      const response = await fixture.inject(Buffer.from('{"operationRef":'));
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error.code, "FORBIDDEN");
      assert.deepEqual(fixture.events, ["admit:start:deployAgent"]);
      assert.deepEqual(fixture.identities, []);
      assert.deepEqual(fixture.deliveries, []);
    },
  );

  await t.test(
    "an adjacent createAgent operation keeps ordinary default JSON handling",
    async () => {
      fixture.reset();
      const payload = Buffer.from(
        `{"name":"discarded","name":"retained","configurationId":"${configurationId}"}`,
      );
      const response = await fixture.inject(payload, fixture.createOperation);
      assert.equal(response.statusCode, 201, response.body);
      assert.deepEqual(fixture.events, [
        "admit:start:createAgent",
        "admit:end:createAgent",
        "identity:createAgent",
        "handler:createAgent",
      ]);
      assert.equal(fixture.deliveries.length, 1);
      assert.equal(fixture.deliveries[0].operation, fixture.createOperation);
      assert.deepEqual(fixture.deliveries[0].body, { name: "retained", configurationId });
      assert.equal(response.json().data.name, "retained");
      assert.equal(Object.hasOwn(response.json().data, "workloadProfileSelection"), false);
    },
  );
});

const clone = (value) => structuredClone(value);
const serviceRevisionId = id("rev", 4);
const principalId = id("prn", 25);
const servicePrincipalId = id("prn", 26);
const serviceAccountId = id("sa", 28);
const secretId = id("sec", 29);
const originalRequestId = id("req", 31);
const auditId = id("aud", 32);
const digest = (character) => `sha256:${character.repeat(64)}`;
const serviceCommand = () => {
  const value = command();
  Object.assign(value.expectedDraft, {
    providerId: "provider/model",
    executionMode: "dedicated",
    serviceAccountId,
  });
  return value;
};
const stores = () =>
  ["gateway", "harness"].map((component, index) => ({
    component,
    name: "state",
    path: `/state/${component}`,
    store: { ref: `${component}-state-policy`, version: index + 1, contentDigest: digest("b") },
    access: "read-write",
  }));
const sandboxValues = (values) => ({
  ...clone(values),
  tools: { allow: ["read"], fs: { workspaceOnly: true } },
});

function admittedProjection(candidate, selected, profileRefs, storePolicyBindings) {
  return {
    manifestDigest: selected.manifestDigest,
    configurationRef: candidate.configurationId,
    configurationGeneration: candidate.configurationGeneration,
    immutableConfigurationContent: {
      kind: candidate.configurationKind,
      values: candidate.configuration,
      secretBindings: candidate.secretBindings ?? {},
    },
    resolvedProfileBindingParameters: {
      installationId,
      namespaceId: candidate.namespaceId,
      agentId: candidate.agentId,
      serviceAccountAssociation: {
        servicePrincipalId: candidate.servicePrincipalId,
        serviceAccount: candidate.serviceAccount,
      },
      storePolicyBindings,
      roleBindings: profileRefs,
    },
  };
}

async function deploymentFixture(settings = {}) {
  const [domain, codec, profiles, credentials, projection, logging, configuration, examples] =
    await Promise.all([
      import("../../packages/occ/src/services/deployment/service.ts"),
      import("../../packages/contracts/src/lifecycle-deploy-v2.ts"),
      import("../../packages/contracts/src/workload-profile-v1.ts"),
      import("../../packages/contracts/src/credential-workload-selection-v1.ts"),
      import("../../packages/occ/src/workload-profiles/admitted-configuration.ts"),
      import("../../packages/contracts/src/logging.ts"),
      import("../helpers/harness-configuration.mjs"),
      import("../fixtures/credential-workload-selection-v1/producer.ts"),
    ]);
  const events = [];
  const calls = {
    authorization: [],
    bindings: [],
    recoveryBindings: [],
    commandLocks: [],
    commandReads: [],
    intentReads: [],
    prepare: [],
    verify: [],
    credentialPrepare: [],
    credentialVerify: 0,
    inserts: [],
    intentWrites: [],
    audit: [],
    auditComparison: [],
    records: [],
    work: [],
    retentionAttempts: [],
    retained: [],
    releases: { prepared: 0, verified: 0, credential: 0 },
    createId: 0,
    invocation: 0,
    mutation: 0,
    recovery: 0,
    outerAccess: 0,
    validation: [],
    poison: [],
    ioPoison: [],
    recoveryPoison: [],
  };
  const input = { namespaceId, agentId, command: serviceCommand() };
  const source = {
    id: configurationId,
    namespaceId,
    kind: "agent",
    generation: 7,
    createdAt: acceptedAt,
    values: configuration.createHarnessConfiguration("codex", "gpt-4.1"),
    secretBindings: { DATA_TOKEN: { source: { kind: "secret", namespaceId, id: secretId } } },
  };
  const account = {
    id: serviceAccountId,
    namespaceId,
    name: "model-account",
    credential: { kind: "api_key", secretRef: { name: "model-credential", key: "api-key" } },
  };
  const agent = {
    id: agentId,
    namespaceId,
    name: "agent",
    configurationId,
    providerId: "provider/model",
    serviceAccountId,
    servicePrincipalId,
    executionMode: "dedicated",
    createdAt: acceptedAt,
    workloadProfileSelection: clone(input.command.expectedDraft.workloadProfileSelection),
  };
  const secret = {
    id: secretId,
    namespaceId,
    name: "data-token",
    driverId: "secret/example",
    backendRef: { name: "data-token", key: "token" },
  };
  const control = {
    input,
    source,
    account,
    agent,
    secret,
    calls,
    events,
    codec,
    profiles,
    credentials,
    projection,
    activeTransaction: true,
    current: { prepared: true, verified: true, credential: true },
    ioActive: true,
    recoveryActive: true,
    retainedRevision: settings.retainedRevision,
    retainedIntent: settings.retainedIntent,
    prepared: undefined,
    use: undefined,
    record: undefined,
  };
  const errors = {
    prepared: new Error("controlled prepared Use lost currentness"),
    verified: new Error("controlled inserted Use lost currentness"),
    credential: new Error("controlled credential record lost currentness"),
    io: new Error("controlled deployment IO lost currentness"),
    recovery: new Error("controlled recovery IO lost currentness"),
  };
  async function point(name, value) {
    events.push(`${name}:start`);
    if (
      settings.onlyReplay &&
      !["authorize", "command.lock", "command.read", "intent.read", "installation.read"].includes(
        name,
      )
    )
      assert.fail(`Replay or recovery attempted fresh work: ${name}`);
    await settings.hooks?.[name]?.(control, value);
    events.push(`${name}:end`);
    return value;
  }
  function makeIo(recovery = false) {
    let poisoned = false;
    let failure;
    return {
      assertActive() {
        if (poisoned) throw failure;
        if (!(recovery ? control.recoveryActive : control.ioActive))
          throw recovery ? errors.recovery : errors.io;
      },
      poison(error) {
        (recovery ? calls.recoveryPoison : calls.ioPoison).push(error);
        if (!poisoned) {
          poisoned = true;
          failure = error;
        }
      },
      async query() {
        assert.fail("Service conformance supplies repository operations, not SQL");
      },
    };
  }
  const io = makeIo();
  const recoveryIo = makeIo(true);
  const controller = new AbortController();
  const recoveryController = new AbortController();
  const selectedScope = (actual) => ({ namespaceId: actual.namespaceId, agentId: actual.agentId });
  const state = {
    namespaces: {
      async lockNamespace(target) {
        assert.equal(target, namespaceId);
        return point("namespace.lock", {
          id: namespaceId,
          name: "namespace",
          status: "ready",
          createdAt: acceptedAt,
        });
      },
    },
    agents: {
      async findAgent(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, agentId]);
        return point("agent.find", agent);
      },
      async lockAgent(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, agentId]);
        return point("agent.lock", agent);
      },
    },
    configurations: {
      async lockConfiguration(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, configurationId]);
        return point("configuration.lock", source);
      },
    },
    serviceAccounts: {
      async lockServiceAccount(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, serviceAccountId]);
        return point("account.lock", account);
      },
      async findServiceAccountProviderBinding() {
        assert.fail("API-key fixture has no token binding");
      },
    },
    secrets: {
      async lockSecret(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, secretId]);
        return point("secret.lock", secret);
      },
    },
    revisions: {
      async listRevisions(namespace, target) {
        assert.deepEqual([namespace, target], [namespaceId, agentId]);
        return point("revision.list", []);
      },
      async createRevision(...operands) {
        calls.inserts.push(operands);
        return point("revision.insert", settings.returnRevision?.(operands[0]) ?? operands[0]);
      },
    },
    runtimeAssignments: {
      async findRuntimeIntentHead(actual) {
        assert.deepEqual(selectedScope(actual), { namespaceId, agentId });
        return point("head.read", settings.head);
      },
      async findRuntimeIntent(actual, operationRef) {
        calls.intentReads.push([clone(actual), operationRef]);
        return point("intent.read", control.retainedIntent);
      },
      async initializeRuntimeIntent(actual, revisionId, operationRef, attribution) {
        calls.intentWrites.push([clone(actual), revisionId, operationRef, clone(attribution)]);
        return point("intent.write", {
          installationId,
          namespaceId: actual.namespaceId,
          agentId: actual.agentId,
          revisionId,
          transitionRef: operationRef,
          desiredMode: "running",
          generation: 1,
          ...attribution,
          createdAt: acceptedAt,
          ...settings.intentOverrides,
        });
      },
      async advanceRuntimeIntent(actual, generation, desired, operationRef, attribution) {
        calls.intentWrites.push([
          clone(actual),
          generation,
          clone(desired),
          operationRef,
          clone(attribution),
        ]);
        return point("intent.write", {
          installationId,
          ...selectedScope(actual),
          ...desired,
          transitionRef: operationRef,
          generation: generation + 1,
          ...attribution,
          createdAt: acceptedAt,
        });
      },
    },
    runtimeAdmissions: {
      async lockDeployCommand(actual, operationRef) {
        calls.commandLocks.push([clone(actual), operationRef]);
        await point("command.lock");
      },
      async findCommittedDeployCommand(...operands) {
        calls.commandReads.push(operands);
        if (settings.replayFailure) throw settings.replayFailure;
        return point("command.read", control.retainedRevision);
      },
      async recordAdmission(...operands) {
        calls.records.push(operands);
        await point("admission.record", operands);
      },
    },
    audit: {
      async append(value) {
        calls.audit.push(value);
        await point("audit.append", value);
      },
    },
    operations: {
      async append(value) {
        calls.work.push(value);
        await point("work.append", value);
      },
    },
  };
  const read = {
    installations: {
      async getInstallation() {
        return point("installation.read", { id: settings.readInstallationId ?? installationId });
      },
    },
    agents: {
      async findAgent() {
        assert.fail("Command recovery does not consult the current Agent draft");
      },
    },
    runtimeAssignments: { findRuntimeIntent: state.runtimeAssignments.findRuntimeIntent },
    runtimeAdmissions: {
      findCommittedDeployCommand: state.runtimeAdmissions.findCommittedDeployCommand,
      async findCommittedAdmission() {
        assert.fail("Command recovery uses its original command join");
      },
    },
  };
  const unit = {
    kind: "deployment",
    installationId,
    namespaceId,
    agentId,
    operationRef: input.command.operationRef,
    platform: state,
    signal: controller.signal,
    retain(guard) {
      const role =
        calls.retentionAttempts.filter(({ role }) => role !== "credential").length === 0
          ? "prepared"
          : "verified";
      calls.retentionAttempts.push({ role, guard });
      events.push(`${role}.retain`);
      if (settings.refuseRetention === role) throw errors[role];
      calls.retained.push({ role, guard });
      return undefined;
    },
    ...settings.unitOverrides,
  };
  const recoveryUnit = {
    kind: "deployment-recovery",
    installationId,
    namespaceId,
    agentId,
    operationRef: input.command.operationRef,
    read,
    signal: recoveryController.signal,
    retain() {
      assert.fail("Command recovery acquires no active-profile lease");
    },
    ...settings.recoveryUnitOverrides,
  };
  function lease(role) {
    return {
      assertCurrent() {
        if (!control.current[role]) throw errors[role];
        if (settings.assertion?.[role]) return settings.assertion[role](control);
        return undefined;
      },
      async release() {
        calls.releases[role]++;
        await point(`${role}.release`);
      },
    };
  }
  const template = examples.exampleCredentialWorkloadSelectionV1();
  const roleRefs = clone(template.association.profileRefs);
  const storePolicyBindings = stores();
  const workloadProfiles = {
    invocations: {
      async forCurrentInvocation() {
        calls.invocation++;
        await settings.onInvocation?.(control);
        return invocation;
      },
    },
    enrollment: {
      async withDeployment(actualInvocation, binding, work) {
        assert.equal(actualInvocation, invocation);
        calls.bindings.push(binding);
        if (settings.enrollmentFailure) throw settings.enrollmentFailure;
        return work(unit, io);
      },
      async withRecovery(actualInvocation, binding, work) {
        assert.equal(actualInvocation, invocation);
        calls.recoveryBindings.push(binding);
        return work(recoveryUnit, recoveryIo);
      },
    },
    use: {
      async validateSelectionLocked() {
        assert.fail("Deployment prepares the actual revision Use");
      },
      async prepareUseLocked(request, candidate, actualUnit, actualIo) {
        calls.prepare.push({ request, candidate, unit: actualUnit, io: actualIo });
        assert.equal(actualUnit, unit);
        assert.equal(actualIo, io);
        await point("use.prepare", candidate);
        const projected = projection.deriveAdmittedConfigurationV1(
          admittedProjection(candidate, request.selection, roleRefs, storePolicyBindings),
        );
        const use = {
          schemaVersion: 2,
          installationId,
          namespaceId,
          component: "gateway-harness-pair",
          ...clone(request.selection),
          canonicalFormat: "oce.workload-profile.canonical-json.v1",
          profileRefs: clone(roleRefs),
          admittedConfigurationDigest: projected.admittedConfigurationDigest,
        };
        settings.changeUse?.(use, control);
        control.use = use;
        const prepared = {
          ...lease("prepared"),
          use,
          async verifyInserted(actualIo) {
            assert.equal(actualIo, io);
            calls.verify.push(actualIo);
            await point("use.verify");
            // Only service-consumed fields are supplied. Original resolver tests
            // own full manifest/digest correspondence; no definition is fabricated.
            const verified = { ...lease("verified"), request: clone(request), use: clone(use) };
            settings.changeVerified?.(verified, control);
            return verified;
          },
        };
        settings.changePrepared?.(prepared, control);
        control.prepared = prepared;
        return prepared;
      },
    },
  };
  const invocation = Object.freeze({}); // Recognized by this controlled fixture only.
  const credentialSelection = {
    async prepare(context) {
      calls.credentialPrepare.push(context);
      await point("credential.prepare", context);
      const record = examples.exampleCredentialWorkloadSelectionV1();
      record.revisionId = context.revision.id;
      record.association.selection = clone(calls.prepare[0].request.selection);
      record.association.profileRefs = clone(roleRefs);
      settings.changeCredentialAssociation?.(record.association, control);
      record.association.admittedConfigurationDigest = projection.deriveAdmittedConfigurationV1(
        admittedProjection(
          context.revision,
          record.association.selection,
          record.association.profileRefs,
          storePolicyBindings,
        ),
      ).admittedConfigurationDigest;
      settings.changeCredentialRecord?.(record, control);
      control.record = record;
      return {
        ...lease("credential"),
        record,
        storePolicyBindings,
        async verifyInserted() {
          calls.credentialVerify++;
          await point("credential.verify");
        },
      };
    },
    retain(context, guard) {
      assert.equal(context, calls.credentialPrepare.at(-1));
      calls.retentionAttempts.push({ role: "credential", guard });
      events.push("credential.retain");
      if (settings.refuseRetention === "credential") throw errors.credential;
      calls.retained.push({ role: "credential", guard });
      return undefined;
    },
  };
  const outerProjection = Object.fromEntries(
    Object.entries(state).map(([name, methods]) => [
      name,
      Object.fromEntries(
        Object.keys(methods).map((method) => [
          method,
          () => {
            calls.outerAccess++;
            assert.fail("Command service used the outer projection instead of its enrolled unit");
          },
        ]),
      ),
    ]),
  );
  const secretDriver = {
    id: secret.driverId,
    implementation: "controlled-secret",
    async resolve(value) {
      assert.equal(value, secret);
      return point("secret.resolve", { ...secret.backendRef });
    },
  };
  const options = {
    installationId,
    repositories: {
      async mutate(work) {
        calls.mutation++;
        events.push("mutation:start");
        try {
          return await work(outerProjection);
        } finally {
          events.push("mutation:end");
        }
      },
    },
    async recoveryRead(work) {
      calls.recovery++;
      assert.equal(control.activeTransaction, false);
      events.push("recovery:start");
      try {
        return await work(outerProjection);
      } finally {
        events.push("recovery:end");
      }
    },
    hasActiveTransaction: () => control.activeTransaction,
    poisonAdmission(error) {
      calls.poison.push(error);
    },
    authorization: {
      async authorize(actor, action, resource) {
        calls.authorization.push({ actor, action, resource: clone(resource) });
        await point("authorize", { actor, action, resource });
      },
    },
    computeDriver() {
      events.push("compute.select");
      if (settings.onlyReplay) assert.fail("Replay selected a current Compute Driver");
      return { id: "compute/example", implementation: "controlled-compute" };
    },
    configurationDriver: () => ({
      id: "configuration/example",
      async read(actual) {
        assert.deepEqual(actual, { id: configurationId, namespaceId });
        return point("configuration.read", source);
      },
      async validate(value) {
        calls.validation.push(clone(value));
        await point("configuration.validate", value);
      },
    }),
    secretDriver(expected) {
      if (expected !== undefined) assert.equal(expected, secret.driverId);
      return secretDriver;
    },
    sandboxDriver: () => ({ id: "sandbox/example", configureAgent: sandboxValues }),
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
    createId() {
      calls.createId++;
      return serviceRevisionId;
    },
    now: () => acceptedAt,
    isRuntimeAdmissionAudit(event, intent) {
      // Observe complete operands; this accepting predicate is not a copied or
      // invoked production audit evaluator and supplies no current authority.
      calls.auditComparison.push({ event: clone(event), intent: clone(intent) });
      return settings.auditAccepted !== false;
    },
    ...(settings.noProfiles ? {} : { workloadProfiles }),
    ...(settings.noCredentialProducer ? {} : { credentialSelection }),
  };
  const admission = {
    transitionRef: input.command.operationRef,
    requestId: originalRequestId,
    ...(settings.noCredentialRequirement ? {} : { requireCredentialSelection: true }),
    createAuditEvent(revision) {
      events.push("audit.create");
      settings.onAudit?.(control);
      return {
        id: auditId,
        installationId,
        namespaceId,
        occurredAt: acceptedAt,
        kind: "mutation",
        actorId: principalId,
        requestId: originalRequestId,
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revision.id, namespaceId },
        outcome: "success",
      };
    },
  };
  const service = new domain.DeploymentService(options);
  const harness = (name, mode) => {
    assert.deepEqual([name, mode], ["codex", "dedicated"]);
    if (settings.onlyReplay) assert.fail("Replay resolved a current Harness");
    return { id: "codex", version: "test-version" };
  };
  let cleanup;
  return Object.assign(control, {
    state,
    read,
    unit,
    recoveryUnit,
    io,
    recoveryIo,
    controller,
    recoveryController,
    options,
    admission,
    workloadProfiles,
    service,
    errors,
    roleRefs,
    storePolicyBindings,
    expectedConfiguration: () =>
      logging.admitLoggingConfiguration(sandboxValues(source.values), "warn"),
    deploy(actualInput = input, actualAdmission = admission, actor = principalId) {
      return service.deployAgentCommand(actor, actualInput, harness, actualAdmission);
    },
    recover(actualInput = input, actor = principalId) {
      return service.recoverDeployAgentCommand(actor, actualInput);
    },
    finish() {
      // Explicit controlled terminal cleanup, with no asserted COMMIT outcome.
      cleanup ??= (async () => {
        for (const { guard } of [...calls.retained].reverse()) await guard.release();
      })();
      return cleanup;
    },
  });
}

function before(events, first, second) {
  assert.notEqual(events.indexOf(first), -1, first);
  assert.notEqual(events.indexOf(second), -1, second);
  assert.ok(events.indexOf(first) < events.indexOf(second), `${first} must precede ${second}`);
}
function noPublication(control) {
  assert.equal(control.calls.intentWrites.length, 0);
  assert.equal(control.calls.audit.length, 0);
  assert.equal(control.calls.records.length, 0);
  assert.equal(control.calls.work.length, 0);
}

test("actual command admission inserts one normalized revision with paired Use and a separate matching credential record", async () => {
  const control = await deploymentFixture();
  const originalInput = clone(control.input);
  const receipt = await control.deploy();
  assert.deepEqual(plain(receipt), acceptedReceipt(originalInput.command.operationRef));
  assert.equal(control.calls.invocation, 1);
  assert.equal(control.calls.mutation, 1);
  assert.equal(control.calls.bindings.length, 1);
  const binding = control.calls.bindings[0];
  assert.deepEqual(plain(binding), [principalId, originalInput]);
  assert.ok(Object.isFrozen(binding));
  assert.ok(Object.isFrozen(binding[1]));
  assert.ok(Object.isFrozen(binding[1].command.expectedDraft));
  assert.notEqual(binding[1].command, control.input.command);
  assert.equal(control.calls.outerAccess, 0);
  assert.equal(control.calls.commandLocks.length, 1);
  assert.equal(control.calls.commandLocks[0][1], originalInput.command.operationRef);
  assert.equal(control.calls.commandReads[0].length, 3);
  assert.deepEqual(plain(control.calls.commandReads[0][1]), originalInput.command);
  assert.equal(control.calls.commandReads[0][2], principalId);
  assert.equal(control.calls.createId, 1);
  assert.equal(control.calls.prepare.length, 1);
  const prepared = control.calls.prepare[0];
  assert.equal(prepared.unit, control.unit);
  assert.equal(prepared.unit.platform, control.state);
  assert.equal(prepared.io, control.io);
  assert.deepEqual(plain(prepared.request), {
    schemaVersion: 2,
    installationId,
    namespaceId,
    agentId,
    revisionId: serviceRevisionId,
    configurationRef: configurationId,
    configurationVersion: 7,
    selection: originalInput.command.expectedDraft.workloadProfileSelection,
  });
  assert.equal(Object.hasOwn(prepared.candidate, "workloadProfileUse"), false);
  assert.equal(Object.hasOwn(prepared.candidate, "credentialWorkloadSelection"), false);
  assert.deepEqual(plain(prepared.candidate.configuration), control.expectedConfiguration());
  assert.deepEqual(control.calls.validation[0].values, control.expectedConfiguration());
  assert.notDeepEqual(plain(prepared.candidate.configuration), control.source.values);
  assert.deepEqual(plain(prepared.candidate.serviceAccount), {
    id: serviceAccountId,
    credential: control.account.credential,
  });
  assert.equal(prepared.candidate.servicePrincipalId, servicePrincipalId);
  assert.ok(Object.isFrozen(prepared.candidate.configuration));
  assert.equal(control.calls.inserts.length, 1);
  const [candidate, record] = control.calls.inserts[0];
  assert.equal(control.calls.inserts[0].length, 2);
  assert.equal(candidate.id, serviceRevisionId);
  assert.equal(
    control.profiles.decodeWorkloadProfileUseV2(candidate.workloadProfileUse).kind,
    "valid",
  );
  assert.equal(control.credentials.decodeCredentialWorkloadSelectionV1(record).kind, "valid");
  const use = candidate.workloadProfileUse;
  assert.equal(use.schemaVersion, 2);
  assert.equal(use.component, "gateway-harness-pair");
  assert.deepEqual(plain(use.profileRefs), control.roleRefs);
  assert.deepEqual(
    plain(record.association.selection),
    originalInput.command.expectedDraft.workloadProfileSelection,
  );
  assert.equal(use.admittedConfigurationDigest, record.association.admittedConfigurationDigest);
  assert.equal(
    use.admittedConfigurationDigest,
    control.projection.deriveAdmittedConfigurationV1(
      admittedProjection(
        candidate,
        record.association.selection,
        record.association.profileRefs,
        control.storePolicyBindings,
      ),
    ).admittedConfigurationDigest,
  );
  assert.equal(Object.hasOwn(candidate, "credentialWorkloadSelection"), false);
  for (const key of ["materialSelection", "model", "repository", "channels", "serviceAccount"])
    assert.equal(Object.hasOwn(use, key), false);
  assert.equal(Object.hasOwn(record, "workloadProfileUse"), false);
  assert.equal(control.calls.credentialPrepare[0].revision, candidate);
  assert.equal(control.calls.verify.length, 1);
  assert.equal(control.calls.credentialVerify, 1);
  assert.deepEqual(
    control.calls.retained.map(({ role }) => role),
    ["prepared", "credential", "verified"],
  );
  assert.deepEqual(control.calls.releases, { prepared: 0, verified: 0, credential: 0 });
  for (const { guard } of control.calls.retained) assert.equal(guard.assertCurrent(), undefined);
  assert.deepEqual(
    control.calls.authorization,
    [
      [principalId, "deploy", "agent", agentId],
      [principalId, "deploy", "agent", agentId],
      [principalId, "read", "service_account", serviceAccountId],
      [principalId, "read", "configuration", configurationId],
      [principalId, "operate", "secret", secretId],
      [servicePrincipalId, "operate", "secret", secretId],
    ].map(([actor, action, kind, target]) => ({
      actor,
      action,
      resource: { kind, id: target, namespaceId },
    })),
  );
  const expectedIntent = {
    installationId,
    namespaceId,
    agentId,
    revisionId: serviceRevisionId,
    transitionRef: originalInput.command.operationRef,
    desiredMode: "running",
    generation: 1,
    actorId: principalId,
    requestId: originalRequestId,
    createdAt: acceptedAt,
  };
  assert.deepEqual(control.calls.auditComparison, [
    { event: control.calls.audit[0], intent: expectedIntent },
  ]);
  assert.deepEqual(control.calls.audit[0], {
    id: auditId,
    installationId,
    namespaceId,
    occurredAt: acceptedAt,
    kind: "mutation",
    actorId: principalId,
    requestId: originalRequestId,
    action: "openclaw.agents.deploy",
    resource: { kind: "agent_revision", id: serviceRevisionId, namespaceId },
    outcome: "success",
  });
  assert.deepEqual(plain(control.calls.records), [
    [
      {
        namespaceId,
        agentId,
        revisionId: serviceRevisionId,
        runtimeTransitionRef: originalInput.command.operationRef,
        lifecycleGeneration: 1,
        auditEventId: auditId,
      },
      { command: originalInput.command, actorId: principalId },
    ],
  ]);
  assert.equal(
    control.codec.canonicalLifecycleDeployCommandV2(scope, control.calls.records[0][1].command),
    control.codec.canonicalLifecycleDeployCommandV2(scope, originalInput.command),
  );
  assert.deepEqual(control.calls.work, [
    {
      kind: "agent_revision",
      action: "reconcile",
      namespaceId,
      resourceId: serviceRevisionId,
      actorId: principalId,
      runtimeTransitionRef: originalInput.command.operationRef,
      lifecycleGeneration: 1,
    },
  ]);
  for (const [first, second] of [
    ["command.lock:end", "command.read:start"],
    ["command.read:end", "namespace.lock:start"],
    ["configuration.validate:end", "use.prepare:start"],
    ["use.prepare:end", "prepared.retain"],
    ["credential.prepare:end", "revision.insert:start"],
    ["revision.insert:end", "use.verify:start"],
    ["use.verify:end", "verified.retain"],
    ["verified.retain", "credential.verify:start"],
    ["credential.verify:end", "audit.create"],
    ["audit.create", "intent.write:start"],
    ["intent.write:end", "audit.append:start"],
    ["audit.append:end", "admission.record:start"],
    ["admission.record:end", "work.append:start"],
  ])
    before(control.events, first, second);
  await control.finish();
  await control.finish();
  assert.deepEqual(control.calls.releases, { prepared: 1, verified: 1, credential: 1 });
});

test("canonical Use data may change object prototypes while every other inserted revision field stays exact", async () => {
  const control = await deploymentFixture({
    returnRevision(candidate) {
      return { ...candidate, workloadProfileUse: plain(candidate.workloadProfileUse) };
    },
  });
  await control.deploy();
  assert.equal(control.calls.inserts.length, 1);
  assert.equal(control.calls.verify.length, 1);
  assert.equal(control.calls.work.length, 1);
  await control.finish();
});

test("command operands are captured before an awaited invocation can observe caller mutation", async () => {
  const control = await deploymentFixture({
    onInvocation(value) {
      value.input.command.expectedDraft.configurationGeneration = 99;
      value.input.command.expectedDraft.workloadProfileSelection.admissionVersion = 100;
      value.input.namespaceId = id("ns", 60);
    },
  });
  const expected = clone(control.input);
  await control.deploy();
  assert.deepEqual(plain(control.calls.bindings[0]), [principalId, expected]);
  assert.deepEqual(plain(control.calls.records[0][1].command), expected.command);
  assert.deepEqual(
    plain(control.calls.prepare[0].request.selection),
    expected.command.expectedDraft.workloadProfileSelection,
  );
  assert.equal(control.calls.inserts[0][0].configurationGeneration, 7);
  await control.finish();
});

test("missing profile composition or a different trusted operation cannot reach draft work", async () => {
  const unavailable = await deploymentFixture({ noProfiles: true });
  await assert.rejects(unavailable.deploy());
  assert.equal(unavailable.calls.commandReads.length, 0);
  assert.equal(unavailable.calls.inserts.length, 0);
  noPublication(unavailable);
  const wrongOperation = await deploymentFixture();
  await assert.rejects(
    wrongOperation.deploy(wrongOperation.input, {
      ...wrongOperation.admission,
      transitionRef: uuid(60),
    }),
  );
  assert.equal(wrongOperation.calls.mutation, 0);
});

test("new command admission compares all saved draft and lifecycle expectations before preparing Use", async () => {
  for (const change of [
    (control) => {
      control.agent.configurationId = id("cfg", 60);
    },
    (control) => {
      control.agent.providerId = "provider/changed";
    },
    (control) => {
      control.agent.executionMode = "embedded";
    },
    (control) => {
      delete control.agent.serviceAccountId;
    },
    (control) => {
      control.source.generation++;
    },
    ...["manifestRef", "manifestDigest", "admissionRef", "admissionVersion"].map(
      (key) => (control) => {
        control.agent.workloadProfileSelection[key] =
          key === "admissionVersion" ? 10 : key === "manifestDigest" ? digest("f") : uuid(60);
      },
    ),
    (control) => {
      delete control.agent.workloadProfileSelection;
    },
    (control) => {
      control.input.command.expectedLifecycleGeneration = 1;
    },
  ]) {
    const control = await deploymentFixture();
    change(control);
    await assert.rejects(control.deploy());
    assert.equal(control.calls.prepare.length, 0);
    assert.equal(control.calls.inserts.length, 0);
    assert.equal(control.calls.createId, 0);
    noPublication(control);
  }
});

test("foreign deployment owner coordinates refuse before replay or current draft lookup", async () => {
  for (const unitOverrides of [
    { kind: "agent-selection" },
    { installationId: id("ins", 60) },
    { namespaceId: id("ns", 60) },
    { agentId: id("agt", 60) },
    { operationRef: uuid(60) },
  ]) {
    const control = await deploymentFixture({ unitOverrides });
    await assert.rejects(control.deploy());
    assert.equal(control.calls.commandReads.length, 0);
    assert.equal(control.calls.prepare.length, 0);
    assert.equal(control.calls.inserts.length, 0);
    assert.ok(control.calls.ioPoison.length > 0);
  }
});

test("malformed or foreign prepared Use is retained for cleanup and refused before initial INSERT", async () => {
  for (const changeUse of [
    (use) => {
      use.schemaVersion = 1;
    },
    (use) => {
      use.component = "harness";
    },
    (use) => {
      use.installationId = id("ins", 60);
    },
    (use) => {
      use.namespaceId = id("ns", 60);
    },
    (use) => {
      use.manifestRef = uuid(60);
    },
    (use) => {
      use.manifestDigest = digest("f");
    },
    (use) => {
      use.admissionRef = uuid(60);
    },
    (use) => {
      use.admissionVersion++;
    },
    (use) => {
      use.materialSelection = {};
    },
    (use) => {
      use.profileRefs.runtime.ref = use.profileRefs.provider.ref;
    },
  ]) {
    const control = await deploymentFixture({ changeUse });
    await assert.rejects(control.deploy());
    assert.equal(control.calls.inserts.length, 0);
    assert.deepEqual(
      control.calls.retained.map(({ role }) => role),
      ["prepared"],
    );
    assert.deepEqual(control.calls.releases, { prepared: 0, verified: 0, credential: 0 });
    noPublication(control);
    await control.finish();
    assert.equal(control.calls.releases.prepared, 1);
  }
});

test("individually decoded credential records must match the paired Use Selection, five roles and configuration digest", async () => {
  for (const settings of [
    {
      changeCredentialAssociation(value) {
        value.selection.manifestRef = uuid(60);
      },
    },
    {
      changeCredentialAssociation(value) {
        value.selection.admissionRef = uuid(60);
      },
    },
    {
      changeCredentialAssociation(value) {
        value.selection.admissionVersion++;
      },
    },
    ...["provider", "runtime", "identity", "containment", "storage"].map((role) => ({
      changeCredentialAssociation(value) {
        value.profileRefs[role].version++;
      },
    })),
    {
      changeUse(value) {
        value.admittedConfigurationDigest = digest("f");
      },
    },
  ]) {
    const control = await deploymentFixture(settings);
    await assert.rejects(control.deploy());
    assert.equal(control.profiles.decodeWorkloadProfileUseV2(control.use).kind, "valid");
    assert.equal(
      control.credentials.decodeCredentialWorkloadSelectionV1(control.record).kind,
      "valid",
    );
    assert.equal(control.calls.inserts.length, 0);
    noPublication(control);
    await control.finish();
    assert.deepEqual(control.calls.releases, { prepared: 1, verified: 0, credential: 1 });
  }
});

test("verifyInserted result is retained before its exact request and Use correspondence is checked", async () => {
  for (const changeVerified of [
    (value) => {
      value.request.revisionId = id("rev", 60);
    },
    (value) => {
      value.request.configurationVersion++;
    },
    (value) => {
      value.request.agentId = id("agt", 60);
    },
    (value) => {
      value.request.selection.admissionVersion++;
    },
    (value) => {
      value.use.admittedConfigurationDigest = digest("f");
    },
    (value) => {
      value.use.profileRefs.runtime.version++;
    },
    (value) => {
      value.use.component = "harness";
    },
  ]) {
    const control = await deploymentFixture({ changeVerified });
    await assert.rejects(control.deploy());
    assert.equal(control.calls.inserts.length, 1);
    assert.equal(control.calls.verify.length, 1);
    assert.equal(control.calls.credentialVerify, 0);
    assert.deepEqual(
      control.calls.retained.map(({ role }) => role),
      ["prepared", "credential", "verified"],
    );
    noPublication(control);
    await control.finish();
    assert.deepEqual(control.calls.releases, { prepared: 1, verified: 1, credential: 1 });
  }
});

test("an INSERT response cannot alter the admitted revision or inject its protected credential sibling", async () => {
  for (const alter of [
    (value) => {
      value.id = id("rev", 60);
    },
    (value) => {
      value.servicePrincipalId = id("prn", 60);
    },
    (value) => {
      value.configurationGeneration++;
    },
    (value) => {
      value.workloadProfileUse.profileRefs.identity.version++;
    },
    (value) => {
      value.credentialWorkloadSelection = { marker: "private" };
    },
  ]) {
    const control = await deploymentFixture({
      returnRevision(candidate) {
        const value = clone(candidate);
        alter(value);
        return value;
      },
    });
    await assert.rejects(control.deploy());
    assert.equal(control.calls.inserts.length, 1);
    assert.equal(control.calls.verify.length, 0);
    noPublication(control);
    await control.finish();
  }
});

test("Use and credential verification failures poison a caught admission before intent, audit or work", async () => {
  for (const stage of ["use.verify", "credential.verify"]) {
    const failure = new Error(`controlled ${stage} failure`);
    const control = await deploymentFixture({
      hooks: {
        [stage]() {
          throw failure;
        },
      },
    });
    await assert.rejects(control.deploy(), (error) => error === failure);
    assert.equal(control.calls.inserts.length, 1);
    noPublication(control);
    assert.ok(control.calls.ioPoison.includes(failure));
    assert.ok(control.calls.poison.includes(failure));
    assert.throws(
      () => control.io.assertActive(),
      (error) => error === failure,
    );
    assert.deepEqual(control.calls.releases, { prepared: 0, verified: 0, credential: 0 });
    await control.finish();
    assert.deepEqual(control.calls.releases, {
      prepared: 1,
      verified: stage === "credential.verify" ? 1 : 0,
      credential: 1,
    });
  }
});

test("lease currentness is fenced at acquisition and after each write or verification await", async () => {
  for (const [stage, role, expectedInserts] of [
    ["use.prepare", "prepared", 0],
    ["credential.prepare", "prepared", 0],
    ["revision.insert", "prepared", 1],
    ["use.verify", "prepared", 1],
    ["credential.verify", "verified", 1],
    ["intent.write", "verified", 1],
    ["audit.append", "prepared", 1],
    ["admission.record", "credential", 1],
    ["work.append", "verified", 1],
  ]) {
    const control = await deploymentFixture({
      hooks: {
        [stage](value) {
          value.current[role] = false;
        },
      },
    });
    await assert.rejects(control.deploy());
    assert.equal(control.calls.inserts.length, expectedInserts);
    assert.ok(control.calls.poison.length > 0);
    if (
      [
        "use.prepare",
        "credential.prepare",
        "revision.insert",
        "use.verify",
        "credential.verify",
      ].includes(stage)
    )
      noPublication(control);
    if (stage === "intent.write") assert.equal(control.calls.audit.length, 0);
    if (stage === "audit.append") assert.equal(control.calls.records.length, 0);
    if (stage === "admission.record") assert.equal(control.calls.work.length, 0);
    if (stage === "work.append") assert.equal(control.calls.work.length, 1);
    await control.finish();
    for (const count of Object.values(control.calls.releases))
      assert.ok(count === 0 || count === 1);
    assert.equal(control.calls.releases.prepared, 1);
  }
});

test("IO loss before replay lookup and after the INSERT cannot be hidden by held producer leases", async () => {
  for (const stage of ["before", "revision.insert"]) {
    const control = await deploymentFixture({
      hooks:
        stage === "before"
          ? {}
          : {
              [stage](value) {
                value.ioActive = false;
              },
            },
    });
    if (stage === "before") control.ioActive = false;
    await assert.rejects(control.deploy());
    assert.equal(control.calls.inserts.length, stage === "before" ? 0 : 1);
    assert.equal(control.calls.verify.length, 0);
    noPublication(control);
    await control.finish();
  }
});

test("refused prepare or verification retention cleans only the untransferred acquisition locally", async () => {
  for (const role of ["prepared", "verified"]) {
    const control = await deploymentFixture({ refuseRetention: role });
    await assert.rejects(control.deploy());
    assert.equal(
      control.calls.retained.some((value) => value.role === role),
      false,
    );
    assert.equal(control.calls.releases[role], 1);
    assert.equal(control.calls.inserts.length, role === "prepared" ? 0 : 1);
    noPublication(control);
    if (role === "verified") {
      assert.equal(control.calls.releases.prepared, 0);
      assert.equal(control.calls.releases.credential, 0);
    }
    await control.finish();
    assert.deepEqual(control.calls.releases, {
      prepared: 1,
      verified: role === "verified" ? 1 : 0,
      credential: role === "verified" ? 1 : 0,
    });
  }
});

test("Deployment Use joins acquired cleanup when poison reporting throws", async () => {
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
      const control = await deploymentFixture({
        changePrepared(prepared) {
          if (point === "assertion")
            prepared.assertCurrent = () => {
              throw firstFailure;
            };
        },
        hooks: {
          async "prepared.release"() {
            announceRelease();
            await releaseGate;
            releaseFinished = true;
          },
        },
      });
      // This records attempted reporting, not successful original-owner poison.
      control.io.poison = (error) => {
        reported.push(error);
        throw reporterFailure;
      };
      if (point === "retention") {
        control.unit.retain = () => {
          retentionAttempts++;
          throw firstFailure;
        };
      }
      const outcome = control.deploy().then(
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
        assert.equal(control.calls.releases.prepared, 1);
        assert.equal(control.calls.retained.length, 0);
        assert.equal(control.calls.inserts.length, 0);
        noPublication(control);
      } finally {
        completeRelease();
      }
      const result = await outcome;
      assert.equal(result.kind, "rejected");
      assert.equal(result.error, firstFailure);
      assert.equal(releaseFinished, true);
      assert.ok(reported.length > 0);
      assert.equal(reported[0], firstFailure);
      assert.ok(control.calls.poison.includes(firstFailure));
      assert.equal(retentionAttempts, point === "retention" ? 1 : 0);
      await control.finish();
      assert.deepEqual(control.calls.releases, { prepared: 1, verified: 0, credential: 0 });
    }
  }
});

test("malformed asynchronous profile assertions are observed and drain before local cleanup", async () => {
  let settled = false;
  const control = await deploymentFixture({
    assertion: {
      prepared() {
        return Promise.resolve().then(() => {
          settled = true;
          throw new Error("controlled invalid asynchronous profile assertion");
        });
      },
    },
    hooks: {
      "prepared.release"() {
        assert.equal(settled, true);
      },
    },
  });
  await assert.rejects(control.deploy());
  assert.equal(settled, true);
  assert.equal(control.calls.retained.length, 0);
  assert.equal(control.calls.releases.prepared, 1);
  assert.equal(control.calls.inserts.length, 0);
  noPublication(control);
});

test("both retained Use leases remain live through the callback-to-terminal gap", async () => {
  for (const role of ["prepared", "verified"]) {
    const control = await deploymentFixture();
    await control.deploy();
    assert.deepEqual(control.calls.releases, { prepared: 0, verified: 0, credential: 0 });
    control.current[role] = false;
    const retained = control.calls.retained.find((value) => value.role === role);
    assert.throws(
      () => retained.guard.assertCurrent(),
      (error) => error === control.errors[role],
    );
    assert.ok(control.calls.ioPoison.includes(control.errors[role]));
    await control.finish();
    await control.finish();
    assert.deepEqual(control.calls.releases, { prepared: 1, verified: 1, credential: 1 });
  }
});

test("invalid intent correspondence or receipt is poisoned before the mutation callback returns", async () => {
  for (const intentOverrides of [
    { transitionRef: uuid(60) },
    { requestId: id("req", 60) },
    { generation: 2 },
    { createdAt: "not-a-timestamp" },
  ]) {
    const control = await deploymentFixture({ intentOverrides });
    await assert.rejects(control.deploy());
    assert.ok(control.calls.poison.length > 0);
    assert.ok(control.calls.ioPoison.length > 0);
    assert.throws(() => control.io.assertActive());
    await control.finish();
  }
});

async function retainedExample() {
  const original = await deploymentFixture();
  const receipt = await original.deploy();
  const retainedRevision = clone(original.calls.inserts[0][0]);
  const retainedIntent = clone(original.calls.auditComparison[0].intent);
  await original.finish();
  return { retainedRevision, retainedIntent, receipt: plain(receipt) };
}
function assertNoFreshDeployment(control) {
  assert.equal(control.calls.prepare.length, 0);
  assert.equal(control.calls.credentialPrepare.length, 0);
  assert.equal(control.calls.inserts.length, 0);
  assert.equal(control.calls.createId, 0);
  assert.equal(control.calls.retained.length, 0);
  assert.equal(control.calls.validation.length, 0);
  noPublication(control);
}

test("exact replay returns the original receipt before current draft, head, provider or profile acquisition", async () => {
  const historical = await retainedExample();
  const control = await deploymentFixture({ ...historical, onlyReplay: true });
  delete control.agent.workloadProfileSelection;
  control.source.generation = 99;
  control.options.providers.clear();
  const retriedAdmission = {
    ...control.admission,
    requestId: id("req", 60),
    createAuditEvent() {
      assert.fail("Replay must retain the original request attribution");
    },
  };
  const receipt = await control.deploy(control.input, retriedAdmission);
  assert.deepEqual(plain(receipt), historical.receipt);
  assert.equal(control.calls.commandLocks.length, 1);
  assert.equal(control.calls.commandReads.length, 1);
  const [, originalCommand, actor] = control.calls.commandReads[0];
  assert.deepEqual(plain(originalCommand), serviceCommand());
  assert.equal(actor, principalId);
  assert.equal(control.calls.commandReads[0].length, 3, "replay must not pass a new request ID");
  assert.equal(control.calls.intentReads[0][1], serviceCommand().operationRef);
  assert.equal(control.retainedIntent.requestId, originalRequestId);
  assert.deepEqual(control.calls.authorization, [
    {
      actor: principalId,
      action: "deploy",
      resource: { kind: "agent", id: agentId, namespaceId },
    },
  ]);
  before(control.events, "authorize:end", "command.lock:start");
  before(control.events, "command.lock:end", "command.read:start");
  before(control.events, "command.read:end", "intent.read:start");
  assertNoFreshDeployment(control);
});

test("the original replay repository receives changed canonical operands and a declared conflict never falls back to a new admission", async () => {
  const historical = await retainedExample();
  const conflict = new Error("controlled retained-command conflict");
  const control = await deploymentFixture({
    ...historical,
    onlyReplay: true,
    replayFailure: conflict,
  });
  const changed = clone(control.input);
  changed.command.expectedDraft.configurationGeneration++;
  assert.notEqual(
    control.codec.canonicalLifecycleDeployCommandV2(scope, changed.command),
    control.codec.canonicalLifecycleDeployCommandV2(scope, serviceCommand()),
  );
  await assert.rejects(control.deploy(changed), (error) => error === conflict);
  assert.deepEqual(plain(control.calls.commandReads[0][1]), changed.command);
  assert.ok(control.calls.poison.includes(conflict));
  assertNoFreshDeployment(control);
});

test("replay intent must still match the original revision, actor and exact scope", async () => {
  const historical = await retainedExample();
  for (const overrides of [
    { revisionId: id("rev", 60) },
    { actorId: id("prn", 60) },
    { installationId: id("ins", 60) },
    { namespaceId: id("ns", 60) },
    { agentId: id("agt", 60) },
    { transitionRef: uuid(60) },
    { desiredMode: "stopped" },
    { createdAt: "invalid" },
  ]) {
    const control = await deploymentFixture({
      ...historical,
      onlyReplay: true,
      retainedIntent: { ...historical.retainedIntent, ...overrides },
    });
    await assert.rejects(control.deploy());
    assert.ok(control.calls.poison.length > 0);
    assertNoFreshDeployment(control);
  }
});

test("read-only command recovery uses the original recovery unit after unwind and performs no new admission", async () => {
  const historical = await retainedExample();
  const control = await deploymentFixture({ ...historical, onlyReplay: true });
  await assert.rejects(control.recover());
  assert.equal(control.calls.invocation, 0);
  assert.equal(control.calls.recovery, 0);
  control.activeTransaction = false;
  const receipt = await control.recover();
  assert.deepEqual(plain(receipt), historical.receipt);
  assert.equal(control.calls.bindings.length, 0);
  assert.equal(control.calls.recoveryBindings.length, 1);
  assert.deepEqual(plain(control.calls.recoveryBindings[0]), [principalId, control.input]);
  assert.ok(Object.isFrozen(control.calls.recoveryBindings[0]));
  assert.equal(control.calls.mutation, 0);
  assert.equal(control.calls.recovery, 1);
  assert.equal(control.calls.commandLocks.length, 0);
  assert.equal(control.calls.commandReads[0].length, 3);
  assert.equal(control.calls.commandReads[0][2], principalId);
  assert.equal(control.calls.outerAccess, 0);
  assert.equal(Object.hasOwn(control.recoveryUnit, "platform"), false);
  before(control.events, "installation.read:end", "authorize:start");
  before(control.events, "authorize:end", "command.read:start");
  assertNoFreshDeployment(control);
});

test("missing, foreign or inactive recovery evidence never retries deployment or allocates an ID", async () => {
  const historical = await retainedExample();
  for (const settings of [
    { retainedRevision: undefined },
    { retainedIntent: undefined },
    { retainedIntent: { ...historical.retainedIntent, actorId: id("prn", 60) } },
    { retainedIntent: { ...historical.retainedIntent, transitionRef: uuid(60) } },
    { recoveryUnitOverrides: { kind: "deployment" } },
    { recoveryUnitOverrides: { installationId: id("ins", 60) } },
    { recoveryUnitOverrides: { namespaceId: id("ns", 60) } },
    { recoveryUnitOverrides: { agentId: id("agt", 60) } },
    { recoveryUnitOverrides: { operationRef: uuid(60) } },
    { readInstallationId: id("ins", 60) },
    {
      hooks: {
        "command.read"(value) {
          value.recoveryActive = false;
        },
      },
    },
    {
      hooks: {
        "intent.read"(value) {
          value.recoveryActive = false;
        },
      },
    },
  ]) {
    const control = await deploymentFixture({ ...historical, onlyReplay: true, ...settings });
    control.activeTransaction = false;
    await assert.rejects(control.recover());
    assert.equal(control.calls.mutation, 0);
    assert.equal(control.calls.commandLocks.length, 0);
    assertNoFreshDeployment(control);
  }
});
