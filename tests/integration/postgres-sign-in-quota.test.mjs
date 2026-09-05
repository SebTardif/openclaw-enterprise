import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

test(
  "PostgreSQL quotas protect two real HTTP listeners, refill, and fail closed under storage faults",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a migrated disposable PostgreSQL database.",
  },
  async (t) => {
    const options = {
      mode: "development",
      installationId: `ins_${randomUUID()}`,
      baseURL: "http://127.0.0.1",
      secret: `quota-storage-${randomUUID()}`,
    };
    const pools = [0, 1].map(
      (i) =>
        new pg.Pool({
          connectionString: databaseUrl,
          max: 2,
          application_name: `quota-${randomUUID()}-${i}`,
          connectionTimeoutMillis: 2000,
        }),
    );
    const observer = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const apps = [];
    const auths = [];
    const origins = [];
    const calls = { lookup: 0, hash: 0, verify: 0 };
    const credentials = {
      email: `member-${randomUUID()}@example.test`,
      password: "a-valid-local-test-password",
    };
    let account;
    t.after(async () => {
      await Promise.all(apps.map((app) => app.close()));
      if (account) await auths[0].deleteAccount(account);
      await Promise.all([...pools, observer].map((pool) => pool.end()));
    });
    for (const pool of pools) {
      const auth = await createPostgresControllerAuth({ ...options, pool });
      auths.push(auth);
      if (!account) account = await auth.createAccount(credentials);
      const context = await auth.auth.$context;
      // Observe actual account/password calls while preserving their real implementations.
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
      apps.push(app);
      origins.push(await app.listen({ host: "127.0.0.1", port: 0 }));
    }
    const signIn = async (
      instance,
      { email = credentials.email, password = "an-incorrect-test-password", headers = {} } = {},
    ) => {
      const response = await fetch(`${origins[instance]}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    };

    await t.test(
      "limited application role and fixed slot constraints bound stored key cardinality",
      async () => {
        const role = await observer.query(
          "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        );
        assert.deepEqual(role.rows[0], {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
        });
        for (const slot of [-1, 20480])
          await assert.rejects(
            observer.query("INSERT INTO occ.sign_in_quota_slots VALUES ($1, 0)", [slot]),
            { code: "23514" },
          );
        await assert.rejects(observer.query("DELETE FROM occ.sign_in_quota_slots"), {
          code: "42501",
        });
        await assert.rejects(observer.query("UPDATE occ.sign_in_quota_slots SET slot = 1"), {
          code: "42501",
        });
      },
    );

    await t.test(
      "concurrent instances share exactly five account admissions despite spoofed forwarded headers",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            signIn(i % 2, {
              email: i % 2 ? credentials.email.toUpperCase() : credentials.email,
              headers: {
                "x-forwarded-for": `192.0.2.${i}`,
                "x-real-ip": `198.51.100.${i}`,
                forwarded: `for=203.0.113.${i}`,
              },
            }),
          ),
        );
        assert.equal(results.filter((r) => r.status === 401).length, 5);
        assert.equal(results.filter((r) => r.status === 429).length, 7);
        assert.deepEqual(calls, { lookup: 5, verify: 5, hash: 0 });
        for (const result of results.filter((r) => r.status === 429)) {
          assert.equal(result.headers.get("retry-after"), "12");
          assert.equal(result.headers.get("set-cookie"), null);
          assert.deepEqual(result.body.error, {
            code: "RATE_LIMITED",
            message: "The caller did not provide valid authentication credentials.",
          });
        }
        const rows = await observer.query("SELECT slot, next_at_ms FROM occ.sign_in_quota_slots");
        assert.ok(rows.rows.length <= 20480);
        assert.ok(rows.rows.every((row) => Number.isSafeInteger(Number(row.next_at_ms))));
      },
    );

    await t.test(
      "actual elapsed refill permits a successful password login from the other instance",
      async () => {
        await delay(12100);
        const success = await signIn(1, { password: credentials.password });
        assert.equal(success.status, 200);
        assert.deepEqual(success.body.data, { authenticated: true });
        assert.match(success.headers.get("set-cookie"), /HttpOnly/i);
        assert.equal((await signIn(0)).status, 429);
        assert.deepEqual(calls, { lookup: 6, verify: 6, hash: 0 });
      },
    );

    const unknown = `unknown-${randomUUID()}@example.test`;
    await t.test(
      "unknown accounts consume the same pair quota and expose the same denial metadata",
      async () => {
        const before = { ...calls };
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) => signIn(i % 2, { email: unknown })),
        );
        // A fixed-slot collision may share the first account's active debt. It
        // can only reduce admissions; the existing-account case proves a fresh burst.
        const admitted = results.filter((r) => r.status === 401).length;
        assert.ok(admitted <= 5);
        assert.equal(results.filter((r) => r.status === 429).length, 6 - admitted);
        const denied = results.find((r) => r.status === 429);
        assert.equal(denied.headers.get("retry-after"), "12");
        assert.deepEqual(denied.body.error, {
          code: "RATE_LIMITED",
          message: "The caller did not provide valid authentication credentials.",
        });
        assert.deepEqual(calls, {
          lookup: before.lookup + admitted,
          verify: before.verify,
          hash: before.hash + admitted,
        });
      },
    );

    await t.test(
      "row lock timeout fails closed before authentication and preserves usable storage",
      async () => {
        const blocker = await observer.connect();
        const before = { ...calls };
        try {
          await blocker.query("BEGIN");
          // Lock existing source slots so both real listeners contend on shared admission.
          await blocker.query(
            "SELECT slot FROM occ.sign_in_quota_slots WHERE slot < 4096 FOR UPDATE",
          );
          const started = performance.now();
          const result = await signIn(0, { email: `lock-${randomUUID()}@example.test` });
          assert.equal(result.status, 503);
          assert.equal(result.headers.get("retry-after"), "1");
          assert.equal(result.body.error.code, "DEPENDENCY_UNAVAILABLE");
          assert.ok(performance.now() - started < 2000);
          assert.deepEqual(calls, before);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        assert.equal(
          (await signIn(0, { email: `recovered-${randomUUID()}@example.test` })).status,
          401,
        );
      },
    );

    await t.test(
      "pool exhaustion bounds pending reservations and late checkout cannot authenticate",
      async () => {
        const held = await Promise.all([pools[0].connect(), pools[0].connect()]);
        const before = { ...calls };
        try {
          const started = performance.now();
          const results = await Promise.all(Array.from({ length: 40 }, () => signIn(0)));
          assert.ok(performance.now() - started < 2500);
          assert.ok(results.every((r) => r.status === 503 && r.headers.get("retry-after") === "1"));
          assert.ok(pools[0].waitingCount <= 32);
          assert.deepEqual(calls, before);
        } finally {
          held.forEach((client) => client.release());
        }
        // Expired reservations may acquire a socket later, but must destroy it without work.
        const until = Date.now() + 3000;
        while (pools[0].waitingCount && Date.now() < until) await delay(20);
        assert.equal(pools[0].waitingCount, 0);
        assert.deepEqual(calls, before);
        assert.equal(
          (await signIn(0, { email: `available-${randomUUID()}@example.test` })).status,
          401,
        );
      },
    );

    await t.test(
      "a real backend disconnect returns a safe failure without an unhandled client error",
      async () => {
        const blocker = await observer.connect();
        const before = { ...calls };
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT slot FROM occ.sign_in_quota_slots WHERE slot < 4096 FOR UPDATE",
          );
          const pending = signIn(1, { email: `disconnect-${randomUUID()}@example.test` });
          let pid;
          const until = Date.now() + 600;
          while (!pid && Date.now() < until) {
            const blocked = await observer.query(
              "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
              [pools[1].options.application_name],
            );
            pid = blocked.rows[0]?.pid;
            if (!pid) await delay(10);
          }
          assert.ok(
            pid,
            "the real quota transaction must be blocked before terminating its backend",
          );
          assert.equal(
            (await observer.query("SELECT pg_terminate_backend($1) AS stopped", [pid])).rows[0]
              .stopped,
            true,
          );
          const result = await pending;
          assert.equal(result.status, 503);
          assert.equal(result.headers.get("retry-after"), "1");
          assert.deepEqual(calls, before);
          assert.doesNotMatch(
            JSON.stringify(result.body),
            /postgres|terminated|SELECT|quota_slots|password/i,
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        assert.equal(
          (await signIn(1, { email: `alive-${randomUUID()}@example.test` })).status,
          401,
        );
      },
    );
  },
);
