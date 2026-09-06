import assert from "node:assert/strict";
import test from "node:test";
import {
  PreparationJobSchemasV1,
  PREPARATION_JOB_LIMITS_V1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import {
  parsePreparationJobV1 as parse,
  parsePreparationJobJsonV1 as json,
  preparationJobMutationDigestV1,
  preparationJobAttemptManifestDigestV1,
  preparationJobAdmissionManifestDigestV1,
  parsePreparationJobAdmissionExchangeV1 as admissionExchange,
  parsePreparationJobMutationExchangeV1 as mutationExchange,
  parsePreparationJobReadExchangeV1 as readExchange,
  parsePreparationJobClosureExchangeV1 as closureExchange,
  parsePreparationJobReceiptPairV1 as receiptPair,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
import {
  scenario,
  admissionSnapshot,
  observation,
  closure,
  read,
  clock,
  provenance,
  unknown,
  clone,
  at,
  id,
  digest,
} from "../fixtures/preparation-job-v1/vectors.mjs";

const invalid = (run) =>
  assert.throws(run, { name: "TypeError", message: "Invalid preparation Job V1 value" });
const changed = (value, edit) => {
  const copy = clone(value);
  edit(copy);
  return copy;
};

test("actual exported schemas parse the separate Job lifecycle and freeze accepted values", () => {
  const s = scenario();
  for (const key of ["target", "plan", "reserve", "release", "seal", "terminate", "identity"]) {
    const value = parse(key, s[key]);
    assert.deepEqual(value, s[key]);
    assert.ok(Object.isFrozen(value));
  }
  assert.deepEqual(parse("observation", observation(s)), observation(s));
  assert.deepEqual(parse("closure", closure(s)), closure(s));
  assert.deepEqual(receiptPair(s.pair, s.release, clock()), s.pair);
  assert.ok(Object.isFrozen(PreparationJobSchemasV1));
  assert.ok(Object.isFrozen(parse("target", s.target).preparation.gate));
});

test("checkout, reserve and release retain distinct canonical request digests", () => {
  const s = scenario();
  assert.equal(s.pair.receipt.effectRequestDigest, s.reserve.checkout.requestDigest);
  assert.equal(s.reserve.checkout.effectRef, s.release.effectRef);
  assert.equal(
    new Set([s.reserve.requestDigest, s.release.requestDigest, s.reserve.checkout.requestDigest])
      .size,
    3,
  );
  invalid(() =>
    parse(
      "receiptPair",
      changed(s.pair, (p) => {
        p.receipt.effectRequestDigest = s.release.requestDigest;
      }),
    ),
  );
  invalid(() =>
    parse(
      "receiptPair",
      changed(s.pair, (p) => {
        p.receipt.effectRef = s.reserve.effectRef;
      }),
    ),
  );
});

for (const [label, edit] of [
  [
    "Deployment target",
    (x) => {
      x.apiKind = "Deployment";
    },
  ],
  [
    "Harness purpose",
    (x) => {
      x.purpose = "original-turn-runtime";
    },
  ],
  [
    "cross-scope subject",
    (x) => {
      x.preparation.gate.scope.agentId = `agt_${id(77)}`;
    },
  ],
  [
    "implicit TTL root deletion",
    (x) => {
      x.ttlSecondsAfterFinished = 0;
    },
  ],
  [
    "invalid Kubernetes name",
    (x) => {
      x.name = "candidate-";
    },
  ],
])
  test(`reject ${label}`, () => invalid(() => parse("target", changed(scenario().target, edit))));

for (const [label, edit] of [
  [
    "wrong owner incarnation",
    (x) => {
      x.predicate.ownerIncarnationRef = "incarnation/other";
    },
  ],
  [
    "wrong Namespace UID",
    (x) => {
      x.predicate.namespaceUid = "other-namespace";
    },
  ],
  [
    "missing resourceVersion predicate",
    (x) => {
      delete x.predicate.resourceVersion;
    },
  ],
  [
    "new release effect",
    (x) => {
      x.effectRef = id(79);
    },
  ],
  [
    "changed release intent",
    (x) => {
      x.gate.intentRef = id(95);
    },
  ],
  [
    "extended original deadline",
    (x) => {
      x.original.deadline = at(6000);
    },
  ],
  [
    "changed admission plan",
    (x) => {
      x.original.plan.jobSpecDigest = `sha256:${"b".repeat(64)}`;
    },
  ],
])
  test(`reject mutation with ${label}`, () => {
    const value = changed(scenario().release, edit);
    invalid(() => preparationJobMutationDigestV1(value));
  });

test("canonical mutation digest binds every original deadline and request byte", () => {
  const s = scenario();
  const changedDeadline = { ...s.reserve, deadline: at(4000) };
  assert.notEqual(preparationJobMutationDigestV1(changedDeadline), s.reserve.requestDigest);
  invalid(() => parse("reserve", changedDeadline));
  const changedRequest = { ...s.reserve, requestId: `req_${id(80)}` };
  assert.notEqual(preparationJobMutationDigestV1(changedRequest), s.reserve.requestDigest);
});

test("cleanup keeps the immutable original running subject while using a later protective guard", () => {
  const s = scenario();
  assert.equal(s.seal.original.target.preparation.gate.mode, "running");
  assert.equal(s.seal.gate.mode, "stopped");
  assert.equal(s.seal.gate.responsibility.kind, "protective-fence");
  assert.ok(Date.parse(s.seal.createdAt) > Date.parse(s.reserve.deadline));
  assert.deepEqual(parse("seal", s.seal), s.seal);
  invalid(() =>
    preparationJobMutationDigestV1(
      changed(s.seal, (x) => {
        x.cleanupBinding.responsibility.responsibilityRef = id(90);
        x.gate = clone(s.guard);
      }),
    ),
  );
  invalid(() =>
    preparationJobMutationDigestV1(
      changed(s.seal, (x) => {
        x.original.target.preparation.gate = clone(s.guard);
      }),
    ),
  );
});

test("an acknowledged cancellation does not prove termination or writer exclusion", () => {
  const s = scenario();
  const result = {
    status: "acknowledged",
    original: s.seal,
    providerReceiptRef: "receipt/seal",
    physicalOutcome: "unproven",
    provenance: provenance("job-controller", 7000),
  };
  assert.equal(mutationExchange(s.seal, result, clock(7000)).physicalOutcome, "unproven");
  invalid(() => parse("mutationResult", { ...result, physicalOutcome: "terminated" }));
  invalid(() => parse("closureResult", { status: "closed", closure: result }));
});

test("lost create acknowledgment remains attached to the original effect and digest", () => {
  const s = scenario(),
    result = unknown(s.reserve);
  assert.deepEqual(mutationExchange(s.reserve, result, clock(8000)), result);
  const request = read(s.reserve, "discover-job", s.reserve.gate, 8000);
  assert.deepEqual(
    readExchange(request, { ...result, reason: "not-visible" }, clock(8000)).original,
    s.reserve,
  );
  invalid(() => readExchange(request, unknown({ ...s.reserve, effectRef: id(81) }), clock(8000)));
});

test("exact readback preserves historical acknowledgment source time with a fresh readback observation", () => {
  const s = scenario();
  const historical = {
    status: "acknowledged",
    original: s.reserve,
    providerReceiptRef: "receipt/reserve",
    physicalOutcome: "unproven",
    provenance: provenance("job-controller", 1000),
  };
  const result = {
    status: "effect-record",
    original: s.reserve,
    result: historical,
    provenance: provenance("job-controller", 20000),
  };
  const request = read(s.reserve, "read-original-effect", s.guard, 20000);
  const parsed = readExchange(request, result, clock(20000));
  assert.equal(parsed.result.provenance.clock.sourceObservedAt, at(1000));
  invalid(() =>
    readExchange(
      request,
      changed(result, (x) => {
        x.provenance = provenance("job-controller", 1000);
      }),
      clock(20000),
    ),
  );
});

for (const [label, edit] of [
  [
    "wrong Job ancestor",
    (x) => {
      x.pod.controllerUid = "foreign-job";
    },
  ],
  [
    "cross-Pod execution",
    (x) => {
      x.execution.podUid = "foreign-pod";
    },
  ],
  [
    "stale authorization generation",
    (x) => {
      x.authorizationGeneration++;
    },
  ],
  [
    "stale lifecycle generation",
    (x) => {
      x.lifecycleGeneration++;
    },
  ],
  [
    "wrong fence epoch",
    (x) => {
      x.fenceEpoch++;
    },
  ],
  [
    "one duplicated source",
    (x) => {
      x.runtime.evidenceRef = x.controlPlane.evidenceRef;
    },
  ],
])
  test(`identity rejects ${label}`, () =>
    invalid(() => parse("identity", changed(scenario().identity, edit))));

test("receipt pairing rejects foreign grant, commit, runtime profile and replaced identity", () => {
  const s = scenario();
  for (const edit of [
    (p) => {
      p.receipt.actualCommit.oid = "b".repeat(40);
    },
    (p) => {
      p.receipt.request.preparation.grant.version++;
    },
    (p) => {
      p.identity.target.preparation.incarnationRef = "incarnation/replaced";
    },
    (p) => {
      p.identity.execution.runscExecutableDigest = `sha256:${"b".repeat(64)}`;
    },
    (p) => {
      p.identity.runtime.producerRef = "producer/self";
    },
  ])
    invalid(() => receiptPair(changed(s.pair, edit), s.release, clock()));
  invalid(() => receiptPair(s.pair, s.release, clock(6000)));
});

for (const [label, edit] of [
  [
    "truncated Pod listing",
    (x) => {
      x.collection.state = "incomplete";
    },
  ],
  [
    "advanced guard after await",
    (x) => {
      x.gate.gateVersion++;
    },
  ],
  [
    "replayed control-plane source",
    (x) => {
      x.controlPlane.clock = clock(0);
    },
  ],
  [
    "late child past observed cutoff",
    (x) => {
      x.collection.observedChildCutoff++;
    },
  ],
  [
    "wrong authenticated producer reference",
    (x) => {
      x.runtime.producerRef = "producer/unaccepted";
    },
  ],
])
  test(`observation exchange rejects ${label}`, () => {
    const s = scenario();
    const ms = label.startsWith("replayed") ? 10000 : 1000;
    const request = read(s.release, "observe-job", s.release.gate, ms);
    const base = { status: "observed", original: s.release, observation: observation(s, ms) };
    assert.deepEqual(readExchange(request, base, clock(ms)), base);
    invalid(() =>
      readExchange(request, { ...base, observation: changed(base.observation, edit) }, clock(ms)),
    );
  });

test("multiple runtime executions for the same Pod remain distinct observed identities", () => {
  const s = scenario(),
    value = observation(s);
  value.executions.push({
    ...clone(s.execution),
    executionRef: "execution/restart",
    executionGeneration: 2,
    sandboxId: "sandbox/restart",
  });
  assert.equal(parse("observation", value).executions.length, 2);
  invalid(() =>
    parse(
      "observation",
      changed(value, (x) => {
        x.executions[1].executionRef = x.executions[0].executionRef;
      }),
    ),
  );
});

for (const [label, edit] of [
  [
    "late child beyond closed cutoff",
    (x) => {
      x.attempts[2].admittedSequence = 4;
    },
  ],
  [
    "missing node runtime domain",
    (x) => {
      x.producerDomains.pop();
    },
  ],
  [
    "duplicate domain replacing missing producer",
    (x) => {
      x.producerDomains[2] = clone(x.producerDomains[1]);
    },
  ],
  [
    "unresolved controller create",
    (x) => {
      x.producerDomains[0].unresolvedAttempts = 1;
    },
  ],
  [
    "unresolved runtime writer",
    (x) => {
      x.producerDomains[1].unresolvedWriters = 1;
    },
  ],
  [
    "unsealed future restart",
    (x) => {
      x.producerDomains[1].futureStarts = "open";
    },
  ],
  [
    "foreign root UID",
    (x) => {
      x.root.uid = "replacement-job";
    },
  ],
  [
    "foreign terminated Pod ancestor",
    (x) => {
      x.attempts[2].pod.jobUid = "replacement-job";
    },
  ],
  [
    "wrong retained staging",
    (x) => {
      x.staging.bindingVersion++;
    },
  ],
  [
    "stale producer seal",
    (x) => {
      x.producerDomains[1].sealVersion--;
    },
  ],
  [
    "removed retained original attempt",
    (x) => {
      x.attempts.shift();
    },
  ],
])
  test(`closure rejects ${label}`, () => {
    const value = changed(closure(scenario()), edit);
    // Recompute the data manifest only when its shape is valid: this proves the
    // rejection comes from cross-record semantics, not just a stale self digest.
    try {
      value.attemptManifestDigest = preparationJobAttemptManifestDigestV1(value.attempts);
    } catch {}
    invalid(() => parse("closure", value));
  });

test("closure exchange binds the current guard after await and each independent source", () => {
  const s = scenario(),
    request = read(s.seal, "read-closure", s.guard, 7000, admissionSnapshot(s));
  const result = { status: "closed", closure: closure(s) };
  assert.deepEqual(closureExchange(request, result, clock(7000)), result);
  invalid(() =>
    closureExchange({ ...request, gate: { ...request.gate, gateVersion: 3 } }, result, clock(7000)),
  );
  invalid(() =>
    closureExchange(
      read(s.seal, "read-closure", s.guard, 25000, admissionSnapshot(s)),
      result,
      clock(25000),
    ),
  );
  invalid(() => closureExchange(read(s.seal, "observe-job", s.guard, 7000), result, clock(7000)));
});

test("unknown, unsupported and incomplete results cannot become positive observations", () => {
  const s = scenario();
  for (const status of [
    "unsupported",
    "incomplete",
    "ambiguous",
    "unknown",
    "conflict",
    "denied",
  ]) {
    const result = { ...unknown(s.reserve), status };
    assert.equal(parse("readResult", result).status, status);
    invalid(() => parse("readResult", { ...result, ready: true }));
    invalid(() => parse("closureResult", { ...result, status: "closed" }));
  }
});

test("raw JSON rejects duplicate decoded keys, rounded numbers and extra authority fields", () => {
  const s = scenario(),
    text = JSON.stringify(s.target);
  assert.deepEqual(json("target", text), s.target);
  invalid(() =>
    json("target", text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
  );
  invalid(() =>
    json("target", text.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1')),
  );
  invalid(() => json("target", text.replace('"schemaVersion":1', '"schemaVersion":1e0')));
  invalid(() =>
    json("target", text.replace('"schemaVersion":1', '"schemaVersion":9007199254740993')),
  );
  invalid(() => json("target", " ".repeat(PREPARATION_JOB_LIMITS_V1.maxJsonBytes + 1)));
  invalid(() =>
    parse(
      "target",
      changed(s.target, (x) => {
        x.preparation.gate.scope.authority = true;
      }),
    ),
  );
});

test("plain-data guards reject getters, proxies, cycles, invalid times and unsafe counters", () => {
  const s = scenario();
  let accessed = false;
  const getter = clone(s.target);
  Object.defineProperty(getter, "name", {
    enumerable: true,
    get() {
      accessed = true;
      return "candidate";
    },
  });
  invalid(() => parse("target", getter));
  assert.equal(accessed, false);
  invalid(() => parse("target", new Proxy(s.target, {})));
  const cycle = clone(s.target);
  cycle.extra = cycle;
  invalid(() => parse("target", cycle));
  invalid(() =>
    parse(
      "target",
      changed(s.target, (x) => {
        x.preparation.createdAt = "2026-02-30T00:00:00.000Z";
      }),
    ),
  );
  invalid(() =>
    parse(
      "target",
      changed(s.target, (x) => {
        x.preparation.authorizationGeneration = Number.MAX_SAFE_INTEGER + 1;
      }),
    ),
  );
  invalid(() =>
    parse(
      "identity",
      changed(s.identity, (x) => {
        x.runtime.clock.uncertaintyMs = -0;
      }),
    ),
  );
});

test("release accepts only canonical gate-version/cutoff advancement with exact responsibility", () => {
  const s = scenario();
  const candidate = {
    ...s.release,
    gate: { ...s.release.gate, gateVersion: 2, admittedChildCutoff: 1 },
  };
  const current = { ...candidate, requestDigest: preparationJobMutationDigestV1(candidate) };
  assert.deepEqual(parse("release", current), current);
  assert.deepEqual(current.original, s.reserve);
  invalid(() =>
    preparationJobMutationDigestV1(
      changed(current, (x) => {
        x.gate.responsibility.responsibilityVersion++;
      }),
    ),
  );
  invalid(() =>
    preparationJobMutationDigestV1(
      changed(current, (x) => {
        x.gate.planVersion++;
      }),
    ),
  );
});

test("known Job UID stays exact when every returned descendant consistently changes to a replacement", () => {
  const s = scenario();
  const value = observation(s);
  value.job.uid = "replacement-job";
  value.pods.forEach((p) => {
    p.jobUid = "replacement-job";
    p.controllerUid = "replacement-job";
  });
  assert.deepEqual(parse("observation", value), value);
  invalid(() =>
    readExchange(
      read(s.release),
      { status: "observed", original: s.release, observation: value },
      clock(),
    ),
  );
  const result = closure(s);
  result.root.uid = "replacement-job";
  result.attempts.forEach((a) => {
    if (a.outcome === "inert-root") a.rootUid = "replacement-job";
    if (a.outcome === "terminated") {
      a.pod.jobUid = "replacement-job";
      a.pod.controllerUid = "replacement-job";
    }
  });
  result.attemptManifestDigest = preparationJobAttemptManifestDigestV1(result.attempts);
  assert.deepEqual(parse("closure", result), result);
  invalid(() =>
    closureExchange(
      read(s.seal, "read-closure", s.guard, 7000, admissionSnapshot(s)),
      { status: "closed", closure: result },
      clock(7000),
    ),
  );
});

test("current observed resourceVersion advances while exact root owner and sealed epoch remain bound", () => {
  const s = scenario(),
    value = observation(s);
  assert.notEqual(value.job.resourceVersion, s.release.predicate.resourceVersion);
  assert.equal(
    readExchange(
      read(s.release),
      { status: "observed", original: s.release, observation: value },
      clock(),
    ).status,
    "observed",
  );
  invalid(() =>
    parse(
      "observation",
      changed(value, (x) => {
        x.job.ownerIncarnationRef = "incarnation/replacement";
      }),
    ),
  );
  invalid(() =>
    parse(
      "closure",
      changed(closure(s), (x) => {
        x.root.fenceEpoch = 1;
      }),
    ),
  );
});

for (const removed of ["attempt/release", "attempt/pod", "attempt/execution"])
  test(`canonical admission rejects omitted ${removed} even with a recomputed resolution digest`, () => {
    const value = closure(scenario());
    value.attempts = value.attempts.filter((a) => a.attemptRef !== removed);
    value.attemptManifestDigest = preparationJobAttemptManifestDigestV1(value.attempts);
    invalid(() => parse("closure", value));
  });

test("rewriting both local manifests cannot replace the independently retained admission snapshot", () => {
  const s = scenario(),
    expected = admissionSnapshot(s),
    value = closure(s);
  value.attempts = value.attempts.slice(0, 1);
  value.admission.members = value.admission.members.slice(0, 1);
  value.admission.manifestDigest = preparationJobAdmissionManifestDigestV1(value.admission.members);
  value.attemptManifestDigest = preparationJobAttemptManifestDigestV1(value.attempts);
  assert.deepEqual(parse("closure", value), value);
  invalid(() =>
    closureExchange(
      read(s.seal, "read-closure", s.guard, 7000, expected),
      { status: "closed", closure: value },
      clock(7000),
    ),
  );
});

test("same-Pod restart and delayed retry in the retained manifest require their own physical resolutions", () => {
  const s = scenario(),
    value = closure(s);
  const restart = {
    attemptRef: "attempt/restart",
    effectRef: id(96),
    requestDigest: digest,
    domainRef: "domain/node-runtime",
    admittedSequence: 4,
  };
  value.admission.members.push(restart);
  value.admission.gate.admittedChildCutoff = 4;
  value.admission.closedChildCutoff = 4;
  value.admission.manifestDigest = preparationJobAdmissionManifestDigestV1(value.admission.members);
  value.gate.admittedChildCutoff = 4;
  value.closedChildCutoff = 4;
  value.storeEvidence.closedChildCutoff = 4;
  value.producerDomains.forEach((d) => {
    d.closedChildCutoff = 4;
  });
  invalid(() => parse("closure", value));
  value.attempts.push({
    ...restart,
    outcome: "terminated",
    pod: clone(s.pod),
    execution: {
      ...clone(s.execution),
      executionRef: "execution/restarted",
      executionGeneration: 2,
      sandboxId: "sandbox/restarted",
    },
    finalState: "execution-terminated",
    resolutionEvidenceRef: value.producerDomains[1].provenance.evidenceRef,
  });
  value.attemptManifestDigest = preparationJobAttemptManifestDigestV1(value.attempts);
  assert.deepEqual(parse("closure", value), value);
});

test("admission currentness after await preserves identity, membership and actual source provenance", () => {
  const s = scenario(),
    snapshot = admissionSnapshot(s),
    request = read(s.seal, "read-admission", s.guard, 7000);
  const result = { status: "admitted", snapshot };
  assert.deepEqual(admissionExchange(request, result, clock(7000)), result);
  invalid(() =>
    admissionExchange(
      request,
      changed(result, (x) => {
        x.snapshot.snapshotVersion++;
      }),
      clock(8000),
      snapshot,
    ),
  );
  invalid(() =>
    admissionExchange(
      request,
      changed(result, (x) => {
        x.snapshot.provenance.clock = clock(8000);
      }),
      clock(8000),
      snapshot,
    ),
  );
  const reobserved = changed(result, (x) => {
    x.snapshot.provenance.clock = clock(8000);
    x.snapshot.provenance.evidenceVersion++;
  });
  assert.deepEqual(admissionExchange(request, reobserved, clock(8000), snapshot), reobserved);
  invalid(() =>
    admissionExchange(
      read(s.seal, "read-admission", s.guard, 25000),
      result,
      clock(25000),
      snapshot,
    ),
  );
});

test("a prevented sole release cannot coexist with executed descendants in positive closure", () => {
  const value = closure(scenario());
  const { originalEffectOutcome: _history, ...release } = value.attempts[1];
  value.attempts[1] = { ...release, outcome: "prevented", prevention: "sealed-admission" };
  value.attemptManifestDigest = preparationJobAttemptManifestDigestV1(value.attempts);
  invalid(() => parse("closure", value));
});
