import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createPostgresRevisionCredentialReaderV1 } from "../../packages/occ/src/state/postgres/credential-record.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { exampleCredentialWorkloadSelectionV1 as example } from "../fixtures/credential-workload-selection-v1/producer.ts";
import {
  CredentialWorkloadSelectionSchemaV1,
  decodeCredentialWorkloadSelectionV1,
} from "../../packages/contracts/src/credential-workload-selection-v1.ts";
import {
  revisionResources,
  revisionRecord,
  seedRevisionOwner,
} from "./revision-repository.contract.mjs";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  createGatewayStartupOwnerV1,
  createGatewayStartupOwnerV2,
  GatewayStartupOwnerPhaseV1,
} from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { binding as historicalBinding } from "../fixtures/gateway-startup-v1/values.mjs";
import { agentRevisions } from "../../packages/occ/src/state/postgres-schema.ts";
const { getTableConfig, PgDialect } = createRequire(
  new URL("../../packages/occ/package.json", import.meta.url),
)("drizzle-orm/pg-core");
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";
const privateKey = "credential_workload_selection";
function recordFor(revision, installationId) {
  const record = example();
  const scope = { installationId, namespaceId: revision.namespaceId, agentId: revision.agentId };
  function replace(value) {
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "scope")) value.scope = { ...scope };
      for (const child of Object.values(value)) replace(child);
    }
  }
  replace(record);
  record.revisionId = revision.id;
  assert.equal(decodeCredentialWorkloadSelectionV1(record).kind, "valid");
  return record;
}
const storedMemory = (state) => [...state.snapshot.revisions.values()].flat();
async function memory() {
  const state = new InMemoryPlatformState();
  const resources = await seedRevisionOwner(state, revisionResources());
  const revision = revisionRecord(resources);
  const installation = await state.read((view) => view.installations.getInstallation());
  return { state, resources, revision, record: recordFor(revision, installation.id) };
}
test("memory stores the complete first record while every public projection omits it", async () => {
  const { state, resources, revision, record } = await memory();
  const expected = structuredClone(record);
  let pending, escaped;
  await state.transact(async (unit) => {
    escaped = unit.revisions;
    pending = unit.revisions.createRevision(revision, record);
    record.materialSelection.recordVersion = 9;
  });
  assert.deepEqual(await pending, revision);
  assert.deepEqual(storedMemory(state)[0][privateKey], expected);
  assert.ok(Object.isFrozen(storedMemory(state)[0][privateKey].model));
  await state.transact(async (unit) => {
    assert.deepEqual(
      await unit.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
      revision,
    );
    await unit.revisions.createRevision(revisionRecord(resources, 2));
  });
  assert.deepEqual(
    storedMemory(state)[0][privateKey],
    expected,
    "original snapshot clone must retain the private member",
  );
  await state.read(async (view) => {
    for (const row of await view.revisions.listRevisions(revision.namespaceId, revision.agentId))
      assert.equal(Object.hasOwn(row, privateKey), false);
  });
  await assert.rejects(escaped.createRevision(revision, expected), ScopeViolationError);
});
test("memory rollback and duplicate identity cannot fill or replace the original record", async () => {
  const { state, revision, record } = await memory();
  const failure = new Error("abort after private insertion");
  await assert.rejects(
    state.transact(async (unit) => {
      await unit.revisions.createRevision(revision, record);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(storedMemory(state), []);
  await state.transact((unit) => unit.revisions.createRevision(revision));
  await assert.rejects(state.transact((unit) => unit.revisions.createRevision(revision, record)));
  assert.equal(Object.hasOwn(storedMemory(state)[0], privateKey), false);
});
for (const field of [
  "installationId",
  "namespaceId",
  "agentId",
  "revisionId",
  "accessor",
  "unknown-field",
]) {
  test(`memory rejects ${field} before publishing a private revision`, async () => {
    const { state, revision, record } = await memory();
    if (field === "accessor")
      Object.defineProperty(record, "materialSelection", {
        get() {
          assert.fail("getter executed");
        },
      });
    else if (field === "unknown-field") record.secretMaterial = "not permitted";
    else if (field === "revisionId") record.revisionId = `rev_00000000-0000-4000-8000-000000000999`;
    else
      record.scope[field] =
        `${field === "installationId" ? "ins" : field === "namespaceId" ? "ns" : "agt"}_00000000-0000-4000-8000-000000000999`;
    await assert.rejects(
      state.transact((unit) => unit.revisions.createRevision(revision, record)),
      ScopeViolationError,
    );
    assert.deepEqual(storedMemory(state), []);
  });
}

// Original transaction owner and canonical mapper, with a controlled row peer.
// This exercises query/serialization/lifetime, not PostgreSQL execution or locks.
function postgresRevision(options = {}) {
  const resources = revisionResources();
  const { secretBindings, ...revision } = revisionRecord(resources);
  const installation = {
    id: example().scope.installationId,
    name: "Installation",
    created_at: revision.createdAt,
  };
  const calls = [],
    inserted = [];
  let rows = [];
  const response = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  const client = {
    on() {},
    removeListener() {},
    release() {},
    async query(statement, values = []) {
      calls.push(statement);
      if (statement === "COMMIT" || statement === "ROLLBACK") return response([], statement);
      if (statement.startsWith("BEGIN")) return response();
      if (statement.includes("FROM occ.installation")) {
        await options.installation?.();
        return response([installation]);
      }
      if (statement.includes("FROM occ.agents AS a"))
        return response([
          {
            id: revision.agentId,
            namespace_id: revision.namespaceId,
            name: "agent",
            configuration_id: revision.configurationId,
            execution_mode: resources.agent.executionMode,
            provider_id: revision.providerId,
            service_principal_id: revision.servicePrincipalId,
            service_account_id: resources.account.id,
            active_revision_id: null,
            created_at: revision.createdAt,
          },
        ]);
      if (statement.startsWith("INSERT INTO occ.agent_revisions")) {
        await options.insert?.();
        inserted.push(structuredClone(values));
        rows = [
          {
            id: values[0],
            namespace_id: values[1],
            agent_id: values[2],
            revision_number: values[3],
            provider_id: values[4],
            admitted_spec: JSON.parse(values[5]),
            admitted_at: values[6],
            service_principal_id: revision.servicePrincipalId,
          },
        ];
        return response([], "INSERT");
      }
      if (statement.includes("FROM occ.agent_revisions AS r")) return response(rows);
      throw new Error(`Unexpected revision query: ${statement}`);
    },
  };
  const state = new PostgresPlatformState({
    async connect() {
      return client;
    },
    async end() {},
  });
  return { state, revision, record: recordFor(revision, installation.id), calls, inserted };
}
test("PostgreSQL initial INSERT is captured before waits and actual public mapper omits private data", async () => {
  const wait = deferred();
  const p = postgresRevision({ installation: () => wait.promise });
  const expected = structuredClone(p.record),
    original = structuredClone(p.revision);
  let escaped;
  const pending = p.state.transact((unit) => {
    escaped = unit.revisions;
    return unit.revisions.createRevision(p.revision, p.record);
  });
  await new Promise(setImmediate);
  p.record.materialSelection.recordVersion = 99;
  p.revision.configuration.models.providers.openai.changed = true;
  wait.resolve();
  assert.deepEqual(await pending, original);
  assert.equal(p.inserted.length, 1);
  assert.deepEqual(JSON.parse(p.inserted[0][5])[privateKey], expected);
  assert.deepEqual(
    await p.state.read((view) =>
      view.revisions.findRevision(original.namespaceId, original.agentId, original.id),
    ),
    original,
  );
  assert.deepEqual(
    await p.state.read((view) =>
      view.revisions.listRevisions(original.namespaceId, original.agentId),
    ),
    [original],
  );
  await assert.rejects(escaped.createRevision(original, expected), ScopeViolationError);
  assert.equal(
    p.calls.some((sql) => sql.startsWith("UPDATE occ.agent_revisions")),
    false,
  );
});
test("PostgreSQL record failure precedes INSERT and original outer owner rolls back", async () => {
  const p = postgresRevision();
  p.record.materialSelection = null;
  await assert.rejects(
    p.state.transact((unit) => unit.revisions.createRevision(p.revision, p.record)),
    ScopeViolationError,
  );
  assert.equal(p.inserted.length, 0);
  assert.ok(p.calls.includes("ROLLBACK"));
  assert.equal(p.calls.includes("COMMIT"), false);
});

// Controlled integration peer retained from the original Gateway owner tests.
function deriveControlledProfile() {
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const accounting = envelope();
  for (const component of ["gateway", "harness"])
    accounting.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: ref(`${name}-environment`),
    runtimeClass: "selected-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: [
      {
        name: `${name}-state`,
        path: `/state/${name}`,
        store: ref(`${name}-store`),
        access: "read-write",
      },
    ],
  });
  const content = {
    schemaVersion: 2,
    target: {
      component: "gateway-harness-pair",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      placement: "dedicated",
      fallback: "none",
      subject: "installation-namespace-agent",
    },
    profileRefs: workloadProfileManifestFixture().profileRefs,
    artifactSet: { gateway: image("gateway"), harness: image("harness") },
    launchConfiguration: {
      gateway: process("gateway"),
      harness: process("harness"),
      modules: ["identity", "channel", "harness", "persistence"].map((kind) => ({
        id: kind,
        kind,
        definition: ref(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: ref("cluster"), namespaceAllocation: ref("allocation") },
      runtime: { implementation: ref("runsc"), handler: "selected-runsc", platform: "systrap" },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope: accounting } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: ref("materials"),
        pathCustody: ref("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: ref("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: ref("identity"),
      modelMediator: ref("mediator"),
      repositoryIssuer: ref("issuer"),
      harnessTransport: ref("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: ref(id),
      })),
    },
  };
  const derived = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(JSON.stringify(content)),
  );
  return derived;
}
const controlledProfile = deriveControlledProfile();
function credentialExample() {
  const record = example();
  record.association.selection.manifestDigest = controlledProfile.digests.manifestDigest;
  for (const [role, contentDigest] of Object.entries(controlledProfile.roleDigests))
    record.association.profileRefs[role].contentDigest = contentDigest;
  return record;
}
function completeHeld(r) {
  let active = true;
  const use = Object.freeze({
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: r.installationId,
    namespaceId: r.namespaceId,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...r.selection,
    profileRefs: credentialExample().association.profileRefs,
    admittedConfigurationDigest: credentialExample().association.admittedConfigurationDigest,
  });
  return Object.freeze({
    request: Object.freeze(r),
    use,
    manifest: controlledProfile.content,
    digests: controlledProfile.digests,
    assertCurrent() {
      assert.ok(active);
      return undefined;
    },
    async release() {
      active = false;
    },
  });
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subject = {
  kind: "agent-gateway",
  installationId: `ins_${uuid(1)}`,
  namespaceRef: `ns_${uuid(2)}`,
  agentRef: `agt_${uuid(3)}`,
};
const selection = credentialExample().association.selection;
const roles = credentialExample().association.profileRefs;
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
      if (statement.includes("AS credential_record")) {
        events.push("credential-read");
        if (options.credentialRead) return options.credentialRead();
        return result([credentialRow()]);
      }
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
      if (statement.startsWith("INSERT INTO occ.audit_events")) {
        // Observe the canonical State audit on the original controlled client.
        // This supplies only a database response, never startup acceptance.
        events.push("audit");
        audits.push({
          actorId: parameters[3],
          action: parameters[4],
          namespaceId: parameters[5],
          resourceKind: parameters[6],
          resourceId: parameters[7],
          outcome: parameters[8],
          details: JSON.parse(parameters[9]),
        });
        if (options.audit) await options.audit();
        return result([], "INSERT");
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
      async resolveLocked(_command, _original, unit, io, reader) {
        if (options.resolve)
          return options.resolve({
            command: _command,
            original: _original,
            unit,
            io,
            reader,
            lease,
          });
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

function request() {
  return {
    schemaVersion: 2,
    ...credentialExample().scope,
    revisionId: credentialExample().revisionId,
    configurationRef: `cfg_${uuid(50)}`,
    configurationVersion: 1,
    selection: credentialExample().association.selection,
  };
}
function credentialRow() {
  const r = request();
  return {
    installation_id: r.installationId,
    namespace_id: r.namespaceId,
    agent_id: r.agentId,
    revision_id: r.revisionId,
    configuration_id: r.configurationRef,
    configuration_generation: String(r.configurationVersion),
    credential_record: credentialExample(),
  };
}
function selectionLease(lease, unit) {
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
}
function assertAcceptanceAudit(p) {
  assert.equal(p.audits.length, 1);
  const { details, ...audit } = p.audits[0];
  assert.deepEqual(audit, {
    actorId: "controlled-actor",
    action: "gateway-startup.accept-startup",
    namespaceId: subject.namespaceRef,
    resourceKind: "agent",
    resourceId: subject.agentRef,
    outcome: "success",
  });
  assert.equal(details.command.operationRef, "original-admission");
  assert.ok(p.events.indexOf("audit") < p.events.indexOf("append"));
  assert.ok(p.events.indexOf("append") < p.events.indexOf("commit"));
}
test("actual private selection reader uses one original operation and expires before later work", async () => {
  let escaped;
  const p = protocol({
    async resolve({ unit, io, reader, lease }) {
      const r = request(),
        held = completeHeld(r);
      escaped = () => reader.readLocked(r, held, unit, io);
      assert.deepEqual(await escaped(), credentialExample());
      return selectionLease(lease, unit);
    },
  });
  assert.equal((await p.run(accept())).kind, "accepted");
  assertAcceptanceAudit(p);
  const read = p.calls.find((call) => call.statement.includes("AS credential_record"));
  assert.deepEqual(read.parameters, [
    subject.installationId,
    subject.namespaceRef,
    subject.agentRef,
    example().revisionId,
  ]);
  assert.equal(p.connects(), 1);
  assert.equal(p.acquired.find((lease) => lease.name === "selection").releases, 1);
  const queryCount = p.calls.length;
  await assert.rejects(escaped(), ScopeViolationError);
  assert.equal(p.calls.length, queryCount);
});
for (const mismatch of [
  "unit",
  "io",
  "request",
  "scope",
  "row-owner",
  "row-configuration",
  "missing",
  "invalid",
]) {
  test(`private credential reader rejects ${mismatch} and poisons a caught failure`, async () => {
    const p = protocol({
      credentialRead() {
        const row = credentialRow();
        if (mismatch === "missing") return result();
        if (mismatch === "row-owner") row.agent_id = "foreign";
        if (mismatch === "row-configuration") row.configuration_generation = "2";
        if (mismatch === "invalid") row.credential_record = { schemaVersion: 1 };
        return result([row]);
      },
      async resolve({ unit, io, reader, lease }) {
        const r = request();
        if (mismatch === "scope") r.namespaceId = `ns_${uuid(999)}`;
        const held = completeHeld(r);
        await assert.rejects(
          reader.readLocked(
            mismatch === "request" ? { ...r } : r,
            held,
            mismatch === "unit" ? { ...unit } : unit,
            mismatch === "io" ? { ...io } : io,
          ),
        );
        return selectionLease(lease, unit);
      },
    });
    assert.equal((await p.run(accept())).kind, "unavailable");
    assert.equal(p.events.includes("commit"), false);
    assert.equal(p.events.includes("advance"), false);
    assert.equal(p.acquired.find((entry) => entry.name === "selection").releases, 1);
  });
}
test("ignored complete read is joined, known selection cleanup retained, late invalid data prevents COMMIT", async () => {
  const wait = deferred(),
    entered = deferred();
  let ignored;
  const p = protocol({
    async credentialRead() {
      entered.resolve();
      await wait.promise;
      return result([{ ...credentialRow(), credential_record: null }]);
    },
    async resolve({ unit, io, reader, lease }) {
      const r = request();
      ignored = reader.readLocked(r, completeHeld(r), unit, io);
      return selectionLease(lease, unit);
    },
  });
  const running = p.run(accept());
  await entered.promise;
  assert.equal(p.events.includes("commit"), false);
  assert.equal(p.acquired.find((entry) => entry.name === "selection").releases, 0);
  wait.resolve();
  assert.equal((await running).kind, "unavailable");
  await assert.rejects(ignored);
  assert.equal(p.acquired.find((entry) => entry.name === "selection").releases, 1);
  assert.equal(p.events.includes("advance"), false);
});
test("unbound reader context remains a denial, never a structural positive enrollment", async () => {
  const failure = new Error("no original enrollment");
  let queries = 0,
    poison;
  const reader = createPostgresRevisionCredentialReaderV1({
    scope: example().scope,
    query: {
      async query() {
        queries++;
      },
    },
    assertEnrolled() {
      throw failure;
    },
    poison(error) {
      poison = error;
    },
  });
  const r = request();
  await assert.rejects(reader.readLocked(r, { request: r }, {}, {}), (error) => error === failure);
  assert.equal(queries, 0);
  assert.equal(poison, failure);
});
test("conditional SQL shape derives from the original closed schema and preserves old admission predicates", () => {
  const sql = readFileSync(
    new URL("../../migrations/0033_revision_credential_selection.sql", import.meta.url),
    "utf8",
  );
  const embedded = JSON.parse(sql.split("$definition$")[1]);
  const original = JSON.parse(JSON.stringify(CredentialWorkloadSelectionSchemaV1));
  let removed = 0;
  function providerPatterns(value) {
    if (!value || typeof value !== "object") return;
    if (value.properties?.providerId?.pattern) {
      delete value.properties.providerId.pattern;
      removed++;
    }
    for (const child of Object.values(value)) providerPatterns(child);
  }
  providerPatterns(original);
  assert.equal(removed, 4);
  assert.deepEqual(embedded, original);
  const previous = readFileSync(
    new URL("../../migrations/0013_secret_state.sql", import.meta.url),
    "utf8",
  );
  const marker =
    "ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (";
  const extract = (text) =>
    text.slice(text.indexOf(marker)).split("--> statement-breakpoint")[0].trim();
  assert.equal(extract(sql).replace(" - 'credential_workload_selection'", ""), extract(previous));
  const table = getTableConfig(agentRevisions);
  const checks = table.checks.filter(
    (check) => check.name === "agent_revisions_credential_selection",
  );
  assert.equal(checks.length, 1);
  const predicate = new PgDialect().sqlToQuery(checks[0].value).sql;
  assert.match(predicate, /NOT .*credential_workload_selection/s);
  assert.match(predicate, /occ\.revision_credential_selection_valid_v1/);
  assert.equal(/CREATE\s+TABLE|UPDATE\s+occ\.|CREATE\s+ROLE|GRANT\s+/i.test(sql), false);
  // Actual SQL validation/concurrency remains a separately authorized PG check.
});

test("actual admitted selector lease feeds the exact central reader on the same unit", async () => {
  let activeHeld;
  const p = protocol({
    async resolve({ unit, io, reader, lease }) {
      const r = request(),
        controlled = completeHeld(r);
      const admission = {
        schemaVersion: 2,
        state: "admitted",
        use: controlled.use,
        canonicalManifest: new TextDecoder().decode(controlledProfile.canonicalBytes),
        revision: {
          id: r.revisionId,
          agentId: r.agentId,
          namespaceId: r.namespaceId,
          workloadProfileUse: controlled.use,
          configurationRef: r.configurationRef,
          configurationVersion: r.configurationVersion,
        },
        configuration: {
          ref: r.configurationRef,
          version: r.configurationVersion,
          admittedConfigurationDigest: controlled.use.admittedConfigurationDigest,
        },
      };
      const selector = createAdmittedWorkloadProfileSelectorV2(
        {
          async enroll(actual, originalUnit, originalIO) {
            assert.equal(originalUnit, unit);
            assert.equal(originalIO, io);
            assert.equal(actual.revisionId, r.revisionId);
            return {
              assertCurrent: () => undefined,
              async release() {},
              async lockNamespace() {
                return { namespaceId: r.namespaceId };
              },
              async lockAgent() {
                return { namespaceId: r.namespaceId, agentId: r.agentId };
              },
              async readAdmission() {
                return admission;
              },
            };
          },
        },
        {
          async acquire(_request, _manifest, _use, originalUnit, originalIO) {
            assert.equal(originalUnit, unit);
            assert.equal(originalIO, io);
            return { assertCurrent: () => undefined, async release() {} };
          },
        },
      );
      activeHeld = await selector.resolveLocked(r, unit, io);
      assert.equal(Object.getPrototypeOf(activeHeld.request.selection), null);
      assert.deepEqual(
        await reader.readLocked(activeHeld.request, activeHeld, unit, io),
        credentialExample(),
      );
      const selected = selectionLease(lease, unit);
      return {
        ...selected,
        async release() {
          await selected.release();
          await activeHeld.release();
        },
      };
    },
  });
  assert.equal((await p.run(accept())).kind, "accepted");
  assertAcceptanceAudit(p);
  assert.throws(() => activeHeld.assertCurrent());
  assert.equal(p.connects(), 1);
});
