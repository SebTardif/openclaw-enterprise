import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { createMemoryRevisionRepository } from "../../packages/occ/src/state/memory/revisions.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  revisionResources,
  revisionRecord,
  seedRevisionOwner,
  verifyRevisionBootstrap,
  assertRevisionClosed,
  revisionStoreCases,
} from "./revision-repository.contract.mjs";

test("memory revision factory construction does not call helpers, backend or scope", () => {
  const unexpected = () => assert.fail("factory eagerly accessed owner");
  const repository = createMemoryRevisionRepository({
    transaction: { assertActive: unexpected },
    snapshot: {
      get installation() {
        return unexpected();
      },
    },
    agents: { findAgent: unexpected },
    revisionKey: unexpected,
    assertInitialized: unexpected,
    assertAdmittedAgentRevision: unexpected,
    normalizedSecretBindings: unexpected,
    assertSecretBindingsAvailable: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "createRevision",
    "findRevision",
    "listRevisions",
  ]);
});
test("memory revision factories share live owner history and revoke pending reads", async () => {
  const store = new InMemoryPlatformState();
  const resources = await seedRevisionOwner(store, revisionResources());
  const revision = revisionRecord(resources);
  const saved = await store.transact((unit) => unit.revisions.createRevision(revision));
  const revisions = new Map();
  const transaction = new RepositoryTransactionLifetime();
  const unexpected = () => assert.fail("read accessed mutation-only context");
  const context = {
    transaction,
    snapshot: {
      revisions,
      namespaces: new Map([[revision.namespaceId, resources.namespace]]),
      get installation() {
        return unexpected();
      },
    },
    agents: { findAgent: unexpected },
    revisionKey: (namespaceId, agentId) => `${namespaceId}\u0000${agentId}`,
    assertInitialized: unexpected,
    assertAdmittedAgentRevision: unexpected,
    normalizedSecretBindings: unexpected,
    assertSecretBindingsAvailable: unexpected,
    get scope() {
      return unexpected();
    },
  };
  const first = createMemoryRevisionRepository(context),
    second = createMemoryRevisionRepository(context);
  assert.equal(
    await first.findRevision(revision.namespaceId, revision.agentId, revision.id),
    undefined,
  );
  // Publish a revision obtained from the real store after both factories exist;
  // the constructor must not clone or capture a private replacement history.
  revisions.set(context.revisionKey(revision.namespaceId, revision.agentId), [saved]);
  assert.deepEqual(await second.listRevisions(revision.namespaceId, revision.agentId), [saved]);
  assert.notEqual(
    await first.findRevision(revision.namespaceId, revision.agentId, revision.id),
    saved,
  );
  const pending = first.listRevisions(revision.namespaceId, revision.agentId);
  transaction.close();
  await assert.rejects(pending, {
    name: "ScopeViolationError",
    message: "The platform transaction is closed.",
  });
  await assertRevisionClosed(first, revision);
  await assertRevisionClosed(second, revision);
});
test("memory revision factory observes same-unit bootstrap and rollback", async () =>
  verifyRevisionBootstrap(new InMemoryPlatformState()));
for (const [name, verify] of revisionStoreCases)
  test(`memory revision repository ${name}`, async () => verify(new InMemoryPlatformState()));
