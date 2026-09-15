import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  attribution,
  profiles,
  runtimeAudit,
  seedRuntimeOwner,
  verifyRuntimeAssignmentStore,
} from "../conformance/runtime-assignment-store.contract.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for real PostgreSQL runtime storage integration.",
  timeout: 60000,
};

test(
  "PostgreSQL runtime assignments: shared contract, restart, CAS, constraints and commit uncertainty",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const store = new PostgresPlatformState(pool);
    t.after(() => pool.end());
    const { owner, intent, allocation } = await verifyRuntimeAssignmentStore(store);

    await t.test("fresh adapter and pool recover exact historical locators", async () => {
      const freshPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const fresh = new PostgresPlatformState(freshPool);
        assert.deepEqual(
          await fresh.read((s) =>
            s.runtimeAssignments.findRuntimeIntent(owner.scope, intent.transitionRef),
          ),
          intent,
        );
        assert.deepEqual(
          await fresh.read((s) =>
            s.runtimeAssignments.findRuntimeAllocation(owner.scope, {
              createEffectRef: allocation.createEffectRef,
            }),
          ),
          allocation,
        );
      } finally {
        await freshPool.end();
      }
    });

    await t.test(
      "competing transactions admit exactly one intent and allocation generation",
      async () => {
        const contender = await seedRuntimeOwner(store);
        const { scope, revision } = contender;
        await store.transact((s) =>
          s.runtimeAssignments.initializeRuntimeIntent(
            scope,
            revision.id,
            randomUUID(),
            attribution,
          ),
        );
        // Both transactions own separate database clients before entering the CAS.
        async function race(operations) {
          let arrived = 0;
          let release;
          const barrier = new Promise((resolve) => {
            release = resolve;
          });
          return Promise.allSettled(
            operations.map((operation) =>
              store.transact(async (s) => {
                if (++arrived === operations.length) release();
                await barrier;
                return operation(s);
              }),
            ),
          );
        }
        const audits = [runtimeAudit(contender), runtimeAudit(contender)];
        const refs = [randomUUID(), randomUUID()];
        const outcomes = await race(
          refs.map((ref, i) => async (s) => {
            const result = await s.runtimeAssignments.advanceRuntimeIntent(
              scope,
              1,
              { desiredMode: "running", revisionId: revision.id },
              ref,
              attribution,
            );
            await s.audit.append(audits[i]);
            return result;
          }),
        );
        assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
        const loser = outcomes.findIndex((o) => o.status === "rejected");
        assert.equal(
          await store.read((s) => s.runtimeAssignments.findRuntimeIntent(scope, refs[loser])),
          undefined,
        );
        assert.equal(
          (await store.transact((s) => s.audit.list())).some((a) => a.id === audits[loser].id),
          false,
        );
        const effects = [randomUUID(), randomUUID()];
        const allocations = await race(
          effects.map(
            (effect) => (s) =>
              s.runtimeAssignments.allocateUnboundRuntime(scope, 2, "gateway", 0, effect, profiles),
          ),
        );
        assert.equal(allocations.filter((o) => o.status === "fulfilled").length, 1);
        assert.equal(allocations.filter((o) => o.status === "rejected").length, 1);
        const rejectedEffect = effects[allocations.findIndex((o) => o.status === "rejected")];
        assert.equal(
          await store.read((s) =>
            s.runtimeAssignments.findRuntimeAllocation(scope, { createEffectRef: rejectedEffect }),
          ),
          undefined,
        );
        const count = await pool.query(
          "SELECT count(*)::int AS count FROM occ.runtime_assignment_allocations WHERE namespace_id=$1 AND agent_id=$2",
          [scope.namespaceId, scope.agentId],
        );
        assert.equal(count.rows[0].count, 1);
      },
    );

    await t.test(
      "limited application grants and database ownership constraints protect immutable records",
      async () => {
        const role = await pool.query(
          "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
        );
        assert.equal(role.rows[0].name, "occ_app");
        assert.equal(role.rows[0].rolsuper, false);
        assert.equal(role.rows[0].rolbypassrls, false);
        for (const table of ["agent_runtime_intents", "runtime_assignment_allocations"]) {
          const grants = await pool.query(
            "SELECT has_table_privilege(current_user,$1,'SELECT') AS read, has_table_privilege(current_user,$1,'INSERT') AS insert, has_table_privilege(current_user,$1,'UPDATE') AS update, has_table_privilege(current_user,$1,'DELETE') AS delete",
            [`occ.${table}`],
          );
          assert.deepEqual(grants.rows[0], {
            read: true,
            insert: true,
            update: false,
            delete: false,
          });
          await assert.rejects(
            pool.query(
              `UPDATE occ.${table} SET created_at=now() WHERE namespace_id=$1 AND agent_id=$2`,
              [owner.scope.namespaceId, owner.scope.agentId],
            ),
            { code: "42501" },
          );
          await assert.rejects(
            pool.query(`DELETE FROM occ.${table} WHERE namespace_id=$1 AND agent_id=$2`, [
              owner.scope.namespaceId,
              owner.scope.agentId,
            ]),
            { code: "42501" },
          );
        }
        const headGrants = await pool.query(
          "SELECT has_table_privilege(current_user,'occ.agent_runtime_intent_heads','UPDATE') AS broad, has_table_privilege(current_user,'occ.agent_runtime_intent_heads','DELETE') AS delete, has_column_privilege(current_user,'occ.agent_runtime_intent_heads','generation','UPDATE') AS generation, has_column_privilege(current_user,'occ.agent_runtime_intent_heads','transition_ref','UPDATE') AS transition, has_column_privilege(current_user,'occ.agent_runtime_intent_heads','agent_id','UPDATE') AS owner",
        );
        assert.deepEqual(headGrants.rows[0], {
          broad: false,
          delete: false,
          generation: true,
          transition: true,
          owner: false,
        });
        const foreign = await seedRuntimeOwner(store);
        const columns = [
          "assignment_ref",
          "create_effect_ref",
          "installation_id",
          "namespace_id",
          "agent_id",
          "revision_id",
          "service_principal_id",
          "lifecycle_generation",
          "component",
          "runtime_generation",
          "provider_profile_ref",
          "runtime_profile_ref",
          "identity_profile_ref",
          "created_at",
          "binding_condition",
        ];
        const stored = (
          await pool.query(
            "SELECT * FROM occ.runtime_assignment_allocations WHERE assignment_ref=$1",
            [allocation.assignmentRef],
          )
        ).rows[0];
        const directOwner = await seedRuntimeOwner(store);
        await store.transact((s) =>
          s.runtimeAssignments.initializeRuntimeIntent(
            directOwner.scope,
            directOwner.revision.id,
            randomUUID(),
            attribution,
          ),
        );
        const baseline = {
          ...stored,
          assignment_ref: randomUUID(),
          create_effect_ref: randomUUID(),
          installation_id: directOwner.installation.id,
          namespace_id: directOwner.scope.namespaceId,
          agent_id: directOwner.scope.agentId,
          revision_id: directOwner.revision.id,
          service_principal_id: directOwner.agent.servicePrincipalId,
          lifecycle_generation: 1,
          runtime_generation: 1,
        };
        const insert = (row) =>
          pool.query(
            `INSERT INTO occ.runtime_assignment_allocations (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
            columns.map((key) => row[key]),
          );
        // Direct SQL must reject cross-owner tuples even when repository checks are bypassed.
        for (const patch of [
          { installation_id: randomUUID() },
          { namespace_id: foreign.namespace.id },
          { agent_id: foreign.agent.id },
          { revision_id: foreign.revision.id },
          { service_principal_id: foreign.agent.servicePrincipalId },
          { lifecycle_generation: 900 },
          { runtime_generation: 0 },
          { runtime_generation: "9007199254740992" },
          { component: "unknown" },
          { binding_condition: "bound" },
          { runtime_profile_ref: "bad ref" },
        ]) {
          const row = {
            ...baseline,
            assignment_ref: randomUUID(),
            create_effect_ref: randomUUID(),
            ...patch,
          };
          await assert.rejects(
            insert(row),
            (error) =>
              error.code === (Object.hasOwn(patch, "service_principal_id") ? "23503" : "23514"),
          );
        }
        // Accepting the unchanged baseline proves failures above were caused by each
        // individual mutation rather than by a stale head or skipped generation.
        await insert(baseline);
        assert.equal(
          (
            await store.read((s) =>
              s.runtimeAssignments.findRuntimeAllocation(directOwner.scope, {
                assignmentRef: baseline.assignment_ref,
              }),
            )
          ).runtimeGeneration,
          1,
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.agent_runtime_intent_heads SET generation=123, transition_ref=$1 WHERE namespace_id=$2 AND agent_id=$3",
            [intent.transitionRef, owner.scope.namespaceId, owner.scope.agentId],
          ),
          (error) => ["23503", "23514"].includes(error.code),
        );
        assert.equal(
          (await store.read((s) => s.runtimeAssignments.findRuntimeIntentHead(owner.scope)))
            .generation,
          4,
        );
      },
    );

    await t.test(
      "a real database constraint failure rolls back preceding intent and audit writes",
      async () => {
        const transition = randomUUID();
        const audit = runtimeAudit(owner);
        await assert.rejects(
          store.transact(async (s) => {
            await s.runtimeAssignments.advanceRuntimeIntent(
              owner.scope,
              4,
              { desiredMode: "running", revisionId: owner.revision.id },
              transition,
              attribution,
            );
            await s.audit.append(audit);
            // The malformed head references no matching immutable history tuple.
            await store.queryInTransaction(
              s,
              "UPDATE occ.agent_runtime_intent_heads SET generation=777 WHERE namespace_id=$1 AND agent_id=$2",
              [owner.scope.namespaceId, owner.scope.agentId],
            );
          }),
        );
        assert.equal(
          await store.read((s) => s.runtimeAssignments.findRuntimeIntent(owner.scope, transition)),
          undefined,
        );
        assert.equal(
          (await store.read((s) => s.runtimeAssignments.findRuntimeIntentHead(owner.scope)))
            .generation,
          4,
        );
        assert.equal(
          (await store.transact((s) => s.audit.list())).some((event) => event.id === audit.id),
          false,
        );
      },
    );

    await t.test(
      "real lost COMMIT acknowledgement resolves by preknown effect without allocating twice",
      async () => {
        const subject = await seedRuntimeOwner(store);
        const transitionRef = randomUUID();
        await store.transact((s) =>
          s.runtimeAssignments.initializeRuntimeIntent(
            subject.scope,
            subject.revision.id,
            transitionRef,
            attribution,
          ),
        );
        const proxy = await commitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          query_timeout: 5000,
          connectionTimeoutMillis: 5000,
        });
        faultPool.on("error", () => {});
        try {
          const faultStore = new PostgresPlatformState(faultPool);
          const effectRef = randomUUID(); // Retained before the uncertain transaction starts.
          proxy.arm();
          await assert.rejects(
            faultStore.transact((s) =>
              s.runtimeAssignments.allocateUnboundRuntime(
                subject.scope,
                1,
                "gateway",
                0,
                effectRef,
                profiles,
              ),
            ),
            { name: "PostgresCommitOutcomeUnknownError" },
          );
          assert.equal(
            proxy.observedCommit,
            true,
            "The real database reported COMMIT before transport loss.",
          );
          const committed = await store.read((s) =>
            s.runtimeAssignments.findRuntimeAllocation(subject.scope, {
              createEffectRef: effectRef,
            }),
          );
          assert.ok(committed);
          assert.equal(committed.runtimeGeneration, 1);
          assert.deepEqual(
            await store.transact((s) =>
              s.runtimeAssignments.allocateUnboundRuntime(
                subject.scope,
                1,
                "gateway",
                0,
                effectRef,
                profiles,
              ),
            ),
            committed,
          );
          const rows = await pool.query(
            "SELECT count(*)::int AS count, max(runtime_generation)::int AS generation FROM occ.runtime_assignment_allocations WHERE agent_id=$1",
            [subject.agent.id],
          );
          assert.deepEqual(rows.rows[0], { count: 1, generation: 1 });
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
