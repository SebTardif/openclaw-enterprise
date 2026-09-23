import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function seedOAuthAgent(store) {
  const createdAt = "2026-09-23T00:00:00.000Z";
  const namespace = {
    id: `ns_${randomUUID()}`,
    name: `OAuth ${randomUUID()}`,
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
    name: `Draft ${randomUUID()}`,
    configurationId: configuration.id,
    providerId: null,
    harnessAuth: null,
    executionMode: "embedded",
    servicePrincipalId: `sp-${randomUUID()}`,
    createdAt,
  };
  await store.transact(async (unit) => {
    if ((await unit.installations.getInstallation()) === undefined) {
      await unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "OAuth state contract",
        createdAt,
      });
    }
    await unit.namespaces.createNamespace(namespace);
    await unit.configurations.createConfiguration(configuration);
    await unit.agents.createAgent(agent);
  });
  return { namespace, agent };
}

export function oauthAttempt(agent, overrides = {}) {
  return {
    namespaceId: agent.namespaceId,
    agentId: agent.id,
    providerConnectionId: `pco_${randomUUID()}`,
    connectionId: `aoc_${randomUUID()}`,
    generation: 1,
    attemptId: `aoa_${randomUUID()}`,
    actorId: "actor-oauth",
    providerId: "openai",
    methodId: "device-code",
    profileId: `openai:oce:${agent.id}:1`,
    phase: "authorizing",
    deadlineAt: "2026-09-23T00:10:00.000Z",
    secretDriverId: "kubernetes-secret",
    secretIdentity: {
      id: `sec_${randomUUID()}`,
      namespaceId: agent.namespaceId,
      name: `oauth-${randomUUID()}`,
    },
    stagedSecret: null,
    storageUid: null,
    failureCode: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

export function stagedSecret(attempt) {
  return {
    ...attempt.secretIdentity,
    driverId: attempt.secretDriverId,
    backendRef: {
      namespaceName: "oauth-tenant",
      name: "oauth-staging",
      key: "value",
      uid: randomUUID(),
    },
    createdAt: attempt.createdAt,
  };
}

export async function verifyAgentOAuthState(t, store) {
  await t.test(
    "draft OAuth metadata survives handoff retry and teardown retains outstanding custody",
    async () => {
      const { agent } = await seedOAuthAgent(store);
      const attempt = oauthAttempt(agent);
      await store.transact((unit) => unit.agentOAuth.create(attempt));
      const advance = (expectedPhase, phase, fields = {}) =>
        store.transact(async (unit) => {
          await unit.agents.lockAgent(agent.namespaceId, agent.id);
          return unit.agentOAuth.update({
            namespaceId: agent.namespaceId,
            agentId: agent.id,
            generation: 1,
            expectedPhase,
            phase,
            updatedAt: "2026-09-23T00:01:00.000Z",
            ...fields,
          });
        });
      await advance("authorizing", "staging");
      const secret = stagedSecret(attempt);
      await advance("staging", "authenticated", { stagedSecret: secret });
      assert.equal(await advance("staging", "authenticated", { stagedSecret: secret }), undefined);
      await advance("authenticated", "handoff_pending", { storageUid: "durable-pvc-uid" });
      await advance("handoff_pending", "ready");
      await assert.rejects(advance("ready", "ready", { storageUid: "replacement-pvc-uid" }));
      // Native receipt can be durable before the controller's staged Secret deletion succeeds.
      await assert.rejects(
        store.transact((unit) => unit.agentOAuth.delete(agent.namespaceId, agent.id)),
      );
      await store.transact((unit) =>
        unit.agents.transitionAgentStatus(agent.namespaceId, agent.id, "active", "deleting"),
      );
      await assert.rejects(
        store.transact((unit) => unit.agentOAuth.delete(agent.namespaceId, agent.id)),
      );
      await advance("ready", "ready", { stagedSecret: null });
      await assert.rejects(advance("ready", "ready", { stagedSecret: secret }));
      const ready = await store.read((view) => view.agentOAuth.latest(agent.namespaceId, agent.id));
      assert.equal(ready.storageUid, "durable-pvc-uid");
      assert.equal(ready.stagedSecret, null);
      await store.transact((unit) => unit.agentOAuth.delete(agent.namespaceId, agent.id));
      assert.deepEqual(
        await store.read((view) => view.agentOAuth.list(agent.namespaceId, agent.id)),
        [],
      );
    },
  );

  await t.test(
    "reconnect generations keep one Agent connection and preserve superseded cleanup identities",
    async () => {
      const { agent } = await seedOAuthAgent(store);
      const first = oauthAttempt(agent);
      await store.transact((unit) => unit.agentOAuth.create(first));
      const second = oauthAttempt(agent, {
        generation: 2,
        connectionId: first.connectionId,
        profileId: `openai:oce:${agent.id}:2`,
      });
      await assert.rejects(
        store.transact((unit) => unit.agentOAuth.create({ ...second, generation: 3 })),
      );
      await assert.rejects(
        store.transact((unit) =>
          unit.agentOAuth.create({ ...second, connectionId: `aoc_${randomUUID()}` }),
        ),
      );
      await store.transact(async (unit) => {
        await unit.agents.lockAgent(agent.namespaceId, agent.id);
        await unit.agentOAuth.update({
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          generation: 1,
          expectedPhase: "authorizing",
          phase: "superseded",
          updatedAt: first.updatedAt,
        });
        await unit.agentOAuth.create(second);
      });
      assert.deepEqual(
        await store.read((view) => view.agentOAuth.latest(agent.namespaceId, agent.id)),
        second,
      );
      const previous = await store.read((view) =>
        view.agentOAuth.find(agent.namespaceId, agent.id, 1),
      );
      assert.equal(previous.phase, "superseded");
      assert.deepEqual(previous.secretIdentity, first.secretIdentity);
      assert.equal(
        await store.read((view) => view.agentOAuth.latest(`ns_${randomUUID()}`, agent.id)),
        undefined,
      );
      assert.deepEqual(
        await store
          .read((view) => view.agentOAuth.list(agent.namespaceId, agent.id))
          .then((rows) => rows.map(({ generation }) => generation)),
        [1, 2],
      );
      // Failed external work must not expose a partially advanced custody phase.
      await assert.rejects(
        store.transact(async (unit) => {
          await unit.agentOAuth.update({
            namespaceId: agent.namespaceId,
            agentId: agent.id,
            generation: 2,
            expectedPhase: "authorizing",
            phase: "staging",
            updatedAt: second.updatedAt,
          });
          throw new Error("rollback-fixture");
        }),
        /rollback-fixture/,
      );
      assert.equal(
        (await store.read((view) => view.agentOAuth.latest(agent.namespaceId, agent.id))).phase,
        "authorizing",
      );
    },
  );

  await t.test(
    "closed custody shapes reject credential fields and mismatched backend owners",
    async () => {
      const { agent } = await seedOAuthAgent(store);
      const attempt = oauthAttempt(agent);
      await assert.rejects(
        store.transact((unit) =>
          unit.agentOAuth.create({ ...attempt, accessToken: "must-not-persist" }),
        ),
      );
      await assert.rejects(
        store.transact((unit) =>
          unit.agentOAuth.create({
            ...attempt,
            secretIdentity: { ...attempt.secretIdentity, token: "must-not-persist" },
          }),
        ),
      );
      await store.transact((unit) => unit.agentOAuth.create(attempt));
      await store.transact((unit) =>
        unit.agentOAuth.update({
          namespaceId: agent.namespaceId,
          agentId: agent.id,
          generation: 1,
          expectedPhase: "authorizing",
          phase: "staging",
          updatedAt: attempt.updatedAt,
        }),
      );
      for (const secret of [
        { ...stagedSecret(attempt), accessToken: "must-not-persist" },
        { ...stagedSecret(attempt), driverId: "another-driver" },
        { ...stagedSecret(attempt), namespaceId: `ns_${randomUUID()}` },
      ]) {
        await assert.rejects(
          store.transact((unit) =>
            unit.agentOAuth.update({
              namespaceId: agent.namespaceId,
              agentId: agent.id,
              generation: 1,
              expectedPhase: "staging",
              phase: "authenticated",
              stagedSecret: secret,
              updatedAt: attempt.updatedAt,
            }),
          ),
        );
      }
      assert.equal(
        (await store.read((view) => view.agentOAuth.latest(agent.namespaceId, agent.id))).phase,
        "staging",
      );
    },
  );
}
