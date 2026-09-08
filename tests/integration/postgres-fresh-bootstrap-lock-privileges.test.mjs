import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.OCC_FRESH_BOOTSTRAP_LOCK_DATABASE_URL;
const lockFunction = "occ.lock_fresh_bootstrap_iam_v1()";
// Fixed identifiers match the bootstrap barrier's scope; none come from input.
const iamTables = [
  "iam_identities",
  "iam_roles",
  "iam_groups",
  "iam_group_memberships",
  "iam_access_bindings",
  "iam_restrictions",
];
const freshTables = ["installation", ...iamTables];

async function assertFresh(pool) {
  const result = await pool.query(
    freshTables
      .map((name) => `SELECT '${name}' AS name, count(*)::integer AS count FROM occ.${name}`)
      .join(" UNION ALL ") + " ORDER BY name",
  );
  assert.deepEqual(
    result.rows,
    [...freshTables].sort().map((name) => ({ name, count: 0 })),
  );
}

async function begin(client) {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '15s'");
}

async function expectedSqlError(client, sql, values, code) {
  await client.query("SAVEPOINT expected_error");
  try {
    await assert.rejects(client.query(sql, values), { code });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_error");
    await client.query("RELEASE SAVEPOINT expected_error");
  }
}

async function inspectBarrier(observer, ownerPid, writers) {
  // Observe actual server waiters rather than inferring blocking from elapsed
  // time or an unresolved JavaScript promise. The owner must block every one.
  const deadline = performance.now() + 5_000;
  let observed;
  do {
    observed = (
      await observer.query(
        `SELECT l.pid, c.relname AS name, l.mode, l.granted,
                $1::integer = ANY(pg_blocking_pids(l.pid)) AS blocked_by_owner
           FROM pg_locks l
           JOIN pg_class c ON c.oid=l.relation
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE l.pid=ANY($2::integer[]) AND n.nspname='occ'
            AND l.mode='RowExclusiveLock'`,
        [ownerPid, writers.map((writer) => writer.pid)],
      )
    ).rows;
    if (
      writers.every((writer) =>
        observed.some(
          (row) =>
            row.pid === writer.pid &&
            row.name === writer.name &&
            !row.granted &&
            row.blocked_by_owner,
        ),
      )
    )
      return;
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail(`Expected all six real writer lock waits; observed ${JSON.stringify(observed)}`);
}

async function exerciseBarrier(pool, completion) {
  const clients = [];
  const writers = [];
  const pending = [];
  try {
    // Borrow sequentially so a connection failure still leaves every acquired
    // client available for cleanup. Owner, observer and six writers are distinct.
    for (let index = 0; index < 8; index += 1) clients.push(await pool.connect());
    const [owner, observer, ...writerClients] = clients;
    await begin(owner);
    const ownerPid = (await owner.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await owner.query(`SELECT ${lockFunction}`);
    const locks = (
      await observer.query(
        `SELECT c.relname AS name, l.mode
           FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
           JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE l.pid=$1 AND l.granted AND n.nspname='occ'
          ORDER BY c.relname`,
        [ownerPid],
      )
    ).rows;
    assert.deepEqual(
      locks,
      [...iamTables].sort().map((name) => ({ name, mode: "ShareRowExclusiveLock" })),
    );

    for (const [index, client] of writerClients.entries()) {
      await begin(client);
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const name = iamTables[index];
      writers.push({ name, pid });
      // These are real INSERT commands acquiring RowExclusiveLock, with empty
      // inputs to preserve a fresh database. They establish lock behavior only;
      // actual bootstrap row creation and FK validation belong to the CLI suite.
      // Attach both handlers immediately, including on an assertion-failure path.
      pending.push(
        client.query(`INSERT INTO occ.${name} SELECT * FROM occ.${name} WHERE false`).then(
          (result) => ({ result }),
          (error) => ({ error }),
        ),
      );
    }
    assert.equal(new Set([ownerPid, ...writers.map((writer) => writer.pid)]).size, 7);
    await inspectBarrier(observer, ownerPid, writers);
    await owner.query(completion);
    for (const outcome of await Promise.all(pending)) {
      if (outcome.error) throw outcome.error;
      assert.equal(outcome.result.command, "INSERT");
      assert.equal(outcome.result.rowCount, 0);
    }
  } finally {
    // Release the owner first even if a waiter assertion failed. Every pending
    // writer settles before rollback/release; server timeouts bound error paths.
    try {
      if (clients[0]) await clients[0].query("ROLLBACK");
    } finally {
      await Promise.all(pending);
      const cleanup = await Promise.allSettled(
        clients.slice(1).map((client) => client.query("ROLLBACK")),
      );
      for (const client of clients) client.release(true);
      for (const result of cleanup) if (result.status === "rejected") throw result.reason;
    }
  }
  await assertFresh(pool);
}

test(
  "fresh bootstrap locks work under the unchanged limited application role",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_FRESH_BOOTSTRAP_LOCK_DATABASE_URL to a migrated, fresh loopback database.",
    timeout: 60_000,
  },
  async (t) => {
    const target = new URL(databaseUrl);
    assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
    assert.equal(target.username, "occ_app");
    assert.equal(target.search, "");
    assert.equal(target.hash, "");
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 1_000,
      statement_timeout: 15_000,
      lock_timeout: 10_000,
      application_name: "fresh-bootstrap-lock-privileges-test",
    });
    try {
      assert.deepEqual(
        (
          await pool.query(
            `SELECT current_user AS name, session_user AS session_name,
                    current_database() AS database_name,
                    rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
               FROM pg_roles WHERE rolname=current_user`,
          )
        ).rows[0],
        {
          name: "occ_app",
          session_name: "occ_app",
          database_name: decodeURIComponent(target.pathname.slice(1)),
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
        },
      );
      await assertFresh(pool);

      await t.test("function identity and ACL expose only the fixed barrier", async () => {
        const actual = (
          await pool.query(
            `SELECT r.rolname AS owner, p.prosecdef, p.proconfig, p.pronargs,
                    pg_get_function_result(p.oid) AS result_type,
                    has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
                    (SELECT jsonb_agg(jsonb_build_object(
                       'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC'
                                      ELSE pg_get_userbyid(a.grantee) END,
                       'privilege',a.privilege_type,'grantable',a.is_grantable)
                       ORDER BY a.grantee)
                       FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) AS acl
               FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
              WHERE p.oid=$1::regprocedure`,
            [lockFunction],
          )
        ).rows[0];
        assert.deepEqual(
          { ...actual, acl: actual.acl.sort((a, b) => a.grantee.localeCompare(b.grantee)) },
          {
            owner: "occ_migrator",
            prosecdef: true,
            proconfig: ["search_path=pg_catalog, pg_temp"],
            pronargs: 0,
            result_type: "void",
            executable: true,
            acl: [
              { grantee: "occ_app", privilege: "EXECUTE", grantable: false },
              { grantee: "occ_migrator", privilege: "EXECUTE", grantable: false },
            ],
          },
        );
        for (const name of freshTables) {
          const rights = (
            await pool.query(
              `SELECT has_table_privilege(current_user,$1,'SELECT') AS can_select,
                      has_table_privilege(current_user,$1,'INSERT') AS can_insert,
                      has_table_privilege(current_user,$1,'UPDATE') AS table_update,
                      has_any_column_privilege(current_user,$1,'UPDATE') AS column_update,
                      has_table_privilege(current_user,$1,'DELETE') AS can_delete,
                      has_table_privilege(current_user,$1,'TRUNCATE') AS can_truncate,
                      has_table_privilege(current_user,$1,'REFERENCES') AS can_reference,
                      has_table_privilege(current_user,$1,'TRIGGER') AS can_trigger,
                      has_table_privilege(current_user,$1,'MAINTAIN') AS can_maintain`,
              [`occ.${name}`],
            )
          ).rows[0];
          assert.deepEqual(
            rights,
            {
              can_select: true,
              can_insert: true,
              table_update: false,
              column_update: name === "installation",
              can_delete: false,
              can_truncate: false,
              can_reference: false,
              can_trigger: false,
              can_maintain: false,
            },
            name,
          );
        }
      });

      await t.test(
        "Installation row locking preserves column and mutation restrictions",
        async () => {
          const client = await pool.connect();
          const id = `ins_${randomUUID()}`;
          try {
            await begin(client);
            await client.query(
              "INSERT INTO occ.installation (id,name,created_at) VALUES ($1,$2,$3)",
              [id, "Rollback-only lock privilege fixture", new Date().toISOString()],
            );
            assert.equal(
              (await client.query("SELECT id FROM occ.installation WHERE id=$1 FOR SHARE", [id]))
                .rows[0].id,
              id,
            );
            await expectedSqlError(
              client,
              "UPDATE occ.installation SET id=id WHERE id=$1",
              [id],
              "55000",
            );
            await expectedSqlError(
              client,
              "UPDATE occ.installation SET name=name WHERE id=$1",
              [id],
              "42501",
            );
            await expectedSqlError(
              client,
              "UPDATE occ.installation SET created_at=created_at WHERE id=$1",
              [id],
              "42501",
            );
            await expectedSqlError(
              client,
              "DELETE FROM occ.installation WHERE id=$1",
              [id],
              "42501",
            );
            assert.equal((await client.query("SELECT id FROM occ.installation")).rows[0].id, id);
          } finally {
            try {
              await client.query("ROLLBACK");
            } finally {
              client.release(true);
            }
          }
          await assertFresh(pool);
        },
      );

      for (const completion of ["COMMIT", "ROLLBACK"]) {
        await t.test(
          `all six actual IAM INSERT lock probes wait until owner ${completion}`,
          async () => {
            await exerciseBarrier(pool, completion);
          },
        );
      }
      await assertFresh(pool);
    } finally {
      await pool.end();
    }
  },
);
