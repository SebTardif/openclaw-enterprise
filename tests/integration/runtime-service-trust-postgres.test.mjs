import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import pg from "pg";
import {
  PostgresPlatformState,
  RuntimeServiceTrustService,
  ResourceConflictError,
  AuthorizationDeniedError,
  canonicalRuntimeServiceTrust,
  runtimeServiceTrustDigest,
} from "../../packages/occ/src/index.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  signal,
} from "../fixtures/runtime-service-trust.mjs";
const databaseUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL;
const migratorUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL;
const options = {
  skip: databaseUrl ? false : "Select real limited-role registry PostgreSQL.",
  timeout: 60000,
};
async function until(check, timeout = 1500) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Expected PostgreSQL condition did not occur within the bound.");
}

test(
  "PostgreSQL service registry: real human policy, atomic audit, retained replay, CAS and fresh-pool recovery",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const f = await createRuntimeServiceTrustFixture({ state, pool });
    t.after(() => f.close());
    const request = sourceRequest(f.source.sourceRef);
    const first = await f.trust.apply(request, f.context, signal());
    assert.equal(first.result, "applied");
    assert.deepEqual((await f.trust.apply(request, f.context, signal())).record, first.record);
    const current = await pool.query(
      "SELECT r.record_version,a.id FROM occ.runtime_service_trust_records r JOIN occ.audit_events a ON a.id=r.audit_id WHERE r.operation_ref=$1",
      [request.operationRef],
    );
    assert.equal(current.rowCount, 1);
    await t.test("two real transactions retain exactly one next-version admission", async () => {
      const results = await Promise.allSettled([
        f.trust.apply(sourceRequest(f.source.sourceRef, 1), f.context, signal()),
        f.trust.apply(sourceRequest(f.source.sourceRef, 1), f.context, signal()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        results.find((r) => r.status === "rejected").reason instanceof ResourceConflictError,
      );
    });
    await t.test("global operation identity serializes different source locks", async () => {
      const other = { ...f.source, sourceRef: `source/${randomUUID()}` };
      const trust = new RuntimeServiceTrustService({ ...f.options, sources: [f.source, other] });
      const operationRef = randomUUID();
      const results = await Promise.allSettled([
        trust.apply({ ...sourceRequest(f.source.sourceRef, 2), operationRef }, f.context, signal()),
        trust.apply({ ...sourceRequest(other.sourceRef), operationRef }, f.context, signal()),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        results.find((r) => r.status === "rejected").reason instanceof ResourceConflictError,
      );
    });
    await t.test("fresh pool and current service recover historical immutable input", async () => {
      const freshPool = new pg.Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 250,
      });
      try {
        const fresh = new PostgresPlatformState(freshPool);
        const trust = new RuntimeServiceTrustService({ ...f.options, state: fresh, sources: [] });
        assert.deepEqual(
          await trust.recover(request.operationRef, f.context, signal()),
          first.record,
        );
        assert.deepEqual((await trust.apply(request, f.context, signal())).record, first.record);
      } finally {
        await freshPool.end();
      }
    });
    await t.test("caught same-unit failure rolls back registry and matching audit", async () => {
      const source = { ...f.source, sourceRef: `source/${randomUUID()}` };
      const trust = new RuntimeServiceTrustService({ ...f.options, sources: [source] });
      const good = sourceRequest(source.sourceRef);
      await assert.rejects(
        state.transact(async (unit) => {
          await trust.applyInTransaction(unit, good, f.context, signal());
          await assert.rejects(
            trust.applyInTransaction(
              unit,
              { ...sourceRequest(source.sourceRef), actorId: "forged" },
              f.context,
              signal(),
            ),
          );
        }),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM occ.runtime_service_trust_records WHERE operation_ref=$1",
            [good.operationRef],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query("SELECT 1 FROM occ.audit_events WHERE details->>'operationRef'=$1", [
            good.operationRef,
          ])
        ).rowCount,
        0,
      );
    });
    await t.test(
      "a cancelled exact replay after a real operation lock wait discloses no receipt",
      async () => {
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-operation:'||$1,0))",
            [request.operationRef],
          );
          const control = new AbortController();
          const replay = f.trust.apply(request, f.context, control.signal);
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock' AND query LIKE '%runtime-service-trust-operation:%'",
                )
              ).rowCount === 1,
          );
          control.abort();
          await blocker.query("ROLLBACK");
          await assert.rejects(replay);
          assert.deepEqual(
            (await f.trust.apply(request, f.context, signal())).record,
            first.record,
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      },
    );
    await t.test(
      "a human grant withdrawn during the real replay lock wait is rechecked",
      {
        skip: migratorUrl
          ? false
          : "Select migrator for exact fixture IAM grant withdrawal/restore.",
      },
      async () => {
        const administrativePool = new pg.Pool({
          connectionString: migratorUrl,
          max: 2,
          connectionTimeoutMillis: 250,
        });
        const blocker = await pool.connect();
        const bindingId = f.seed.bindings[0].id;
        const saved = (
          await administrativePool.query("SELECT * FROM occ.iam_access_bindings WHERE id=$1", [
            bindingId,
          ])
        ).rows[0];
        assert.ok(saved);
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-operation:'||$1,0))",
            [request.operationRef],
          );
          const replay = f.trust.apply(request, f.context, signal());
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock' AND query LIKE '%runtime-service-trust-operation:%'",
                )
              ).rowCount === 1,
          );
          // Explicit administrator-side fixture policy change, not a product grant-management API.
          // Only this test's preprovisioned binding is withdrawn and restored below.
          await administrativePool.query("DELETE FROM occ.iam_access_bindings WHERE id=$1", [
            bindingId,
          ]);
          await blocker.query("ROLLBACK");
          await assert.rejects(replay, (error) => error instanceof AuthorizationDeniedError);
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
          await administrativePool.query(
            "INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,group_subject_id,role_id,resource_kind,resource_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING",
            [
              saved.id,
              saved.namespace_id,
              saved.identity_subject_id,
              saved.group_subject_id,
              saved.role_id,
              saved.resource_kind,
              saved.resource_id,
            ],
          );
          await administrativePool.end();
        }
        assert.deepEqual((await f.trust.apply(request, f.context, signal())).record, first.record);
      },
    );
    if (
      process.env.OCC_RUNTIME_SERVICE_TRUST_RESTART_RECEIPT &&
      process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY
    ) {
      const admitted = await f.request(
        "POST",
        "/v1/runtime-service-trust/operations",
        serviceRequest(f),
      );
      assert.equal(admitted.status, 200, JSON.stringify(admitted));
      const active = await f.trust.readCurrentRecord(admitted.data.record.subjectRef, signal());
      assert.ok(active);
      await writeFile(
        process.env.OCC_RUNTIME_SERVICE_TRUST_RESTART_RECEIPT,
        JSON.stringify(
          { record: admitted.data.record, source: f.source, current: active },
          null,
          2,
        ) + "\n",
      );
    }
    await t.test("limited application role cannot update/delete retained records", async () => {
      await assert.rejects(
        pool.query(
          "UPDATE occ.runtime_service_trust_records SET actor_id=actor_id WHERE operation_ref=$1",
          [request.operationRef],
        ),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        pool.query("DELETE FROM occ.runtime_service_trust_records WHERE operation_ref=$1", [
          request.operationRef,
        ]),
        (e) => e.code === "42501",
      );
    });
  },
);

test(
  "bounded canonical PostgreSQL reads drain exhausted checkout and original blocked backend",
  {
    ...options,
    skip:
      databaseUrl && migratorUrl
        ? false
        : "Select app and migrator URLs for actual lock/cancellation proof.",
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 250,
    });
    const lockPool = new pg.Pool({
      connectionString: migratorUrl,
      max: 1,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
    t.after(() => lockPool.end());
    const state = new PostgresPlatformState(pool);
    await t.test(
      "aborted checkout returns only after its real queue waiter is removed",
      async () => {
        const clients = await Promise.all([pool.connect(), pool.connect()]);
        try {
          const control = new AbortController();
          let invoked = false;
          const pending = state.read(
            async () => {
              invoked = true;
            },
            { signal: control.signal, timeoutMs: 3000 },
          );
          await delay(20);
          control.abort();
          await assert.rejects(pending);
          assert.equal(invoked, false);
          assert.equal(pool.waitingCount, 0);
          assert.equal(pool.totalCount, 2);
        } finally {
          clients.forEach((c) => c.release());
        }
      },
    );
    await t.test(
      "cancel destroys and joins the actual blocked history read while blocker stays held",
      async () => {
        const blocker = await lockPool.connect();
        let pid;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "LOCK TABLE occ.runtime_authority_operations IN ACCESS EXCLUSIVE MODE",
          );
          const control = new AbortController();
          const pending = state.read(
            async (unit) => {
              pid = (await state.queryInTransaction(unit, "SELECT pg_backend_pid() AS pid")).rows[0]
                .pid;
              // Execute the actual authority repository SELECT; no query or repository monkeypatch.
              return unit.runtimeAuthority.findOperation(
                {
                  installationId: (await unit.installations.getInstallation()).id,
                  namespaceId: `ns_${randomUUID()}`,
                  agentId: `agt_${randomUUID()}`,
                },
                randomUUID(),
              );
            },
            { signal: control.signal, timeoutMs: 3000 },
          );
          await until(
            async () =>
              pid !== undefined &&
              (
                await pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
                  [pid],
                )
              ).rowCount === 1,
          );
          const began = performance.now();
          control.abort();
          await assert.rejects(pending);
          await until(
            async () =>
              (await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).rowCount ===
              0,
            1200,
          );
          assert.ok(performance.now() - began < 1500);
          assert.equal(pool.waitingCount, 0);
          assert.equal(
            (
              await blocker.query(
                "SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND mode='AccessExclusiveLock' AND granted",
              )
            ).rowCount,
            1,
          );
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      },
    );
  },
);

test(
  "limited-role SQL rejects malformed canonical sources and forged audit attribution",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const f = await createRuntimeServiceTrustFixture({ state, pool });
    t.after(() => f.close());
    const accepted = (await f.trust.apply(sourceRequest(f.source.sourceRef), f.context, signal()))
      .record;
    const originalAudit = (
      await pool.query("SELECT * FROM occ.audit_events WHERE id=$1", [accepted.auditId])
    ).rows[0];
    const cases = [
      [
        "noncanonical 24-hour timestamp alias",
        (record, audit) => {
          // Both scalar timestamps represent the same instant; the inherited closed
          // record shape must still reject this spelling that the TypeScript parser rejects.
          record.committedAt = "2026-09-05T24:00:00.000Z";
          audit.occurred_at = "2026-09-06T00:00:00.000Z";
        },
      ],
      [
        "missing protected source field",
        (record) => {
          delete record.source.workloadApiSocketPath;
        },
      ],
      [
        "unknown protected source field",
        (record) => {
          record.source.role = "lifecycle-authority";
        },
      ],
      [
        "wrong source digest",
        (record) => {
          record.sourceConfigurationDigest = `sha256:${"9".repeat(64)}`;
        },
      ],
      [
        "different record actor",
        (record) => {
          record.actorId = "principal/foreign";
        },
      ],
      [
        "wrong original human issuer",
        (_record, audit) => {
          audit.details.__occAuditMetadata.actor.issuer = "foreign-issuer";
        },
      ],
      [
        "missing original human subject",
        (_record, audit) => {
          delete audit.details.__occAuditMetadata.actor.subject;
        },
      ],
      [
        "different audit operation",
        (_record, audit) => {
          audit.details.operationRef = randomUUID();
        },
      ],
      [
        "missing actual decision evidence",
        (_record, audit) => {
          delete audit.details.checks[0].decision.evidence;
        },
      ],
      [
        "whitespace canonical alias",
        (record) => {
          record.canonicalRequest = " " + record.canonicalRequest;
        },
      ],
      [
        "duplicate canonical key",
        (record) => {
          record.canonicalRequest = record.canonicalRequest.replace(
            '"kind":"source-admit"',
            '"kind":"source-admit","kind":"source-admit"',
          );
        },
      ],
      [
        "fractional canonical integer alias",
        (record) => {
          record.canonicalRequest = record.canonicalRequest.replace(
            '"schemaVersion":1',
            '"schemaVersion":1.0',
          );
        },
      ],
    ];
    async function attempt(change) {
      const request = sourceRequest(`source/${randomUUID()}`);
      const source = { ...f.source, sourceRef: request.sourceRef };
      const record = {
        ...structuredClone(accepted),
        subjectRef: request.sourceRef,
        operationRef: request.operationRef,
        recordVersion: 1,
        canonicalRequest: canonicalRuntimeServiceTrust(request),
        requestDigest: runtimeServiceTrustDigest(request),
        auditId: `aud_${randomUUID()}`,
        committedAt: new Date().toISOString(),
        source,
        sourceConfigurationDigest: runtimeServiceTrustDigest(source),
      };
      const audit = structuredClone(originalAudit);
      audit.id = record.auditId;
      audit.occurred_at = record.committedAt;
      audit.details = {
        ...audit.details,
        operationRef: record.operationRef,
        subjectRef: record.subjectRef,
        recordVersion: 1,
        requestDigest: record.requestDigest,
      };
      change?.(record, audit);
      // Recompute the raw digest for canonical-text negatives: the canonical check, not an
      // accidentally stale digest, must reject reordered/duplicate/numeric alias bytes.
      if (record.canonicalRequest !== canonicalRuntimeServiceTrust(request)) {
        record.requestDigest = `sha256:${createHash("sha256").update(record.canonicalRequest).digest("hex")}`;
        audit.details.requestDigest = record.requestDigest;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO occ.audit_events(id,occurred_at,kind,actor_id,action,namespace_id,resource_kind,resource_id,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
          [
            audit.id,
            audit.occurred_at,
            audit.kind,
            audit.actor_id,
            audit.action,
            audit.namespace_id,
            audit.resource_kind,
            audit.resource_id,
            audit.outcome,
            JSON.stringify(audit.details),
          ],
        );
        await client.query(
          "INSERT INTO occ.runtime_service_trust_records(installation_id,subject_kind,subject_ref,record_version,operation_ref,actor_id,audit_id,canonical_request,request_digest,committed_at,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
          [
            record.installationId,
            record.subjectKind,
            record.subjectRef,
            record.recordVersion,
            record.operationRef,
            record.actorId,
            record.auditId,
            record.canonicalRequest,
            record.requestDigest,
            record.committedAt,
            JSON.stringify(record),
          ],
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    await attempt();
    for (const [name, change] of cases)
      await t.test(name, () => assert.rejects(attempt(change), (error) => error.code === "23514"));
  },
);

test(
  "real lost COMMIT acknowledgement returns exact HTTP locator and recovers original immutable admission",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    t.after(() => pool.end());
    const state = new PostgresPlatformState(pool);
    const f = await createRuntimeServiceTrustFixture({ state, pool });
    t.after(() => f.close());
    const proxy = await runtimeCommitAckProxy(databaseUrl);
    t.after(() => proxy.close());
    const faultPool = new pg.Pool({
      connectionString: proxy.url,
      max: 2,
      connectionTimeoutMillis: 250,
    });
    t.after(() => faultPool.end());
    const faultState = new PostgresPlatformState(faultPool);
    const trust = new RuntimeServiceTrustService({ ...f.options, state: faultState });
    const app = createFastifyApp({ ...f.appOptions, runtimeServiceTrust: trust });
    t.after(() => app.close());
    await app.ready();
    const request = sourceRequest(f.source.sourceRef);
    proxy.arm();
    const response = await app.inject({
      method: "POST",
      url: "/v1/runtime-service-trust/operations",
      headers: f.headers,
      payload: request,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(proxy.observedCommit, true);
    assert.deepEqual(response.json().data, {
      result: "commit-unknown",
      operationRef: request.operationRef,
      nextAction: "exact-readback-only",
    });
    const recovered = await f.request(
      "GET",
      `/v1/runtime-service-trust/operations/${request.operationRef}`,
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.operationRef, request.operationRef);
    const withdrawal = {
      schemaVersion: 1,
      kind: "source-withdraw",
      sourceRef: f.source.sourceRef,
      expectedVersion: 1,
      operationRef: randomUUID(),
    };
    await f.trust.apply(withdrawal, f.context, signal());
    const replay = await f.trust.apply(request, f.context, signal());
    assert.equal(replay.result, "exact-replay");
    assert.deepEqual(replay.record, recovered.data);
    assert.equal(
      (
        await state.read((unit) =>
          unit.runtimeServiceTrust.latest(f.owner.installation.id, "source", f.source.sourceRef),
        )
      ).kind,
      "source-withdraw",
    );
  },
);
