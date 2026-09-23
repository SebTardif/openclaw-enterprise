import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createNativeOAuthAcquisition } from "../../apps/controller/src/providers/agent-oauth/native-acquisition.mjs";
import { acquireAgentOAuth } from "../../apps/controller/src/providers/agent-oauth/acquire.ts";
import {
  actor,
  method as deviceMethod,
  fixture as custodyFixture,
} from "../helpers/agent-oauth-custody.mjs";

const binding = {
  provider: "openai",
  method: "device-code",
  connectionId: "aoc_00000000-0000-4000-8000-000000000001",
  generation: 1,
};
const credential = {
  type: "oauth",
  provider: "openai",
  access: "fixture-private-access",
  refresh: "fixture-private-refresh",
  expires: 2_000_000_000_000,
  idToken: "fixture-private-id-token",
  clientId: "fixture-client",
  accountId: "fixture-account",
  authFlow: "device-code",
  email: "fixture@example.test",
};
const browserUrl = new URL("https://auth.openai.com/oauth/authorize");
browserUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: "fixture-native-client",
  redirect_uri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  code_challenge: "A".repeat(43),
  code_challenge_method: "S256",
  state: "0123456789abcdef0123456789abcdef",
  originator: "openclaw",
}).toString();
function browserRedirect(authorizationUrl = browserUrl.href) {
  const authorize = new URL(authorizationUrl);
  const redirect = new URL(authorize.searchParams.get("redirect_uri"));
  redirect.searchParams.set("code", "fixture-private-authorization-code");
  redirect.searchParams.set("state", authorize.searchParams.get("state"));
  return redirect.href;
}

// These fixtures substitute only the native SDK boundary. The real fork, IPC,
// environment isolation, authority callbacks and cleanup are under test; this
// does not prove native provider login, SQLite persistence or image qualification.
function fixture(
  t,
  {
    method = "device-code",
    url = method === "oauth" ? browserUrl.href : "https://auth.openai.com/codex/device",
    provider = "openai",
    nativeFailure = false,
    nativeCallback = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "oce-acquisition-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observation = join(root, "observation.json");
  const persisted = join(root, "persisted");
  const beforePersist = join(root, "before-persist");
  const managedLoginModulePath = join(root, "provider-auth-managed-login-runtime.mjs");
  const providerAuthModulePath = join(root, "provider-auth.mjs");
  writeFileSync(
    managedLoginModulePath,
    `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import { setFixtureProfile } from "./provider-auth.mjs";
    export const MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY = "openclaw.models.auth.managed.v1";
    export async function runManagedModelsAuthLoginFlow(opts) {
      assert.equal(opts.managed.capability, MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY);
      assert.equal(opts.isRemote, true);
      assert.equal(opts.env.HOME, process.env.HOME);
      assert.equal(opts.env.OPENCLAW_STATE_DIR, opts.managed.stateDir);
      assert.equal(opts.env.OPENCLAW_AGENT_DIR, opts.managed.stateDir + "/agents/main/agent");
      assert.equal(process.env.OPENAI_API_KEY, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ pid: process.pid, home: process.env.HOME, cwd: process.cwd(), env: process.env }));
      if (${nativeFailure}) { throw new Error(${JSON.stringify(credential.refresh)}); }
      await opts.openUrl(${JSON.stringify(url)});
      if (opts.method === "oauth") {
        const input = opts.prompter.text({ message: "Paste callback", sensitive: true });
        if (${nativeCallback}) {
          // Native's own loopback callback may win its manual-input race.
          void input.catch(() => {});
        } else {
          assert.equal(await input, ${JSON.stringify(browserRedirect())});
        }
      } else {
        await opts.prompter.deviceCode({ code: "ABCD-1234", expiresInMinutes: 15, message: ${JSON.stringify(credential.access)} });
      }
      writeFileSync(${JSON.stringify(beforePersist)}, "requested");
      await opts.managed.beforePersist();
      opts.managed.assertCurrent();
      writeFileSync(${JSON.stringify(persisted)}, "yes");
      setFixtureProfile(opts.managed.profileId);
      return { providerId: ${JSON.stringify(provider)}, methodId: opts.method,
        profiles: [{ profileId: opts.managed.profileId, provider: ${JSON.stringify(provider)}, mode: "oauth" }] };
    }
  `,
  );
  writeFileSync(
    providerAuthModulePath,
    `
    let profileId;
    export function setFixtureProfile(selected) { profileId = selected; }
    export async function updateAuthProfileStoreWithLock({ updater }) {
      const store = { profiles: { [profileId]: ${JSON.stringify(credential)} } };
      updater(store);
      return store;
    }
  `,
  );
  const acquire = createNativeOAuthAcquisition({ managedLoginModulePath, providerAuthModulePath });
  const controller = new AbortController();
  const run = (overrides = {}) =>
    acquire({
      binding: { ...binding, method },
      signal: controller.signal,
      assertCurrent() {},
      async onInstructions() {},
      async stage() {},
      ...overrides,
    });
  return { root, controller, observation, persisted, beforePersist, run, acquire };
}

test("acquisition isolates native home and exposes only device instructions before privately staging the full profile", async (t) => {
  const f = fixture(t);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-controller-key";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  });
  let instructions;
  let staged;
  assert.equal(
    await f.run({
      async onInstructions(value) {
        instructions = value;
      },
      async stage(value) {
        staged = value;
        assert.equal(existsSync(f.persisted), true);
      },
    }),
    undefined,
  );
  assert.deepEqual(instructions, {
    kind: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    expiresInMinutes: 15,
  });
  assert.deepEqual(staged, {
    ...binding,
    profileId: `openai:oce:${binding.connectionId}:g1`,
    credential,
  });
  const observed = JSON.parse(readFileSync(f.observation, "utf8"));
  assert.equal(observed.home, observed.cwd);
  assert.notEqual(observed.home, process.env.HOME);
  assert.equal(existsSync(observed.home), false);
  for (const key of [
    "CODEX_HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_CONFIG_PATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
  ]) {
    assert.ok(
      observed.env[key] === observed.home || observed.env[key].startsWith(`${observed.home}/`),
    );
  }
});

test("acquisition rechecks authority at native beforePersist and cleans its temporary home on rejection", async (t) => {
  const f = fixture(t);
  let staged = false;
  await assert.rejects(
    f.run({
      assertCurrent() {
        if (existsSync(f.beforePersist)) {
          throw new Error(credential.refresh);
        }
      },
      async stage() {
        staged = true;
      },
    }),
    { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
  );
  assert.equal(staged, false);
  assert.equal(existsSync(f.beforePersist), true);
  assert.equal(existsSync(f.persisted), false);
  assert.equal(existsSync(JSON.parse(readFileSync(f.observation, "utf8")).home), false);
});

test("acquisition cancellation interrupts a waiting native process without staging", async (t) => {
  const f = fixture(t);
  let staged = false;
  await assert.rejects(
    f.run({
      async onInstructions() {
        f.controller.abort(new Error(credential.access));
      },
      async stage() {
        staged = true;
      },
    }),
    { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
  );
  assert.equal(staged, false);
  assert.equal(existsSync(f.persisted), false);
  assert.equal(existsSync(JSON.parse(readFileSync(f.observation, "utf8")).home), false);
});

test("acquisition never forwards native failures, arbitrary URLs or a differently qualified profile", async (t) => {
  for (const scenario of [
    { nativeFailure: true },
    { url: `https://auth.openai.com/codex/device?token=${credential.access}` },
    { provider: "other" },
  ]) {
    const f = fixture(t, scenario);
    let staged = false;
    await assert.rejects(
      f.run({
        async stage() {
          staged = true;
        },
      }),
      { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
    );
    assert.equal(staged, false);
    assert.equal(existsSync(JSON.parse(readFileSync(f.observation, "utf8")).home), false);
  }
});

test("acquisition checks authority after private staging before acknowledging completion", async (t) => {
  const f = fixture(t);
  let current = true;
  let stages = 0;
  await assert.rejects(
    f.run({
      assertCurrent() {
        if (!current) {
          throw new Error(credential.refresh);
        }
      },
      async stage() {
        stages += 1;
        current = false;
      },
    }),
    { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
  );
  assert.equal(stages, 1);
  assert.equal(existsSync(JSON.parse(readFileSync(f.observation, "utf8")).home), false);
});

test(
  "a native process exit fences an authority check already awaiting before staging",
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t);
    let reached;
    const waiting = new Promise((resolve) => {
      reached = resolve;
    });
    let resume;
    const released = new Promise((resolve) => {
      resume = resolve;
    });
    let staged = false;
    const failed = assert.rejects(
      f.run({
        async assertCurrent() {
          if (existsSync(f.persisted)) {
            reached();
            await released;
          }
        },
        async stage() {
          staged = true;
        },
      }),
      { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
    );
    await waiting;
    process.kill(JSON.parse(readFileSync(f.observation, "utf8")).pid, "SIGKILL");
    await failed;
    resume();
    await setImmediate();
    assert.equal(staged, false);
  },
);

test("controller composition authenticates the draft Agent from native acquisition with complete private custody", async (t) => {
  const native = fixture(t);
  const owner = await custodyFixture();
  owner.advanceTo(new Date().toISOString());
  const selected = await owner.begin();
  let instructions;
  const authenticated = await acquireAgentOAuth({
    controller: owner.controller,
    actorId: actor,
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
    selected,
    acquire: native.acquire,
    signal: native.controller.signal,
    async onInstructions(value) {
      instructions = value;
    },
  });
  const attempt = await owner.latest();
  assert.equal(authenticated.phase, "authenticated");
  assert.deepEqual(
    await owner.custody.get(actor, owner.namespace.id, owner.agent.id),
    authenticated,
  );
  assert.deepEqual(JSON.parse(owner.storage.valueFor(attempt.secretIdentity)), {
    provider: "openai",
    method: "device-code",
    connectionId: selected.connectionId,
    generation: selected.generation,
    profileId: selected.profileId,
    credential,
  });
  assert.deepEqual(instructions, {
    kind: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    expiresInMinutes: 15,
  });
  const persisted = await owner.controller.transact(async (view) => ({
    agent: await view.agents.findAgent(owner.namespace.id, owner.agent.id),
    revisions: await view.revisions.listRevisions(owner.namespace.id, owner.agent.id),
    ordinarySecret: await view.secrets.findSecret(owner.namespace.id, attempt.secretIdentity.id),
    audit: await view.audit.list(),
    operations: await view.operations.list(),
  }));
  assert.deepEqual(persisted.revisions, []);
  assert.equal(persisted.ordinarySecret, undefined);
  assert.equal(owner.stageCalls(), 1);
  for (const secret of [
    credential.access,
    credential.refresh,
    credential.idToken,
    credential.accountId,
    credential.email,
  ]) {
    assert.equal(
      JSON.stringify({ authenticated, instructions, attempt, persisted }).includes(secret),
      false,
    );
  }
});

test("controller composition records native acquisition failure without staging or exposing its error", async (t) => {
  const native = fixture(t, { nativeFailure: true });
  const owner = await custodyFixture();
  owner.advanceTo(new Date().toISOString());
  const selected = await owner.begin();
  let challenges = 0;
  await assert.rejects(
    acquireAgentOAuth({
      controller: owner.controller,
      actorId: actor,
      namespaceId: owner.namespace.id,
      agentId: owner.agent.id,
      selected,
      acquire: native.acquire,
      signal: native.controller.signal,
      async onInstructions() {
        challenges += 1;
      },
    }),
    { message: "OAuth did not complete. Check the connection status before retrying." },
  );
  const status = await owner.custody.get(actor, owner.namespace.id, owner.agent.id);
  assert.equal(status.phase, "reconnect_required");
  assert.equal(status.failureCode, "OAUTH_FAILED");
  assert.equal(owner.stageCalls(), 0);
  assert.equal(challenges, 0);
  assert.equal((await owner.latest()).stagedSecret, null);
});

test("controller composition drains an aborted custody write and cleans its uncertain Secret without late authentication", async (t) => {
  const native = fixture(t);
  const entered = Promise.withResolvers();
  const resumed = Promise.withResolvers();
  const owner = await custodyFixture({
    beforeStage: async () => {
      entered.resolve();
      await resumed.promise;
    },
  });
  owner.advanceTo(new Date().toISOString());
  const selected = await owner.begin();
  let settled = false;
  const acquisition = acquireAgentOAuth({
    controller: owner.controller,
    actorId: actor,
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
    selected,
    acquire: native.acquire,
    signal: native.controller.signal,
    async onInstructions() {},
  }).finally(() => {
    settled = true;
  });
  const rejected = assert.rejects(acquisition, {
    message: "OAuth did not complete. Check the connection status before retrying.",
  });
  await entered.promise;
  native.controller.abort();
  await setImmediate();
  assert.equal(settled, false);
  resumed.resolve();
  await rejected;
  const attempt = await owner.latest();
  assert.equal(attempt.phase, "cancelled");
  assert.equal(attempt.stagedSecret, null);
  // The external create completed after cancellation; its durable intent remains
  // recoverable for cleanup, while the transaction never publishes authentication.
  assert.equal(owner.storage.has(attempt.secretIdentity), true);
  await owner.custody.cleanup(actor, owner.namespace.id, owner.agent.id);
  assert.equal(owner.storage.has(attempt.secretIdentity), false);
  assert.equal((await owner.latest()).phase, "cancelled");
});

test("browser login completes through the controller with a private state-bound redirect and complete native profile", async (t) => {
  const native = fixture(t, { method: "oauth" });
  const owner = await custodyFixture({ method: { ...deviceMethod, methodId: "oauth" } });
  owner.advanceTo(new Date().toISOString());
  const selected = await owner.begin();
  let instructions;
  const authenticated = await acquireAgentOAuth({
    controller: owner.controller,
    actorId: actor,
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
    selected,
    acquire: native.acquire,
    signal: native.controller.signal,
    async onInstructions(value) {
      instructions = value;
    },
    async requestRedirect() {
      assert.deepEqual(instructions, {
        kind: "browser",
        authorizationUrl: browserUrl.href,
        input: "redirect-url",
      });
      return browserRedirect(instructions.authorizationUrl);
    },
  });
  const attempt = await owner.latest();
  const bundle = JSON.parse(owner.storage.valueFor(attempt.secretIdentity));
  assert.equal(authenticated.phase, "authenticated");
  assert.equal(authenticated.methodId, "oauth");
  assert.deepEqual(bundle, {
    provider: "openai",
    method: "oauth",
    connectionId: selected.connectionId,
    generation: selected.generation,
    profileId: selected.profileId,
    credential,
  });
  const persisted = await owner.controller.transact(async (view) => ({
    agent: await view.agents.findAgent(owner.namespace.id, owner.agent.id),
    audit: await view.audit.list(),
    operations: await view.operations.list(),
  }));
  for (const secret of [
    credential.access,
    credential.refresh,
    credential.idToken,
    "fixture-private-authorization-code",
  ]) {
    assert.equal(
      JSON.stringify({ instructions, authenticated, attempt, persisted }).includes(secret),
      false,
    );
  }
  assert.equal(JSON.stringify(bundle).includes("fixture-private-authorization-code"), false);
});

test("browser input rejects bare codes, unbound redirects, duplicate parameters and provider errors before native persistence", async (t) => {
  const valid = browserRedirect();
  const wrongState = new URL(valid);
  wrongState.searchParams.set("state", "another-attempt");
  const missingState = new URL(valid);
  missingState.searchParams.delete("state");
  for (const input of [
    "fixture-private-authorization-code",
    missingState.href,
    wrongState.href,
    valid.replace("localhost:1455", "foreign.example.test"),
    valid.replace("/auth/callback", "/other"),
    `${valid}&state=another-attempt`,
    `${valid}&code=another-code`,
    `${valid}&error=access_denied`,
    `${valid}#fragment`,
  ]) {
    const f = fixture(t, { method: "oauth" });
    let stages = 0;
    await assert.rejects(
      f.run({
        async requestRedirect() {
          return input;
        },
        async stage() {
          stages += 1;
        },
      }),
      { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
    );
    assert.equal(stages, 0);
    assert.equal(existsSync(f.beforePersist), false);
  }
});

test("browser authorization instructions require the native state, PKCE and callback destination", async (t) => {
  for (const [key, value] of [
    ["state", ""],
    ["code_challenge_method", "plain"],
    ["redirect_uri", "https://foreign.example.test/callback"],
    ["access_token", credential.access],
  ]) {
    const url = new URL(browserUrl);
    url.searchParams.set(key, value);
    const f = fixture(t, { method: "oauth", url: url.href });
    let instructions = 0;
    await assert.rejects(
      f.run({
        async onInstructions() {
          instructions += 1;
        },
        async requestRedirect() {
          return browserRedirect();
        },
      }),
      { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
    );
    assert.equal(instructions, 0);
    assert.equal(existsSync(f.beforePersist), false);
  }
});

test("cancellation fences a browser redirect submitted after the private prompt was opened", async (t) => {
  const f = fixture(t, { method: "oauth" });
  const entered = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  let stages = 0;
  const rejected = assert.rejects(
    f.run({
      async requestRedirect() {
        entered.resolve();
        return submitted.promise;
      },
      async stage() {
        stages += 1;
      },
    }),
    { message: "NATIVE_OAUTH_ACQUISITION_FAILED" },
  );
  await entered.promise;
  f.controller.abort();
  await rejected;
  submitted.resolve(browserRedirect());
  await setImmediate();
  assert.equal(stages, 0);
  assert.equal(existsSync(f.beforePersist), false);
});

test(
  "native completion can settle while its manual browser prompt remains pending",
  { timeout: 5_000 },
  async (t) => {
    const f = fixture(t, { method: "oauth", nativeCallback: true });
    const submitted = Promise.withResolvers();
    let stages = 0;
    await f.run({
      async requestRedirect() {
        return submitted.promise;
      },
      async stage() {
        stages += 1;
      },
    });
    submitted.resolve(browserRedirect());
    await setImmediate();
    assert.equal(stages, 1);
    assert.equal(existsSync(f.persisted), true);
  },
);
