import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateContainmentEvidenceV1 as evaluate,
  emptyContainmentEvidenceStateV1 as empty,
  CONTAINMENT_EVIDENCE_LIMITS_V1 as limits,
} from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import {
  sample,
  copy,
  at,
  id,
  digest,
  advanceProjection,
  advanceControl,
  negativeAuthority,
  allClocks,
} from "../fixtures/containment-evidence-v1/values.mjs";

const same = (actual, expected) => assert.deepEqual(copy(actual), copy(expected));
const has = (value, code) => value.findings.some((finding) => finding.reasonCode === code);
const satisfied = (value) => {
  assert.equal(value.decision, "satisfied", JSON.stringify(value.findings));
  return value;
};
const compare = (value, state = empty()) => evaluate(value, state);
const watermarks = (result) => result.nextState.subjects[0]?.watermarks;

for (const purpose of [
  "identity-registration",
  "readiness-probe",
  "runtime-peer",
  "model-call",
  "repository-issuance",
]) {
  test(`${purpose} uses its original positive branch and remains comparison-only`, () => {
    const result = satisfied(compare(sample(purpose)));
    assert.equal(result.scope, "comparison-only");
    assert.ok(result.nextState.subjects.length === 1);
    assert.ok(Object.isFrozen(result.nextState.subjects[0].watermarks[0]));
    assert.equal("admission" in result, false);
  });
}
test("a preparation candidate needs no target identity and cannot become current user work", () => {
  const value = sample("identity-registration");
  assert.equal(value.observation.runtimeObservation.identityEvidence, null);
  satisfied(compare(value));
  value.authorityRequest.purpose = "model-call";
  delete value.authorityRequest.operationRef;
  delete value.authorityRequest.expectedResponsibilityVersion;
  assert.ok(has(compare(value), "purpose-mismatch"));
});
for (const field of ["identityEvidence", "peerIdentityEvidence"]) {
  test(`readiness requires original ${field}`, () => {
    const value = sample("readiness-probe");
    delete value.authorityResult[field];
    const result = compare(value);
    assert.equal(result.decision, "unknown");
    assert.ok(has(result, "invalid-input"));
    same(result.nextState, empty());
  });
}
test("user work requires original observed verified identity matching authority registration", () => {
  const value = sample();
  value.observation.runtimeObservation.identityEvidence = null;
  assert.ok(has(compare(value), "missing-evidence"));
  const other = sample();
  other.observation.runtimeObservation.identityEvidence.registrationId = "different-registration";
  assert.ok(has(compare(other), "target-mismatch"));
});
for (const [purpose, selected] of [
  ["model-call", "snapshot"],
  ["runtime-peer", "snapshot"],
  ["repository-issuance", "snapshot"],
  ["readiness-probe", "snapshot"],
  ["readiness-probe", "peer"],
]) {
  test(`${purpose} identity must match the selected ${selected} profile without advancing state`, () => {
    const value = sample(purpose);
    const retained = satisfied(compare(value)).nextState;
    value.authorityResult[selected].identityProfileRef = "other-selected-identity-profile";
    const slot = `authority:${purpose}:${selected === "peer" ? "peer-identity-profile" : "identity-profile"}`;
    for (const previous of [empty(), retained]) {
      const result = compare(value, previous);
      assert.equal(result.decision, "denied");
      assert.ok(
        result.findings.some(
          (finding) => finding.reasonCode === "target-mismatch" && finding.slot === slot,
        ),
      );
      same(result.nextState, previous);
    }
  });
}
for (const [name, mutate, reason] of [
  ["required-control omission", (v) => v.observation.controls.pop(), "invalid-input"],
  [
    "wrong expected profile",
    (v) => (v.expected.containmentProfile.digest = digest(90)),
    "invalid-input",
  ],
  [
    "wrong expected execution",
    (v) => (v.expected.runtime.binding.protectedRestartDiscriminator += "-other"),
    "invalid-input",
  ],
  [
    "authority target mismatch",
    (v) => (v.authorityResult.snapshot.target.createEffectRef = id(90)),
    "target-mismatch",
  ],
  [
    "authority binding mismatch",
    (v) => (v.authorityResult.snapshot.binding.protectedRestartDiscriminator += "-other"),
    "target-mismatch",
  ],
  [
    "authority request mismatch",
    (v) => (v.authorityResult.requestRef += "-other"),
    "purpose-mismatch",
  ],
  [
    "authority scope mismatch",
    (v) => (v.authorityRequest.assignmentRef.id = id(90)),
    "target-mismatch",
  ],
  ["unsupported schema", (v) => (v.expected.schemaVersion = 2), "invalid-input"],
  ["serialized verified flag", (v) => (v.observation.verified = true), "invalid-input"],
  [
    "missing authority",
    (v) => {
      delete v.authorityResult;
    },
    "invalid-input",
  ],
  [
    "loose current flag",
    (v) => {
      v.authorityResult = { current: true };
    },
    "invalid-input",
  ],
]) {
  test(`${name} denies with no state progress`, () => {
    const value = sample();
    mutate(value);
    const result = compare(value);
    assert.notEqual(result.decision, "satisfied");
    assert.ok(has(result, reason), JSON.stringify(result.findings));
    same(result.nextState, empty());
  });
}
test("observer order is irrelevant to exact required coverage", () => {
  const first = satisfied(compare(sample()));
  const value = sample();
  value.observation.controls.reverse();
  const replay = satisfied(compare(value, first.nextState));
  same(watermarks(replay), watermarks(first));
});
for (const status of ["incomplete", "ambiguous", "unknown"]) {
  test(`original Runtime ${status} remains denial`, () => {
    const value = sample();
    value.observation.runtimeObservation = {
      schemaVersion: 1,
      status,
      input: copy(value.expected.runtime),
      reasonCode: "evidence-incomplete",
    };
    assert.ok(has(compare(value), "missing-evidence"));
  });
}
for (const status of ["unknown", "unavailable", "cancelled", "deadline-exceeded"]) {
  test(`${status} controls cannot qualify`, () => {
    const value = sample();
    value.observation = {
      schemaVersion: 1,
      projectionVersion: 1,
      input: copy(value.expected),
      eligibility: "observation-only",
      status,
      reasonCode: status === "unknown" ? "evidence-incomplete" : status,
    };
    assert.ok(has(compare(value), "missing-evidence"));
  });
}
test("desired, delivered and effective Runtime policy remain separate and must agree", () => {
  const value = sample();
  value.observation.runtimeObservation.profile.effective.digest = digest(91);
  assert.ok(has(compare(value), "policy-mismatch"));
});
test("missing or explicitly ineffective controls retain a source-specific recovery requirement", () => {
  const value = sample();
  const control = value.observation.controls[0];
  control.effective = null;
  control.outcome = "unknown";
  control.reasonCode = "evidence-incomplete";
  const first = compare(value);
  assert.ok(has(first, "missing-evidence"));
  assert.ok(first.nextState.subjects[0].blocked.includes("control:runtime-isolation"));
  const repaired = sample();
  advanceProjection(repaired);
  assert.ok(has(compare(repaired, first.nextState), "evidence-conflict"));
  advanceControl(repaired);
  satisfied(compare(repaired, first.nextState));
});
test("ineffective control recovery requires newer original evidence, not a newer observer envelope", () => {
  const value = sample();
  const control = value.observation.controls[0];
  control.effective.digest = digest(92);
  control.outcome = "ineffective";
  control.reasonCode = "precondition-failed";
  const failed = compare(value);
  assert.equal(failed.decision, "denied");
  const repaired = sample();
  advanceProjection(repaired);
  advanceControl(repaired);
  assert.ok(has(compare(repaired, failed.nextState), "evidence-conflict"));
  repaired.observation.controls[0].effective.evidence.evidenceVersion++;
  repaired.observation.controls[0].effective.evidence.evidenceRef += "-new";
  satisfied(compare(repaired, failed.nextState));
});
test("original 15-second age boundary includes uncertainty and receipt cannot refresh it", () => {
  const value = sample();
  allClocks(value, 1_000, 0);
  value.clock = { now: at(16_000), monotonicMs: 16_000 };
  satisfied(compare(value));
  value.clock.now = at(16_001);
  value.clock.monotonicMs++;
  value.observation.observation.clock.receivedAt = value.clock.now;
  const result = compare(value);
  assert.ok(has(result, "evidence-stale"));
  same(result.nextState, empty());
});
test("original 2-second uncertainty boundary and stricter uncertainty apply to every source", () => {
  const value = sample();
  allClocks(value, 1_000, 2_000);
  satisfied(compare(value));
  value.expected.maxUncertaintyMs = 1_999;
  value.observation.input = copy(value.expected);
  assert.ok(has(compare(value), "evidence-stale"));
});
test("zero purpose bounds accept only exact zero-uncertainty evidence at the sampled instant", () => {
  const value = sample();
  allClocks(value, 2_000, 0);
  value.expected.maxAgeMs = 0;
  value.expected.maxUncertaintyMs = 0;
  value.observation.input = copy(value.expected);
  satisfied(compare(value));
  value.clock.now = at(2_001);
  value.clock.monotonicMs++;
  assert.ok(has(compare(value), "evidence-stale"));
});
for (const [name, mutate, slot] of [
  [
    "old control effective",
    (v) => {
      v.observation.controls[0].effective.evidence.clock.sourceObservedAt = at(0);
      v.observation.controls[0].effective.evidence.clock.validUntil = at(15_000);
      v.expected.maxAgeMs = 1_500;
      v.observation.input = copy(v.expected);
    },
    "control:runtime-isolation:effective",
  ],
  [
    "expired control validity",
    (v) => {
      v.observation.controls[0].source.clock.validUntil = at(1_500);
    },
    "control:runtime-isolation",
  ],
  [
    "future source beyond uncertainty",
    (v) => {
      v.clock.now = at(900);
      v.authorityResult.evaluatedAt = at(900);
      v.observation.controls[0].effective.evidence.clock.uncertaintyMs = 0;
    },
    "control:runtime-isolation:effective",
  ],
  [
    "old owner-chain",
    (v) => {
      v.observation.runtimeObservation.ownerChainEvidence.clock.sourceObservedAt = at(0);
      v.observation.runtimeObservation.ownerChainEvidence.clock.validUntil = at(15_000);
      v.expected.maxAgeMs = 1_500;
      v.observation.input = copy(v.expected);
    },
    "runtime:owner-chain",
  ],
  [
    "old authority identity",
    (v) => {
      v.authorityResult.identityEvidence.evidence.sourceObservedAt = at(0);
      v.authorityResult.identityEvidence.evidence.validUntil = at(15_000);
      v.expected.maxAgeMs = 1_500;
      v.observation.input = copy(v.expected);
    },
    "authority:model-call:identityEvidence:evidence",
  ],
  [
    "expired identity",
    (v) => {
      v.observation.runtimeObservation.identityEvidence.expiresAt = at(1_999);
    },
    "runtime:identity",
  ],
]) {
  test(`${name} cannot be concealed by a fresh outer receipt`, () => {
    const value = sample();
    mutate(value);
    const result = compare(value);
    assert.notEqual(result.decision, "satisfied");
    assert.ok(
      result.findings.some(
        (finding) => finding.reasonCode === "evidence-stale" && finding.slot === slot,
      ),
      JSON.stringify(result.findings),
    );
    same(result.nextState, empty());
  });
}
test("receipt-only changes preserve exact proof replay without changing original time", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.observation.observation.clock.receivedAt = at(2_000);
  value.observation.controls[0].source.clock.receivedAt = at(2_000);
  value.authorityResult.runtimeEvidence.receivedAt = at(2_000);
  const second = satisfied(compare(value, first.nextState));
  same(watermarks(second), watermarks(first));
});
test("new enclosing source permits unchanged original policy-stage evidence within its own lifetime", () => {
  const value = sample();
  const first = satisfied(compare(value));
  advanceProjection(value);
  advanceControl(value);
  satisfied(compare(value, first.nextState));
});
for (const axis of ["wall", "monotonic"]) {
  test(`${axis} clock rollback cannot advance state`, () => {
    const value = sample();
    const first = satisfied(compare(value));
    if (axis === "wall") value.clock.now = at(1_999);
    else value.clock.monotonicMs--;
    const result = compare(value, first.nextState);
    assert.ok(has(result, "clock-rollback"));
    same(result.nextState, first.nextState);
  });
}
test("same epoch with lower version or conflicting payload does not advance watermarks", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.observation.cursor.evidenceVersion--;
  value.observation.observation.evidenceVersion--;
  const stale = compare(value, first.nextState);
  assert.ok(has(stale, "evidence-reordered"));
  same(watermarks(stale), watermarks(first));
  const conflict = sample();
  conflict.observation.controls[0].source.evidenceRef = "conflict";
  assert.ok(has(compare(conflict, first.nextState), "evidence-conflict"));
});
test("projection epoch changes require a larger protected epoch version and a changed ref", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.observation.cursor.epochRef = "different-epoch";
  assert.ok(has(compare(value, first.nextState), "epoch-invalid"));
  value.observation.cursor.epochVersion++;
  value.observation.cursor.evidenceVersion = 1;
  value.observation.observation.evidenceVersion = 1;
  satisfied(compare(value, first.nextState));
  value.observation.cursor.epochRef = "fixture-projection-epoch-1";
  assert.ok(has(compare(value, first.nextState), "epoch-invalid"));
});
test("projection restart cannot reset an original control producer's history", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.observation.cursor.epochRef = "projection-restarted";
  value.observation.cursor.epochVersion++;
  value.observation.controls[0].source.evidenceVersion = 1;
  value.observation.controls[0].delivered.evidence.evidenceVersion = 1;
  value.observation.controls[0].effective.evidence.evidenceVersion = 1;
  assert.ok(has(compare(value, first.nextState), "evidence-reordered"));
});
test("original producer restart permits numbering reset only with advanced distinct epoch", () => {
  const value = sample();
  const first = satisfied(compare(value));
  advanceProjection(value);
  for (const control of value.observation.controls) {
    control.sourceEpoch = { epochRef: "control-restarted", epochVersion: 2 };
    for (const evidence of [control.source, control.delivered.evidence, control.effective.evidence])
      evidence.evidenceVersion = 1;
  }
  satisfied(compare(value, first.nextState));
  value.observation.controls[1].sourceEpoch.epochRef = "conflicting-same-producer";
  assert.ok(has(compare(value, first.nextState), "epoch-invalid"));
});
test("late success cannot revive an assignment retired under a separate projection or execution epoch", () => {
  const value = sample();
  negativeAuthority(value);
  const retired = compare(value);
  assert.equal(retired.decision, "denied");
  assert.equal(retired.nextState.retiredAssignments.length, 1);
  const late = sample();
  late.authorityResult.evaluatedAt = at(2_000);
  late.observation.cursor.epochRef = "new-observer";
  late.observation.cursor.epochVersion++;
  assert.equal(compare(late, retired.nextState).decision, "denied");
  late.expected.runtime.binding.protectedRestartDiscriminator = "new-execution-same-pod";
  late.observation.input = copy(late.expected);
  late.observation.runtimeObservation.input = copy(late.expected.runtime);
  late.observation.runtimeObservation.binding = copy(late.expected.runtime.binding);
  late.authorityResult.snapshot.binding = copy(late.expected.runtime.binding);
  assert.ok(has(compare(late, retired.nextState), "retired-assignment"));
});
test("retirement does not latch an unrelated exact assignment", () => {
  const value = sample();
  negativeAuthority(value, "assignment-replaced");
  const retired = compare(value);
  const other = sample();
  const oldId = other.expected.runtime.target.assignmentRef.id;
  const replaced = JSON.parse(JSON.stringify(other).replaceAll(oldId, id(80)));
  satisfied(compare(replaced, retired.nextState));
});
test("a failed source cannot be healed by evidence for another exact profile", () => {
  const value = sample();
  value.observation.controls[0].effective = null;
  value.observation.controls[0].outcome = "unknown";
  value.observation.controls[0].reasonCode = "evidence-incomplete";
  const failed = compare(value);
  const other = sample();
  other.expected.containmentProfile.version++;
  other.observation.input = copy(other.expected);
  const compared = satisfied(compare(other, failed.nextState));
  assert.equal(compared.nextState.subjects.length, 2);
  same(compared.nextState.subjects[0].blocked, failed.nextState.subjects[0].blocked);
});
test("malformed caller data never invokes getters or proxy traps", () => {
  let invoked = 0;
  const value = sample();
  Object.defineProperty(value, "clock", {
    enumerable: true,
    get() {
      invoked++;
      throw Error("getter");
    },
  });
  assert.ok(has(compare(value), "invalid-input"));
  const proxy = new Proxy(sample(), {
    ownKeys() {
      invoked++;
      throw Error("proxy");
    },
  });
  assert.ok(has(compare(proxy), "invalid-input"));
  assert.equal(invoked, 0);
});
test("invalid retained state produces no replacement history and duplicate slots reject", () => {
  const state = copy(satisfied(compare(sample())).nextState);
  state.subjects[0].watermarks.push(copy(state.subjects[0].watermarks[0]));
  const result = compare(sample(), state);
  assert.ok(has(result, "invalid-state"));
  assert.equal(result.nextState, null);
});
test("comparison outputs are detached and deeply immutable", () => {
  const value = sample();
  const state = copy(empty());
  const result = satisfied(compare(value, state));
  value.observation.controls[0].source.evidenceRef = "mutated";
  state.retiredAssignments.push("x".repeat(64));
  assert.equal(result.nextState.retiredAssignments.length, 0);
  assert.throws(() => {
    result.nextState.subjects[0].watermarks[0].version = 999;
  }, TypeError);
});
test("subject capacity fails closed without evicting retained retirement or producer history", () => {
  let state = empty();
  for (let i = 0; i < limits.maxSubjects; i++) {
    const value = sample();
    value.expected.containmentProfile.version += i;
    value.observation.input = copy(value.expected);
    state = satisfied(compare(value, state)).nextState;
  }
  const value = sample();
  value.expected.containmentProfile.version = 999;
  value.observation.input = copy(value.expected);
  const result = compare(value, state);
  assert.ok(has(result, "state-capacity"));
  same(result.nextState, state);
});
test("current retirement is retained even when the supplied observer evidence has expired", () => {
  const value = sample();
  negativeAuthority(value);
  value.observation.controls[0].source.clock.validUntil = at(1_500);
  const retired = compare(value);
  assert.equal(retired.decision, "denied");
  assert.ok(has(retired, "evidence-stale"));
  assert.equal(retired.nextState.retiredAssignments.length, 1);
  assert.equal(retired.nextState.subjects.length, 0);
  assert.ok(has(compare(sample(), retired.nextState), "retired-assignment"));
});
for (const [status, reasonCode] of [
  ["pending", "evidence-incomplete"],
  ["unavailable", "lookup-unavailable"],
  ["not-visible", "scope-hidden"],
]) {
  test(`original ${status} authority stays negative until a newer matching original response`, () => {
    const value = sample();
    value.authorityResult = {
      schemaVersion: 1,
      result: status,
      reasonCode,
      evaluatedAt: at(2_000),
      requestRef: value.authorityRequest.requestRef,
      ...(status === "pending" ? { purpose: value.authorityRequest.purpose } : {}),
    };
    const failed = compare(value);
    assert.notEqual(failed.decision, "satisfied");
    assert.notEqual(compare(sample(), failed.nextState).decision, "satisfied");
    const current = sample();
    current.clock.now = at(2_001);
    current.clock.monotonicMs++;
    current.authorityResult.evaluatedAt = at(2_001);
    satisfied(compare(current, failed.nextState));
  });
}
test("a preparation authority failure does not become a global latch on another original purpose", () => {
  const value = sample("identity-registration");
  negativeAuthority(value, "operation-denied");
  const failed = compare(value);
  const current = sample();
  advanceProjection(current);
  current.observation.runtimeObservation.observation.evidenceVersion++;
  current.observation.runtimeObservation.observation.evidenceRef += "-identity-ready";
  const result = satisfied(compare(current, failed.nextState));
  assert.ok(result.nextState.subjects[0].blocked.includes("authority:identity-registration"));
});
test("authority envelope refresh cannot renew an old original source version", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.authorityResult.evaluatedAt = at(2_000);
  value.authorityResult.runtimeEvidence.version--;
  assert.ok(has(compare(value, first.nextState), "evidence-reordered"));
});
test("known projection restart still rejects a decreased original source time", () => {
  const value = sample();
  const first = satisfied(compare(value));
  value.observation.cursor.epochRef = "restarted-with-old-source";
  value.observation.cursor.epochVersion++;
  value.observation.cursor.sourceObservedAt = at(900);
  value.observation.observation.clock.sourceObservedAt = at(900);
  value.observation.observation.clock.validUntil = at(15_900);
  assert.ok(has(compare(value, first.nextState), "evidence-reordered"));
});
test("producer replacement cannot silently reset an existing logical control watermark", () => {
  const value = sample();
  const first = satisfied(compare(value));
  advanceProjection(value);
  advanceControl(value);
  for (const evidence of [
    value.observation.controls[0].source,
    value.observation.controls[0].delivered.evidence,
    value.observation.controls[0].effective.evidence,
  ])
    evidence.producerRef = "replacement-producer";
  assert.ok(has(compare(value, first.nextState), "producer-changed"));
});
test("finding overflow is explicit and never truncates denial into satisfaction", () => {
  const state = copy(satisfied(compare(sample())).nextState);
  const subject = state.subjects[0];
  while (subject.watermarks.length < limits.maxWatermarksPerSubject) {
    const n = subject.watermarks.length;
    subject.watermarks.push({ ...copy(subject.watermarks[0]), slot: `fixture-reserved:${n}` });
  }
  subject.blocked = subject.watermarks.map((mark) => mark.slot);
  const result = compare(sample(), state);
  assert.ok(has(result, "state-capacity"));
  same(result.nextState, state);
});
test("malformed clocks and bounded but unsupported historical dates return a closed result", () => {
  for (const clock of [
    { now: "not-a-date", monotonicMs: 1 },
    { now: at(2_000), monotonicMs: -1 },
    { now: at(2_000), monotonicMs: NaN },
  ]) {
    const value = sample();
    value.clock = clock;
    assert.ok(has(compare(value), "invalid-input"));
  }
  const value = sample();
  negativeAuthority(value);
  value.authorityResult.evaluatedAt = "1969-12-31T23:59:59.000Z";
  assert.ok(has(compare(value), "invalid-input"));
});
test("oversized retained metadata is rejected without silently replacing protected state", () => {
  const state = copy(empty());
  state.extra = "x".repeat(limits.maxStateBytes + 1);
  const result = compare(sample(), state);
  assert.equal(result.nextState, null);
  assert.ok(has(result, "invalid-state"));
});
