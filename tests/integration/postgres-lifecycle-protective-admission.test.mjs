import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  apply,
  assertAbsent,
  committed,
  head,
  protectiveWrite,
  seedRunning,
  seedRuntimeOwner,
  verifyProtectiveAdmissionStore,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";
import {
  capability,
  databaseFixture,
  databaseSelection,
  familyCounts,
  rollback,
  waitForBlock,
} from "../fixtures/lifecycle-protective-admission/database-fixture.mjs";

const selected = databaseSelection();
// Real PostgreSQL only when explicitly selected and separately prepared. These
// are trusted storage/barrier tests, not account authentication or live cutover.
test(
  "PostgreSQL protective admission atomicity and inert queue barrier",
  { skip: selected.skip, timeout: 120_000 },
  async (t) => {
    const fixture = await databaseFixture(t, selected);
    const { state, app, migrator, PostgresWorkQueue, WorkClaimLostError } = fixture;
    await verifyProtectiveAdmissionStore(t, state);
    const owner = await seedRuntimeOwner(state);
    const input = protectiveWrite(owner);
    const result = await apply(state, input);

    await t.test("one committed unit retains all six correlated row families", async () => {
      assert.deepEqual(await familyCounts(app, input), {
        intents: 1,
        admissions: 1,
        cleanup: 1,
        work: 1,
        audit: 1,
        export: 1,
      });
      const rows = (
        await app.query(
          "SELECT work_schema_version,handler,revision_id,state,attempt_count FROM occ.controller_work WHERE idempotency_key=$1",
          [input.workId],
        )
      ).rows;
      assert.deepEqual(rows, [
        {
          work_schema_version: 1,
          handler: "ReconcileAgentLifecycleV1",
          revision_id: null,
          state: "queued",
          attempt_count: 0,
        },
      ]);
    });

    await t.test(
      "application cannot change capabilities or retained immutable records",
      async () => {
        const rights = (
          await app.query(
            "SELECT has_table_privilege(current_user,'occ.lifecycle_capabilities','SELECT') AS read, has_table_privilege(current_user,'occ.lifecycle_capabilities','INSERT') AS insert, has_table_privilege(current_user,'occ.lifecycle_capabilities','UPDATE') AS update, has_table_privilege(current_user,'occ.lifecycle_capabilities','DELETE') AS delete",
          )
        ).rows[0];
        assert.deepEqual(rights, { read: true, insert: false, update: false, delete: false });
        await assert.rejects(
          app.query(
            "UPDATE occ.lifecycle_capabilities SET capability_version=capability_version+1 WHERE installation_id=$1",
            [owner.installation.id],
          ),
          { code: "42501" },
        );
        for (const [table, key, value] of [
          ["agent_lifecycle_admissions", "operation_ref", input.transitionRef],
          ["runtime_cleanup_responsibilities", "responsibility_ref", input.responsibilityRef],
          ["audit_export_outbox", "audit_event_id", input.audit.id],
        ]) {
          await assert.rejects(app.query(`DELETE FROM occ.${table} WHERE ${key}=$1`, [value]));
        }
        assert.deepEqual(await committed(state, owner, input), result.retained);
      },
    );

    await t.test("current legacy queue methods cannot claim or transition V1 work", async () => {
      const queue = new PostgresWorkQueue(app);
      const original = (
        await app.query("SELECT * FROM occ.controller_work WHERE idempotency_key=$1", [
          input.workId,
        ])
      ).rows[0];
      const claim = { idempotencyKey: input.workId, claimToken: randomUUID() };
      assert.equal(await queue.heartbeat(claim), undefined);
      for (const method of ["complete", "retry", "defer", "fail"]) {
        await assert.rejects(queue[method](claim, { code: "TEST_CLOSED" }), WorkClaimLostError);
      }
      // Execute queue scans transactionally so unrelated retained V0 test history
      // is not consumed. Every returned row must remain the legacy shape.
      await rollback(app, async (client) => {
        const local = new PostgresWorkQueue(client);
        const claimed = await local.claim({ claimToken: randomUUID() });
        assert.ok(claimed, "the original deploy work from the shared contract remains claimable");
        assert.notEqual(claimed?.idempotencyKey, input.workId);
        assert.equal(Object.hasOwn(claimed, "handler"), false);
        await local.pending();
        await local.recoverStale();
      });
      assert.deepEqual(
        (
          await app.query("SELECT * FROM occ.controller_work WHERE idempotency_key=$1", [
            input.workId,
          ])
        ).rows[0],
        original,
      );
    });

    await t.test(
      "old SQL that ignores work version is refused by the database barrier",
      async () => {
        await rollback(migrator, async (operator) => {
          await capability(operator, owner.installation.id, "legacy");
          // This UPDATE is actually executed against the constrained V1 row; no
          // hand-written query string is used as a substitute for database behavior.
          await assert.rejects(
            operator.query(
              "UPDATE occ.controller_work SET state='claimed',claim_token=$2::uuid,lease_expires_at=clock_timestamp()+interval '30 seconds',attempt_count=1 WHERE idempotency_key=$1",
              [input.workId, randomUUID()],
            ),
            { code: "23514" },
          );
        });
        assert.deepEqual(await committed(state, owner, input), result.retained);
      },
    );

    await t.test(
      "missing marker role is a closed result even with live capability",
      async (caseTest) => {
        if (
          (await app.query("SELECT to_regrole('occ_lifecycle_worker_v1')::text AS marker")).rows[0]
            .marker !== null
        ) {
          caseTest.skip(
            "Absent-role vector requires a separately prepared cluster without the optional marker; this test never creates or drops roles.",
          );
          return;
        }
        await rollback(migrator, async (operator) => {
          await capability(operator, owner.installation.id, "live");
          await assert.rejects(
            operator.query(
              "UPDATE occ.controller_work SET available_at=available_at WHERE idempotency_key=$1",
              [input.workId],
            ),
            { code: "23514" },
          );
        });
      },
    );

    await t.test("audit mismatch prevents commit of every correlated row family", async () => {
      const isolated = await seedRuntimeOwner(state);
      const bad = protectiveWrite(isolated);
      bad.audit.requestId = `req_${randomUUID()}`;
      await assert.rejects(apply(state, bad));
      await assertAbsent(state, isolated, bad);
      assert.deepEqual(await familyCounts(app, bad), {
        intents: 0,
        admissions: 0,
        cleanup: 0,
        work: 0,
        audit: 0,
        export: 0,
      });
    });

    await t.test(
      "a previously retained legacy intent cannot supersede a protective head",
      async () => {
        const isolated = await seedRuntimeOwner(state);
        const running = await seedRunning(state, isolated);
        assert.equal(running.intent.generation, 1);
        const legacyTransition = randomUUID();
        // Retain valid V0 history in its own committed statement while the head
        // remains generation 1. This predates the protective INSERT barrier.
        await app.query(
          `INSERT INTO occ.agent_runtime_intents
         (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at,admission_version)
         VALUES($1,$2,$3,$4,3,'running',$5,$6,$7,clock_timestamp(),0)`,
          [
            legacyTransition,
            isolated.installation.id,
            isolated.namespace.id,
            isolated.agent.id,
            isolated.revision.id,
            running.intent.actorId,
            running.intent.requestId,
          ],
        );
        assert.deepEqual(await head(state, isolated), running.intent);
        const guarded = protectiveWrite(isolated, "disable", 1);
        const admission = await apply(state, guarded);
        assert.equal(admission.kind, "provisional");
        const protectiveHead = await head(state, isolated);
        assert.equal(protectiveHead.generation, 2);
        await assert.rejects(
          app.query(
            "UPDATE occ.agent_runtime_intent_heads SET generation=3,transition_ref=$3 WHERE namespace_id=$1 AND agent_id=$2",
            [isolated.namespace.id, isolated.agent.id, legacyTransition],
          ),
          { code: "23514" },
        );
        assert.deepEqual(await head(state, isolated), protectiveHead);
        assert.deepEqual(await committed(state, isolated, guarded), admission.retained);
        assert.deepEqual(await familyCounts(app, guarded), {
          intents: 1,
          admissions: 1,
          cleanup: 1,
          work: 1,
          audit: 1,
          export: 1,
        });
        const retainedLegacy = await app.query(
          "SELECT generation,admission_version,revision_id FROM occ.agent_runtime_intents WHERE transition_ref=$1",
          [legacyTransition],
        );
        assert.equal(retainedLegacy.rowCount, 1);
        assert.equal(Number(retainedLegacy.rows[0].generation), 3);
        assert.equal(retainedLegacy.rows[0].admission_version, 0);
        assert.equal(retainedLegacy.rows[0].revision_id, isolated.revision.id);
      },
    );

    for (const ordering of ["before", "after"]) {
      await t.test(
        `ordinary borrowed SQL ${ordering} admission cannot bypass unit isolation`,
        async () => {
          const isolated = await seedRuntimeOwner(state);
          const guarded = protectiveWrite(isolated);
          await assert.rejects(
            state.transact(async (unit) => {
              if (ordering === "before") await state.queryInTransaction(unit, "SELECT 1");
              try {
                await unit.lifecycleAdmissions.applyProtective(guarded);
                if (ordering === "after") await state.queryInTransaction(unit, "SELECT 1");
              } catch {
                /* A caller catching the failure must not permit COMMIT. */
              }
            }),
          );
          assert.deepEqual(await familyCounts(app, guarded), {
            intents: 0,
            admissions: 0,
            cleanup: 0,
            work: 0,
            audit: 0,
            export: 0,
          });
        },
      );
    }

    await t.test(
      "a standalone V1 intent cannot satisfy deferred admission correspondence",
      async () => {
        const isolated = await seedRuntimeOwner(state);
        const orphan = protectiveWrite(isolated);
        await rollback(app, async (client) => {
          await assert.rejects(
            async () => {
              await client.query(
                `INSERT INTO occ.agent_runtime_intents
          (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at,admission_version)
          VALUES($1,$2,$3,$4,1,'disabled',NULL,$5,$6,clock_timestamp(),1)`,
                [
                  orphan.transitionRef,
                  isolated.installation.id,
                  isolated.namespace.id,
                  isolated.agent.id,
                  orphan.attribution.actorId,
                  orphan.attribution.requestId,
                ],
              );
              await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            },
            (error) => ["23503", "23514"].includes(error.code),
          );
        });
        assert.deepEqual(await familyCounts(app, orphan), {
          intents: 0,
          admissions: 0,
          cleanup: 0,
          work: 0,
          audit: 0,
          export: 0,
        });
      },
    );

    await t.test(
      "competing protective CAS transactions admit one complete original unit",
      async () => {
        const isolated = await seedRuntimeOwner(state);
        const inputs = [protectiveWrite(isolated), protectiveWrite(isolated, "stop")];
        let arrived = 0;
        let release;
        const ready = new Promise((resolve) => {
          release = resolve;
        });
        const results = await Promise.allSettled(
          inputs.map((entry) =>
            state.transact(async (unit) => {
              if (++arrived === 2) release();
              await ready;
              return unit.lifecycleAdmissions.applyProtective(entry);
            }),
          ),
        );
        assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
        assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
        for (let i = 0; i < inputs.length; i += 1) {
          const count = results[i].status === "fulfilled" ? 1 : 0;
          assert.deepEqual(await familyCounts(app, inputs[i]), {
            intents: count,
            admissions: count,
            cleanup: count,
            work: count,
            audit: count,
            export: count,
          });
        }
      },
    );
  },
);

test(
  "PostgreSQL capability serialization uses fresh READ COMMITTED observations",
  {
    skip:
      selected.skip ||
      (!selected.worker &&
        "Select a separately provisioned compatibility-worker URL; tests never create roles or grant membership."),
    timeout: 60_000,
  },
  async (t) => {
    const fixture = await databaseFixture(t, selected);
    const { state, app, migrator, worker } = fixture;
    const membership = (
      await worker.query(
        "SELECT current_user AS name, rolsuper, rolcreaterole, rolbypassrls, to_regrole('occ_lifecycle_worker_v1') IS NOT NULL AND pg_has_role(current_user,to_regrole('occ_lifecycle_worker_v1'),'USAGE') IS TRUE AS member FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(membership.member, true);
    assert.equal(membership.rolsuper, false);
    assert.equal(membership.rolcreaterole, false);
    assert.equal(membership.rolbypassrls, false);
    const owner = await seedRuntimeOwner(state);
    const input = protectiveWrite(owner);
    await apply(state, input);
    await capability(migrator, owner.installation.id, "live");
    try {
      await t.test(
        "prepared member can enter the limited database branch while app remains refused",
        async () => {
          await rollback(worker, async (client) => {
            assert.equal(
              (
                await client.query(
                  "UPDATE occ.controller_work SET available_at=available_at WHERE idempotency_key=$1",
                  [input.workId],
                )
              ).rowCount,
              1,
            );
          });
          await assert.rejects(
            app.query(
              "UPDATE occ.controller_work SET available_at=available_at WHERE idempotency_key=$1",
              [input.workId],
            ),
            { code: "23514" },
          );
        },
      );

      for (const isolation of ["REPEATABLE READ", "SERIALIZABLE"]) {
        await t.test(`${isolation} cannot reuse a retained capability snapshot`, async () => {
          await rollback(
            worker,
            async (client) => {
              await client.query(
                "SELECT * FROM occ.lifecycle_capabilities WHERE installation_id=$1",
                [owner.installation.id],
              );
              await assert.rejects(
                client.query(
                  "UPDATE occ.controller_work SET available_at=available_at WHERE idempotency_key=$1",
                  [input.workId],
                ),
                { code: "23514" },
              );
            },
            isolation,
          );
        });
      }

      await t.test(
        "waiting V1 update reads a committed capability withdrawal after the writer releases its lock",
        async () => {
          const writer = await migrator.connect();
          const receiver = await worker.connect();
          let pending;
          try {
            await writer.query("BEGIN");
            await receiver.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const receiverPid = (await receiver.query("SELECT pg_backend_pid() AS pid")).rows[0]
              .pid;
            await capability(writer, owner.installation.id, "legacy");
            pending = receiver
              .query(
                "UPDATE occ.controller_work SET available_at=available_at WHERE idempotency_key=$1",
                [input.workId],
              )
              .then(
                (result) => ({ result }),
                (error) => ({ error }),
              );
            await waitForBlock(app, receiverPid, writerPid);
            await writer.query("COMMIT");
            assert.equal((await pending).error?.code, "23514");
          } finally {
            await writer.query("ROLLBACK");
            await pending?.catch(() => {});
            await receiver.query("ROLLBACK");
            writer.release();
            receiver.release();
          }
        },
      );
    } finally {
      await capability(migrator, owner.installation.id, "legacy");
    }
  },
);
