import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";

// This test is for a separately admitted disposable, migrated PostgreSQL
// fixture. The fixture owner must remove the complete database afterwards:
// applying an unregistered supplier changes the migration catalog.
const manifestPath = process.env.OCC_PASSWORD_BUDGET_FIXTURE_MANIFEST;

async function fixture(path = manifestPath) {
  if (!isAbsolute(path ?? "")) {
    throw new Error("A private absolute fixture manifest is required.");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("The fixture manifest must be a private regular file.");
  }
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("The fixture manifest is invalid.");
  }
  let application;
  let migrator;
  try {
    application = new URL(data.appUrl);
    migrator = new URL(data.migratorUrl);
  } catch {
    throw new Error("The fixture targets are invalid.");
  }
  if (
    application.protocol !== "postgresql:" ||
    migrator.protocol !== "postgresql:" ||
    application.hostname !== "127.0.0.1" ||
    application.host !== migrator.host ||
    application.port === "" ||
    application.pathname !== migrator.pathname ||
    !/^\/openclaw_ci_password_budget_[a-f0-9]{12}$/.test(application.pathname) ||
    application.username !== "occ_app" ||
    migrator.username !== "occ_migrator" ||
    application.search !== "" ||
    migrator.search !== "" ||
    application.hash !== "" ||
    migrator.hash !== ""
  ) {
    throw new Error(
      "The fixture targets must identify one owned local database and its restricted roles.",
    );
  }
  return {
    appUrl: data.appUrl,
    migratorUrl: data.migratorUrl,
  };
}

test(
  "restricted-role password budgets serialize across two controllers",
  {
    skip: manifestPath === undefined ? "requires a separately admitted owned fixture" : false,
    timeout: 30_000,
  },
  async () => {
    const urls = await fixture();
    const { Pool } = await import("pg");
    const { createPostgresStateWithPasswordBudget } =
      await import("../../packages/occ/src/state/postgres-password-attempt-budget.ts");
    const { createPostgresPasswordBudgetPool } =
      await import("../../packages/occ/src/state/postgres-pool.ts");
    const appPool = await createPostgresPasswordBudgetPool(urls.appUrl, {
      authMode: "password",
      max: 3,
      connectionTimeoutMillis: 5000,
    });
    const migrationPool = new Pool({
      connectionString: urls.migratorUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const installationId = "ins_00000000-0000-4000-8000-000000000001";
    const confirmation = Buffer.alloc(32, 17);
    const first = Buffer.alloc(32, 1);
    try {
      for (const [pool, role] of [
        [appPool, "occ_app"],
        [migrationPool, "occ_migrator"],
      ]) {
        const result = await pool.query(
          "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
        );
        assert.deepEqual(result.rows, [
          {
            name: role,
            rolsuper: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolbypassrls: false,
          },
        ]);
      }
      const existing = await migrationPool.query(
        "SELECT count(*)::int AS count FROM occ.installation",
      );
      assert.equal(existing.rows[0].count, 0);
      await migrationPool.query(
        "INSERT INTO occ.installation (id, name, created_at) VALUES ($1, 'Budget fixture', clock_timestamp())",
        [installationId],
      );
      const sql = await readFile(
        new URL("../../sql-suppliers/password-attempt-budget.sql", import.meta.url),
        "utf8",
      );
      await migrationPool.query(sql);
      await migrationPool.query(
        "INSERT INTO occ.password_attempt_budget_control (installation_id) VALUES ($1)",
        [installationId],
      );
      await migrationPool.query("SELECT occ.password_budget_activate($1, $2, $3, $4, $5, $6, $7)", [
        installationId,
        "1",
        confirmation,
        10,
        600,
        2,
        1,
      ]);
      const binding = {
        installationId,
        epoch: "1",
        keyConfirmation: confirmation,
        transactionTimeoutMs: 5000,
      };
      const controllerA = createPostgresStateWithPasswordBudget(appPool, {}, binding);
      const controllerB = createPostgresStateWithPasswordBudget(appPool, {}, binding);
      // The same fixed app-role function participates in the caller's original
      // transaction; a definite rollback must leave no counter behind.
      const rollbackClient = await appPool.connect();
      try {
        await rollbackClient.query("BEGIN");
        const staged = await rollbackClient.query(
          "SELECT status FROM occ.reserve_password_attempt($1, $2, $3, $4)",
          [installationId, "1", confirmation, Buffer.alloc(32, 4)],
        );
        assert.equal(staged.rows[0].status, "allowed");
        await rollbackClient.query("ROLLBACK");
      } finally {
        rollbackClient.release(true);
      }
      const afterRollback = await migrationPool.query(
        "SELECT count(*)::int AS count FROM occ.password_attempt_budget_rows WHERE installation_id = $1",
        [installationId],
      );
      assert.equal(afterRollback.rows[0].count, 0);

      // Force a real two-backend overlap and observe its database blocker before
      // releasing the first transaction. The fixture owns both connections.
      const a = await appPool.connect();
      const b = await appPool.connect();
      try {
        await a.query("BEGIN");
        await b.query("BEGIN");
        await a.query("SET LOCAL statement_timeout = '5s'");
        await b.query("SET LOCAL statement_timeout = '5s'");
        const aPid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        assert.notEqual(aPid, bPid);
        assert.equal(
          (
            await a.query("SELECT status FROM occ.reserve_password_attempt($1, $2, $3, $4)", [
              installationId,
              "1",
              confirmation,
              first,
            ])
          ).rows[0].status,
          "allowed",
        );
        const pending = b.query("SELECT status FROM occ.reserve_password_attempt($1, $2, $3, $4)", [
          installationId,
          "1",
          confirmation,
          first,
        ]);
        pending.catch(() => {}); // observed below; prevents an early unhandled rejection
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const observed = await migrationPool.query(
            "SELECT $1::integer = ANY(pg_catalog.pg_blocking_pids($2::integer)) AS blocked",
            [aPid, bPid],
          );
          if (observed.rows[0].blocked === true) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(blocked, true, "the competing backend must actually wait for the first");
        await a.query("COMMIT");
        assert.equal((await pending).rows[0].status, "allowed");
        await b.query("COMMIT");
      } finally {
        a.release(true);
        b.release(true);
      }
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          (i % 2 ? controllerA : controllerB).passwordBudget.reserve(first),
        ),
      );
      assert.equal(results.filter((result) => result.status === "allowed").length, 8);
      const limited = results.filter((result) => result.status === "limited");
      assert.equal(limited.length, 1);
      assert.ok(limited[0].retryAfterSeconds > 0 && limited[0].retryAfterSeconds <= 600);

      assert.equal(
        (await controllerA.passwordBudget.reserve(Buffer.alloc(32, 2))).status,
        "allowed",
      );
      assert.equal(
        (await controllerB.passwordBudget.reserve(Buffer.alloc(32, 3))).status,
        "unavailable",
      );
      assert.equal((await controllerB.passwordBudget.reserve(first)).status, "limited");
      const stored = await migrationPool.query(
        "SELECT attempts, count(*) OVER ()::int AS total FROM occ.password_attempt_budget_rows WHERE installation_id = $1 ORDER BY attempts DESC",
        [installationId],
      );
      assert.equal(stored.rows.length, 2);
      assert.equal(stored.rows[0].attempts, 10);
      assert.equal(stored.rows[0].total, 2);

      // Fixture-only time travel by the privileged owner exercises expiration
      // without waiting 600 seconds; it is not an application capability.
      await migrationPool.query(
        "UPDATE occ.password_attempt_budget_rows SET expires_at = clock_timestamp() - interval '1 second' WHERE installation_id = $1 AND subject_digest = $2",
        [installationId, Buffer.alloc(32, 2)],
      );
      assert.equal(
        (await controllerB.passwordBudget.reserve(Buffer.alloc(32, 3))).status,
        "allowed",
      );
      const afterCleanup = await migrationPool.query(
        "SELECT subject_digest FROM occ.password_attempt_budget_rows WHERE installation_id = $1",
        [installationId],
      );
      assert.equal(afterCleanup.rows.length, 2);
      assert.ok(afterCleanup.rows.some((row) => row.subject_digest.equals(first)));
      assert.ok(afterCleanup.rows.some((row) => row.subject_digest.equals(Buffer.alloc(32, 3))));

      const wrong = createPostgresStateWithPasswordBudget(
        appPool,
        {},
        {
          ...binding,
          keyConfirmation: Buffer.alloc(32, 18),
        },
      );
      assert.equal((await wrong.passwordBudget.reserve(first)).status, "unavailable");
      await assert.rejects(
        appPool.query("SELECT * FROM occ.password_attempt_budget_rows"),
        (error) => error.code === "42501",
      );
      await assert.rejects(
        appPool.query("SELECT occ.password_budget_close($1)", [installationId]),
        (error) => error.code === "42501",
      );
      await migrationPool.query("SELECT occ.password_budget_close($1)", [installationId]);
      assert.equal((await controllerA.passwordBudget.reserve(first)).status, "unavailable");
      await assert.rejects(
        migrationPool.query("SELECT occ.password_budget_activate($1, $2, $3, $4, $5, $6, $7)", [
          installationId,
          "2",
          Buffer.alloc(32, 19),
          10,
          600,
          2,
          1,
        ]),
      );
      await migrationPool.query(
        "UPDATE occ.password_attempt_budget_rows SET expires_at = clock_timestamp() - interval '1 second' WHERE installation_id = $1",
        [installationId],
      );
      await migrationPool.query("SELECT occ.password_budget_activate($1, $2, $3, $4, $5, $6, $7)", [
        installationId,
        "2",
        Buffer.alloc(32, 19),
        10,
        600,
        1,
        1,
      ]);
      assert.equal((await controllerA.passwordBudget.reserve(first)).status, "unavailable");
      const rotated = createPostgresStateWithPasswordBudget(
        appPool,
        {},
        {
          ...binding,
          epoch: "2",
          keyConfirmation: Buffer.alloc(32, 19),
        },
      );
      // Two expired old-epoch rows exceed the new one-row cap and a single
      // cleanup batch. The first call must commit one deletion while refusing
      // admission; the next may insert only after the remaining row is gone.
      assert.equal((await rotated.passwordBudget.reserve(first)).status, "unavailable");
      const afterFirstCleanup = await migrationPool.query(
        "SELECT epoch::text AS epoch FROM occ.password_attempt_budget_rows WHERE installation_id = $1",
        [installationId],
      );
      assert.deepEqual(afterFirstCleanup.rows, [{ epoch: "1" }]);
      assert.equal((await rotated.passwordBudget.reserve(first)).status, "allowed");
      const afterSecondCleanup = await migrationPool.query(
        "SELECT epoch::text AS epoch, attempts FROM occ.password_attempt_budget_rows WHERE installation_id = $1",
        [installationId],
      );
      assert.deepEqual(afterSecondCleanup.rows, [{ epoch: "2", attempts: 1 }]);
    } finally {
      await Promise.allSettled([appPool.end(), migrationPool.end()]);
    }
  },
);

for (const [kind, variable] of [
  ["direct", "OCC_PASSWORD_BUDGET_DIRECT_ROLE_FIXTURE_MANIFEST"],
  ["transitive", "OCC_PASSWORD_BUDGET_TRANSITIVE_ROLE_FIXTURE_MANIFEST"],
  ["direct-maintain", "OCC_PASSWORD_BUDGET_DIRECT_MAINTAIN_FIXTURE_MANIFEST"],
  ["transitive-maintain", "OCC_PASSWORD_BUDGET_TRANSITIVE_MAINTAIN_FIXTURE_MANIFEST"],
  ["direct-admin", "OCC_PASSWORD_BUDGET_DIRECT_ADMIN_FIXTURE_MANIFEST"],
  ["inherited-admin", "OCC_PASSWORD_BUDGET_INHERITED_ADMIN_FIXTURE_MANIFEST"],
]) {
  const selected = process.env[variable];
  test(
    `supplier refuses unsafe ${kind} role authority`,
    {
      skip: selected === undefined ? "requires a separately admitted negative-role fixture" : false,
      timeout: 15_000,
    },
    async () => {
      const urls = await fixture(selected);
      const { Pool } = await import("pg");
      const pool = new Pool({
        connectionString: urls.migratorUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
      });
      const client = await pool.connect();
      try {
        const identity = await client.query("SELECT current_user AS name");
        assert.equal(identity.rows[0].name, "occ_migrator");
        // Separate, disposable servers are prepared by the fixture owner.
        // This test creates no roles and changes no memberships.
        const maintain = kind.endsWith("-maintain");
        const admin = kind.endsWith("-admin");
        const transitive = kind.startsWith("transitive") || kind.startsWith("inherited");
        const target = admin
          ? "occ_migrator"
          : maintain
            ? "pg_maintain"
            : "occ_password_budget_member_test";
        const bridge = "occ_password_budget_bridge_test";
        const edges = admin
          ? transitive
            ? [
                ["occ_app", bridge, false, true, false],
                [bridge, target, false, false, true],
              ]
            : [["occ_app", target, false, false, true]]
          : transitive
            ? [
                ["occ_app", bridge, !maintain, maintain, false],
                [bridge, target, !maintain, maintain, false],
              ]
            : [["occ_app", target, !maintain, maintain, false]];
        for (const [member, parent, canSet, canInherit, canAdmin] of edges) {
          const membership = await client.query(
            `SELECT EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members m
               JOIN pg_catalog.pg_roles p ON p.oid = m.roleid
               JOIN pg_catalog.pg_roles c ON c.oid = m.member
               WHERE c.rolname = $1 AND p.rolname = $2
                 AND m.set_option = $3 AND m.inherit_option = $4 AND m.admin_option = $5
             ) AS present`,
            [member, parent, canSet, canInherit, canAdmin],
          );
          assert.equal(membership.rows[0].present, true);
        }
        if (maintain) {
          const effective = await client.query(
            "SELECT pg_catalog.pg_has_role('occ_app', 'pg_maintain', 'USAGE') AS inherited",
          );
          assert.equal(effective.rows[0].inherited, true);
        }
        if (admin) {
          const effective = await client.query(
            "SELECT pg_catalog.pg_has_role('occ_app', 'occ_migrator', 'USAGE') AS inherited",
          );
          assert.equal(effective.rows[0].inherited, false);
          // Inspect every SET/INHERIT edge reachable from the app, so an
          // alternative inherited or switchable role cannot hide the finding.
          const actualEdges = await client.query(
            `WITH RECURSIVE reachable(roleid) AS (
               SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'occ_app'
               UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m
                 JOIN reachable r ON r.roleid = m.member
                 WHERE m.set_option OR m.inherit_option
             )
             SELECT c.rolname AS member, p.rolname AS parent,
                    m.set_option AS can_set, m.inherit_option AS can_inherit,
                    m.admin_option AS can_admin
             FROM pg_catalog.pg_auth_members m
             JOIN reachable r ON r.roleid = m.member
             JOIN pg_catalog.pg_roles c ON c.oid = m.member
             JOIN pg_catalog.pg_roles p ON p.oid = m.roleid
             ORDER BY member, parent`,
          );
          assert.deepEqual(
            actualEdges.rows,
            edges
              .map(([member, parent, can_set, can_inherit, can_admin]) => ({
                member,
                parent,
                can_set,
                can_inherit,
                can_admin,
              }))
              .sort((a, b) => a.member.localeCompare(b.member) || a.parent.localeCompare(b.parent)),
          );
          // The current supplier first rejects other unsafe privileges, then
          // emits this distinct ADMIN diagnostic. The ordinary fixture above
          // is its positive control; no private predecessor SQL is needed.
        }
        const sql = await readFile(
          new URL("../../sql-suppliers/password-attempt-budget.sql", import.meta.url),
          "utf8",
        );
        await assert.rejects(
          client.query(sql),
          (error) =>
            error.code === "42501" &&
            (!admin ||
              error.message === "password budget application has role administration authority"),
        );
        // The supplier's transaction is aborted, so the owner must roll it back
        // before inspecting the catalog; a refusal is not successful setup.
        await client.query("ROLLBACK");
        const absent = await client.query(
          "SELECT to_regclass('occ.password_attempt_budget_control') AS control, to_regprocedure('occ.reserve_password_attempt(text,bigint,bytea,bytea)') AS reserve",
        );
        assert.deepEqual(absent.rows, [{ control: null, reserve: null }]);
      } finally {
        client.release(true);
        await pool.end();
      }
    },
  );
}
