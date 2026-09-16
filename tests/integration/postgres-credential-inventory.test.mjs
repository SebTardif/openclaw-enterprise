import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../../packages/occ/src/state/postgres-state.ts";
import { transactCredentialInventoryMetadataV1 as storage } from "../../packages/occ/src/state/postgres/credential-inventory-owner.ts";
import {
  INVENTORY_LIMITS_V1,
  inventoryIntentDigestV1,
} from "../../packages/occ/src/credential-inventory-v1/transactions.ts";
import { seedInventorySubject } from "../fixtures/credential-inventory-v1/subject.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import * as cases from "../fixtures/credential-inventory-v1/cases.ts";

// Storage-component coverage only. Fixture documents carry no authority handle,
// credential bytes, custody producer or accepting-audit callback. The existing
// platform owner alone acquires clients and executes BEGIN/COMMIT/ROLLBACK.
const databaseUrl = process.env.OCC_CREDENTIAL_INVENTORY_TEST_DATABASE_URL;
const tableKeys = {
  records: "record_ref",
  operations: "operation_ref",
  mint_claims: "record_ref",
  revocation_claims: "claim_ref",
};
const emptyKeys = () => ({
  operations: [],
  records: [],
  mintClaims: [],
  revocationClaims: [],
});

async function subject(store) {
  const owner = await seedInventorySubject(store);
  const scope = { installationId: owner.installation.id, ...owner.scope };
  const input = cases.reserve(`reserve/${randomUUID()}`);
  input.scope = scope;
  input.profile.scope = scope;
  input.original.scope = scope;
  input.original.revisionId = owner.revision.id;
  input.binding.scope = scope;
  const commitRef = randomUUID();
  // This is a codec-valid persisted observation, not a new audit acceptance.
  const record = {
    schemaVersion: 1,
    target: {
      issuanceOperationRef: input.operationRef,
      recordRef: `record/${randomUUID()}`,
      intentDigest: inventoryIntentDigestV1(input),
    },
    inventoryVersion: 1,
    issuance: input,
    invalidationVersion: 1,
    audit: {
      state: "accepted",
      eventRef: input.originalAuditRef,
      commitRef,
      source: "credential",
      category: "credential",
    },
    updatedAt: input.createdAt,
    state: "reserved",
    expiry: { kind: "expiry-unproven" },
    disposition: "scope-held",
  };
  const operation = observation(input, record, commitRef, "intent-recorded");
  await storage(
    store,
    scope,
    async (repository) => {
      await repository.insertRecord(record);
      await repository.appendOperation(operation);
    },
    { commitRef },
  );
  return { scope, input, record, operation };
}

function observation(input, record, commitRef, state) {
  return {
    input,
    digest: inventoryIntentDigestV1(input),
    state,
    record,
    commitRef,
    recordedAt: input.createdAt,
  };
}

function mintTransition(record) {
  const input = cases.mintClaim(record, `mint/${randomUUID()}`);
  const claim = {
    issuanceOperationRef: record.target.issuanceOperationRef,
    recordRef: record.target.recordRef,
    issuanceIntentDigest: record.target.intentDigest,
    useOperationRef: input.operationRef,
    useIntentDigest: inventoryIntentDigestV1(input),
    providerAttemptRef: input.providerAttemptRef,
    inventoryVersion: record.inventoryVersion + 1,
  };
  const next = {
    ...record,
    state: "mint-unknown",
    providerAttemptRef: input.providerAttemptRef,
    inventoryVersion: claim.inventoryVersion,
  };
  return { input, claim, next };
}

test(
  "PostgreSQL inventory metadata: real storage, original transaction and lost acknowledgment",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_CREDENTIAL_INVENTORY_TEST_DATABASE_URL to a fresh migrated dedicated database.",
    timeout: 60000,
  },
  async (t) => {
    const selected = new URL(databaseUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(selected.hostname));
    assert.match(selected.pathname, /^\/openclaw_inventory_[a-zA-Z0-9_]+$/);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 250,
    });
    const store = new PostgresPlatformState(pool);
    t.after(() => pool.end());
    const role = await pool.query(
      "SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], {
      name: "occ_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    assert.equal(
      await store.read((unit) => unit.installations.getInstallation()),
      undefined,
      "This suite requires its own empty database and never resets existing state.",
    );
    for (const suffix of Object.keys(tableKeys)) {
      const count = await pool.query(
        `SELECT count(*)::int AS count FROM occ.credential_inventory_${suffix}`,
      );
      assert.equal(count.rows[0].count, 0);
    }

    await t.test(
      "fresh pool recovers the original reservation and immutable operation",
      async () => {
        const s = await subject(store);
        const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
        try {
          const fresh = new PostgresPlatformState(freshPool);
          await storage(fresh, s.scope, async (repository) => {
            assert.deepEqual(await repository.findRecord(s.record.target.recordRef), s.record);
            const original = await repository.findOperation(s.input.operationRef);
            assert.deepEqual(original, s.operation);
            assert.equal(Object.hasOwn(original, "originalReceipt"), false);
            assert.deepEqual(await repository.listLive(s.input.binding.bindingRef), [s.record]);
            const counts = await repository.liveCounts();
            assert.equal(counts.agent, 1);
            assert.equal(counts.unresolved, 1);
            assert.ok(counts.installation >= 1);
          });
        } finally {
          await freshPool.end();
        }
      },
    );

    await t.test("mint claim, CAS update and operation share one commit", async () => {
      const s = await subject(store);
      const mint = mintTransition(s.record);
      const commitRef = randomUUID();
      const operation = observation(mint.input, mint.next, commitRef, "effect-pending");
      await storage(
        store,
        s.scope,
        async (repository) => {
          await repository.insertMintClaim(mint.claim);
          await repository.replaceRecord(1, mint.next);
          await repository.appendOperation(operation);
        },
        { commitRef },
      );
      const keys = {
        operations: [s.input.operationRef, mint.input.operationRef],
        records: [s.record.target.recordRef],
        mintClaims: [s.record.target.recordRef],
        revocationClaims: [],
      };
      await storage(
        store,
        s.scope,
        async (repository) => {
          assert.deepEqual(await repository.findMintClaim(s.record.target.recordRef), mint.claim);
          assert.deepEqual(await repository.findRecord(s.record.target.recordRef), mint.next);
          assert.deepEqual(await repository.findOperation(mint.input.operationRef), operation);
        },
        { keys },
      );
      await assert.rejects(
        storage(store, s.scope, (repository) => repository.insertMintClaim(mint.claim)),
        /original issuance/,
      );
    });

    await t.test(
      "competing original transactions retain one mint attempt and one version increment",
      async () => {
        const s = await subject(store);
        const contenders = [mintTransition(s.record), mintTransition(s.record)];
        const results = await Promise.allSettled(
          contenders.map((mint) =>
            storage(store, s.scope, async (repository) => {
              await repository.insertMintClaim(mint.claim);
              await repository.replaceRecord(1, mint.next);
              await repository.appendOperation(
                observation(mint.input, mint.next, repository.commitRef, "effect-pending"),
              );
            }),
          ),
        );
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        const winner = contenders[results.findIndex((result) => result.status === "fulfilled")];
        const loser = contenders[results.findIndex((result) => result.status === "rejected")];
        await storage(store, s.scope, async (repository) => {
          assert.deepEqual(await repository.findMintClaim(s.record.target.recordRef), winner.claim);
          assert.deepEqual(await repository.findRecord(s.record.target.recordRef), winner.next);
          assert.equal(await repository.findOperation(loser.input.operationRef), undefined);
        });
        await assert.rejects(
          storage(store, s.scope, (repository) => repository.replaceRecord(1, loser.next)),
          /compare-and-swap conflict/,
        );
      },
    );

    await t.test("caught post-write codec failure rolls the whole phase back", async () => {
      const s = await subject(store);
      const mint = mintTransition(s.record);
      await assert.rejects(
        storage(store, s.scope, async (repository) => {
          await repository.insertMintClaim(mint.claim);
          await repository.replaceRecord(1, mint.next);
          await repository
            .appendOperation({ invalid: "codec failure after writes" })
            .catch(() => {});
          return "caught";
        }),
      );
      await storage(store, s.scope, async (repository) => {
        assert.deepEqual(await repository.findRecord(s.record.target.recordRef), s.record);
        assert.equal(await repository.findMintClaim(s.record.target.recordRef), undefined);
      });
    });

    await t.test("unawaited admitted calls drain and poison prevents commit", async () => {
      const s = await subject(store);
      const mint = mintTransition(s.record);
      await assert.rejects(
        storage(store, s.scope, async (repository) => {
          void repository.insertMintClaim(mint.claim);
          void repository.replaceRecord(1, mint.next);
          void repository.appendOperation({ invalid: "unawaited decode failure" });
          return "provisional";
        }),
      );
      await storage(store, s.scope, async (repository) => {
        assert.deepEqual(await repository.findRecord(s.record.target.recordRef), s.record);
        assert.equal(await repository.findMintClaim(s.record.target.recordRef), undefined);
      });
    });

    await t.test(
      "metadata callback commits normally while captured methods close with its phase",
      async () => {
        const s = await subject(store);
        const mint = mintTransition(s.record);
        let captured;
        const committed = await storage(store, s.scope, async (repository) => {
          captured = repository;
          await repository.insertMintClaim(mint.claim);
          await repository.replaceRecord(1, mint.next);
          return repository.findMintClaim(s.record.target.recordRef);
        });
        assert.deepEqual(committed, mint.claim);
        // Callers use metadata operations inside their callback; retained methods
        // lose access after the owner has drained and closed that same phase.
        await assert.rejects(captured.findRecord(s.record.target.recordRef), /closed|unavailable/);
        await assert.rejects(
          captured.replaceRecord(2, { ...mint.next, inventoryVersion: 3 }),
          /closed|unavailable/,
        );
        await storage(store, s.scope, async (repository) => {
          assert.deepEqual(await repository.findRecord(s.record.target.recordRef), mint.next);
        });
      },
    );

    await t.test("cross-scope reads hide rows and cross-scope writes roll back", async () => {
      const s = await subject(store);
      const foreign = await subject(store);
      await storage(store, foreign.scope, async (repository) => {
        assert.equal(await repository.findRecord(s.record.target.recordRef), undefined);
        assert.equal(await repository.findOperation(s.input.operationRef), undefined);
      });
      await assert.rejects(
        storage(store, foreign.scope, (repository) => repository.insertRecord(s.record)),
        /Cross-scope/,
      );
    });

    await t.test(
      "revocation claim history round-trips and supports ordered key locking",
      async () => {
        const s = await subject(store);
        const mint = mintTransition(s.record);
        await storage(store, s.scope, async (repository) => {
          await repository.insertMintClaim(mint.claim);
          await repository.replaceRecord(1, mint.next);
        });
        const accepted = cases.accepted(mint.next, mint.claim.providerAttemptRef);
        const outstanding = {
          schemaVersion: 1,
          target: s.record.target,
          inventoryVersion: 3,
          issuance: s.input,
          invalidationVersion: 1,
          audit: s.record.audit,
          updatedAt: accepted.observedAt,
          state: "outstanding",
          tokenRef: accepted.tokenRef,
          protectedRevocationRef: accepted.protectedRevocationRef,
          expiry: accepted.expiry,
          returnedScope: accepted.returnedScope,
          delivery: { state: "not-delivered" },
          revocation: { state: "unrequested", version: 1 },
          disposition: "mitigation-only",
        };
        // These are storage-only references. No custody claim or material handle
        // is created, and the absent custody producer is tested below.
        await storage(store, s.scope, (repository) => repository.replaceRecord(2, outstanding));
        const claim = {
          input: cases.claimRevoke(outstanding, `revoke/${randomUUID()}`),
          claimRef: `claim/${randomUUID()}`,
          claimVersion: 2,
          providerAttemptRef: `attempt/${randomUUID()}`,
          claimedAt: s.input.createdAt,
          claimNotAfter: new Date(
            Date.parse(s.input.createdAt) + INVENTORY_LIMITS_V1.claimMs,
          ).toISOString(),
        };
        await storage(store, s.scope, (repository) => repository.appendRevocationClaim(claim));
        await storage(
          store,
          s.scope,
          async (repository) => {
            assert.deepEqual(await repository.findRevocationClaim(claim.claimRef), claim);
          },
          { keys: { ...emptyKeys(), revocationClaims: [claim.claimRef] } },
        );
      },
    );

    await t.test(
      "application grants preserve immutable journals and database identity constraints",
      async () => {
        const s = await subject(store);
        const mint = mintTransition(s.record);
        await storage(store, s.scope, async (repository) => {
          await repository.insertMintClaim(mint.claim);
        });
        for (const [suffix, key] of Object.entries(tableKeys)) {
          const table = `occ.credential_inventory_${suffix}`;
          const grants = await pool.query(
            "SELECT has_table_privilege(current_user,$1,'SELECT') AS read,has_table_privilege(current_user,$1,'INSERT') AS insert,has_table_privilege(current_user,$1,'UPDATE') AS broad_update,has_table_privilege(current_user,$1,'DELETE') AS delete",
            [table],
          );
          assert.deepEqual(grants.rows[0], {
            read: true,
            insert: true,
            broad_update: false,
            delete: false,
          });
          await assert.rejects(pool.query(`DELETE FROM ${table}`), { code: "42501" });
          if (suffix !== "records") {
            const privilege = await pool.query(
              "SELECT has_column_privilege(current_user,$1,$2,'UPDATE') AS allowed",
              [table, key],
            );
            assert.equal(privilege.rows[0].allowed, true);
            // Existing rows make this a trigger execution, not a vacuous UPDATE.
            const count = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
            assert.ok(count.rows[0].count > 0);
            await assert.rejects(pool.query(`UPDATE ${table} SET ${key}=${key}`), {
              code: "55000",
            });
          }
        }
        // The lock-only grant cannot bypass the existing Installation immutability trigger.
        await assert.rejects(pool.query("UPDATE occ.installation SET id=id"), { code: "55000" });
        const values = [
          s.scope.installationId,
          s.scope.namespaceId,
          s.scope.agentId,
          s.record.target.recordRef,
        ];
        for (const [document, constraint] of [
          [{ ...s.record, inventoryVersion: 3 }, "credential_inventory_records_identity"],
          [
            { ...s.record, inventoryVersion: 2, schemaVersion: 2 },
            "credential_inventory_records_identity",
          ],
          [
            { ...s.record, inventoryVersion: 2, padding: "x".repeat(131072) },
            "credential_inventory_records_document",
          ],
        ]) {
          await assert.rejects(
            pool.query(
              "UPDATE occ.credential_inventory_records SET inventory_version=2,document=$5::jsonb WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND record_ref=$4",
              [...values, JSON.stringify(document)],
            ),
            { code: "23514", constraint },
          );
        }
        const changedIssuance = structuredClone(s.record);
        changedIssuance.inventoryVersion = 2;
        changedIssuance.issuance.grant.repositoryIds = ["202"];
        await assert.rejects(
          pool.query(
            "UPDATE occ.credential_inventory_records SET inventory_version=2,document=$5::jsonb WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND record_ref=$4",
            [...values, JSON.stringify(changedIssuance)],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.credential_inventory_records SET inventory_version=0 WHERE record_ref=$1",
            [s.record.target.recordRef],
          ),
          { code: "23514" },
        );
        await assert.rejects(
          pool.query(
            "UPDATE occ.credential_inventory_records SET agent_id=agent_id WHERE record_ref=$1",
            [s.record.target.recordRef],
          ),
          { code: "42501" },
        );
        await assert.rejects(
          pool.query(
            "INSERT INTO occ.credential_inventory_operations SELECT installation_id,namespace_id,agent_id,operation_ref,record_ref,document || '{\"originalReceipt\":{}}'::jsonb FROM occ.credential_inventory_operations WHERE operation_ref=$1",
            [s.input.operationRef],
          ),
          { code: "23514" },
        );
        await storage(store, s.scope, async (repository) =>
          assert.deepEqual(await repository.findRecord(s.record.target.recordRef), s.record),
        );
      },
    );

    await t.test(
      "database keys reject duplicate mint identities and foreign record references",
      async () => {
        const first = await subject(store);
        const second = await subject(store);
        const mint = mintTransition(first.record);
        await storage(store, first.scope, (repository) => repository.insertMintClaim(mint.claim));
        const candidate = mintTransition(second.record).claim;
        const insert = (claim) =>
          pool.query(
            "INSERT INTO occ.credential_inventory_mint_claims (installation_id,namespace_id,agent_id,record_ref,use_operation_ref,provider_attempt_ref,document) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
            [
              second.scope.installationId,
              second.scope.namespaceId,
              second.scope.agentId,
              claim.recordRef,
              claim.useOperationRef,
              claim.providerAttemptRef,
              JSON.stringify(claim),
            ],
          );
        await assert.rejects(
          insert({ ...candidate, useOperationRef: mint.claim.useOperationRef }),
          {
            code: "23505",
            constraint: "credential_inventory_mint_claims_use",
          },
        );
        await assert.rejects(
          insert({ ...candidate, providerAttemptRef: mint.claim.providerAttemptRef }),
          {
            code: "23505",
            constraint: "credential_inventory_mint_claims_attempt",
          },
        );
        await assert.rejects(insert({ ...candidate, recordRef: first.record.target.recordRef }), {
          code: "23503",
          constraint: "credential_inventory_mint_claims_record",
        });
        await storage(store, second.scope, async (repository) => {
          assert.equal(await repository.findMintClaim(second.record.target.recordRef), undefined);
          assert.deepEqual(
            await repository.findRecord(second.record.target.recordRef),
            second.record,
          );
        });
      },
    );

    await t.test(
      "a real lost COMMIT acknowledgment retains exact original operation, claim and CAS",
      async () => {
        const s = await subject(store);
        const mint = mintTransition(s.record);
        const commitRef = randomUUID();
        const operation = observation(mint.input, mint.next, commitRef, "effect-pending");
        const proxy = await commitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 250,
          query_timeout: 5000,
        });
        faultPool.on("error", () => {});
        try {
          const faultStore = new PostgresPlatformState(faultPool);
          proxy.arm();
          await assert.rejects(
            storage(
              faultStore,
              s.scope,
              async (repository) => {
                await repository.insertMintClaim(mint.claim);
                await repository.replaceRecord(1, mint.next);
                await repository.appendOperation(operation);
              },
              { commitRef },
            ),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(
            proxy.observedCommit,
            true,
            "The proxy consumed the real server's COMMIT acknowledgment.",
          );
          // Read through an independent connection using the unchanged original
          // identifiers. No new claim, operation, receipt or provider call repairs uncertainty.
          const freshPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
          try {
            await storage(new PostgresPlatformState(freshPool), s.scope, async (repository) => {
              const readback = await repository.findOperation(mint.input.operationRef);
              assert.deepEqual(readback, operation);
              assert.equal(Object.hasOwn(readback, "originalReceipt"), false);
              assert.deepEqual(await repository.findRecord(s.record.target.recordRef), mint.next);
              assert.deepEqual(
                await repository.findMintClaim(s.record.target.recordRef),
                mint.claim,
              );
            });
          } finally {
            await freshPool.end();
          }
          const count = await pool.query(
            "SELECT count(*)::int AS count FROM occ.credential_inventory_mint_claims WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3",
            Object.values(s.scope),
          );
          assert.equal(count.rows[0].count, 1);
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
