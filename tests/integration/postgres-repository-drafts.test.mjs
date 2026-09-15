import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validateNativeIAMState } from "../../packages/iam/src/index.ts";
import {
  createPostgresControllerAppFixture,
  expectStatus as expect,
} from "../helpers/postgres-controller-app.mjs";
import {
  createRepositoryScenario,
  repositoryDraft,
  deploymentCounts,
  waitForRevisionWork,
} from "../helpers/repository-drafts.mjs";

const databaseUrl = process.env.OCC_TEST_REPOSITORY_DATABASE_URL;
const id = (prefix) => `${prefix}_${randomUUID()}`;
const empty = { schemaVersion: 1, repositories: [] };

// These roles isolate binding operate from Secret operate; neither grant substitutes for the other.
const editorPermissions = [
  { action: "read", resourceKind: "repository_binding" },
  { action: "read", resourceKind: "agent" },
  { action: "update", resourceKind: "agent" },
  { action: "read", resourceKind: "configuration" },
];
const accounts = {
  admin: { name: "Repository Administrator", administrator: true },
  reader: {
    name: "Repository reader",
    permissions: [...editorPermissions, { action: "operate", resourceKind: "secret" }],
  },
  noSecret: {
    name: "Repository operator without Secret",
    permissions: [
      ...editorPermissions,
      { action: "operate", resourceKind: "repository_binding" },
      { action: "create", resourceKind: "repository_binding" },
    ],
  },
};

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
    const fixture = await createPostgresControllerAppFixture(t, { databaseUrl, accounts });
    const { pool, actors, iam, policy } = fixture;
    // Sequential scenarios share auth/composition only. The worker starts in the last scenario.
    await t.test("authenticated draft lifecycle and persistence", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-lifecycle" });
      expect(await scenario.createBinding(scenario.descriptor, null), 401);
      const binding = expect(await scenario.createBinding(), 201);
      assert.equal(binding.state, "unverified");
      assert.equal(binding.generation, 1);
      assert.equal(JSON.stringify(binding).includes("synthetic-signing-key"), false);
      assert.deepEqual(expect(await scenario.getBinding(binding), 200), binding);
      const agent = expect(await scenario.createAgent(), 201);
      assert.deepEqual(agent.repositoryAccess, empty);
      const draft = repositoryDraft(binding);
      assert.deepEqual(
        expect(await scenario.patchAgentDraft(agent, draft), 200).repositoryAccess,
        draft,
      );
      assert.deepEqual(expect(await scenario.patchAgentDraft(agent), 200).repositoryAccess, draft);
      assert.deepEqual(await scenario.readPersistedDraft(agent), draft);
      expect(
        await scenario.updateBinding(binding, {
          ...scenario.descriptor,
          repositoryIds: [789, 790],
          expectedGeneration: 1,
        }),
        200,
      );
      const replacement = repositoryDraft(binding, {
        repositoryId: 790,
        checkoutRef: "a".repeat(40),
      });
      assert.deepEqual(
        expect(await scenario.patchAgentDraft(agent, replacement), 200).repositoryAccess,
        replacement,
      );
      assert.deepEqual(
        expect(await scenario.patchAgentDraft(agent, empty), 200).repositoryAccess,
        empty,
      );
    });

    await t.test("independent binding and Secret permissions", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-permissions" });
      const binding = expect(await scenario.createBinding(), 201);
      const agent = expect(await scenario.createAgent(), 201);
      const draft = repositoryDraft(binding);
      expect(await scenario.getBinding(binding, actors.reader), 200);
      expect(await scenario.patchAgentDraft(agent, draft, actors.reader), 403);
      expect(await scenario.patchAgentDraft(agent, draft, actors.noSecret), 403);
      expect(await scenario.createBinding(scenario.descriptor, actors.noSecret), 403);
    });

    await t.test("binding compare-and-swap preserves the Agent draft", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "binding-cas" });
      const binding = expect(await scenario.createBinding(), 201);
      const agent = expect(await scenario.createAgent(), 201);
      const draft = repositoryDraft(binding);
      expect(await scenario.patchAgentDraft(agent, draft), 200);
      const updatedBinding = expect(
        await scenario.updateBinding(binding, {
          ...scenario.descriptor,
          repositoryIds: [789, 790],
          expectedGeneration: 1,
        }),
        200,
      );
      assert.equal(updatedBinding.generation, 2);
      assert.equal(updatedBinding.state, "unverified");
      expect(
        await scenario.updateBinding(binding, { ...scenario.descriptor, expectedGeneration: 1 }),
        409,
      );
      assert.deepEqual(expect(await scenario.getAgent(agent), 200).repositoryAccess, draft);
    });

    await t.test("draft and descriptor bounds agree with PostgreSQL", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-bounds" });
      const { namespace, descriptor } = scenario;
      const binding = expect(
        await scenario.createBinding({ ...descriptor, repositoryIds: [789, 790] }),
        201,
      );
      const agent = expect(await scenario.createAgent(), 201);
      const repositoryAccess = repositoryDraft(binding);
      const replacement = repositoryDraft(binding, {
        repositoryId: 790,
        checkoutRef: "a".repeat(40),
      });
      for (const [name, value] of [
        ["unsupported schema", { ...repositoryAccess, schemaVersion: 2 }],
        ["unknown field", { ...repositoryAccess, views: [] }],
        [
          "too many selections",
          { ...repositoryAccess, repositories: Array(9).fill(repositoryAccess.repositories[0]) },
        ],
        [
          "duplicate selections",
          { ...repositoryAccess, repositories: Array(2).fill(repositoryAccess.repositories[0]) },
        ],
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
        ].map((checkoutRef) => [
          `invalid checkout ref ${JSON.stringify(checkoutRef)}`,
          {
            ...repositoryAccess,
            repositories: [{ ...repositoryAccess.repositories[0], checkoutRef }],
          },
        ]),
        [
          "enabled publication",
          {
            ...repositoryAccess,
            repositories: [
              { ...repositoryAccess.repositories[0], publication: { mode: "enabled" } },
            ],
          },
        ],
        [
          "repository outside the binding",
          {
            ...repositoryAccess,
            repositories: [{ ...repositoryAccess.repositories[0], repositoryId: 999 }],
          },
        ],
        [
          "nonexistent binding",
          {
            ...repositoryAccess,
            repositories: [
              {
                ...repositoryAccess.repositories[0],
                bindingRef: { ...repositoryAccess.repositories[0].bindingRef, id: id("rb") },
              },
            ],
          },
        ],
      ])
        assert.ok(
          [400, 404].includes((await scenario.patchAgentDraft(agent, value)).status),
          `${name} must be rejected: ${JSON.stringify(value)}`,
        );
      // PostgreSQL and the codec enforce the same UTF-16 bound for supplementary characters.
      for (const [count, accepted] of [
        [122, true],
        [130, false],
      ]) {
        const unicodeDraft = {
          ...repositoryAccess,
          repositories: [
            {
              ...repositoryAccess.repositories[0],
              checkoutRef: `refs/heads/${"😀".repeat(count)}`,
            },
          ],
        };
        const sql = await pool.query("SELECT occ.repository_access_valid($1::jsonb,$2) AS valid", [
          JSON.stringify(unicodeDraft),
          namespace.id,
        ]);
        assert.equal(sql.rows[0].valid, accepted);
        expect(await scenario.patchAgentDraft(agent, unicodeDraft), accepted ? 200 : 400);
      }
      expect(await scenario.patchAgentDraft(agent, replacement), 200);
      for (const [name, value] of [
        ["duplicate repositories", { ...descriptor, repositoryIds: [789, 789] }],
        [
          "too many repositories",
          { ...descriptor, repositoryIds: Array.from({ length: 33 }, (_, i) => i + 1) },
        ],
        ["server-owned state", { ...descriptor, state: "verified" }],
        ["zero app ID", { ...descriptor, appId: 0 }],
        ["server-owned generation", { ...descriptor, generation: 99 }],
      ]) {
        const response = await scenario.createBinding(value);
        assert.equal(response.status, 400, `${name}: ${JSON.stringify(response.body)}`);
      }
      const maximalBinding = expect(
        await scenario.createBinding({
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
        expect(await scenario.patchAgentDraft(agent, maximalDraft), 200).repositoryAccess,
        maximalDraft,
      );
      expect(await scenario.patchAgentDraft(agent, replacement), 200);
    });

    await t.test("exact Namespace and IAM scope", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-scope" });
      const other = await createRepositoryScenario(fixture, { name: "foreign-draft-scope" });
      const binding = expect(await scenario.createBinding(), 201);
      const agent = expect(await scenario.createAgent(), 201);
      expect(await other.getBinding(binding), 404);
      expect(await other.createBinding(scenario.descriptor), 404);
      const foreignDraft = repositoryDraft({ ...binding, namespaceId: other.namespace.id });
      expect(await scenario.patchAgentDraft(agent, foreignDraft), 404);
      assert.equal(
        (
          await iam.authorize({
            principalId: actors.admin.principal.id,
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
                effect: "deny",
                action: "read",
                resourceKind: "repository_binding",
                resourceId: binding.id,
                reason: "test",
              };
        assert.throws(
          () => validateNativeIAMState({ ...policy, [collection]: [invalid] }),
          /targets a repository binding without a Namespace/,
        );
        assert.doesNotThrow(() =>
          validateNativeIAMState({
            ...policy,
            [collection]: [{ ...invalid, namespaceId: scenario.namespace.id }],
          }),
        );
      }
    });

    await t.test("duplicate audit primary keys roll back repository mutations", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-audit" });
      const binding = expect(
        await scenario.createBinding({ ...scenario.descriptor, repositoryIds: [789, 790] }),
        201,
      );
      const agent = expect(await scenario.createAgent(), 201);
      const replacement = repositoryDraft(binding, {
        repositoryId: 790,
        checkoutRef: "a".repeat(40),
      });
      expect(await scenario.patchAgentDraft(agent, replacement), 200);
      // An actual duplicate audit PK aborts the same database transaction as the mutation.
      await fixture.withAuditCollision(async () => {
        const beforeFailure = await pool.query(
          "SELECT count(*)::int count FROM occ.repository_bindings",
        );
        assert.ok((await scenario.createBinding()).status >= 400);
        assert.deepEqual(
          (await pool.query("SELECT count(*)::int count FROM occ.repository_bindings")).rows,
          beforeFailure.rows,
        );
        assert.ok((await scenario.patchAgentDraft(agent, empty)).status >= 400);
        assert.deepEqual(await scenario.readPersistedDraft(agent), replacement);
      });
    });

    await t.test("database ownership and signing Secret lifetime constraints", async () => {
      const scenario = await createRepositoryScenario(fixture, { name: "draft-constraints" });
      const other = await createRepositoryScenario(fixture, { name: "foreign-constraints" });
      const { secret } = scenario;
      const foreignSecret = other.secret;
      const binding = expect(await scenario.createBinding(), 201);
      const updatedBinding = expect(
        await scenario.updateBinding(binding, {
          ...scenario.descriptor,
          repositoryIds: [789, 790],
          expectedGeneration: 1,
        }),
        200,
      );
      const agent = expect(await scenario.createAgent(), 201);
      const replacement = repositoryDraft(binding, {
        repositoryId: 790,
        checkoutRef: "a".repeat(40),
      });
      expect(await scenario.patchAgentDraft(agent, replacement), 200);
      const foreignDraft = repositoryDraft({ ...binding, namespaceId: other.namespace.id });
      // The binding alone retains its signing Secret, even without an admitted revision.
      expect(
        await fixture.request(actors.admin, "DELETE", `${scenario.base}/secrets/${secret.ref.id}`),
        409,
      );
      await assert.rejects(pool.query("DELETE FROM occ.secrets WHERE id = $1", [secret.ref.id]), {
        code: "23503",
      });
      // A structurally valid descriptor cannot move the signing key across Namespaces.
      const foreignKeyBinding = {
        ...updatedBinding,
        generation: 3,
        keySecretRef: { ...secret.ref, id: foreignSecret.ref.id },
      };
      await assert.rejects(
        pool.query(
          `UPDATE occ.repository_bindings
         SET key_secret_id = $2, generation = $3, descriptor = $4::jsonb
         WHERE id = $1`,
          [binding.id, foreignSecret.ref.id, 3, JSON.stringify(foreignKeyBinding)],
        ),
        { code: "23503" },
      );
      assert.deepEqual(expect(await scenario.getBinding(binding), 200), updatedBinding);
      await assert.rejects(
        pool.query("UPDATE occ.repository_bindings SET generation=generation+2 WHERE id=$1", [
          binding.id,
        ]),
        { code: "23514" },
      );
      await assert.rejects(
        pool.query("UPDATE occ.repository_bindings SET id=$2 WHERE id=$1", [binding.id, id("rb")]),
      );
      await assert.rejects(
        pool.query("UPDATE occ.repository_bindings SET namespace_id=$2 WHERE id=$1", [
          binding.id,
          other.namespace.id,
        ]),
      );
      await assert.rejects(
        pool.query("UPDATE occ.agents SET repository_access=$2::jsonb WHERE id=$1", [
          agent.id,
          JSON.stringify(foreignDraft),
        ]),
      );
      assert.deepEqual(
        expect(await scenario.patchAgentDraft(agent, empty), 200).repositoryAccess,
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
    });

    await t.test(
      "nonempty admission has no effect and the empty draft worker succeeds",
      async (workerTest) => {
        const scenario = await createRepositoryScenario(fixture, { name: "draft-admission" });
        const binding = expect(await scenario.createBinding(), 201);
        const agent = expect(await scenario.createAgent(), 201);
        expect(await scenario.patchAgentDraft(agent, repositoryDraft(binding)), 200);
        const beforeDeploy = await deploymentCounts(pool);
        const inactiveDeployment = await scenario.deployAgent(agent);
        expect(inactiveDeployment, 503);
        assert.equal(inactiveDeployment.body.error.code, "REPOSITORY_VERIFICATION_UNAVAILABLE");
        assert.deepEqual(await deploymentCounts(pool), beforeDeploy);
        assert.deepEqual(
          expect(await scenario.patchAgentDraft(agent, empty), 200).repositoryAccess,
          empty,
        );
        const revision = expect(await scenario.deployAgent(agent), 202);
        assert.equal(revision.agentId, agent.id);
        // The real worker consumes admitted work; only the external Compute boundary is deterministic.
        await fixture.startWorker(workerTest);
        assert.equal(
          await waitForRevisionWork(pool, revision.id),
          "succeeded",
          "worker must complete the actual no-repository revision",
        );
      },
    );
  },
);
