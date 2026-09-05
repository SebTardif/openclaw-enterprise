import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNTIME_AUTHORITY_PURPOSES_V1,
  RUNTIME_AUTHORITY_LIMITS_V1,
  RUNTIME_AUTHORITY_ROLE_POLICY_V1,
  RUNTIME_AUTHORITY_SERVICE_ROLES_V1,
  parseRuntimeAuthorityV1 as parse,
  parseRuntimeAuthorityJsonV1 as parseJson,
  canonicalRuntimeAuthorityMutationV1 as canonical,
  parseRuntimeMutationResultV1,
} from "../../packages/contracts/src/index.ts";
import * as v from "../fixtures/runtime-authority-v1/vectors.mjs";
import {
  classifyBinding,
  classifyReadback,
} from "../fixtures/runtime-authority-v1/run-consumer.ts";
import { classifyPurpose } from "../fixtures/runtime-authority-v1/credential-consumer.ts";

const invalid = (kind, value) =>
  assert.throws(() => parse(kind, value), { message: "Invalid runtime authority V1 value." });
test("all seven purpose requests are closed and preparation has exact retained operation identity", () => {
  assert.equal(RUNTIME_AUTHORITY_PURPOSES_V1.length, 7);
  for (const purpose of RUNTIME_AUTHORITY_PURPOSES_V1)
    parse("resolveRequest", v.resolveRequest(purpose));
  for (const purpose of ["purge", "create", "resume", "model-call-v2"])
    invalid("resolveRequest", v.resolveRequest(purpose));
  for (const purpose of [
    "identity-registration",
    "readiness-probe",
    "cleanup",
    "completed-context-restore",
  ]) {
    const request = v.resolveRequest(purpose);
    delete request.operationRef;
    invalid("resolveRequest", request);
  }
  const request = v.resolveRequest("completed-context-restore");
  request.requestedSuboperation = "appendConversation";
  invalid("resolveRequest", request);
  request.requestedSuboperation = "readImportedContext";
  parse("resolveRequest", request);
  request.purposeContract = "completed-context-restore-v2";
  invalid("resolveRequest", request);
});

test("direct gVisor binding requires exact instance, owner UIDs, profile and restart discriminator", () => {
  const binding = parse("binding", v.binding());
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.imageDigests[0]), true);
  for (const field of [
    "deploymentUid",
    "replicaSetUid",
    "podUid",
    "kubernetesNamespaceUid",
    "runscSandboxId",
    "runtimeInstanceRef",
    "protectedRestartDiscriminator",
    "runtimeBinaryDigest",
    "runtimeDistributionDigest",
    "runtimeFlagsDigest",
  ]) {
    const value = v.binding();
    delete value[field];
    invalid("binding", value);
  }
  for (const extra of [
    "openShellSandboxId",
    "observedAt",
    "latestEvidenceRef",
    "verified",
    "processId",
  ])
    invalid("binding", { ...v.binding(), [extra]: "caller-claim" });
  invalid("binding", { ...v.binding(), bindingVersion: 2 });
  invalid("binding", { ...v.binding(), platform: "kvm" });
  invalid("binding", {
    ...v.binding(),
    imageDigests: [v.binding().imageDigests[0], v.binding().imageDigests[0]],
  });
  const bind = v.bindRequest();
  bind.binding.component = "gateway";
  invalid("bind", bind);
});

test("binding identity is separate from append-only source observations", () => {
  const initial = parse("bind", v.bindRequest());
  const next = v.evidenceRequest();
  next.expectedEvidenceVersion = 1;
  next.evidence.evidenceVersion = 2;
  next.evidence.observationRef = "observation/newer";
  next.evidence.providerObservedAt = "2026-01-01T00:00:01.000Z";
  next.evidence.receivedAt = "2026-01-01T00:00:01.000Z";
  const refreshed = parse("recordEvidence", next);
  assert.deepEqual(initial.binding, refreshed.evidence.binding);
  assert.equal(refreshed.evidence.evidenceVersion, 2);
  next.expectedEvidenceVersion = 2;
  invalid("recordEvidence", next);
  const mismatch = v.evidenceRequest();
  mismatch.evidence.target.agentId = `agt_${v.id(99)}`;
  invalid("recordEvidence", mismatch);
});

test("canonical operation bytes preserve exact payload and CAS while allowing new request correlation", () => {
  const original = v.bindRequest();
  assert.equal(canonical(original), canonical({ ...original, requestRef: "request/retry" }));
  assert.equal(
    canonical(original),
    canonical(Object.fromEntries(Object.entries(original).reverse())),
  );
  for (const change of [
    (x) => {
      x.binding.podUid = v.id(90);
    },
    (x) => {
      x.binding.protectedRestartDiscriminator = "restart/new";
    },
    (x) => {
      x.target.agentId = `agt_${v.id(91)}`;
    },
    (x) => {
      x.expectedAssignmentRecordVersion = 2;
    },
    (x) => {
      x.observation.observationRef = "observation/new";
    },
  ]) {
    const changed = structuredClone(original);
    change(changed);
    assert.notEqual(canonical(original), canonical(changed));
  }
  const mismatch = v.bindRequest();
  mismatch.expectedLifecycleGeneration = 2;
  invalid("bind", mismatch);
});

test("unknown acknowledgement and missing readback cannot become create or authority permission", () => {
  const unknown = parse("mutationResult", {
    schemaVersion: 1,
    result: "commit-unknown",
    operation: v.exactOperation(),
    nextAction: "exact-readback-only",
  });
  assert.equal(classifyBinding(unknown), "readback-only");
  invalid("mutationResult", { ...unknown, nextAction: "retry-create" });
  for (const result of ["not-found", "unavailable"]) {
    const state = parse("operationState", {
      schemaVersion: 1,
      result,
      nextAction: "exact-readback-only",
    });
    assert.equal(classifyReadback(state), "readback-only");
  }
  for (const result of ["applied", "exact-replay"]) {
    const parsed = parse("mutationResult", { schemaVersion: 1, result, receipt: v.receipt() });
    assert.equal(classifyBinding(parsed), "bound-observation");
  }
  const inconsistent = v.receipt();
  inconsistent.operationKind = "retire";
  invalid("operationState", { schemaVersion: 1, result: "committed", receipt: inconsistent });
});

test("purpose-bound results have exhaustive consumers and never confer a model grant", () => {
  assert.equal(
    classifyPurpose(parse("resolveResult", v.current())),
    "separate-current-operation-authorization-required",
  );
  assert.equal(classifyPurpose(parse("resolveResult", v.candidate())), "candidate-only");
  assert.equal(classifyPurpose(parse("resolveResult", v.restore())), "candidate-only");
  assert.equal(classifyPurpose(parse("resolveResult", v.cleanup())), "cleanup-only");
  for (const value of [v.candidate(), v.restore(), v.cleanup()]) {
    invalid("resolveResult", { ...value, selectionVersion: 1 });
    invalid("resolveResult", { ...value, result: "current" });
  }
  invalid("resolveResult", { ...v.current(), purpose: "cleanup" });
  invalid("resolveResult", { ...v.current(), lifecycleGeneration: 2 });
  invalid("resolveResult", { ...v.candidate(), reasonCode: "restore-operation-eligible" });
  const restore = v.restore();
  restore.binding.completionSequence = 0;
  invalid("resolveResult", restore);
  restore.binding.completionSequence = 1;
  restore.binding.gatewayAssignmentRef = restore.binding.harnessAssignmentRef;
  invalid("resolveResult", restore);
});

test("retirement and retained cleanup carry no assertion of liveness, purge or successor authority", () => {
  // Generation 2 may withdraw generation 1; the typed target and current CAS remain distinct.
  parse("retire", v.retireRequest());
  const cleanup = parse("resolveResult", v.cleanup());
  assert.equal(Object.hasOwn(cleanup, "identityEvidence"), false);
  assert.equal(Object.hasOwn(cleanup, "selectionVersion"), false);
  for (const allowedOperation of ["create", "resume", "purge", "delete-successor"])
    invalid("resolveResult", { ...v.cleanup(), allowedOperation });
  const receipt = v.receipt();
  receipt.operationKind = "retire";
  receipt.outcome = {
    kind: "retire",
    authority: "retired",
    responsibilityRef: v.id(15),
    responsibilityVersion: 1,
    termination: "not-asserted",
    providerCredentialRevocation: "not-asserted",
  };
  parse("operationState", { schemaVersion: 1, result: "committed", receipt });
  receipt.outcome.termination = "stopped";
  invalid("operationState", { schemaVersion: 1, result: "committed", receipt });
});

test("denials are closed and not-visible cannot disclose foreign scope or existence", () => {
  const hidden = {
    schemaVersion: 1,
    result: "not-visible",
    reasonCode: "scope-hidden",
    evaluatedAt: v.now,
    requestRef: "request/example",
  };
  assert.equal(classifyPurpose(parse("resolveResult", hidden)), "deny");
  for (const key of [
    "assignmentRef",
    "namespaceId",
    "operationRef",
    "principalId",
    "reason",
    "exists",
  ])
    invalid("resolveResult", { ...hidden, [key]: "foreign-value" });
  invalid("resolveResult", { ...hidden, reasonCode: "assignment-retired" });
  for (const [result, reasonCode] of [
    ["pending", "evidence-incomplete"],
    ["not-current", "agent-stopped"],
  ])
    assert.equal(
      classifyPurpose(
        parse("resolveResult", { ...hidden, result, reasonCode, purpose: "model-call" }),
      ),
      "deny",
    );
  parse("serviceTrust", v.trust());
  invalid("serviceTrust", { ...v.trust(), role: "admin" });
  invalid("serviceTrust", { ...v.trust(), verified: true });
  const foreign = v.trust();
  foreign.allowedScope.installationId = `ins_${v.id(80)}`;
  invalid("serviceTrust", foreign);
});

test("strict codecs reject duplicate keys, authority additions, malformed IDs, versions and counters", () => {
  const request = v.bindRequest();
  parseJson("bind", JSON.stringify(request));
  for (const raw of [
    JSON.stringify(request).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify(request).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schema\\u0056ersion":1',
    ),
    JSON.stringify(request) + " null",
    "[".repeat(34) + "0" + "]".repeat(34),
    " ".repeat(65_537),
  ])
    assert.throws(() => parseJson("bind", raw), { message: "Invalid runtime authority V1 value." });
  for (const counter of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])
    invalid("bind", { ...request, expectedAssignmentRecordVersion: counter });
  invalid("bind", { ...request, schemaVersion: 2 });
  invalid("bind", {
    ...request,
    operationRef: request.operationRef.toUpperCase().replace("00000000", "ABCDEF00"),
  });
  invalid("binding", { ...v.binding(), runtimeBinaryDigest: "sha256:" + "A".repeat(64) });
  invalid("bind", { ...request, context: { verified: true } });
  const accessor = { ...request };
  Object.defineProperty(accessor, "target", {
    get() {
      assert.fail("must not evaluate getters");
    },
    enumerable: true,
  });
  invalid("bind", accessor);
  const withSymbol = { ...request, [Symbol("authority")]: true };
  invalid("bind", withSymbol);
});

test("receipt time cannot freshen stale source evidence and clocks have bounded uncertainty", () => {
  assert.equal(RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs, 15_000);
  assert.equal(RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs, 3_000);
  for (const patch of [
    { providerObservedAt: "2025-12-31T23:59:40.000Z" },
    { policyObservedAt: "2025-12-31T23:59:40.000Z" },
    { readinessObservedAt: "2025-12-31T23:59:40.000Z" },
    { providerObservedAt: "2026-01-01T00:00:03.000Z" },
    { uncertaintyMs: 2_001 },
    { receivedAt: "2026-02-30T00:00:00.000Z" },
    { validUntil: "2025-12-31T23:59:59.000Z" },
  ])
    invalid("evidence", { ...v.evidence(), ...patch });
  const expiredHistory = {
    ...v.evidence(),
    providerObservedAt: "2025-12-31T23:59:30.000Z",
    policyObservedAt: "2025-12-31T23:59:30.000Z",
    readinessObservedAt: "2025-12-31T23:59:30.000Z",
    validUntil: "2025-12-31T23:59:40.000Z",
  };
  // Historical evidence may remain a record, but a positive current result cannot refresh it.
  parse("evidence", expiredHistory);
  const stale = v.current();
  stale.runtimeEvidence.sourceObservedAt = "2025-12-31T23:59:30.000Z";
  stale.runtimeEvidence.validUntil = "2025-12-31T23:59:40.000Z";
  invalid("resolveResult", stale);
});

test("allocation projection reuses existing inert fields without treating them as a binding", () => {
  const t = v.target();
  const allocation = {
    ...v.scope,
    providerProfileRef: "provider/example",
    runtimeProfileRef: "runtime/example",
    identityProfileRef: "identity/example",
    assignmentRef: t.assignmentRef.id,
    createEffectRef: t.createEffectRef,
    revisionId: t.revisionId,
    servicePrincipalId: `service-agent-${t.agentId}`,
    lifecycleGeneration: 1,
    component: "harness",
    runtimeGeneration: 1,
    bindingCondition: "unbound",
    createdAt: v.now,
  };
  const record = {
    schemaVersion: 1,
    allocation,
    binding: { status: "unbound" },
    authority: { state: "allocated", assignmentRecordVersion: 1 },
  };
  parse("assignmentRecord", record);
  invalid("assignmentRecord", {
    ...record,
    authority: { state: "active", assignmentRecordVersion: 1 },
  });
  const bound = {
    ...record,
    binding: { status: "bound", instance: v.binding() },
    authority: { state: "bound", assignmentRecordVersion: 2 },
  };
  parse("assignmentRecord", bound);
  assert.equal(bound.allocation.bindingCondition, "unbound");
  const retirement = v.retireRequest();
  retirement.bindingVersion = null;
  parse("retire", retirement);
});

test("method-specific result parser rejects another operation's otherwise valid response", () => {
  const applied = { schemaVersion: 1, result: "applied", receipt: v.receipt() };
  assert.equal(parseRuntimeMutationResultV1("bind", applied).receipt.outcome.kind, "bind");
  assert.throws(() => parseRuntimeMutationResultV1("retire", applied));
  const unknown = {
    schemaVersion: 1,
    result: "commit-unknown",
    operation: v.exactOperation(),
    nextAction: "exact-readback-only",
  };
  assert.throws(() => parseRuntimeMutationResultV1("record-evidence", unknown));
});

test("the direct gateway has its own explicit scheduling and restart binding", () => {
  const gateway = v.binding();
  for (const field of [
    "runtimeClass",
    "runtimeHandler",
    "runtimeType",
    "platform",
    "isolation",
    "runscSandboxId",
    "runtimeBinaryDigest",
    "runtimeDistributionDigest",
    "runtimeFlagsDigest",
  ])
    delete gateway[field];
  gateway.provider = "occ/kubernetes-gateway";
  gateway.component = "gateway";
  gateway.scheduling = { mode: "default", profileRef: "scheduling/default-v1" };
  parse("binding", gateway);
  invalid("binding", { ...gateway, openShellSandboxId: "invented" });
  delete gateway.protectedRestartDiscriminator;
  invalid("binding", gateway);
});

test("cleanup can remove an exact owned provider object before any instance binding exists", () => {
  const parsed = parse("resolveResult", v.unboundCleanup());
  assert.equal(classifyPurpose(parsed), "cleanup-only");
  assert.equal(parsed.targetKind, "owned-provider-object");
  assert.equal(Object.hasOwn(parsed.providerObject, "podUid"), false);
  for (const field of ["deploymentUid", "kubernetesNamespaceUid", "clusterRef"]) {
    const value = v.unboundCleanup();
    delete value.providerObject[field];
    invalid("resolveResult", value);
  }
  for (const field of [
    "ownershipEvidence",
    "successorExclusionEvidence",
    "effectPreconditionEvidence",
    "cleanupPolicyEvidence",
  ]) {
    const value = v.unboundCleanup();
    delete value[field];
    invalid("resolveResult", value);
  }
  for (const allowedOperation of ["create", "purge", "resume", "retire-registration"])
    invalid("resolveResult", { ...v.unboundCleanup(), allowedOperation });
  const forged = v.unboundCleanup();
  forged.providerObject.podUid = "invented";
  invalid("resolveResult", forged);
  const mismatch = v.unboundCleanup();
  mismatch.target.component = "gateway";
  invalid("resolveResult", mismatch);
});

test("record-evidence success, replay and committed readback do not require request-only CAS fields", () => {
  const receipt = v.receipt();
  receipt.operationKind = "record-evidence";
  receipt.operationRef = v.id(13);
  receipt.outcome = { kind: "record-evidence", evidence: v.evidence() };
  for (const result of ["applied", "exact-replay"]) {
    const decoded = parseRuntimeMutationResultV1("record-evidence", {
      schemaVersion: 1,
      result,
      receipt,
    });
    assert.equal(decoded.receipt.outcome.evidence.evidenceVersion, 1);
  }
  const readback = parse("operationState", { schemaVersion: 1, result: "committed", receipt });
  assert.equal(classifyReadback(readback), "receipt-only");
  const missingCAS = v.evidenceRequest();
  delete missingCAS.expectedEvidenceVersion;
  invalid("recordEvidence", missingCAS);
});

test("raw JSON fractional and noncanonical integer lexemes cannot round into valid counters", () => {
  const request = JSON.stringify(v.bindRequest());
  for (const value of [
    "9007199254740991.1",
    "1.0000000000000001",
    "1.0",
    "1e0",
    "-0",
    "9007199254740992",
  ]) {
    const raw = request.replace(
      '"expectedAssignmentRecordVersion":1',
      `"expectedAssignmentRecordVersion":${value}`,
    );
    assert.throws(() => parseJson("bind", raw), { message: "Invalid runtime authority V1 value." });
  }
  parseJson(
    "bind",
    request.replace(
      '"expectedAssignmentRecordVersion":1',
      '"expectedAssignmentRecordVersion":9007199254740991',
    ),
  );
});

test("the closed service-role policy separates producers, writers, purposes and receiver reports", () => {
  const policy = RUNTIME_AUTHORITY_ROLE_POLICY_V1;
  assert.deepEqual(Object.keys(policy).sort(), [...RUNTIME_AUTHORITY_SERVICE_ROLES_V1].sort());
  assert.deepEqual(policy["compute-observer"].mutations, ["bind", "record-evidence:runtime"]);
  assert.deepEqual(policy["identity-verifier"].mutations, ["record-evidence:identity"]);
  assert.deepEqual(policy["lifecycle-authority"].mutations, ["bind", "retire"]);
  assert.deepEqual(policy["model-mediator"].purposes, ["model-call"]);
  assert.deepEqual(policy["repository-issuer"].purposes, ["repository-issuance"]);
  assert.deepEqual(policy.cleanup.purposes, ["cleanup"]);
  assert.equal(policy.cleanup.operationRead, "accepted-cleanup-responsibility");
  assert.deepEqual(policy["restore-preparer"].restoreSuboperations, [
    "importCompletedContext",
    "readImportedContext",
  ]);
  assert.deepEqual(policy["restore-receiver"].purposes, []);
  assert.deepEqual(policy["restore-receiver"].restoreSuboperations, []);
  assert.equal(Object.hasOwn(policy, "admin"), false);
  assert.equal(Object.isFrozen(policy["restore-preparer"].restoreSuboperations), true);
});

test("evidence receipts keep outer scope and assignment equal to the exact nested target", () => {
  for (const field of ["installationId", "namespaceId", "agentId", "assignmentRef"]) {
    const receipt = v.receipt();
    receipt.operationKind = "record-evidence";
    receipt.operationRef = v.id(13);
    receipt.outcome = { kind: "record-evidence", evidence: v.evidence() };
    const target = receipt.outcome.evidence.target;
    target[field] =
      field === "assignmentRef"
        ? { schemaVersion: 1, id: v.id(90) }
        : `${{ installationId: "ins", namespaceId: "ns", agentId: "agt" }[field]}_${v.id(90)}`;
    for (const result of ["applied", "exact-replay"])
      invalid("mutationResult", { schemaVersion: 1, result, receipt });
    invalid("operationState", { schemaVersion: 1, result: "committed", receipt });
  }
});
