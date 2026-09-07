import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const { getTableConfig } = createRequire(
  new URL("../../packages/occ/package.json", import.meta.url),
)("drizzle-orm/pg-core");
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  createGatewayStartupOwnerV1,
  createGatewayStartupOwnerV2,
  GatewayStartupOwnerPhaseV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import {
  gatewayStartupHeads,
  gatewayStartupOperations,
  agents,
  installation,
  auditEvents,
} from "../../packages/occ/src/state/postgres-schema.ts";
import { binding as historicalBinding } from "../fixtures/gateway-startup-v1/values.mjs";

// Real central binding, sole execute/phase, Runtime owners, NativeIAM loader and
// scoped PostgreSQL backend. The row peer supplies protocol replies, not SQL
// storage/lock behavior. Controlled account/selection/process/audit collaborators
// exercise integration only; they are not production authority or physical proof.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subject = {
  kind: "agent-gateway",
  installationId: `ins_${uuid(1)}`,
  namespaceRef: `ns_${uuid(2)}`,
  agentRef: `agt_${uuid(3)}`,
};
const selection = {
  manifestRef: uuid(10),
  manifestDigest: `sha256:${"1".repeat(64)}`,
  admissionRef: uuid(11),
  admissionVersion: 1,
};
const roles = Object.fromEntries(
  ["provider", "runtime", "identity", "containment", "storage"].map((name, index) => [
    name,
    { ref: uuid(20 + index), version: 1, contentDigest: `sha256:${"2".repeat(64)}` },
  ]),
);
const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
const read = (version = 2, target = subject) => ({
  schemaVersion: version,
  ...(version === 2 ? { subject: target } : {}),
  kind: "read-operation",
  operation: {
    ...(version === 2
      ? { schemaVersion: 2, subject: target }
      : { installationId: target.installationId }),
    operationRef: "original-operation",
    operationDigest: "a".repeat(64),
    startup: null,
  },
});
const accept = () => ({
  schemaVersion: 2,
  subject,
  kind: "accept-startup",
  operationRef: "original-admission",
  expectedHead: null,
  selectedDefinition: selection,
  predecessorDisposition: ref("controlled-original-settlement"),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const result = (rows = [], command = "SELECT") => ({ command, rows, rowCount: rows.length });

function protocol(options = {}) {
  const calls = [],
    events = [],
    acquired = [],
    audits = [];
  let connects = 0,
    closed = false,
    allocations = 0,
    lastUnit,
    lastPolicy,
    lastIO;
  const client = {
    on() {},
    removeListener() {},
    async query(statement, parameters = []) {
      calls.push({ statement, parameters });
      if (statement === "COMMIT") {
        events.push("commit");
        return options.commit ? options.commit() : result([], "COMMIT");
      }
      if (statement === "ROLLBACK") {
        events.push("rollback");
        return result([], "ROLLBACK");
      }
      if (
        statement.startsWith("BEGIN") ||
        statement.startsWith("SET LOCAL") ||
        statement.startsWith("SELECT set_config")
      )
        return result();
      if (statement.includes("FROM occ.installation "))
        return result([
          {
            id: subject.installationId,
            name: "Installation",
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
      if (statement.includes("lock_workload_profile_iam")) {
        events.push("policy");
        return result();
      }
      if (statement.includes("FROM occ.iam_")) {
        events.push("iam-read");
        // A valid retained policy is required even for an absent-subject lookup.
        // These controlled rows exercise the real loader, not an allow decision.
        if (statement.includes("FROM occ.iam_identities "))
          return result([
            { id: "principal", kind: "principal", issuer: "installation", subject: "account" },
          ]);
        if (statement.includes("FROM occ.iam_roles "))
          return result([{ id: "role", permissions: [{ action: "read", resourceKind: "agent" }] }]);
        if (statement.includes("FROM occ.iam_access_bindings "))
          return result([{ id: "binding", identity_subject_id: "principal", role_id: "role" }]);
        return result();
      }
      if (statement === "SELECT id FROM occ.namespaces WHERE id=$1 FOR SHARE") {
        events.push("namespace");
        return options.namespace ? options.namespace() : result([{ id: parameters[0] }]);
      }
      if (statement === "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR SHARE") {
        events.push("agent");
        return options.agent ? options.agent() : result([{ id: parameters[1] }]);
      }
      if (statement.startsWith("SELECT") && statement.includes("occ.gateway_startup_operations")) {
        events.push("history");
        if (options.history) await options.history();
        return result();
      }
      if (statement.startsWith("SELECT") && statement.includes("occ.gateway_startup_heads"))
        return result([
          {
            installation_id: parameters[0],
            subject_version: parameters[1],
            subject_key: parameters[2],
            namespace_ref: parameters[3],
            agent_ref: parameters[4],
            head_version: 0,
            process_generation: 0,
            latest_operation_ref: null,
            startup_operation_ref: null,
            record_version: 0,
            state: "empty",
          },
        ]);
      if (statement.startsWith("INSERT INTO occ.gateway_startup_heads")) {
        events.push("head");
        return result([{ inserted: true }]);
      }
      if (statement.startsWith("INSERT INTO occ.gateway_startup_operations")) {
        events.push("append");
        return result([{ inserted: true }]);
      }
      if (statement.startsWith("UPDATE occ.gateway_startup_heads")) {
        events.push("advance");
        return result([{ head_version: 1 }]);
      }
      throw new Error(`Unexpected protocol query: ${statement}`);
    },
    release() {
      closed = true;
      events.push("client-release");
      options.release?.();
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      connects++;
      return client;
    },
    async end() {},
  });
  const driverSelection = new DriverSelection();
  const driver = new NativeIAMDriver(state);
  driverSelection.registerDriver(driver);
  driverSelection.selectDriver("iam", driver.id);
  const lease = (name) => {
    const entry = { name, releases: 0, current: true };
    acquired.push(entry);
    return {
      assertCurrent() {
        if (!entry.current) throw new Error("retained participant revoked");
      },
      async release() {
        entry.releases++;
        events.push(`release:${name}`);
        options.leaseRelease?.(name);
      },
    };
  };
  const source = {
    driverSelection,
    authority: {
      async consume(invocation, command, bounds, unit, io, policy) {
        events.push("account");
        lastUnit = unit;
        lastPolicy = policy;
        lastIO = io;
        assert.ok(unit.phase instanceof GatewayStartupOwnerPhaseV1);
        if (options.beforePolicy)
          await options.beforePolicy({ state, unit, io, policy, command, bounds });
        await policy.lockPolicy();
        // Lookup through the actual native adapter loads all six canonical tables.
        assert.equal(
          await policy.iam.lookupIdentity({ issuer: "controlled", subject: "absent" }),
          undefined,
        );
        const owned = lease("account");
        try {
          if (options.afterPolicy)
            await options.afterPolicy({ state, unit, io, policy, command, bounds });
        } catch (error) {
          await owned.release();
          throw error;
        }
        return {
          ...owned,
          attribution: {
            actorId: "controlled-actor",
            requestRef: bounds.requestRef,
            decisionRef: "controlled-decision",
          },
        };
      },
    },
    selection: {
      async resolveLocked(_command, _original, unit, io) {
        io.assertActive();
        const { startup, createEffectRef, ...host } = historicalBinding();
        return {
          ...lease("selection"),
          selected: {
            ...host,
            schemaVersion: 2,
            selection,
            profileRefs: roles,
            admittedConfigurationDigest: `sha256:${"3".repeat(64)}`,
            namespaceRef: unit.subject.namespaceRef,
            agentRef: unit.subject.agentRef,
          },
        };
      },
    },
    process: {
      async requireDisposition(command, _previous, _unit, io) {
        io.assertActive();
        return {
          ...lease("process"),
          predecessor: {
            kind: "complete-initial",
            disposition: command.predecessorDisposition,
            previousStartup: null,
            processOwner: ref("controlled-process-owner"),
            settlement: ref("controlled-settlement"),
          },
        };
      },
      async requireCurrent() {
        return lease("process");
      },
    },
    audit: {
      async append(event, attribution, _unit, io) {
        io.assertActive();
        events.push("audit");
        audits.push({ event, attribution });
        if (options.audit) await options.audit();
      },
    },
    allocate(kind) {
      allocations++;
      return `${kind}-${allocations}`;
    },
  };
  return {
    state,
    source,
    calls,
    events,
    acquired,
    audits,
    connects: () => connects,
    closed: () => closed,
    unit: () => lastUnit,
    policy: () => lastPolicy,
    io: () => lastIO,
    run(input = read(), version = 2, signal = new AbortController().signal) {
      const binding =
        version === 2
          ? state.bindGatewayStartupOwnersV2(source)
          : state.bindGatewayStartupOwnersV1(source);
      const owner =
        version === 2 ? createGatewayStartupOwnerV2(binding) : createGatewayStartupOwnerV1(binding);
      return owner.execute(
        input,
        {},
        {
          requestRef: "original-request",
          signal,
          deadline: new Date(Date.now() + 2500).toISOString(),
        },
      );
    },
  };
}

for (const version of [1, 2]) {
  test(`actual V${version} central owner retains its original unit, policy input and result version`, async () => {
    const p = protocol();
    const output = await p.run(read(version), version);
    assert.equal(output.kind, "not-observed", JSON.stringify({ events: p.events, calls: p.calls }));
    assert.deepEqual(output.operation, read(version).operation);
    assert.equal(p.connects(), 1);
    assert.equal(p.events.filter((event) => event === "commit").length, 1);
    assert.equal(p.events.filter((event) => event === "iam-read").length, 6);
    assert.equal(p.acquired[0].releases, 1);
    assert.ok(p.events.indexOf("client-release") < p.events.indexOf("release:account"));
    assert.throws(() => p.io().assertActive());
    assert.throws(() => p.policy().iam.assertCurrent());
    if (version === 2) {
      assert.deepEqual(p.unit().subject, subject);
      assert.equal(Object.hasOwn(p.unit(), "installationId"), false);
      assert.ok(p.events.indexOf("policy") < p.events.indexOf("namespace"));
      assert.ok(p.events.indexOf("namespace") < p.events.indexOf("agent"));
      assert.ok(p.events.indexOf("agent") < p.events.indexOf("history"));
    } else assert.equal(p.unit().installationId, subject.installationId);
  });
}

test("missing genuine participants remain unavailable before checkout", async () => {
  const p = protocol();
  const binding = p.state.bindGatewayStartupOwnersV2();
  const result = await binding.transaction.run(
    read(),
    {
      signal: new AbortController().signal,
      deadline: new Date(Date.now() + 1000).toISOString(),
      requestRef: "request",
    },
    async () => {
      throw new Error("must not run");
    },
  );
  assert.equal(result.kind, "rolled-back");
  assert.equal(p.connects(), 0);
});

test("foreign Installation subject cannot reach account consumption", async () => {
  const p = protocol();
  assert.equal(
    (await p.run(read(2, { ...subject, installationId: "foreign-installation" }))).kind,
    "unavailable",
  );
  assert.equal(p.events.includes("account"), false);
  assert.equal(p.events.includes("commit"), false);
});

for (const parent of ["namespace", "agent"]) {
  test(`missing ${parent} joins consumed-lease cleanup before returning noncommit`, async () => {
    const p = protocol({ [parent]: () => result() });
    assert.equal((await p.run()).kind, "unavailable");
    assert.equal(p.acquired[0].releases, 1);
    assert.ok(p.events.indexOf("release:account") < p.events.indexOf("client-release"));
    assert.equal(p.events.includes("history"), false);
    assert.equal(p.events.includes("commit"), false);
  });
}

test("cancellation during parent acquisition joins the original consumed lease", async () => {
  const entered = deferred(),
    pending = deferred(),
    abort = new AbortController();
  const p = protocol({
    namespace: () => {
      entered.resolve();
      return pending.promise;
    },
  });
  const running = p.run(read(), 2, abort.signal);
  await Promise.race([
    entered.promise,
    running.then(() => {
      throw new Error("command completed before parent acquisition");
    }),
  ]);
  abort.abort(new Error("original cancellation"));
  pending.resolve(result([{ id: subject.namespaceRef }]));
  assert.equal((await running).kind, "unavailable");
  assert.equal(p.acquired[0].releases, 1);
  assert.equal(p.events.includes("commit"), false);
});

test("premature IAM access poisons the actual Gateway phase even when caught", async () => {
  const p = protocol({
    beforePolicy: async ({ policy }) => {
      try {
        policy.iam.assertCurrent();
      } catch {}
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.includes("commit"), false);
});

test("a foreign private IAM token cannot borrow the Gateway enrollment", async () => {
  const p = protocol({
    afterPolicy: async ({ state }) => {
      await assert.rejects(state.loadNativeIAMStateInTransaction({}));
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.includes("commit"), false);
});

test("same phase rejects an ambient nested platform transaction", async () => {
  const p = protocol({
    afterPolicy: async ({ state }) => {
      await assert.rejects(state.transact(async () => undefined));
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.connects(), 1);
  assert.equal(p.events.includes("commit"), false);
});

test("retained currentness loss after IO closes prevents COMMIT", async () => {
  let p;
  p = protocol({
    history: () => {
      p.acquired[0].current = false;
    },
  });
  assert.equal((await p.run()).kind, "unavailable");
  assert.equal(p.events.includes("commit"), false);
  assert.equal(p.acquired[0].releases, 1);
});

test("actual V2 acceptance keeps audit-before-history ordering and original subject", async () => {
  const p = protocol();
  const output = await p.run(accept());
  assert.equal(output.kind, "accepted");
  assert.deepEqual(output.record.binding.startup.subject, subject);
  assert.deepEqual(output.record.binding.selection, selection);
  assert.ok(p.events.indexOf("audit") < p.events.indexOf("append"));
  assert.ok(p.events.indexOf("append") < p.events.indexOf("advance"));
  assert.ok(p.events.indexOf("advance") < p.events.indexOf("commit"));
  assert.equal(p.audits[0].event.command.operationRef, "original-admission");
  assert.equal(
    p.acquired.every((lease) => lease.releases === 1),
    true,
  );
});

test("mandatory audit rejection cannot append history or commit", async () => {
  const p = protocol({
    audit: async () => {
      throw new Error("audit unavailable");
    },
  });
  assert.equal((await p.run(accept())).kind, "unavailable");
  assert.equal(p.events.includes("audit"), true);
  assert.equal(p.events.includes("append"), false);
  assert.equal(p.events.includes("commit"), false);
});

test("lost COMMIT acknowledgement preserves exact V2 recovery locator", async () => {
  const p = protocol({
    commit: async () => {
      throw new Error("acknowledgement lost");
    },
  });
  const output = await p.run(accept());
  assert.equal(output.kind, "recovery-required");
  assert.equal(output.operation.operationRef, "original-admission");
  assert.deepEqual(output.operation.subject, subject);
  assert.equal(
    p.acquired.every((lease) => lease.releases === 1),
    true,
  );
});

test("acknowledged COMMIT plus client cleanup failure keeps terminal lease cleanup and outward uncertainty", async () => {
  const p = protocol({
    release: () => {
      throw new Error("client cleanup failed");
    },
  });
  const output = await p.run(accept());
  assert.equal(output.kind, "recovery-required");
  assert.deepEqual(output.operation.subject, subject);
  assert.equal(p.events.includes("commit"), true);
  // finishTerminal would reject commit-unknown after ACK before this cleanup.
  assert.equal(
    p.acquired.every((lease) => lease.releases === 1),
    true,
  );
});

test("known COMMIT rejection never returns an accepted result", async () => {
  const p = protocol({ commit: () => result([], "ROLLBACK") });
  assert.equal((await p.run(accept())).kind, "unavailable");
  assert.equal(
    p.acquired.every((lease) => lease.releases === 1),
    true,
  );
});

test("the selected aggregate uses one V2 schema with original parent objects", () => {
  for (const table of [gatewayStartupHeads, gatewayStartupOperations]) {
    const metadata = getTableConfig(table);
    assert.equal(
      metadata.columns.some((column) => column.name === "subject_version"),
      true,
    );
    assert.equal(
      metadata.columns.some((column) => column.name === "subject_key"),
      true,
    );
    const parents = metadata.foreignKeys.map((fk) => fk.reference().foreignTable);
    assert.equal(parents.includes(installation), true);
    assert.equal(parents.includes(agents), true);
    if (table === gatewayStartupOperations) assert.equal(parents.includes(auditEvents), true);
  }
});
