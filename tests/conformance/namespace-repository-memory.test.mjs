import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryNamespaceRepository } from "../../packages/occ/src/state/memory/namespaces.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { seedChannelOwner } from "./channel-binding-store.contract.mjs";
import {
  namespaceRecord,
  namespaceChildren,
  assertNamespaceRepositoryClosed,
  verifyNamespaceRepositoryBootstrap,
  verifyNamespaceRepositoryLifecycle,
  verifyNamespaceRepositoryChildren,
  verifyNamespaceRepositoryLifetime,
  verifyNamespaceRepositoryAtomicity,
} from "./namespace-repository.contract.mjs";

test("memory Namespace factory borrows live maps and resolves Installation only for create", async () => {
  const owner = await seedChannelOwner(new InMemoryPlatformState());
  const transaction = new RepositoryTransactionLifetime();
  let installation;
  let installationReads = 0;
  let scopeReads = 0;
  const snapshot = {
    get installation() {
      installationReads++;
      return installation;
    },
    namespaces: new Map(),
    agents: new Map(),
    configurations: new Map(),
    serviceAccounts: new Map(),
    secrets: new Map(),
  };
  const context = {
    snapshot,
    transaction,
    get scope() {
      scopeReads++;
      assert.ok(installation);
      return { installationId: installation.id };
    },
  };
  const repository = createMemoryNamespaceRepository(context);
  assert.equal(installationReads, 0);
  assert.equal(scopeReads, 0);
  const candidate = namespaceRecord();
  assert.deepEqual(await repository.listNamespaces(), []);
  assert.equal(await repository.findNamespace(candidate.id), undefined);
  assert.equal(await repository.lockNamespace(candidate.id), undefined);
  assert.equal(
    await repository.transitionNamespaceStatus(candidate.id, "provisioning", "ready"),
    undefined,
  );
  assert.equal(await repository.markNamespaceDeleted(candidate.id, candidate.createdAt), undefined);
  for (const method of ["hasAgents", "hasConfigurations", "hasServiceAccounts", "hasSecrets"])
    assert.equal(await repository[method](candidate.id), false);
  assert.equal(
    installationReads,
    0,
    "ordinary reads and missing mutations do not require bootstrap in memory",
  );
  assert.equal(scopeReads, 0);
  await assert.rejects(repository.createNamespace(candidate), ScopeViolationError);
  installation = owner.installation;
  assert.deepEqual(await repository.createNamespace(candidate), candidate);
  assert.deepEqual(snapshot.namespaces.get(candidate.id), candidate);
  assert.notEqual(snapshot.namespaces.get(candidate.id), candidate);
  const sibling = createMemoryNamespaceRepository(context);
  const ready = await sibling.transitionNamespaceStatus(candidate.id, "provisioning", "ready");
  assert.deepEqual(await repository.findNamespace(candidate.id), ready);
  assert.deepEqual(snapshot.namespaces.get(candidate.id), ready);
  assert.ok(Object.isFrozen(ready));
  const children = namespaceChildren(candidate);
  // These are complete persisted child records in a ready Namespace. The owner
  // publishes them into the same maps after both factories have been constructed.
  for (const [map, record, method] of [
    ["configurations", children.configuration, "hasConfigurations"],
    ["agents", children.agent, "hasAgents"],
    ["serviceAccounts", children.account, "hasServiceAccounts"],
    ["secrets", children.secret, "hasSecrets"],
  ]) {
    assert.equal(await repository[method](candidate.id), false);
    snapshot[map].set(record.id, record);
    assert.equal(await repository[method](candidate.id), true);
    assert.equal(await sibling[method](candidate.id), true);
    assert.equal(await repository[method]("absent-namespace"), false);
  }
  await transaction.finish();
  await assertNamespaceRepositoryClosed(repository, candidate);
  await assertNamespaceRepositoryClosed(sibling, candidate);
});

test("memory Namespace list preserves insertion order and returns immutable copies", async () => {
  const store = new InMemoryPlatformState();
  await seedChannelOwner(store);
  const later = namespaceRecord({ createdAt: "2025-02-02T00:00:00.000Z" });
  const earlier = namespaceRecord({ createdAt: "2025-01-01T00:00:00.000Z" });
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(later);
    await s.namespaces.createNamespace(earlier);
  });
  const listed = await store.read((s) => s.namespaces.listNamespaces());
  assert.deepEqual(
    listed.filter((n) => [later.id, earlier.id].includes(n.id)),
    [later, earlier],
  );
  assert.ok(Object.isFrozen(listed));
  assert.ok(listed.every(Object.isFrozen));
  assert.throws(() => {
    listed.find((n) => n.id === later.id).name = "changed";
  }, TypeError);
  assert.deepEqual(await store.read((s) => s.namespaces.findNamespace(later.id)), later);
});

for (const [name, verify] of [
  ["sees same-unit bootstrap and rolls it back", verifyNamespaceRepositoryBootstrap],
  [
    "preserves empty lifecycle, tombstones, name reservation and external placement reuse",
    verifyNamespaceRepositoryLifecycle,
  ],
  [
    "observes actual Agents, Configurations, service accounts and Secrets",
    verifyNamespaceRepositoryChildren,
  ],
  [
    "drains cross-domain calls and closes all escaped Namespace methods",
    verifyNamespaceRepositoryLifetime,
  ],
  [
    "commits and rolls back Namespace, children, channel, audit and work together",
    verifyNamespaceRepositoryAtomicity,
  ],
])
  test(`memory aggregate ${name}`, async () => verify(new InMemoryPlatformState()));
