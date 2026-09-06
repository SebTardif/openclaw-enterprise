import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { inertProfileRequest } from "../fixtures/workload-profile.mjs";
import { runtimeCommitAckProxy } from "../fixtures/postgres-runtime-assignment-commit-ack-fault.mjs";

// Internal actual policy/storage unit only. These synthetic actors are not an
// authenticated account participant, and no HTTP/service admission is enabled.
const databaseUrl = process.env.OCC_WORKLOAD_PROFILE_GUARD_DATABASE_URL;
const migratorUrl = process.env.OCC_WORKLOAD_PROFILE_GUARD_MIGRATOR_DATABASE_URL;
const options = {
  skip:
    !databaseUrl || !migratorUrl
      ? "Allocate and migrate the dedicated guarded-profile PostgreSQL fixture."
      : false,
  timeout: 150_000,
};
for (const value of [databaseUrl, migratorUrl].filter(Boolean)) {
  const url = new URL(value);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/openclaw_profile_guard_[a-z0-9_]+$/);
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(work, message) {
  const end = performance.now() + 2500;
  do {
    if (await work()) return;
    await delay(20);
  } while (performance.now() < end);
  assert.fail(message);
}
function compose(pool) {
  const state = new PostgresPlatformState(pool);
  const iam = new NativeIAMDriver(state, { id: "profile-policy-native" });
  const selection = new DriverSelection();
  selection.registerDriver(iam);
  selection.selectDriver("iam", iam.id);
  return { state, iam, selection };
}

test(
  "guarded PostgreSQL profile policy, preparation and terminal transaction ownership",
  options,
  async (t) => {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 250,
    });
    const migrator = new pg.Pool({
      connectionString: migratorUrl,
      max: 3,
      connectionTimeoutMillis: 250,
    });
    pool.on("error", () => {});
    t.after(async () => {
      await pool.end();
      await migrator.end();
    });
    const { state, iam, selection } = compose(pool);
    const ident = (
      await pool.query(
        "SELECT current_user, current_database(), rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(ident.current_user, "occ_app");
    assert.equal(ident.rolsuper, false);
    assert.equal(ident.rolcreaterole, false);
    // Repeated verification preserves prior immutable fixture history. Each run
    // allocates a distinct real Namespace/principal and charges only its new rows.
    const baseline = (
      await pool.query(`SELECT
      (SELECT count(*)::int FROM occ.workload_profile_operations) operations,
      (SELECT count(*)::int FROM occ.audit_events WHERE action='openclaw.workload-profile.prepare') audits,
      coalesce((SELECT sum(ordinary_operations)::int FROM occ.workload_profile_capacity),0) capacity`)
    ).rows[0];
    assert.equal(baseline.operations, baseline.audits);
    assert.equal(baseline.operations, baseline.capacity);
    let installation = await state.loadInstallation();
    if (!installation)
      installation = await state.transact((u) =>
        u.installations.createInstallation({
          id: `ins_${randomUUID()}`,
          name: "Guarded profile fixture",
          createdAt: new Date().toISOString(),
        }),
      );
    const namespace = {
      id: `ns_${randomUUID()}`,
      name: `Guarded profile ${randomUUID()}`,
      status: "ready",
      createdAt: new Date().toISOString(),
    };
    await state.transact((u) => u.namespaces.createNamespace(namespace));
    const seed = createAuthPrincipalSeed(installation.id, "guarded-profile-fixture", {
      id: `synthetic-account/${randomUUID()}`,
    });
    await state.seedNativeIAM({
      identities: [seed.principal],
      roles: seed.roles,
      bindings: seed.bindings,
      groups: [],
      memberships: [],
      restrictions: [],
    });
    const actor = {
      principal: seed.principal,
      accountRef: seed.principal.subject,
      requestId: "profile-fixture-request",
      admissionDecisionId: "profile-fixture-internal-policy",
    };
    const request = () => inertProfileRequest({ namespaceId: namespace.id });
    const run = (work, signal = new AbortController().signal, timeoutMs = 3000) =>
      state.workloadProfileTransaction(selection, work, { signal, timeoutMs });
    const prepare = (input, subject = actor) => run((u) => u.prepare(input, subject));
    const read = (input, subject = actor) =>
      run((u) => u.readOperation(input.operationRef, subject));
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT (SELECT count(*)::int FROM occ.workload_profile_operations) operations,
    (SELECT count(*)::int FROM occ.audit_events WHERE action='openclaw.workload-profile.prepare') audits,
    coalesce((SELECT ordinary_operations FROM occ.workload_profile_capacity WHERE installation_id=$1),0) capacity`,
          [installation.id],
        )
      ).rows[0];
    const mapping = async (status) =>
      migrator.query(
        `UPDATE occ.iam_access_bindings SET channel_administration=jsonb_set(jsonb_set(channel_administration,'{status}',to_jsonb($2::text)),'{version}',to_jsonb((channel_administration->>'version')::bigint+1)) WHERE id=$1 AND channel_administration->>'status'<>$2`,
        [seed.bindings[0].id, status],
      );

    await t.test("fixed lock helper grants only bounded transaction lock acquisition", async () => {
      const proc = (
        await pool.query(
          `SELECT p.prosecdef,p.pronargs,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='occ.lock_workload_profile_iam()'::regprocedure`,
        )
      ).rows[0];
      assert.equal(proc.prosecdef, true);
      assert.equal(proc.pronargs, 0);
      assert.equal(proc.rolname, "occ_migrator");
      assert.deepEqual(proc.proconfig, ["search_path=pg_catalog, pg_temp"]);
      const rights = (
        await pool.query(`SELECT has_function_privilege(current_user,'occ.lock_workload_profile_iam()','EXECUTE') execute,
      has_table_privilege(current_user,'occ.iam_roles','UPDATE') update,
      has_table_privilege(current_user,'occ.iam_roles','DELETE') delete,
      has_table_privilege(current_user,'occ.iam_roles','MAINTAIN') maintain`)
      ).rows[0];
      assert.deepEqual(rights, { execute: true, update: false, delete: false, maintain: false });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await assert.rejects(client.query("LOCK TABLE occ.iam_roles IN SHARE MODE"), {
          code: "42501",
        });
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      assert.equal(
        (
          await pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='occ.lock_workload_profile_iam()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') permitted",
          )
        ).rows[0].permitted,
        false,
      );
    });

    const originalInput = request();
    let original;
    await t.test(
      "explicit READ COMMITTED, real policy decision and audit share the preparation unit",
      async () => {
        original = await run(async (u) => {
          const isolation = await u.account.query("SHOW transaction_isolation");
          assert.equal(isolation.rows[0].transaction_isolation, "read committed");
          return u.prepare(originalInput, actor);
        });
        assert.deepEqual(await snapshot(), {
          operations: baseline.operations + 1,
          audits: baseline.audits + 1,
          capacity: baseline.capacity + 1,
        });
        assert.deepEqual(await read(originalInput), original);
        const audit = (await state.read((u) => u.audit.list())).find(
          (a) => a.details?.operationRef === original.operationRef,
        );
        assert.equal(audit.actor.issuer, seed.principal.issuer);
        assert.equal(audit.actor.subject, seed.principal.subject);
        assert.equal(audit.iamDriverId, iam.id);
        assert.equal(audit.details.checks[0].decision.allowed, true);
        assert.equal(
          audit.details.checks[0].decision.evidence.channelAdministration.mappings.length,
          1,
        );
        assert.notEqual(audit.id, `aud_${original.allocated.auditRef}`);
      },
    );

    await t.test(
      "exact competing replay retains one operation, allocation and original audit",
      async () => {
        const before = await snapshot();
        const copies = await Promise.all([
          prepare(originalInput),
          prepare(originalInput),
          prepare(originalInput),
        ]);
        for (const record of copies) assert.deepEqual(record, original);
        assert.deepEqual(await snapshot(), before);
      },
    );

    await t.test(
      "current read and administrator registration deny retained disclosure independently",
      async () => {
        const permissions = seed.roles[0].permissions;
        await migrator.query("UPDATE occ.iam_roles SET permissions=$2::jsonb WHERE id=$1", [
          seed.roles[0].id,
          JSON.stringify(
            permissions.filter((p) => !(p.action === "read" && p.resourceKind === "installation")),
          ),
        ]);
        try {
          await assert.rejects(read(originalInput), AuthorizationDeniedError);
          assert.deepEqual(await prepare(originalInput), original);
        } finally {
          await migrator.query("UPDATE occ.iam_roles SET permissions=$2::jsonb WHERE id=$1", [
            seed.roles[0].id,
            JSON.stringify(permissions),
          ]);
        }
        await mapping("disabled");
        try {
          await assert.rejects(read(originalInput), AuthorizationDeniedError);
          await assert.rejects(prepare(originalInput), AuthorizationDeniedError);
        } finally {
          await mapping("enabled");
        }
        assert.equal(
          await read(originalInput, { ...actor, accountRef: "another-account" }),
          undefined,
        );
        await assert.rejects(
          prepare(originalInput, { ...actor, accountRef: "another-account" }),
          ScopeViolationError,
        );
      },
    );

    await t.test(
      "same-driver foreign-store construction cannot borrow this guarded policy",
      async () => {
        const foreign = new DriverSelection();
        foreign.registerDriver(
          new NativeIAMDriver(new PostgresPlatformState(pool), { id: "foreign-store" }),
        );
        foreign.selectDriver("iam", "foreign-store");
        await assert.rejects(
          state.workloadProfileTransaction(foreign, (u) => u.prepare(request(), actor), {
            signal: new AbortController().signal,
            timeoutMs: 3000,
          }),
          TypeError,
        );
      },
    );

    await t.test(
      "held IAM snapshot excludes a concurrent new Restriction until actual commit",
      async () => {
        const entered = deferred(),
          release = deferred();
        const input = request();
        const restrictionId = `restriction_${randomUUID()}`;
        const writer = await pool.connect();
        let writerDone = false;
        let writing;
        const operation = run(async (u) => {
          const record = await u.prepare(input, actor);
          entered.resolve();
          await release.promise;
          return record;
        });
        try {
          await entered.promise;
          writing = writer
            .query(
              "INSERT INTO occ.iam_restrictions(id,action,resource_kind,resource_id,effect) VALUES($1,'administer','installation',$2,'deny')",
              [restrictionId, installation.id],
            )
            .then(() => {
              writerDone = true;
            });
          await delay(100);
          assert.equal(writerDone, false);
          release.resolve();
          await operation;
          await writing;
          await assert.rejects(prepare(input), AuthorizationDeniedError);
        } finally {
          release.resolve();
          await operation.catch(() => {});
          await writing?.catch(() => {});
          writer.release();
          await migrator.query("DELETE FROM occ.iam_restrictions WHERE id=$1", [restrictionId]);
        }
      },
    );

    await t.test(
      "a policy withdrawal committed while the helper waits is read after the lock",
      async () => {
        const writer = await migrator.connect();
        const input = request();
        const before = await snapshot();
        let operation;
        try {
          await writer.query("BEGIN");
          await writer.query(
            "UPDATE occ.iam_access_bindings SET channel_administration=jsonb_set(jsonb_set(channel_administration,'{status}','\"disabled\"'),'{version}',to_jsonb((channel_administration->>'version')::bigint+1)) WHERE id=$1",
            [seed.bindings[0].id],
          );
          operation = prepare(input);
          void operation.catch(() => {});
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT occ.lock_workload_profile_iam%' ",
                )
              ).rows[0].n > 0,
            "The actual policy lock must wait.",
          );
          await writer.query("COMMIT");
          await assert.rejects(operation, AuthorizationDeniedError);
          assert.deepEqual(await snapshot(), before);
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
          await operation?.catch(() => {});
          await mapping("enabled");
        }
      },
    );

    await t.test(
      "mandatory audit outage rolls back preparation even when the caller catches it",
      async () => {
        const before = await snapshot();
        const input = request();
        await migrator.query("REVOKE INSERT ON occ.audit_events FROM occ_app");
        try {
          await assert.rejects(
            run(async (u) => {
              await assert.rejects(u.prepare(input, actor));
            }),
          );
        } finally {
          await migrator.query("GRANT INSERT ON occ.audit_events TO occ_app");
        }
        assert.deepEqual(await snapshot(), before);
        assert.equal(await read(input), undefined);
      },
    );

    await t.test(
      "unawaited preparation is drained and caught late account work poisons the whole unit",
      async () => {
        const input = request();
        let pending;
        await run(async (u) => {
          pending = u.prepare(input, actor);
        });
        assert.deepEqual(await read(input), await pending);
        const next = request(),
          before = await snapshot();
        await assert.rejects(
          run(async (u) => {
            await u.prepare(next, actor);
            await assert.rejects(u.account.query("SELECT 1"), ScopeViolationError);
          }),
          ScopeViolationError,
        );
        assert.deepEqual(await snapshot(), before);
        const chained = request();
        let late;
        await run(async (u) => {
          const first = u.prepare(chained, actor);
          late = first.then(() => u.prepare(request(), actor));
          void late.catch(() => {});
        });
        await assert.rejects(late, ScopeViolationError);
        assert.ok(await read(chained));
      },
    );

    await t.test(
      "caught currentness registration failures poison the active owner only",
      async () => {
        for (const late of [false, true]) {
          const input = request(),
            before = await snapshot();
          await assert.rejects(
            run(async (u) => {
              if (late) await u.prepare(input, actor);
              assert.throws(
                () => u.retainCurrentness(late ? () => {} : undefined),
                ScopeViolationError,
              );
              if (!late) await u.prepare(input, actor);
            }),
            ScopeViolationError,
          );
          assert.deepEqual(await snapshot(), before);
          assert.equal(await read(input), undefined);
        }
        // An escaped registration after terminal completion can only reject; it
        // cannot alter the already committed preparation, audit or capacity.
        const retained = request();
        let escaped;
        await run(async (u) => {
          escaped = u;
          await u.prepare(retained, actor);
        });
        const before = await snapshot();
        assert.throws(() => escaped.retainCurrentness(() => {}), ScopeViolationError);
        assert.deepEqual(await snapshot(), before);
        assert.ok(await read(retained));
      },
    );

    await t.test("ordinary unrelated SQL cannot be reclassified by a caller flag", async () => {
      const before = await snapshot(),
        input = request();
      await assert.rejects(
        state.transact(async (u) => {
          await state.queryInTransaction(u, "SELECT 1");
          await assert.rejects(
            u.workloadProfiles.prepareOperation(input, {
              accountRef: actor.accountRef,
              principalRef: actor.principal.id,
            }),
            ScopeViolationError,
          );
        }),
        ScopeViolationError,
      );
      assert.deepEqual(await snapshot(), before);
    });

    await t.test("selection hold covers the owner's final callback and rollback", async () => {
      const next = new NativeIAMDriver(state, { id: "replacement-native" });
      selection.registerDriver(next);
      const input = request(),
        before = await snapshot();
      await assert.rejects(
        run(async (u) => {
          await u.prepare(input, actor);
          assert.throws(() => selection.selectDriver("iam", next.id));
          throw new Error("caller requested rollback");
        }),
        /caller requested rollback/,
      );
      assert.deepEqual(await snapshot(), before);
      selection.selectDriver("iam", next.id);
      selection.selectDriver("iam", iam.id);
    });

    await t.test(
      "policy cancellation removes the backend lock waiter while the blocker remains held",
      async () => {
        const blocker = await migrator.connect();
        const abort = new AbortController();
        let operation;
        try {
          await blocker.query("BEGIN");
          await blocker.query("LOCK TABLE occ.iam_roles IN ACCESS EXCLUSIVE MODE");
          operation = run((u) => u.prepare(request(), actor), abort.signal);
          void operation.catch(() => {});
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT occ.lock_workload_profile_iam%' ",
                )
              ).rows[0].n > 0,
            "Policy must actually block.",
          );
          abort.abort();
          await assert.rejects(operation, DependencyUnavailableError);
          await until(
            async () =>
              (
                await pool.query(
                  "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename='occ_app' AND wait_event_type='Lock'",
                )
              ).rows[0].n === 0,
            "Cancelled backend must leave the still-held lock.",
          );
          assert.equal(pool.waitingCount, 0);
        } finally {
          abort.abort();
          await operation?.catch(() => {});
          await blocker.query("ROLLBACK");
          blocker.release();
        }
      },
    );

    await t.test(
      "a lost actual COMMIT acknowledgement preserves preparation and audit for exact recovery",
      async () => {
        const proxy = await runtimeCommitAckProxy(databaseUrl);
        const faultPool = new pg.Pool({
          connectionString: proxy.url,
          max: 1,
          connectionTimeoutMillis: 250,
        });
        faultPool.on("error", () => {});
        const fault = compose(faultPool);
        const input = request();
        let retained;
        try {
          proxy.arm();
          await assert.rejects(
            fault.state.workloadProfileTransaction(
              fault.selection,
              async (u) => {
                retained = await u.prepare(input, actor);
              },
              { signal: new AbortController().signal, timeoutMs: 3000 },
            ),
            PostgresCommitOutcomeUnknownError,
          );
          assert.equal(proxy.observedCommit, true);
          assert.deepEqual(await read(input), retained);
          const before = await snapshot();
          assert.deepEqual(await prepare(input), retained);
          assert.deepEqual(await snapshot(), before);
        } finally {
          await faultPool.end();
          await proxy.close();
        }
      },
    );
  },
);
