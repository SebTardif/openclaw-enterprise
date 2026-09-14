import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const profiles = Object.freeze({
  providerProfileRef: "test/provider-v1",
  runtimeProfileRef: "test/runtime-v1",
  identityProfileRef: "test/identity-v1",
});
export const attribution = Object.freeze({
  actorId: "test/runtime-owner",
  requestId: "test/request",
});

// These synthetic profiles are persistence values only; no workload is launched.
export async function seedRuntimeOwner(store) {
  let installation = await store.read((s) => s.installations.getInstallation());
  if (!installation)
    installation = await store.transact((s) =>
      s.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: `Runtime ${randomUUID()}`,
        createdAt: new Date().toISOString(),
      }),
    );
  const createdAt = new Date().toISOString();
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `Runtime ${randomUUID()}`,
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

export function runtimeAudit(owner) {
  return {
    id: `aud_${randomUUID()}`,
    installationId: owner.installation.id,
    namespaceId: owner.namespace.id,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: attribution.actorId,
    action: "deploy",
    resource: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
    outcome: "success",
  };
}

export async function verifyRuntimeAssignmentStore(store) {
  const owner = await seedRuntimeOwner(store);
  const foreign = await seedRuntimeOwner(store);
  const { scope, revision } = owner;
  const write = (fn) => store.transact((s) => fn(s.runtimeAssignments));
  const read = (fn) => store.read((s) => fn(s.runtimeAssignments));
  assert.equal(await read((r) => r.findRuntimeIntentHead(scope)), undefined);
  await assert.rejects(
    write((r) => r.allocateUnboundRuntime(scope, 1, "gateway", 0, randomUUID(), profiles)),
  );
  await assert.rejects(
    write((r) => r.initializeRuntimeIntent(scope, foreign.revision.id, randomUUID(), attribution)),
  );

  const transitionRef = randomUUID();
  const mutableAttribution = { ...attribution };
  const intent = await write((r) =>
    r.initializeRuntimeIntent(scope, revision.id, transitionRef, mutableAttribution),
  );
  mutableAttribution.actorId = "changed";
  assert.equal(intent.generation, 1);
  assert.equal(intent.installationId, owner.installation.id);
  assert.equal(intent.revisionId, revision.id);
  assert.equal(intent.desiredMode, "running");
  assert.equal(intent.actorId, attribution.actorId);
  assert.equal(intent.requestId, attribution.requestId);
  assert.ok(Number.isFinite(Date.parse(intent.createdAt)));
  assert.deepEqual(await read((r) => r.findRuntimeIntent(scope, transitionRef)), intent);
  assert.deepEqual(await read((r) => r.findRuntimeIntentHead(scope)), intent);
  await assert.rejects(
    write((r) => r.initializeRuntimeIntent(scope, revision.id, randomUUID(), attribution)),
  );
  assert.equal(await read((r) => r.findRuntimeIntent(foreign.scope, transitionRef)), undefined);
  assert.equal(
    await read((r) =>
      r.findRuntimeIntent({ ...scope, namespaceId: foreign.namespace.id }, transitionRef),
    ),
    undefined,
  );

  const effect = randomUUID();
  const mutableProfiles = { ...profiles };
  const allocation = await write((r) =>
    r.allocateUnboundRuntime(scope, 1, "gateway", 0, effect, mutableProfiles),
  );
  mutableProfiles.runtimeProfileRef = "changed";
  assert.equal(allocation.runtimeGeneration, 1);
  assert.equal(allocation.lifecycleGeneration, 1);
  assert.equal(allocation.bindingCondition, "unbound");
  assert.equal(allocation.servicePrincipalId, owner.agent.servicePrincipalId);
  assert.equal(allocation.revisionId, revision.id);
  assert.equal(allocation.runtimeProfileRef, profiles.runtimeProfileRef);
  assert.deepEqual(
    await read((r) => r.findRuntimeAllocation(scope, { assignmentRef: allocation.assignmentRef })),
    allocation,
  );
  assert.deepEqual(
    await read((r) => r.findRuntimeAllocation(scope, { createEffectRef: effect })),
    allocation,
  );
  assert.equal(
    await read((r) => r.findRuntimeAllocation(foreign.scope, { createEffectRef: effect })),
    undefined,
  );
  assert.deepEqual(
    await write((r) => r.allocateUnboundRuntime(scope, 1, "gateway", 0, effect, profiles)),
    allocation,
  );
  for (const args of [
    [scope, 1, "harness", 0, effect, profiles],
    [scope, 2, "gateway", 0, effect, profiles],
    [scope, 1, "gateway", 1, effect, profiles],
    [scope, 1, "gateway", 0, effect, { ...profiles, identityProfileRef: "different" }],
    [foreign.scope, 1, "gateway", 0, effect, profiles],
  ])
    await assert.rejects(write((r) => r.allocateUnboundRuntime(...args)));

  const replacement = await write((r) =>
    r.allocateUnboundRuntime(scope, 1, "gateway", 1, randomUUID(), profiles),
  );
  assert.equal(replacement.runtimeGeneration, 2);
  const harness = await write((r) =>
    r.allocateUnboundRuntime(scope, 1, "harness", 0, randomUUID(), profiles),
  );
  assert.equal(harness.runtimeGeneration, 1);
  for (const desiredMode of ["disabled", "stopped"]) {
    const head = await read((r) => r.findRuntimeIntentHead(scope));
    const next = await write((r) =>
      r.advanceRuntimeIntent(
        scope,
        head.generation,
        { desiredMode, revisionId: revision.id },
        randomUUID(),
        attribution,
      ),
    );
    await assert.rejects(
      write((r) =>
        r.allocateUnboundRuntime(scope, next.generation, "gateway", 2, randomUUID(), profiles),
      ),
    );
    // Historical replay retrieves bookkeeping and cannot make a stopped runtime authoritative.
    assert.deepEqual(
      await write((r) => r.allocateUnboundRuntime(scope, 1, "gateway", 0, effect, profiles)),
      allocation,
    );
  }
  await assert.rejects(
    write((r) =>
      r.advanceRuntimeIntent(
        scope,
        3,
        { desiredMode: "running", revisionId: revision.id },
        transitionRef,
        attribution,
      ),
    ),
  );
  const resumed = await write((r) =>
    r.advanceRuntimeIntent(
      scope,
      3,
      { desiredMode: "running", revisionId: revision.id },
      randomUUID(),
      attribution,
    ),
  );
  const afterResume = await write((r) =>
    r.allocateUnboundRuntime(scope, resumed.generation, "gateway", 2, randomUUID(), profiles),
  );
  assert.equal(afterResume.runtimeGeneration, 3);
  assert.deepEqual(await read((r) => r.findRuntimeIntent(scope, transitionRef)), intent);

  // A success audit and both storage writes belong to the same rollback boundary.
  const rolledTransition = randomUUID();
  const rolledEffect = randomUUID();
  const audit = runtimeAudit(owner);
  await assert.rejects(
    store.transact(async (s) => {
      await s.runtimeAssignments.advanceRuntimeIntent(
        scope,
        4,
        { desiredMode: "running", revisionId: revision.id },
        rolledTransition,
        attribution,
      );
      await s.runtimeAssignments.allocateUnboundRuntime(
        scope,
        5,
        "gateway",
        3,
        rolledEffect,
        profiles,
      );
      await s.audit.append(audit);
      throw new Error("abort runtime storage transaction");
    }),
    /abort runtime storage transaction/,
  );
  assert.equal(await read((r) => r.findRuntimeIntent(scope, rolledTransition)), undefined);
  assert.equal(
    await read((r) => r.findRuntimeAllocation(scope, { createEffectRef: rolledEffect })),
    undefined,
  );
  assert.equal((await read((r) => r.findRuntimeIntentHead(scope))).generation, 4);
  assert.equal(
    (await store.transact((s) => s.audit.list())).some((e) => e.id === audit.id),
    false,
  );

  for (const expected of [
    -1,
    0,
    0.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      write((r) =>
        r.advanceRuntimeIntent(
          scope,
          expected,
          { desiredMode: "running", revisionId: revision.id },
          randomUUID(),
          attribution,
        ),
      ),
    );
  }
  for (const desiredMode of ["", "active", null])
    await assert.rejects(
      write((r) =>
        r.advanceRuntimeIntent(
          scope,
          4,
          { desiredMode, revisionId: revision.id },
          randomUUID(),
          attribution,
        ),
      ),
    );
  for (const actorId of ["", "x".repeat(201), "space here", null])
    await assert.rejects(
      write((r) =>
        r.advanceRuntimeIntent(
          scope,
          4,
          { desiredMode: "running", revisionId: revision.id },
          randomUUID(),
          { ...attribution, actorId },
        ),
      ),
    );
  for (const reference of ["", "bad ref", "x".repeat(201), null])
    await assert.rejects(
      write((r) =>
        r.allocateUnboundRuntime(scope, 4, "gateway", 3, randomUUID(), {
          ...profiles,
          runtimeProfileRef: reference,
        }),
      ),
    );
  for (const component of ["agent", "", null])
    await assert.rejects(
      write((r) => r.allocateUnboundRuntime(scope, 4, component, 0, randomUUID(), profiles)),
    );
  await assert.rejects(
    write((r) => r.allocateUnboundRuntime(scope, 4, "gateway", 3, "invalid-uuid", profiles)),
  );
  await assert.rejects(
    write((r) =>
      r.advanceRuntimeIntent(
        scope,
        4,
        { desiredMode: "running", revisionId: revision.id },
        "invalid-uuid",
        attribution,
      ),
    ),
  );
  assert.equal((await read((r) => r.findRuntimeIntentHead(scope))).generation, 4);
  for (const expected of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      write((r) => r.allocateUnboundRuntime(scope, 4, "gateway", expected, randomUUID(), profiles)),
    );
  for (const invalidProfiles of [
    { ...profiles, unexpected: "extra" },
    {
      providerProfileRef: profiles.providerProfileRef,
      runtimeProfileRef: profiles.runtimeProfileRef,
    },
  ])
    await assert.rejects(
      write((r) => r.allocateUnboundRuntime(scope, 4, "gateway", 3, randomUUID(), invalidProfiles)),
    );
  assert.throws(() => {
    intent.actorId = "changed";
  }, TypeError);
  assert.throws(() => {
    allocation.runtimeProfileRef = "changed";
  }, TypeError);
  const missing = { namespaceId: `ns_${randomUUID()}`, agentId: `agt_${randomUUID()}` };
  assert.equal(await read((r) => r.findRuntimeIntentHead(missing)), undefined);
  assert.equal(await read((r) => r.findRuntimeIntent(missing, transitionRef)), undefined);
  assert.equal(
    await read((r) =>
      r.findRuntimeAllocation(missing, { assignmentRef: allocation.assignmentRef }),
    ),
    undefined,
  );

  const failedAuditTransition = randomUUID();
  await assert.rejects(
    store.transact(async (s) => {
      await s.runtimeAssignments.advanceRuntimeIntent(
        scope,
        4,
        { desiredMode: "running", revisionId: revision.id },
        failedAuditTransition,
        attribution,
      );
      await s.audit.append({ ...runtimeAudit(owner), installationId: `ins_${randomUUID()}` });
    }),
  );
  assert.equal(await read((r) => r.findRuntimeIntent(scope, failedAuditTransition)), undefined);
  assert.equal((await read((r) => r.findRuntimeIntentHead(scope))).generation, 4);

  // The supported lifecycle permits tombstoning only an empty Namespace. Do not
  // invent a tombstoned Namespace retaining Agents to test a state that cannot occur.
  const retired = {
    id: `ns_${randomUUID()}`,
    name: `Retired ${randomUUID()}`,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(retired);
    await s.namespaces.transitionNamespaceStatus(retired.id, "ready", "deleting");
    await s.namespaces.markNamespaceDeleted(retired.id, new Date().toISOString());
  });
  const retiredScope = { namespaceId: retired.id, agentId: scope.agentId };
  assert.equal(await read((r) => r.findRuntimeIntentHead(retiredScope)), undefined);
  assert.equal(await read((r) => r.findRuntimeIntent(retiredScope, transitionRef)), undefined);
  assert.equal(
    await read((r) => r.findRuntimeAllocation(retiredScope, { createEffectRef: effect })),
    undefined,
  );
  await assert.rejects(
    write((r) => r.initializeRuntimeIntent(retiredScope, revision.id, randomUUID(), attribution)),
  );
  await assert.rejects(
    write((r) => r.allocateUnboundRuntime(retiredScope, 1, "gateway", 0, randomUUID(), profiles)),
  );
  await verifyConcurrentRuntimeMutations(store);
  return { owner, intent, allocation };
}

async function verifyConcurrentRuntimeMutations(store) {
  const { scope, revision } = await seedRuntimeOwner(store);
  const next = { desiredMode: "running", revisionId: revision.id };
  function oneWinner(outcomes) {
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const failure = outcomes.find((result) => result.status === "rejected");
    assert.equal(failure?.reason.name, "ResourceConflictError");
    return outcomes.find((result) => result.status === "fulfilled").value;
  }
  // Concurrent calls in one callback share a unit of work; the outer transaction
  // queue cannot protect the read/check/write intervals between these operations.
  const initialRefs = [randomUUID(), randomUUID()];
  const initial = oneWinner(
    await store.transact((s) =>
      Promise.allSettled(
        initialRefs.map((ref) =>
          s.runtimeAssignments.initializeRuntimeIntent(scope, revision.id, ref, attribution),
        ),
      ),
    ),
  );
  assert.equal(initial.generation, 1);
  for (const ref of initialRefs) {
    const saved = await store.read((s) => s.runtimeAssignments.findRuntimeIntent(scope, ref));
    assert.deepEqual(saved, ref === initial.transitionRef ? initial : undefined);
  }
  const advanceRefs = [randomUUID(), randomUUID()];
  const advanced = oneWinner(
    await store.transact((s) =>
      Promise.allSettled(
        advanceRefs.map((ref) =>
          s.runtimeAssignments.advanceRuntimeIntent(scope, 1, next, ref, attribution),
        ),
      ),
    ),
  );
  assert.equal(advanced.generation, 2);
  assert.deepEqual(
    await store.read((s) => s.runtimeAssignments.findRuntimeIntentHead(scope)),
    advanced,
  );
  for (const ref of advanceRefs) {
    const saved = await store.read((s) => s.runtimeAssignments.findRuntimeIntent(scope, ref));
    assert.deepEqual(saved, ref === advanced.transitionRef ? advanced : undefined);
  }
  const effects = [randomUUID(), randomUUID()];
  const allocation = oneWinner(
    await store.transact((s) =>
      Promise.allSettled(
        effects.map((effect) =>
          s.runtimeAssignments.allocateUnboundRuntime(scope, 2, "gateway", 0, effect, profiles),
        ),
      ),
    ),
  );
  assert.equal(allocation.runtimeGeneration, 1);
  for (const effect of effects) {
    const saved = await store.read((s) =>
      s.runtimeAssignments.findRuntimeAllocation(scope, { createEffectRef: effect }),
    );
    assert.deepEqual(saved, effect === allocation.createEffectRef ? allocation : undefined);
  }
  const sharedEffect = randomUUID();
  const replays = await store.transact((s) =>
    Promise.all([
      s.runtimeAssignments.allocateUnboundRuntime(scope, 2, "gateway", 1, sharedEffect, profiles),
      s.runtimeAssignments.allocateUnboundRuntime(scope, 2, "gateway", 1, sharedEffect, profiles),
    ]),
  );
  assert.deepEqual(replays[0], replays[1]);
  assert.equal(replays[0].runtimeGeneration, 2);
  const conflictingEffect = randomUUID();
  const sameEffect = oneWinner(
    await store.transact((s) =>
      Promise.allSettled([
        s.runtimeAssignments.allocateUnboundRuntime(
          scope,
          2,
          "gateway",
          2,
          conflictingEffect,
          profiles,
        ),
        s.runtimeAssignments.allocateUnboundRuntime(
          scope,
          2,
          "gateway",
          3,
          conflictingEffect,
          profiles,
        ),
      ]),
    ),
  );
  assert.equal(sameEffect.runtimeGeneration, 3);
  assert.deepEqual(
    await store.read((s) =>
      s.runtimeAssignments.findRuntimeAllocation(scope, { createEffectRef: conflictingEffect }),
    ),
    sameEffect,
  );
  // A head change must be visible to an allocation invoked after it, even when
  // both promises are awaited together rather than sequentially by the caller.
  const blockedEffect = randomUUID();
  const stopped = await store.transact((s) =>
    Promise.allSettled([
      s.runtimeAssignments.advanceRuntimeIntent(
        scope,
        2,
        { ...next, desiredMode: "stopped" },
        randomUUID(),
        attribution,
      ),
      s.runtimeAssignments.allocateUnboundRuntime(scope, 2, "gateway", 3, blockedEffect, profiles),
    ]),
  );
  assert.equal(oneWinner(stopped).desiredMode, "stopped");
  assert.equal(
    await store.read((s) =>
      s.runtimeAssignments.findRuntimeAllocation(scope, { createEffectRef: blockedEffect }),
    ),
    undefined,
  );
}
