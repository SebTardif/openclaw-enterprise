import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { inspectRuntimeOwner } from "../../packages/occ/src/delegation/runtime-owner.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const profiles = {
  providerProfileRef: "test/provider-v1",
  runtimeProfileRef: "test/runtime-v1",
  identityProfileRef: "test/identity-v1",
};
const attribution = { actorId: "test/operator", requestId: "test/request" };

async function owner(store) {
  let installation = await store.read((unit) => unit.installations.getInstallation());
  if (!installation)
    installation = await store.transact((unit) =>
      unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Delegation owner test",
        createdAt: new Date().toISOString(),
      }),
    );
  const createdAt = new Date().toISOString();
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `Owner ${randomUUID()}`,
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
  // The selected dedicated configuration and ready Namespace match supported storage states.
  // Only allocation is exercised here: no guest, identity or serving state is invented.
  const agent = {
    id: `agt_${randomUUID()}`,
    namespaceId: namespace.id,
    name: "Owner",
    configurationId: configuration.id,
    providerId: null,
    executionMode: "dedicated",
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
    configuration: createHarnessConfiguration("codex", "gpt-5.1"),
    harness: { id: "codex", version: "0.153.0", mode: "dedicated" },
    compute: { id: "compute-test", implementation: "deterministic-test" },
    servicePrincipalId: agent.servicePrincipalId,
    createdAt,
  };
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  await store.transact(async (unit) => {
    await unit.namespaces.createNamespace(namespace);
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
    await unit.revisions.createRevision(revision);
    await unit.runtimeAssignments.initializeRuntimeIntent(
      scope,
      revision.id,
      randomUUID(),
      attribution,
    );
  });
  const allocate = (expectedRuntimeGeneration = 0) =>
    store.transact((unit) =>
      unit.runtimeAssignments.allocateUnboundRuntime(
        scope,
        1,
        "harness",
        expectedRuntimeGeneration,
        randomUUID(),
        profiles,
      ),
    );
  const allocation = await allocate();
  const holder = {
    installationId: installation.id,
    namespaceId: namespace.id,
    agentId: agent.id,
    agentRevisionId: revision.id,
    servicePrincipalId: agent.servicePrincipalId,
    assignmentRef: { schemaVersion: 1, id: allocation.assignmentRef },
    component: "harness",
    lifecycleGeneration: 1,
    runtimeGeneration: 1,
    ...profiles,
  };
  return { holder, scope, revision, allocate, allocation };
}

test("real matching allocation and historical replacement are unbound evidence, never execution authority", async () => {
  const store = new InMemoryPlatformState();
  const { holder, allocate } = await owner(store);
  const initial = await inspectRuntimeOwner(store, holder);
  assert.deepEqual(initial, { result: "unbound", holder });
  const replacement = await allocate(1);
  assert.equal((await inspectRuntimeOwner(store, holder)).result, "unbound");
  assert.equal(
    (
      await inspectRuntimeOwner(store, {
        ...holder,
        assignmentRef: { schemaVersion: 1, id: replacement.assignmentRef },
        runtimeGeneration: 2,
      })
    ).result,
    "unbound",
  );
  holder.agentId = "changed";
  assert.notEqual(initial.holder.agentId, holder.agentId);
  assert.equal(Object.isFrozen(initial.holder.assignmentRef), true);
});

test("real lifecycle head changes invalidate an old allocation even when revision stays the same", async () => {
  for (const desiredMode of ["running", "disabled", "stopped"]) {
    const store = new InMemoryPlatformState();
    const { holder, scope, revision } = await owner(store);
    await store.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        scope,
        1,
        { desiredMode, revisionId: revision.id },
        randomUUID(),
        attribution,
      ),
    );
    assert.equal((await inspectRuntimeOwner(store, holder)).result, "not-current");
  }
});

test("exact ownership, profile, component generation and locator checks refuse substitution", async () => {
  const store = new InMemoryPlatformState();
  const first = await owner(store);
  const foreign = await owner(store);
  for (const field of [
    "installationId",
    "namespaceId",
    "agentId",
    "agentRevisionId",
    "servicePrincipalId",
  ]) {
    const changed = field === "installationId" ? `ins_${randomUUID()}` : foreign.holder[field];
    assert.equal(
      (await inspectRuntimeOwner(store, { ...first.holder, [field]: changed })).result,
      "not-visible",
    );
  }
  for (const field of ["providerProfileRef", "runtimeProfileRef", "identityProfileRef"])
    assert.equal(
      (await inspectRuntimeOwner(store, { ...first.holder, [field]: "other/profile" })).result,
      "not-current",
    );
  assert.equal(
    (await inspectRuntimeOwner(store, { ...first.holder, runtimeGeneration: 2 })).result,
    "not-current",
  );
  assert.equal(
    (
      await inspectRuntimeOwner(store, {
        ...first.holder,
        assignmentRef: { schemaVersion: 1, id: foreign.holder.assignmentRef.id },
      })
    ).result,
    "not-visible",
  );
  assert.equal(
    (
      await inspectRuntimeOwner(store, {
        ...first.holder,
        assignmentRef: { schemaVersion: 1, id: first.allocation.createEffectRef },
      })
    ).result,
    "not-visible",
  );
  assert.equal(
    (
      await inspectRuntimeOwner(store, {
        ...first.holder,
        assignmentRef: { schemaVersion: 1, createEffectRef: randomUUID() },
      })
    ).result,
    "invalid-input",
  );
  assert.equal(
    (await inspectRuntimeOwner(new InMemoryPlatformState(), first.holder)).result,
    "not-visible",
  );
});
