import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  createGatewayStartupOwnerV1,
  GatewayStartupOwnerPhaseV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { createPostgresGatewayStartupV1 } from "../../packages/occ/src/gateway-startup-v1/postgres.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import {
  controlledOwner,
  submissionCommand,
  consumeCommand,
} from "../fixtures/gateway-startup-v1/values.mjs";

const selected = process.env.OCC_GATEWAY_STARTUP_PG === "1";
test(
  "Gateway startup owner and borrowed PostgreSQL backend",
  { skip: !selected && "No separately allocated Gateway startup PostgreSQL fixture selected" },
  async (t) => {
    const address = new URL(process.env.OCC_GATEWAY_STARTUP_DATABASE_URL ?? "");
    assert.ok(["127.0.0.1", "[::1]"].includes(address.hostname));
    assert.equal(address.username, "occ_app");
    assert.match(address.pathname, /^\/oce_gateway_startup_[a-z0-9_]+$/u);
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: address.href, max: 2 });
    t.after(() => pool.end());
    const installation = await pool.query("SELECT id FROM occ.installation");
    assert.equal(
      installation.rows.length,
      1,
      "Fixture setup must create the original Installation",
    );
    const installationId = installation.rows[0].id;
    assert.equal(
      (await pool.query("SELECT installation_id FROM occ.gateway_startup_heads")).rows.length,
      0,
      "This suite requires fresh retained startup storage; it never resets it",
    );
    const f = await controlledOwner();
    const consumeAuthority = f.participants.authority.consume;
    f.participants.authority.consume = async (invocation, command, bounds, unit, io) => {
      const lease = await consumeAuthority(invocation, command, bounds, unit, io);
      return {
        ...lease,
        async release() {
          unit.assertClientSettled();
          await lease.release();
        },
      };
    };
    f.participants.allocate = (kind) =>
      kind === "audit" ? `aud_${randomUUID()}` : `${kind}_${randomUUID()}`;
    let omitHead = false;
    f.participants.audit.append = async (event, attribution, _unit, io) => {
      await io.query(
        "INSERT INTO occ.audit_events(id,occurred_at,kind,actor_id,action,resource_kind,resource_id,outcome,details) VALUES($1,now(),'controlled-startup',$2,$3,'installation',$4,'success',$5::jsonb)",
        [
          event.auditEventId,
          attribution.actorId,
          event.kind,
          installationId,
          JSON.stringify({ operationRef: event.command.operationRef }),
        ],
      );
    };
    const backend = createPostgresGatewayStartupV1(installationId);
    // This test owns the actual pg client and COMMIT, while exercising the real
    // public owner/phase/backend. It does not replace the pending central store
    // wiring proof or claim genuine account/IAM/native/physical participants.
    const transaction = {
      async run(_command, _bounds, work) {
        const client = await pool.connect();
        const lifetime = new RepositoryTransactionLifetime();
        const phase = new GatewayStartupOwnerPhaseV1(lifetime, (sql, params) =>
          client.query(sql, params),
        );
        let sent = false,
          acknowledged = false;
        let response = { kind: "unknown" };
        let cleanupFailed = false;
        let clientSettled = false;
        let discard = false;
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await work({
            installationId,
            phase,
            backend: omitHead ? { ...backend, async advanceHead() {} } : backend,
            policy: {},
            assertClientSettled() {
              assert.equal(
                clientSettled,
                true,
                "Authority lease must survive actual client release",
              );
            },
          });
          await phase.drainAccepted();
          await lifetime.finish();
          const completion = phase.finalize();
          if (completion.kind === "rollback") {
            await client.query("ROLLBACK");
            response = { kind: "rolled-back", response: completion.response };
          } else {
            phase.markCommitDispatched();
            sent = true;
            const result = await client.query("COMMIT");
            phase.observeCommitAcknowledgement(result.command);
            acknowledged = true;
            response = { kind: "committed", response: completion.provisional };
          }
        } catch (error) {
          phase.poison(error);
          // A failed synchronous fence may have registered an invalid thenable.
          // Drain it while every participant remains owned, before terminal I/O.
          await phase.drainAccepted();
          await lifetime.finish();
          try {
            await client.query("ROLLBACK");
          } catch {
            discard = true;
          }
        } finally {
          try {
            await phase.drainAccepted();
            await lifetime.finish();
          } catch {
            cleanupFailed = true;
          }
          try {
            client.release(discard || (sent && !acknowledged));
            clientSettled = true;
          } catch {
            cleanupFailed = true;
          }
          try {
            // Invoke once after actual client settlement. A later cleanup error
            // cannot change an acknowledged COMMIT into a non-commit fact.
            await phase.finishTerminal(
              acknowledged ? "committed" : sent ? "commit-unknown" : "rolled-back",
            );
          } catch {
            cleanupFailed = true;
          }
        }
        return cleanupFailed ? { kind: "unknown" } : response;
      },
    };
    const owner = createGatewayStartupOwnerV1({ transaction, participants: f.participants });
    const execute = (c) => owner.execute(c, f.token, f.bounds);
    const accept = { ...f.accept, operationRef: `accept_${randomUUID()}` };
    let accepted, submitted;
    await t.test(
      "original acceptance writes exact event, head and mandatory audit atomically",
      async () => {
        accepted = await execute(accept);
        assert.equal(accepted.kind, "accepted");
        assert.equal(accepted.record.binding.startup.installationId, installationId);
        const rows = await pool.query(
          "SELECT o.record,h.head_version,a.id FROM occ.gateway_startup_operations o JOIN occ.gateway_startup_heads h ON h.latest_operation_ref=o.operation_ref JOIN occ.audit_events a ON a.id=o.audit_event_id",
        );
        assert.equal(rows.rows.length, 1);
        assert.equal(
          rows.rows[0].record.acceptance.binding.createEffectRef,
          accepted.record.binding.createEffectRef,
        );
      },
    );
    await t.test(
      "concurrent original submission retains exactly one event and no retry permission",
      async () => {
        const command = submissionCommand(accepted, `submit_${randomUUID()}`);
        const results = await Promise.all([execute(command), execute(command)]);
        assert.equal(results.filter((x) => x.kind === "submitted").length, 1);
        assert.equal(results.filter((x) => x.kind === "recovery-required").length, 1);
        submitted = results.find((x) => x.kind === "submitted");
      },
    );
    await t.test("deferred omitted-head commit rejects all event and audit writes", async () => {
      const before = await pool.query("SELECT count(*)::int AS n FROM occ.audit_events");
      omitHead = true;
      const result = await execute(consumeCommand(accepted, submitted));
      omitHead = false;
      assert.equal(result.kind, "recovery-required");
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM occ.audit_events")).rows[0].n,
        before.rows[0].n,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM occ.gateway_startup_operations WHERE kind='consume-startup'",
          )
        ).rows[0].n,
        0,
      );
    });
    await t.test(
      "proper original recipient consume and current read preserve source identity",
      async () => {
        const command = consumeCommand(accepted, submitted);
        const consumed = await execute(command);
        assert.equal(consumed.kind, "consumed");
        const current = await execute({
          schemaVersion: 1,
          kind: "read-current",
          startup: accepted.record.binding.startup,
          expectedRecordVersion: 3,
          recipient: command.recipient,
        });
        assert.equal(current.kind, "current");
        assert.deepEqual(current.record.acceptance, accepted.record);
      },
    );
    await t.test(
      "limited application role cannot rewrite or truncate original history",
      async () => {
        for (const sql of [
          "UPDATE occ.gateway_startup_operations SET record=record",
          "DELETE FROM occ.gateway_startup_operations",
          "TRUNCATE occ.gateway_startup_operations",
          "DELETE FROM occ.gateway_startup_heads",
        ]) {
          await assert.rejects(pool.query(sql), (error) => ["42501", "23514"].includes(error.code));
        }
      },
    );
    await t.test("wrong head identity cannot be repaired through a direct update", async () => {
      await assert.rejects(
        pool.query(
          "UPDATE occ.gateway_startup_heads SET process_generation=process_generation+1 WHERE installation_id=$1",
          [installationId],
        ),
        (error) => error.code === "23514",
      );
    });
  },
);
