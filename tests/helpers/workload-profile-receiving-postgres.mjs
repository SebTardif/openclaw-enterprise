import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { authenticatedHeaders, signInWithEmailPassword } from "./auth-session.mjs";

const controllerRole = "occ_controller_workload_profile";
const outerSignature = "occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text)";
const observationLimitMs = 750;
const commandLimitMs = 3000;

// These URLs select three distinct existing fixture roles on one allocated
// loopback database. The observer never supplies a factory, reader or IAM unit.
export function receivingPostgresEnvironment(databaseUrl) {
  const names = [
    "OCC_WORKLOAD_PROFILE_RECEIVING_DATABASE_URL",
    "OCC_WORKLOAD_PROFILE_RECEIVING_MIGRATOR_DATABASE_URL",
    "OCC_WORKLOAD_PROFILE_RECEIVING_OBSERVER_DATABASE_URL",
  ];
  const values = names.map((name) => process.env[name]);
  if (values.every((value) => value === undefined)) return undefined;
  assert.ok(
    values.every((value) => typeof value === "string" && value.length > 0),
    "The receiving fixture requires all three allocated role URLs.",
  );
  const baseline = new URL(databaseUrl);
  const urls = values.map((value) => new URL(value));
  for (const url of [baseline, ...urls]) {
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname));
    assert.equal(url.hostname, baseline.hostname);
    assert.equal(url.port, baseline.port);
    assert.equal(url.pathname, baseline.pathname);
  }
  assert.equal(decodeURIComponent(baseline.username), "occ_app");
  assert.deepEqual(
    urls.map((url) => decodeURIComponent(url.username)),
    [controllerRole, "occ_migrator", "postgres"],
  );
  return Object.freeze({ selected: values[0], migrator: values[1], observer: values[2] });
}

function pool(connectionString, max) {
  const value = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 250 });
  value.on("error", () => {});
  return value;
}

async function observeUntil(read, predicate, description) {
  const began = performance.now();
  while (performance.now() - began < observationLimitMs) {
    const observed = await read();
    if (predicate(observed)) return observed;
    await delay(25);
  }
  assert.fail(`The allocated ${description} interval was not observed within 750ms.`);
}

// Observe the real request without exposing its SQL text or bind values. Clear
// PostgreSQL's statistics snapshot separately before every activity observation.
async function activity(observer, { pid, helper = false, blocker }) {
  await observer.query("SELECT pg_stat_clear_snapshot()");
  return (
    await observer.query(
      `SELECT a.pid, a.backend_start::text, a.xact_start::text,
            a.datid::text, a.usesysid::text, a.usename, a.state, a.backend_xid::text,
            a.wait_event_type, a.wait_event, pg_blocking_pids(a.pid) AS blockers,
            CASE WHEN a.query LIKE '%FROM occ.read_locked_workload_profile_session_v1(%'
                 THEN 'profile-session-helper'
                 WHEN a.query = 'SELECT occ.lock_workload_profile_iam()'
                 THEN 'native-iam-lock'
                 ELSE 'other' END AS query_kind,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'database',l.database::text,'classid',l.classid::text,
               'objid',l.objid::text,'objsubid',l.objsubid,
               'mode',l.mode,'granted',l.granted)), '[]'::jsonb)
               FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory') AS advisory,
            EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
                    AND l.relation='occ.account_security_records'::regclass
                    AND l.granted) AS account_relation_held,
            EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
                    AND l.relation='occ.session'::regclass
                    AND l.granted) AS session_relation_held
       FROM pg_stat_activity a
      WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
        AND ($1::integer IS NULL OR a.pid=$1)
        AND (NOT $2::boolean OR (a.usename=$3 AND
             a.query LIKE '%FROM occ.read_locked_workload_profile_session_v1(%'))
        AND ($4::integer IS NULL OR $4=ANY(pg_blocking_pids(a.pid)))`,
      [pid ?? null, helper, controllerRole, blocker ?? null],
    )
  ).rows;
}

function openRequest(endpoint, origin, session, method, path, payload) {
  const started = performance.now();
  const observationId = randomUUID();
  let request;
  let settled = false;
  const outcome = new Promise((resolve) => {
    request = httpRequest(
      new URL(path, endpoint),
      {
        method,
        headers: authenticatedHeaders(session, {
          origin,
          "content-type": "application/json",
          connection: "close",
          "x-receiving-observation-id": observationId,
        }),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65536) request.destroy(new Error("Receiving response exceeded its bound."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          settled = true;
          const body = Buffer.concat(chunks).toString("utf8");
          let value;
          try {
            value = body.length === 0 ? undefined : JSON.parse(body);
          } catch {
            resolve({ kind: "invalid-response", status: response.statusCode });
            return;
          }
          resolve({ kind: "response", status: response.statusCode, value });
        });
        response.on("error", () => {
          settled = true;
          resolve({ kind: "transport-closed" });
        });
      },
    );
    request.on("error", () => {
      settled = true;
      resolve({ kind: "transport-closed" });
    });
    request.setTimeout(commandLimitMs + 500, () => request.destroy());
    request.end(JSON.stringify(payload));
  });
  return {
    outcome,
    started,
    observationId,
    isSettled: () => settled,
    abort: () => request.destroy(),
  };
}

async function begin(pool) {
  const client = await pool.connect();
  client.on("error", quietClientError);
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL statement_timeout='3000ms'");
    const identity = (
      await client.query(
        "SELECT pg_backend_pid() AS pid, current_database() AS database, current_user AS role",
      )
    ).rows[0];
    return { client, identity };
  } catch (error) {
    try {
      client.release(true);
    } finally {
      client.removeListener("error", quietClientError);
    }
    throw error;
  }
}

function quietClientError() {}

async function finish(transaction, commit = false) {
  if (transaction === undefined || transaction.finished) return;
  transaction.finished = true;
  let discard = false;
  try {
    await transaction.client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    transaction.client.release(discard);
    transaction.client.removeListener("error", quietClientError);
  }
}

const publicationTables = Object.freeze([
  "agents",
  "agent_revisions",
  "controller_work",
  "agent_runtime_intents",
  "agent_runtime_intent_heads",
  "runtime_assignment_allocations",
  "agent_revision_runtime_admissions",
  "agent_lifecycle_admissions",
  "runtime_preparation_operations",
  "workload_profile_operations",
  "workload_profile_capacity",
  "workload_profile_admissions",
  "workload_profile_admission_history",
  "workload_profile_invalidations",
]);

async function publicationSnapshot(observer) {
  const result = {};
  // The database is exclusively allocated to this whole suite. Comparing every
  // scoped publication table also catches a misplaced write outside the target.
  for (const table of publicationTables) {
    const rows = (await observer.query(`SELECT to_jsonb(t) AS value FROM occ.${table} t`)).rows;
    result[table] = rows.map(({ value }) => JSON.stringify(value)).sort();
  }
  result.successfulMutationAudit = (
    await observer.query(
      `SELECT id FROM occ.audit_events WHERE kind='mutation' AND outcome='success' ORDER BY id`,
    )
  ).rows;
  return result;
}

function gateKey(lock) {
  return [lock.database, lock.classid, lock.objid, lock.objsubid].join(":");
}

async function capturedGate(observer, writerPid) {
  const rows = (
    await observer.query(
      `SELECT database::text, classid::text, objid::text, objsubid, mode, granted
       FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND mode='ExclusiveLock' AND granted`,
      [writerPid],
    )
  ).rows;
  assert.equal(rows.length, 1, "The supported writer must own one actual Installation gate.");
  return rows[0];
}

function hasGate(row, gate, mode, granted) {
  return row.advisory.some(
    (lock) => gateKey(lock) === gateKey(gate) && lock.mode === mode && lock.granted === granted,
  );
}

async function recordPrivilegeSnapshot(client) {
  const record = (
    await client.query(
      `SELECT c.relowner::regrole::text AS owner,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',x.grantee::text,
               'privilege',x.privilege_type,'grantable',x.is_grantable)), '[]'::jsonb)
               FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
              WHERE x.grantee<>c.relowner) AS relation_acl,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('column',a.attname,
               'grantee',x.grantee::text,'privilege',x.privilege_type,
               'grantable',x.is_grantable)), '[]'::jsonb)
               FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
              WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
                AND x.grantee<>c.relowner) AS column_acl
       FROM pg_class c WHERE c.oid='occ.account_security_records'::regclass`,
    )
  ).rows;
  assert.equal(record.length, 1);
  const effective = (
    await client.query(
      `SELECT r.role,
            has_table_privilege(r.role,'occ.account_security_records','SELECT') AS table_select,
            has_table_privilege(r.role,'occ.account_security_records','INSERT') AS table_insert,
            has_table_privilege(r.role,'occ.account_security_records','UPDATE') AS table_update,
            has_table_privilege(r.role,'occ.account_security_records','DELETE') AS table_delete,
            has_any_column_privilege(r.role,'occ.account_security_records','SELECT') AS column_select,
            has_any_column_privilege(r.role,'occ.account_security_records','INSERT') AS column_insert,
            has_any_column_privilege(r.role,'occ.account_security_records','UPDATE') AS column_update,
            has_any_column_privilege(r.role,'occ.account_security_records','REFERENCES') AS column_references
       FROM unnest(ARRAY['occ_app'::text,$1::text]) r(role) ORDER BY r.role`,
      [controllerRole],
    )
  ).rows;
  assert.equal(record[0].owner, "occ_migrator");
  assert.deepEqual(record[0].relation_acl, []);
  assert.deepEqual(record[0].column_acl, []);
  assert.deepEqual(
    effective.map((row) => row.role),
    ["occ_app", controllerRole],
  );
  for (const row of effective) {
    assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => key !== "role")), {
      table_select: false,
      table_insert: false,
      table_update: false,
      table_delete: false,
      column_select: false,
      column_insert: false,
      column_update: false,
      column_references: false,
    });
  }
  return { ...record[0], effective };
}

async function verifyEnrollment(observer) {
  const role = (
    await observer.query(
      `SELECT oid::text, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
            rolcanlogin, rolreplication, rolbypassrls, rolconnlimit
       FROM pg_roles WHERE rolname=$1`,
      [controllerRole],
    )
  ).rows;
  assert.equal(role.length, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(role[0]).filter(([key]) => key !== "oid")), {
    rolname: controllerRole,
    rolsuper: false,
    rolinherit: true,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
    rolconnlimit: 8,
  });
  const memberships = (
    await observer.query(
      `SELECT parent.rolname, m.admin_option, m.inherit_option, m.set_option
       FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
      WHERE m.member=$1::oid ORDER BY parent.rolname`,
      [role[0].oid],
    )
  ).rows;
  assert.deepEqual(memberships, [
    { rolname: "occ_app", admin_option: false, inherit_option: true, set_option: false },
  ]);
  assert.equal(
    (
      await observer.query(
        "SELECT count(*)::integer AS count FROM pg_auth_members WHERE roleid=$1::oid",
        [role[0].oid],
      )
    ).rows[0].count,
    0,
  );
  const functions = (
    await observer.query(
      `SELECT p.oid::text, p.proowner::regrole::text AS owner, p.prosecdef,
            p.provolatile, p.proconfig, p.prosrc,
            has_function_privilege($1,p.oid,'EXECUTE') AS selected,
            has_function_privilege('occ_app',p.oid,'EXECUTE') AS ordinary,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee',x.grantee::text,
                'grantor',x.grantor::text,'privilege',x.privilege_type,
                'grantable',x.is_grantable)), '[]'::jsonb)
             FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x) AS acl
       FROM pg_proc p WHERE p.oid=$2::regprocedure`,
      [controllerRole, outerSignature],
    )
  ).rows;
  assert.equal(functions.length, 1);
  const outer = functions[0];
  assert.equal(outer.owner, "occ_migrator");
  assert.equal(outer.prosecdef, true);
  assert.equal(outer.provolatile, "v");
  assert.deepEqual(outer.proconfig, ["search_path=pg_catalog, pg_temp"]);
  assert.equal(outer.selected, true);
  assert.equal(outer.ordinary, false);
  const source = await readFile(
    new URL("../../migrations/0035_workload_profile_session_security.sql", import.meta.url),
    "utf8",
  );
  const body = source
    .slice(source.indexOf("CREATE FUNCTION occ.read_locked_workload_profile_session_v1("))
    .match(/AS \$function\$([\s\S]*?)\$function\$;/)?.[1];
  assert.equal(typeof body, "string");
  assert.equal(
    createHash("sha256").update(outer.prosrc).digest("hex"),
    createHash("sha256").update(body).digest("hex"),
  );
  const ownerOid = (
    await observer.query("SELECT oid::text FROM pg_roles WHERE rolname='occ_migrator'")
  ).rows[0].oid;
  assert.deepEqual(
    outer.acl.filter((entry) => entry.grantee !== ownerOid),
    [
      {
        grantee: role[0].oid,
        grantor: ownerOid,
        privilege: "EXECUTE",
        grantable: false,
      },
    ],
  );
  const nested = [
    "occ.read_locked_account_security_v1(text,text,text,text)",
    "occ.account_security_installation_v1()",
    "occ.account_security_writer_gate_v1()",
    "occ.account_security_refuse_truncate_v1()",
  ];
  for (const signature of nested) {
    assert.equal(
      (
        await observer.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
          controllerRole,
          signature,
        ])
      ).rows[0].allowed,
      false,
    );
  }
  await recordPrivilegeSnapshot(observer);
  const privileges = (
    await observer.query(
      `SELECT has_table_privilege($1,'occ.account_security_records','SELECT') AS records,
            has_schema_privilege($1,'occ','CREATE') AS schema_create,
            has_database_privilege($1,current_database(),'CONNECT') AS connect,
            has_schema_privilege($1,'occ','USAGE') AS usage`,
      [controllerRole],
    )
  ).rows[0];
  assert.deepEqual(privileges, {
    records: false,
    schema_create: false,
    connect: true,
    usage: true,
  });
  const triggers = (
    await observer.query(
      `SELECT c.relname,t.tgname,t.tgenabled,t.tgtype::integer,
            t.tgfoid::regprocedure::text AS function
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE t.tgname IN ('account_security_user_gate_v1','account_security_account_gate_v1',
                        'account_security_session_gate_v1','account_security_session_no_truncate_v1')
      ORDER BY t.tgname`,
    )
  ).rows;
  assert.equal(triggers.length, 4);
  assert.ok(triggers.every((trigger) => trigger.tgenabled === "O"));
  assert.ok(
    triggers
      .filter((trigger) => !trigger.tgname.includes("truncate"))
      .every(
        (trigger) =>
          trigger.function === "occ.account_security_writer_gate_v1()" && trigger.tgtype === 30,
      ),
  );
}

async function requestJson(endpoint, origin, session, method, path, payload) {
  const response = await fetch(new URL(path, endpoint), {
    method,
    headers: authenticatedHeaders(session, {
      origin,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    }),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(4000),
  });
  return {
    status: response.status,
    value: response.status === 204 ? undefined : await response.json(),
  };
}

function assertUnavailable(result) {
  assert.equal(result.kind, "response");
  assert.equal(result.status, 503);
  assert.equal(result.value?.error?.code, "DEPENDENCY_UNAVAILABLE");
}

async function accountState(observer, accountId) {
  return (
    await observer.query(
      `SELECT account_version::text,state,current_user_id,credential_account_id
       FROM occ.account_security_records WHERE account_id=$1`,
      [accountId],
    )
  ).rows[0];
}

async function authenticatedSession(endpoint, origin, observer, credentials) {
  const user = (
    await observer.query('SELECT id FROM occ."user" WHERE email=$1', [credentials.email])
  ).rows;
  assert.equal(user.length, 1, "Authentication requires a genuinely provisioned user.");
  const previous = new Set(
    (await observer.query("SELECT id FROM occ.session WHERE user_id=$1", [user[0].id])).rows.map(
      (row) => row.id,
    ),
  );
  const session = await signInWithEmailPassword({
    origin: endpoint,
    headers: { origin },
    ...credentials,
  });
  const created = (
    await observer.query("SELECT id, user_id, expires_at FROM occ.session WHERE user_id=$1", [
      user[0].id,
    ])
  ).rows.filter((row) => !previous.has(row.id));
  assert.equal(created.length, 1, "Real BetterAuth sign-in must create one new session.");
  assert.equal((await accountState(observer, user[0].id)).state, "active");
  return { ...session, id: created[0].id, userId: user[0].id };
}

async function provision(endpoint, origin, admin, roleId, observer) {
  const credentials = {
    email: `receiving-${randomUUID()}@example.test`,
    password: `receiving-password-${randomUUID()}`,
  };
  const response = await requestJson(endpoint, origin, admin, "POST", "/api/auth/accounts", {
    ...credentials,
    name: "Receiving PostgreSQL operator",
    roleId,
  });
  assert.equal(response.status, 201);
  const session = await authenticatedSession(endpoint, origin, observer, credentials);
  assert.equal(session.userId, response.value.data.id);
  return { credentials, session, account: response.value.data };
}

async function receiverTerminal(observer, identity) {
  await observeUntil(
    () => activity(observer, { pid: identity.pid }),
    (rows) =>
      rows.length === 0 ||
      rows.every((row) => row.xact_start !== identity.xact_start || row.state === "idle"),
    "receiving transaction terminal",
  );
  const held = (
    await observer.query(
      "SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",
      [identity.pid],
    )
  ).rows[0].count;
  assert.equal(held, 0, "The receiving terminal must release its transaction gate.");
}

async function blockedReceiving({
  observer,
  writers,
  iamWriters,
  endpoint,
  origin,
  session,
  path,
  payload,
  mutation,
  commitGate = false,
  expectedInvalid = false,
  expire = false,
  abort = false,
  followWriter,
  followSignIn,
  beforeIamRelease,
  expectedStatus = 404,
  serverErrors,
  context,
}) {
  let gateWriter;
  let iamWriter;
  let waitingWriter;
  let pendingWriter;
  let request;
  let acquired;
  try {
    iamWriter = await begin(iamWriters);
    // ROW EXCLUSIVE conflicts with the real six-table SHARE barrier while
    // allowing ordinary authentication policy SELECTs to finish first.
    await iamWriter.client.query("LOCK TABLE occ.iam_roles IN ROW EXCLUSIVE MODE");
    gateWriter = await begin(writers);
    await gateWriter.client.query("UPDATE occ.session SET expires_at=expires_at WHERE id=$1", [
      session.id,
    ]);
    if (mutation !== undefined) await mutation(gateWriter.client);
    const gate = await capturedGate(observer, gateWriter.identity.pid);
    request = openRequest(endpoint, origin, session, "PATCH", path, payload);
    const helperRows = await observeUntil(
      () => activity(observer, { helper: true, blocker: gateWriter.identity.pid }),
      (rows) =>
        rows.length === 1 &&
        rows[0].wait_event_type === "Lock" &&
        hasGate(rows[0], gate, "ShareLock", false),
      "outer session-helper wait",
    );
    acquired = helperRows[0];
    assert.equal(acquired.usename, controllerRole);
    assert.equal(acquired.query_kind, "profile-session-helper");
    assert.ok(acquired.xact_start);
    if (expire) {
      // This is a genuine database expiry, not a replacement clock or renewed
      // receiving deadline. The session was shortened before HTTP capture.
      const end = request.started + 2000;
      let elapsed = false;
      while (performance.now() < end) {
        const row = (
          await observer.query(
            "SELECT clock_timestamp()>=expires_at AS expired FROM occ.session WHERE id=$1",
            [session.id],
          )
        ).rows[0];
        if (row?.expired) {
          elapsed = true;
          break;
        }
        await delay(25);
      }
      assert.equal(elapsed, true, "Real session expiry must fit the original command lifetime.");
    }
    await finish(gateWriter, commitGate);
    if (expectedInvalid) {
      assertUnavailable(await request.outcome);
      await receiverTerminal(observer, acquired);
      return;
    }
    const iamRows = await observeUntil(
      () => activity(observer, { pid: acquired.pid, blocker: iamWriter.identity.pid }),
      (rows) =>
        rows.length === 1 &&
        rows[0].query_kind === "native-iam-lock" &&
        rows[0].wait_event_type === "Lock",
      "same-client IAM wait",
    );
    const atIam = iamRows[0];
    for (const key of ["pid", "backend_start", "xact_start", "datid", "usesysid"])
      assert.equal(atIam[key], acquired[key]);
    assert.equal(hasGate(atIam, gate, "ShareLock", true), true);
    assert.equal(atIam.account_relation_held, true);
    assert.equal(atIam.session_relation_held, true);
    // An uncontended FOR SHARE need not appear as a tuple row in pg_locks.
    // Same-client acquisition plus a conflicting supported writer proves that
    // these original transaction locks remain held through the terminal.
    if (followSignIn === undefined) waitingWriter = await begin(writers);
    const write =
      followSignIn === undefined
        ? (
            followWriter ??
            ((client) =>
              client.query("UPDATE occ.session SET expires_at=expires_at WHERE id=$1", [
                session.id,
              ]))
          )(waitingWriter.client)
        : followSignIn();
    pendingWriter = write.then(
      () => ({ kind: "complete" }),
      (error) => ({ kind: "failed", code: error.code }),
    );
    await observeUntil(
      () => activity(observer, { pid: waitingWriter?.identity.pid, blocker: acquired.pid }),
      (rows) => rows.length === 1 && hasGate(rows[0], gate, "ExclusiveLock", false),
      "supported writer gate wait",
    );
    // Finishing a catalog observation does not end the separately held original
    // SQL unit. Observe its gate and waiting writer again before terminal.
    assert.equal(
      hasGate((await activity(observer, { pid: acquired.pid }))[0], gate, "ShareLock", true),
      true,
    );
    if (beforeIamRelease !== undefined) await beforeIamRelease(iamWriter.client);
    if (abort) {
      request.abort();
      assert.equal((await request.outcome).kind, "transport-closed");
      // Disconnect marks the genuine request aborted. Release this controlled
      // IAM wait so the original post-await fence can observe it and roll back.
      // This does not assert immediate physical cancellation of blocked SQL.
      const releasedAt = performance.now();
      await finish(iamWriter, true);
      const classified = await observeUntil(
        async () => serverErrors.get(request.observationId),
        (value) => value !== undefined,
        "aborted server-side receiving fence",
      );
      assert.equal(classified.name, "DependencyUnavailableError");
      assert.ok(classified.at >= releasedAt);
      await receiverTerminal(observer, acquired);
      context.diagnostic(
        `Real abort fence classified after IAM release in ${Math.ceil(classified.at - releasedAt)}ms; total command ${Math.ceil(performance.now() - request.started)}ms.`,
      );
    } else {
      await finish(iamWriter, true);
      const response = await request.outcome;
      assert.equal(response.kind, "response");
      assert.equal(response.status, expectedStatus);
      assert.equal(
        response.value?.error?.code,
        expectedStatus === 403
          ? "FORBIDDEN"
          : expectedStatus === 404
            ? "NOT_FOUND"
            : "DEPENDENCY_UNAVAILABLE",
      );
      await receiverTerminal(observer, acquired);
      if (expectedStatus === 404) {
        const classified = serverErrors.get(request.observationId);
        assert.equal(
          classified?.name,
          "ScopeViolationError",
          "Un-aborted absent-resource control must differ from the abort fence.",
        );
      }
    }
    assert.equal((await pendingWriter).kind, "complete");
    await finish(waitingWriter, true);
    context.diagnostic(
      `Observed session-helper -> IAM -> terminal on one ${controllerRole} backend and transaction; supported writer settled afterward.`,
    );
  } finally {
    request?.abort();
    // Both held controls release even when an earlier assertion or SQL terminal
    // failed. Only then can the real waiting writer and request drain.
    const controls = await Promise.allSettled([finish(gateWriter), finish(iamWriter)]);
    if (request !== undefined) await request.outcome;
    if (pendingWriter !== undefined) await pendingWriter;
    const writer = await Promise.allSettled([finish(waitingWriter)]);
    assert.ok(
      [...controls, ...writer].every((result) => result.status === "fulfilled"),
      "All owned receiving control transactions must settle.",
    );
  }
}

// The ordinary baseline driver is preserved. Receiving uses this explicit
// rejecting fixture only to detect an unexpected work dispatch; it supplies no
// successful Compute/provider response and no capability or Use producer.
export function receivingComputeObserver(existing) {
  const calls = [];
  const reject = (method) => async () => {
    calls.push(method);
    assert.fail(`Receiving refusal unexpectedly dispatched Compute.${method}.`);
  };
  return {
    calls,
    driver: Object.freeze({
      id: existing.id,
      capability: existing.capability,
      implementation: existing.implementation,
      ...(typeof existing.preflight === "function"
        ? { preflight: existing.preflight.bind(existing) }
        : {}),
      ensureNamespace: reject("ensureNamespace"),
      deleteNamespace: reject("deleteNamespace"),
      prepareRevision: reject("prepareRevision"),
      retireRevision: reject("retireRevision"),
    }),
  };
}

export async function exerciseReceivingPostgres({
  context,
  databaseUrl,
  defaultApp,
  defaultEndpoint,
  createSelectedApp,
  authBaseURL,
  credentials,
  runWriterMatrix,
  computeCalls,
}) {
  const selected = receivingPostgresEnvironment(databaseUrl);
  await context.test(
    "real receiving factory session/IAM custody and refusal",
    {
      skip: selected === undefined ? "Select all three receiving PostgreSQL role URLs." : false,
      timeout: runWriterMatrix ? 120000 : 90000,
    },
    async (group) => {
      const observerPool = pool(selected.observer, 2);
      const writers = pool(databaseUrl, 2);
      const iamWriters = pool(selected.migrator, 1);
      const selectedReader = pool(selected.selected, 1);
      let observer;
      let app;
      const origin = new URL(authBaseURL).origin;
      try {
        observer = await observerPool.connect();
        observer.on("error", quietClientError);
        await verifyEnrollment(observer);
        const installations = (await observer.query("SELECT id FROM occ.installation")).rows;
        assert.equal(installations.length, 1);
        const installationId = installations[0].id;
        const namespaces = (
          await observer.query("SELECT id FROM occ.namespaces WHERE name='default'")
        ).rows;
        assert.equal(namespaces.length, 1);
        const namespaceId = namespaces[0].id;
        const absentAgent = `agt_${randomUUID()}`;
        const absentConfiguration = `cfg_${randomUUID()}`;
        const selection = Object.freeze({
          manifestRef: randomUUID(),
          admissionRef: randomUUID(),
          admissionVersion: 1,
          manifestDigest: `sha256:${"0".repeat(64)}`,
        });
        const absentPath = `/namespaces/${namespaceId}/agents/${absentAgent}`;
        const absentPayload = {
          configurationId: absentConfiguration,
          workloadProfileSelection: selection,
        };
        const baselineEndpoint =
          defaultEndpoint ?? (await defaultApp.listen({ host: "127.0.0.1", port: 0 }));
        const ordinary = await authenticatedSession(
          baselineEndpoint,
          origin,
          observer,
          credentials,
        );

        const checkedCase = async (name, work) =>
          group.test(name, async (testContext) => {
            const before = await publicationSnapshot(observer);
            const callsBefore = computeCalls.length;
            const denialBefore = (
              await observer.query(
                "SELECT count(*)::integer AS count FROM occ.audit_events WHERE kind='authorization_denial'",
              )
            ).rows[0].count;
            try {
              await work(testContext);
              assert.deepEqual(
                await publicationSnapshot(observer),
                before,
                "Receiving refusal/abort must not publish draft, revision, work, Use, intent, admission, capacity or a successful mutation audit.",
              );
              assert.equal(computeCalls.length, callsBefore);
              const denialAfter = (
                await observer.query(
                  "SELECT count(*)::integer AS count FROM occ.audit_events WHERE kind='authorization_denial'",
                )
              ).rows[0].count;
              assert.ok(denialAfter >= denialBefore);
            } catch (error) {
              // A failed SQL/auth interval is still a failed test. Keep credentials,
              // SQL diagnostics and captured request fields out of TAP evidence.
              const code =
                typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
                  ? error.code
                  : "ASSERTION_OR_DEPENDENCY";
              throw new Error(`${name} failed at its original receiving boundary (${code}).`);
            }
          });

        await checkedCase(
          "R2 default app role refuses the real outer helper without publication",
          async () => {
            const request = openRequest(
              baselineEndpoint,
              origin,
              ordinary,
              "PATCH",
              absentPath,
              absentPayload,
            );
            try {
              assertUnavailable(await request.outcome);
            } finally {
              request.abort();
              await request.outcome;
            }
          },
        );
        // State and BetterAuth now move together to the selected factory pool.
        // There is never a privileged fallback or an injected session reader.
        await defaultApp.close();
        app = await createSelectedApp(selected.selected);
        const serverErrors = new Map();
        app.addHook("onError", async (request, _reply, error) => {
          const key = request.headers["x-receiving-observation-id"];
          if (typeof key === "string" && /^[0-9a-f-]{36}$/.test(key)) {
            serverErrors.set(key, {
              requestId: request.id,
              name: error.name,
              at: performance.now(),
            });
          }
        });
        const endpoint = await app.listen({ host: "127.0.0.1", port: 0 });
        const admin = await authenticatedSession(endpoint, origin, observer, credentials);
        const roles = (
          await observer.query("SELECT id, permissions FROM occ.iam_roles ORDER BY id")
        ).rows;
        const role = roles.find((candidate) =>
          candidate.permissions.some(
            (permission) =>
              permission.action === "read" && permission.resourceKind === "installation",
          ),
        );
        assert.ok(role, "The actual bootstrap must supply an account-bindable role.");
        const configured = await requestJson(
          endpoint,
          origin,
          admin,
          "POST",
          `/namespaces/${namespaceId}/configurations`,
          { kind: "agent", values: { model: "receiving-no-provider" } },
        );
        assert.equal(configured.status, 201);
        const created = await requestJson(
          endpoint,
          origin,
          admin,
          "POST",
          `/namespaces/${namespaceId}/agents`,
          { name: `receiving-${randomUUID()}`, configurationId: configured.value.data.id },
        );
        assert.equal(created.status, 201);
        const actualPath = `/namespaces/${namespaceId}/agents/${created.value.data.id}`;
        const actualPayload = {
          configurationId: configured.value.data.id,
          workloadProfileSelection: selection,
        };
        const interval = (session, extra) =>
          blockedReceiving({
            observer,
            writers,
            iamWriters,
            endpoint,
            origin,
            session,
            path: absentPath,
            payload: absentPayload,
            serverErrors,
            ...extra,
          });

        await checkedCase(
          "R1 same real reader client advances from session gate to IAM and releases its writer",
          async (c) => {
            await interval(admin, { context: c });
          },
        );
        await checkedCase(
          "R3 loopback disconnect ends the receiving transaction before its waiting writer",
          async (c) => {
            await interval(admin, { context: c, abort: true });
          },
        );

        for (const kind of [
          "session-delete",
          "session-rotate",
          "credential-remove",
          "writer-rollback",
          "real-expiry",
        ]) {
          // Each invalidation owns an independently provisioned and signed-in
          // account. No modified row is ever presented as a manufactured login.
          const person = await provision(endpoint, origin, admin, role.id, observer);
          if (kind === "real-expiry")
            await writers.query(
              "UPDATE occ.session SET expires_at=clock_timestamp()+interval '1200 milliseconds' WHERE id=$1",
              [person.session.id],
            );
          await checkedCase(`R4 fresh post-wait ${kind}`, async (c) => {
            const mutation =
              kind === "session-delete" || kind === "writer-rollback"
                ? (client) =>
                    client.query("DELETE FROM occ.session WHERE id=$1", [person.session.id])
                : kind === "session-rotate"
                  ? (client) =>
                      client.query("UPDATE occ.session SET token=$2 WHERE id=$1", [
                        person.session.id,
                        randomUUID(),
                      ])
                  : kind === "credential-remove"
                    ? (client) =>
                        client.query(
                          "DELETE FROM occ.account WHERE user_id=$1 AND provider_id='credential'",
                          [person.session.userId],
                        )
                    : undefined;
            await interval(person.session, {
              context: c,
              mutation,
              commitGate: kind !== "writer-rollback",
              expectedInvalid: kind !== "writer-rollback",
              expire: kind === "real-expiry",
              expectedStatus: kind === "writer-rollback" ? 403 : 404,
            });
          });
        }

        // A newly provisioned account has only its exact Installation binding.
        // This explicit operator fixture enrollment adds two real persisted target
        // bindings. It is not a public HTTP API, replacement IAM or a positive Use.
        const bindingColumns =
          "id,namespace_id,identity_subject_id,group_subject_id,role_id,resource_kind,resource_id,channel_administration";
        const enrollTargetBindings = async (person) => {
          assert.equal(typeof person.account.principalId, "string");
          assert.equal(created.value.data.serviceAccountId ?? null, null);
          assert.ok(
            role.permissions.some(
              (permission) => permission.action === "update" && permission.resourceKind === "agent",
            ),
          );
          assert.ok(
            role.permissions.some(
              (permission) =>
                permission.action === "read" && permission.resourceKind === "configuration",
            ),
          );
          const transaction = await begin(iamWriters);
          try {
            const original = (
              await transaction.client.query(
                `SELECT ${bindingColumns} FROM occ.iam_access_bindings ORDER BY id`,
              )
            ).rows;
            const expected = [
              {
                id: `iab_${randomUUID()}`,
                namespace_id: namespaceId,
                identity_subject_id: person.account.principalId,
                group_subject_id: null,
                role_id: role.id,
                resource_kind: "agent",
                resource_id: created.value.data.id,
                channel_administration: null,
              },
              {
                id: `iab_${randomUUID()}`,
                namespace_id: namespaceId,
                identity_subject_id: person.account.principalId,
                group_subject_id: null,
                role_id: role.id,
                resource_kind: "configuration",
                resource_id: configured.value.data.id,
                channel_administration: null,
              },
            ];
            const result = await transaction.client.query(
              `INSERT INTO occ.iam_access_bindings
             (id,namespace_id,identity_subject_id,group_subject_id,role_id,resource_kind,resource_id,channel_administration)
             VALUES ($1,$2,$3,NULL,$4,'agent',$5,NULL),($6,$2,$3,NULL,$4,'configuration',$7,NULL)
             RETURNING ${bindingColumns}`,
              [
                expected[0].id,
                namespaceId,
                person.account.principalId,
                role.id,
                created.value.data.id,
                expected[1].id,
                configured.value.data.id,
              ],
            );
            assert.equal(result.rowCount, 2);
            const byKind = (a, b) => a.resource_kind.localeCompare(b.resource_kind);
            assert.deepEqual([...result.rows].sort(byKind), [...expected].sort(byKind));
            await finish(transaction, true);
            return { original, expected };
          } finally {
            await finish(transaction);
          }
        };
        const withdrawTargetBindings = async (client, enrollment) => {
          for (const row of enrollment.expected) {
            const result = await client.query(
              `DELETE FROM occ.iam_access_bindings
              WHERE id=$1 AND namespace_id=$2 AND identity_subject_id=$3
                AND group_subject_id IS NULL AND role_id=$4 AND resource_kind=$5
                AND resource_id=$6 AND channel_administration IS NULL
              RETURNING ${bindingColumns}`,
              [
                row.id,
                row.namespace_id,
                row.identity_subject_id,
                row.role_id,
                row.resource_kind,
                row.resource_id,
              ],
            );
            assert.equal(result.rowCount, 1);
            assert.deepEqual(result.rows, [row]);
          }
          assert.deepEqual(
            (
              await client.query(
                `SELECT ${bindingColumns} FROM occ.iam_access_bindings ORDER BY id`,
              )
            ).rows,
            enrollment.original,
            "Only the two captured target bindings may be withdrawn; original Installation/admin bindings remain.",
          );
        };
        const limited = await provision(endpoint, origin, admin, role.id, observer);
        const limitedEnrollment = await enrollTargetBindings(limited);
        await checkedCase(
          "R6 exact target bindings pass original IAM before committed withdrawal",
          async (c) => {
            await interval(limited.session, {
              context: c,
              path: actualPath,
              payload: actualPayload,
              expectedStatus: 404,
            });
          },
        );
        const withdrawalTransaction = await begin(iamWriters);
        try {
          await withdrawTargetBindings(withdrawalTransaction.client, limitedEnrollment);
          await finish(withdrawalTransaction, true);
        } finally {
          await finish(withdrawalTransaction);
        }
        await checkedCase(
          "R6 real principal with its own committed target bindings withdrawn is denied",
          async () => {
            const response = await requestJson(
              endpoint,
              origin,
              limited.session,
              "PATCH",
              actualPath,
              actualPayload,
            );
            assert.equal(response.status, 403);
            assert.equal(response.value?.error?.code, "FORBIDDEN");
          },
        );
        const withdrawal = await provision(endpoint, origin, admin, role.id, observer);
        const duringWaitEnrollment = await enrollTargetBindings(withdrawal);
        await checkedCase(
          "R6 exact target bindings pass original IAM before held-wait withdrawal",
          async (c) => {
            await interval(withdrawal.session, {
              context: c,
              path: actualPath,
              payload: actualPayload,
              expectedStatus: 404,
            });
          },
        );
        await checkedCase(
          "R6 target authority withdrawn after authentication is reloaded at original IAM",
          async (c) => {
            await interval(withdrawal.session, {
              context: c,
              path: actualPath,
              payload: actualPayload,
              expectedStatus: 403,
              beforeIamRelease: (client) => withdrawTargetBindings(client, duringWaitEnrollment),
            });
          },
        );
        const foreignNamespace = await requestJson(endpoint, origin, admin, "POST", "/namespaces", {
          name: `receiving-foreign-${randomUUID()}`,
        });
        assert.equal(foreignNamespace.status, 201);
        await checkedCase(
          "R6 actual foreign Namespace and Agent tuple refuses without publication",
          async () => {
            const response = await requestJson(
              endpoint,
              origin,
              admin,
              "PATCH",
              `/namespaces/${foreignNamespace.value.data.id}/agents/${created.value.data.id}`,
              actualPayload,
            );
            assert.equal(response.status, 404);
            assert.equal(response.value?.error?.code, "NOT_FOUND");
          },
        );
        await checkedCase(
          "R6 absent Agent stays not-found after genuine reader and IAM acquisition",
          async (c) => {
            await interval(admin, { context: c });
          },
        );
        await checkedCase(
          "R6 provisioning Namespace refuses before any admitted-head or Use claim",
          async () => {
            const response = await requestJson(
              endpoint,
              origin,
              admin,
              "PATCH",
              actualPath,
              actualPayload,
            );
            assert.equal(response.status, 404);
            assert.equal(response.value?.error?.code, "NOT_FOUND");
          },
        );

        if (runWriterMatrix) {
          const donor = await provision(endpoint, origin, admin, role.id, observer);
          const writerKinds = [
            "signin-insert",
            "session-token-update",
            "session-expiry-update",
            "session-delete",
            "session-bulk-update",
            "session-bulk-delete",
            "password-update",
            "credential-delete",
            "user-update",
            "user-delete-cascade",
          ];
          for (const kind of writerKinds) {
            const person = await provision(endpoint, origin, admin, role.id, observer);
            if (kind.includes("bulk"))
              await authenticatedSession(endpoint, origin, observer, person.credentials);
            const beforeAccount = await accountState(observer, person.session.userId);
            const sessionsBefore = (
              await observer.query(
                "SELECT count(*)::integer AS count FROM occ.session WHERE user_id=$1",
                [person.session.userId],
              )
            ).rows[0].count;
            await checkedCase(
              `R5 supported ${kind} waits at the original Installation gate`,
              async (c) => {
                const writes = {
                  "session-token-update": [
                    "UPDATE occ.session SET token=$2 WHERE id=$1",
                    [person.session.id, randomUUID()],
                  ],
                  "session-expiry-update": [
                    "UPDATE occ.session SET expires_at=expires_at+interval '1 minute' WHERE id=$1",
                    [person.session.id],
                  ],
                  "session-delete": ["DELETE FROM occ.session WHERE id=$1", [person.session.id]],
                  "session-bulk-update": [
                    "UPDATE occ.session SET expires_at=expires_at+interval '1 minute' WHERE user_id=$1",
                    [person.session.userId],
                  ],
                  "session-bulk-delete": [
                    "DELETE FROM occ.session WHERE user_id=$1",
                    [person.session.userId],
                  ],
                  // The replacement hash comes from another genuinely provisioned
                  // credential; no invented password format is accepted as auth.
                  "password-update": [
                    "UPDATE occ.account SET password=(SELECT password FROM occ.account WHERE user_id=$2 AND provider_id='credential') WHERE user_id=$1 AND provider_id='credential'",
                    [person.session.userId, donor.session.userId],
                  ],
                  "credential-delete": [
                    "DELETE FROM occ.account WHERE user_id=$1 AND provider_id='credential'",
                    [person.session.userId],
                  ],
                  "user-update": [
                    'UPDATE occ."user" SET name=$2 WHERE id=$1',
                    [person.session.userId, "Receiving renamed operator"],
                  ],
                  "user-delete-cascade": [
                    'DELETE FROM occ."user" WHERE id=$1',
                    [person.session.userId],
                  ],
                };
                await interval(person.session, {
                  context: c,
                  abort: true,
                  ...(kind === "signin-insert"
                    ? {
                        followSignIn: () =>
                          signInWithEmailPassword({
                            origin: endpoint,
                            headers: { origin },
                            ...person.credentials,
                          }),
                      }
                    : { followWriter: (client) => client.query(...writes[kind]) }),
                });
                const afterAccount = await accountState(observer, person.session.userId);
                assert.equal(
                  afterAccount.state,
                  kind === "credential-delete"
                    ? "provisioning"
                    : kind === "user-delete-cascade"
                      ? "deleted"
                      : "active",
                );
                if (kind === "user-delete-cascade") {
                  // The real user and credential cascade triggers may both advance
                  // the account. Preserve the resulting tombstone, not a guessed count.
                  assert.ok(
                    BigInt(afterAccount.account_version) > BigInt(beforeAccount.account_version),
                  );
                  assert.equal(afterAccount.current_user_id, null);
                  assert.equal(afterAccount.credential_account_id, null);
                } else
                  assert.equal(
                    BigInt(afterAccount.account_version),
                    BigInt(beforeAccount.account_version) +
                      (["password-update", "credential-delete", "user-update"].includes(kind)
                        ? 1n
                        : 0n),
                  );
                if (kind === "signin-insert")
                  assert.equal(
                    (
                      await observer.query(
                        "SELECT count(*)::integer AS count FROM occ.session WHERE user_id=$1",
                        [person.session.userId],
                      )
                    ).rows[0].count,
                    sessionsBefore + 1,
                  );
                if (kind === "password-update") {
                  // A new account version alone does not revoke a still-valid
                  // original session. The fresh real receiving lookup can proceed.
                  const result = await requestJson(
                    endpoint,
                    origin,
                    person.session,
                    "PATCH",
                    absentPath,
                    absentPayload,
                  );
                  assert.equal(result.status, 403);
                  assert.equal(result.value?.error?.code, "FORBIDDEN");
                }
              },
            );
          }
        }
        if (runWriterMatrix) {
          // These are SQL rejection controls only. No negative row is authenticated
          // or supplied as a factory lease, request handle, Use or provider proof.
          for (const [label, controlPool, sql, code] of [
            [
              "owner TRUNCATE remains blocked by the installed trigger",
              iamWriters,
              "TRUNCATE occ.session",
              "55000",
            ],
            [
              "selected login cannot bypass into account records",
              selectedReader,
              "SELECT * FROM occ.account_security_records",
              "42501",
            ],
            [
              "selected login cannot invoke the nested account helper",
              selectedReader,
              "SELECT * FROM occ.read_locked_account_security_v1('x','x','x','x')",
              "42501",
            ],
          ])
            await checkedCase(`R5 ${label}`, async () => {
              const transaction = await begin(controlPool);
              let observed;
              try {
                try {
                  await transaction.client.query(sql);
                } catch (error) {
                  observed = error.code;
                }
              } finally {
                await finish(transaction);
              }
              assert.equal(observed, code);
            });
          for (const kind of ["provisioning", "deleted", "no-record"]) {
            let tuple;
            if (kind === "deleted") {
              const person = await provision(endpoint, origin, admin, role.id, observer);
              tuple = (
                await observer.query(
                  `SELECT r.installation_id,r.account_id,r.issuer,r.subject,s.id AS session_id,
                      encode(sha256(convert_to(s.token,'UTF8')),'hex') AS credential_digest
                 FROM occ.account_security_records r JOIN occ.session s ON s.user_id=r.current_user_id
                WHERE r.account_id=$1 AND s.id=$2`,
                  [person.session.userId, person.session.id],
                )
              ).rows[0];
              await writers.query('DELETE FROM occ."user" WHERE id=$1', [person.session.userId]);
              assert.equal((await accountState(observer, person.session.userId)).state, "deleted");
            } else if (kind === "provisioning") {
              const id = randomUUID();
              await writers.query(
                `INSERT INTO occ."user" (id,name,email,email_verified,created_at,updated_at)
               VALUES ($1,'Receiving negative control',$2,false,clock_timestamp(),clock_timestamp())`,
                [id, `receiving-unprovisioned-${randomUUID()}@example.test`],
              );
              tuple = (
                await observer.query(
                  "SELECT installation_id,account_id,issuer,subject FROM occ.account_security_records WHERE account_id=$1",
                  [id],
                )
              ).rows[0];
              assert.equal((await accountState(observer, id)).state, "provisioning");
            } else {
              const original = (
                await observer.query(
                  "SELECT installation_id,issuer FROM occ.account_security_records WHERE account_id=$1",
                  [admin.userId],
                )
              ).rows[0];
              const id = randomUUID();
              assert.equal(await accountState(observer, id), undefined);
              tuple = { ...original, account_id: id, subject: id };
            }
            await checkedCase(`R5 ${kind} cannot produce a SQL session-security row`, async () => {
              const transaction = await begin(selectedReader);
              try {
                const result = await transaction.client.query(
                  `SELECT * FROM occ.read_locked_workload_profile_session_v1($1,$2,$3,$4,$5,$6)`,
                  [
                    tuple.installation_id,
                    tuple.account_id,
                    tuple.issuer,
                    tuple.subject,
                    tuple.session_id ?? "receiving-negative-session",
                    tuple.credential_digest ?? "0".repeat(64),
                  ],
                );
                assert.equal(result.rowCount, 0);
              } finally {
                await finish(transaction);
              }
            });
          }
        }
        assert.equal(computeCalls.length, 0, "No receiving interval may dispatch Compute work.");
        group.diagnostic(
          "All publication snapshots include Agent drafts/revisions, controller work, profile Use-bearing revisions, runtime intent/admission and capacity; denial audits remain distinct. No successful receiving COMMIT or provider capability is claimed.",
        );
      } finally {
        const appSettlement = app === undefined ? [] : await Promise.allSettled([app.close()]);
        if (observer !== undefined) {
          try {
            observer.release();
          } finally {
            observer.removeListener("error", quietClientError);
          }
        }
        const settlements = [
          ...appSettlement,
          ...(await Promise.allSettled([
            selectedReader.end(),
            iamWriters.end(),
            writers.end(),
            observerPool.end(),
          ])),
        ];
        assert.ok(
          settlements.every((result) => result.status === "fulfilled"),
          "Every owned receiving pool must settle successfully.",
        );
      }
    },
  );
}
