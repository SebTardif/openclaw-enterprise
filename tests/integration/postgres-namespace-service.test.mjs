import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  OpenClawController,
  PostgresPlatformState,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { namespaceChildren } from "../conformance/namespace-repository.contract.mjs";

// Real PostgreSQL, Native IAM, MutationRunner and queue. Direct OCC lifecycle
// calls use the existing deterministic Compute fixture; they are conformance
// evidence, not a running production worker or live Kubernetes/runtime proof.
const databaseUrl = process.env.OCC_NAMESPACE_SERVICE_DATABASE_URL;
const id = (kind) => `${kind}_${randomUUID()}`;

test(
  "Namespace facade preserves PostgreSQL lifecycle, queue, ownership and atomicity",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_NAMESPACE_SERVICE_DATABASE_URL to a fresh migrated disposable PostgreSQL database.",
    timeout: 90_000,
  },
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 6,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      query_timeout: 12_000,
    });
    t.after(() => pool.end());
    const role = (
      await pool.query(
        "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(role, {
      name: "occ_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    const state = new PostgresPlatformState(pool);
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "Select a fresh database; existing Installation state must not be replaced.",
    );
    const installation = {
      id: id("ins"),
      name: "Namespace service PostgreSQL",
      createdAt: new Date().toISOString(),
    };
    const seed = createAuthPrincipalSeed(installation.id, "namespace-service", {
      id: id("account"),
    });
    const actor = seed.principal.id;
    state.setBootstrapNativeIAM({
      identities: [seed.principal],
      roles: seed.roles,
      bindings: seed.bindings,
      groups: [],
      memberships: [],
      restrictions: [],
    });
    const controller = new OpenClawController(installation, { state });
    const select = (driver) => {
      controller.registerDriver(driver);
      controller.selectDriver(driver.capability, driver.id);
    };
    select(new NativeIAMDriver(state));
    const create = () => controller.createNamespace(actor, { name: `Namespace ${randomUUID()}` });
    const audits = (namespaceId) =>
      state.read(async (view) =>
        (await view.audit.list()).filter((event) => event.namespaceId === namespaceId),
      );
    const counts = async (namespaceId) =>
      (
        await pool.query(
          `SELECT
    (SELECT count(*)::int FROM occ.namespaces WHERE id=$1) AS resources,
    (SELECT count(*)::int FROM occ.controller_work WHERE namespace_id=$1) AS work,
    (SELECT count(*)::int FROM occ.audit_events WHERE namespace_id=$1) AS audit`,
          [namespaceId],
        )
      ).rows[0];

    await t.test(
      "reads and rejected mutations leave singleton Installation unpersisted",
      async () => {
        assert.deepEqual(await controller.listNamespaces(actor), []);
        await assert.rejects(controller.getNamespace(actor, id("ns")), ScopeViolationError);
        await assert.rejects(controller.createNamespace(actor, { name: "" }), ScopeViolationError);
        await assert.rejects(
          controller.createNamespace("unknown", { name: "Denied" }),
          AuthorizationDeniedError,
        );
        await assert.rejects(controller.deleteNamespace(actor, id("ns")), ScopeViolationError);
        assert.equal(await state.loadInstallation(), undefined);
        const persisted = (
          await pool.query(
            "SELECT (SELECT count(*)::int FROM occ.controller_work) AS work, (SELECT count(*)::int FROM occ.audit_events) AS audit",
          )
        ).rows[0];
        assert.deepEqual(persisted, { work: 0, audit: 0 });
      },
    );

    await t.test(
      "create, real queue claim, readiness, idempotent delete and tombstone preserve exact identities",
      async () => {
        select(createDevelopmentComputeDriver());
        const owner = await create();
        assert.deepEqual(await state.loadInstallation(), installation);
        assert.equal(owner.status, "provisioning");
        assert.deepEqual(await controller.getNamespace(actor, owner.id), owner);
        assert.deepEqual(await controller.listNamespaces(actor), [owner]);
        assert.deepEqual(await counts(owner.id), { resources: 1, work: 1, audit: 0 });
        const queue = new PostgresWorkQueue(pool, { workKind: "namespace" });
        const prepare = await queue.claim();
        assert.equal(prepare.namespaceId, owner.id);
        assert.equal(prepare.actorId, actor);
        assert.equal(prepare.namespaceTarget, "ready");
        const ready = await controller.handleNamespaceLifecycle(actor, owner.id, "ready");
        assert.equal(ready.status, "ready");
        await queue.complete(prepare);
        const deleting = await controller.deleteNamespace(actor, owner.id);
        assert.equal(deleting.status, "deleting");
        assert.deepEqual(await controller.deleteNamespace(actor, owner.id), deleting);
        assert.deepEqual(await counts(owner.id), { resources: 1, work: 2, audit: 2 });
        const teardown = await queue.claim();
        assert.equal(teardown.namespaceId, owner.id);
        assert.equal(teardown.namespaceTarget, "deleted");
        const deleted = await controller.handleNamespaceLifecycle(actor, owner.id, "deleted");
        assert.ok(deleted.deletedAt);
        await queue.complete(teardown);
        assert.equal(await queue.claim(), undefined);
        await assert.rejects(controller.getNamespace(actor, owner.id), ScopeViolationError);
        assert.deepEqual(await controller.listNamespaces(actor), []);
        const allEvents = await audits(owner.id);
        assert.equal(
          allEvents.filter(
            (event) =>
              event.action === "reconcile" && event.details.reasonCode === "RECONCILE_SUCCEEDED",
          ).length,
          2,
        );
        const events = allEvents.filter((event) =>
          event.action.startsWith("openclaw.namespaces.lifecycle."),
        );
        assert.deepEqual(
          events.map((event) => event.action),
          ["openclaw.namespaces.lifecycle.ensure", "openclaw.namespaces.lifecycle.delete"],
        );
        for (const event of events) {
          assert.equal(event.installationId, installation.id);
          assert.equal(event.actorId, actor);
          assert.equal(event.outcome, "success");
          assert.deepEqual(event.resource, {
            kind: "namespace",
            id: owner.id,
            namespaceId: owner.id,
          });
          assert.equal(event.details.computeDriverId, "compute-local-development");
          assert.equal(event.iamDriverId, "occ-native-iam");
        }
        const work = (
          await pool.query("SELECT state FROM occ.controller_work WHERE namespace_id=$1", [
            owner.id,
          ])
        ).rows;
        assert.deepEqual(
          work.map((row) => row.state),
          ["succeeded", "succeeded"],
        );
        await assert.rejects(
          controller.createNamespace(actor, { name: owner.name }),
          ResourceConflictError,
        );
      },
    );

    await t.test(
      "each persisted child kind prevents deletion without affecting an empty tenant",
      async () => {
        for (const kind of ["configuration", "agent", "secret", "account"]) {
          const owner = await create();
          await controller.handleNamespaceLifecycle(actor, owner.id, "ready");
          const children = namespaceChildren(owner);
          // Seed complete records through production repositories; an Agent retains
          // its required Configuration, while other child kinds are isolated.
          await controller.transact(async (unit) => {
            if (kind === "configuration" || kind === "agent")
              await unit.configurations.createConfiguration(children.configuration);
            if (kind === "agent") await unit.agents.createAgent(children.agent);
            if (kind === "secret") await unit.secrets.createSecret(children.secret);
            if (kind === "account")
              await unit.serviceAccounts.createServiceAccount(children.account);
          });
          const before = await counts(owner.id);
          await assert.rejects(controller.deleteNamespace(actor, owner.id), NamespaceNotEmptyError);
          assert.equal((await controller.getNamespace(actor, owner.id)).status, "ready");
          assert.deepEqual(await counts(owner.id), before);
        }
        const empty = await create();
        assert.equal((await controller.deleteNamespace(actor, empty.id)).status, "deleting");
      },
    );

    await t.test(
      "real audit uniqueness failure rolls back Namespace, lifecycle result and queued work",
      async () => {
        let candidate;
        // A duplicate persisted audit ID fails in PostgreSQL after the nested facade
        // has staged its resource, lifecycle audit and both reconciliation intents.
        await assert.rejects(
          controller.transact(async (unit) => {
            candidate = await create();
            await controller.handleNamespaceLifecycle(actor, candidate.id, "ready");
            await controller.deleteNamespace(actor, candidate.id);
            const event = (await unit.audit.list()).find((row) => row.namespaceId === candidate.id);
            assert.ok(event);
            assert.equal(
              (await unit.operations.list()).filter((row) => row.namespaceId === candidate.id)
                .length,
              2,
            );
            await unit.audit.append(event);
          }),
          ResourceConflictError,
        );
        assert.deepEqual(await counts(candidate.id), { resources: 0, work: 0, audit: 0 });
        await assert.rejects(controller.getNamespace(actor, candidate.id), ScopeViolationError);
        assert.deepEqual(await state.loadInstallation(), installation);
      },
    );

    await t.test(
      "foreign result fails closed and a delayed successful ensure cannot revive deleting state",
      async () => {
        const owner = await create();
        const compute = createDevelopmentComputeDriver();
        select({
          ...compute,
          id: "compute-foreign-result",
          async ensureNamespace() {
            return { namespaceId: id("foreign"), namespaceReady: true };
          },
        });
        await assert.rejects(
          controller.handleNamespaceLifecycle(actor, owner.id, "ready"),
          DependencyUnavailableError,
        );
        assert.equal((await controller.getNamespace(actor, owner.id)).status, "provisioning");
        assert.equal((await audits(owner.id)).at(-1).details.failure, "invalid_driver_result");
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        select({
          ...compute,
          id: "compute-delayed-result",
          async ensureNamespace(namespace) {
            entered.resolve();
            await release.promise;
            return compute.ensureNamespace(namespace);
          },
        });
        const pending = controller.handleNamespaceLifecycle(actor, owner.id, "ready");
        await entered.promise;
        try {
          // Delete commits through another real transaction while the fixture effect
          // is in flight. The stale result must fail its persisted-state recheck.
          const deleting = await controller.deleteNamespace(actor, owner.id);
          const before = await audits(owner.id);
          release.resolve();
          assert.deepEqual(await pending, deleting);
          assert.deepEqual(await audits(owner.id), before);
          assert.equal((await controller.getNamespace(actor, owner.id)).status, "deleting");
        } finally {
          release.resolve();
        }
      },
    );

    await t.test(
      "exact tenant grants and a changed current IAM selection control facade reads and deletes",
      async () => {
        const owner = await create();
        const foreign = await create();
        const reader = {
          kind: "principal",
          id: id("reader"),
          issuer: "namespace-service",
          subject: "reader",
        };
        const role = {
          id: id("role"),
          namespaceId: owner.id,
          permissions: [{ action: "read", resourceKind: "namespace" }],
        };
        await state.seedNativeIAM({
          identities: [reader],
          roles: [role],
          groups: [],
          memberships: [],
          restrictions: [],
          bindings: [
            {
              id: id("binding"),
              namespaceId: owner.id,
              subjectKind: "identity",
              subjectId: reader.id,
              roleId: role.id,
              resourceKind: "namespace",
              resourceId: owner.id,
            },
          ],
        });
        assert.deepEqual(await controller.listNamespaces(reader.id), [owner]);
        assert.deepEqual(await controller.getNamespace(reader.id, owner.id), owner);
        await assert.rejects(
          controller.getNamespace(reader.id, foreign.id),
          AuthorizationDeniedError,
        );
        await assert.rejects(
          controller.deleteNamespace(reader.id, owner.id),
          AuthorizationDeniedError,
        );
        // Lifecycle evidence and subsequent scoped reads use the current
        // selected Native IAM instance against actual persisted grants.
        select(new NativeIAMDriver(state, { id: "native-reselected" }));
        controller.selectDriver("compute", "compute-local-development");
        await controller.handleNamespaceLifecycle(actor, owner.id, "ready");
        assert.equal((await audits(owner.id)).at(-1).iamDriverId, "native-reselected");
        const readyOwner = await controller.getNamespace(actor, owner.id);
        assert.equal(readyOwner.status, "ready");
        assert.deepEqual(await controller.listNamespaces(reader.id), [readyOwner]);
      },
    );
  },
);
