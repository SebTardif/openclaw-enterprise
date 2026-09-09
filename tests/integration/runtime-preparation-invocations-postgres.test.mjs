import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import {
  invocationControllerRole,
  invocationSessionHelper,
  seedRuntimePreparationInvocation,
} from "../fixtures/runtime-preparation-invocation.mjs";

const databaseUrl = process.env.OCC_RUNTIME_PREPARATION_DATABASE_URL;
const migrationUrl = process.env.OCC_MIGRATION_DATABASE_URL;
const tables = [
  "runtime_preparation_admission_origins",
  "runtime_preparation_submissions",
  "runtime_preparation_submission_responses",
];

async function rejectWithoutMutation(pool, operation, expectedCodes) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(operation(client), (error) => expectedCodes.includes(error.code));
  } finally {
    // Also roll back an unexpectedly accepted negative case.
    await client.query("ROLLBACK");
    client.release();
  }
}

// Restricted SQL cases use representation-only seedPreparation values. The
// final case separately exercises real BetterAuth, Native IAM, an original queue
// claim and the original current-use owner. Profile definitions and provider
// responses remain storage fixtures, without installed capability or execution
// qualification and without a protected HTTP deployment admission claim.
test(
  "runtime preparation invocations: real restricted PostgreSQL origin, current use and receipt storage",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_RUNTIME_PREPARATION_DATABASE_URL and OCC_MIGRATION_DATABASE_URL for an isolated officially migrated database.",
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(migrationUrl, "The independent migration-catalog connection is required.");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    const catalog = new pg.Pool({ connectionString: migrationUrl, max: 1 });
    t.after(async () => {
      await Promise.all([pool.end(), catalog.end()]);
    });
    const store = new PostgresPlatformState(pool);

    await t.test("the exact migration and restricted application role are installed", async () => {
      const {
        rows: [role],
      } = await pool.query(
        "SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(role.current_user, "occ_app");
      for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls"])
        assert.equal(role[key], false);
      const bytes = await readFile(
        new URL("../../migrations/0043_runtime_preparation_invocations.sql", import.meta.url),
      );
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        (await catalog.query("SELECT hash FROM drizzle.__drizzle_migrations WHERE hash=$1", [hash]))
          .rowCount,
        1,
        "The exact checked-in migration must have been applied through the official runner.",
      );
      for (const table of tables) {
        const {
          rows: [permissions],
        } = await pool.query(
          `SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
             has_table_privilege(current_user,$1,'INSERT') AS append,
             has_table_privilege(current_user,$1,'UPDATE') AS update,
             has_table_privilege(current_user,$1,'DELETE') AS delete,
             has_table_privilege(current_user,$1,'TRUNCATE') AS truncate`,
          [`occ.${table}`],
        );
        assert.equal(permissions.read, true, table);
        assert.equal(permissions.append, table !== "runtime_preparation_admission_origins", table);
        for (const privilege of ["update", "delete", "truncate"])
          assert.equal(permissions[privilege], false, `${table}.${privilege}`);
        const triggers = await pool.query(
          "SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal",
          [`occ.${table}`],
        );
        assert.ok(triggers.rowCount > 0, table);
        assert.ok(
          triggers.rows.every((trigger) => ["O", "A"].includes(trigger.tgenabled)),
          table,
        );
      }
    });

    await t.test(
      "a real committed admission cannot receive an application-invented origin",
      async () => {
        const fixture = await seedPreparation(store);
        await rejectWithoutMutation(
          pool,
          (client) =>
            client.query(
              `INSERT INTO occ.runtime_preparation_admission_origins
          (installation_id,namespace_id,agent_id,revision_id,intent_ref,lifecycle_generation,
           actor_id,request_id,admission_decision_id,session_origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
              [
                fixture.installation.id,
                fixture.namespace.id,
                fixture.agent.id,
                fixture.revision.id,
                fixture.intent.transitionRef,
                fixture.intent.generation,
                fixture.attribution.actorId,
                fixture.attribution.requestId,
                "test/storage-only-decision",
                JSON.stringify({
                  installationId: fixture.installation.id,
                  accountId: fixture.attribution.actorId,
                  issuer: `occ:installation:${fixture.installation.id}:better-auth`,
                  subject: fixture.attribution.actorId,
                  sessionId: randomUUID(),
                  sessionCredentialDigest: "0".repeat(64),
                  accountIncarnation: randomUUID(),
                  accountVersion: 1,
                }),
              ],
            ),
          ["42501"],
        );
        assert.equal(
          (
            await pool.query(
              "SELECT revision_id FROM occ.runtime_preparation_admission_origins WHERE revision_id=$1",
              [fixture.revision.id],
            )
          ).rowCount,
          0,
        );
        assert.ok(
          await store.read((unit) =>
            unit.runtimeAdmissions.findRevisionAdmission(fixture.scope, fixture.revision.id),
          ),
          "The original committed admission remains present.",
        );
      },
    );

    await t.test(
      "application SQL cannot rewrite, delete or truncate any invocation history",
      async () => {
        for (const table of tables) {
          const column =
            table === "runtime_preparation_admission_origins" ? "revision_id" : "effect_ref";
          for (const statement of [
            `UPDATE occ.${table} SET ${column}=${column}`,
            `DELETE FROM occ.${table}`,
            `TRUNCATE occ.${table}`,
          ])
            await rejectWithoutMutation(pool, (client) => client.query(statement), ["42501"]);
        }
      },
    );

    await t.test("real retained child bytes alone cannot create a durable submission", async () => {
      const fixture = await seedPreparation(store);
      await fixture.append(fixture.plan);
      await fixture.append(fixture.child);
      const child = fixture.child.child;
      await rejectWithoutMutation(
        pool,
        (client) =>
          client.query(
            `INSERT INTO occ.runtime_preparation_submissions
          (effect_ref,submission_ref,installation_id,namespace_id,agent_id,revision_id,
           preparation_ref,preparation_version,request_digest,provider_wire_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              child.effect.effectRef,
              randomUUID(),
              fixture.installation.id,
              fixture.namespace.id,
              fixture.agent.id,
              fixture.revision.id,
              fixture.plan.preparationRef,
              2,
              child.effect.requestDigest,
              child.providerWire.bytesDigest,
            ],
          ),
        ["23514", "23503"],
      );
      assert.equal(
        (
          await pool.query(
            "SELECT effect_ref FROM occ.runtime_preparation_submissions WHERE effect_ref=$1",
            [child.effect.effectRef],
          )
        ).rowCount,
        0,
      );
      assert.equal((await fixture.record()).children.length, 1);
    });

    await t.test(
      "an API-shaped response cannot be retained without its original submission",
      async () => {
        const effectRef = randomUUID();
        await rejectWithoutMutation(
          pool,
          (client) =>
            client.query(
              `INSERT INTO occ.runtime_preparation_submission_responses
          (effect_ref,namespace_name,deployment_name,deployment_uid,resource_version,received_at)
         VALUES ($1,'test-namespace','test-deployment','opaque-uid','opaque-rv',clock_timestamp())`,
              [effectRef],
            ),
          ["23503", "23514"],
        );
        assert.equal(
          (
            await pool.query(
              "SELECT effect_ref FROM occ.runtime_preparation_submission_responses WHERE effect_ref=$1",
              [effectRef],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      "real session, Native IAM and original worker own exact invocation readback",
      async () => {
        const selectedUrl = process.env.OCC_WORKLOAD_PROFILE_RECEIVING_DATABASE_URL;
        assert.ok(selectedUrl, "The explicitly enrolled selected-controller role URL is required.");
        const selectedAddress = new URL(selectedUrl);
        const appAddress = new URL(databaseUrl);
        assert.equal(decodeURIComponent(selectedAddress.username), invocationControllerRole);
        for (const field of ["hostname", "port", "pathname"])
          assert.equal(selectedAddress[field], appAddress[field]);
        const selected = new pg.Pool({
          connectionString: selectedUrl,
          max: 2,
          connectionTimeoutMillis: 250,
        });
        const fixtureClaims = [];
        let originalClaim;
        const previous = (
          await catalog.query(
            `SELECT has_function_privilege($1,$2,'EXECUTE') AS execute,
           has_table_privilege($1,'occ.runtime_preparation_admission_origins','INSERT') AS insert`,
            [invocationControllerRole, invocationSessionHelper],
          )
        ).rows[0];
        try {
          // Exact operator enrollment for this isolated test. This enrollment
          // changes neither application data nor trigger settings.
          if (!previous.execute)
            await catalog.query(
              `GRANT EXECUTE ON FUNCTION ${invocationSessionHelper} TO ${invocationControllerRole}`,
            );
          if (!previous.insert)
            await catalog.query(
              `GRANT INSERT ON occ.runtime_preparation_admission_origins TO ${invocationControllerRole}`,
            );
          const {
            rows: [role],
          } = await selected.query(
            "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
          );
          assert.equal(role.current_user, invocationControllerRole);
          assert.equal(role.rolsuper, false);
          assert.equal(role.rolbypassrls, false);
          for (const table of ["agent_revisions", "agent_runtime_intents"]) {
            const immutable = (
              await selected.query(
                "SELECT has_any_column_privilege(current_user,$1,'UPDATE') AS update",
                [`occ.${table}`],
              )
            ).rows[0];
            assert.equal(
              immutable.update,
              false,
              "Current use must not require new mutation privileges on immutable history.",
            );
          }
          const fixture = await seedRuntimePreparationInvocation(selected);
          originalClaim = await fixture.claimOriginalWork();
          fixtureClaims.push([fixture, originalClaim]);
          assert.equal(fixture.signInTransportClosed, true);
          const options = () => ({ signal: new AbortController().signal, timeoutMs: 3000 });
          const currentRead = (claim = originalClaim, request = fixture.currentUseRequest) =>
            fixture.state.readRuntimePreparationSubmissionV1(
              fixture.drivers,
              claim,
              request,
              options(),
            );
          let completedLease;
          const currentEffect = await fixture.state.withRuntimePreparationWorkerCurrentUseV1(
            fixture.drivers,
            originalClaim,
            fixture.currentUseRequest,
            options(),
            async (lease) => {
              completedLease = lease;
              lease.assertCurrent();
              assert.equal(
                lease.profile.use.manifestDigest,
                fixture.revision.workloadProfileUse.manifestDigest,
              );
              assert.equal(lease.revision.id, fixture.revision.id);
              return lease.child.effect.effectRef;
            },
          );
          assert.equal(currentEffect, fixture.child.effect.effectRef);
          assert.throws(
            () => completedLease.assertCurrent(),
            "The original transaction's lease must expire at terminal.",
          );
          assert.equal((await currentRead()).status, "unknown");
          assert.equal(
            (await currentRead({ ...originalClaim, claimToken: randomUUID() })).status,
            "unavailable",
          );
          const readOrigin = async () =>
            (
              await selected.query(
                "SELECT * FROM occ.runtime_preparation_admission_origins WHERE revision_id=$1",
                [fixture.revision.id],
              )
            ).rows;
          const before = await readOrigin();
          assert.equal(before.length, 1);
          assert.deepEqual(before[0].session_origin, fixture.originInput.origin);
          assert.equal(before[0].actor_id, fixture.originInput.principalId);
          assert.equal(before[0].request_id, fixture.originInput.requestId);
          assert.equal(before[0].admission_decision_id, fixture.originInput.admissionDecisionId);
          assert.equal(before[0].intent_ref, fixture.intent.transitionRef);
          assert.equal(
            (
              await fixture.state.read((unit) =>
                unit.runtimeAdmissions.findCommittedDeployCommand(
                  fixture.owner.scope,
                  fixture.originInput.deployment.command,
                  fixture.originInput.principalId,
                ),
              )
            ).id,
            fixture.revision.id,
          );
          await assert.rejects(
            fixture.retainOriginAgain(),
            (error) => error.name === "ScopeViolationError",
          );
          assert.deepEqual(fixture.originFailure, { code: "23514", associationRejected: true });
          assert.deepEqual(
            await readOrigin(),
            before,
            "Later replay cannot add or replace original provenance.",
          );

          const child = fixture.child;
          const submissionRef = randomUUID();
          const submission = [
            child.effect.effectRef,
            submissionRef,
            fixture.owner.installation.id,
            fixture.owner.namespace.id,
            fixture.owner.agent.id,
            fixture.revision.id,
            fixture.plan.preparationRef,
            2,
            child.effect.requestDigest,
            child.providerWire.bytesDigest,
          ];
          const submit = (client, parameters = submission) =>
            client.query(
              `INSERT INTO occ.runtime_preparation_submissions
            (effect_ref,submission_ref,installation_id,namespace_id,agent_id,revision_id,
             preparation_ref,preparation_version,request_digest,provider_wire_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              parameters,
            );
          for (const version of [1, 3]) {
            const invalid = [...submission];
            invalid[7] = version;
            await rejectWithoutMutation(selected, (client) => submit(client, invalid), ["23514"]);
          }
          for (const index of [8, 9]) {
            const invalid = [...submission];
            invalid[index] = `sha256:${"f".repeat(64)}`;
            await rejectWithoutMutation(selected, (client) => submit(client, invalid), ["23514"]);
          }
          assert.equal((await submit(selected)).rowCount, 1);
          await rejectWithoutMutation(selected, (client) => submit(client), ["23505"]);
          const retained = (
            await selected.query(
              "SELECT * FROM occ.runtime_preparation_submissions WHERE effect_ref=$1",
              [child.effect.effectRef],
            )
          ).rows;
          assert.equal(retained.length, 1);
          assert.equal(retained[0].submission_ref, submissionRef);
          assert.equal(retained[0].preparation_version, "2");
          assert.equal(retained[0].request_digest, child.effect.requestDigest);
          assert.equal(retained[0].provider_wire_digest, child.providerWire.bytesDigest);
          assert.equal(
            (await currentRead()).status,
            "unknown",
            "A committed submission without an API response stays unknown.",
          );

          // Provider-reported time is on a different clock from PostgreSQL.
          // Preserve finite values exactly without inventing causal ordering.
          const response = [
            child.effect.effectRef,
            "storage-fixture-namespace",
            child.providerTarget.name,
            child.predicate.uid,
            "opaque.resource.version",
            new Date(retained[0].submitted_at.getTime() - 1000),
          ];
          const respond = (client, parameters = response) =>
            client.query(
              `INSERT INTO occ.runtime_preparation_submission_responses
            (effect_ref,namespace_name,deployment_name,deployment_uid,resource_version,received_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
              parameters,
            );
          assert.equal(child.predicate.kind, "expected-object");
          for (const index of [2, 3]) {
            const invalid = [...response];
            invalid[index] = `different-${randomUUID()}`;
            await rejectWithoutMutation(selected, (client) => respond(client, invalid), ["23514"]);
          }
          for (const timestamp of ["infinity", "-infinity"]) {
            const invalid = [...response];
            invalid[5] = timestamp;
            await rejectWithoutMutation(selected, (client) => respond(client, invalid), ["23514"]);
          }
          assert.equal((await respond(selected)).rowCount, 1);
          await rejectWithoutMutation(selected, (client) => respond(client), ["23505"]);
          const observed = (
            await selected.query(
              "SELECT * FROM occ.runtime_preparation_submission_responses WHERE effect_ref=$1",
              [child.effect.effectRef],
            )
          ).rows;
          assert.equal(observed.length, 1);
          assert.equal(observed[0].deployment_name, child.providerTarget.name);
          assert.equal(observed[0].deployment_uid, child.predicate.uid);
          assert.equal(observed[0].resource_version, response[4]);
          assert.equal(observed[0].received_at.getTime(), response[5].getTime());
          const expectedReadback = {
            status: "retained",
            effectRef: child.effect.effectRef,
            response: {
              namespace: response[1],
              name: response[2],
              uid: response[3],
              resourceVersion: response[4],
              receivedAt: response[5].toISOString(),
            },
          };
          assert.deepEqual(await currentRead(), expectedReadback);
          assert.deepEqual(
            await currentRead(),
            expectedReadback,
            "Scoped replay returns the same response without a Compute driver.",
          );
          assert.equal(
            (
              await currentRead(originalClaim, {
                ...fixture.currentUseRequest,
                effectRef: randomUUID(),
              })
            ).status,
            "unavailable",
            "A different effect cannot borrow the retained response.",
          );
          assert.equal(
            (
              await currentRead(originalClaim, {
                ...fixture.currentUseRequest,
                selection: {
                  ...fixture.currentUseRequest.selection,
                  revisionId: `rev_${randomUUID()}`,
                },
              })
            ).status,
            "unavailable",
            "A different revision cannot borrow the original invocation.",
          );
          const bindingId = fixture.iamSeed.bindings[0].id;
          const binding = (
            await selected.query("SELECT * FROM occ.iam_access_bindings WHERE id=$1", [bindingId])
          ).rows[0];
          assert.ok(binding);
          assert.equal(
            (
              await selected.query(
                "SELECT has_table_privilege(current_user,'occ.iam_access_bindings','DELETE') AS can_delete",
              )
            ).rows[0].can_delete,
            false,
          );
          // Simulate operator withdrawal of only this fixture's generated IAM
          // binding. The actual IAM writer triggers remain enabled. Every
          // current-use request still runs on the restricted controller role.
          await catalog.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [bindingId]);
          try {
            assert.equal(
              (await currentRead()).status,
              "unavailable",
              "Withdrawing the real current IAM binding denies receipt disclosure.",
            );
          } finally {
            await catalog.query(
              `INSERT INTO occ.iam_access_bindings
                (id,namespace_id,identity_subject_id,group_subject_id,role_id,resource_kind,resource_id,channel_administration)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              [
                binding.id,
                binding.namespace_id,
                binding.identity_subject_id,
                binding.group_subject_id,
                binding.role_id,
                binding.resource_kind,
                binding.resource_id,
                binding.channel_administration === null
                  ? null
                  : JSON.stringify(binding.channel_administration),
              ],
            );
          }
          assert.deepEqual(await currentRead(), expectedReadback);
          await fixture.revokeAccount();
          assert.equal(
            (await currentRead()).status,
            "unavailable",
            "Real BetterAuth account/session revocation denies the original worker.",
          );
          assert.deepEqual(
            await readOrigin(),
            before,
            "Revocation preserves historical origin while removing current authorization.",
          );
          for (const [table, key] of [
            ["runtime_preparation_admission_origins", "revision_id"],
            ["runtime_preparation_submissions", "effect_ref"],
            ["runtime_preparation_submission_responses", "effect_ref"],
          ])
            for (const statement of [
              `UPDATE occ.${table} SET ${key}=${key}`,
              `DELETE FROM occ.${table}`,
            ])
              await rejectWithoutMutation(selected, (client) => client.query(statement), ["42501"]);

          const historical = await seedRuntimePreparationInvocation(selected, {
            retainOrigin: false,
          });
          await assert.rejects(
            historical.retainOriginAgain(),
            (error) => error.name === "ScopeViolationError",
          );
          assert.deepEqual(historical.originFailure, { code: "23514", associationRejected: true });
          assert.equal(
            (
              await selected.query(
                "SELECT revision_id FROM occ.runtime_preparation_admission_origins WHERE revision_id=$1",
                [historical.revision.id],
              )
            ).rowCount,
            0,
            "Even a currently authenticated real session cannot backfill a historical admission.",
          );
          const logout = await seedRuntimePreparationInvocation(selected);
          const logoutClaim = await logout.claimOriginalWork();
          fixtureClaims.push([logout, logoutClaim]);
          const logoutRead = () =>
            logout.state.readRuntimePreparationSubmissionV1(
              logout.drivers,
              logoutClaim,
              logout.currentUseRequest,
              options(),
            );
          assert.equal((await logoutRead()).status, "unknown");
          const accountState = async () =>
            (
              await catalog.query(
                `SELECT state,incarnation::text,account_version::text,current_user_id
               FROM occ.account_security_records WHERE installation_id=$1 AND account_id=$2`,
                [logout.owner.installation.id, logout.originInput.accountRef],
              )
            ).rows[0];
          const activeAccount = await accountState();
          assert.equal(activeAccount.state, "active");
          await logout.signOut();
          assert.deepEqual(
            await accountState(),
            activeAccount,
            "Logging out removes the exact session while leaving the real account active.",
          );
          assert.equal(
            (await logoutRead()).status,
            "unavailable",
            "The original session locator cannot authorize worker use after logout.",
          );
        } finally {
          const cleanupErrors = [];
          const cleanup = async (work) => {
            try {
              await work();
            } catch (error) {
              cleanupErrors.push(error);
            }
          };
          for (const [fixture, claim] of fixtureClaims.reverse())
            await cleanup(() => fixture.releaseClaim(claim));
          await cleanup(() => selected.end());
          if (!previous.insert)
            await cleanup(() =>
              catalog.query(
                `REVOKE INSERT ON occ.runtime_preparation_admission_origins FROM ${invocationControllerRole}`,
              ),
            );
          if (!previous.execute)
            await cleanup(() =>
              catalog.query(
                `REVOKE EXECUTE ON FUNCTION ${invocationSessionHelper} FROM ${invocationControllerRole}`,
              ),
            );
          const restored = (
            await catalog.query(
              `SELECT has_function_privilege($1,$2,'EXECUTE') AS execute,
             has_table_privilege($1,'occ.runtime_preparation_admission_origins','INSERT') AS insert`,
              [invocationControllerRole, invocationSessionHelper],
            )
          ).rows[0];
          assert.deepEqual(restored, previous, "Exact temporary role privileges must be restored.");
          if (cleanupErrors.length)
            throw new AggregateError(cleanupErrors, "Invocation fixture cleanup failed.");
        }
      },
    );
  },
);
