import assert from "node:assert/strict";
import pg from "pg";
import { composePostgresDevelopment } from "../../../apps/controller/src/composition/development-postgres.ts";
import { createDevelopmentComputeDriver } from "../../helpers/development.mjs";
import { createTestConfigurationDriver } from "../../helpers/configuration-driver.mjs";
import { signInWithEmailPassword } from "../../helpers/auth-session.mjs";

const mode = process.argv[2];
const control = new pg.Pool({
  connectionString: process.env.OCC_AUTH_FAILURE_MIGRATOR_URL,
  max: 1,
});
const app = await composePostgresDevelopment(
  {
    mode: "development",
    host: "127.0.0.1",
    databaseUrl: process.env.OCC_AUTH_FAILURE_DATABASE_URL,
    authBaseURL: "http://127.0.0.1",
    authSecret: process.env.OCC_AUTH_SECRET,
  },
  {
    computeDriver: createDevelopmentComputeDriver(),
    configurationDriver: createTestConfigurationDriver(),
  },
);
let phase = "startup";

async function run() {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  async function request(method, path, cookie, browserOrigin = "http://127.0.0.1") {
    const response = await fetch(origin + path, {
      method,
      headers: { origin: browserOrigin, cookie },
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    return {
      status: response.status,
      authenticated: body.data?.authenticated === true,
      success: body.data?.success === true,
      code: body.error?.code,
      cookies: response.headers.getSetCookie(),
      body,
    };
  }
  async function tokens() {
    return (
      await control.query(
        'SELECT s.token FROM occ.session s JOIN occ."user" u ON u.id=s.user_id WHERE u.email=$1',
        [process.env.OPENCLAW_DEV_EMAIL],
      )
    ).rows.map((r) => r.token);
  }
  async function login() {
    const before = await tokens();
    const session = await signInWithEmailPassword({
      origin,
      email: process.env.OPENCLAW_DEV_EMAIL,
      password: process.env.OPENCLAW_DEV_PASSWORD,
      headers: { origin: "http://127.0.0.1" },
    });
    const added = (await tokens()).filter((token) => !before.includes(token));
    assert.equal(added.length, 1, "the actual login must create exactly one new durable session");
    process.send({ kind: "canary", value: added[0] });
    return { ...session, token: added[0] };
  }
  phase = "healthy-login";
  const session = await login();
  const other = await login();
  assert.equal((await request("GET", "/api/auth/session", session.cookie)).authenticated, true);
  assert.equal((await request("GET", "/api/auth/session", other.cookie)).authenticated, true);
  // Browser intent must reject before a valid bearer can reach durable deletion.
  const untrusted = await request(
    "POST",
    "/api/auth/sign-out",
    session.cookie,
    "https://untrusted.example",
  );
  assert.equal(untrusted.status, 403);
  assert.equal((await tokens()).includes(session.token), true);

  if (mode !== "healthy") {
    const privilege = mode === "delete" ? "DELETE" : "SELECT";
    phase = `${mode}-denial`;
    // Only the separately selected owned test database's migration role changes grants.
    await control.query(`REVOKE ${privilege} ON occ.session FROM occ_app`);
    const permission = await control.query(
      "SELECT has_table_privilege('occ_app','occ.session',$1) AS allowed",
      [privilege],
    );
    assert.equal(permission.rows[0].allowed, false);
    const failed = await request(
      mode === "select-session" ? "GET" : "POST",
      mode === "select-session" ? "/api/auth/session" : "/api/auth/sign-out",
      session.cookie,
    );
    assert.equal(failed.success, false, "a storage failure must never acknowledge logout");
    assert.equal(failed.authenticated, false);
    if (mode === "select-session") assert.equal(failed.status >= 400, true);
    else {
      assert.equal(failed.status, 503);
      assert.equal(failed.code === "DEPENDENCY_UNAVAILABLE", true);
      assert.equal(
        failed.cookies.length,
        0,
        "failed revocation must not clear or replace the cookie",
      );
    }
    assert.equal(JSON.stringify(failed.body).includes(session.token), false);
    assert.equal(
      (await tokens()).includes(session.token),
      true,
      "the denied storage operation must leave the selected durable session present",
    );
    await control.query(`GRANT ${privilege} ON occ.session TO occ_app`);
    phase = "recovered-original-cookie";
    assert.equal(
      (await request("GET", "/api/auth/session", session.cookie)).authenticated,
      true,
      "failure must truthfully leave the original cookie usable after storage recovers",
    );
  }

  phase = "healthy-durable-logout";
  const revoked = await request("POST", "/api/auth/sign-out", session.cookie);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.success, true);
  assert.equal(
    revoked.cookies.some((cookie) => /max-age=0/i.test(cookie)),
    true,
  );
  assert.equal((await tokens()).includes(session.token), false);
  assert.equal((await request("GET", "/api/auth/session", session.cookie)).authenticated, false);
  assert.equal(
    (await request("GET", "/api/auth/session", other.cookie)).authenticated,
    true,
    "logout must not delete another valid session",
  );
  assert.equal((await request("POST", "/api/auth/sign-out", other.cookie)).success, true);
  assert.equal((await tokens()).includes(other.token), false);
  assert.equal(
    (await request("POST", "/api/auth/sign-out", session.cookie)).success,
    true,
    "an already absent session has an idempotent successful logout",
  );
  process.send({ kind: "result", mode, passed: true });
}

try {
  await run();
} catch {
  // Raw dependency/assertion errors may contain the synthetic bearer. Never echo them.
  process.send?.({ kind: "failure", phase });
  process.exitCode = 1;
} finally {
  await control.query("GRANT SELECT, DELETE ON occ.session TO occ_app");
  const permissions = await control.query(
    "SELECT has_table_privilege('occ_app','occ.session','SELECT') AND has_table_privilege('occ_app','occ.session','DELETE') AS restored",
  );
  process.send?.({ kind: "restored", value: permissions.rows[0].restored });
  await app.close();
  await control.end();
  process.disconnect?.();
}
