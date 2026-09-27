import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  seedSessionRevision,
  sessionAttempt,
  verifyRepositorySessions,
} from "../conformance/repository-sessions.contract.mjs";
import {
  repositoryBinding,
  repositoryCredentials,
  repositoryGrant,
} from "../fixtures/repository-credentials/session-state.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;

function insertAttempt(
  pool,
  input,
  phase = "opening",
  sessionId = null,
  updatedAt = input.createdAt,
) {
  return pool.query(
    `INSERT INTO occ.repository_session_attempts
       (namespace_id, agent_id, revision_id, repository_ref, admission_id,
        duration_seconds, deadline_wall_ms, phase, session_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.namespaceId,
      input.agentId,
      input.revisionId,
      input.repositoryRef,
      input.admissionId,
      input.durationSeconds,
      input.deadlineWallMs,
      phase,
      sessionId,
      input.createdAt,
      updatedAt,
    ],
  );
}

test(
  "PostgreSQL repository sessions enforce durable admission boundaries",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
    timeout: 60_000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await verifyRepositorySessions(t, store);

    await t.test(
      "SQL rejects owner mismatches, unadmitted repositories and altered deadlines",
      async (t) => {
        const { revision } = await seedSessionRevision(store);
        const other = await seedSessionRevision(store);
        const foreignOwners = {
          "namespace belongs to another revision": { namespaceId: other.namespace.id },
          "agent belongs to another revision": { agentId: other.agent.id },
          "revision does not exist": { revisionId: `rev_${randomUUID()}` },
        };
        for (const [name, override] of Object.entries(foreignOwners)) {
          await t.test(name, async () => {
            await assert.rejects(insertAttempt(pool, sessionAttempt(revision, override)), {
              code: "23503",
            });
          });
        }
        const invalidAttempts = {
          "repository was not admitted": { repositoryRef: "unadmitted" },
          "deadline differs from the admitted deadline": {
            deadlineWallMs: revision.repositoryCredentials.deadlineWallMs + 1,
          },
          "duration is zero": { durationSeconds: 0 },
          "duration is negative": { durationSeconds: -1 },
          "duration exceeds the safe integer range": { durationSeconds: "9007199254740992" },
          "admission identity contains a space": { admissionId: "bad admission" },
          "admission identity ends with a newline": { admissionId: "admission\n" },
          "admission identity exceeds 128 characters": { admissionId: "a".repeat(129) },
        };
        for (const [name, override] of Object.entries(invalidAttempts)) {
          await t.test(name, async () => {
            await assert.rejects(insertAttempt(pool, sessionAttempt(revision, override)), {
              code: "23514",
            });
          });
        }
        await t.test("phase is unknown", async () => {
          await assert.rejects(insertAttempt(pool, sessionAttempt(revision), "unknown"), {
            code: "23514",
          });
        });
        await t.test("opening attempt already has a session identity", async () => {
          await assert.rejects(
            insertAttempt(pool, sessionAttempt(revision), "opening", "session-present"),
            { code: "23514" },
          );
        });
        await t.test("creation time is infinite", async () => {
          await assert.rejects(
            insertAttempt(pool, sessionAttempt(revision, { createdAt: "infinity" })),
            { code: "23514" },
          );
        });
        await t.test("update time precedes creation", async () => {
          await assert.rejects(
            insertAttempt(
              pool,
              sessionAttempt(revision),
              "opening",
              null,
              "2030-03-17T17:46:39.000Z",
            ),
            { code: "23514" },
          );
        });
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::integer AS count FROM occ.repository_session_attempts WHERE revision_id = $1",
              [revision.id],
            )
          ).rows[0].count,
          0,
        );
      },
    );

    await t.test(
      "SQL uniqueness and lifecycle retain one active admission and immutable session IDs",
      async () => {
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        await assert.rejects(insertAttempt(pool, input), { code: "23505" });
        await assert.rejects(insertAttempt(pool, sessionAttempt(revision)), { code: "23505" });
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        const sessionId = `session-${randomUUID()}`;
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [input.admissionId, "session\n"],
          ),
          { code: "23514" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
          [input.admissionId, sessionId],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET session_id = NULL WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'closing', session_id = 'replacement' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "55000" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'closing' WHERE admission_id = $1",
          [input.admissionId],
        );
        // Cleanup evidence remains while a replacement admission can be persisted.
        const replacement = sessionAttempt(revision);
        await insertAttempt(pool, replacement);
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open', session_id = $2 WHERE admission_id = $1",
            [replacement.admissionId, sessionId],
          ),
          { code: "23505" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'disposed' WHERE admission_id = $1",
          [input.admissionId],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'open' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
      },
    );

    await t.test(
      "application grants permit lifecycle changes while protecting identity and history",
      async () => {
        const role = (
          await pool.query(
            "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
          )
        ).rows[0];
        assert.equal(role.name, "occ_app");
        assert.equal(role.rolsuper, false);
        assert.equal(role.rolbypassrls, false);
        const { revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        for (const column of [
          "namespace_id",
          "agent_id",
          "revision_id",
          "live_revision_id",
          "cleanup_context",
          "repository_ref",
          "admission_id",
          "duration_seconds",
          "deadline_wall_ms",
          "created_at",
        ]) {
          await assert.rejects(
            pool.query(
              `UPDATE occ.repository_session_attempts SET ${column} = ${column} WHERE admission_id = $1`,
              [input.admissionId],
            ),
            { code: "42501" },
          );
        }
        await assert.rejects(
          pool.query("DELETE FROM occ.repository_session_attempts WHERE admission_id = $1", [
            input.admissionId,
          ]),
          { code: "42501" },
        );
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'invalidated', updated_at = $2 WHERE admission_id = $1",
          [input.admissionId, "2030-03-17T17:46:41.000Z"],
        );
        assert.equal(
          (await store.read((view) => view.repositorySessions.findAttempt(input.admissionId)))
            .phase,
          "invalidated",
        );
      },
    );

    await t.test(
      "explicit recovery can abandon exact invalidated attempts after deletion cleanup evidence",
      async () => {
        const { namespace, agent, revision } = await seedSessionRevision(store);
        const input = sessionAttempt(revision);
        await insertAttempt(pool, input);
        await pool.query(
          "UPDATE occ.repository_session_attempts SET phase = 'invalidated', updated_at = $2 WHERE admission_id = $1",
          [input.admissionId, "2030-03-17T17:46:41.000Z"],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'abandoned', live_revision_id = NULL WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          store.transact((unit) =>
            unit.repositorySessions.abandonCleanupAttempts({
              namespaceId: namespace.id,
              agentId: agent.id,
              admissionIds: [input.admissionId],
              updatedAt: "2030-03-17T17:46:42.000Z",
            }),
          ),
          { name: "ScopeViolationError" },
        );

        const workId = `agent:${agent.id}:delete`;
        await pool.query(
          "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE namespace_id = $1 AND id = $2",
          [namespace.id, agent.id],
        );
        await pool.query(
          `INSERT INTO occ.controller_work (
             idempotency_key, namespace_id, agent_id, revision_id, actor_id,
             namespace_target, agent_target, state, available_at, attempt_count, created_at, updated_at
           ) VALUES ($1,$2,$3,NULL,$4,NULL,'deleted','queued',$5,1,$5,$5)`,
          [workId, namespace.id, agent.id, "operator", "2030-03-17T17:46:42.000Z"],
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.controller_work SET deletion_teardown_completed_at = clock_timestamp() WHERE idempotency_key = $1",
            [workId],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.controller_work (
               idempotency_key, namespace_id, agent_id, revision_id, actor_id,
               namespace_target, agent_target, state, available_at, attempt_count,
               deletion_teardown_completed_at, deletion_teardown_claim_token, created_at, updated_at
             ) VALUES ($1,$2,$3,NULL,$4,NULL,'deleted','queued',$5,1,$5,$6,$5,$5)`,
            [
              `${workId}:forged`,
              namespace.id,
              agent.id,
              "operator",
              "2030-03-17T17:46:42.000Z",
              randomUUID(),
            ],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          store.transact((unit) =>
            unit.repositorySessions.abandonCleanupAttempts({
              namespaceId: namespace.id,
              agentId: agent.id,
              admissionIds: [input.admissionId],
              updatedAt: "2030-03-17T17:46:42.000Z",
            }),
          ),
          { name: "ScopeViolationError" },
        );

        const claim = randomUUID();
        await pool.query(
          `UPDATE occ.controller_work
           SET state = 'claimed', claim_token = $2, lease_expires_at = $3, updated_at = $3
           WHERE idempotency_key = $1`,
          [workId, claim, "2030-03-17T17:56:43.000Z"],
        );
        assert.equal(
          (
            await pool.query("SELECT occ.finalize_agent_deletion($1,$2,$3,$4) AS completed", [
              namespace.id,
              agent.id,
              workId,
              claim,
            ])
          ).rows[0].completed,
          null,
        );
        assert.equal(
          (
            await pool.query(
              `SELECT deletion_teardown_completed_at IS NOT NULL AS recorded
               FROM occ.controller_work WHERE idempotency_key = $1`,
              [workId],
            )
          ).rows[0].recorded,
          true,
        );
        await assert.rejects(
          store.transact((unit) =>
            unit.repositorySessions.abandonCleanupAttempts({
              namespaceId: namespace.id,
              agentId: agent.id,
              admissionIds: [`missing-${input.admissionId}`],
              updatedAt: "2030-03-17T17:46:43.000Z",
            }),
          ),
          { name: "ScopeViolationError" },
        );
        const abandoned = await store.transact((unit) =>
          unit.repositorySessions.abandonCleanupAttempts({
            namespaceId: namespace.id,
            agentId: agent.id,
            admissionIds: [input.admissionId],
            updatedAt: "2030-03-17T17:46:43.000Z",
          }),
        );
        assert.equal(abandoned.length, 1);
        assert.equal(abandoned[0].phase, "abandoned");
        assert.equal(abandoned[0].liveRevisionId, null);
        assert.deepEqual(abandoned[0].cleanupContext, {
          driver: revision.repositoryCredentials.driver,
          binding: revision.repositoryCredentials.bindings[0],
        });
        await assert.rejects(
          pool.query(
            "UPDATE occ.repository_session_attempts SET phase = 'opening' WHERE admission_id = $1",
            [input.admissionId],
          ),
          { code: "23514" },
        );
        assert.equal(
          (
            await pool.query("SELECT occ.finalize_agent_deletion($1,$2,$3,$4) AS completed", [
              namespace.id,
              agent.id,
              workId,
              claim,
            ])
          ).rows[0].completed,
          true,
        );
        const retained = await store.read((view) =>
          view.repositorySessions.findAttempt(input.admissionId),
        );
        assert.equal(retained.phase, "abandoned");
        assert.equal(retained.liveRevisionId, null);
        assert.equal(
          await store.read((view) => view.agents.findAgent(namespace.id, agent.id)),
          undefined,
        );
      },
    );

    await t.test("session admission serializes behind deleting ownership", async () => {
      const { namespace, agent, revision } = await seedSessionRevision(store);
      const deleting = await pool.connect();
      const admission = await pool.connect();
      try {
        const admissionPid = (await admission.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await deleting.query("BEGIN");
        await deleting.query("SELECT id FROM occ.namespaces WHERE id = $1 FOR UPDATE", [
          namespace.id,
        ]);
        await deleting.query(
          "UPDATE occ.agents SET desired_runtime_state = 'stopped', status = 'deleting' WHERE id = $1",
          [agent.id],
        );
        const pending = insertAttempt(admission, sessionAttempt(revision));
        const refused = assert.rejects(pending, { code: "23514" });
        const timeout = Date.now() + 5_000;
        while (
          !(
            await pool.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
              admissionPid,
            ])
          ).rows[0].blocked
        ) {
          assert.ok(Date.now() < timeout, "admission must wait on its Namespace owner");
          await delay(10);
        }
        // The owner commits deletion before the waiting INSERT may validate admission.
        await deleting.query("COMMIT");
        await refused;
        assert.deepEqual(
          await store.read((view) =>
            view.repositorySessions.listRevisionAttempts({
              namespaceId: namespace.id,
              agentId: agent.id,
              revisionId: revision.id,
            }),
          ),
          [],
        );
      } finally {
        await deleting.query("ROLLBACK");
        deleting.release();
        admission.release();
      }
    });

    await t.test(
      "SQL validates canonical draft and immutable revision repository snapshots",
      async (t) => {
        const { agent, revision } = await seedSessionRevision(store);
        const invalidDrafts = {
          "bindings are empty": [],
          "repository reference ends with a newline": [
            { repositoryRef: "source\n", profile: "git-read" },
          ],
          "profile ends with a newline": [{ repositoryRef: "source", profile: "git-read\n" }],
          "binding contains an extra field": [
            { repositoryRef: "source", profile: "read", bearer: "extra" },
          ],
          "repository reference appears twice": [
            { repositoryRef: "source", profile: "read" },
            { repositoryRef: "source", profile: "write" },
          ],
        };
        for (const [name, bindings] of Object.entries(invalidDrafts)) {
          await t.test(`draft: ${name}`, async () => {
            await assert.rejects(
              pool.query("UPDATE occ.agents SET repository_bindings = $2::jsonb WHERE id = $1", [
                agent.id,
                JSON.stringify(bindings),
              ]),
              { code: "23514" },
            );
          });
        }
        const invalidSnapshots = {
          "snapshot is null": null,
          "bindings are empty": repositoryCredentials({ bindings: [] }),
          "bindings are an object": repositoryCredentials({ bindings: {} }),
          "driver contains an extra field": repositoryCredentials({
            driver: {
              id: "repository-credentials",
              implementation: "github",
              bearer: "unexpected",
            },
          }),
          "binding contains an extra field": repositoryCredentials({
            bindings: [repositoryBinding({ bearer: "unexpected" })],
          }),
          "grant is null": repositoryCredentials({
            bindings: [repositoryBinding({ grant: null })],
          }),
          "grant contains an extra field": repositoryCredentials({
            bindings: [repositoryBinding({ grant: repositoryGrant({ bearer: "unexpected" }) })],
          }),
          "deadline is fractional": repositoryCredentials({ deadlineWallMs: 1.5 }),
          "driver identity contains a newline": repositoryCredentials({
            driver: { id: "bad\nidentity", implementation: "native" },
          }),
          "driver identity exceeds 512 UTF-8 bytes": repositoryCredentials({
            driver: { id: `${"é".repeat(256)}x`, implementation: "github" },
          }),
          "provider identity contains surrounding spaces": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: " provider " })],
          }),
          "provider identity exceeds 200 UTF-16 code units": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: "😀".repeat(101) })],
          }),
          "provider identity starts with a nonbreaking space": repositoryCredentials({
            bindings: [repositoryBinding({ backendId: "\u00a0provider" })],
          }),
          "grant identity is empty": repositoryCredentials({
            bindings: [repositoryBinding({ grant: repositoryGrant({ grantId: "" }) })],
          }),
          "snapshot contains an extra field": repositoryCredentials({ bearer: "extra" }),
        };
        // Insert variants of a real admitted row so the repository snapshot is the only invalid input.
        for (const [name, credentials] of Object.entries(invalidSnapshots)) {
          await t.test(`snapshot: ${name}`, async () => {
            await assert.rejects(
              pool.query(
                `INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, admitted_spec, admitted_at)
         SELECT $2, namespace_id, agent_id, 2,
           jsonb_set(admitted_spec, '{repository_credentials}', $3::jsonb), admitted_at
         FROM occ.agent_revisions WHERE id = $1`,
                [revision.id, `rev_${randomUUID()}`, JSON.stringify(credentials)],
              ),
              { code: "23514" },
            );
          });
        }
        const row = (
          await pool.query(
            "SELECT admitted_spec->'repository_credentials' AS credentials FROM occ.agent_revisions WHERE id = $1",
            [revision.id],
          )
        ).rows[0];
        assert.deepEqual(row.credentials, revision.repositoryCredentials);
      },
    );
  },
);
