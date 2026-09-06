import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { LifecycleAdmissionUnitPhase } from "../../packages/occ/src/lifecycle/protective-admission-unit.ts";
import { protectiveIntentDecision } from "../../packages/occ/src/lifecycle/protective-admission-v1.ts";
import {
  apply,
  committed,
  protectiveWrite,
  seedRuntimeOwner,
  verifyProtectiveAdmissionStore,
} from "../fixtures/lifecycle-protective-admission/shared-cases.mjs";

// Actual memory transaction behavior only. Trusted storage inputs do not
// authenticate an account, enable a public handler or establish durable recovery.
test("memory protective admission preserves atomic retained storage", async (t) => {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/state/platform-state.ts");
  await verifyProtectiveAdmissionStore(t, new InMemoryPlatformState());
});

test("protective local audit and pending export commit without calling an unavailable remote sink", async () => {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/state/platform-state.ts");
  let sends = 0;
  const state = new InMemoryPlatformState({
    auditSink: {
      append: async () => {
        sends += 1;
        throw new Error("remote audit unavailable");
      },
    },
  });
  const owner = await seedRuntimeOwner(state);
  const input = protectiveWrite(owner);
  const result = await apply(state, input);
  assert.equal(result.kind, "provisional");
  assert.equal(sends, 0);
  const retained = await committed(state, owner, input);
  assert.equal(retained.audit.id, input.audit.id);
  assert.equal(retained.export.state, "pending");
});

// Boundary arithmetic in the actual decision helper only. A maximum-generation
// representation is not a fabricated committed memory or PostgreSQL history.
function maximumDecisionInput() {
  const owner = {
    installation: { id: `ins_${randomUUID()}` },
    namespace: { id: `ns_${randomUUID()}` },
    agent: { id: `agt_${randomUUID()}` },
  };
  const input = protectiveWrite(owner, "disable", Number.MAX_SAFE_INTEGER);
  const head = {
    installationId: owner.installation.id,
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
    transitionRef: randomUUID(),
    generation: Number.MAX_SAFE_INTEGER,
    desiredMode: "disabled",
    revisionId: null,
    actorId: input.attribution.actorId,
    requestId: input.attribution.requestId,
    createdAt: new Date().toISOString(),
  };
  return { owner, input, head };
}

test("pure protective decision allows maximum-generation same-mode no-op", () => {
  const { owner, input, head } = maximumDecisionInput();
  assert.deepEqual(
    protectiveIntentDecision(input, owner.installation.id, head, new Date().toISOString()),
    {
      kind: "unchanged",
      lifecycleGeneration: Number.MAX_SAFE_INTEGER,
      desiredMode: "disabled",
    },
  );
});

test("pure protective decision checks stale CAS before same-mode no-op", () => {
  const { owner, input, head } = maximumDecisionInput();
  input.request.expectedLifecycleGeneration -= 1;
  assert.throws(
    () => protectiveIntentDecision(input, owner.installation.id, head, new Date().toISOString()),
    /generation does not match/,
  );
});

test("pure protective decision rejects material generation overflow", () => {
  const { owner, input, head } = maximumDecisionInput();
  input.request.kind = "stop";
  assert.throws(
    () => protectiveIntentDecision(input, owner.installation.id, head, new Date().toISOString()),
    /generation is exhausted/,
  );
});

// These controlled callbacks exercise the actual phase only. They are not a
// PlatformState implementation and do not prove a store commit or backend drain.
function phaseFixture(work) {
  const phase = new LifecycleAdmissionUnitPhase();
  const unit = phase.bind({ lifecycleAdmissions: { applyProtective: work } });
  return { phase, unit };
}

test("pure protective phase drains accepted unawaited work after synchronous close", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const events = [];
  const { phase, unit } = phaseFixture(async () => {
    events.push("entered");
    phase.assertProtective();
    entered.resolve();
    await release.promise;
    phase.assertProtective();
    events.push("completed");
    return "retained callback result";
  });
  const accepted = unit.lifecycleAdmissions.applyProtective();
  phase.closeAdmissions();
  const finishing = phase.finish().then(() => events.push("finished"));
  await entered.promise;
  assert.deepEqual(events, ["entered"]);
  release.resolve();
  await finishing;
  assert.equal(await accepted, "retained callback result");
  assert.deepEqual(events, ["entered", "completed", "finished"]);
  assert.throws(() => phase.assertProtective(), ScopeViolationError);
});

test("pure protective phase preserves a caught original failure through finish", async () => {
  const original = new Error("controlled admission callback failure");
  const { phase, unit } = phaseFixture(async () => {
    throw original;
  });
  let caught;
  await unit.lifecycleAdmissions.applyProtective().catch((error) => {
    caught = error;
  });
  assert.equal(caught, original);
  // A later ordering error cannot replace the first accepted failure.
  await assert.rejects(
    phase.other(async () => {}),
    ScopeViolationError,
  );
  await assert.rejects(phase.finish(), (error) => error === original);
});

for (const method of ["other", "legacyQuery"]) {
  test(`pure protective phase poisons finish for illegal ${method} after apply`, async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const { phase, unit } = phaseFixture(async () => {
      entered.resolve();
      await release.promise;
    });
    const accepted = unit.lifecycleAdmissions.applyProtective();
    await entered.promise;
    let calls = 0;
    let original;
    await phase[method](async () => {
      calls += 1;
    }).catch((error) => {
      original = error;
    });
    assert.ok(original instanceof ScopeViolationError);
    assert.equal(calls, 0);
    release.resolve();
    await accepted;
    await assert.rejects(phase.finish(), (error) => error === original);
  });
}

test("pure protective phase rejects new submissions after close without entering callbacks", async () => {
  let calls = 0;
  const { phase, unit } = phaseFixture(async () => {
    calls += 1;
  });
  phase.closeAdmissions();
  await assert.rejects(unit.lifecycleAdmissions.applyProtective(), ScopeViolationError);
  await assert.rejects(
    phase.other(async () => {
      calls += 1;
    }),
    ScopeViolationError,
  );
  assert.equal(calls, 0);
  await phase.finish();
});

test("pure protective phase permits accepted legacy query continuation until owner backend closes", async () => {
  const phase = new LifecycleAdmissionUnitPhase();
  const resume = Promise.withResolvers();
  const backendClosed = new Error("controlled owner backend closed");
  let backendOpen = true;
  let calls = 0;
  // The callback models only the owner's lifetime boundary. The phase must
  // forward legacy continuation; actual backend lifetime enforcement is separate.
  const query = async () => {
    if (!backendOpen) throw backendClosed;
    calls += 1;
    return "legacy query result";
  };
  const accepted = phase.other(async () => {
    await resume.promise;
    return phase.legacyQuery(query);
  });
  phase.closeAdmissions();
  await assert.rejects(phase.other(query), ScopeViolationError);
  resume.resolve();
  assert.equal(await accepted, "legacy query result");
  assert.equal(calls, 1);
  await phase.finish();
  backendOpen = false;
  await assert.rejects(phase.legacyQuery(query), (error) => error === backendClosed);
  assert.equal(calls, 1);
});
