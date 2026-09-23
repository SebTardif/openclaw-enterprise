import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { seedOAuthAgent } from "./agent-oauth-state.contract.mjs";
import {
  actor,
  otherActor,
  method,
  credential,
  envelope,
  fixture,
} from "../helpers/agent-oauth-custody.mjs";

test("OAuth consent and complete credential custody precede deployment without exposing material", async () => {
  const f = await fixture();
  const selected = await f.begin();
  const authenticated = await (await f.acquire(selected)).stage(envelope(selected));
  const attempt = await f.latest();
  assert.equal(authenticated.phase, "authenticated");
  assert.equal(authenticated.providerConnectionId, f.connection.id);
  assert.equal(authenticated.providerId, method.providerId);
  assert.notEqual(f.connection.providerId, authenticated.providerId);
  assert.deepEqual(
    JSON.parse(f.storage.valueFor(attempt.secretIdentity)),
    JSON.parse(envelope(selected)),
  );
  assert.deepEqual(await f.custody.get(actor, f.namespace.id, f.agent.id), authenticated);
  assert.deepEqual(Object.keys(authenticated).sort(), [
    "attemptId",
    "connectionId",
    "deadlineAt",
    "failureCode",
    "generation",
    "methodId",
    "phase",
    "profileId",
    "providerConnectionId",
    "providerId",
  ]);
  const persisted = await f.controller.transact(async (view) => ({
    attempt: await view.agentOAuth.latest(f.namespace.id, f.agent.id),
    agent: await view.agents.findAgent(f.namespace.id, f.agent.id),
    configuration: await view.configurations.findConfiguration(
      f.namespace.id,
      f.agent.configurationId,
    ),
    revisions: await view.revisions.listRevisions(f.namespace.id, f.agent.id),
    ordinarySecret: await view.secrets.findSecret(f.namespace.id, attempt.secretIdentity.id),
    audit: await view.audit.list(),
    operations: await view.operations.list(),
  }));
  assert.deepEqual(persisted.revisions, []);
  assert.equal(persisted.agent.activeRevisionId, undefined);
  assert.equal(persisted.ordinarySecret, undefined);
  assert.deepEqual(persisted.operations, []);
  for (const material of [
    credential.access,
    credential.refresh,
    credential.idToken,
    credential.accountId,
  ]) {
    assert.equal(JSON.stringify({ selected, authenticated, persisted }).includes(material), false);
  }
});

test("OAuth begin requires the selected catalog OAuth method and its operate permission", async () => {
  const f = await fixture();
  for (const mismatch of [
    { ...method, providerId: "another-provider" },
    { ...method, methodId: "browser" },
  ]) {
    await assert.rejects(
      f.custody.begin(actor, f.namespace.id, f.agent.id, mismatch, 0, f.connection.id),
      ScopeViolationError,
    );
  }
  await f.selectConnection(null);
  await assert.rejects(f.begin(), ScopeViolationError);
  const nonOAuth = await f.createConnection({ authMethodId: "none" });
  await f.selectConnection(nonOAuth);
  await assert.rejects(f.begin(), ScopeViolationError);
  await f.selectConnection(f.connection);
  revokeOperate(f);
  await assert.rejects(f.begin(), AuthorizationDeniedError);
  assert.equal(await f.latest(), undefined);
  assert.equal(f.stageCalls(), 0);
});

function revokeOperate(f) {
  f.iamState.bindings = f.iamState.bindings.filter(
    ({ subjectId, roleId }) => subjectId !== actor || roleId !== "oauth-operator",
  );
}

test("OAuth begin binds the exact selected provider connection even when two connections share a native method", async () => {
  const f = await fixture();
  const replacement = await f.createConnection();
  await f.selectConnection(replacement);
  await assert.rejects(f.begin(0, f.connection.id), ScopeViolationError);
  assert.equal(await f.latest(), undefined);
  const selected = await f.begin(0, replacement.id);
  assert.equal(selected.providerConnectionId, replacement.id);
  assert.equal(selected.providerId, method.providerId);
  assert.equal(selected.methodId, method.methodId);
});

test("OAuth begin requires Agent operate in addition to Agent administration and provider operation", async () => {
  const f = await fixture();
  f.iamState.bindings = f.iamState.bindings.filter(
    ({ subjectId, roleId }) => subjectId !== actor || roleId !== "oauth-agent-operator",
  );
  await assert.rejects(f.begin(), AuthorizationDeniedError);
  assert.equal(await f.latest(), undefined);
  assert.equal(f.stageCalls(), 0);
});

for (const phase of ["authorizing", "staging", "authenticated"]) {
  test(`status inspection durably expires pending consent while preserving ${phase} custody semantics`, async () => {
    const f = await fixture({
      stageOutcome: phase === "staging" ? "lost-acknowledgment" : undefined,
    });
    const selected = await f.begin();
    if (phase === "staging") {
      await assert.rejects(
        (await f.acquire(selected)).stage(envelope(selected)),
        DependencyUnavailableError,
      );
    } else if (phase === "authenticated") {
      await (await f.acquire(selected)).stage(envelope(selected));
    }
    // A status read must settle a persisted pending attempt even when no live
    // acquisition timer exists after restart. Completed consent has its own lifecycle.
    f.advanceTo(selected.deadlineAt);
    const observed = await f.custody.get(actor, f.namespace.id, f.agent.id);
    assert.equal(
      observed.phase,
      phase === "authenticated" ? "authenticated" : "reconnect_required",
    );
    assert.equal(observed.failureCode, phase === "authenticated" ? null : "OAUTH_EXPIRED");
    assert.equal((await f.latest()).phase, observed.phase);
    assert.deepEqual(await f.custody.get(actor, f.namespace.id, f.agent.id), observed);
    if (phase !== "authenticated") {
      await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
      assert.equal(f.storage.has((await f.latest()).secretIdentity), false);
    }
  });
}

for (const phase of ["authorizing", "staging", "authenticated"]) {
  test(`changing the draft selection supersedes ${phase} custody even when switched back`, async () => {
    const f = await fixture({
      stageOutcome: phase === "staging" ? "lost-acknowledgment" : undefined,
    });
    const first = await f.begin();
    const acquisition = await f.acquire(first);
    if (phase === "authenticated") {
      await acquisition.stage(envelope(first));
    } else if (phase === "staging") {
      await assert.rejects(acquisition.stage(envelope(first)), DependencyUnavailableError);
    }
    const replacement = await f.createConnection();
    await f.selectConnection(replacement);
    assert.equal((await f.latest()).phase, "superseded");
    await f.selectConnection(f.connection);
    await assert.rejects(acquisition.assertCurrent(), ResourceConflictError);
    await assert.rejects(acquisition.stage(envelope(first)), ResourceConflictError);
    const second = await f.begin(first.generation);
    assert.equal(second.providerConnectionId, first.providerConnectionId);
    assert.equal(second.connectionId, first.connectionId);
    assert.equal(second.generation, first.generation + 1);
    assert.notEqual(second.profileId, first.profileId);
    await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
    assert.equal(
      f.storage.calls.filter(({ operation }) => operation === "delete").length,
      phase === "authorizing" ? 0 : 1,
    );
  });
}

test("configuration updates preserving the provider connection retain authenticated custody", async () => {
  const f = await fixture();
  const first = await f.begin();
  const authenticated = await (await f.acquire(first)).stage(envelope(first));
  await f.selectConnection(f.connection);
  await f.controller.updateAgent(actor, {
    namespaceId: f.namespace.id,
    agentId: f.agent.id,
    configurationId: f.agent.configurationId,
    executionMode: "embedded",
  });
  assert.deepEqual(await f.custody.get(actor, f.namespace.id, f.agent.id), authenticated);
  assert.equal(f.stageCalls(), 1);
});

for (const phase of ["handoff_pending", "ready"]) {
  test(`draft selection cannot replace a ${phase} native refresh owner`, async () => {
    const f = await fixture();
    const first = await f.begin();
    await (await f.acquire(first)).stage(envelope(first));
    await f.state.transact(async (unit) => {
      const transition = (expectedPhase, next) =>
        unit.agentOAuth.update({
          namespaceId: f.namespace.id,
          agentId: f.agent.id,
          generation: first.generation,
          expectedPhase,
          phase: next,
          storageUid: "retained-agent-volume",
          updatedAt: first.deadlineAt,
        });
      await transition("authenticated", "handoff_pending");
      if (phase === "ready") {
        await transition("handoff_pending", "ready");
      }
    });
    const replacement = await f.createConnection();
    await assert.rejects(f.selectConnection(replacement), ResourceConflictError);
    const agent = await f.state.read((view) => view.agents.findAgent(f.namespace.id, f.agent.id));
    assert.equal(agent.harnessAuth.connectionId, f.connection.id);
    assert.equal((await f.latest()).phase, phase);
  });
}

test("reusing setup metadata keeps OAuth credentials and logical connections Agent-owned", async () => {
  const f = await fixture();
  const secondAgent = {
    ...f.agent,
    id: `agt_${randomUUID()}`,
    name: "Second OAuth Agent",
    servicePrincipalId: `sp-${randomUUID()}`,
    harnessAuth: { method: "provider_connection", connectionId: f.connection.id },
  };
  await f.state.transact((unit) => unit.agents.createAgent(secondAgent));
  const first = await f.begin();
  const second = await f.custody.begin(
    actor,
    f.namespace.id,
    secondAgent.id,
    method,
    0,
    f.connection.id,
  );
  await (await f.acquire(first)).stage(envelope(first));
  await (
    await f.custody.acquisition(actor, f.namespace.id, secondAgent.id, second)
  ).stage(envelope(second));
  assert.equal(first.providerConnectionId, second.providerConnectionId);
  assert.notEqual(first.connectionId, second.connectionId);
  assert.notEqual(first.profileId, second.profileId);
  const secondAttempt = await f.state.read((view) =>
    view.agentOAuth.latest(f.namespace.id, secondAgent.id),
  );
  assert.notEqual((await f.latest()).secretIdentity.id, secondAttempt.secretIdentity.id);
  assert.deepEqual(
    await f.state.read((view) =>
      view.providerConnections.findProviderConnection(f.namespace.id, f.connection.id),
    ),
    f.connection,
  );
});

test("superseded custody can be cleaned after its historical setup metadata is deleted", async () => {
  const f = await fixture();
  const selected = await f.begin();
  await (await f.acquire(selected)).stage(envelope(selected));
  const attempt = await f.latest();
  await f.selectConnection(await f.createConnection());
  await f.controller.deleteProviderConnection(actor, f.namespace.id, f.connection.id);
  revokeOperate(f);
  assert.equal((await f.custody.get(actor, f.namespace.id, f.agent.id)).phase, "superseded");
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  assert.equal(f.storage.has(attempt.secretIdentity), false);
  assert.equal((await f.latest()).stagedSecret, null);
});

test("OAuth acquisition binds the initiating actor, Namespace, Agent, and generation", async () => {
  const f = await fixture();
  const selected = await f.begin();
  const foreign = await seedOAuthAgent(f.state);
  for (const [actorId, namespaceId, agentId, status, error] of [
    [otherActor, f.namespace.id, f.agent.id, selected, ResourceConflictError],
    [actor, foreign.namespace.id, f.agent.id, selected, ScopeViolationError],
    [actor, foreign.namespace.id, foreign.agent.id, selected, ResourceConflictError],
    [actor, f.namespace.id, f.agent.id, { ...selected, generation: 2 }, ResourceConflictError],
  ]) {
    await assert.rejects(f.custody.acquisition(actorId, namespaceId, agentId, status), error);
  }
  assert.equal(f.stageCalls(), 0);
  assert.equal((await f.latest()).phase, "authorizing");
});

test("OAuth acquisition uses its stored provider binding and refuses mismatched credential envelopes", async () => {
  const f = await fixture();
  const selected = await f.begin();
  const acquisition = await f.acquire({ ...selected, providerId: "another-provider" });
  assert.deepEqual(acquisition.status, selected);
  const original = JSON.parse(envelope(selected));
  for (const mismatched of [
    { ...original, provider: "another-provider" },
    { ...original, credential: { ...credential, provider: "another-provider" } },
    { ...original, profileId: "openai:foreign-profile" },
  ]) {
    await assert.rejects(acquisition.stage(JSON.stringify(mismatched)), ScopeViolationError);
  }
  assert.equal(f.stageCalls(), 0);
  assert.equal((await f.latest()).phase, "authorizing");
});

for (const closure of ["expired", "cancelled", "superseded"]) {
  test(`OAuth ${closure} consent cannot stage through a retained acquisition handle`, async () => {
    const f = await fixture();
    const selected = await f.begin();
    const acquisition = await f.acquire(selected);
    if (closure === "expired") {
      f.advanceTo(selected.deadlineAt);
    } else if (closure === "cancelled") {
      await f.custody.cancel(
        actor,
        f.namespace.id,
        f.agent.id,
        selected.attemptId,
        selected.generation,
      );
    } else {
      const replacement = await f.begin(selected.generation);
      assert.equal(replacement.connectionId, selected.connectionId);
      assert.equal(replacement.generation, selected.generation + 1);
      assert.notEqual(replacement.profileId, selected.profileId);
    }
    await assert.rejects(acquisition.assertCurrent(), ResourceConflictError);
    await assert.rejects(acquisition.stage(envelope(selected)), ResourceConflictError);
    assert.equal(f.stageCalls(), 0);
    assert.equal(f.storage.calls.length, 0);
  });
}

for (const permission of ["Agent", "Agent operate", "provider connection"]) {
  test(`OAuth provider completion revalidates ${permission} IAM after consent was pending`, async () => {
    const f = await fixture();
    const selected = await f.begin();
    const acquisition = await f.acquire(selected);
    // The retained handle represents a provider wait; no authority is cached across it.
    if (permission === "Agent") {
      f.iamState.bindings = f.iamState.bindings.filter(({ subjectId }) => subjectId !== actor);
    } else if (permission === "Agent operate") {
      f.iamState.bindings = f.iamState.bindings.filter(
        ({ subjectId, roleId }) => subjectId !== actor || roleId !== "oauth-agent-operator",
      );
    } else {
      revokeOperate(f);
    }
    await assert.rejects(acquisition.assertCurrent(), AuthorizationDeniedError);
    await assert.rejects(acquisition.stage(envelope(selected)), AuthorizationDeniedError);
    assert.equal(f.stageCalls(), 0);
    assert.equal((await f.latest()).phase, "authorizing");
  });
}

test("OAuth staging revalidates provider operate permission after writing bytes and permits administrative cleanup", async () => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture({
    beforeStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const selected = await f.begin();
  const staging = (await f.acquire(selected)).stage(envelope(selected));
  await entered.promise;
  revokeOperate(f);
  resumed.resolve();
  await assert.rejects(staging, AuthorizationDeniedError);
  const attempt = await f.latest();
  assert.equal(attempt.phase, "staging");
  assert.equal(attempt.stagedSecret, null);
  assert.equal(f.storage.has(attempt.secretIdentity), true);
  await assert.rejects(
    f.custody.recover(actor, f.namespace.id, f.agent.id, selected.attemptId, selected.generation),
    AuthorizationDeniedError,
  );
  assert.equal(f.lookupCalls(), 0);
  await f.custody.cancel(
    actor,
    f.namespace.id,
    f.agent.id,
    selected.attemptId,
    selected.generation,
  );
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  assert.equal(f.storage.has(attempt.secretIdentity), false);
});

test("OAuth session revocation during Secret creation never publishes authenticated custody", async () => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture({
    beforeStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const selected = await f.begin();
  let sessionCurrent = true;
  const acquisition = await f.custody.acquisition(
    actor,
    f.namespace.id,
    f.agent.id,
    selected,
    undefined,
    async () => {
      // Reading canonical state here also proves the custody transaction has
      // released its connection before the external session verifier runs.
      const attempt = await f.latest();
      assert.equal(attempt.phase, "staging");
      assert.equal(attempt.stagedSecret, null);
      if (!sessionCurrent) {
        throw new Error("Session revoked.");
      }
    },
  );
  const staging = acquisition.stage(envelope(selected));
  await entered.promise;
  sessionCurrent = false;
  resumed.resolve();
  await assert.rejects(staging, ResourceConflictError);
  assert.equal(acquisition.signal.aborted, true);
  await acquisition.fail();
  const attempt = await f.latest();
  assert.equal(attempt.phase, "cancelled");
  assert.equal(attempt.stagedSecret, null);
  assert.equal(f.storage.has(attempt.secretIdentity), true);
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  assert.equal(f.storage.has(attempt.secretIdentity), false);
});

test("OAuth rechecks its exact selection after external session verification", async () => {
  const f = await fixture();
  const replacement = await f.createConnection();
  const selected = await f.begin();
  const acquisition = await f.custody.acquisition(
    actor,
    f.namespace.id,
    f.agent.id,
    selected,
    undefined,
    async () => {
      await f.selectConnection(replacement);
    },
  );
  await assert.rejects(acquisition.stage(envelope(selected)), ResourceConflictError);
  const attempt = await f.latest();
  assert.equal(attempt.phase, "superseded");
  assert.equal(attempt.stagedSecret, null);
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  assert.equal(f.storage.has(attempt.secretIdentity), false);
});

test("OAuth recovery finds committed Secret material after an ambiguous create without reacquiring bytes", async () => {
  const f = await fixture({ stageOutcome: "lost-acknowledgment" });
  const selected = await f.begin();
  const acquisition = await f.acquire(selected);
  await assert.rejects(acquisition.stage(envelope(selected)), (error) => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.equal(JSON.stringify(error).includes(credential.refresh), false);
    assert.equal(error.message.includes(credential.refresh), false);
    return true;
  });
  await acquisition.fail();
  const pending = await f.latest();
  assert.equal(pending.phase, "staging");
  assert.equal(pending.stagedSecret, null);
  assert.equal(f.storage.valueFor(pending.secretIdentity), envelope(selected));
  const recovered = await f.custody.recover(
    actor,
    f.namespace.id,
    f.agent.id,
    selected.attemptId,
    selected.generation,
  );
  assert.equal(recovered.phase, "authenticated");
  assert.equal(f.stageCalls(), 1);
  assert.equal(f.lookupCalls(), 1);
  assert.equal((await f.latest()).stagedSecret.id, pending.secretIdentity.id);
  assert.equal(
    f.storage.calls.some(({ operation }) => operation === "resolve"),
    false,
  );
});

for (const closure of ["IAM revocation", "provider operate revocation", "consent expiry"]) {
  test(`OAuth recovery revalidates ${closure} after its backend lookup`, async () => {
    const entered = Promise.withResolvers();
    const resumed = Promise.withResolvers();
    const f = await fixture({
      stageOutcome: "lost-acknowledgment",
      afterLookup: () => {
        entered.resolve();
        return resumed.promise;
      },
    });
    const selected = await f.begin();
    await assert.rejects(
      (await f.acquire(selected)).stage(envelope(selected)),
      DependencyUnavailableError,
    );
    const recovery = f.custody.recover(
      actor,
      f.namespace.id,
      f.agent.id,
      selected.attemptId,
      selected.generation,
    );
    await entered.promise;
    // Complete the external lookup only after the live authority has closed.
    if (closure === "IAM revocation") {
      f.iamState.bindings = f.iamState.bindings.filter(({ subjectId }) => subjectId !== actor);
    } else if (closure === "provider operate revocation") {
      revokeOperate(f);
    } else {
      f.advanceTo(selected.deadlineAt);
    }
    resumed.resolve();
    await assert.rejects(
      recovery,
      closure === "consent expiry" ? ResourceConflictError : AuthorizationDeniedError,
    );
    assert.equal((await f.latest()).phase, "staging");
    assert.equal((await f.latest()).stagedSecret, null);
    assert.equal(f.stageCalls(), 1);
  });
}

test("OAuth cancellation cleans an unknown create outcome and cleanup is retryable", async () => {
  const f = await fixture({ stageOutcome: "lost-acknowledgment" });
  const selected = await f.begin();
  await assert.rejects(
    (await f.acquire(selected)).stage(envelope(selected)),
    DependencyUnavailableError,
  );
  const pending = await f.latest();
  await f.custody.cancel(
    actor,
    f.namespace.id,
    f.agent.id,
    selected.attemptId,
    selected.generation,
  );
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  await f.custody.cleanup(actor, f.namespace.id, f.agent.id);
  assert.equal(f.storage.has(pending.secretIdentity), false);
  assert.equal(f.storage.calls.filter(({ operation }) => operation === "delete").length, 1);
  assert.equal((await f.latest()).phase, "cancelled");
  assert.equal((await f.latest()).stagedSecret, null);
});

test("OAuth recovery distinguishes an absent Secret from a successful staging acknowledgment", async () => {
  const f = await fixture({ stageOutcome: "failed-before-create" });
  const selected = await f.begin();
  await assert.rejects(
    (await f.acquire(selected)).stage(envelope(selected)),
    DependencyUnavailableError,
  );
  const recovered = await f.custody.recover(
    actor,
    f.namespace.id,
    f.agent.id,
    selected.attemptId,
    selected.generation,
  );
  assert.equal(recovered.phase, "reconnect_required");
  assert.equal(recovered.failureCode, "CREDENTIAL_STAGING_FAILED");
  assert.equal((await f.latest()).stagedSecret, null);
  assert.equal(f.stageCalls(), 1);
});
