import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  PostgresPlatformState,
  PostgresCommitOutcomeUnknownError,
} from "../../packages/occ/src/state/postgres-state.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { createBootstrapAdministratorSeed, NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  accountSecurityRecords,
  installation as installationTable,
  user,
  account,
  gatewayStartupHeads,
} from "../../packages/occ/src/state/postgres-schema.ts";
const { getTableConfig } = createRequire(
  new URL("../../packages/occ/package.json", import.meta.url),
)("drizzle-orm/pg-core");

const now = "2026-09-07T00:00:00.000Z";
const installation = {
  id: "ins_00000000-0000-4000-8000-000000000001",
  name: "Fresh",
  createdAt: now,
};
const namespace = {
  id: "ns_00000000-0000-4000-8000-000000000002",
  name: "Default",
  status: "provisioning",
  createdAt: now,
};
const tables = [
  "iam_identities",
  "iam_roles",
  "iam_groups",
  "iam_group_memberships",
  "iam_access_bindings",
  "iam_restrictions",
];
const clone = structuredClone;
const result = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function seed() {
  const original = createBootstrapAdministratorSeed(
    installation.id,
    `occ:installation:${installation.id}:better-auth`,
    { id: "actual-account" },
  );
  return {
    identities: [original.principal, original.servicePrincipal],
    roles: original.roles,
    bindings: original.bindings,
    groups: [],
    memberships: [],
    restrictions: [],
  };
}
function audit(original, ns = namespace) {
  return {
    id: "aud_00000000-0000-4000-8000-000000000003",
    installationId: installation.id,
    occurredAt: now,
    kind: "bootstrap",
    actorId: original.identities[0].id,
    source: "occ",
    action: "administer",
    resource: { kind: "installation", id: installation.id },
    outcome: "success",
    details: {
      kind: "bootstrap",
      source: "development-installation-job",
      servicePrincipalId: original.identities[1].id,
      serviceKeyId: "key-original",
      defaultNamespaceId: ns.id,
    },
  };
}

// A controlled transaction protocol peer, not a database/BetterAuth/lock emulator.
// The real state owner, repositories, MutationRunner and NativeIAM evaluate all calls.
function peer(options = {}) {
  let durable = {
    installation: [],
    namespaces: [],
    controller_work: [],
    audit_events: [],
    ...Object.fromEntries(tables.map((t) => [t, []])),
  };
  const calls = [];
  const clients = [];
  let checkout = 0;
  const pool = {
    async connect() {
      const number = ++checkout;
      await options.connect?.(number);
      let pending;
      const client = new EventEmitter();
      clients.push(client);
      client.release = () => {
        calls.push({ number, sql: "RELEASE" });
        if (options.releaseEvent === number) {
          const emit = () => client.emit("error", options.failure);
          if (options.releaseEventMicrotask) queueMicrotask(emit);
          else emit();
        }
        if (options.releaseFailure === number) throw options.failure;
      };
      client.query = async (statement, values = []) => {
        const sql = statement.replace(/\s+/g, " ").trim();
        calls.push({ number, sql, values: clone(values) });
        await options.query?.({ number, sql, values, client });
        if (sql.startsWith("BEGIN")) {
          pending = clone(durable);
          return result([], "BEGIN");
        }
        if (sql === "ROLLBACK") {
          pending = undefined;
          return result([], "ROLLBACK");
        }
        if (sql === "COMMIT") {
          if (options.commitRollback === number) {
            pending = undefined;
            return result([], "ROLLBACK");
          }
          durable = pending;
          pending = undefined;
          if (options.commitUnknown === number) throw options.failure;
          return result([], "COMMIT");
        }
        assert.ok(pending, "every data query belongs to the checked-out transaction");
        if (sql.startsWith("LOCK TABLE")) return result([], "LOCK");
        if (sql.includes("AS retained_count"))
          return result([
            { retained_count: String(tables.reduce((n, t) => n + pending[t].length, 0)) },
          ]);
        if (sql.startsWith("INSERT INTO occ.controller_work")) {
          const row = {
            idempotency_key: values[0],
            namespace_id: values[1],
            agent_id: values[2],
            revision_id: values[3],
            actor_id: values[4],
            namespace_target: values[5],
            runtime_transition_ref: values[7],
            lifecycle_generation: values[8],
            work_schema_version: 0,
            state: "queued",
            available_at: now,
            attempt_count: 0,
            created_at: now,
            updated_at: now,
            claim_token: null,
            lease_expires_at: null,
            completed_at: null,
          };
          pending.controller_work.push(row);
          return result([row], "INSERT");
        }
        const insert = /^INSERT INTO occ\.(\w+) \(([^)]+)\)/.exec(sql);
        if (insert) {
          const [, table, columns] = insert;
          const row = Object.fromEntries(
            columns.split(",").map((key, i) => [key.trim(), clone(values[i])]),
          );
          for (const key of ["permissions", "details", "channel_administration"])
            if (typeof row[key] === "string") row[key] = JSON.parse(row[key]);
          if (table === "installation") {
            if (pending.installation.length)
              throw Object.assign(new Error("duplicate installation"), { code: "23505" });
            row.row_version = "101";
          }
          if (table === "namespaces") row.deleted_at = null;
          assert.ok(pending[table], table);
          pending[table].push(row);
          return result([], "INSERT");
        }
        const select = /FROM occ\.(\w+)/.exec(sql);
        if (select) {
          const table = select[1];
          assert.ok(pending[table], table);
          let found = pending[table];
          if (sql.includes("WHERE id=") || sql.includes("WHERE id ="))
            found = found.filter((row) => row.id === values[0]);
          return result(clone(found));
        }
        throw new Error(`Unexpected controlled query: ${sql}`);
      };
      return client;
    },
  };
  const state = new PostgresPlatformState(pool);
  return {
    state,
    options,
    calls,
    clients,
    get db() {
      return durable;
    },
    get checkouts() {
      return checkout;
    },
  };
}
async function admitted(p, original, options = {}) {
  return p.state.transact(async (unit) => {
    options.unit?.(unit);
    assert.equal((await unit.installations.getInstallation()).id, installation.id);
    const ns = await unit.namespaces.createNamespace(clone(namespace));
    if (!options.noWork)
      await unit.operations.append({
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: ns.id,
        resourceId: ns.id,
        actorId: original.identities[0].id,
      });
    if (!options.noAudit) await unit.audit.append(audit(original, ns));
    await options.extra?.(unit);
    return ns;
  });
}
async function reserved(options) {
  const p = peer(options);
  const reservation = await p.state.reserveFreshInstallationV1(installation);
  return { p, reservation, original: seed() };
}

test("definite reservation precedes real Controller/MutationRunner and same-client NativeIAM finalization", async () => {
  const { p, reservation, original } = await reserved();
  assert.equal(p.db.installation[0].id, installation.id);
  assert.deepEqual(p.db.iam_identities, []);
  const controller = new OpenClawController(installation, {
    state: p.state,
    recordOperations: true,
    loggingLevel: "error",
  });
  const iam = new NativeIAMDriver(p.state, { id: "native-iam", implementation: "native" });
  controller.registerDriver(iam);
  controller.selectDriver("iam", iam.id);
  const ns = await p.state.finalizeFreshInstallationV1(reservation, original, () =>
    controller.transact(async (unit) => {
      const created = await controller.createNamespace(original.identities[0].id, {
        name: "Default",
      });
      await unit.audit.append(audit(original, created));
      return created;
    }),
  );
  assert.equal(p.checkouts, 2);
  assert.equal(p.db.namespaces[0].id, ns.id);
  assert.equal(p.db.controller_work.length, 1);
  assert.equal(p.db.audit_events.filter((row) => row.kind === "bootstrap").length, 1);
  assert.equal(p.db.iam_identities.length, 2);
  const queries = p.calls.filter((c) => c.number === 2).map((c) => c.sql);
  const lock = queries.findIndex((s) => s.startsWith("LOCK TABLE"));
  const empty = queries.findIndex((s) => s.includes("AS retained_count"));
  const seedWrite = queries.findIndex((s) => s.startsWith("INSERT INTO occ.iam_identities"));
  const iamRead = queries.findIndex((s) => s.startsWith("SELECT id, namespace_id, agent_id, kind"));
  const nsWrite = queries.findIndex((s) => s.startsWith("INSERT INTO occ.namespaces"));
  assert.ok(lock < empty && empty < seedWrite && seedWrite < iamRead && iamRead < nsWrite);
  assert.equal(queries.filter((s) => s === "COMMIT").length, 1);
});
for (const mode of ["existing", "unknown", "release"])
  test(`reservation ${mode} cannot issue usable fresh authority`, async () => {
    const failure = new Error(mode);
    const p = peer({
      failure,
      ...(mode === "unknown"
        ? { commitUnknown: 1 }
        : mode === "release"
          ? { releaseFailure: 1 }
          : {}),
    });
    if (mode === "existing")
      p.db.installation.push({
        id: installation.id,
        name: installation.name,
        created_at: now,
        row_version: "old",
      });
    await assert.rejects(
      p.state.reserveFreshInstallationV1(installation),
      mode === "existing" ? undefined : PostgresCommitOutcomeUnknownError,
    );
  });
for (const releaseEventMicrotask of [false, true])
  test(`reservation refuses a post-ACK no-throw release event (${releaseEventMicrotask ? "microtask" : "synchronous"})`, async () => {
    const failure = new Error("transport event after definite ACK");
    const p = peer({ failure, releaseEvent: 1, releaseEventMicrotask });
    let handle;
    await assert.rejects(
      p.state.reserveFreshInstallationV1(installation).then((value) => {
        handle = value;
      }),
      PostgresCommitOutcomeUnknownError,
    );
    assert.equal(handle, undefined);
    assert.equal(p.db.installation.length, 1, "acknowledged original insert stays committed");
    assert.deepEqual(p.db.iam_identities, []);
    assert.equal(p.calls.filter((call) => call.sql === "COMMIT").length, 1);
    assert.equal(p.calls.filter((call) => call.sql === "RELEASE").length, 1);
    await assert.rejects(
      p.state.finalizeFreshInstallationV1({ installation }, seed(), async () => {}),
      ScopeViolationError,
    );
    assert.equal(p.checkouts, 1, "no reconstructed authority or retry checkout");
  });
test("copied, foreign and reused handles cannot select finalization", async () => {
  const { p, reservation, original } = await reserved();
  const foreign = peer();
  await assert.rejects(
    p.state.finalizeFreshInstallationV1({ ...reservation }, original, () => admitted(p, original)),
    ScopeViolationError,
  );
  await assert.rejects(
    foreign.state.finalizeFreshInstallationV1(reservation, original, async () => {}),
    ScopeViolationError,
  );
  await p.state.finalizeFreshInstallationV1(reservation, original, () => admitted(p, original));
  await assert.rejects(
    p.state.finalizeFreshInstallationV1(reservation, original, () => admitted(p, original)),
    ScopeViolationError,
  );
  assert.equal(p.checkouts, 2);
  assert.equal(foreign.checkouts, 0);
});
for (const table of tables)
  test(`fresh finalizer cannot adopt retained ${table}`, async () => {
    const { p, reservation, original } = await reserved();
    p.db[table].push({ id: "retained" });
    await assert.rejects(
      p.state.finalizeFreshInstallationV1(reservation, original, () => admitted(p, original)),
      ScopeViolationError,
    );
    assert.deepEqual(p.db.namespaces, []);
    assert.equal(p.db[table].length, 1);
  });
test("changed original insertion identity refuses before IAM seed", async () => {
  const { p, reservation, original } = await reserved();
  p.db.installation[0].row_version = "102";
  await assert.rejects(
    p.state.finalizeFreshInstallationV1(reservation, original, () => admitted(p, original)),
    ScopeViolationError,
  );
  assert.deepEqual(p.db.iam_identities, []);
});
test("seed and operation operands are captured before awaited acquisition", async () => {
  const entered = deferred(),
    resume = deferred();
  const { p, reservation, original } = await reserved({
    connect: async (n) => {
      if (n === 2) {
        entered.resolve();
        await resume.promise;
      }
    },
  });
  const expected = clone(original);
  const run = p.state.finalizeFreshInstallationV1(reservation, original, () =>
    admitted(p, expected, {
      extra: async (unit) => {
        const event = audit(expected);
        const pending = unit.audit.append(event);
        event.actorId = "changed";
        await pending;
      },
    }),
  );
  await entered.promise;
  original.identities[0].subject = "changed";
  resume.resolve();
  await run;
  assert.equal(p.db.iam_identities[0].subject, "actual-account");
  assert.ok(p.db.audit_events.every((row) => row.actor_id === expected.identities[0].id));
});
for (const mode of [
  "noWork",
  "noAudit",
  "noTransaction",
  "secondTransaction",
  "nestedTransaction",
  "foreignRead",
  "seedReplacement",
])
  test(`${mode} cannot escape the original complete bootstrap unit`, async () => {
    const { p, reservation, original } = await reserved();
    await assert.rejects(
      p.state.finalizeFreshInstallationV1(reservation, original, async () => {
        if (mode === "noTransaction") return;
        await admitted(p, original, {
          [mode]: true,
          extra: async () => {
            if (mode === "nestedTransaction")
              await p.state.transact(async () => {}).catch(() => {});
            if (mode === "foreignRead") await p.state.read(async () => {}).catch(() => {});
            if (mode === "seedReplacement") {
              try {
                p.state.setBootstrapNativeIAM(original);
              } catch {}
            }
          },
        });
        if (mode === "secondTransaction") await p.state.transact(async () => {});
      }),
    );
    if (mode !== "secondTransaction") assert.deepEqual(p.db.namespaces, []);
  });
test("caught wrong audit attribution poisons and rolls back the whole finalizer", async () => {
  const { p, reservation, original } = await reserved();
  await assert.rejects(
    p.state.finalizeFreshInstallationV1(reservation, original, () =>
      admitted(p, original, {
        extra: async (unit) => {
          await unit.audit.append({ ...audit(original), actorId: "another-actor" }).catch(() => {});
        },
      }),
    ),
    ScopeViolationError,
  );
  assert.deepEqual(p.db.iam_identities, []);
  assert.deepEqual(p.db.namespaces, []);
  assert.equal(p.db.installation.length, 1);
});
test("an ignored accepted query rejection is joined and preserves original failure", async () => {
  const entered = deferred(),
    resume = deferred(),
    failure = new Error("retained query failure");
  let rejected;
  const { p, reservation, original } = await reserved({
    query: async ({ sql, values }) => {
      if (sql.startsWith("INSERT INTO occ.audit_events") && values[0] === "aud-delayed") {
        entered.resolve();
        await resume.promise;
        throw failure;
      }
    },
  });
  let settled = false;
  const run = p.state
    .finalizeFreshInstallationV1(reservation, original, () =>
      admitted(p, original, {
        extra: async (unit) => {
          rejected = unit.audit.append({ ...audit(original), id: "aud-delayed" });
        },
      }),
    )
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  resume.resolve();
  await assert.rejects(run, (error) => error === failure);
  await assert.rejects(rejected, (error) => error === failure);
  assert.deepEqual(p.db.audit_events, []);
});
test("transport loss poisons final commit even without a rejected query", async () => {
  const { p, reservation, original } = await reserved();
  await assert.rejects(
    p.state.finalizeFreshInstallationV1(reservation, original, () =>
      admitted(p, original, {
        extra: async () => {
          p.clients[1].emit("error", new Error("closed"));
        },
      }),
    ),
  );
  assert.deepEqual(p.db.namespaces, []);
});
for (const mode of ["commitUnknown", "releaseFailure", "afterAck"])
  test(`${mode} retains committed identity and forbids replay`, async () => {
    const failure = new Error(mode);
    const { p, reservation, original } = await reserved({
      failure,
      ...(mode === "afterAck" ? {} : { [mode]: 2 }),
    });
    await assert.rejects(
      p.state.finalizeFreshInstallationV1(reservation, original, async () => {
        await admitted(p, original);
        if (mode === "afterAck") throw failure;
      }),
      PostgresCommitOutcomeUnknownError,
    );
    assert.equal(p.db.namespaces.length, 1);
    await assert.rejects(
      p.state.finalizeFreshInstallationV1(reservation, original, () => admitted(p, original)),
      ScopeViolationError,
    );
  });
test("escaped original unit is closed after finalization", async () => {
  const { p, reservation, original } = await reserved();
  let escaped;
  await p.state.finalizeFreshInstallationV1(reservation, original, () =>
    admitted(p, original, {
      unit: (unit) => {
        escaped = unit;
      },
    }),
  );
  await assert.rejects(escaped.audit.append(audit(original)), ScopeViolationError);
});
test("aggregate registers one original account security table with canonical parents", () => {
  const config = getTableConfig(accountSecurityRecords);
  assert.equal(config.name, "account_security_records");
  assert.equal(config.columns.length, 9);
  const parents = config.foreignKeys.map((fk) => fk.reference().foreignTable);
  assert.ok(parents.includes(installationTable));
  assert.ok(parents.includes(user));
  assert.ok(parents.includes(account));
  assert.equal(getTableConfig(gatewayStartupHeads).name, "gateway_startup_heads");
});
