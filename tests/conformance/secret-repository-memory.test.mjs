import assert from "node:assert/strict";
import test from "node:test";
import { createMemorySecretRepository } from "../../packages/occ/src/state/memory/secrets.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  secretResources,
  seedSecretInstallation,
  assertSecretRepositoryClosed,
  verifySecretBootstrap,
  secretStoreCases,
} from "./secret-repository.contract.mjs";

test("memory Secret construction does not access backend, helpers or scope", () => {
  // A construction sentinel is not persistence or validation proof.
  const unexpected = () => assert.fail("Secret factory construction accessed its backend");
  const repository = createMemorySecretRepository({
    transaction: { assertActive: unexpected },
    snapshot: {
      get installation() {
        return unexpected();
      },
    },
    namespaces: { lockNamespace: unexpected },
    resourceKey: unexpected,
    assertSecret: unexpected,
    secretBindingsReference: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "createSecret",
    "deleteSecret",
    "findSecret",
    "hasReferences",
    "lockSecret",
  ]);
});

test("memory Secret factories borrow live maps and reject reads revoked during an await", async () => {
  const store = new InMemoryPlatformState();
  const installation = await seedSecretInstallation(store);
  const { namespace, secret } = secretResources();
  const disposable = { ...secretResources().secret, namespaceId: namespace.id };
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.secrets.createSecret(secret);
    await s.secrets.createSecret(disposable);
  });
  const saved = await store.read((s) => s.secrets.findSecret(namespace.id, secret.id));
  const transaction = new RepositoryTransactionLifetime();
  let installationReads = 0;
  let scopeReads = 0;
  const secrets = new Map();
  const resourceKey = (namespaceId, id) => `${namespaceId}\u0000${id}`;
  const unused = () =>
    assert.fail("unreferenced reads/deletion must not emulate owner validation or bindings");
  const context = {
    transaction,
    snapshot: {
      get installation() {
        installationReads++;
        return installation;
      },
      secrets,
      namespaces: new Map([[namespace.id, namespace]]),
      configurations: new Map(),
      agents: new Map(),
      revisions: new Map(),
      operations: [],
    },
    resourceKey,
    namespaces: { lockNamespace: unused },
    assertSecret: unused,
    secretBindingsReference: unused,
    get scope() {
      scopeReads++;
      return { installationId: installation.id };
    },
  };
  const repository = createMemorySecretRepository(context);
  const sibling = createMemorySecretRepository(context);
  assert.equal(await repository.findSecret(namespace.id, secret.id), undefined);
  // Complete real aggregate-created metadata is published after factory construction.
  secrets.set(resourceKey(namespace.id, secret.id), saved);
  assert.deepEqual(await sibling.lockSecret(namespace.id, secret.id), saved);
  assert.notEqual(await repository.findSecret(namespace.id, secret.id), saved);
  assert.equal(await repository.hasReferences(namespace.id, secret.id), false);
  secrets.set(
    resourceKey(namespace.id, disposable.id),
    await store.read((s) => s.secrets.findSecret(namespace.id, disposable.id)),
  );
  assert.equal(await repository.deleteSecret(namespace.id, disposable.id), true);
  assert.equal(secrets.has(resourceKey(namespace.id, disposable.id)), false);
  assert.equal(await sibling.findSecret(namespace.id, disposable.id), undefined);
  const pending = sibling.findSecret(namespace.id, secret.id);
  transaction.close();
  await assert.rejects(pending, {
    name: "ScopeViolationError",
    message: "The platform transaction is closed.",
  });
  await assertSecretRepositoryClosed(repository, secret);
  await assertSecretRepositoryClosed(sibling, secret);
  assert.equal(installationReads, 0);
  assert.equal(scopeReads, 0);
});

test("memory Secret aggregate resolves same-unit bootstrap and rolls it back", async () =>
  verifySecretBootstrap(new InMemoryPlatformState()));
for (const [name, verify] of secretStoreCases)
  test(`memory Secret aggregate ${name}`, async () => verify(new InMemoryPlatformState()));
