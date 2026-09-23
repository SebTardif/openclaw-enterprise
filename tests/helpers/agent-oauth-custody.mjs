import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { seedOAuthAgent } from "../conformance/agent-oauth-state.contract.mjs";

const actor = "oauth-owner";
const otherActor = "oauth-other-administrator";
const method = {
  providerId: "openai",
  methodId: "device-code",
  profileId: (connectionId, generation) => `openai:oce:${connectionId}:g${generation}`,
};
const credential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-oauth-access",
  refresh: "synthetic-oauth-refresh",
  expires: Date.parse("2026-09-23T01:00:00Z"),
  accountId: "synthetic-oauth-account",
  idToken: "synthetic-oauth-id-token",
  clientId: "synthetic-oauth-client",
  tokenEndpoint: "https://identity.example.test/oauth/token",
};

function envelope(selected) {
  return JSON.stringify({
    provider: selected.providerId,
    method: selected.methodId,
    connectionId: selected.connectionId,
    generation: selected.generation,
    profileId: selected.profileId,
    credential,
  });
}

async function fixture({
  stageOutcome,
  afterLookup,
  beforeStage,
  method: selectedMethod = method,
} = {}) {
  const state = new InMemoryPlatformState();
  const { namespace, agent } = await seedOAuthAgent(state);
  const installation = await state.read((view) => view.installations.getInstallation());
  const iamState = {
    identities: [actor, otherActor].map((id) => ({
      kind: "principal",
      id,
      issuer: "oauth-custody-test",
      subject: id,
    })),
    groups: [],
    memberships: [],
    roles: [
      {
        id: "oauth-administrator",
        permissions: [
          { action: "administer", resourceKind: "agent" },
          { action: "update", resourceKind: "agent" },
          { action: "read", resourceKind: "configuration" },
          { action: "create", resourceKind: "provider_connection" },
          { action: "delete", resourceKind: "provider_connection" },
        ],
      },
      {
        id: "oauth-operator",
        permissions: [{ action: "operate", resourceKind: "provider_connection" }],
      },
      {
        id: "oauth-agent-operator",
        permissions: [{ action: "operate", resourceKind: "agent" }],
      },
    ],
    bindings: [actor, otherActor].flatMap((id) =>
      ["oauth-administrator", "oauth-operator", "oauth-agent-operator"].map((roleId) => ({
        id: `binding-${roleId}-${id}`,
        subjectKind: "identity",
        subjectId: id,
        roleId,
      })),
    ),
    restrictions: [],
  };
  let now = Date.parse("2026-09-23T00:00:00Z");
  const controller = new OpenClawController(installation, { state, now: () => new Date(now) });
  const storage = createTestSecretDriver();
  const references = new Map();
  const key = ({ namespaceId, id }) => `${namespaceId}:${id}`;
  let stageCalls = 0;
  let lookupCalls = 0;
  // Only the external storage boundary is simulated. Controller custody, IAM,
  // transaction rollback, identity allocation, and recovery are production code.
  const driver = {
    ...storage,
    async stage(identity, value) {
      stageCalls += 1;
      await beforeStage?.();
      if (stageOutcome === "failed-before-create") {
        throw new Error(credential.refresh);
      }
      const reference = await storage.create(identity, value);
      references.set(key(identity), reference);
      if (stageOutcome === "lost-acknowledgment") {
        throw new Error(credential.refresh);
      }
      return reference;
    },
    async findStaged(identity) {
      lookupCalls += 1;
      await afterLookup?.();
      return references.get(key(identity));
    },
    async delete(secret) {
      await storage.delete(secret);
      references.delete(key(secret));
    },
  };
  for (const selected of [
    new NativeIAMDriver({ loadNativeIAMState: async () => iamState }),
    driver,
  ]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  controller.registerProviderCatalog([
    {
      id: "catalog-openai",
      label: "OpenAI setup",
      requiresBaseUrl: false,
      authMethods: [...new Set(["device-code", "browser", selectedMethod.methodId])]
        .map((methodId) => ({
          id: `setup-${methodId}`,
          label: methodId,
          credentialKind: "oauth",
          nativeProviderId: selectedMethod.providerId,
          nativeMethodId: methodId,
          nativeVersion: null,
          deploymentAuthMethod: null,
          unavailableReason: "Runtime handoff is not enabled.",
        }))
        .concat({
          id: "none",
          label: "No credentials",
          credentialKind: "none",
          nativeProviderId: selectedMethod.providerId,
          nativeMethodId: "none",
          nativeVersion: null,
          deploymentAuthMethod: null,
          unavailableReason: "Not an OAuth method.",
        }),
    },
  ]);
  let connectionCount = 0;
  const createConnection = (input = {}) =>
    controller.createProviderConnection(actor, {
      namespaceId: namespace.id,
      name: `OAuth setup ${++connectionCount}`,
      providerId: "catalog-openai",
      authMethodId: `setup-${selectedMethod.methodId}`,
      ...input,
    });
  const selectConnection = (connection) =>
    controller.updateAgent(actor, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth:
        connection === null ? null : { method: "provider_connection", connectionId: connection.id },
    });
  const connection = await createConnection();
  await selectConnection(connection);
  const custody = controller.agentOAuth;
  const begin = (generation = 0, expectedProviderConnectionId = connection.id) =>
    custody.begin(
      actor,
      namespace.id,
      agent.id,
      selectedMethod,
      generation,
      expectedProviderConnectionId,
    );
  const acquire = (selected) => custody.acquisition(actor, namespace.id, agent.id, selected);
  const latest = () => state.read((view) => view.agentOAuth.latest(namespace.id, agent.id));
  return {
    state,
    namespace,
    agent,
    controller,
    connection,
    createConnection,
    selectConnection,
    custody,
    storage,
    begin,
    acquire,
    latest,
    iamState,
    advanceTo: (timestamp) => {
      now = Date.parse(timestamp);
    },
    stageCalls: () => stageCalls,
    lookupCalls: () => lookupCalls,
  };
}

export { actor, otherActor, method, credential, envelope, fixture };
