import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { createAgentOAuthSocketServer } from "../../apps/controller/src/providers/agent-oauth/socket.mjs";
import {
  actor,
  credential,
  fixture as custodyFixture,
  method,
} from "../helpers/agent-oauth-custody.mjs";

const { WebSocket } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "ws",
);
const protocol = "occ.agent-oauth.v1";
const browserMethod = { ...method, methodId: "oauth" };
const instructions = {
  kind: "browser",
  authorizationUrl: "https://auth.openai.com/oauth/authorize?state=private-native-state",
  input: "redirect-url",
};

// The transport, controller, custody and IAM are real. Session authentication,
// audit delivery and the provider itself remain composition-boundary fixtures.
async function fixture(t, { beforeStage, beforeProviderStage, admitWait, auditFailure } = {}) {
  const owner = await custodyFixture({ method: browserMethod, beforeStage });
  owner.advanceTo(new Date().toISOString());
  let authorized = true;
  const audits = [];
  const denials = [];
  const installation = await owner.state.read((view) => view.installations.getInstallation());
  const context = {
    controller: owner.controller,
    actorId: actor,
    async assertAuthorized() {
      if (!authorized) {
        throw new Error(credential.refresh);
      }
    },
    async auditDenial(error) {
      if (error.authorization) {
        denials.push(error.authorization);
      }
    },
    async audit(event, status, writer) {
      await writer.append({
        id: randomUUID(),
        installationId: installation.id,
        namespaceId: owner.namespace.id,
        occurredAt: new Date().toISOString(),
        kind: "mutation",
        actorId: actor,
        action: `openclaw.agents.oauth.${event}`,
        resource: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
        outcome: "success",
      });
      if (event === auditFailure) {
        throw new Error(credential.refresh);
      }
      audits.push({ event, status });
    },
  };
  let inputs = 0;
  const sockets = createAgentOAuthSocketServer({
    async admit(request, scope) {
      assert.equal(scope.namespaceId, owner.namespace.id);
      assert.equal(scope.agentId, owner.agent.id);
      await admitWait?.();
      if (request.headers.authorization !== "Bearer fixture-session") {
        throw new Error(credential.refresh);
      }
      return context;
    },
    async selectMethod({ providerConnectionId }) {
      assert.equal(providerConnectionId, owner.connection.id);
      return {
        method: browserMethod,
        async acquire(options) {
          await options.assertCurrent();
          await options.onInstructions(instructions);
          await options.requestRedirect();
          inputs += 1;
          await beforeProviderStage?.();
          await options.assertCurrent();
          await options.stage({
            ...options.binding,
            profileId: browserMethod.profileId(
              options.binding.connectionId,
              options.binding.generation,
            ),
            credential,
          });
          await options.assertCurrent();
        },
      };
    },
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    void sockets.upgrade(request, socket, head);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await sockets.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/namespaces/${owner.namespace.id}/agents/${owner.agent.id}/oauth/acquire`;
  function connect({
    suffix = "",
    protocols = protocol,
    headers = { authorization: "Bearer fixture-session" },
  } = {}) {
    const socket = new WebSocket(url + suffix, protocols, { headers });
    const messages = [];
    const waiters = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      messages.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.matches(frame)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    });
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.on("error", () => {});
    return {
      socket,
      messages,
      closed,
      wait(matches) {
        const found = messages.find(matches);
        if (found) {
          return Promise.resolve(found);
        }
        return new Promise((resolve) => waiters.push({ matches, resolve }));
      },
      begin() {
        socket.send(
          JSON.stringify({
            type: "begin",
            providerConnectionId: owner.connection.id,
            expectedGeneration: 0,
          }),
        );
      },
      redirect(status) {
        socket.send(
          JSON.stringify({
            type: "redirect-url",
            attemptId: status.attemptId,
            generation: status.generation,
            url: "http://localhost:1455/auth/callback?code=private-code&state=private-native-state",
          }),
        );
      },
    };
  }
  async function begin() {
    const client = connect();
    await once(client.socket, "open");
    client.begin();
    const { status } = await client.wait((frame) => frame.type === "status");
    await client.wait((frame) => frame.type === "instructions");
    return { ...client, status };
  }
  return {
    owner,
    sockets,
    connect,
    begin,
    audits,
    denials,
    inputs: () => inputs,
    revoke: () => {
      authorized = false;
    },
  };
}

test("authenticated OAuth socket privately completes one consent and preserves it after normal close", async (t) => {
  const f = await fixture(t);
  const client = await f.begin();
  assert.equal(client.socket.protocol, protocol);
  assert.equal(client.socket.extensions, "");
  client.redirect(client.status);
  const result = await client.wait(
    (frame) => frame.type === "status" && frame.status.phase === "authenticated",
  );
  await client.closed;
  assert.equal((await f.owner.latest()).phase, "authenticated");
  assert.equal(result.status.providerConnectionId, f.owner.connection.id);
  assert.deepEqual(
    f.audits.map(({ event }) => event),
    ["begin", "complete"],
  );
  const attempt = await f.owner.latest();
  assert.deepEqual(
    JSON.parse(f.owner.storage.valueFor(attempt.secretIdentity)).credential,
    credential,
  );
  for (const secret of [
    credential.access,
    credential.refresh,
    credential.idToken,
    "private-code",
  ]) {
    assert.equal(
      JSON.stringify({ frames: client.messages, audits: f.audits }).includes(secret),
      false,
    );
  }
});

test("socket upgrades reject missing authentication, queries and other subprotocols before consent", async (t) => {
  const f = await fixture(t);
  for (const options of [{ headers: {} }, { suffix: "?attempt=ignored" }, { protocols: "other" }]) {
    const client = f.connect(options);
    await client.closed;
    assert.equal(client.messages.length, 0);
  }
  assert.equal(await f.owner.latest(), undefined);
});

test("provider permission denials retain their exact authorization for the audit owner", async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await once(client.socket, "open");
  f.owner.iamState.bindings = f.owner.iamState.bindings.filter(
    ({ roleId }) => roleId !== "oauth-operator",
  );
  client.begin();
  await client.closed;
  assert.ok(
    f.denials.some(
      ({ action, resource }) =>
        action === "operate" &&
        resource.kind === "provider_connection" &&
        resource.id === f.owner.connection.id,
    ),
  );
  assert.equal(await f.owner.latest(), undefined);
  assert.deepEqual(client.messages, [{ type: "error", code: "AUTHORIZATION_LOST" }]);
});

test("socket disconnect during admission cannot create an OAuth attempt", async (t) => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture(t, {
    admitWait: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const client = f.connect();
  await entered.promise;
  client.socket.terminate();
  await client.closed;
  resumed.resolve();
  await f.sockets.close();
  assert.equal(await f.owner.latest(), undefined);
});

test("socket disconnect and explicit cancel close pending browser input without staging", async (t) => {
  for (const action of ["disconnect", "cancel"]) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      const client = await f.begin();
      if (action === "disconnect") {
        client.socket.close();
      } else {
        client.socket.send(
          JSON.stringify({
            type: "cancel",
            attemptId: client.status.attemptId,
            generation: client.status.generation,
          }),
        );
      }
      await client.closed;
      await f.sockets.close();
      assert.equal((await f.owner.latest()).phase, "cancelled");
      assert.equal(f.owner.stageCalls(), 0);
      assert.equal(f.inputs(), 0);
      assert.equal(f.audits.at(-1).event, action === "cancel" ? "cancel" : "interrupted");
    });
  }
});

test("socket rejects binary, oversized, duplicate begin and stale redirect frames", async (t) => {
  for (const action of ["binary", "oversized", "duplicate", "stale", "extra"]) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      const client = await f.begin();
      if (action === "binary") {
        client.socket.send(Buffer.from("{}"));
      } else if (action === "oversized") {
        client.socket.send("x".repeat(16_385));
      } else if (action === "duplicate") {
        client.begin();
      } else if (action === "extra") {
        client.socket.send(
          JSON.stringify({
            type: "cancel",
            attemptId: client.status.attemptId,
            generation: 1,
            token: credential.refresh,
          }),
        );
      } else {
        client.redirect({ ...client.status, generation: 2 });
      }
      await client.closed;
      await f.sockets.close();
      assert.equal((await f.owner.latest()).phase, "cancelled");
      assert.equal(f.owner.stageCalls(), 0);
      assert.equal(JSON.stringify(client.messages).includes(credential.refresh), false);
    });
  }
});

test("session revocation while a provider is waiting rejects its late completion", async (t) => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture(t, {
    beforeProviderStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const client = await f.begin();
  client.redirect(client.status);
  await entered.promise;
  f.revoke();
  resumed.resolve();
  await client.closed;
  assert.equal(f.owner.stageCalls(), 0);
  assert.equal((await f.owner.latest()).phase, "cancelled");
  assert.ok(client.messages.some((frame) => frame.code === "AUTHORIZATION_LOST"));
});

test("duplicate browser input aborts the exact attempt before late provider completion", async (t) => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture(t, {
    beforeProviderStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const client = await f.begin();
  client.redirect(client.status);
  await entered.promise;
  client.redirect(client.status);
  await client.wait((frame) => frame.type === "error" && frame.code === "INVALID_REQUEST");
  resumed.resolve();
  await client.closed;
  assert.equal(f.inputs(), 1);
  assert.equal(f.owner.stageCalls(), 0);
  assert.equal((await f.owner.latest()).phase, "cancelled");
});

test("socket shutdown drains a pending Secret write before exposing cancellation", async (t) => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture(t, {
    beforeStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const client = await f.begin();
  client.redirect(client.status);
  await entered.promise;
  const shutdown = f.sockets.close();
  resumed.resolve();
  await shutdown;
  const attempt = await f.owner.latest();
  assert.equal(attempt.phase, "cancelled");
  assert.equal(attempt.stagedSecret, null);
  assert.equal(f.owner.storage.has(attempt.secretIdentity), true);
  assert.equal(
    client.messages.some((frame) => frame.status?.phase === "authenticated"),
    false,
  );
});

test("audit failure rolls back begin or prevents a completed socket from reporting success", async (t) => {
  for (const event of ["begin", "complete"]) {
    await t.test(event, async (t) => {
      const f = await fixture(t, { auditFailure: event });
      const client = f.connect();
      await once(client.socket, "open");
      client.begin();
      if (event === "complete") {
        const { status } = await client.wait((frame) => frame.type === "status");
        await client.wait((frame) => frame.type === "instructions");
        client.redirect(status);
      }
      await client.closed;
      assert.equal((await f.owner.latest())?.phase, event === "begin" ? undefined : "cancelled");
      const audit = await f.owner.controller.transact((unit) => unit.audit.list());
      assert.equal(
        audit.some((entry) => entry.action === `openclaw.agents.oauth.${event}`),
        false,
      );
      assert.equal(
        client.messages.some((frame) => frame.status?.phase === "authenticated"),
        false,
      );
    });
  }
});

test("session revocation during a Secret write rolls back authentication before interruption", async (t) => {
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const f = await fixture(t, {
    beforeStage: () => {
      entered.resolve();
      return resumed.promise;
    },
  });
  const client = await f.begin();
  client.redirect(client.status);
  await entered.promise;
  f.revoke();
  resumed.resolve();
  await client.closed;
  const attempt = await f.owner.latest();
  assert.equal(attempt.phase, "cancelled");
  assert.equal(attempt.stagedSecret, null);
  assert.equal(f.owner.storage.has(attempt.secretIdentity), true);
  assert.equal(
    client.messages.some((frame) => frame.status?.phase === "authenticated"),
    false,
  );
});

test(
  "periodic authority checks interrupt an otherwise idle revoked session",
  { timeout: 12_000 },
  async (t) => {
    const f = await fixture(t);
    const client = await f.begin();
    f.revoke();
    await client.closed;
    assert.equal((await f.owner.latest()).phase, "cancelled");
    assert.equal(f.owner.stageCalls(), 0);
  },
);

test(
  "an idle socket expires its first-message deadline without creating consent",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const client = f.connect();
    await once(client.socket, "open");
    await client.closed;
    assert.deepEqual(client.messages, [{ type: "error", code: "TIMEOUT" }]);
    assert.equal(await f.owner.latest(), undefined);
  },
);
