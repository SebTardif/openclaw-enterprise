import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { signInToControllerApp, authenticatedHeaders } from "./auth-session.mjs";
import { createTestConfigurationDriver } from "./configuration-driver.mjs";
import { createTestSecretDriver } from "./secret-driver.mjs";
import { createDevelopmentComputeDriver } from "./development.mjs";

export function expectStatus(response, code) {
  assert.equal(response.status, code, JSON.stringify(response.body));
  return response.data;
}

// Real PostgreSQL auth, IAM, State and Fastify; external Drivers are deterministic fixtures.
// The caller owns a fresh migrated database, accessed only as the application role.
export async function createPostgresControllerAppFixture(t, { databaseUrl, accounts }) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let app;
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      await pool.end();
    }
  });
  assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name, "occ_app");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM occ.installation")).rows[0].count,
    0,
    "use a fresh dedicated migrated database",
  );
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "Controller integration",
    createdAt: new Date().toISOString(),
  };
  const auth = await createPostgresControllerAuth({
    mode: "development",
    installationId: installation.id,
    pool,
    baseURL: "http://127.0.0.1",
    secureCookies: false,
    secret: `test-${randomUUID()}-${randomUUID()}`,
  });
  const actors = {};
  const policy = {
    identities: [],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [],
    bindings: [],
  };
  for (const [key, account] of Object.entries(accounts)) {
    const credentials = {
      email: `${key}-${randomUUID()}@example.com`,
      password: `test-${randomUUID()}`,
      name: account.name,
    };
    const seed = auth.principalSeed(await auth.createAccount(credentials));
    const roles = account.administrator
      ? seed.roles
      : [{ id: key, name: account.name, permissions: account.permissions }];
    policy.identities.push(seed.principal);
    policy.roles.push(...roles);
    policy.bindings.push({
      id: `${key}-binding`,
      subjectKind: "identity",
      subjectId: seed.principal.id,
      roleId: roles[0].id,
    });
    actors[key] = { principal: seed.principal, credentials };
  }
  const state = new PostgresPlatformState(pool, { bootstrapNativeIAM: policy });
  await state.transact((unit) => unit.installations.createInstallation(installation));
  const iam = new NativeIAMDriver(state, { id: "native-iam" });
  const compute = createDevelopmentComputeDriver();
  const controller = new OpenClawController(installation, { state, recordOperations: true });
  const configurationDriver = createTestConfigurationDriver();
  const secretDriver = createTestSecretDriver();
  for (const driver of [iam, compute, configurationDriver, secretDriver]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  let collideAuditId;
  app = createFastifyApp({
    controller,
    auth,
    iamDriver: iam,
    computeDriver: compute,
    configurationDriver,
    secretDriver,
    resolveHarness: resolveApprovedHarness,
    auditSink: state.auditSink,
    development: { enabled: true, installationId: installation.id },
    auditEventFactory: new AuditEventFactory({
      idGenerator: () => collideAuditId ?? `aud_${randomUUID()}`,
    }),
  });
  for (const actor of Object.values(actors)) {
    actor.session = await signInToControllerApp(app, actor.credentials);
  }

  async function request(actor, method, url, payload) {
    const response = await app.inject({
      method,
      url,
      remoteAddress: "127.0.0.1",
      headers: { host: "127.0.0.1", ...(actor ? authenticatedHeaders(actor.session) : {}) },
      ...(payload === undefined ? {} : { payload }),
    });
    const body = response.json();
    return { status: response.statusCode, body, data: body.data };
  }

  // Run exclusively before the worker: duplicate audit PKs abort real mutation transactions.
  async function withAuditCollision(operation) {
    collideAuditId = (await pool.query("SELECT id FROM occ.audit_events LIMIT 1")).rows[0].id;
    try {
      return await operation();
    } finally {
      collideAuditId = undefined;
    }
  }

  async function startWorker(workerTest) {
    const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    let worker;
    workerTest.after(async () => {
      // stop owns its State/pool and runs before the parent closes the app pool.
      if (worker) await worker.stop();
      else await workerPool.end();
    });
    worker = createControllerWorker({
      pool: workerPool,
      computeDriver: compute,
      pollIntervalMs: 10,
      emit: () => {},
    });
    await worker.start();
    return worker;
  }

  return {
    app,
    pool,
    state,
    controller,
    iam,
    policy,
    actors,
    request,
    withAuditCollision,
    startWorker,
  };
}
