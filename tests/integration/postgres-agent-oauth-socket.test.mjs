import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import pg from "pg";

import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { ensureInstallation } from "../helpers/postgres-provider-state.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const { WebSocket } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "ws",
);
const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "PostgreSQL OAuth socket recovers a lost staging acknowledgment and commits audit with one pool connection",
  {
    skip: databaseUrl ? false : "Set OCC_TEST_DATABASE_URL to a disposable migrated database.",
    timeout: 20_000,
  },
  async (t) => {
    // A nested global auditSink transaction must fail this flow rather than wait
    // forever for the only connection already held by the custody transaction.
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
    });
    const state = new PostgresPlatformState(pool);
    const installation = await ensureInstallation(state, "oauth-socket");
    const storage = createTestSecretDriver();
    const references = new Map();
    const acquisitions = [];
    let loseStageAcknowledgment = true;
    // Native auth/IAM use the fixture backing; custody and mutation auditing
    // share the real PostgreSQL pool, including the lost-ack recovery branch.
    const fixture = await createConsoleAppFixture(t, {
      installation,
      state,
      auditSink: state.auditSink,
      publicOrigin: true,
      providers: [],
      secretDriver: {
        ...storage,
        async stage(identity, value) {
          const reference = await storage.create(identity, value);
          references.set(identity.id, reference);
          // The backend write commits, but its response is lost. The same live
          // consent must recover its identity without another provider login.
          if (loseStageAcknowledgment) {
            loseStageAcknowledgment = false;
            throw new Error("private-pg-backend-acknowledgment-lost");
          }
          return reference;
        },
        async findStaged(identity) {
          return references.get(identity.id);
        },
      },
      agentOAuthMethods: [
        {
          providerId: "openai",
          methodId: "oauth",
          async acquire({ binding, onInstructions, requestRedirect, stage }) {
            acquisitions.push(binding.generation);
            await onInstructions({
              kind: "browser",
              authorizationUrl: "https://auth.openai.com/oauth/authorize?state=private-pg-state",
              input: "redirect-url",
            });
            await requestRedirect();
            await stage({
              ...binding,
              profileId: `openai:oce:${binding.connectionId}:g${binding.generation}`,
              credential: {
                type: "oauth",
                provider: "openai",
                access: "synthetic-pg-access",
                refresh: "synthetic-pg-refresh",
                expires: Date.now() + 60_000,
              },
            });
          },
        },
      ],
    });
    t.after(async () => {
      await fixture.app.close();
      await pool.end();
    });
    const namespace = await fixture.createNamespace(`OAuth socket ${randomUUID()}`, {
      ready: true,
    });
    const selected = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/provider-connections`,
      {
        body: { name: "OAuth", providerId: "openai", authMethodId: "oauth" },
      },
    );
    assert.equal(selected.status, 201);
    const agent = await fixture.createAgent(
      namespace.id,
      "Before deployment",
      createHarnessConfiguration("openclaw", "gpt-4.1"),
      {
        harnessAuth: { method: "provider_connection", connectionId: selected.data.id },
      },
    );
    const session = await fixture.signIn(fixture.credentials);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}/oauth`;
    async function begin(expectedGeneration) {
      const socket = new WebSocket(
        fixture.origin.replace(/^http/, "ws") + path + "/acquire",
        "occ.agent-oauth.v1",
        {
          headers: { cookie: session.cookie, origin: fixture.origin },
        },
      );
      const frames = [];
      const waiters = [];
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString());
        const resolve = waiters.shift();
        if (resolve) {
          resolve(value);
        } else {
          frames.push(value);
        }
      });
      const next = () =>
        frames.length
          ? Promise.resolve(frames.shift())
          : new Promise((resolve) => waiters.push(resolve));
      t.after(() => socket.terminate());
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "begin",
          providerConnectionId: selected.data.id,
          expectedGeneration,
        }),
      );
      const begun = await next();
      assert.equal(begun.type, "status", JSON.stringify(begun));
      assert.equal(begun.status.phase, "authorizing");
      assert.equal((await next()).type, "instructions");
      return { socket, next, status: begun.status };
    }
    const first = await begin(0);
    const closed = once(first.socket, "close");
    first.socket.send(
      JSON.stringify({
        type: "cancel",
        attemptId: first.status.attemptId,
        generation: first.status.generation,
      }),
    );
    const cancelled = await first.next();
    assert.equal(cancelled.type, "status");
    assert.equal(cancelled.status.phase, "cancelled");
    await closed;
    assert.equal((await fixture.request("GET", path)).data.phase, "cancelled");

    const second = await begin(1);
    const completed = once(second.socket, "close");
    second.socket.send(
      JSON.stringify({
        type: "redirect-url",
        attemptId: second.status.attemptId,
        generation: second.status.generation,
        url: "http://localhost:1455/auth/callback?code=private-pg-code&state=private-pg-state",
      }),
    );
    const recovered = await second.next();
    assert.equal(recovered.type, "status", JSON.stringify(recovered));
    assert.deepEqual(recovered.status, { ...second.status, phase: "authenticated" });
    await completed;
    assert.deepEqual((await fixture.request("GET", path)).data, recovered.status);
    assert.deepEqual(acquisitions, [1, 2], "recovery must not start consent again");
    const response = await fixture.request(
      "POST",
      `${path}/attempts/${second.status.attemptId}/cancel`,
      {
        headers: { origin: fixture.origin },
        body: { connectionId: second.status.connectionId, generation: second.status.generation },
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.data.phase, "cancelled");
    const attempts = await state.read((view) => view.agentOAuth.list(namespace.id, agent.id));
    assert.deepEqual(
      attempts.map((attempt) => attempt.phase),
      ["cancelled", "cancelled"],
    );
    assert.equal(storage.calls.filter((call) => call.operation === "create").length, 1);
    assert.deepEqual(
      attempts[1].stagedSecret.backendRef,
      references.get(attempts[1].secretIdentity.id),
    );
    const audit = await pool.query(
      "SELECT action, details FROM occ.audit_events WHERE resource_id=$1 AND action LIKE 'openclaw.agents.oauth.%' ORDER BY occurred_at, id",
      [agent.id],
    );
    assert.deepEqual(
      audit.rows.map((event) => event.action),
      [
        "openclaw.agents.oauth.begin",
        "openclaw.agents.oauth.cancel",
        "openclaw.agents.oauth.begin",
        "openclaw.agents.oauth.complete",
        "openclaw.agents.oauth.cancel",
      ],
    );
    assert.doesNotMatch(
      JSON.stringify([response.body, audit.rows]),
      /synthetic-pg|private-pg|backendRef|secretIdentity/,
    );
  },
);
