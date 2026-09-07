import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  databaseSelection,
  databaseFixture,
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
  },
);
