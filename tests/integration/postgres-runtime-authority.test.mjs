import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { canonicalRuntimeAuthorityMutationV1 } from "../../packages/contracts/src/runtime-authority-v1.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { runtimeAuthorityDigest } from "../../packages/occ/src/runtime-authority/repository.ts";
import { commitRuntimeAuthorityMutation } from "../../packages/occ/src/runtime-authority/service.ts";
import { verifyRuntimeAuthorityState } from "../conformance/runtime-authority-state.contract.mjs";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

const url = process.env.OCC_TEST_DATABASE_URL;
const data = (value) => JSON.parse(JSON.stringify(value));
test(
  "PostgreSQL runtime authority: real limited-role storage, races and COMMIT uncertainty",
  {
    skip: url
      ? false
      : "Set OCC_TEST_DATABASE_URL for an isolated migrated PostgreSQL18.6 database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const store = new PostgresPlatformState(pool);
    t.after(() => pool.end());
    await t.test(
      "the actual connection is the nonsuperuser application role on PostgreSQL18.6",
      async () => {
        const {
          rows: [identity],
        } = await pool.query(
          "SELECT current_user, current_setting('server_version') AS version, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        );
        assert.equal(identity.current_user, "occ_app");
        assert.match(identity.version, /^18\.6(?:\s|$)/);
        for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls"])
          assert.equal(identity[key], false);
      },
    );
    await verifyRuntimeAuthorityState(t, store);
    await t.test(
      "two checked-out clients race an exact version; stale writer cannot commit",
      async () => {
        const f = await seedAuthority(store);
        let arrived = 0;
        let release;
        const barrier = new Promise((resolve) => {
          release = resolve;
        });
        const refs = [randomUUID(), randomUUID()];
        const outcomes = await Promise.allSettled(
          refs.map((operationRef) =>
            store.transact(async (unit) => {
              if (++arrived === 2) release();
              await barrier;
              return unit.runtimeAuthority.appendMutation({ ...f.bind, operationRef }, writer);
            }),
          ),
        );
        assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
        const absent = refs[outcomes.findIndex((o) => o.status === "rejected")];
        assert.equal(await f.operation(absent), undefined);
        assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
      },
    );
    await t.test(
      "same operation ID across different Agent locks produces typed payload conflict",
      async () => {
        const a = await seedAuthority(store);
        const b = await seedAuthority(store);
        const operationRef = randomUUID();
        const results = await Promise.all([
          commitRuntimeAuthorityMutation(store, { ...a.bind, operationRef }, writer),
          commitRuntimeAuthorityMutation(store, { ...b.bind, operationRef }, writer),
        ]);
        assert.equal(results.filter((r) => r.result === "applied").length, 1);
        assert.equal(
          results.filter(
            (r) => r.result === "conflict" && r.reasonCode === "operation-payload-mismatch",
          ).length,
          1,
        );
        assert.equal(
          (await a.record()).authority.assignmentRecordVersion +
            (await b.record()).authority.assignmentRecordVersion,
          3,
        );
      },
    );
    await t.test(
      "limited role cannot update/delete history or bypass owner, version and tuple constraints",
      async () => {
        const f = await seedAuthority(store);
        const accepted = await f.append(f.bind);
        const row = (
          await pool.query(
            "SELECT * FROM occ.runtime_authority_operations WHERE operation_ref=$1",
            [f.bind.operationRef],
          )
        ).rows[0];
        for (const sql of [
          "UPDATE occ.runtime_authority_operations SET receipt='{}' WHERE operation_ref=$1",
          "DELETE FROM occ.runtime_authority_operations WHERE operation_ref=$1",
          "UPDATE occ.runtime_assignment_allocations SET binding_condition='bound' WHERE assignment_ref=$1",
        ]) {
          await assert.rejects(
            pool.query(sql, [
              sql.includes("allocations") ? f.allocation.assignmentRef : f.bind.operationRef,
            ]),
            (error) => error.code === "42501" || error.code === "23001",
          );
        }
        const insert = (value) =>
          pool.query(
            "INSERT INTO occ.runtime_authority_operations (operation_ref,installation_id,namespace_id,agent_id,assignment_ref,assignment_record_version,operation_kind,canonical_payload,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
            [
              value.operation_ref,
              value.installation_id,
              value.namespace_id,
              value.agent_id,
              value.assignment_ref,
              value.assignment_record_version,
              value.operation_kind,
              value.canonical_payload,
              JSON.stringify(value.receipt),
            ],
          );
        // Each malicious row uses the actual accepted request/receipt, then changes one
        // database invariant. This exercises PostgreSQL, not a SQL-string inspection.
        await assert.rejects(
          insert({ ...row, operation_ref: randomUUID(), agent_id: `agt_${randomUUID()}` }),
          (e) => ["23514", "23503"].includes(e.code),
        );
        await assert.rejects(
          insert({ ...row, operation_ref: randomUUID(), assignment_record_version: 9 }),
          (e) => e.code === "23514",
        );
        const changed = {
          ...f.bind,
          operationRef: randomUUID(),
          expectedAssignmentRecordVersion: 2,
          expectedBindingVersion: 1,
          binding: { ...f.bind.binding, protectedRestartDiscriminator: "restart/replacement" },
        };
        const changedReceipt = {
          ...data(accepted.receipt),
          operationRef: changed.operationRef,
          assignmentRecordVersion: 3,
          canonicalPayloadDigest: runtimeAuthorityDigest(changed),
          outcome: { kind: "bind", binding: changed.binding },
        };
        await assert.rejects(
          insert({
            ...row,
            operation_ref: changed.operationRef,
            assignment_record_version: 3,
            canonical_payload: canonicalRuntimeAuthorityMutationV1(changed),
            receipt: changedReceipt,
          }),
          (e) => e.code === "23514",
        );
        assert.deepEqual(
          data((await f.operation(f.bind.operationRef)).receipt),
          data(accepted.receipt),
        );
      },
    );
    await t.test(
      "direct application inserts reject incomplete closed binding/evidence/retirement shapes",
      async () => {
        const f = await seedAuthority(store);
        const insertMalformed = async (input, outcome, version) => {
          const { requestRef, ...request } = input;
          const payload = JSON.stringify(request);
          const receipt = {
            schemaVersion: 1,
            installationId: f.target.installationId,
            namespaceId: f.target.namespaceId,
            agentId: f.target.agentId,
            assignmentRef: f.target.assignmentRef,
            operationRef: input.operationRef,
            operationKind: input.kind,
            assignmentRecordVersion: version,
            ...writer,
            canonicalPayloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
            outcome,
          };
          await assert.rejects(
            pool.query(
              "INSERT INTO occ.runtime_authority_operations (operation_ref,installation_id,namespace_id,agent_id,assignment_ref,assignment_record_version,operation_kind,canonical_payload,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
              [
                input.operationRef,
                f.target.installationId,
                f.target.namespaceId,
                f.target.agentId,
                f.allocation.assignmentRef,
                version,
                input.kind,
                payload,
                JSON.stringify(receipt),
              ],
            ),
            (e) => e.code === "23514" && e.message.includes("closed persisted shape invalid"),
          );
        };
        for (const binding of [
          { component: "harness", bindingVersion: 1 },
          { ...f.bind.binding, unknownAuthority: true },
          {
            ...f.bind.binding,
            imageDigests: [...f.bind.binding.imageDigests, ...f.bind.binding.imageDigests],
          },
        ]) {
          const input = { ...f.bind, operationRef: randomUUID(), binding };
          await insertMalformed(input, { kind: "bind", binding }, 2);
        }
        await f.append(f.bind);
        const evidence = {
          schemaVersion: 1,
          kind: "runtime",
          target: f.target,
          bindingVersion: 1,
          evidenceVersion: 1,
          binding: f.bind.binding,
        };
        await insertMalformed(
          { ...f.evidence, operationRef: randomUUID(), evidence },
          { kind: "record-evidence", evidence },
          3,
        );
        const { responsibilityRef, ...retire } = f.retire;
        await insertMalformed(
          { ...retire, operationRef: randomUUID() },
          {
            kind: "retire",
            authority: "retired",
            responsibilityVersion: 1,
            termination: "not-asserted",
            providerCredentialRevocation: "not-asserted",
          },
          3,
        );
        const stale = { ...f.evidence.evidence, validUntil: "2026-01-01T00:00:16.000Z" };
        await insertMalformed(
          { ...f.evidence, operationRef: randomUUID(), evidence: stale },
          { kind: "record-evidence", evidence: stale },
          3,
        );
        assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
      },
    );
    await t.test("retained payload is the exact imported canonical representation", async () => {
      const f = await seedAuthority(store);
      for (const input of [f.bind, f.evidence, f.retire]) {
        const canonical = canonicalRuntimeAuthorityMutationV1(input);
        const result = await pool.query(
          "SELECT occ.runtime_authority_canonical($1::jsonb) AS canonical",
          [canonical],
        );
        assert.equal(result.rows[0].canonical, canonical);
      }
      const canonical = canonicalRuntimeAuthorityMutationV1(f.bind);
      const variants = [
        " " + canonical,
        JSON.stringify(JSON.parse(canonical), null, 2),
        JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(canonical)).reverse())),
        canonical.replace('"kind":"bind"', '"kind":"bind","kind":"bind"'),
        canonical.replace('"schemaVersion":1', '"schemaVersion":1.0'),
      ];
      for (const payload of variants) {
        const receipt = {
          schemaVersion: 1,
          installationId: f.target.installationId,
          namespaceId: f.target.namespaceId,
          agentId: f.target.agentId,
          assignmentRef: f.target.assignmentRef,
          operationRef: f.bind.operationRef,
          operationKind: "bind",
          assignmentRecordVersion: 2,
          ...writer,
          canonicalPayloadDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
          outcome: { kind: "bind", binding: f.bind.binding },
        };
        await assert.rejects(
          pool.query(
            "INSERT INTO occ.runtime_authority_operations (operation_ref,installation_id,namespace_id,agent_id,assignment_ref,assignment_record_version,operation_kind,canonical_payload,receipt) VALUES ($1,$2,$3,$4,$5,2,'bind',$6,$7::jsonb)",
            [
              f.bind.operationRef,
              f.target.installationId,
              f.target.namespaceId,
              f.target.agentId,
              f.allocation.assignmentRef,
              payload,
              JSON.stringify(receipt),
            ],
          ),
          (e) => e.code === "23514" && e.message.includes("payload is not canonical"),
        );
      }
      assert.equal(await f.operation(f.bind.operationRef), undefined);
      assert.equal((await f.append(f.bind)).result, "applied");
    });
    await t.test(
      "a real lost COMMIT ACK returns only exact readback and retains historical receipt",
      async () => {
        const f = await seedAuthority(store);
        const proxy = await runtimeCommitAckProxy(url);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 3000,
        });
        try {
          const faultStore = new PostgresPlatformState(faultPool);
          const operationRef = f.bind.operationRef;
          proxy.arm();
          const uncertain = await commitRuntimeAuthorityMutation(faultStore, f.bind, writer);
          assert.equal(proxy.observedCommit, true);
          assert.equal(uncertain.result, "commit-unknown");
          assert.equal(uncertain.nextAction, "exact-readback-only");
          assert.equal(uncertain.operation.operationRef, operationRef);
          const original = await f.operation(operationRef);
          assert.ok(original);
          assert.equal(
            original.receipt.canonicalPayloadDigest,
            uncertain.operation.canonicalPayloadDigest,
          );
          await f.stop();
          await f.append({ ...f.retire, expectedLifecycleGeneration: 2 });
          const before = await f.record();
          const freshPool = new pg.Pool({ connectionString: url });
          try {
            const fresh = new PostgresPlatformState(freshPool);
            const recovered = await fresh.read((unit) =>
              unit.runtimeAuthority.findOperation(f.target, operationRef),
            );
            assert.deepEqual(data(recovered), data(original));
            const replay = await commitRuntimeAuthorityMutation(
              fresh,
              { ...f.bind, requestRef: "readback/new-request" },
              writer,
            );
            assert.equal(replay.result, "exact-replay");
            assert.deepEqual(data(replay.receipt), data(original.receipt));
          } finally {
            await freshPool.end();
          }
          assert.deepEqual(await f.record(), before);
          // Optional explicit evidence path permits the external, real container-restart
          // check to bind its fresh process readback to this exact committed history.
          if (process.env.OCC_RUNTIME_AUTHORITY_RESTART_RECEIPT)
            await writeFile(
              process.env.OCC_RUNTIME_AUTHORITY_RESTART_RECEIPT,
              JSON.stringify(
                { target: f.target, operationRef, original, record: before },
                null,
                2,
              ) + "\n",
            );
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
