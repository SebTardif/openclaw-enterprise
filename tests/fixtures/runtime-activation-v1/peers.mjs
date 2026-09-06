import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CONTAINMENT_CONTROL_KINDS_V1 } from "@openclaw-enterprise/contracts/containment-controls-v1";
import { canonicalRuntimeAuthorityMutationV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { emptyContainmentEvidenceStateV1 } from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import { sample, policy, copy, at, source } from "../containment-evidence-v1/values.mjs";
import { response } from "../containment-controls-v1/values.mjs";
import * as effects from "../runtime-effects-v1/vectors.mjs";
import {
  Clock,
  deferred,
  settle,
  receipt as faultReceipt,
} from "../containment-evidence-v1/fault-values.mjs";

// Explicitly controlled original-port values. No peer here authenticates a caller,
// admits a profile, persists a transaction, or observes a real provider or writer.
export { copy, at, deferred, settle, effects };
export const same = (left, right) => assert.deepEqual(copy(left), copy(right));
export const names = (s) => s.events.map(([name]) => name);
export const count = (s, name) => names(s).filter((value) => value === name).length;
export function freshCall(s, requestRef) {
  const context = Object.freeze({ controlledIndependentHandle: requestRef });
  s.callContexts.set(requestRef, context);
  return { ...s.call, context, requestRef, signal: new AbortController().signal };
}

export function activationInput() {
  const value = sample("readiness-probe");
  const route = effects.routeRequest();
  const target = copy(route.effect.target);
  const binding = copy(route.desiredRoute.binding);
  const expected = value.expected;
  expected.requestRef = effects.uuid(910);
  expected.runtime = {
    schemaVersion: 1,
    kind: "bound-instance",
    target,
    binding,
    expectedEvidenceVersion: 1,
  };
  expected.requiredControls = CONTAINMENT_CONTROL_KINDS_V1.map((control, i) => ({
    control,
    desired: policy(20 + i),
  }));
  const observation = response(expected);
  observation.runtimeObservation.profile = copy(value.observation.runtimeObservation.profile);
  observation.runtimeObservation.identityEvidence = {
    ...value.observation.runtimeObservation.identityEvidence,
    target: copy(target),
  };
  observation.runtimeObservation.object.target = effects.providerTarget(2);
  const authority = {
    ...value.authorityRequest,
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
    assignmentRef: copy(target.assignmentRef),
    requestRef: expected.requestRef,
    operationRef: route.effect.responsibility.responsibilityRef,
  };
  const authorityResult = {
    ...value.authorityResult,
    requestRef: authority.requestRef,
    operationRef: authority.operationRef,
    snapshot: {
      ...value.authorityResult.snapshot,
      target: copy(target),
      binding: copy(binding),
      profileDigests: copy(binding.profileDigests),
    },
  };
  const state = {
    schemaVersion: 1,
    version: 1,
    evidence: emptyContainmentEvidenceStateV1(),
    cursor: null,
    activationClosed: false,
    operations: [],
  };
  const input = {
    state,
    selection: {
      runtimeProfile: copy(observation.runtimeObservation.profile.desired),
      containmentProfile: copy(expected.containmentProfile),
      controls: copy(expected.requiredControls),
    },
    expected,
    authority,
    handoff: effects.handoffInput(),
    stores: [effects.storeResult().input],
    route,
  };
  return { input, observation, authorityResult };
}

export function routeResult(request, status = "observed") {
  const result = effects.appliedResult(request);
  result.route =
    status === "observed"
      ? {
          status,
          route: copy(request.desiredRoute),
          controlObject: copy(result.object),
          dataPlaneEvidence: effects.evidence("effective-route"),
        }
      : { status, reasonCode: "provider-outcome-unknown" };
  return result;
}

export function retirementInput(state) {
  const cleanup = effects.stopRequest();
  const route = effects.routeRequest();
  route.effect.target = copy(cleanup.effect.target);
  route.effect.effectRef = effects.uuid(901);
  route.effect.effectKind = "route-inactive";
  route.effect.responsibility = copy(cleanup.effect.responsibility);
  route.gate = copy(cleanup.gate);
  route.providerTarget = effects.providerTarget(1, "Service");
  route.predicate = effects.expectedObject(1, "Service");
  route.plan.targets.push({
    target: copy(route.providerTarget),
    desiredSpecDigest: effects.digest(12),
    allowedMutations: ["route-inactive", "seal"],
  });
  route.desiredRoute = { kind: "inactive", reservedUnmatchableRouteRef: "inert-route" };
  effects.signRequest(route);
  cleanup.plan = copy(route.plan);
  effects.signRequest(cleanup);
  const target = cleanup.effect.target;
  const retirement = {
    schemaVersion: 1,
    kind: "retire",
    operationRef: effects.uuid(902),
    requestRef: "retirement-check",
    target: copy(target),
    expectedLifecycleGeneration: cleanup.gate.lifecycleGeneration,
    expectedAssignmentRecordVersion: 2,
    bindingVersion: cleanup.binding.bindingVersion,
    expectedCurrentSelection: null,
    responsibilityRef: cleanup.effect.responsibility.responsibilityRef,
    expectedResponsibilityVersion: 1,
    reasonCode: "assignment-replaced",
  };
  const authority = (requestedOperation) => ({
    schemaVersion: 1,
    purpose: "cleanup",
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
    assignmentRef: copy(target.assignmentRef),
    requestRef: retirement.requestRef,
    operationRef: retirement.responsibilityRef,
    expectedResponsibilityVersion: 1,
    requestedOperation,
  });
  return {
    state,
    retirement,
    routeAuthority: authority("remove-route"),
    cleanupAuthority: authority("terminate-instance"),
    route,
    cleanup,
  };
}

export function setup(overrides = {}) {
  const values = activationInput();
  const clock = new Clock();
  clock.wall = Date.parse(at(2_000));
  clock.monotonic = 2_000;
  const abort = new AbortController();
  const call = {
    context: Object.freeze({ controlledOnly: true }),
    requestRef: values.input.authority.requestRef,
    recipientRef: "controlled-original-service",
    deadline: at(60_000),
    signal: abort.signal,
  };
  const s = {
    ...values,
    clock,
    abort,
    call,
    events: [],
    callContexts: new Map([[call.requestRef, call.context]]),
    retained: copy(values.input.state),
    effectHistory: new Map(),
    retirementHistory: new Map(),
  };
  const record = (name, input, actualCall) => {
    s.events.push([name, copy(input), actualCall]);
    assert.equal(s.callContexts.has(actualCall.requestRef), true);
    assert.equal(actualCall.context, s.callContexts.get(actualCall.requestRef));
    assert.equal(actualCall.recipientRef, call.recipientRef);
    assert.equal(actualCall.deadline, call.deadline);
  };
  s.options = {
    clock: clock.port,
    owner: {
      async checkpoint(previous, proposed, actualCall) {
        record("checkpoint", proposed, actualCall);
        if (JSON.stringify(copy(previous)) !== JSON.stringify(copy(s.retained))) return "conflict";
        s.retained = copy(proposed);
        return "retained";
      },
    },
    authority: {
      async resolve(input, actualCall) {
        record("resolve", input, actualCall);
        if (input.purpose !== "cleanup") return copy(s.authorityResult);
        const target = s.retirement.cleanup.effect.target;
        return {
          schemaVersion: 1,
          result: "cleanup-eligible",
          purpose: "cleanup",
          reasonCode: "cleanup-allowed",
          evaluatedAt: at(1_100),
          validUntil: at(15_000),
          requestRef: input.requestRef,
          operationRef: input.operationRef,
          responsibilityVersion: input.expectedResponsibilityVersion,
          snapshot: {
            ...copy(s.authorityResult.snapshot),
            target: copy(target),
            binding: copy(s.retirement.cleanup.binding),
          },
          allowedOperation: input.requestedOperation,
          successorExclusionEvidence: source(),
          effectPreconditionEvidence: source(),
          cleanupPolicyEvidence: source(),
        };
      },
      async retire(input, actualCall) {
        record("retire", input, actualCall);
        const value = {
          schemaVersion: 1,
          result: "applied",
          receipt: {
            schemaVersion: 1,
            installationId: input.target.installationId,
            namespaceId: input.target.namespaceId,
            agentId: input.target.agentId,
            operationRef: input.operationRef,
            operationKind: "retire",
            canonicalPayloadDigest: `sha256:${createHash("sha256").update(canonicalRuntimeAuthorityMutationV1(input)).digest("hex")}`,
            assignmentRef: copy(input.target.assignmentRef),
            acceptedServiceIdentityRef: "controlled-retirement-service",
            committedAt: at(2_000),
            assignmentRecordVersion: 3,
            outcome: {
              kind: "retire",
              authority: "retired",
              responsibilityRef: input.responsibilityRef,
              responsibilityVersion: input.expectedResponsibilityVersion,
              termination: "not-asserted",
              providerCredentialRevocation: "not-asserted",
            },
          },
        };
        s.retirementHistory.set(input.operationRef, copy(value));
        return value;
      },
      async readOperation(input, actualCall) {
        record("readAuthority", input, actualCall);
        const value = s.retirementHistory.get(input.operationRef);
        return value
          ? { schemaVersion: 1, result: "committed", receipt: copy(value.receipt) }
          : { schemaVersion: 1, result: "not-found", nextAction: "exact-readback-only" };
      },
    },
    controls: {
      async readControls(input, actualCall) {
        record("controls", input, actualCall);
        return { ...copy(s.observation), input: copy(input) };
      },
    },
    workspace: {
      async observePriorWriters(input, actualCall) {
        record("writers", input, actualCall);
        const value = effects.handoffResult();
        value.input = copy(input);
        return value;
      },
      async verifyStoreBinding(input, actualCall) {
        record("store", input, actualCall);
        const value = effects.storeResult();
        value.input = copy(input);
        return value;
      },
    },
    effects: {
      async setRoute(input, actualCall) {
        record("route", input, actualCall);
        const value = routeResult(input);
        s.effectHistory.set(input.effect.effectRef, copy(value));
        return value;
      },
      async stopRetainingState(input, actualCall) {
        record("cleanup", input, actualCall);
        const value = effects.appliedResult(input);
        value.termination = {
          status: "terminated",
          execution: { target: copy(input.effect.target), binding: copy(input.binding) },
          terminationEvidence: effects.evidence("physical-termination"),
        };
        s.effectHistory.set(input.effect.effectRef, copy(value));
        return value;
      },
      async readEffect(input, actualCall) {
        record("readEffect", input, actualCall);
        return copy(
          s.effectHistory.get(input.effectRef) ?? {
            schemaVersion: 1,
            status: "not-found",
            outcome: "unknown",
            effect: input,
          },
        );
      },
    },
    faults: {
      async recordFaultAndRequestStop(input, actualCall) {
        record("fault", input, actualCall);
        return faultReceipt(input);
      },
      async readRequest(input, actualCall) {
        record("readFault", input, actualCall);
        return { status: "not-found", operation: input, reasonCode: "unavailable" };
      },
    },
  };
  for (const [name, value] of Object.entries(overrides)) s.options[name] = value;
  s.retirement = retirementInput(s.retained);
  return s;
}
