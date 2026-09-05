import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError as legacyError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { PostgresCommitOutcomeUnknownError } from "@openclaw-enterprise/occ/ports/transaction-errors";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";
import { verifyPlatformStateStoreContract } from "../conformance/platform-state-store.contract.mjs";
import { RuntimeServiceTrustService } from "../../packages/occ/src/runtime-authority/service-trust.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  signal,
} from "../fixtures/runtime-service-trust.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for isolated migrated PostgreSQL integration.",
  timeout: 60000,
};
const id = (kind) => `${kind}_${randomUUID()}`;
const namespace = () => ({
  id: id("ns"),
  name: `repository-${randomUUID()}`,
  status: "ready",
  createdAt: new Date().toISOString(),
});

test(
  "PostgreSQL repositories retain closure, atomicity and exact unknown-commit readback",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      connectionTimeoutMillis: 250,
    });
    const store = new PostgresPlatformState(pool);
    t.after(() => pool.end());
    let installation = await store.loadInstallation();
    if (!installation)
      installation = await store.transact((unit) =>
        unit.installations.createInstallation({
          id: id("ins"),
          name: "Repository contracts",
          createdAt: new Date().toISOString(),
        }),
      );

    await t.test("read methods close even when their Installation value is cached", async () => {
      let read;
      await store.read(async (view) => {
        read = view;
        assert.ok(await view.installations.getInstallation());
        assert.equal((await store.queryInTransaction(view, "SELECT 1 AS value")).rows[0].value, 1);
        assert.ok(await view.installations.getInstallation());
        assert.deepEqual(Object.keys(view.audit), ["list"]);
        assert.deepEqual(Object.keys(view.operations), ["list"]);
        assert.equal(Object.hasOwn(view.namespaces, "lockNamespace"), false);
      });
      await assert.rejects(read.installations.getInstallation(), ScopeViolationError);
      assert.throws(() => store.queryInTransaction(read, "SELECT 1"), DependencyUnavailableError);
      await assert.rejects(read.namespaces.listNamespaces(), ScopeViolationError);
      assert.equal((await pool.query("SELECT 1 AS still_available")).rows[0].still_available, 1);
    });

    await t.test(
      "the owning transaction drains accepted SQL and closes queue and raw-query adapters",
      async () => {
        let unit;
        let queue;
        let accepted;
        let completed = false;
        await store.transactWithQueue(async (current, currentQueue) => {
          unit = current;
          queue = currentQueue;
          accepted = store
            .queryInTransaction(current, "SELECT pg_sleep(0.05), 1 AS value")
            .then((result) => {
              completed = true;
              return result;
            });
        });
        assert.equal(completed, true);
        assert.equal((await accepted).rows[0].value, 1);
        await assert.rejects(queue.pending(), ScopeViolationError);
        assert.throws(() => store.queryInTransaction(unit, "SELECT 1"), DependencyUnavailableError);
        await assert.rejects(unit.installations.getInstallation(), ScopeViolationError);
        assert.equal((await pool.query("SELECT 2 AS still_available")).rows[0].still_available, 2);
      },
    );

    await t.test(
      "the adapter retains the shared resource ownership and atomicity contract",
      async () => {
        await verifyPlatformStateStoreContract(store, { installation });
      },
    );

    await t.test(
      "a known callback rollback removes resource, work and audit together",
      async () => {
        const candidate = namespace();
        const eventId = id("aud");
        const failure = new Error("confirmed rollback");
        let retained;
        await assert.rejects(
          store.transact(async (unit) => {
            retained = unit;
            await unit.namespaces.createNamespace(candidate);
            await unit.operations.append({
              kind: "namespace",
              action: "reconcile",
              target: "ready",
              namespaceId: candidate.id,
              resourceId: candidate.id,
              actorId: "actor",
            });
            await unit.audit.append({
              id: eventId,
              installationId: installation.id,
              namespaceId: candidate.id,
              occurredAt: candidate.createdAt,
              kind: "mutation",
              actorId: "actor",
              action: "create",
              resource: { kind: "namespace", id: candidate.id, namespaceId: candidate.id },
              outcome: "success",
            });
            throw failure;
          }),
          (error) => error === failure,
        );
        assert.equal(
          await store.read((read) => read.namespaces.findNamespace(candidate.id)),
          undefined,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM occ.controller_work WHERE namespace_id=$1",
              [candidate.id],
            )
          ).rows[0].count,
          0,
        );
        assert.equal(
          (
            await pool.query("SELECT count(*)::int AS count FROM occ.audit_events WHERE id=$1", [
              eventId,
            ])
          ).rows[0].count,
          0,
        );
        await assert.rejects(retained.namespaces.createNamespace(namespace()), ScopeViolationError);
      },
    );

    await t.test(
      "bounded cancellation revokes cached reads without waiting for user work",
      async () => {
        const controller = new AbortController();
        let entered;
        const ready = new Promise((resolve) => {
          entered = resolve;
        });
        let retained;
        const operation = store.read(
          async (read) => {
            retained = read;
            await read.installations.getInstallation();
            entered();
            await new Promise(() => {});
          },
          { signal: controller.signal, timeoutMs: 1000 },
        );
        await ready;
        controller.abort();
        await assert.rejects(operation, DependencyUnavailableError);
        await assert.rejects(retained.installations.getInstallation(), ScopeViolationError);
        assert.throws(
          () => store.queryInTransaction(retained, "SELECT 1"),
          DependencyUnavailableError,
        );
        assert.equal((await pool.query("SELECT 3 AS still_available")).rows[0].still_available, 3);
      },
    );

    await t.test(
      "real COMMIT acknowledgement loss uses the canonical error and exact retained identity",
      async () => {
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 1000,
          query_timeout: 5000,
        });
        faultPool.on("error", () => {});
        const faultStore = new PostgresPlatformState(faultPool);
        const candidate = namespace();
        const eventId = id("aud");
        let retained;
        try {
          proxy.arm();
          await assert.rejects(
            faultStore.transact(async (unit) => {
              retained = unit;
              await unit.namespaces.createNamespace(candidate);
              await unit.operations.append({
                kind: "namespace",
                action: "reconcile",
                target: "ready",
                namespaceId: candidate.id,
                resourceId: candidate.id,
                actorId: "actor",
              });
              await unit.audit.append({
                id: eventId,
                installationId: installation.id,
                namespaceId: candidate.id,
                occurredAt: candidate.createdAt,
                kind: "mutation",
                actorId: "actor",
                action: "create",
                resource: { kind: "namespace", id: candidate.id, namespaceId: candidate.id },
                outcome: "success",
              });
            }),
            (error) =>
              error instanceof PostgresCommitOutcomeUnknownError && error instanceof legacyError,
          );
          assert.equal(proxy.observedCommit, true);
          assert.deepEqual(
            await store.read((read) => read.namespaces.findNamespace(candidate.id)),
            candidate,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.controller_work WHERE namespace_id=$1",
                [candidate.id],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await pool.query("SELECT count(*)::int AS count FROM occ.audit_events WHERE id=$1", [
                eventId,
              ])
            ).rows[0].count,
            1,
          );
          await assert.rejects(
            retained.namespaces.createNamespace(namespace()),
            ScopeViolationError,
          );
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );

    await t.test(
      "the actual service-trust consumer classifies lost COMMIT and recovers the original operation",
      async () => {
        const fixture = await createRuntimeServiceTrustFixture({ state: store, pool });
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 2,
          connectionTimeoutMillis: 250,
        });
        faultPool.on("error", () => {});
        try {
          const trust = new RuntimeServiceTrustService({
            ...fixture.options,
            state: new PostgresPlatformState(faultPool),
          });
          const request = sourceRequest(fixture.source.sourceRef);
          proxy.arm();
          assert.deepEqual(await trust.apply(request, fixture.context, signal()), {
            result: "commit-unknown",
            operationRef: request.operationRef,
            nextAction: "exact-readback-only",
          });
          assert.equal(proxy.observedCommit, true);
          const recovered = await fixture.trust.recover(
            request.operationRef,
            fixture.context,
            signal(),
          );
          assert.equal(recovered.operationRef, request.operationRef);
          assert.deepEqual(
            (await fixture.trust.apply(request, fixture.context, signal())).record,
            recovered,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM occ.runtime_service_trust_records WHERE operation_ref=$1",
                [request.operationRef],
              )
            ).rows[0].count,
            1,
          );
        } finally {
          await faultPool.end();
          await proxy.close();
          await fixture.close();
        }
      },
    );
  },
);
