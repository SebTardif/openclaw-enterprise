import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  GatewayStartupOwnerPhaseV1,
  canonicalGatewayStartupValueV1 as canonical,
  createGatewayStartupOwnerV2,
  createGatewayStartupSubmissionOwnerV2,
  gatewayStartupCommandDigestV1,
  gatewayStartupCommandDigestV2,
  parseGatewayStartupBindingV1,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV1,
  parseGatewayStartupCommandV2,
  parseGatewayStartupEventV1,
  parseGatewayStartupEventV2,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import {
  createPostgresGatewayStartupV1,
  createPostgresGatewayStartupV2,
} from "../../packages/occ/src/gateway-startup-v1/postgres.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { createGatewayStartupTablesV2 } from "../../packages/occ/src/state/postgres/gateway-startup-schema.ts";
import {
  occSchema,
  installation,
  auditEvents,
  agents,
} from "../../packages/occ/src/state/postgres-schema.ts";
import { binding as historicalBinding, deferred } from "../fixtures/gateway-startup-v1/values.mjs";

// Controlled accepting participants and a PostgreSQL-shaped query peer exercise
// actual owner/phase/backend code. This peer is not SQL execution or production
// admission, account, placement, physical settlement or provider evidence.
const copy = (v) => structuredClone(v);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (n) => `sha256:${String(n).repeat(64)}`;
const recordRef = (name) => ({ recordRef: name, recordVersion: 1 });
const selection = {
  manifestRef: uuid(1),
  manifestDigest: hash(1),
  admissionRef: uuid(2),
  admissionVersion: 1,
};
const subject = (n = 5) => ({
  kind: "agent-gateway",
  installationId: `ins_${uuid(3)}`,
  namespaceRef: `ns_${uuid(4)}`,
  agentRef: `agt_${uuid(n)}`,
});
const roles = Object.fromEntries(
  ["provider", "runtime", "identity", "containment", "storage"].map((name, i) => [
    name,
    { ref: uuid(20 + i), version: 1, contentDigest: hash(i + 1) },
  ]),
);
function selected(scope) {
  const { startup, createEffectRef, ...host } = historicalBinding();
  return {
    ...host,
    schemaVersion: 2,
    selection: copy(selection),
    profileRefs: copy(roles),
    admittedConfigurationDigest: hash(6),
    namespaceRef: scope.namespaceRef,
    agentRef: scope.agentRef,
  };
}
function accept(scope = subject(), operationRef = "accept-1", expectedHead = null) {
  return {
    schemaVersion: 2,
    subject: copy(scope),
    kind: "accept-startup",
    operationRef,
    expectedHead,
    selectedDefinition: copy(selection),
    predecessorDisposition: recordRef("physical-disposition"),
  };
}
const expected = (head) => ({
  version: head.version,
  startup: head.startup,
  recordVersion: head.recordVersion,
});
function submit(accepted, operationRef = "submit-1") {
  const b = accepted.record.binding;
  return {
    schemaVersion: 2,
    subject: b.startup.subject,
    kind: "submit-create",
    operationRef,
    startup: b.startup,
    expectedHead: expected(accepted.head),
    input: {
      binding: b,
      target: {
        clusterRef: "selected-cluster",
        namespace: { name: "physical-namespace", uid: "namespace-uid", resourceVersion: "7" },
        deploymentName: "selected-deployment",
      },
      launchPlan: recordRef("full-renderer-plan"),
    },
  };
}
const recipient = {
  recipient: recordRef("gateway-recipient"),
  process: recordRef("actual-process"),
  incarnationRef: "original-incarnation",
  observation: recordRef("current-observation"),
};
function consume(accepted, submitted, operationRef = "consume-1") {
  return {
    schemaVersion: 2,
    subject: accepted.record.binding.startup.subject,
    kind: "consume-startup",
    operationRef,
    startup: accepted.record.binding.startup,
    expectedHead: {
      version: submitted.event.afterHeadVersion,
      startup: submitted.event.startup,
      recordVersion: submitted.event.afterRecordVersion,
    },
    recipient: copy(recipient),
  };
}
function eventRow(e) {
  const v2 = e.schemaVersion === 2;
  const s = v2 ? e.command.subject : null;
  return {
    installation_id: v2 ? s.installationId : e.command.installationId,
    subject_version: v2 ? 2 : 1,
    subject_key: v2 ? `agent-v2:${s.agentRef}` : "installation-v1",
    namespace_ref: s?.namespaceRef ?? null,
    agent_ref: s?.agentRef ?? null,
    operation_ref: e.command.operationRef,
    operation_digest: e.command.operationDigest,
    canonical_command: e.canonicalCommand,
    kind: e.kind,
    startup_operation_ref: e.startup.operationRef,
    startup_operation_digest: e.startup.operationDigest,
    process_ref: e.startup.processRef,
    process_generation: e.startup.processGeneration,
    create_effect_ref: e.createEffectRef,
    before_head_version: e.beforeHeadVersion,
    after_head_version: e.afterHeadVersion,
    before_record_version: e.beforeRecordVersion,
    after_record_version: e.afterRecordVersion,
    previous_operation_ref: e.previousOperationRef,
    audit_event_id: e.auditEventId,
    record: copy(e),
  };
}
function peer() {
  let retained = { heads: new Map(), events: new Map() };
  let allocation = 0;
  const calls = [];
  const options = {
    terminal: "committed",
    beforeFinalize: undefined,
    query: undefined,
    predecessor: undefined,
    authority: undefined,
    allocate: undefined,
  };
  const key = (v) => `${v[0]}|${v[2]}`;
  const matches = (r, v) =>
    r &&
    r.installation_id === v[0] &&
    r.subject_version === v[1] &&
    r.subject_key === v[2] &&
    r.namespace_ref === v[3] &&
    r.agent_ref === v[4];
  const query = async (draft, statement, values = []) => {
    calls.push({ statement, values: copy(values) });
    if (options.query) await options.query(statement, values);
    if (statement.startsWith("SELECT") && statement.includes("gateway_startup_operations")) {
      const records = [...draft.events.values()].filter((r) => matches(r, values));
      const rows = statement.includes("AND startup_operation_ref=$6 AND kind=$7")
        ? records.filter((r) => r.startup_operation_ref === values[5] && r.kind === values[6])
        : records.filter((r) => r.operation_ref === values[5]);
      return { rows: copy(rows), rowCount: rows.length };
    }
    if (statement.startsWith("SELECT") && statement.includes("gateway_startup_heads")) {
      const r = draft.heads.get(key(values));
      return { rows: matches(r, values) ? [copy(r)] : [], rowCount: matches(r, values) ? 1 : 0 };
    }
    if (statement.startsWith("INSERT INTO occ.gateway_startup_heads")) {
      if (draft.heads.has(key(values))) return { rows: [], rowCount: 0 };
      draft.heads.set(key(values), {
        installation_id: values[0],
        subject_version: values[1],
        subject_key: values[2],
        namespace_ref: values[3],
        agent_ref: values[4],
        head_version: 0,
        process_generation: 0,
        latest_operation_ref: null,
        startup_operation_ref: null,
        record_version: 0,
        state: "empty",
      });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO occ.gateway_startup_operations")) {
      const e = JSON.parse(values.at(-1));
      if (draft.events.has(e.command.operationRef)) throw Error("global operation uniqueness");
      if (
        [...draft.events.values()].some(
          (r) =>
            r.audit_event_id === e.auditEventId ||
            (e.kind === "accept-startup" &&
              r.kind === "accept-startup" &&
              (r.process_ref === e.startup.processRef ||
                r.create_effect_ref === e.createEffectRef)),
        )
      )
        throw Error("global accepted identity uniqueness");
      draft.events.set(e.command.operationRef, eventRow(e));
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("UPDATE occ.gateway_startup_heads")) {
      const r = draft.heads.get(key(values));
      if (
        !matches(r, values) ||
        r.head_version !== values[11] ||
        r.process_generation !== values[12] ||
        r.latest_operation_ref !== values[13] ||
        r.startup_operation_ref !== values[14] ||
        r.record_version !== values[15] ||
        r.state !== values[16]
      )
        return { rows: [], rowCount: 0 };
      Object.assign(r, {
        head_version: values[5],
        process_generation: values[6],
        latest_operation_ref: values[7],
        startup_operation_ref: values[8],
        record_version: values[9],
        state: values[10],
      });
      return { rows: [{ head_version: r.head_version }], rowCount: 1 };
    }
    throw Error(`Unexpected controlled query ${statement}`);
  };
  const leases = [];
  const lease = (name) => {
    const state = { name, current: true, releases: 0 };
    leases.push(state);
    return {
      assertCurrent() {
        if (!state.current) throw Error(`${name} withdrawn`);
      },
      async release() {
        state.releases++;
      },
    };
  };
  const participants = {
    authority: {
      async consume(invocation, command, bounds, unit, io) {
        io.assertActive();
        if (options.authority) return options.authority(invocation, command, bounds, unit, io);
        return {
          ...lease("account"),
          attribution: {
            actorId: "controlled-actor",
            requestRef: bounds.requestRef,
            decisionRef: "controlled-decision",
          },
        };
      },
    },
    selection: {
      async resolveLocked(command, original, unit, io) {
        io.assertActive();
        return { ...lease("selection"), selected: selected(unit.subject) };
      },
    },
    process: {
      async requireDisposition(command, previous, unit, io) {
        io.assertActive();
        return {
          ...lease("physical"),
          predecessor: options.predecessor ?? {
            kind: previous ? "retired-agent" : "complete-initial",
            disposition: command.predecessorDisposition,
            previousStartup: previous?.binding.startup ?? null,
            processOwner: recordRef("physical-owner"),
            settlement: recordRef("joined-settlement"),
          },
        };
      },
      async requireCurrent(command, acceptance, unit, io) {
        io.assertActive();
        return lease("process");
      },
    },
    audit: {
      async append(event, attribution, unit, io) {
        io.assertActive();
        calls.push({ audit: event.command.operationRef });
      },
    },
    allocate(kind) {
      allocation++;
      return options.allocate?.(kind, allocation) ?? `${kind}-${allocation}`;
    },
  };
  const transaction = {
    async run(command, bounds, work) {
      const draft = copy(retained),
        lifetime = new RepositoryTransactionLifetime();
      const phase = new GatewayStartupOwnerPhaseV1(lifetime, (sql, args) =>
        query(draft, sql, args),
      );
      let terminal = "rolled-back",
        response = { kind: "unknown" },
        sent = false,
        ack = false;
      try {
        await work({
          subject: command.subject,
          phase,
          backend: createPostgresGatewayStartupV2(command.subject),
          policy: {},
        });
        await options.beforeFinalize?.(phase, leases);
        await phase.drainAccepted();
        await lifetime.finish();
        const completion = phase.finalize();
        if (completion.kind === "rollback")
          response = { kind: "rolled-back", response: completion.response };
        else {
          phase.markCommitDispatched();
          sent = true;
          terminal = options.terminal;
          if (terminal === "committed" || terminal === "commit-unknown") retained = draft;
          if (terminal === "committed") {
            phase.observeCommitAcknowledgement("COMMIT");
            ack = true;
            response = { kind: "committed", response: completion.provisional };
          } else if (terminal === "commit-rejected")
            response = { kind: "rolled-back", response: { kind: "unavailable" } };
        }
      } catch (e) {
        phase.poison(e);
        terminal = ack ? "committed" : sent ? "commit-unknown" : "rolled-back";
      } finally {
        await phase.drainAccepted();
        await lifetime.finish();
        try {
          await phase.finishTerminal(terminal);
        } catch {
          response = { kind: "unknown" };
        }
      }
      return response;
    },
  };
  const owner = createGatewayStartupOwnerV2({ transaction, participants });
  return {
    owner,
    options,
    participants,
    calls,
    leases,
    retained: () => retained,
    allocation: () => allocation,
    installLegacy(events) {
      for (const e of events) retained.events.set(e.command.operationRef, eventRow(e));
    },
    run(command) {
      return owner.execute(
        command,
        {},
        {
          requestRef: "request-fixture",
          deadline: "2099-01-01T00:00:00Z",
          signal: new AbortController().signal,
        },
      );
    },
  };
}
function legacy(scope = subject()) {
  const c = {
    schemaVersion: 1,
    kind: "accept-startup",
    operationRef: "legacy-accept",
    expectedHead: null,
    selectedDefinition: recordRef("legacy-selection"),
    predecessorDisposition: recordRef("legacy-physical"),
  };
  const startup = {
    installationId: scope.installationId,
    processRef: "legacy-process",
    processGeneration: 7,
    operationRef: c.operationRef,
    operationDigest: gatewayStartupCommandDigestV1(c),
  };
  const binding = {
    ...historicalBinding(),
    startup,
    namespaceRef: scope.namespaceRef,
    agentRef: scope.agentRef,
    selection: c.selectedDefinition,
  };
  const a = parseGatewayStartupEventV1({
    kind: c.kind,
    command: {
      installationId: scope.installationId,
      operationRef: c.operationRef,
      operationDigest: startup.operationDigest,
      startup: null,
    },
    canonicalCommand: canonical(c),
    beforeHeadVersion: 0,
    afterHeadVersion: 1,
    beforeRecordVersion: 0,
    afterRecordVersion: 1,
    previousOperationRef: null,
    startup,
    createEffectRef: binding.createEffectRef,
    acceptance: {
      binding,
      predecessor: {
        disposition: c.predecessorDisposition,
        previousStartup: null,
        processOwner: recordRef("legacy-owner"),
        settlement: recordRef("legacy-settlement"),
      },
      auditEventId: "legacy-audit",
    },
    submissionInput: null,
    recipient: null,
    withdrawalReason: null,
    auditEventId: "legacy-audit",
  });
  const w = {
    schemaVersion: 1,
    kind: "withdraw",
    operationRef: "legacy-withdraw",
    startup,
    expectedHead: { version: 1, startup, recordVersion: 1 },
    reason: "administrative",
  };
  const withdrawal = parseGatewayStartupEventV1({
    kind: w.kind,
    command: {
      installationId: scope.installationId,
      operationRef: w.operationRef,
      operationDigest: gatewayStartupCommandDigestV1(w),
      startup,
    },
    canonicalCommand: canonical(w),
    beforeHeadVersion: 1,
    afterHeadVersion: 2,
    beforeRecordVersion: 1,
    afterRecordVersion: 2,
    previousOperationRef: a.command.operationRef,
    startup,
    createEffectRef: binding.createEffectRef,
    acceptance: null,
    submissionInput: null,
    recipient: null,
    withdrawalReason: w.reason,
    auditEventId: "legacy-withdraw-audit",
  });
  return { acceptance: a, withdrawal };
}

test("missing V2 accepting owner refuses without a transaction", async () => {
  assert.deepEqual(
    await createGatewayStartupOwnerV2({}).execute(
      accept(),
      {},
      { requestRef: "r", deadline: "2099-01-01T00:00:00Z", signal: new AbortController().signal },
    ),
    { kind: "unavailable" },
  );
});
test("two Agents in one Installation have distinct generation-one heads and full original selections", async () => {
  const f = peer(),
    a = await f.run(accept()),
    b = await f.run(accept(subject(6), "accept-2"));
  assert.equal(a.kind, "accepted");
  assert.equal(b.kind, "accepted");
  assert.equal(a.record.binding.startup.processGeneration, 1);
  assert.equal(b.record.binding.startup.processGeneration, 1);
  assert.equal(a.record.binding.hostRuntimeGeneration, 19);
  assert.deepEqual(a.record.binding.selection, selection);
  assert.equal(f.retained().heads.size, 2);
  assert.notEqual(a.record.binding.createEffectRef, b.record.binding.createEffectRef);
  assert.equal(
    f.leases.every((l) => l.releases === 1),
    true,
  );
});
test("a changed Namespace cannot create another head for the same Agent", async () => {
  const f = peer();
  assert.equal((await f.run(accept())).kind, "accepted");
  const before = f.allocation();
  const other = { ...subject(), namespaceRef: `ns_${uuid(9)}` };
  assert.notEqual((await f.run(accept(other, "other-namespace"))).kind, "accepted");
  assert.equal(f.retained().heads.size, 1);
  assert.equal(f.allocation(), before);
});
test("submit and consume use separate once-only original commands, then exact current read", async () => {
  const f = peer(),
    a = await f.run(accept()),
    s = await f.run(submit(a));
  assert.equal(s.kind, "submitted");
  const command = consume(a, s),
    c = await f.run(command);
  assert.equal(c.kind, "consumed");
  const retry = await f.run(command);
  assert.equal(retry.kind, "recovery-required");
  const read = await f.run({
    schemaVersion: 2,
    subject: subject(),
    kind: "read-current",
    startup: a.record.binding.startup,
    expectedRecordVersion: 3,
    recipient,
  });
  assert.equal(read.kind, "current");
  assert.equal(read.record.claim.previousOperationRef, s.event.command.operationRef);
  assert.equal(f.retained().events.size, 3);
});
test("unknown commit retains exact operation for authorized readback without another allocation", async () => {
  const f = peer();
  f.options.terminal = "commit-unknown";
  const c = accept(),
    r = await f.run(c);
  assert.equal(r.kind, "recovery-required");
  assert.equal(r.operation.operationDigest, gatewayStartupCommandDigestV2(c));
  f.options.terminal = "committed";
  const count = f.allocation();
  const observed = await f.run({
    schemaVersion: 2,
    subject: subject(),
    kind: "read-operation",
    operation: r.operation,
  });
  assert.equal(observed.kind, "observed");
  assert.equal(f.allocation(), count);
  assert.equal(f.retained().events.size, 1);
});
test("withdrawn subject advances its own generation under an exact retired-agent disposition", async () => {
  const f = peer(),
    a = await f.run(accept());
  const w = await f.run({
    schemaVersion: 2,
    subject: subject(),
    kind: "withdraw",
    operationRef: "withdraw-1",
    startup: a.record.binding.startup,
    expectedHead: expected(a.head),
    reason: "administrative",
  });
  assert.equal(w.kind, "withdrawn");
  const next = await f.run(accept(subject(), "accept-next", expected(w.head)));
  assert.equal(next.kind, "accepted");
  assert.equal(next.record.binding.startup.processGeneration, 2);
  assert.equal(next.record.predecessor.kind, "retired-agent");
});
test("V1 physical predecessor bridge is distinct from the empty Agent event chain", async () => {
  const f = peer(),
    old = legacy();
  f.installLegacy([old.acceptance, old.withdrawal]);
  f.options.predecessor = {
    kind: "retired-installation",
    disposition: recordRef("physical-disposition"),
    previousStartup: old.acceptance.startup,
    historicalWithdrawal: old.withdrawal.command,
    processOwner: recordRef("physical-owner"),
    settlement: recordRef("physical-closure"),
  };
  const a = await f.run(accept());
  assert.equal(a.kind, "accepted");
  assert.equal(a.record.binding.startup.processGeneration, 1);
  const event = f.retained().events.get("accept-1").record;
  assert.equal(event.previousOperationRef, null);
  assert.equal(event.beforeHeadVersion, 0);
  assert.equal(a.record.predecessor.previousStartup.processGeneration, 7);
});
for (const change of ["missing-withdrawal", "foreign-agent", "unknown-disposition"])
  test(`legacy bridge refuses ${change} before allocation`, async () => {
    const f = peer(),
      old = legacy(change === "foreign-agent" ? subject(6) : subject());
    f.installLegacy(
      change === "missing-withdrawal" ? [old.acceptance] : [old.acceptance, old.withdrawal],
    );
    f.options.predecessor = {
      kind: change === "unknown-disposition" ? "unknown" : "retired-installation",
      disposition: recordRef("physical-disposition"),
      previousStartup: old.acceptance.startup,
      historicalWithdrawal: old.withdrawal.command,
      processOwner: recordRef("physical-owner"),
      settlement: recordRef("physical-closure"),
    };
    assert.notEqual((await f.run(accept())).kind, "accepted");
    assert.equal(f.allocation(), 0);
  });
test("currentness loss at the actual final owner fence rolls back and joins all leases", async () => {
  const f = peer();
  f.options.beforeFinalize = (_, leases) => {
    leases.find((l) => l.name === "selection").current = false;
  };
  assert.notEqual((await f.run(accept())).kind, "accepted");
  assert.equal(f.retained().events.size, 0);
  assert.equal(
    f.leases.every((l) => l.releases === 1),
    true,
  );
});
test("caught and unawaited original query failures still poison the complete phase", async () => {
  for (const caught of [false, true]) {
    const f = peer();
    f.options.query = async (sql) => {
      if (sql === "controlled-failing-query") throw Error("query failed");
    };
    f.options.authority = async (invocation, command, bounds, unit, io) => {
      const p = io.query("controlled-failing-query");
      if (caught) await p.catch(() => {});
      else void p.catch(() => {});
      return {
        assertCurrent() {},
        async release() {},
        attribution: { actorId: "actor", requestRef: bounds.requestRef, decisionRef: "decision" },
      };
    };
    assert.notEqual((await f.run(accept())).kind, "accepted");
    assert.equal(f.retained().events.size, 0);
  }
});
for (const mutate of [
  (c) => {
    c.subject.agentRef = "foreign";
  },
  (c) => {
    c.expectedHead.startup.subject.namespaceRef = "foreign";
  },
  (c) => {
    c.input.binding.selection = { recordRef: "alias", recordVersion: 1 };
  },
  (c) => {
    c.input.binding.profileRefs.runtime = c.input.binding.profileRefs.provider;
  },
  (c) => {
    c.input.binding.admittedConfigurationDigest = "not-a-digest";
  },
  (c) => {
    c.input.binding.extra = true;
  },
])
  test(`closed V2 create correspondence rejects mutation ${mutate.toString()}`, async () => {
    const f = peer(),
      a = await f.run(accept()),
      c = copy(submit(a));
    mutate(c);
    assert.throws(() => parseGatewayStartupCommandV2(c));
  });
test("V1 and V2 parsers preserve closed version separation and original legacy domain", () => {
  const old = legacy(),
    c = JSON.parse(old.acceptance.canonicalCommand);
  assert.deepEqual(parseGatewayStartupCommandV1(c), c);
  assert.throws(() => parseGatewayStartupCommandV2(c));
  assert.throws(() => parseGatewayStartupCommandV1(accept()));
  assert.throws(() => parseGatewayStartupBindingV2(old.acceptance.acceptance.binding));
  assert.equal(
    parseGatewayStartupBindingV1(old.acceptance.acceptance.binding).startup.processGeneration,
    7,
  );
  assert.notEqual(gatewayStartupCommandDigestV1(c), gatewayStartupCommandDigestV2(accept()));
});
test("legacy backend explicitly filters its partition and rejects foreign physical row scope", async () => {
  const old = legacy(),
    row = eventRow(old.acceptance),
    queries = [];
  const io = {
    async query(sql, args) {
      queries.push({ sql, args });
      return { rows: [copy(row)], rowCount: 1 };
    },
  };
  const backend = createPostgresGatewayStartupV1(subject().installationId);
  assert.equal((await backend.findOperation(io, "legacy-accept")).kind, "accept-startup");
  assert.deepEqual(queries[0].args.slice(0, 5), [
    subject().installationId,
    1,
    "installation-v1",
    null,
    null,
  ]);
  assert.match(queries[0].sql, /subject_key=\$3/);
  row.subject_version = 2;
  row.subject_key = `agent-v2:${subject().agentRef}`;
  await assert.rejects(backend.findOperation(io, "legacy-accept"));
});
test("V2 table factory uses the original Agent membership columns and composite head key", () => {
  const tables = createGatewayStartupTablesV2(occSchema, { installation, auditEvents, agents });
  const values = Object.values(tables),
    heads = values.find((t) => getTableConfig(t).name === "gateway_startup_heads"),
    operations = values.find((t) => getTableConfig(t).name === "gateway_startup_operations");
  for (const table of [heads, operations]) {
    const config = getTableConfig(table),
      fk = config.foreignKeys.find((f) => f.reference().foreignColumns.includes(agents.id));
    assert.ok(fk);
    assert.deepEqual(fk.reference().foreignColumns, [agents.namespaceId, agents.id]);
  }
  assert.deepEqual(
    getTableConfig(heads).primaryKeys[0].columns.map((c) => c.name),
    ["installation_id", "subject_key"],
  );
  assert.equal(
    getTableConfig(operations).columns.find((c) => c.name === "operation_ref").primary,
    true,
  );
});

// The controlled process-call owner retains every registered drain until its
// own terminal settlement; a database transaction ending does not close it.
function submissionPeer(f, command) {
  const drains = [],
    call = Object.freeze({}),
    controls = { assertion: () => undefined, registration: undefined };
  const owner = createGatewayStartupSubmissionOwnerV2(f.owner, {
    async resolve(input, actualCall) {
      if (actualCall !== call || canonical(input) !== canonical(command.input)) return undefined;
      return {
        command,
        invocation: {},
        bounds: {
          requestRef: "submission-call",
          deadline: "2099-01-01T00:00:00Z",
          signal: new AbortController().signal,
        },
        assertCurrent() {
          return controls.assertion();
        },
        registerDrain(drain) {
          drains.push(drain);
          return controls.registration;
        },
      };
    },
  });
  return {
    owner,
    call,
    controls,
    drains,
    close: () => Promise.all(drains.map((drain) => drain())),
  };
}

test("V2 submission ticket requires a newly acknowledged original submission and is consumed once", async () => {
  const f = peer(),
    a = await f.run(accept()),
    command = submit(a),
    p = submissionPeer(f, command);
  const result = await p.owner.claimOriginal(command.input, p.call);
  assert.equal(result.kind, "claimed");
  assert.equal(p.drains.length, 1);
  assert.equal(p.owner.consumeSubmission(result.submission, command.input, p.call), undefined);
  assert.throws(() => p.owner.consumeSubmission(result.submission, command.input, p.call));
  const repeated = await p.owner.claimOriginal(command.input, p.call);
  assert.equal(repeated.kind, "unknown");
  assert.equal(f.retained().events.size, 2);
  await p.close();
});
for (const mismatch of ["call", "input", "closed"])
  test(`V2 submission ticket refuses ${mismatch} and cannot be recovered for dispatch`, async () => {
    const f = peer(),
      a = await f.run(accept()),
      command = submit(a),
      p = submissionPeer(f, command);
    const result = await p.owner.claimOriginal(command.input, p.call);
    assert.equal(result.kind, "claimed");
    const input = copy(command.input);
    if (mismatch === "input") input.target.deploymentName = "other";
    if (mismatch === "closed") await p.close();
    assert.throws(() =>
      p.owner.consumeSubmission(result.submission, input, mismatch === "call" ? {} : p.call),
    );
    assert.throws(() => p.owner.consumeSubmission(result.submission, command.input, p.call));
    await p.close();
  });
test("V2 unknown submission commit and authorized historical readback never mint a new ticket", async () => {
  const f = peer(),
    a = await f.run(accept()),
    command = submit(a),
    p = submissionPeer(f, command);
  f.options.terminal = "commit-unknown";
  assert.equal((await p.owner.claimOriginal(command.input, p.call)).kind, "unknown");
  f.options.terminal = "committed";
  assert.equal((await p.owner.claimOriginal(command.input, p.call)).kind, "unknown");
  assert.equal(f.retained().events.size, 2);
  await p.close();
});
test("V2 submission default source remains unavailable", async () => {
  const f = peer(),
    a = await f.run(accept()),
    c = submit(a);
  assert.equal(
    (await createGatewayStartupSubmissionOwnerV2(f.owner).claimOriginal(c.input, {})).kind,
    "unavailable",
  );
  assert.equal(f.retained().events.size, 1);
});
test("deferred invalid acquisition assertion is joined before the claim returns", async () => {
  const f = peer(),
    a = await f.run(accept()),
    command = submit(a),
    p = submissionPeer(f, command),
    wait = deferred();
  p.controls.assertion = () => wait.promise;
  let done = false;
  const pending = p.owner.claimOriginal(command.input, p.call).then((r) => {
    done = true;
    return r;
  });
  await new Promise(setImmediate);
  assert.equal(done, false);
  assert.equal(p.drains.length, 1);
  assert.equal(f.retained().events.size, 1);
  wait.reject(undefined);
  assert.equal((await pending).kind, "unknown");
  await p.close();
});
test("deferred invalid dispatch assertion remains with the original call owner until it settles", async () => {
  const f = peer(),
    a = await f.run(accept()),
    command = submit(a),
    p = submissionPeer(f, command),
    wait = deferred();
  const result = await p.owner.claimOriginal(command.input, p.call);
  assert.equal(result.kind, "claimed");
  p.controls.assertion = () => wait.promise;
  assert.throws(() => p.owner.consumeSubmission(result.submission, command.input, p.call));
  let released = false;
  const closing = p.close().then(() => {
    released = true;
  });
  await new Promise(setImmediate);
  assert.equal(released, false);
  wait.resolve();
  await closing;
  assert.equal(released, true);
  assert.throws(() => p.owner.consumeSubmission(result.submission, command.input, p.call));
});
test("asynchronous drain registration is joined and refused before any authority command", async () => {
  const f = peer(),
    a = await f.run(accept()),
    command = submit(a),
    p = submissionPeer(f, command),
    wait = deferred();
  p.controls.registration = wait.promise;
  let assertions = 0;
  p.controls.assertion = () => {
    assertions++;
  };
  let done = false;
  const result = p.owner.claimOriginal(command.input, p.call).then((r) => {
    done = true;
    return r;
  });
  await new Promise(setImmediate);
  assert.equal(done, false);
  assert.equal(assertions, 0);
  wait.resolve();
  assert.equal((await result).kind, "unknown");
  assert.equal(f.retained().events.size, 1);
  await p.close();
});
for (const identity of ["operation", "process", "create-effect", "audit"])
  test(`controlled global ${identity} collision cannot be accepted under a second Agent`, async () => {
    const f = peer(),
      a = await f.run(accept());
    assert.equal(a.kind, "accepted");
    f.options.allocate = (kind, n) =>
      kind === identity
        ? kind === "process"
          ? a.record.binding.startup.processRef
          : kind === "create-effect"
            ? a.record.binding.createEffectRef
            : a.record.auditEventId
        : `${kind}-${n}`;
    const b = await f.run(accept(subject(6), identity === "operation" ? "accept-1" : "accept-2"));
    assert.notEqual(b.kind, "accepted");
    assert.equal(f.retained().heads.size, 1);
    assert.equal(f.retained().events.size, 1);
  });
