import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryChannelBindingRepository } from "../../packages/occ/src/state/memory/channel-bindings.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { channelRecords, seedChannelOwner } from "./channel-binding-store.contract.mjs";
import {
  assertChannelRepositoryClosed,
  verifyChannelRepositoryBootstrap,
  verifyChannelRepositoryLifetime,
  verifyChannelRepositoryAtomicity,
  verifyChannelRepositoryDeletingNamespaceTarget,
} from "./channel-repository.contract.mjs";

test("memory channel factory borrows live Installation and exact working maps", async () => {
  const owner = await seedChannelOwner(new InMemoryPlatformState());
  const records = channelRecords(owner);
  const transaction = new RepositoryTransactionLifetime();
  let installation;
  let installationReads = 0;
  let scopeReads = 0;
  const snapshot = {
    get installation() {
      installationReads++;
      return installation;
    },
    channelInstallations: new Map(),
    channelHumans: new Map(),
    channelAgents: new Map(),
    namespaces: new Map(),
    agents: new Map(),
  };
  const context = {
    transaction,
    snapshot,
    get scope() {
      scopeReads++;
      if (!installation) throw new ScopeViolationError("Installation unavailable");
      return Object.freeze({ installationId: installation.id });
    },
  };
  const repository = createMemoryChannelBindingRepository(context);
  assert.equal(installationReads, 0, "construction must not read the live snapshot");
  assert.equal(scopeReads, 0, "construction must not resolve absent Installation scope");
  assert.deepEqual(await repository.listChannelInstallations({ limit: 1 }), []);
  assert.equal(await repository.findChannelInstallation(records.app.id), undefined);
  assert.equal(scopeReads, 0, "empty reads must remain valid before bootstrap");

  // The owner publishes its uncommitted bootstrap and resources into the same
  // maps after factory construction; no replacement repository is created.
  installation = owner.installation;
  snapshot.namespaces.set(owner.namespace.id, owner.namespace);
  snapshot.agents.set(`${owner.namespace.id}\u0000${owner.agent.id}`, owner.agent);
  await repository.createChannelInstallation(records.app);
  await repository.createHumanBinding(records.human);
  await repository.createAgentBinding(records.route);
  assert.deepEqual(snapshot.channelInstallations.get(records.app.id), records.app);
  assert.deepEqual(snapshot.channelHumans.get(records.human.id), records.human);
  assert.deepEqual(snapshot.channelAgents.get(records.route.id), records.route);
  const sibling = createMemoryChannelBindingRepository(context);
  const changed = await sibling.setHumanBindingStatus(
    records.app.id,
    records.human.id,
    1,
    "disabled",
    "admin",
    records.app.updatedAt,
  );
  assert.equal(snapshot.channelHumans.get(records.human.id).version, 2);
  assert.deepEqual(await repository.findHumanBinding(records.app.id, records.human.id), changed);
  assert.ok(Object.isFrozen(changed));
  const foreignScope = createMemoryChannelBindingRepository({
    ...context,
    scope: { installationId: "foreign" },
  });
  await assert.rejects(foreignScope.findChannelInstallation(records.app.id), ScopeViolationError);
  await transaction.finish();
  await assertChannelRepositoryClosed(repository, records);
  await assertChannelRepositoryClosed(sibling, records);
});

test("memory aggregate channel repository sees same-unit bootstrap and rolls it back", async () => {
  await verifyChannelRepositoryBootstrap(new InMemoryPlatformState());
});

test("memory aggregate drains queued channel calls and closes every escaped method", async () => {
  await verifyChannelRepositoryLifetime(new InMemoryPlatformState());
});

test("memory aggregate commits and rolls back channel records, resources, audit and work together", async () => {
  await verifyChannelRepositoryAtomicity(new InMemoryPlatformState());
});

test("memory channel repository rejects a route targeting an empty deleting Namespace", async () => {
  await verifyChannelRepositoryDeletingNamespaceTarget(new InMemoryPlatformState());
});
