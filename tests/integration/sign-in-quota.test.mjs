import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createControllerAuth } from "../../apps/controller/src/auth/index.ts";
import {
  createSignInQuota,
  MemorySignInQuotaStore,
} from "../../apps/controller/src/auth/sign-in-quota.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";

async function fixture(t) {
  const auth = createControllerAuth({
    mode: "development",
    installationId: `ins_${randomUUID()}`,
    baseURL: "http://127.0.0.1",
    secret: `quota-fixture-${randomUUID()}`,
  });
  const credentials = { email: "member@example.test", password: "a-valid-local-test-password" };
  await auth.createAccount(credentials);
  // These observers delegate to the real Better Auth functions: no result is invented.
  const calls = { lookup: 0, hash: 0, verify: 0 };
  const context = await auth.auth.$context;
  for (const [owner, key, counter] of [
    [context.internalAdapter, "findUserByEmail", "lookup"],
    [context.password, "hash", "hash"],
    [context.password, "verify", "verify"],
  ]) {
    const original = owner[key];
    owner[key] = function (...args) {
      calls[counter] += 1;
      return original.apply(this, args);
    };
  }
  const app = createFastifyApp({ auth, development: { enabled: false } });
  t.after(() => app.close());
  const signIn = (options = {}) =>
    app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: "192.0.2.10",
      payload: { ...credentials, password: "an-incorrect-test-password" },
      ...options,
    });
  return { auth, app, credentials, calls, signIn };
}

test("real sign-in atomically exhausts a normalized source/account quota before password work", async (t) => {
  const { signIn, credentials, calls } = await fixture(t);
  const attempts = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      signIn({
        payload: {
          ...credentials,
          email: i % 2 ? credentials.email.toUpperCase() : credentials.email,
          password: "an-incorrect-test-password",
        },
        headers: {
          "x-forwarded-for": `198.51.100.${i}`,
          "x-real-ip": `203.0.113.${i}`,
          forwarded: `for=203.0.113.${i}`,
        },
      }),
    ),
  );
  assert.equal(attempts.filter((r) => r.statusCode === 401).length, 5);
  assert.equal(attempts.filter((r) => r.statusCode === 429).length, 7);
  assert.deepEqual(calls, { lookup: 5, verify: 5, hash: 0 });
  for (const response of attempts.filter((r) => r.statusCode === 429)) {
    assert.deepEqual(response.json().error, {
      code: "RATE_LIMITED",
      message: "The caller did not provide valid authentication credentials.",
    });
    assert.equal(response.headers["retry-after"], "12");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["set-cookie"], undefined);
  }
  // Another real transport source does not inherit an account-only lockout.
  assert.equal(
    (await signIn({ remoteAddress: "192.0.2.11", payload: credentials })).statusCode,
    200,
  );
});

test("source quota bounds attempts that vary the account", async (t) => {
  const { signIn, calls } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 36 }, (_, i) =>
      signIn({
        payload: { email: `unknown-${i}@example.test`, password: "an-incorrect-test-password" },
      }),
    ),
  );
  // Hash-slot collisions can conservatively throttle earlier, never increase admission.
  const permitted = results.filter((r) => r.statusCode === 401).length;
  assert.ok(permitted > 0 && permitted <= 30);
  assert.equal(results.filter((r) => r.statusCode === 429).length, 36 - permitted);
  assert.equal(calls.lookup, permitted);
  assert.equal(calls.hash, permitted);
  assert.equal(calls.verify, 0);
});

test("Origin, successful sessions, input errors and disabled signup remain intact", async (t) => {
  const { signIn, app, credentials, calls } = await fixture(t);
  for (const headers of [
    { origin: "https://untrusted.example" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal((await signIn({ headers })).statusCode, 403);
  assert.deepEqual(calls, { lookup: 0, verify: 0, hash: 0 });
  const malformed = await signIn({
    payload: { email: "invalid-email", password: credentials.password },
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(calls, { lookup: 0, verify: 0, hash: 0 });
  const success = await signIn({ payload: credentials, headers: { origin: "http://127.0.0.1" } });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json().data, { authenticated: true });
  assert.match(String(success.headers["set-cookie"]), /HttpOnly/i);
  assert.doesNotMatch(success.body, /session_token|password/);
  const cookie = String(success.headers["set-cookie"]).split(";")[0];
  const session = await app.inject({
    method: "GET",
    url: "/api/auth/session",
    headers: { cookie },
  });
  assert.equal(session.json().data.user.email, credentials.email);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/auth/sign-up/email", payload: credentials }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/auth/sign-in/email", payload: credentials }))
      .statusCode,
    404,
  );
});

test("missing transport fails closed and canonical transport/account forms share admission", async () => {
  const quota = createSignInQuota(
    new MemorySignInQuotaStore(),
    "bounded-fixture-secret",
    "fixture",
  );
  await assert.rejects(quota(undefined, "member@example.test"), { status: 503, retryAfter: 1 });
  for (let i = 0; i < 5; i++)
    await quota(i % 2 ? "::ffff:192.0.2.10" : "192.0.2.10", " MEMBER@EXAMPLE.TEST ");
  await assert.rejects(quota("192.0.2.10", "member@example.test"), { status: 429, retryAfter: 12 });
});
