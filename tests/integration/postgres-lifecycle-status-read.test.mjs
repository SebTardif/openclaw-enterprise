import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createControllerLifecycleStatusV1 } from "../../apps/controller/src/lifecycle/read-integration-v1.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { authenticatedHeaders, signInToControllerApp } from "../helpers/auth-session.mjs";
import {
  seedRuntimeOwner,
  seedRunning,
  protectiveWrite,
  apply,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";

const applicationUrl = process.env.OCC_LIFECYCLE_READ_DATABASE_URL;
const ownerUrl = process.env.OCC_LIFECYCLE_READ_MIGRATOR_DATABASE_URL;

test(
  "production lifecycle reads use actual PostgreSQL, BetterAuth, native IAM and protected Fastify registration",
  {
    skip:
      applicationUrl && ownerUrl
        ? false
        : "Select a dedicated migrated and bootstrapped loopback lifecycle-read database, with occ_app and occ_migrator URLs.",
    timeout: 90_000,
  },
  async (t) => {
    const urls = [applicationUrl, ownerUrl].map((value) => new URL(value));
    for (const url of urls) {
      assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      assert.match(url.pathname, /^\/openclaw_lifecycle_read_[a-z0-9_]+$/);
      assert.equal(url.host, urls[0].host);
      assert.equal(url.pathname, urls[0].pathname);
    }
    const pool = new pg.Pool({
      connectionString: applicationUrl,
      max: 4,
      connectionTimeoutMillis: 250,
      query_timeout: 3000,
    });
    const ownerPool = new pg.Pool({
      connectionString: ownerUrl,
      max: 2,
      connectionTimeoutMillis: 250,
      query_timeout: 3000,
    });
    let app;
    let auth;
    let account;
    t.after(async () => {
      try {
        await app?.close();
      } finally {
        try {
          if (auth && account) await auth.deleteAccount(account);
        } finally {
          await Promise.all([pool.end(), ownerPool.end()]);
        }
      }
    });
    for (const [connection, name] of [
      [pool, "occ_app"],
      [ownerPool, "occ_migrator"],
    ]) {
      assert.deepEqual(
        (
          await connection.query(
            "SELECT current_user AS name, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0],
        { name, rolsuper: false, rolcreaterole: false, rolbypassrls: false },
      );
    }
    const state = new PostgresPlatformState(pool);
    const installation = await state.loadInstallation();
    assert.ok(
      installation,
      "root must prepare the actual fresh bootstrap before this finite read suite",
    );
    const owner = await seedRuntimeOwner(state);
    const foreign = await seedRuntimeOwner(state);
    const running = await seedRunning(state, owner);
    await state.transact((unit) =>
      unit.agents.compareAndSetActiveRevision(
        owner.namespace.id,
        owner.agent.id,
        undefined,
        owner.revision.id,
      ),
    );
    const disable = protectiveWrite(owner, "disable", 1);
    await apply(state, disable);
    const stop = protectiveWrite(owner, "stop", 2);
    await apply(state, stop);

    auth = await createPostgresControllerAuth({
      mode: "production",
      installationId: installation.id,
      baseURL: "http://127.0.0.1",
      secret: `lifecycle-read-disposable-${randomUUID()}-${randomUUID()}`,
      secureCookies: false,
      pool,
    });
    const credentials = {
      email: `lifecycle-read-${randomUUID()}@example.invalid`,
      password: `disposable-${randomUUID()}`,
    };
    account = await auth.createAccount(credentials);
    const seed = auth.principalSeed(account);
    const binding = {
      id: seed.bindings[0].id,
      subjectKind: "identity",
      subjectId: seed.principal.id,
      roleId: seed.roles[0].id,
      namespaceId: owner.namespace.id,
      resourceKind: "agent",
      resourceId: owner.agent.id,
    };
    // Original native-IAM preprovisioning stores an exact fixture policy. The
    // account-provisioning helper only supports existing Installation bindings
    // and is deliberately not repurposed to grant tenant read permissions.
    await state.seedNativeIAM({
      identities: [seed.principal],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [{ id: seed.roles[0].id, permissions: [{ action: "read", resourceKind: "agent" }] }],
      bindings: [binding],
    });
    const iam = new NativeIAMDriver(state);
    const controller = new OpenClawController(installation, { state });
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    const dependencies = createControllerLifecycleStatusV1({
      installationId: installation.id,
      state,
      verifier: auth.admissionVerifier,
    });
    const calls = [];
    app = createFastifyApp({
      controller,
      auth,
      iamDriver: iam,
      auditSink: state.auditSink,
      publicOrigin: "http://127.0.0.1",
      development: { enabled: false, installationId: installation.id },
      lifecycleStatus: {
        ...dependencies,
        async resolveReadCall(request) {
          const call = await dependencies.resolveReadCall(request);
          if (call) calls.push(call);
          return call;
        },
      },
    });
    await app.ready();
    const session = await signInToControllerApp(app, credentials);
    const headers = { ...authenticatedHeaders(session), host: "127.0.0.1" };
    const base = `/namespaces/${owner.namespace.id}/agents/${owner.agent.id}/lifecycle`;
    const get = (suffix = "", override = {}) =>
      app.inject({ method: "GET", url: `${base}${suffix}`, headers, ...override });
    const safe = (response) => {
      assert.equal(response.headers["cache-control"], "no-store");
      for (const secret of [
        account.id,
        seed.principal.id,
        session.cookie,
        credentials.password,
        disable.workId,
        disable.audit.id,
      ])
        assert.equal(response.body.includes(secret), false);
      return response.json();
    };
    await t.test(
      "current status reports committed stopped intent and actual selection without inventing runtime observations",
      async () => {
        const response = await get();
        assert.equal(response.statusCode, 200, response.body);
        const { data } = safe(response);
        assert.deepEqual(data.head, {
          operationRef: stop.transitionRef,
          lifecycleGeneration: 3,
          desiredMode: "stopped",
          requestedRevisionId: owner.revision.id,
        });
        assert.equal(data.selectedRevisionId, owner.revision.id);
        assert.equal(data.servingRevisionId, null);
        assert.equal(data.observedLifecycleGeneration, null);
        assert.equal(data.reasonCode, "NOT_OBSERVED");
        assert.equal(data.serving, false);
        assert.equal(data.stopComplete, false);
        for (const condition of Object.values(data.conditions))
          assert.equal(condition.status, "unknown");
      },
    );
    await t.test(
      "discovery traverses exact bounded pages with immutable original generations and no revision document",
      async () => {
        const first = await get("/operations?limit=2");
        assert.equal(first.statusCode, 200, first.body);
        const page = safe(first).data;
        assert.deepEqual(
          page.operations.map((value) => [value.operationRef, value.lifecycleGeneration]),
          [
            [running.intent.transitionRef, 1],
            [disable.transitionRef, 2],
          ],
        );
        assert.equal(page.nextAfterGeneration, 2);
        assert.equal(
          page.operations.some((value) => Object.hasOwn(value, "requestedRevisionId")),
          false,
        );
        const last = await get("/operations?limit=2&afterGeneration=2");
        assert.equal(last.statusCode, 200, last.body);
        assert.deepEqual(
          safe(last).data.operations.map((value) => value.operationRef),
          [stop.transitionRef],
        );
        assert.equal(last.json().data.nextAfterGeneration, null);
        const empty = await get("/operations?afterGeneration=3");
        assert.equal(empty.statusCode, 200, empty.body);
        assert.deepEqual(safe(empty).data, { operations: [], nextAfterGeneration: null });
      },
    );
    await t.test(
      "exact deploy and protective operations survive head advancement with original acceptance identities",
      async () => {
        for (const [reference, kind, generation] of [
          [running.intent.transitionRef, "deploy", 1],
          [disable.transitionRef, "disable", 2],
          [stop.transitionRef, "stop", 3],
        ]) {
          const response = await get(`/operations/${reference}`);
          assert.equal(response.statusCode, 200, response.body);
          const { operation, observation } = safe(response).data;
          assert.equal(operation.operationRef, reference);
          assert.equal(operation.kind, kind);
          assert.equal(operation.lifecycleGeneration, generation);
          assert.equal(operation.requestedRevisionId, owner.revision.id);
          assert.equal(observation.reasonCode, "NOT_OBSERVED");
          assert.equal(observation.observedAt, null);
        }
      },
    );
    await t.test(
      "an absent capability publisher stays unavailable; exact operator-owned fixture record remains data only",
      async () => {
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.lifecycle_capabilities WHERE installation_id=$1",
              [installation.id],
            )
          ).rows[0].count,
          0,
        );
        const absent = await get("/capability");
        assert.equal(absent.statusCode, 503);
        safe(absent);
        await assert.rejects(
          pool.query("INSERT INTO occ.lifecycle_capabilities(installation_id) VALUES($1)", [
            installation.id,
          ]),
          { code: "42501" },
        );
        // Controlled disposable owner record verifies the READ path only, never a
        // production capability publisher, compatible rollout or runtime authority.
        await ownerPool.query(
          "INSERT INTO occ.lifecycle_capabilities(installation_id) VALUES($1)",
          [installation.id],
        );
        try {
          const response = await get("/capability");
          assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(safe(response).data, {
            schemaVersion: 1,
            protocol: "lifecycle-control-v1",
            stage: "legacy",
            capabilityVersion: 1,
            supportedConsumerVersions: {
              api: null,
              worker: null,
              maintenance: null,
              receiving: null,
            },
          });
        } finally {
          await ownerPool.query(
            "DELETE FROM occ.lifecycle_capabilities WHERE installation_id=$1 AND capability_version=1",
            [installation.id],
          );
        }
      },
    );
    await t.test(
      "missing, hidden and foreign targets disclose the same closed result",
      async () => {
        const missing = await get(`/operations/${randomUUID()}`);
        const hidden = await app.inject({
          method: "GET",
          url: `/namespaces/${foreign.namespace.id}/agents/${foreign.agent.id}/lifecycle/operations/${running.intent.transitionRef}`,
          headers,
        });
        assert.equal(missing.statusCode, 404);
        assert.equal(hidden.statusCode, 404);
        assert.deepEqual(safe(missing).error, safe(hidden).error);
      },
    );
    await t.test(
      "query fields and credentials cannot stand in for exact read custody",
      async () => {
        for (const suffix of [
          "?actorId=admin",
          "/operations?limit=01",
          "/operations?afterGeneration=0",
          "/operations?installationId=foreign",
        ])
          assert.equal((await get(suffix)).statusCode, 400);
        assert.equal((await get("", { headers: { host: "127.0.0.1" } })).statusCode, 401);
        assert.equal(
          (await get("", { headers: { ...headers, "x-api-key": "invalid-explicit-key" } }))
            .statusCode,
          401,
        );
        assert.deepEqual(
          await dependencies.source.readStatus(owner.scope, {
            authenticated: Object.freeze({}),
            signal: new AbortController().signal,
          }),
          { kind: "unavailable" },
        );
        assert.deepEqual(await dependencies.source.readStatus(owner.scope, calls[0]), {
          kind: "unavailable",
        });
      },
    );
    await t.test("a fresh page observes actual IAM binding revocation", async () => {
      // Only the existing table owner mutates this fixture binding; application
      // privileges remain unchanged while the request uses actual native IAM.
      await ownerPool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [binding.id]);
      try {
        const response = await get("/operations?afterGeneration=1");
        assert.equal(response.statusCode, 404);
        safe(response);
      } finally {
        await ownerPool.query(
          `INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,role_id,resource_kind,resource_id)
        VALUES($1,$2,$3,$4,$5,$6)`,
          [
            binding.id,
            binding.namespaceId,
            binding.subjectId,
            binding.roleId,
            binding.resourceKind,
            binding.resourceId,
          ],
        );
      }
    });
    await t.test(
      "actual session revocation during a blocked state read suppresses disclosure after the wait",
      async () => {
        const lock = await ownerPool.connect();
        let pending;
        try {
          await lock.query("BEGIN");
          await lock.query("LOCK TABLE occ.agents IN ACCESS EXCLUSIVE MODE");
          pending = get();
          const until = performance.now() + 1500;
          let blocked = false;
          while (performance.now() < until) {
            blocked = (
              await ownerPool.query(
                `SELECT EXISTS(SELECT 1 FROM pg_locks
          WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND relation='occ.agents'::regclass AND mode='AccessShareLock' AND NOT granted
            AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked`,
                [lock.processID],
              )
            ).rows[0].blocked;
            if (blocked) break;
            await delay(10);
          }
          assert.equal(
            blocked,
            true,
            "the actual lifecycle data read must be waiting before revocation",
          );
          const logout = await app.inject({ method: "POST", url: "/api/auth/sign-out", headers });
          assert.equal(logout.statusCode, 200, logout.body);
          await lock.query("COMMIT");
          const response = await pending;
          assert.equal(response.statusCode, 401, response.body);
          safe(response);
          assert.equal((await get()).statusCode, 401);
        } finally {
          await lock.query("ROLLBACK");
          lock.release();
          await pending;
        }
      },
    );
  },
);
