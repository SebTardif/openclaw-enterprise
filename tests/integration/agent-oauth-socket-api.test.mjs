import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const { WebSocket } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "ws",
);

function messages(socket) {
  const pending = [];
  const ready = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString());
    const resolve = pending.shift();
    if (resolve) {
      resolve(value);
    } else {
      ready.push(value);
    }
  });
  return () =>
    ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => pending.push(resolve));
}

test(
  "OAuth socket admits the exact session and Agent, retains consent before deployment, and rejects cross-origin upgrades",
  { timeout: 20_000 },
  async (t) => {
    const auditSink = new InMemoryAuditSink();
    const storage = createTestSecretDriver();
    const references = new Map();
    const secretDriver = {
      ...storage,
      async stage(identity, value) {
        const reference = await storage.create(identity, value);
        references.set(identity.id, reference);
        return reference;
      },
      async findStaged(identity) {
        return references.get(identity.id);
      },
    };
    let acquisitions = 0;
    const redirect =
      "http://localhost:1455/auth/callback?code=private-api-fixture&state=private-state";
    // Simulate only the provider boundary: real Fastify upgrades, Better Auth,
    // IAM, selected pco, custody transactions, private staging, and status HTTP run.
    const fixture = await createConsoleAppFixture(t, {
      auditSink,
      publicOrigin: true,
      secretDriver,
      agentOAuthMethods: [
        {
          providerId: "openai",
          methodId: "oauth",
          async acquire({ binding, assertCurrent, onInstructions, requestRedirect, stage }) {
            acquisitions++;
            await assertCurrent();
            await onInstructions({
              kind: "browser",
              authorizationUrl: "https://auth.openai.com/oauth/authorize?state=private-state",
              input: "redirect-url",
            });
            assert.equal(await requestRedirect(), redirect);
            await assertCurrent();
            await stage({
              ...binding,
              profileId: `openai:oce:${binding.connectionId}:g${binding.generation}`,
              credential: {
                type: "oauth",
                provider: "openai",
                access: "synthetic-api-access",
                refresh: "synthetic-api-refresh",
                expires: Date.now() + 60_000,
              },
            });
          },
        },
      ],
    });
    await fixture.bootstrap();
    const session = await fixture.signIn(fixture.credentials);
    const namespace = await fixture.createNamespace("OAuth socket", { ready: true });
    const connection = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/provider-connections`,
      {
        body: { name: "Browser login", providerId: "openai", authMethodId: "oauth" },
      },
    );
    assert.equal(connection.status, 201);
    const agent = await fixture.createAgent(
      namespace.id,
      "Before deployment",
      createHarnessConfiguration("openclaw", "gpt-4.1"),
      {
        harnessAuth: { method: "provider_connection", connectionId: connection.data.id },
      },
    );
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/oauth`;
    const url = fixture.origin.replace(/^http/, "ws") + path + "/acquire";
    const rejected = new WebSocket(url, "occ.agent-oauth.v1", {
      headers: { cookie: session.cookie, origin: "https://foreign.example" },
    });
    rejected.on("error", () => {});
    await new Promise((resolve) => rejected.once("close", resolve));
    assert.equal(acquisitions, 0);
    assert.equal((await fixture.request("GET", path)).data, null);

    const socket = new WebSocket(url, "occ.agent-oauth.v1", {
      headers: { cookie: session.cookie, origin: fixture.origin },
    });
    const next = messages(socket);
    t.after(() => socket.terminate());
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "begin",
        providerConnectionId: connection.data.id,
        expectedGeneration: 0,
      }),
    );
    const begun = await next();
    assert.equal(begun.type, "status");
    assert.equal(begun.status.phase, "authorizing");
    assert.equal((await next()).type, "instructions");
    socket.send(
      JSON.stringify({
        type: "redirect-url",
        attemptId: begun.status.attemptId,
        generation: begun.status.generation,
        url: redirect,
      }),
    );
    const completed = await next();
    assert.equal(completed.type, "status");
    assert.equal(completed.status.phase, "authenticated");
    const persisted = await fixture.request("GET", path);
    assert.equal(persisted.data.phase, "authenticated");
    assert.equal(acquisitions, 1);
    assert.doesNotMatch(
      JSON.stringify(persisted.body),
      /synthetic-api|private-api|private-state|backendRef/,
    );
    const resource = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
    assert.deepEqual(resource.data.harnessAuth, {
      method: "provider_connection",
      connectionId: connection.data.id,
    });
    assert.equal(resource.data.desiredRuntimeState, "stopped");

    // Revoking the same authenticated session during consent must prevent the
    // subsequent private redirect from reaching custody, even before the timer checks it.
    const interrupted = new WebSocket(url, "occ.agent-oauth.v1", {
      headers: { cookie: session.cookie, origin: fixture.origin },
    });
    const nextInterrupted = messages(interrupted);
    t.after(() => interrupted.terminate());
    await once(interrupted, "open");
    interrupted.send(
      JSON.stringify({
        type: "begin",
        providerConnectionId: connection.data.id,
        expectedGeneration: 1,
      }),
    );
    const second = await nextInterrupted();
    assert.equal(second.status.generation, 2);
    assert.equal((await nextInterrupted()).type, "instructions");
    const signedOut = await fixture.request("POST", "/api/auth/sign-out", { session });
    assert.equal(signedOut.status, 200);
    const closed = once(interrupted, "close");
    interrupted.send(
      JSON.stringify({
        type: "redirect-url",
        attemptId: second.status.attemptId,
        generation: 2,
        url: redirect,
      }),
    );
    assert.deepEqual(await nextInterrupted(), { type: "error", code: "AUTHORIZATION_LOST" });
    await closed;
    assert.equal(storage.calls.filter((call) => call.operation === "create").length, 1);
    const freshSession = await fixture.signIn(fixture.credentials);
    const afterInterruption = await fixture.request("GET", path, { session: freshSession });
    assert.equal(afterInterruption.data.phase, "cancelled");

    fixture.policy.roles[0].permissions = fixture.policy.roles[0].permissions.filter(
      (permission) =>
        !(permission.action === "operate" && permission.resourceKind === "provider_connection"),
    );
    const denied = new WebSocket(url, "occ.agent-oauth.v1", {
      headers: { cookie: freshSession.cookie, origin: fixture.origin },
    });
    const nextDenied = messages(denied);
    t.after(() => denied.terminate());
    await once(denied, "open");
    denied.send(
      JSON.stringify({
        type: "begin",
        providerConnectionId: connection.data.id,
        expectedGeneration: 2,
      }),
    );
    assert.deepEqual(await nextDenied(), { type: "error", code: "AUTHORIZATION_LOST" });
    const denials = auditSink.events.filter(
      (event) => event.kind === "authorization_denial" && event.resource.id === connection.data.id,
    );
    assert.equal(denials.length, 1);
    assert.equal(denials[0].authorization.action, "operate");
    assert.doesNotMatch(
      JSON.stringify(auditSink.events),
      /synthetic-api|private-api|private-state/,
    );
  },
);
