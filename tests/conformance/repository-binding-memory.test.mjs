import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";

const id = (prefix) => `${prefix}_${randomUUID()}`;
test("memory binding repository preserves generation, ownership, references and immutable copies", async () => {
  const state = new InMemoryPlatformState();
  const createdAt = new Date().toISOString();
  const namespace = { id: id("ns"), name: "Memory repository", status: "ready", createdAt };
  const secret = {
    id: id("sec"),
    namespaceId: namespace.id,
    name: "Signing key",
    driverId: "secret-test",
    backendRef: {
      namespaceName: "memory-namespace",
      name: "signing-key",
      key: "value",
      uid: randomUUID(),
    },
    createdAt,
  };
  const binding = {
    id: id("rb"),
    namespaceId: namespace.id,
    appId: 1,
    installationId: 2,
    repositoryIds: [3],
    keySecretRef: { kind: "secret", namespaceId: namespace.id, id: secret.id },
    generation: 1,
    state: "unverified",
    createdAt,
  };
  await state.transact(async (unit) => {
    await unit.installations.createInstallation({
      id: id("ins"),
      name: "Memory Installation",
      createdAt,
    });
    await unit.namespaces.createNamespace(namespace);
    await unit.secrets.createSecret(secret);
    await unit.repositoryBindings.createBinding(binding);
  });
  let retainedRead;
  await state.read(async (unit) => {
    retainedRead = unit.repositoryBindings;
    assert.deepEqual(Object.keys(retainedRead), ["findBinding"]);
  });
  await assert.rejects(retainedRead.findBinding(namespace.id, binding.id), {
    name: "ScopeViolationError",
  });
  let retainedWrite;
  await state.transact(async (unit) => {
    retainedWrite = unit.repositoryBindings;
  });
  await assert.rejects(retainedWrite.updateBinding({ ...binding, generation: 2 }, 1), {
    name: "ScopeViolationError",
  });
  binding.repositoryIds.push(4);
  const saved = await state.read((unit) =>
    unit.repositoryBindings.findBinding(namespace.id, binding.id),
  );
  assert.deepEqual(saved.repositoryIds, [3]);
  assert.equal(Object.isFrozen(saved.repositoryIds), true);
  assert.equal(
    await state.read((unit) => unit.repositoryBindings.findBinding(id("ns"), binding.id)),
    undefined,
  );
  assert.equal(
    await state.transact((unit) =>
      unit.repositoryBindings.updateBinding({ ...saved, generation: 2 }, 2),
    ),
    undefined,
  );
  await assert.rejects(
    state.transact((unit) => unit.repositoryBindings.updateBinding({ ...saved, generation: 3 }, 1)),
    { name: "ScopeViolationError" },
  );
  await assert.rejects(
    state.transact((unit) =>
      unit.repositoryBindings.updateBinding({ ...saved, generation: 2, state: "verified" }, 1),
    ),
    { name: "ScopeViolationError" },
  );
  await assert.rejects(
    state.transact((unit) => unit.secrets.deleteSecret(namespace.id, secret.id)),
    { name: "ScopeViolationError" },
  );
  // Both calls enter the same real transaction and await ownership validation.
  // Generation comparison and publication must choose exactly one winner.
  const results = await state.transact((unit) =>
    Promise.all([
      unit.repositoryBindings.updateBinding({ ...saved, generation: 2, repositoryIds: [3, 4] }, 1),
      unit.repositoryBindings.updateBinding({ ...saved, generation: 2, repositoryIds: [3, 5] }, 1),
    ]),
  );
  const winners = results.filter((result) => result !== undefined);
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result === undefined).length, 1);
  assert.equal(winners[0].generation, 2);
  assert.equal(winners[0].state, "unverified");
  const final = await state.read((unit) =>
    unit.repositoryBindings.findBinding(namespace.id, binding.id),
  );
  assert.deepEqual(final, winners[0]);
  assert.deepEqual(saved.repositoryIds, [3]);
});
