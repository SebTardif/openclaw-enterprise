import { randomUUID } from "node:crypto";
// Create ordinary State resources. No runtime assignment or current authority is created.
export async function seedInventorySubject(store) {
  let installation = await store.read((s) => s.installations.getInstallation());
  if (!installation)
    installation = await store.transact((s) =>
      s.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: `Inventory ${randomUUID()}`,
        createdAt: new Date().toISOString(),
      }),
    );
  const createdAt = new Date().toISOString();
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `Inventory ${randomUUID()}`,
    status: "ready",
    createdAt,
  };
  const configuration = {
    id: `cfg_${randomUUID()}`,
    namespaceId: namespace.id,
    kind: "agent",
    generation: 1,
    createdAt,
  };
  const agent = {
    id: `agt_${randomUUID()}`,
    namespaceId: namespace.id,
    name: `Owner ${randomUUID()}`,
    configurationId: configuration.id,
    providerId: null,
    executionMode: "embedded",
    servicePrincipalId: randomUUID(),
    createdAt,
  };
  const revision = {
    id: `rev_${randomUUID()}`,
    namespaceId: namespace.id,
    agentId: agent.id,
    revision: 1,
    configurationId: configuration.id,
    configurationKind: "agent",
    configurationGeneration: 1,
    providerId: null,
    configuration: { models: { providers: { openai: {} } } },
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt,
  };
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.configurations.createConfiguration(configuration);
    await s.agents.createAgent(agent);
    await s.revisions.createRevision(revision);
  });
  return {
    installation,
    namespace,
    agent,
    revision,
    scope: { namespaceId: namespace.id, agentId: agent.id },
  };
}
