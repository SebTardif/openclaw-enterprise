import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryConfigurationRepository } from "../../packages/occ/src/state/memory/configurations.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  configurationResources,
  seedConfigurationInstallation,
  assertConfigurationRepositoryClosed,
  verifyConfigurationRepositoryBootstrap,
  verifyConfigurationRepositoryOwnership,
  verifyConfigurationRepositoryBindings,
  verifyConfigurationRepositoryGenerations,
  verifyConfigurationRepositoryLifetime,
  verifyConfigurationRepositoryAtomicity,
} from "./configuration-repository.contract.mjs";

test("memory Configuration factory construction performs no backend or scope access", () => {
  // This sentinel proves construction only. Secret behavior is exercised below
  // through the aggregate's canonical helpers and real stored Secret metadata.
  const unexpected = () => assert.fail("factory construction accessed its backend");
  const repository = createMemoryConfigurationRepository({
    transaction: { assertActive: unexpected },
    snapshot: {
      get installation() {
        return unexpected();
      },
    },
    namespaces: { lockNamespace: unexpected },
    configurationKey: unexpected,
    normalizedSecretBindings: unexpected,
    assertCreateSecretBindingsAvailable: unexpected,
    assertSecretBindingsAvailable: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "advanceConfigurationGeneration",
    "createConfiguration",
    "deleteConfiguration",
    "findConfiguration",
    "lockConfiguration",
  ]);
});

test("memory Configuration factory reads live owner maps and closes all five methods", async () => {
  const store = new InMemoryPlatformState();
  const installation = await seedConfigurationInstallation(store);
  const resources = configurationResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(resources.namespace);
    await s.configurations.createConfiguration(resources.configuration);
    await s.agents.createAgent(resources.agent);
  });
  const transaction = new RepositoryTransactionLifetime();
  let scopeReads = 0;
  let installationReads = 0;
  const configurations = new Map();
  const agents = new Map();
  const snapshot = {
    get installation() {
      installationReads++;
      return installation;
    },
    configurations,
    agents,
    namespaces: new Map([[resources.namespace.id, resources.namespace]]),
  };
  const unused = () => assert.fail("read/delete tests must not emulate canonical Secret helpers");
  const configurationKey = (namespaceId, configurationId) =>
    `${namespaceId}\u0000${configurationId}`;
  const context = {
    snapshot,
    transaction,
    configurationKey,
    namespaces: { lockNamespace: unused },
    normalizedSecretBindings: unused,
    assertCreateSecretBindingsAvailable: unused,
    assertSecretBindingsAvailable: unused,
    get scope() {
      scopeReads++;
      return { installationId: installation.id };
    },
  };
  const repository = createMemoryConfigurationRepository(context);
  const sibling = createMemoryConfigurationRepository(context);
  const { namespaceId, id } = resources.configuration;
  assert.equal(await repository.findConfiguration(namespaceId, id), undefined);
  // Publish actual aggregate-created records after factory construction. The
  // factories borrow this same map; they do not capture a copied snapshot.
  const saved = await store.read((s) => s.configurations.findConfiguration(namespaceId, id));
  configurations.set(configurationKey(namespaceId, id), saved);
  assert.deepEqual(await repository.lockConfiguration(namespaceId, id), saved);
  assert.deepEqual(await sibling.findConfiguration(namespaceId, id), saved);
  assert.notEqual(await sibling.findConfiguration(namespaceId, id), saved);
  const savedAgent = await store.read((s) => s.agents.findAgent(namespaceId, resources.agent.id));
  agents.set(savedAgent.id, savedAgent);
  await assert.rejects(repository.deleteConfiguration(namespaceId, id), ScopeViolationError);
  const disposable = configurationResources().configuration;
  const unassigned = { ...disposable, namespaceId };
  await store.transact((s) => s.configurations.createConfiguration(unassigned));
  configurations.set(
    configurationKey(namespaceId, unassigned.id),
    await store.read((s) => s.configurations.findConfiguration(namespaceId, unassigned.id)),
  );
  assert.equal(await sibling.deleteConfiguration(namespaceId, unassigned.id), true);
  assert.equal(configurations.has(configurationKey(namespaceId, unassigned.id)), false);
  assert.equal(await repository.findConfiguration(namespaceId, unassigned.id), undefined);
  assert.equal(installationReads, 0);
  assert.equal(scopeReads, 0);
  await transaction.finish();
  await assertConfigurationRepositoryClosed(repository, resources.configuration);
  await assertConfigurationRepositoryClosed(sibling, resources.configuration);
});

for (const [name, verify] of [
  ["sees same-unit bootstrap and rolls it back", verifyConfigurationRepositoryBootstrap],
  [
    "preserves exact ownership, lifecycle and Agent reference constraints",
    verifyConfigurationRepositoryOwnership,
  ],
  [
    "normalizes real Secret bindings and distinguishes preservation from clearing",
    verifyConfigurationRepositoryBindings,
  ],
  [
    "serializes independent generation writers and rolls back speculative updates",
    verifyConfigurationRepositoryGenerations,
  ],
  [
    "drains cross-domain calls and closes all escaped Configuration methods",
    verifyConfigurationRepositoryLifetime,
  ],
  [
    "commits and rolls back Configuration, Secret, Agent, audit and work together",
    verifyConfigurationRepositoryAtomicity,
  ],
])
  test(`memory Configuration aggregate ${name}`, async () => verify(new InMemoryPlatformState()));
