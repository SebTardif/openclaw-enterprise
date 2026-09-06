import { parseLifecycleAdmissionV1 } from "../../../packages/contracts/src/lifecycle-admission-v1.ts";
import { parseRuntimeAuthorityV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";
import { parseRuntimeEffectsV1 } from "../../../packages/contracts/src/runtime-effects-v1.ts";
import { WorkClaimLostError } from "../../../packages/occ/src/state/postgres-work-queue.ts";
import { LifecycleEffectGuard } from "../../../apps/controller/src/worker/lifecycle-effect-guard.ts";
import { cleanup as cleanupVector } from "../runtime-authority-v1/vectors.mjs";
import { copy, createRequest, evidence, now, unknownResult, uuid } from "./vectors.mjs";

// Controlled representations exercise the real guard. The opaque sentinel is
// deliberately not authenticated; these peers prove no service or provider trust.
export function call() {
  return {
    context: Object.freeze({ fixtureOnly: true }),
    requestRef: "guard-test",
    recipientRef: "controlled-peer",
    deadline: "2026-01-01T00:00:10.000Z",
    signal: new AbortController().signal,
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function association(request) {
  const target = request.effect.target;
  return parseLifecycleAdmissionV1("association", {
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      kind: "deploy",
      namespaceId: target.namespaceId,
      agentId: target.agentId,
      expectedLifecycleGeneration:
        target.lifecycleGeneration === 1 ? null : target.lifecycleGeneration - 1,
    },
    intent: {
      installationId: target.installationId,
      namespaceId: target.namespaceId,
      agentId: target.agentId,
      transitionRef: request.gate.intentRef,
      generation: target.lifecycleGeneration,
      desiredMode: "running",
      revisionId: target.revisionId,
      actorId: "principal/guard-test",
      requestId: `req_${uuid(90)}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    auditEventId: `aud_${uuid(91)}`,
    workId: `agent_revision:${target.revisionId}:reconcile`,
  });
}

export function gateObservation(request) {
  return parseRuntimeEffectsV1("gateState", {
    status: "observed",
    guard: request.gate,
    plan: request.plan,
    ordinaryAdmission: "open",
    sealerAdmission: "open",
    children: [],
    authority: "current",
    evidence: evidence("controlled-gate"),
  });
}

export function cleanupAuthority(request) {
  const target = request.effect.target;
  const input = parseRuntimeAuthorityV1("resolveRequest", {
    schemaVersion: 1,
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
    assignmentRef: target.assignmentRef,
    requestRef: "cleanup-test",
    purpose: "cleanup",
    operationRef: request.effect.responsibility.responsibilityRef,
    expectedResponsibilityVersion: request.effect.responsibility.responsibilityVersion,
    requestedOperation: "terminate-instance",
  });
  const value = cleanupVector();
  value.requestRef = input.requestRef;
  value.operationRef = input.operationRef;
  value.snapshot.target = target;
  value.snapshot.binding = request.binding;
  value.snapshot.profileDigests = request.binding.profileDigests;
  return { input, value: parseRuntimeAuthorityV1("resolveResult", value) };
}

export function setup(request = createRequest(), overrides = {}) {
  request = parseRuntimeEffectsV1("effectRequest", request);
  const original = association(request);
  const intent = original.intent;
  const abort = new AbortController();
  const events = [];
  const state = { head: copy(intent), time: new Date(now) };
  const work = {
    idempotencyKey: original.workId,
    namespaceId: intent.namespaceId,
    agentId: intent.agentId,
    revisionId: intent.revisionId,
    actorId: intent.actorId,
    runtimeTransitionRef: intent.transitionRef,
    lifecycleGeneration: intent.generation,
    state: "claimed",
    availableAt: new Date(now),
    attemptCount: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    claimToken: uuid(92),
    leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
  };
  const context = {
    input: {
      schemaVersion: 1,
      handler: "ReconcileAgentLifecycleV1",
      namespaceId: intent.namespaceId,
      agentId: intent.agentId,
      operationRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
      workId: original.workId,
    },
    original,
    operation: {
      action: "reconcile",
      kind: "agent_revision",
      namespaceId: intent.namespaceId,
      resourceId: intent.revisionId,
      actorId: intent.actorId,
      runtimeTransitionRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
    },
    work,
    installationId: intent.installationId,
    signal: abort.signal,
    call: call(),
  };
  const options = {
    lifecycle: {
      async readAdmittedWork(input, bounded) {
        events.push(["read", input, bounded]);
        return { kind: "read", association: original, currentIntent: state.head };
      },
    },
    async heartbeat(claim) {
      events.push(["renew", claim]);
      return copy(work);
    },
    WorkClaimLostError,
    admission: {
      async readGate(input, bounded) {
        events.push(["gate", input, bounded]);
        return gateObservation(request);
      },
    },
    effects: {
      async create(input, bounded) {
        events.push(["create", input, bounded]);
        return unknownResult(input);
      },
      async setRoute(input, bounded) {
        events.push(["route", input, bounded]);
        return unknownResult(input);
      },
      async stopRetainingState(input, bounded) {
        events.push(["cleanup", input, bounded]);
        return unknownResult(input);
      },
      async readEffect(input, bounded) {
        events.push(["readEffect", input, bounded]);
        return unknownResult({ effect: input });
      },
    },
    now: () => new Date(state.time),
    ...overrides,
  };
  return {
    request,
    context,
    abort,
    events,
    state,
    options,
    guard: new LifecycleEffectGuard(options),
  };
}
