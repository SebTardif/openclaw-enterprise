import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryServiceAccountRepository } from "../../packages/occ/src/state/memory/service-accounts.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  serviceAccountResources,
  seedServiceAccountInstallation,
  assertServiceAccountClosed,
  verifyServiceAccountBootstrap,
  serviceAccountStoreCases,
} from "./service-account-repository.contract.mjs";

const methods = [
  "createServiceAccount",
  "deleteServiceAccount",
  "findServiceAccount",
  "findServiceAccountProviderBinding",
  "listServiceAccounts",
  "lockServiceAccount",
  "updateCredential",
];
test("memory ServiceAccount factory construction does not access backend, helpers or scope", () => {
  const unexpected = () => assert.fail("constructor accessed an owner capability");
  const repository = createMemoryServiceAccountRepository({
    transaction: { assertActive: unexpected },
    snapshot: {
      get installation() {
        return unexpected();
      },
    },
    namespaces: { lockNamespace: unexpected },
    resourceKey: unexpected,
    isServiceAccountIdentifier: unexpected,
    validCredential: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), methods);
});

test("memory ServiceAccount factories borrow live maps and revoke pending reads", async () => {
  const store = new InMemoryPlatformState();
  const installation = await seedServiceAccountInstallation(store);
  const { namespace, account } = serviceAccountResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(namespace);
    await s.serviceAccounts.createServiceAccount(account);
  });
  const saved = await store.read((s) =>
    s.serviceAccounts.findServiceAccount(namespace.id, account.id),
  );
  const transaction = new RepositoryTransactionLifetime();
  const serviceAccounts = new Map();
  let installationReads = 0,
    scopeReads = 0;
  const unused = () => assert.fail("reads/deletion should not access creation validation");
  const key = (namespaceId, accountId) => `${namespaceId}\u0000${accountId}`;
  const context = {
    transaction,
    snapshot: {
      get installation() {
        installationReads++;
        return installation;
      },
      serviceAccounts,
      namespaces: new Map([[namespace.id, namespace]]),
      agents: new Map(),
    },
    resourceKey: key,
    namespaces: { lockNamespace: unused },
    isServiceAccountIdentifier: unused,
    validCredential: unused,
    get scope() {
      scopeReads++;
      return { installationId: installation.id };
    },
  };
  const first = createMemoryServiceAccountRepository(context);
  const second = createMemoryServiceAccountRepository(context);
  assert.equal(await first.findServiceAccount(namespace.id, account.id), undefined);
  // Publish complete metadata obtained from the actual aggregate after both
  // factories exist. This is a borrowing check, not replacement persistence proof.
  serviceAccounts.set(key(namespace.id, account.id), saved);
  assert.deepEqual(await second.lockServiceAccount(namespace.id, account.id), saved);
  assert.notEqual(await first.findServiceAccount(namespace.id, account.id), saved);
  assert.deepEqual(await first.listServiceAccounts(namespace.id), [saved]);
  assert.equal(await first.findServiceAccountProviderBinding(namespace.id, account.id), undefined);
  assert.equal(await second.deleteServiceAccount(namespace.id, account.id), true);
  assert.equal(serviceAccounts.size, 0);
  serviceAccounts.set(key(namespace.id, account.id), saved);
  const pending = first.findServiceAccount(namespace.id, account.id);
  transaction.close();
  await assert.rejects(pending, {
    name: "ScopeViolationError",
    message: "The platform transaction is closed.",
  });
  await assertServiceAccountClosed(first, account);
  await assertServiceAccountClosed(second, account);
  assert.equal(installationReads, 0);
  assert.equal(scopeReads, 0);
});

test("memory ServiceAccount aggregate resolves same-unit bootstrap and rolls it back", async () =>
  verifyServiceAccountBootstrap(new InMemoryPlatformState()));
for (const [name, verify] of serviceAccountStoreCases)
  test(`memory ServiceAccount aggregate ${name}`, async () =>
    verify(new InMemoryPlatformState(), { backend: "memory" }));
