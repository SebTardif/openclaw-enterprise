// Synthetic original-contract evidence; no authenticated service or admitted profile.
import {
  request,
  response,
  copy,
  evidence,
  policy,
  id,
  digest,
} from "../containment-controls-v1/values.mjs";
export { copy, evidence, policy, id, digest };
export const at = (ms) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms).toISOString();
export function source(version = 2, ms = 1_000) {
  return {
    reference: "fixture/authority-evidence",
    version,
    sourceObservedAt: at(ms),
    receivedAt: at(ms + 100),
    validUntil: at(ms + 15_000),
    uncertaintyMs: 100,
  };
}
export function sample(purpose = "model-call") {
  const expected = request();
  const observation = response(expected);
  const runtime = observation.runtimeObservation;
  runtime.profile = {
    desired: policy(4),
    delivered: { ...policy(4), evidence: evidence("fixture-runtime") },
    effective: { ...policy(4), evidence: evidence("fixture-runtime") },
  };
  const target = expected.runtime.target;
  const snapshot = {
    target: copy(target),
    binding: copy(expected.runtime.binding),
    assignmentRecordVersion: 2,
    providerProfileRef: "fixture-provider-profile",
    runtimeProfileRef: policy(4).profileRef,
    identityProfileRef: "fixture-identity-profile",
    profileDigests: copy(expected.runtime.binding.profileDigests),
  };
  const registration = () => ({
    registrationId: "fixture-registration",
    registrationVersion: 2,
    bundleSetVersion: 1,
    identityProfileRef: snapshot.identityProfileRef,
    evidence: source(),
  });
  const authorityRequest = {
    schemaVersion: 1,
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
    assignmentRef: copy(target.assignmentRef),
    requestRef: "fixture/authority-request",
    purpose,
  };
  const common = {
    schemaVersion: 1,
    evaluatedAt: at(1_100),
    validUntil: at(15_000),
    requestRef: authorityRequest.requestRef,
    purpose,
    snapshot,
    runtimeEvidence: source(),
    policyEvidence: source(),
  };
  let authorityResult;
  if (purpose === "identity-registration" || purpose === "readiness-probe") {
    authorityRequest.operationRef = id(30);
    authorityRequest.expectedResponsibilityVersion = 1;
    authorityResult = {
      ...common,
      result: "candidate-eligible",
      operationRef: id(30),
      responsibilityVersion: 1,
      ...(purpose === "identity-registration"
        ? {
            reasonCode: "registration-allowed",
            allowedOperation: "register",
            registrationTemplateRef: "fixture/template",
            parentBindingRef: "fixture/parent",
            selectorEvidenceRef: "fixture/selectors",
          }
        : {
            reasonCode: "probe-allowed",
            allowedOperation: "readiness-probe",
            peerPairingRef: "fixture/pairing",
            peerPairingVersion: 1,
            permittedEndpointRef: "fixture/endpoint",
            peer: {
              ...copy(snapshot),
              target: { ...copy(target), assignmentRef: { schemaVersion: 1, id: id(31) } },
            },
            identityEvidence: registration(),
            peerIdentityEvidence: registration(),
          }),
    };
  } else {
    authorityResult = {
      ...common,
      result: "current",
      reasonCode: "conditions-satisfied",
      lifecycleGeneration: 1,
      selectionVersion: 1,
      identityEvidence: registration(),
      servingEvidence: source(),
      mutationEligibilityEvidence: source(),
    };
  }
  if (purpose !== "identity-registration")
    runtime.identityEvidence = {
      schemaVersion: 1,
      kind: "identity",
      target: copy(target),
      bindingVersion: 1,
      evidenceVersion: 2,
      verifierEvidenceRef: "fixture/identity-verifier",
      registrationId: "fixture-registration",
      registrationVersion: 2,
      identityProfileRef: snapshot.identityProfileRef,
      verifiedAt: at(1_000),
      receivedAt: at(1_100),
      expiresAt: at(16_000),
      uncertaintyMs: 100,
      outcome: { result: "verified", reasonCode: "peer-verified" },
    };
  return {
    expected,
    observation,
    authorityRequest,
    authorityResult,
    clock: { now: at(2_000), monotonicMs: 2_000 },
  };
}
export function advanceProjection(value, n = 1, ms = 1_000) {
  value.observation.cursor.evidenceVersion += n;
  value.observation.observation.evidenceVersion += n;
  value.observation.observation.evidenceRef += `-${n}`;
  value.observation.cursor.sourceObservedAt = at(ms);
  value.observation.observation.clock.sourceObservedAt = at(ms);
  value.observation.observation.clock.receivedAt = at(ms + 100);
  value.observation.observation.clock.validUntil = at(ms + 15_000);
}
export function advanceControl(value, index = 0) {
  const control = value.observation.controls[index];
  control.source.evidenceVersion++;
  control.source.evidenceRef += "-next";
}
export function negativeAuthority(value, reasonCode = "assignment-retired", ms = 2_000) {
  value.authorityResult = {
    schemaVersion: 1,
    evaluatedAt: at(ms),
    requestRef: value.authorityRequest.requestRef,
    result: "not-current",
    purpose: value.authorityRequest.purpose,
    reasonCode,
  };
}
export function allClocks(value, ms = 1_000, uncertainty = 0) {
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const key of ["sourceObservedAt", "verifiedAt"]) if (key in node) node[key] = at(ms);
    if ("receivedAt" in node) node.receivedAt = at(ms);
    if ("validUntil" in node) node.validUntil = at(ms + 15_000);
    if ("expiresAt" in node) node.expiresAt = at(ms + 15_000);
    if ("uncertaintyMs" in node) node.uncertaintyMs = uncertainty;
    for (const child of Object.values(node)) walk(child);
  };
  walk(value);
  value.authorityResult.evaluatedAt = at(ms);
}
