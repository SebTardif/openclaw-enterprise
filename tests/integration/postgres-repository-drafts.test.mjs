import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver, validateNativeIAMState } from "../../packages/iam/src/index.ts";
import { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { signInToControllerApp, authenticatedHeaders } from "../helpers/auth-session.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";

const databaseUrl = process.env.OCC_TEST_REPOSITORY_DATABASE_URL;
const id = (prefix) => `${prefix}_${randomUUID()}`;
const empty = { schemaVersion: 1, repositories: [] };

// A dedicated fresh migrated database is required because this fixture bootstraps
// the real Installation, accounts, and administrator policy.
test(
  "authenticated repository drafts persist under application-role PostgreSQL and stay inactive",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_REPOSITORY_DATABASE_URL to a fresh migrated application-role database.",
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    t.after(() => pool.end());
    assert.equal((await pool.query("SELECT current_user AS name")).rows[0].name, "occ_app");
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM occ.installation")).rows[0].count,
      0,
      "use a fresh dedicated migrated database",
    );
    const installation = {
      id: id("ins"),
      name: "Repository definitions",
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
    const credentials = {
      email: `admin-${randomUUID()}@example.com`,
      password: `test-${randomUUID()}`,
      name: "Repository Administrator",
    };
    const admin = auth.principalSeed(await auth.createAccount(credentials));
    const editorCredentials = {
      email: `editor-${randomUUID()}@example.com`,
      password: `test-${randomUUID()}`,
      name: "Repository Reader",
    };
    const editor = auth.principalSeed(await auth.createAccount(editorCredentials));
    const noSecretCredentials = {
      email: `editor-${randomUUID()}@example.com`,
      password: `test-${randomUUID()}`,
      name: "Repository Operator Without Secret",
    };
    const noSecret = auth.principalSeed(await auth.createAccount(noSecretCredentials));
    const editorPermissions = [
      { action: "read", resourceKind: "repository_binding" },
      { action: "read", resourceKind: "agent" },
      { action: "update", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ];
    const policy = {
      identities: [admin.principal, editor.principal, noSecret.principal],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        ...admin.roles,
        {
          id: "repository-reader",
          name: "Repository reader",
          permissions: [...editorPermissions, { action: "operate", resourceKind: "secret" }],
        },
        {
          id: "repository-no-secret",
          name: "Repository operator",
          permissions: [
            ...editorPermissions,
            { action: "operate", resourceKind: "repository_binding" },
            { action: "create", resourceKind: "repository_binding" },
          ],
        },
      ],
      bindings: [
        {
          id: "admin-binding",
          subjectKind: "identity",
          subjectId: admin.principal.id,
          roleId: admin.roles[0].id,
        },
        {
          id: "reader-binding",
          subjectKind: "identity",
          subjectId: editor.principal.id,
          roleId: "repository-reader",
        },
        {
          id: "no-secret-binding",
          subjectKind: "identity",
          subjectId: noSecret.principal.id,
          roleId: "repository-no-secret",
        },
      ],
    };
    const state = new PostgresPlatformState(pool, { bootstrapNativeIAM: policy });
    await state.transact((unit) => unit.installations.createInstallation(installation));
    const iam = new NativeIAMDriver(state, { id: "native-iam" });
    const compute = createDevelopmentComputeDriver();
    const controller = new OpenClawController(installation, {
      state,
      recordOperations: true,
    });
    const configurationDriver = createTestConfigurationDriver();
    const secretDriver = createTestSecretDriver();
    for (const driver of [iam, compute, configurationDriver, secretDriver]) {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    }
    let collideAuditId;
    const app = createFastifyApp({
      controller,
      auth,
      iamDriver: iam,
      computeDriver: compute,
      configurationDriver,
      secretDriver,
      resolveHarness: resolveApprovedHarness,
      auditSink: state.auditSink,
      development: { enabled: true, installationId: installation.id },
      auditEventFactory: new AuditEventFactory({ idGenerator: () => collideAuditId ?? id("aud") }),
    });
    t.after(() => app.close());
    const session = await signInToControllerApp(app, credentials);
    const readerSession = await signInToControllerApp(app, editorCredentials);
    const noSecretSession = await signInToControllerApp(app, noSecretCredentials);
    const request = async (method, url, payload, selectedSession = session) => {
      const response = await app.inject({
        method,
        url,
        remoteAddress: "127.0.0.1",
        headers: {
          host: "127.0.0.1",
          ...(selectedSession ? authenticatedHeaders(selectedSession) : {}),
        },
        ...(payload === undefined ? {} : { payload }),
      });
      return { status: response.statusCode, body: response.json(), data: response.json().data };
    };
    const expect = (response, code) => {
      assert.equal(response.status, code, JSON.stringify(response.body));
      return response.data;
    };
    const namespace = expect(
      await request("POST", "/namespaces", { name: "repository-drafts" }),
      201,
    );
    await controller.handleNamespaceLifecycle(admin.principal.id, namespace.id, "ready");
    const base = `/namespaces/${namespace.id}`;
    const configuration = expect(
      await request("POST", `${base}/configurations`, { kind: "agent", values: {} }),
      201,
    );
    const secret = expect(
      await request("POST", `${base}/secrets`, {
        name: "Signing key reference",
        value: "synthetic-signing-key",
      }),
      201,
    );
    const descriptor = {
      appId: 123,
      installationId: 456,
      repositoryIds: [789],
      keySecretRef: secret.ref,
    };
    expect(await request("POST", `${base}/repository-bindings`, descriptor, null), 401);
    const binding = expect(await request("POST", `${base}/repository-bindings`, descriptor), 201);
    assert.equal(binding.state, "unverified");
    assert.equal(binding.generation, 1);
    assert.equal(JSON.stringify(binding).includes("synthetic-signing-key"), false);
    assert.deepEqual(
      expect(await request("GET", `${base}/repository-bindings/${binding.id}`), 200),
      binding,
    );
    const repositoryAccess = {
      schemaVersion: 1,
      repositories: [
        {
          bindingRef: { kind: "repository_binding", namespaceId: namespace.id, id: binding.id },
          repositoryId: 789,
          checkoutRef: "refs/heads/main",
          readProfile: "checkout",
          publication: { mode: "disabled" },
        },
      ],
    };
    const agent = expect(
      await request("POST", `${base}/agents`, {
        name: "Draft agent",
        configurationId: configuration.id,
      }),
      201,
    );
    assert.deepEqual(agent.repositoryAccess, empty);
    const agentPath = `${base}/agents/${agent.id}`;
    const updateAgent = (value) => ({
      configurationId: configuration.id,
      ...(value === undefined ? {} : { repositoryAccess: value }),
    });
    assert.deepEqual(
      expect(await request("PATCH", agentPath, updateAgent(repositoryAccess)), 200)
        .repositoryAccess,
      repositoryAccess,
    );
    assert.deepEqual(
      expect(await request("PATCH", agentPath, updateAgent()), 200).repositoryAccess,
      repositoryAccess,
    );
    assert.deepEqual(
      (
        await new PostgresPlatformState(pool).read((unit) =>
          unit.agents.findAgent(namespace.id, agent.id),
        )
      ).repositoryAccess,
      repositoryAccess,
    );
    expect(
      await request("GET", `${base}/repository-bindings/${binding.id}`, undefined, readerSession),
      200,
    );
    expect(await request("PATCH", agentPath, updateAgent(repositoryAccess), readerSession), 403);
    expect(await request("PATCH", agentPath, updateAgent(repositoryAccess), noSecretSession), 403);
    expect(await request("POST", `${base}/repository-bindings`, descriptor, noSecretSession), 403);
    const counts = async () =>
      (
        await pool.query(
          "SELECT (SELECT count(*)::int FROM occ.agent_revisions) revisions, (SELECT count(*)::int FROM occ.controller_work) work",
        )
      ).rows[0];
    const beforeDeploy = await counts();
    const inactiveDeployment = await request("POST", `${agentPath}/deploy`);
    expect(inactiveDeployment, 503);
    assert.equal(inactiveDeployment.body.error.code, "REPOSITORY_VERIFICATION_UNAVAILABLE");
    assert.deepEqual(await counts(), beforeDeploy);
    const updatedBinding = expect(
      await request("PATCH", `${base}/repository-bindings/${binding.id}`, {
        ...descriptor,
        repositoryIds: [789, 790],
        expectedGeneration: 1,
      }),
      200,
    );
    assert.equal(updatedBinding.generation, 2);
    assert.equal(updatedBinding.state, "unverified");
    expect(
      await request("PATCH", `${base}/repository-bindings/${binding.id}`, {
        ...descriptor,
        expectedGeneration: 1,
      }),
      409,
    );
    assert.deepEqual(
      expect(await request("GET", agentPath), 200).repositoryAccess,
      repositoryAccess,
    );
    const replacement = {
      ...repositoryAccess,
      repositories: [
        { ...repositoryAccess.repositories[0], repositoryId: 790, checkoutRef: "a".repeat(40) },
      ],
    };
    assert.deepEqual(
      expect(await request("PATCH", agentPath, updateAgent(replacement)), 200).repositoryAccess,
      replacement,
    );
    for (const value of [
      { ...repositoryAccess, schemaVersion: 2 },
      { ...repositoryAccess, views: [] },
      { ...repositoryAccess, repositories: Array(9).fill(repositoryAccess.repositories[0]) },
      { ...repositoryAccess, repositories: Array(2).fill(repositoryAccess.repositories[0]) },
      ...[
        "main",
        "refs/heads/a..b",
        "refs/heads/a.lock",
        "refs/heads/.hidden",
        "refs/heads/a//b",
        "refs/heads/a@{1}",
        "refs/heads/a\\b",
        "refs/heads/a\u007f",
        "refs/heads/a\u0085",
        `refs/heads/${"x".repeat(256)}`,
      ].map((checkoutRef) => ({
        ...repositoryAccess,
        repositories: [{ ...repositoryAccess.repositories[0], checkoutRef }],
      })),
      {
        ...repositoryAccess,
        repositories: [{ ...repositoryAccess.repositories[0], publication: { mode: "enabled" } }],
      },
      {
        ...repositoryAccess,
        repositories: [{ ...repositoryAccess.repositories[0], repositoryId: 999 }],
      },
      {
        ...repositoryAccess,
        repositories: [
          {
            ...repositoryAccess.repositories[0],
            bindingRef: { ...repositoryAccess.repositories[0].bindingRef, id: id("rb") },
          },
        ],
      },
    ])
      assert.ok(
        [400, 404].includes((await request("PATCH", agentPath, updateAgent(value))).status),
      );
    // PostgreSQL and the codec enforce the same UTF-16 bound for supplementary characters.
    for (const [count, accepted] of [
      [122, true],
      [130, false],
    ]) {
      const unicodeDraft = {
        ...repositoryAccess,
        repositories: [
          { ...repositoryAccess.repositories[0], checkoutRef: `refs/heads/${"😀".repeat(count)}` },
        ],
      };
      const sql = await pool.query("SELECT occ.repository_access_valid($1::jsonb,$2) AS valid", [
        JSON.stringify(unicodeDraft),
        namespace.id,
      ]);
      assert.equal(sql.rows[0].valid, accepted);
      expect(await request("PATCH", agentPath, updateAgent(unicodeDraft)), accepted ? 200 : 400);
    }
    expect(await request("PATCH", agentPath, updateAgent(replacement)), 200);
    for (const value of [
      { ...descriptor, repositoryIds: [789, 789] },
      { ...descriptor, repositoryIds: Array.from({ length: 33 }, (_, i) => i + 1) },
      { ...descriptor, state: "verified" },
      { ...descriptor, appId: 0 },
      { ...descriptor, generation: 99 },
    ])
      expect(await request("POST", `${base}/repository-bindings`, value), 400);
    const maximalBinding = expect(
      await request("POST", `${base}/repository-bindings`, {
        ...descriptor,
        repositoryIds: Array.from({ length: 32 }, (_, i) => i + 1),
      }),
      201,
    );
    const maximalDraft = {
      schemaVersion: 1,
      repositories: Array.from({ length: 8 }, (_, i) => ({
        ...repositoryAccess.repositories[0],
        bindingRef: { ...repositoryAccess.repositories[0].bindingRef, id: maximalBinding.id },
        repositoryId: i + 1,
        checkoutRef: "refs/tags/release-v1",
      })),
    };
    assert.deepEqual(
      expect(await request("PATCH", agentPath, updateAgent(maximalDraft)), 200).repositoryAccess,
      maximalDraft,
    );
    expect(await request("PATCH", agentPath, updateAgent(replacement)), 200);
    const other = expect(
      await request("POST", "/namespaces", { name: "other-repository-namespace" }),
      201,
    );
    expect(await request("GET", `/namespaces/${other.id}/repository-bindings/${binding.id}`), 404);
    expect(await request("POST", `/namespaces/${other.id}/repository-bindings`, descriptor), 404);
    const foreignDraft = {
      ...repositoryAccess,
      repositories: [
        {
          ...repositoryAccess.repositories[0],
          bindingRef: { ...repositoryAccess.repositories[0].bindingRef, namespaceId: other.id },
        },
      ],
    };
    expect(await request("PATCH", agentPath, updateAgent(foreignDraft)), 404);
    assert.equal(
      (
        await iam.authorize({
          principalId: admin.principal.id,
          action: "read",
          resource: { kind: "repository_binding", id: binding.id },
        })
      ).allowed,
      false,
    );
    for (const collection of ["bindings", "restrictions"]) {
      const invalid =
        collection === "bindings"
          ? { ...policy.bindings[0], resourceKind: "repository_binding", resourceId: binding.id }
          : {
              id: "restriction",
              action: "read",
              resourceKind: "repository_binding",
              resourceId: binding.id,
              reason: "test",
            };
      assert.throws(() => validateNativeIAMState({ ...policy, [collection]: [invalid] }));
    }
    // An actual duplicate audit PK aborts the same database transaction as the mutation.
    collideAuditId = (await pool.query("SELECT id FROM occ.audit_events LIMIT 1")).rows[0].id;
    const beforeFailure = await pool.query(
      "SELECT count(*)::int count FROM occ.repository_bindings",
    );
    assert.ok((await request("POST", `${base}/repository-bindings`, descriptor)).status >= 400);
    assert.deepEqual(
      (await pool.query("SELECT count(*)::int count FROM occ.repository_bindings")).rows,
      beforeFailure.rows,
    );
    assert.ok((await request("PATCH", agentPath, updateAgent(empty))).status >= 400);
    assert.deepEqual(
      (await state.read((unit) => unit.agents.findAgent(namespace.id, agent.id))).repositoryAccess,
      replacement,
    );
    collideAuditId = undefined;
    await assert.rejects(
      pool.query("UPDATE occ.repository_bindings SET generation=generation+2 WHERE id=$1", [
        binding.id,
      ]),
    );
    await assert.rejects(
      pool.query("UPDATE occ.repository_bindings SET id=$2 WHERE id=$1", [binding.id, id("rb")]),
    );
    await assert.rejects(
      pool.query("UPDATE occ.repository_bindings SET namespace_id=$2 WHERE id=$1", [
        binding.id,
        other.id,
      ]),
    );
    await assert.rejects(
      pool.query("UPDATE occ.agents SET repository_access=$2::jsonb WHERE id=$1", [
        agent.id,
        JSON.stringify(foreignDraft),
      ]),
    );
    assert.deepEqual(
      expect(await request("PATCH", agentPath, updateAgent(empty)), 200).repositoryAccess,
      empty,
    );
    // JSONB accepts 790 and 790.0 as equal numbers; duplicate checks must do so too.
    const numericEntry = JSON.stringify(replacement.repositories[0]);
    const duplicateNumericDraft = `{"schemaVersion":1,"repositories":[${numericEntry},${numericEntry.replace('"repositoryId":790', '"repositoryId":790.0')}]}`;
    await assert.rejects(
      pool.query("UPDATE occ.agents SET repository_access=$2::jsonb WHERE id=$1", [
        agent.id,
        duplicateNumericDraft,
      ]),
    );
    const revision = expect(await request("POST", `${agentPath}/deploy`), 202);
    assert.equal(revision.agentId, agent.id);
    // The real worker consumes actual admitted work; only the external Compute boundary is deterministic.
    const workerPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const worker = createControllerWorker({
      pool: workerPool,
      computeDriver: compute,
      pollIntervalMs: 10,
      emit: () => {},
    });
    t.after(() => worker.stop());
    await worker.start();
    let completed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await pool.query(
        "SELECT state FROM occ.controller_work WHERE revision_id=$1",
        [revision.id],
      );
      if (result.rows[0]?.state === "succeeded") {
        completed = true;
        break;
      }
      await delay(25);
    }
    assert.equal(completed, true, "worker must complete the actual no-repository revision");
  },
);
