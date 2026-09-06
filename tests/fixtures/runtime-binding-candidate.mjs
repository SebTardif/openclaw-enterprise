import { canonicalRuntimeEffectRequestV1 } from "@openclaw-enterprise/contracts";
import {
  copy,
  uuid,
  now,
  target,
  createRequest,
  preparedChild,
  completeObservation,
  providerObject,
  evidence,
  hash,
} from "./runtime-effects-v1/vectors.mjs";

// Synthetic port responses exercise the real consumer's representation/correlation.
// They do not authenticate a service or prove preparation, profiles, Compute or runsc.
export function bindingCandidateFixture() {
  const request = createRequest("materialize");
  const child = preparedChild();
  Object.assign(child, {
    effect: request.effect,
    guard: request.gate,
    providerTarget: request.providerTarget,
    predicate: request.predicate,
    request,
    canonicalRequestJson: canonicalRuntimeEffectRequestV1(request),
    requestBytesDigest: hash(canonicalRuntimeEffectRequestV1(request)),
  });
  const t = target();
  const assignment = {
    schemaVersion: 1,
    allocation: {
      ...t,
      assignmentRef: t.assignmentRef.id,
      servicePrincipalId: "service/agent",
      providerProfileRef: "provider-profile",
      runtimeProfileRef: "runtime-profile",
      identityProfileRef: "identity-profile",
      bindingCondition: "unbound",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    binding: { status: "unbound" },
    authority: { state: "allocated", assignmentRecordVersion: 1 },
  };
  const state = {
    status: "observed",
    guard: request.gate,
    ordinaryAdmission: "open",
    sealerAdmission: "closed",
    plan: request.plan,
    children: [child],
    authority: "current",
    evidence: evidence("gate-current"),
  };
  const observation = completeObservation();
  for (const value of Object.values(observation.profile)) value.profileRef = "runtime-profile";
  const events = [];
  let wallTime = now;
  const clock = { now: () => new Date(wallTime), monotonicMilliseconds: () => performance.now() };
  const abort = new AbortController();
  const call = {
    // Deliberately not a verified handle. The contract ports below only return test values;
    // the real authority service must reject this object without its actual producer.
    context: Object.freeze({}),
    requestRef: "request/binding",
    recipientRef: "recipient/occ",
    deadline: "2026-01-01T00:00:15.000Z",
    signal: abort.signal,
  };
  const responses = { state, observation, correlation: evidence("create-correlation") };
  const options = {
    assignment,
    child,
    guard: request.gate,
    operation: { operationRef: uuid(88), requestRef: call.requestRef },
    authorityCall: call,
    computeCall: { ...call, recipientRef: "recipient/compute" },
    clock,
    admission: {
      async readGate() {
        events.push("gate");
        return copy(responses.state);
      },
    },
    effects: {
      async discover(input) {
        events.push("discover");
        return {
          schemaVersion: 1,
          status: "exact",
          input: copy(input),
          object: providerObject(),
          correlationEvidence: copy(responses.correlation),
        };
      },
      async observe(input) {
        events.push("observe");
        return { ...copy(responses.observation), input: copy(input) };
      },
    },
  };
  return {
    options,
    responses,
    events,
    abort,
    clock,
    setTime(value) {
      wallTime = value;
    },
  };
}
