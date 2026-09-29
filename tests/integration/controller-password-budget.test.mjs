import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  createControllerAuth,
  createPostgresControllerAuth,
} from "../../apps/controller/src/auth/index.ts";
import {
  bindPasswordBudgetKey,
  passwordBudgetKeyBinding,
  preparePasswordBudgetKey,
} from "../../apps/controller/src/auth/password-admission.ts";

import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import * as occ from "../../packages/occ/src/index.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const baseURL = "http://127.0.0.1";
const password = "a-valid-test-password";
const options = {
  mode: "development",
  installationId: "installation-test",
  baseURL,
  secret: "password-budget-test-secret-at-least-32-characters",
};
const memory = () => ({ user: [], session: [], account: [], verification: [], apikey: [] });

async function admission(reserve) {
  const key = await preparePasswordBudgetKey(options.installationId, {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-test", bytes: new Uint8Array(32).fill(7) }) },
  });
  return bindPasswordBudgetKey(key, { reserve });
}

function appFor(context, auth) {
  const auditSink = new InMemoryAuditSink();
  const policy = {
    identities: [],
    roles: [],
    bindings: [],
    groups: [],
    memberships: [],
    restrictions: [],
  };
  const app = createFastifyApp({
    auth,
    iamDriver: new NativeIAMDriver({ loadNativeIAMState: async () => policy }),
    auditSink,
    development: { enabled: true, installationId: options.installationId },
    computeDriver: createDevelopmentComputeDriver(),
    secretDriver: createTestSecretDriver(),
    configurationDriver: createTestConfigurationDriver(),
    resolveHarness: resolveApprovedHarness,
    createController(installation) {
      return new occ.OpenClawController(installation, {
        state: new occ.InMemoryPlatformState({ auditSink }),
        recordOperations: false,
      });
    },
  });
  context.after(() => app.close());
  return app;
}

function signIn(app, email, suppliedPassword = password) {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress: "192.0.2.10",
    headers: { origin: baseURL },
    payload: { email, password: suppliedPassword },
  });
}

test("password budget separates real accounts behind one proxy and preserves non-password routes", async (context) => {
  const db = memory();
  const seed = createControllerAuth({ ...options, memoryDatabase: db });
  await seed.createAccount({ email: "one@example.com", password });
  await seed.createAccount({ email: "two@example.com", password });
  const counts = new Map();
  const auth = createControllerAuth({
    ...options,
    memoryDatabase: db,
    passwordAdmission: await admission(async (digest) => {
      const key = Buffer.from(digest).toString("hex");
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      return count === 0 ? { status: "allowed" } : { status: "limited", retryAfterSeconds: 31 };
    }),
  });
  const app = appFor(context, auth);
  assert.equal((await signIn(app, "ONE@example.com", "wrong-test-password")).statusCode, 401);
  const limited = await signIn(app, "one@example.com");
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "31");
  assert.equal(limited.headers["set-cookie"], undefined);
  const denied = limited.json();
  assert.deepEqual(denied.error, {
    code: "RATE_LIMITED",
    message: "The caller did not provide valid authentication credentials.",
  });
  assert.equal(typeof denied.meta.requestId, "string");
  assert.notEqual(denied.meta.requestId, "");
  assert.deepEqual(Object.keys(denied).sort(), ["error", "meta"]);

  // The real response and generated client contract must agree. This also
  // prevents a shared response helper from advertising throttling everywhere.
  const document = app.swagger();
  const response = document.paths["/api/auth/sign-in/email"].post.responses["429"];
  assert.ok(response, "password sign-in must document its limited response");
  const header = response.headers["Retry-After"];
  assert.equal(header.schema.type, "string");
  assert.equal(header.schema.pattern, "^[1-9][0-9]*$");
  assert.match(header.description, /seconds/i);
  assert.match(limited.headers["retry-after"], new RegExp(header.schema.pattern));
  const envelope = response.content["application/json"].schema;
  assert.equal(envelope.type, "object");
  assert.deepEqual(envelope.required, ["error", "meta"]);
  assert.deepEqual(envelope.properties.error.required, ["code", "message"]);
  assert.equal(envelope.properties.meta.properties.requestId.type, "string");
  const generated = JSON.parse(
    readFileSync(
      new URL("../../packages/contracts/openapi/occ-api.openapi.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(generated.paths["/api/auth/sign-in/email"].post.responses["429"], response);
  assert.equal(document.paths["/api/auth/session"].get.responses["429"], undefined);
  assert.equal(document.paths["/api/auth/sign-out"].post.responses["429"], undefined);
  const accepted = await signIn(app, "two@example.com");
  assert.equal(accepted.statusCode, 200);
  assert.ok(accepted.headers["set-cookie"]);
  assert.equal(counts.size, 2);
  const before = [...counts.entries()];
  await app.inject({ method: "GET", url: "/api/auth/session" });
  await app.inject({ method: "POST", url: "/api/auth/sign-out", headers: { origin: baseURL } });
  assert.deepEqual([...counts.entries()], before);
});

test("password budget preserves Better Auth aliases and awaits acknowledgement before password work", async (context) => {
  const db = memory();
  const seed = createControllerAuth({ ...options, memoryDatabase: db });
  await seed.createAccount({ email: "person@example.com", password });
  const captured = [];
  let result = { status: "unknown" };
  let reservationStarted;
  const budget = await admission(async (digest) => {
    captured.push(Buffer.from(digest).toString("hex"));
    reservationStarted?.();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  const ordinary = createControllerAuth({
    ...options,
    memoryDatabase: db,
    passwordAdmission: budget,
  });
  const ordinaryContext = await ordinary.auth.$context;
  let lookups = 0;
  let passwordWork = 0;
  const originalLookup = ordinaryContext.internalAdapter.findUserByEmail.bind(
    ordinaryContext.internalAdapter,
  );
  ordinaryContext.internalAdapter.findUserByEmail = (...args) => {
    lookups += 1;
    return originalLookup(...args);
  };
  for (const method of ["hash", "verify"]) {
    const original = ordinaryContext.password[method].bind(ordinaryContext.password);
    ordinaryContext.password[method] = (...args) => {
      passwordWork += 1;
      return original(...args);
    };
  }
  const ordinaryApp = appFor(context, ordinary);
  assert.equal((await signIn(ordinaryApp, " person@example.com ")).statusCode, 400);
  assert.equal(captured.length, 0);
  for (const candidate of [
    { status: "unknown" },
    { status: "unavailable" },
    { status: "limited", retryAfterSeconds: 31 },
    { status: "allowed", retryAfterSeconds: 31 },
    { status: "allowed", extra: true },
    new Error("lost reservation acknowledgement"),
  ]) {
    result = candidate;
    const before = captured.length;
    const denied = await signIn(ordinaryApp, "PERSON@example.com");
    assert.equal(denied.statusCode, candidate.status === "limited" ? 429 : 503);
    assert.equal(denied.headers["set-cookie"], undefined);
    assert.equal(captured.length, before + 1);
    assert.equal(lookups, 0);
    assert.equal(passwordWork, 0);
    assert.equal(db.session.length, 0);
  }

  // Hold the real caller at reservation settlement. No lookup, hash or session
  // write may occur until the independently settled port acknowledges allow.
  let allow;
  result = new Promise((resolve) => {
    allow = resolve;
  });
  const started = new Promise((resolve) => {
    reservationStarted = resolve;
  });
  const pending = signIn(ordinaryApp, "PERSON@example.com");
  await started;
  assert.equal(lookups, 0);
  assert.equal(passwordWork, 0);
  assert.equal(db.session.length, 0);
  allow({ status: "allowed" });
  const accepted = await pending;
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok(accepted.headers["set-cookie"]);
  assert.equal(new Set(captured).size, 1);
  assert.equal(lookups, 1);
  assert.ok(passwordWork > 0);
  assert.equal(db.session.length, 1);
});

test("PostgreSQL password admission refuses a directly injected admission before database work", async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error("must not connect");
    },
  };
  const passwordAdmission = await admission(async () => ({ status: "allowed" }));
  await assert.rejects(
    createPostgresControllerAuth({ ...options, pool, passwordAdmission }),
    /selected State and budget pair/,
  );
  assert.equal(connections, 0);
});

test("PostgreSQL password admission refuses an unrecognized State pair before database work", async () => {
  let connections = 0;
  const pool = {
    connect: async () => {
      connections += 1;
      throw new Error("must not connect");
    },
  };
  const state = {};
  const key = await preparePasswordBudgetKey(options.installationId, {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-test", bytes: new Uint8Array(32).fill(7) }) },
  });
  await assert.rejects(
    createPostgresControllerAuth({
      ...options,
      pool,
      passwordBudget: {
        state,
        pair: { state, passwordBudget: { reserve: async () => ({ status: "allowed" }) } },
        key,
      },
    }),
    /selected State and budget pair/,
  );
  assert.equal(connections, 0);
});

test("password admission preserves the current route Unicode bounds and verifier email validation", async (context) => {
  const db = memory();
  const seed = createControllerAuth({ ...options, memoryDatabase: db });
  const unicodePassword = "🦊".repeat(64);
  await seed.createAccount({ email: "person@example.com", password: unicodePassword });
  let calls = 0;
  const auth = createControllerAuth({
    ...options,
    memoryDatabase: db,
    passwordAdmission: await admission(async () => {
      calls += 1;
      return { status: "allowed" };
    }),
  });
  const app = appFor(context, auth);
  // Better Auth rejects these email forms before lookup. Do not reintroduce
  // the unshipped human verifier's broader email normalization on this route.
  for (const email of ["🦊".repeat(160) + "@a.b", "İ".repeat(316) + "@a.b", "ab"]) {
    const denied = await signIn(app, email);
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.headers["set-cookie"], undefined);
  }
  assert.equal(calls, 0);
  const accepted = await signIn(app, "PERSON@example.com", unicodePassword);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok(accepted.headers["set-cookie"]);
  // The HTTP limit counts code points. A longer UTF-16 representation still
  // reaches the existing verifier and returns incorrect-password, not 400.
  const wrong = await signIn(app, "person@example.com", "🦊".repeat(65));
  assert.equal(wrong.statusCode, 401, wrong.body);
  assert.equal(wrong.headers["set-cookie"], undefined);
  assert.equal(calls, 2);
  const oversized = await signIn(app, "person@example.com", "🦊".repeat(129));
  assert.equal(oversized.statusCode, 400);
  assert.equal(calls, 2);
  assert.equal(db.session.length, 1);
});

test("PostgreSQL password admission binds the real State pair to the exact auth pool", async (context) => {
  assert.equal(
    typeof occ.createPostgresStateWithPasswordBudget,
    "function",
    "receive the reviewed State budget supplier before running this join",
  );
  let connections = 0;
  // The real State constructor issues pool identity; an ordinary pg.Pool or
  // copied/wrapped object cannot substitute for it. No client is checked out.
  const pool = await occ.createPostgresPasswordBudgetPool(
    "postgresql://fixture:fixture@127.0.0.1:9/fixture",
    { authMode: "password", max: 1 },
  );
  const wrongPool = await occ.createPostgresPasswordBudgetPool(
    "postgresql://fixture:fixture@127.0.0.1:9/fixture",
    { authMode: "password", max: 1 },
  );
  context.after(async () => {
    await Promise.all([pool.end(), wrongPool.end()]);
  });
  pool.on("connect", () => {
    connections += 1;
  });
  wrongPool.on("connect", () => {
    connections += 1;
  });
  const key = await preparePasswordBudgetKey(options.installationId, {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-test", bytes: new Uint8Array(32).fill(7) }) },
  });
  const binding = passwordBudgetKeyBinding(key);
  const pair = occ.createPostgresStateWithPasswordBudget(
    pool,
    {},
    {
      installationId: options.installationId,
      epoch: binding.policyEpoch,
      keyConfirmation: binding.keyConfirmation,
      transactionTimeoutMs: 1000,
    },
  );
  assert.equal(
    occ.matchesPostgresPasswordBudgetPair(
      pair,
      pair.state,
      {
        installationId: options.installationId,
        epoch: binding.policyEpoch,
        keyConfirmation: binding.keyConfirmation,
      },
      pool,
    ),
    true,
  );
  for (const selectedAuthPool of [undefined, wrongPool, new Proxy(pool, {})]) {
    await assert.rejects(
      createPostgresControllerAuth({
        ...options,
        pool: selectedAuthPool,
        passwordBudget: { state: pair.state, pair, key },
      }),
      /selected State and budget pair/,
    );
  }
  for (const fakeKey of [
    { ...key },
    new Proxy(key, {}),
    { ...binding, bind: () => ({ reserve: async () => ({ status: "allowed" }) }) },
  ]) {
    await assert.rejects(
      createPostgresControllerAuth({
        ...options,
        pool,
        passwordBudget: { state: pair.state, pair, key: fakeKey },
      }),
      /key is not recognized/,
    );
  }
  for (const fakePair of [{ ...pair }, new Proxy(pair, {})]) {
    await assert.rejects(
      createPostgresControllerAuth({
        ...options,
        pool,
        passwordBudget: { state: pair.state, pair: fakePair, key },
      }),
      /selected State and budget pair/,
    );
  }
  for (const state of [undefined, new Proxy(pair.state, {})]) {
    await assert.rejects(
      createPostgresControllerAuth({
        ...options,
        pool,
        passwordBudget: { state, pair, key },
      }),
      /selected State and budget pair/,
    );
  }
  const accepted = await createPostgresControllerAuth({
    ...options,
    pool,
    passwordBudget: { state: pair.state, pair, key },
  });
  assert.equal(typeof accepted.signInEmail, "function");
  assert.equal(connections, 0);
});
