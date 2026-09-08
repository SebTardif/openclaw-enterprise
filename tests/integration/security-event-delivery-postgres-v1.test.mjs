import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  databaseSelection,
  databaseFixture,
  rollback,
  waitForBlock,
} from "../fixtures/lifecycle-protective-admission/database-fixture.mjs";
import {
  seedRuntimeOwner,
  protectiveWrite,
  apply,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";

const selected = databaseSelection();
const enabled = process.env.OCC_SECURITY_EVENT_DELIVERY_POSTGRES === "1";
if (enabled && selected.skip)
  throw new Error("Explicit PostgreSQL selection requires all dedicated database settings.");
const fixtureEvent = JSON.parse(
  readFileSync(
    new URL("../fixtures/security-event-delivery-v1/cases.json", import.meta.url),
    "utf8",
  ),
).event;
const uuidVersion = (version) => {
  const value = randomUUID();
  return value.slice(0, 14) + version + value.slice(15);
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Isolate expected real SQL failures without emulating a query or disabling a
// constraint. The enclosing fixture transaction always rolls these probes back.
async function rejectsSql(client, statement, parameters, code, constraint) {
  await client.query("SAVEPOINT schema_probe");
  try {
    await assert.rejects(client.query(statement, parameters), (error) => {
      assert.equal(error.code, code);
      if (constraint) assert.equal(error.constraint, constraint);
      return true;
    });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT schema_probe");
    await client.query("RELEASE SAVEPOINT schema_probe");
  }
}

// Genuine PostgreSQL cases, unrun unless explicitly selected. No production
// mandatory callback, remote authentication, export or power-loss proof follows.
test(
  "protected security-event PostgreSQL storage primitives",
  {
    skip: enabled
      ? selected.skip
      : "Explicitly select the separately prepared security-event PostgreSQL adapter fixture.",
    timeout: 120000,
  },
  async (t) => {
    const { state, app, migrator } = await databaseFixture(t, selected);
    const [{ createPostgresSecurityEventDeliveryV1 }, { RepositoryTransactionLifetime }] =
      await Promise.all([
        import("../../packages/occ/src/state/postgres/security-event-delivery-v1.ts"),
        import("../../packages/occ/src/ports/transaction.ts"),
      ]);
    assert.equal(
      (await app.query("SELECT to_regclass('occ.security_event_records_v1') IS NOT NULL AS ready"))
        .rows[0].ready,
      true,
      "The original schema owner must prepare the tables and grants; this suite performs no DDL.",
    );
    const securityInstallationId = uuidVersion(7);
    const producerInstanceRef = randomUUID();
    async function obligation(sequence) {
      const owner = await seedRuntimeOwner(state);
      const original = protectiveWrite(owner, "stop");
      assert.equal((await apply(state, original)).kind, "provisional");
      const securityScope = { installationId: securityInstallationId, namespaceId: uuidVersion(1) };
      const timestamp = new Date().toISOString();
      const event = {
        ...fixtureEvent,
        id: uuidVersion(8),
        installationId: securityScope.installationId,
        namespaceId: securityScope.namespaceId,
        receivedAt: timestamp,
        occurredAt: timestamp,
        workload: { state: "not_applicable" },
        resource: { ...fixtureEvent.resource, namespaceId: securityScope.namespaceId },
      };
      return {
        owner,
        securityScope,
        input: {
          event,
          producerInstanceRef,
          producerSequence: sequence,
          obligationRef: randomUUID(),
          origin: { auditEventId: original.audit.id, originalOperationRef: original.transitionRef },
        },
      };
    }
    const firstInput = await obligation(1);
    const installationId = firstInput.owner.installation.id;
    // Explicit disposable-fixture limits, not production defaults or a fresh-spool claim.
    await migrator.query(
      "INSERT INTO occ.security_event_capacity_v1 (installation_id,max_pending_events,max_pending_bytes,max_retained_bytes,record_overhead_bytes) VALUES ($1,10000,67108864,134217728,4096) ON CONFLICT (installation_id) DO NOTHING",
      [installationId],
    );
    async function unit(selection, readOnly, work, commit = true) {
      const client = await app.connect();
      const lifetime = new RepositoryTransactionLifetime();
      try {
        await client.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
            : "BEGIN ISOLATION LEVEL READ COMMITTED",
        );
        const repository = createPostgresSecurityEventDeliveryV1({
          scope: {
            installationId: selection.owner.installation.id,
            namespaceId: selection.owner.namespace.id,
          },
          securityScope: selection.securityScope,
          transaction: lifetime,
          query: {
            query: (statement, parameters) =>
              lifetime.run(() => client.query(statement, [...(parameters ?? [])])),
          },
        });
        const result = await work(repository, client);
        await lifetime.finish();
        await client.query(commit ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) {
        lifetime.close();
        await client.query("ROLLBACK");
        throw error;
      } finally {
        lifetime.close();
        client.release();
      }
    }
    const budget = async () =>
      (
        await app.query(
          "SELECT pending_events,pending_bytes,retained_bytes FROM occ.security_event_capacity_v1 WHERE installation_id=$1",
          [installationId],
        )
      ).rows[0];
    const read = (selection) =>
      unit(selection, true, (repository) => repository.readCommitted(selection.input));
    async function restoreLimits() {
      await migrator.query(
        "UPDATE occ.security_event_capacity_v1 SET max_pending_events=10000,max_pending_bytes=67108864,max_retained_bytes=134217728 WHERE installation_id=$1",
        [installationId],
      );
    }
    // Two actual clients and observed PostgreSQL blocking. Both promises are joined
    // even when a fixture assertion fails; the gate never supplies a SQL result.
    async function contend(left, right, onBlocked, commitLeft = true) {
      const held = deferred();
      const entered = deferred();
      const release = deferred();
      const first = unit(
        left,
        false,
        async (repository, client) => {
          const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          const result = await repository.stage(left.input);
          assert.equal(result.kind, "Staged");
          held.resolve(pid);
          await release.promise;
          return result;
        },
        commitLeft,
      );
      first.catch(held.reject);
      let second;
      try {
        const holder = await held.promise;
        second = unit(right, false, async (repository, client) => {
          entered.resolve((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          return repository.stage(right.input);
        });
        second.catch(entered.reject);
        await waitForBlock(migrator, await entered.promise, holder);
        await onBlocked();
      } finally {
        release.resolve();
        await Promise.allSettled([first, second].filter(Boolean));
      }
      return Promise.all([first, second]);
    }

    await t.test("rollback removes the staged record and capacity reservation", async () => {
      const before = await budget();
      await unit(
        firstInput,
        false,
        async (repository) =>
          assert.equal((await repository.stage(firstInput.input)).kind, "Staged"),
        false,
      );
      assert.deepEqual(await budget(), before);
      assert.equal((await read(firstInput)).kind, "Unknown");
    });
    let first;
    await t.test(
      "first-insert contender waits for real commit and reuses one receipt",
      async () => {
        const before = await budget();
        const results = await contend(firstInput, firstInput, async () =>
          assert.deepEqual(await budget(), before),
        );
        first = results[0];
        assert.deepEqual(results[1], first);
        assert.equal(Number((await budget()).pending_events), Number(before.pending_events) + 1);
        const committedBudget = await budget();
        assert.deepEqual(
          await unit(firstInput, false, (repository) => repository.stage(firstInput.input)),
          first,
        );
        assert.deepEqual(await budget(), committedBudget);
        assert.deepEqual(await read(firstInput), { ...first, kind: "Committed" });
      },
    );
    await t.test(
      "different first events contending on one producer sequence cannot both commit",
      async () => {
        const left = await obligation(2);
        const right = await obligation(2);
        assert.equal(left.owner.installation.id, right.owner.installation.id);
        const before = await budget();
        const results = await contend(left, right, async () =>
          assert.deepEqual(await budget(), before),
        );
        assert.equal(results[0].kind, "Staged");
        assert.equal(results[1].code, "Conflict");
        assert.equal(Number((await budget()).pending_events), Number(before.pending_events) + 1);
        assert.equal((await read(right)).kind, "Unknown");
      },
    );
    await t.test(
      "uncommitted capacity reservation blocks contender then refuses overflow",
      async () => {
        const left = await obligation(3);
        const right = await obligation(4);
        const before = await budget();
        await migrator.query(
          "UPDATE occ.security_event_capacity_v1 SET max_pending_events=pending_events+1 WHERE installation_id=$1",
          [installationId],
        );
        try {
          const results = await contend(left, right, async () =>
            assert.deepEqual(await budget(), before),
          );
          assert.equal(results[0].kind, "Staged");
          assert.equal(results[1].code, "Capacity");
          const after = await budget();
          assert.equal(Number(after.pending_events), Number(before.pending_events) + 1);
          assert.equal((await read(right)).kind, "Unknown");
          const retained = (
            await app.query("SELECT state FROM occ.audit_export_outbox WHERE audit_event_id=$1", [
              right.input.origin.auditEventId,
            ])
          ).rows;
          assert.deepEqual(retained, [{ state: "pending" }]);
          await migrator.query(
            "UPDATE occ.security_event_capacity_v1 SET max_pending_events=10000,max_pending_bytes=pending_bytes WHERE installation_id=$1",
            [installationId],
          );
          assert.equal(
            (await unit(right, false, (repository) => repository.stage(right.input))).code,
            "Capacity",
          );
          assert.deepEqual(await budget(), after);
          await migrator.query(
            "UPDATE occ.security_event_capacity_v1 SET max_pending_bytes=67108864,max_retained_bytes=retained_bytes WHERE installation_id=$1",
            [installationId],
          );
          assert.equal(
            (await unit(right, false, (repository) => repository.stage(right.input))).code,
            "Capacity",
          );
          assert.deepEqual(await budget(), after);
        } finally {
          await restoreLimits();
        }
      },
    );
    await t.test(
      "rolled-back reservation frees capacity to the waiting genuine contender",
      async () => {
        const left = await obligation(5);
        const right = await obligation(6);
        const before = await budget();
        await migrator.query(
          "UPDATE occ.security_event_capacity_v1 SET max_pending_events=pending_events+1 WHERE installation_id=$1",
          [installationId],
        );
        try {
          const results = await contend(
            left,
            right,
            async () => assert.deepEqual(await budget(), before),
            false,
          );
          assert.equal(results[1].kind, "Staged");
          assert.equal((await read(left)).kind, "Unknown");
          assert.equal((await read(right)).kind, "Committed");
          assert.equal(Number((await budget()).pending_events), Number(before.pending_events) + 1);
        } finally {
          await restoreLimits();
        }
      },
    );
    await t.test(
      "event that expires while blocked is refused using the post-lock database clock",
      async () => {
        const selection = await obligation(7);
        const now = (await migrator.query("SELECT clock_timestamp() AS now")).rows[0].now;
        const expires = new Date(now.getTime() + 1000);
        const receiptTime = new Date(expires.getTime() - 30 * 86400000).toISOString();
        selection.input.event = {
          ...selection.input.event,
          occurredAt: receiptTime,
          receivedAt: receiptTime,
        };
        const held = deferred();
        const entered = deferred();
        const release = deferred();
        const before = await budget();
        const locker = unit(selection, false, async (_repository, client) => {
          await client.query(
            "SELECT installation_id FROM occ.security_event_capacity_v1 WHERE installation_id=$1 FOR UPDATE",
            [installationId],
          );
          held.resolve((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          await release.promise;
        });
        locker.catch(held.reject);
        let attempt;
        try {
          const holder = await held.promise;
          attempt = unit(selection, false, async (repository, client) => {
            entered.resolve((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            return repository.stage(selection.input);
          });
          attempt.catch(entered.reject);
          await waitForBlock(migrator, await entered.promise, holder);
          assert.equal(
            (
              await migrator.query("SELECT clock_timestamp()<$1::timestamptz AS before_expiry", [
                expires,
              ])
            ).rows[0].before_expiry,
            true,
            "The event must still be current after blocking was observed.",
          );
          const until = performance.now() + 3000;
          let expired = false;
          do {
            expired = (
              await migrator.query("SELECT clock_timestamp()>=$1::timestamptz AS expired", [
                expires,
              ])
            ).rows[0].expired;
            if (!expired) await delay(20);
          } while (!expired && performance.now() < until);
          assert.equal(expired, true);
        } finally {
          release.resolve();
          await Promise.allSettled([locker, attempt].filter(Boolean));
        }
        assert.equal((await attempt).code, "InvalidRecord");
        assert.deepEqual(await budget(), before);
      },
    );
    await t.test(
      "changed sequence, content and origin cannot replace retained correspondence",
      async () => {
        assert.equal(
          (
            await unit(firstInput, false, (repository) =>
              repository.stage({ ...firstInput.input, producerSequence: 99 }),
            )
          ).code,
          "Conflict",
        );
        assert.equal(
          (
            await unit(firstInput, false, (repository) =>
              repository.stage({
                ...firstInput.input,
                origin: { ...firstInput.input.origin, originalOperationRef: randomUUID() },
              }),
            )
          ).code,
          "WrongProducerScope",
        );
        assert.equal(
          (
            await unit(firstInput, true, (repository) =>
              repository.readCommitted({
                ...firstInput.input,
                event: {
                  ...firstInput.input.event,
                  receivedAt: new Date(
                    Date.parse(firstInput.input.event.receivedAt) + 1,
                  ).toISOString(),
                },
              }),
            )
          ).kind,
          "Conflict",
        );
        assert.deepEqual(await read(firstInput), { ...first, kind: "Committed" });
      },
    );
    await t.test("write-capable transaction cannot certify its own readback", async () => {
      await assert.rejects(
        unit(firstInput, false, (repository) => repository.readCommitted(firstInput.input)),
        /fresh read-only unit/,
      );
    });
    await t.test("closed repository rejects subsequent access", async () => {
      let saved;
      await unit(firstInput, true, async (repository) => {
        saved = repository;
      });
      await assert.rejects(saved.readCommitted(firstInput.input));
    });
    await t.test("real outer COMMIT may succeed before caller loses its receipt", async () => {
      await assert.rejects(
        unit(firstInput, false, (repository) => repository.stage(firstInput.input)).then(() => {
          throw new Error("fixture caller receipt unavailable");
        }),
      );
      assert.deepEqual(await read(firstInput), { ...first, kind: "Committed" });
    });

    await t.test(
      "schema grants expose only record insertion, counters and outbox locking",
      async () => {
        for (const [table, insert, writable] of [
          ["security_event_records_v1", true, []],
          [
            "security_event_capacity_v1",
            false,
            ["pending_events", "pending_bytes", "retained_bytes"],
          ],
          ["audit_export_outbox", true, ["audit_event_id"]],
        ]) {
          const qualified = `occ.${table}`;
          const privileges = (
            await app.query(
              `SELECT has_table_privilege(current_user,$1,'SELECT') AS read,
            has_table_privilege(current_user,$1,'INSERT') AS insert,
            has_table_privilege(current_user,$1,'UPDATE') AS update,
            has_table_privilege(current_user,$1,'DELETE') AS delete,
            has_table_privilege(current_user,$1,'TRUNCATE') AS truncate,
            has_table_privilege(current_user,$1,'REFERENCES') AS references,
            has_table_privilege(current_user,$1,'TRIGGER') AS trigger`,
              [qualified],
            )
          ).rows[0];
          assert.deepEqual(privileges, {
            read: true,
            insert,
            update: false,
            delete: false,
            truncate: false,
            references: false,
            trigger: false,
          });
          const columns = (
            await app.query(
              `SELECT attname, has_column_privilege(current_user,attrelid,attnum,'INSERT') AS insert,
            has_column_privilege(current_user,attrelid,attnum,'UPDATE') AS update,
            has_column_privilege(current_user,attrelid,attnum,'REFERENCES') AS references
           FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`,
              [qualified],
            )
          ).rows;
          assert.ok(columns.length > 0);
          for (const column of columns) {
            assert.equal(column.insert, insert, `${table}.${column.attname} INSERT`);
            assert.equal(
              column.update,
              writable.includes(column.attname),
              `${table}.${column.attname} UPDATE`,
            );
            assert.equal(column.references, false, `${table}.${column.attname} REFERENCES`);
          }
        }
      },
    );

    await t.test("capacity counters obey bounds while app configuration is withheld", async () => {
      const before = await budget();
      await rollback(app, async (client) => {
        const changed = (
          await client.query(
            `UPDATE occ.security_event_capacity_v1 SET pending_events=pending_events+1,
            pending_bytes=pending_bytes+1,retained_bytes=retained_bytes+1
           WHERE installation_id=$1 RETURNING pending_events,pending_bytes,retained_bytes`,
            [installationId],
          )
        ).rows[0];
        for (const field of ["pending_events", "pending_bytes", "retained_bytes"])
          assert.equal(BigInt(changed[field]), BigInt(before[field]) + 1n);
        await rejectsSql(
          client,
          "INSERT INTO occ.security_event_capacity_v1 DEFAULT VALUES",
          [],
          "42501",
        );
        for (const field of [
          "installation_id",
          "max_pending_events",
          "max_pending_bytes",
          "max_retained_bytes",
          "record_overhead_bytes",
        ])
          await rejectsSql(
            client,
            `UPDATE occ.security_event_capacity_v1 SET ${field}=${field} WHERE installation_id=$1`,
            [installationId],
            "42501",
          );
        await rejectsSql(
          client,
          "DELETE FROM occ.security_event_capacity_v1 WHERE installation_id=$1",
          [installationId],
          "42501",
        );
        await rejectsSql(client, "TRUNCATE occ.security_event_capacity_v1", [], "42501");
        for (const assignment of [
          "pending_events=-1",
          "pending_events=max_pending_events+1",
          "pending_bytes=-1",
          "pending_bytes=max_pending_bytes+1",
          "retained_bytes=pending_bytes-1",
          "retained_bytes=max_retained_bytes+1",
        ])
          await rejectsSql(
            client,
            `UPDATE occ.security_event_capacity_v1 SET ${assignment} WHERE installation_id=$1`,
            [installationId],
            "23514",
            "security_event_capacity_v1_bounds",
          );
      });
      // The existing migrator owns fixture configuration. Even that role cannot
      // store limits outside the unchanged factory's declared ranges.
      await rollback(migrator, async (client) => {
        for (const [field, values] of [
          ["max_pending_events", [0, 10001]],
          ["max_pending_bytes", [0, 67108865]],
          ["max_retained_bytes", [0, "9007199254740992"]],
          ["record_overhead_bytes", [0, "9007199254740992"]],
        ])
          for (const value of values)
            await rejectsSql(
              client,
              `UPDATE occ.security_event_capacity_v1 SET ${field}=$2 WHERE installation_id=$1`,
              [installationId, value],
              "23514",
              "security_event_capacity_v1_bounds",
            );
      });
      assert.deepEqual(await budget(), before);
    });

    await t.test("committed security records reject app writes and owner mutations", async () => {
      await rollback(app, async (client) => {
        for (const statement of [
          "UPDATE occ.security_event_records_v1 SET event_digest=event_digest WHERE event_id=$1",
          "DELETE FROM occ.security_event_records_v1 WHERE event_id=$1",
        ])
          await rejectsSql(client, statement, [firstInput.input.event.id], "42501");
        await rejectsSql(client, "TRUNCATE occ.security_event_records_v1", [], "42501");
      });
      // App UPDATE/DELETE is denied before a trigger can run. The real table
      // owner separately proves the immutable trigger, with no grant or bypass.
      await rollback(migrator, async (client) => {
        for (const statement of [
          "UPDATE occ.security_event_records_v1 SET received_at=received_at WHERE event_id=$1",
          "DELETE FROM occ.security_event_records_v1 WHERE event_id=$1",
        ])
          await rejectsSql(client, statement, [firstInput.input.event.id], "55000");
      });
      assert.deepEqual(await read(firstInput), { ...first, kind: "Committed" });
    });

    await t.test("outbox lock grant preserves the original immutable owner row", async () => {
      const id = firstInput.input.origin.auditEventId;
      const before = (
        await app.query("SELECT * FROM occ.audit_export_outbox WHERE audit_event_id=$1", [id])
      ).rows;
      assert.equal(before.length, 1);
      await rollback(app, async (client) => {
        assert.deepEqual(
          (
            await client.query(
              "SELECT * FROM occ.audit_export_outbox WHERE audit_event_id=$1 FOR UPDATE",
              [id],
            )
          ).rows,
          before,
        );
        await rejectsSql(
          client,
          "UPDATE occ.audit_export_outbox SET audit_event_id=audit_event_id WHERE audit_event_id=$1",
          [id],
          "55000",
        );
        await rejectsSql(
          client,
          "UPDATE occ.audit_export_outbox SET state=state WHERE audit_event_id=$1",
          [id],
          "42501",
        );
        await rejectsSql(
          client,
          "DELETE FROM occ.audit_export_outbox WHERE audit_event_id=$1",
          [id],
          "42501",
        );
      });
      assert.deepEqual(
        (await app.query("SELECT * FROM occ.audit_export_outbox WHERE audit_event_id=$1", [id]))
          .rows,
        before,
      );
    });

    await t.test("record constraints reject altered genuine storage correspondence", async () => {
      const selection = await obligation(8);
      const before = await budget();
      // Obtain the candidate from the real adapter and actual lifecycle outbox,
      // then roll back its security record/counters before direct SQL negatives.
      const candidate = await unit(
        selection,
        false,
        async (repository, client) => {
          assert.equal((await repository.stage(selection.input)).kind, "Staged");
          return (
            await client.query("SELECT * FROM occ.security_event_records_v1 WHERE event_id=$1", [
              selection.input.event.id,
            ])
          ).rows[0];
        },
        false,
      );
      assert.deepEqual(await budget(), before);
      assert.equal((await read(selection)).kind, "Unknown");
      const retained = (
        await app.query("SELECT * FROM occ.security_event_records_v1 WHERE event_id=$1", [
          firstInput.input.event.id,
        ])
      ).rows[0];
      const columns = Object.keys(candidate);
      const insert = `INSERT INTO occ.security_event_records_v1 (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`;
      const values = (row) => columns.map((column) => row[column]);
      const changedEvent = (event) => {
        const canonical = JSON.stringify(event);
        return {
          ...candidate,
          canonical_event_utf8: canonical,
          event_digest: `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`,
        };
      };
      await rollback(app, async (client) => {
        const reject = (delta, code, constraint) =>
          rejectsSql(client, insert, values({ ...candidate, ...delta }), code, constraint);
        const event = JSON.parse(candidate.canonical_event_utf8);
        await reject(
          { ...changedEvent({ ...event, id: "invalid-reference" }), event_id: "invalid-reference" },
          "23514",
          "security_event_records_v1_refs",
        );
        for (const field of ["producer_instance_ref", "obligation_ref", "commit_receipt_ref"])
          await reject({ [field]: "invalid-reference" }, "23514", "security_event_records_v1_refs");
        for (const [field, invalid] of [
          ["producer_sequence", 0],
          ["producer_sequence", "9007199254740992"],
          ["envelope_bytes", 0],
          ["envelope_bytes", 16385],
          ["charged_bytes", Number(candidate.envelope_bytes) - 1],
          ["charged_bytes", "9007199254740992"],
        ])
          await reject({ [field]: invalid }, "23514", "security_event_records_v1_bounds");
        await reject(
          changedEvent({ ...event, padding: "x".repeat(8192) }),
          "23514",
          "security_event_records_v1_bounds",
        );
        await reject(
          { event_digest: `sha256:${"0".repeat(64)}` },
          "23514",
          "security_event_records_v1_digest",
        );
        for (const field of ["schema", "id", "installationId", "namespaceId", "receivedAt"]) {
          const missing = { ...event };
          delete missing[field];
          await reject(changedEvent(missing), "23514", "security_event_records_v1_correspondence");
        }
        for (const field of ["security_installation_id", "security_namespace_id", "received_at"])
          await reject(
            { [field]: randomUUID() },
            "23514",
            "security_event_records_v1_correspondence",
          );
        await reject({ installation_id: `ins_${randomUUID()}` }, "23503");
        await reject({ audit_event_id: randomUUID() }, "23503");
        for (const [field, constraint] of [
          ["producer_sequence", "sequence"],
          ["obligation_ref", "obligation"],
          ["audit_event_id", "outbox"],
          ["commit_receipt_ref", "receipt"],
        ])
          await reject(
            { [field]: retained[field] },
            "23505",
            `security_event_records_v1_${constraint}`,
          );
        // Both event uniqueness keys apply in this actual singleton Installation;
        // either index may be the first duplicate identity reported by PostgreSQL.
        await reject(
          { ...changedEvent({ ...event, id: retained.event_id }), event_id: retained.event_id },
          "23505",
        );
        // The unaltered real row still inserts: the negative results above are
        // specific schema rejections, not a generally unusable candidate/role.
        assert.equal((await client.query(insert, values(candidate))).rowCount, 1);
      });
      assert.deepEqual(await budget(), before);
      assert.equal((await read(selection)).kind, "Unknown");
      assert.deepEqual(await read(firstInput), { ...first, kind: "Committed" });
    });
  },
);
