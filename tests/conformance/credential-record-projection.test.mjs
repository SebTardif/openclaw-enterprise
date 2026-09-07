import assert from "node:assert/strict";
import test from "node:test";
import {
  CredentialWorkloadRecordError,
  createCredentialWorkloadSelectionResolverV2 as create,
  projectCredentialWorkloadSelectionV1 as project,
} from "../../packages/occ/src/workload-profiles/credential-record.ts";
import { GatewayStartupOwnerPhaseV1 } from "../../packages/occ/src/gateway-startup-v1/owner.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { exampleCredentialWorkloadSelectionV1 as make } from "../fixtures/credential-workload-selection-v1/producer.ts";
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import { envelope } from "../fixtures/runtime-resource-accounting-v1/values.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (character) => `sha256:${character.repeat(64)}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function rejection(promise) {
  const result = await promise.then(
    () => ({ rejected: false }),
    (reason) => ({ rejected: true, reason }),
  );
  assert.equal(result.rejected, true);
  return result.reason;
}
function frozen(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(frozen);
}

/** Controlled nonsecret composition only: no database enrollment, account,
 * material, manifest admission or production authority is supplied here. */
function fixture() {
  const record = make();
  const calls = {
    source: [],
    reader: [],
    correspondence: [],
    poison: [],
    release: 0,
    workloadRelease: 0,
  };
  const state = { active: true, baseCurrent: true, workloadCurrent: true };
  const workload = {
    request: {
      schemaVersion: 2,
      ...record.scope,
      revisionId: record.revisionId,
      configurationRef: "configuration/example",
      configurationVersion: 7,
      selection: clone(record.association.selection),
    },
    use: {
      schemaVersion: 2,
      component: "gateway-harness-pair",
      installationId: record.scope.installationId,
      namespaceId: record.scope.namespaceId,
      canonicalFormat: "oce.workload-profile.canonical-json.v1",
      ...clone(record.association.selection),
      profileRefs: clone(record.association.profileRefs),
      admittedConfigurationDigest: record.association.admittedConfigurationDigest,
    },
    // This wrapper consumes a retained lease, not a manifest producer. These
    // unused placeholders intentionally claim no manifest/accounting validation.
    manifest: {},
    digests: {},
    assertCurrent() {
      if (!state.workloadCurrent) throw new Error("workload withdrawn");
      return undefined;
    },
    async release() {
      calls.workloadRelease++;
      state.workloadCurrent = false;
    },
  };
  const subject = {
    kind: "agent-gateway",
    installationId: record.scope.installationId,
    namespaceRef: record.scope.namespaceId,
    agentRef: record.scope.agentId,
  };
  const selected = {
    schemaVersion: 2,
    namespaceRef: record.scope.namespaceId,
    agentRef: record.scope.agentId,
    admittedRevisionRef: record.revisionId,
    selection: clone(record.association.selection),
    profileRefs: clone(record.association.profileRefs),
    admittedConfigurationDigest: record.association.admittedConfigurationDigest,
    configurationRef: workload.request.configurationRef,
    configurationVersion: workload.request.configurationVersion,
    profileRef: "gateway-profile/example",
    profileVersion: 1,
    gatewayAssignmentRef: "assignment/example",
    hostRuntimeGeneration: 1,
    nativeConfigRef: "native-config/example",
    configDigest: "native-config-digest/example",
    stateOwnership: { recordRef: "state/example", recordVersion: 1 },
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: record.channels.map((channel) => ({
      id: channel.moduleId,
      kind: "channel",
      profileRef: channel.profileRef,
      requiredCapabilities: ["shared-session"],
    })),
    startupDeadlineMs: 5000,
    shutdownDeadlineMs: 5000,
  };
  const carrier = {
    selected,
    workload,
    assertCurrent() {
      if (!state.baseCurrent) throw new Error("base withdrawn");
      return undefined;
    },
    assertCredentialCorrespondence(value) {
      calls.correspondence.push(value);
      assert.deepEqual(value, record);
      return undefined;
    },
    async release() {
      calls.release++;
      state.baseCurrent = false;
      await workload.release();
    },
  };
  const source = {
    async resolveLocked(...args) {
      calls.source.push(args);
      return carrier;
    },
  };
  const reader = {
    async readLocked(...args) {
      calls.reader.push(args);
      return record;
    },
  };
  const command = {
    schemaVersion: 2,
    kind: "accept-startup",
    subject: clone(subject),
    operationRef: "operation/example",
    expectedHead: null,
    selectedDefinition: { recordRef: "definition/example", recordVersion: 1 },
    predecessorDisposition: { recordRef: "predecessor/example", recordVersion: 1 },
  };
  const original = undefined;
  const unit = { subject, policy: {}, backend: {} };
  const io = {
    assertActive() {
      if (!state.active) throw new Error("acquisition closed");
      return undefined;
    },
    poison(error) {
      calls.poison.push(error);
    },
    async query() {
      throw new Error("No SQL in controlled projection test");
    },
  };
  return {
    record,
    workload,
    selected,
    carrier,
    source,
    reader,
    command,
    original,
    unit,
    io,
    state,
    calls,
  };
}
function resolve(f, reader = f.reader) {
  return create(f.source).resolveLocked(f.command, f.original, f.unit, f.io, reader);
}

test("pure projection preserves the complete original detached immutable CRD record", () => {
  const f = fixture();
  const expected = clone(f.record);
  const result = project(f.workload, f.record);
  assert.deepEqual(result, expected);
  assert.notEqual(result, f.record);
  frozen(result);
  f.record.model.binding.secretVersion++;
  f.record.repository.grant.repositoryIds.push("202");
  f.record.materialSelection.recordVersion++;
  f.record.channels[0].bot.version++;
  assert.deepEqual(result, expected);
  assert.deepEqual(f.calls.poison, []);
  assert.equal(f.calls.release, 0);
});

for (const field of ["installationId", "namespaceId", "agentId", "revisionId"]) {
  test(`pure projection refuses a different retained ${field}`, () => {
    const f = fixture();
    f.workload.request[field] += "/other";
    if (field === "installationId" || field === "namespaceId")
      f.workload.use[field] = f.workload.request[field];
    assert.throws(() => project(f.workload, f.record), CredentialWorkloadRecordError);
  });
}

for (const field of ["manifestRef", "manifestDigest", "admissionRef", "admissionVersion"]) {
  test(`pure projection refuses mismatched selected field ${field}`, () => {
    const f = fixture();
    const changed =
      field === "admissionVersion"
        ? 2
        : field === "manifestDigest"
          ? digest("b")
          : "00000000-0000-4000-8000-000000000099";
    f.workload.use[field] = changed;
    f.workload.request.selection[field] = changed;
    assert.throws(() => project(f.workload, f.record), CredentialWorkloadRecordError);
  });
}

for (const role of ["provider", "runtime", "identity", "containment", "storage"]) {
  test(`pure projection refuses the different retained ${role} profile`, () => {
    const f = fixture();
    f.workload.use.profileRefs[role].version++;
    assert.throws(() => project(f.workload, f.record), CredentialWorkloadRecordError);
  });
}

test("pure projection refuses configuration mismatch, invalid data and incompatible use", () => {
  const f = fixture();
  f.workload.use.admittedConfigurationDigest = digest("b");
  assert.throws(() => project(f.workload, f.record), CredentialWorkloadRecordError);
  for (const record of [undefined, null, {}, { ...make(), unexpected: true }])
    assert.throws(() => project(fixture().workload, record), CredentialWorkloadRecordError);
  for (const mutate of [
    (held) => {
      held.request.schemaVersion = 1;
    },
    (held) => {
      held.use.component = "harness";
    },
    (held) => {
      held.request.selection.admissionVersion++;
    },
  ]) {
    const next = fixture();
    mutate(next.workload);
    assert.throws(() => project(next.workload, next.record), CredentialWorkloadRecordError);
  }
});

test("one resolver forwards exact original arguments and reads the exact held lease", async () => {
  const f = fixture();
  const lease = await resolve(f);
  assert.equal(f.calls.source.length, 1);
  assert.equal(f.calls.source[0].length, 4);
  assert.deepEqual(f.calls.source[0], [f.command, f.original, f.unit, f.io]);
  for (const [actual, expected] of f.calls.source[0].map((value, index) => [
    value,
    [f.command, f.original, f.unit, f.io][index],
  ]))
    assert.equal(actual, expected);
  assert.equal(f.calls.reader.length, 1);
  for (const [index, expected] of [f.workload.request, f.workload, f.unit, f.io].entries())
    assert.equal(f.calls.reader[0][index], expected);
  assert.deepEqual(lease.credentialWorkloadSelection, f.record);
  assert.notEqual(lease.credentialWorkloadSelection, f.record);
  assert.equal(f.calls.correspondence[0], lease.credentialWorkloadSelection);
  assert.equal(lease.selected, f.selected);
  assert.equal("credentialWorkloadSelection" in lease.selected, false);
  assert.equal("materialSelection" in lease.selected, false);
  assert.deepEqual(Object.keys(lease).sort(), [
    "assertCurrent",
    "credentialWorkloadSelection",
    "release",
    "selected",
  ]);
  assert.equal(f.calls.release, 0);
  const first = lease.release();
  assert.equal(lease.release(), first);
  await first;
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  assert.throws(() => lease.assertCurrent());
});

test("missing source or reader refuses before acquisition and poisons the supplied operation", async () => {
  for (const missing of ["source", "reader"]) {
    const f = fixture();
    const resolver = create(missing === "source" ? undefined : f.source);
    await assert.rejects(
      resolver.resolveLocked(
        f.command,
        f.original,
        f.unit,
        f.io,
        missing === "reader" ? undefined : f.reader,
      ),
      CredentialWorkloadRecordError,
    );
    assert.equal(f.calls.source.length, 0);
    assert.equal(f.calls.reader.length, 0);
    assert.ok(f.calls.poison.length > 0);
    assert.equal(f.calls.release, 0);
  }
});

test("wrong Agent subject cannot reach the source or use a V1 fallback", async () => {
  for (const change of [
    (f) => {
      f.unit.subject.agentRef += "/different";
    },
    (f) => {
      f.unit.subject.namespaceRef += "/different";
    },
    (f) => {
      f.unit.subject.installationId += "/different";
    },
    (f) => {
      delete f.unit.subject;
      f.unit.installationId = f.record.scope.installationId;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(resolve(f));
    assert.equal(f.calls.source.length, 0);
    assert.equal(f.calls.reader.length, 0);
    assert.ok(f.calls.poison.length > 0);
  }
});

for (const field of ["assertCurrent", "workload", "selected", "assertCredentialCorrespondence"]) {
  test(`known cleanup survives an acquired ${field} getter throwing`, async () => {
    const f = fixture();
    const error = new Error(`acquired ${field} failed`);
    Object.defineProperty(f.carrier, field, {
      get() {
        throw error;
      },
    });
    assert.equal(await rejection(resolve(f)), error);
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.workloadRelease, 1);
    assert.equal(f.calls.reader.length, 0);
    assert.ok(f.calls.poison.includes(error));
  });
}

test("missing acquired methods and a throwing workload guard getter retain cleanup", async () => {
  for (const change of [
    (f) => {
      f.carrier.assertCurrent = undefined;
    },
    (f) => {
      f.carrier.assertCredentialCorrespondence = undefined;
    },
    (f) => {
      Object.defineProperty(f.workload, "assertCurrent", {
        get() {
          throw new Error("guard getter failed");
        },
      });
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(resolve(f));
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.workloadRelease, 1);
    assert.equal(f.calls.reader.length, 0);
  }
});

test("source and reader errors retain their exact reason, including undefined", async () => {
  for (const where of ["source", "reader"]) {
    for (const error of [new Error(`${where} refused`), undefined]) {
      const f = fixture();
      if (where === "source")
        f.source.resolveLocked = async () => {
          throw error;
        };
      else
        f.reader.readLocked = async () => {
          throw error;
        };
      assert.equal(await rejection(resolve(f)), error);
      assert.ok(f.calls.poison.includes(error));
      assert.equal(f.calls.release, where === "source" ? 0 : 1);
      assert.equal(f.calls.workloadRelease, where === "source" ? 0 : 1);
    }
  }
});

test("an absent protected row fails after acquisition with exactly one cleanup", async () => {
  const f = fixture();
  f.reader.readLocked = async () => undefined;
  await assert.rejects(resolve(f), CredentialWorkloadRecordError);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  assert.equal(f.calls.correspondence.length, 0);
});

test("complete Gateway selection must correspond before the original CRD assertion", async () => {
  const changes = [
    (value) => {
      value.schemaVersion = 1;
    },
    (value) => {
      value.namespaceRef += "/other";
    },
    (value) => {
      value.agentRef += "/other";
    },
    (value) => {
      value.admittedRevisionRef += "/other";
    },
    (value) => {
      value.configurationRef += "/other";
    },
    (value) => {
      value.configurationVersion++;
    },
    (value) => {
      value.selection.admissionVersion++;
    },
    (value) => {
      value.profileRefs.storage.version++;
    },
    (value) => {
      value.admittedConfigurationDigest = digest("c");
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.selected);
    await assert.rejects(resolve(f), CredentialWorkloadRecordError);
    assert.equal(f.calls.correspondence.length, 0);
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.workloadRelease, 1);
  }
});

test("material changes require the original correspondence assertion and never alias selected4", async () => {
  const f = fixture();
  const changed = clone(f.record);
  changed.materialSelection.recordVersion++;
  f.reader.readLocked = async () => changed;
  await assert.rejects(resolve(f), assert.AssertionError);
  assert.equal(f.calls.correspondence.length, 1);
  assert.deepEqual(f.selected.selection, f.record.association.selection);
  assert.equal("recordRef" in f.selected.selection, false);
  assert.equal(f.calls.release, 1);
});

for (const changed of ["request", "use", "selected"]) {
  test(`mutation of captured ${changed} while the row read waits poisons and releases`, async () => {
    const f = fixture();
    const entered = deferred();
    const read = deferred();
    f.reader.readLocked = async () => {
      entered.resolve();
      return read.promise;
    };
    const result = resolve(f);
    const failure = rejection(result);
    await entered.promise;
    if (changed === "request") f.workload.request.configurationVersion++;
    if (changed === "use") f.workload.use.admissionVersion++;
    if (changed === "selected") f.selected.hostRuntimeGeneration++;
    read.resolve(f.record);
    assert.ok((await failure) instanceof CredentialWorkloadRecordError);
    assert.equal(f.calls.correspondence.length, 0);
    assert.equal(f.calls.release, 1);
    assert.ok(f.calls.poison.length > 0);
  });
}

for (const at of ["base", "workload", "correspondence"]) {
  test(`invalid asynchronous ${at} assertion is denied and drained before cleanup`, async () => {
    const f = fixture();
    const entered = deferred();
    const pending = deferred();
    const invalid = () => {
      entered.resolve();
      return pending.promise;
    };
    if (at === "base") f.carrier.assertCurrent = invalid;
    if (at === "workload") f.workload.assertCurrent = invalid;
    if (at === "correspondence") f.carrier.assertCredentialCorrespondence = invalid;
    const result = resolve(f);
    let settled = false;
    const failure = rejection(result).then((error) => {
      settled = true;
      return error;
    });
    await entered.promise;
    await tick();
    assert.equal(settled, false);
    assert.equal(f.calls.release, 0);
    pending.reject(undefined);
    assert.ok((await failure) instanceof CredentialWorkloadRecordError);
    assert.equal(f.calls.release, 1);
    assert.equal(f.calls.workloadRelease, 1);
    assert.ok(f.calls.poison.length > 0);
  });
}

test("invalid synchronous correspondence return is denied rather than truthy acceptance", async () => {
  for (const value of [true, false, null, 1]) {
    const f = fixture();
    f.carrier.assertCredentialCorrespondence = () => value;
    await assert.rejects(resolve(f), CredentialWorkloadRecordError);
    assert.equal(f.calls.release, 1);
    assert.ok(f.calls.poison.length > 0);
  }
});

test("late undefined failure is permanently latched even if a controlled peer recovers", async () => {
  const f = fixture();
  let withdrawn = false;
  f.carrier.assertCurrent = () => {
    if (withdrawn) throw undefined;
    return undefined;
  };
  const lease = await resolve(f);
  withdrawn = true;
  for (const after of [true, false]) {
    withdrawn = after;
    let threw = false;
    try {
      lease.assertCurrent();
    } catch (error) {
      threw = true;
      assert.equal(error, undefined);
    }
    assert.equal(threw, true);
  }
  assert.ok(f.calls.poison.includes(undefined));
  await lease.release();
  assert.equal(f.calls.release, 1);
});

test("late async fence keeps its underlying cleanup until the owned invocation settles", async () => {
  const f = fixture();
  const pending = deferred();
  let late = false;
  f.workload.assertCurrent = () => (late ? pending.promise : undefined);
  const lease = await resolve(f);
  late = true;
  assert.throws(() => lease.assertCurrent(), CredentialWorkloadRecordError);
  const close = lease.release();
  assert.equal(lease.release(), close);
  await tick();
  assert.equal(f.calls.release, 0);
  pending.resolve(undefined);
  await close;
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  assert.throws(() => lease.assertCurrent(), CredentialWorkloadRecordError);
});

test("release rejection with undefined remains a rejection and cleanup runs once", async () => {
  const f = fixture();
  f.carrier.release = async () => {
    f.calls.release++;
    await f.workload.release();
    throw undefined;
  };
  const lease = await resolve(f);
  const close = lease.release();
  assert.equal(lease.release(), close);
  assert.equal(await rejection(close), undefined);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
});

test("the original correspondence inspector uses the guarded view and joins its hidden async fence", async () => {
  const f = fixture();
  const pending = deferred();
  let insideInspector = false;
  let inspected;
  f.carrier.assertCurrent = () => (insideInspector ? pending.promise : undefined);
  f.carrier.assertCredentialCorrespondence = (record, guarded) => {
    assert.deepEqual(record, f.record);
    assert.equal(guarded.selected, f.selected);
    inspected = guarded;
    insideInspector = true;
    // The original inspector can catch a guard failure; Runtime still owns
    // that invocation's promise and the latched failure before any release.
    assert.throws(() => guarded.assertCurrent(), CredentialWorkloadRecordError);
    return undefined;
  };
  let settled = false;
  const running = resolve(f).finally(() => {
    settled = true;
  });
  await tick();
  assert.ok(inspected);
  assert.equal(settled, false);
  assert.equal(f.calls.release, 0);
  pending.reject(undefined);
  assert.ok((await rejection(running)) instanceof CredentialWorkloadRecordError);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
});

test("reentrant original cleanup observes the already memoized terminal promise", async () => {
  const f = fixture();
  let held;
  let reentrant;
  f.carrier.release = () => {
    f.calls.release++;
    reentrant = held.release();
    return f.workload.release();
  };
  held = await resolve(f);
  const terminal = held.release();
  await terminal;
  assert.equal(reentrant, terminal);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
});

test("cleanup failure poisons without replacing the original reader rejection", async () => {
  const f = fixture();
  const original = new Error("original read failure");
  f.reader.readLocked = async () => {
    throw original;
  };
  f.carrier.release = async () => {
    f.calls.release++;
    await f.workload.release();
    throw undefined;
  };
  assert.equal(await rejection(resolve(f)), original);
  assert.ok(f.calls.poison.includes(original));
  assert.ok(f.calls.poison.includes(undefined));
  assert.equal(f.calls.release, 1);
});

/** The real phase/lifetime are exercised below with controlled participants and
 * a query callback. No PostgreSQL transaction, committed authority or production
 * enrollment is represented by this fixture. Rollback completion is deliberate. */
function phaseFixture(
  query = async () => {
    throw new Error("Unexpected query");
  },
) {
  const f = fixture();
  const lifetime = new RepositoryTransactionLifetime();
  const phase = new GatewayStartupOwnerPhaseV1(lifetime, query);
  f.unit.phase = phase;
  const current = f.carrier.assertCurrent.bind(f.carrier);
  f.carrier.assertCurrent = () => {
    lifetime.assertActive();
    current();
    return undefined;
  };
  const completion = { kind: "rollback", response: { kind: "unavailable" } };
  let selectionIO;
  let selectedLease;
  const command = () =>
    phase.runCommand(async () => {
      selectedLease = await phase.runOperation("credential-selection", async (scope) => {
        selectionIO = scope;
        const held = await create(f.source).resolveLocked(
          f.command,
          f.original,
          f.unit,
          scope,
          f.reader,
        );
        // Same ordering as the original owner's selection continuation: retain
        // cleanup before the guard and before leaving the accepted operation.
        phase.retainCleanup(held.release);
        phase.retainCurrentness(held.assertCurrent);
        held.assertCurrent();
        return held;
      });
      return completion;
    });
  return {
    ...f,
    lifetime,
    phase,
    completion,
    command,
    get selectionIO() {
      return selectionIO;
    },
    get selectedLease() {
      return selectedLease;
    },
  };
}

test("real phase retains selection after acquisition IO ends and releases only at terminal cleanup", async () => {
  const f = phaseFixture();
  assert.deepEqual(await f.command(), f.completion);
  const held = f.selectedLease;
  const originalIO = f.selectionIO;
  assert.equal(f.calls.reader[0][3], originalIO);
  assert.equal(f.calls.source[0][3], originalIO);
  assert.equal(f.calls.reader[0][2], f.unit);
  // The first runOperation has settled: reusing its assertActive internally
  // would fail here. The held guard must use the retained lifetime instead.
  assert.equal(held.assertCurrent(), undefined);
  await f.phase.runOperation("later-owner-operation", async (scope) => {
    assert.notEqual(scope, originalIO);
    scope.assertActive();
    assert.equal(held.assertCurrent(), undefined);
  });
  await f.phase.drainAccepted();
  assert.deepEqual(f.phase.finalize(), f.completion);
  assert.equal(f.calls.release, 0);
  await f.phase.finishTerminal("rolled-back");
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  await assert.rejects(f.phase.finishTerminal("rolled-back"));
  assert.equal(f.calls.release, 1);
  await f.lifetime.finish();
  assert.throws(() => held.assertCurrent());
});

test("real phase refuses a captured acquisition IO after its operation has settled", async () => {
  const f = phaseFixture();
  await f.command();
  assert.equal(f.selectedLease.assertCurrent(), undefined);
  assert.throws(() => f.selectionIO.assertActive());
  await f.phase.drainAccepted();
  assert.throws(() => f.phase.finalize());
  await assert.rejects(f.phase.finishTerminal("rolled-back"));
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  await f.lifetime.finish();
});

test("real phase final fence observes withdrawal after admissions close and preserves cleanup", async () => {
  const f = phaseFixture();
  await f.command();
  await f.phase.drainAccepted();
  f.state.workloadCurrent = false;
  assert.throws(() => f.phase.finalize(), /workload withdrawn/);
  f.state.workloadCurrent = true;
  assert.throws(() => f.selectedLease.assertCurrent(), /workload withdrawn/);
  assert.equal(f.calls.release, 0);
  await assert.rejects(f.phase.finishTerminal("rolled-back"), /workload withdrawn/);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  await f.lifetime.finish();
});

test("real phase drains an unawaited query rejection with undefined before terminal cleanup", async () => {
  const entered = deferred();
  const pending = deferred();
  const f = phaseFixture(async (statement) => {
    assert.equal(statement, "controlled-credential-read");
    entered.resolve();
    return pending.promise;
  });
  f.reader.readLocked = async (request, held, unit, io) => {
    f.calls.reader.push([request, held, unit, io]);
    // An intentionally faulty controlled reader ignores its query result. The
    // actual owner phase must still track/drain and retain the failure.
    void io.query("controlled-credential-read").catch(() => {});
    return f.record;
  };
  let settled = false;
  const command = f.command().then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  await tick();
  assert.equal(settled, false);
  assert.equal(f.calls.release, 0);
  pending.reject(undefined);
  assert.deepEqual(await command, f.completion);
  await f.phase.drainAccepted();
  let threw = false;
  try {
    f.phase.finalize();
  } catch (error) {
    threw = true;
    assert.equal(error, undefined);
  }
  assert.equal(threw, true);
  assert.equal(await rejection(f.phase.finishTerminal("rolled-back")), undefined);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.workloadRelease, 1);
  await f.lifetime.finish();
});

test("actual admitted selector null-prototype values pass through the credential resolver", async () => {
  const f = fixture();
  // Reuse the maintained manifest/accounting fixture inputs and real V2
  // derivation. Storage and capability participants below remain controlled
  // non-production seams; there is no database enrollment or runtime evidence.
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
  f.record.association.selection.manifestDigest = derived.digests.manifestDigest;
  for (const [role, contentDigest] of Object.entries(derived.roleDigests))
    f.record.association.profileRefs[role].contentDigest = contentDigest;
  f.selected.selection = clone(f.record.association.selection);
  f.selected.profileRefs = clone(f.record.association.profileRefs);
  const request = {
    schemaVersion: 2,
    ...f.record.scope,
    revisionId: f.record.revisionId,
    configurationRef: f.selected.configurationRef,
    configurationVersion: f.selected.configurationVersion,
    selection: clone(f.record.association.selection),
  };
  const use = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    ...clone(request.selection),
    profileRefs: clone(f.record.association.profileRefs),
    admittedConfigurationDigest: f.record.association.admittedConfigurationDigest,
  };
  const admission = {
    schemaVersion: 2,
    state: "admitted",
    use,
    canonicalManifest: new TextDecoder().decode(derived.canonicalBytes),
    revision: {
      id: request.revisionId,
      agentId: request.agentId,
      namespaceId: request.namespaceId,
      workloadProfileUse: clone(use),
      configurationRef: request.configurationRef,
      configurationVersion: request.configurationVersion,
    },
    configuration: {
      ref: request.configurationRef,
      version: request.configurationVersion,
      admittedConfigurationDigest: use.admittedConfigurationDigest,
    },
  };
  const events = [];
  const selector = createAdmittedWorkloadProfileSelectorV2(
    {
      async enroll(actual, unit, io) {
        assert.deepEqual(clone(actual), request);
        assert.equal(unit, f.unit);
        assert.equal(io, f.io);
        events.push("enroll");
        return {
          assertCurrent: () => undefined,
          async release() {
            events.push("storage-release");
          },
          async lockNamespace() {
            events.push("namespace");
            return { namespaceId: request.namespaceId };
          },
          async lockAgent() {
            events.push("agent");
            return { namespaceId: request.namespaceId, agentId: request.agentId };
          },
          async readAdmission() {
            events.push("admission");
            return admission;
          },
        };
      },
    },
    {
      async acquire(actual, manifest, admittedUse, unit, io) {
        assert.deepEqual(clone(actual), request);
        assert.deepEqual(clone(manifest), clone(derived.content));
        assert.deepEqual(clone(admittedUse), use);
        assert.equal(unit, f.unit);
        assert.equal(io, f.io);
        events.push("capabilities");
        return {
          assertCurrent: () => undefined,
          async release() {
            events.push("capability-release");
          },
        };
      },
    },
  );
  let actualHeld;
  f.source.resolveLocked = async (command, original, unit, io) => {
    f.calls.source.push([command, original, unit, io]);
    actualHeld = await selector.resolveLocked(request, unit, io);
    assert.equal(Object.getPrototypeOf(actualHeld.request.selection), null);
    assert.equal(Object.getPrototypeOf(actualHeld.use.profileRefs), null);
    assert.equal(Object.getPrototypeOf(actualHeld.use.profileRefs.runtime), null);
    f.carrier.workload = actualHeld;
    f.carrier.release = async () => {
      f.calls.release++;
      await actualHeld.release();
    };
    return f.carrier;
  };
  f.reader.readLocked = async (actual, held, unit, io) => {
    f.calls.reader.push([actual, held, unit, io]);
    assert.equal(held, actualHeld);
    assert.equal(actual, actualHeld.request);
    assert.equal(unit, f.unit);
    assert.equal(io, f.io);
    return f.record;
  };
  const lease = await resolve(f);
  assert.equal(f.calls.source.length, 1);
  assert.equal(f.calls.reader.length, 1);
  assert.deepEqual(events, ["enroll", "namespace", "agent", "admission", "capabilities"]);
  assert.deepEqual(lease.credentialWorkloadSelection, f.record);
  assert.equal(lease.assertCurrent(), undefined);
  assert.deepEqual(f.calls.poison, []);
  await lease.release();
  await lease.release();
  assert.equal(f.calls.release, 1);
  assert.deepEqual(events.slice(-2), ["capability-release", "storage-release"]);
});
