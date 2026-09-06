import { Check } from "typebox/value";
import { sha256Hex } from "@openclaw-enterprise/utils";
import {
  CONTAINMENT_CONTROL_KINDS_V1,
  ContainmentControlCursorSchemaV1,
  ContainmentControlInputSchemaV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";
import {
  decodeContainmentControlInputV1,
  decodeContainmentControlExchangeV1,
} from "@openclaw-enterprise/contracts/containment-controls-codec-v1";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
  parseRuntimeMutationResultV1,
  type AuthorityCallV1,
  type ExactAuthorityOperationV1,
  type ResolveAssignmentRequestV1,
  type RetireAssignmentV1,
  type RuntimeBindingV1,
  type RuntimeAssignmentTargetV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  canonicalRuntimeEffectRequestV1,
  canonicalRuntimeFaultRequestV1,
  parseRuntimeEffectsV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectExchangeV1,
  runtimeEffectEvidenceFreshV1,
  type ConditionalRouteV1,
  type ExactCleanupV1,
  type RuntimeEffectStateV1,
  type StoreBindingResultV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { evaluateContainmentEvidenceV1 } from "../containment/evidence-evaluator-v1.ts";
import { ContainmentFaultRequestAdapterV1 } from "../containment/fault-request-adapter-v1.ts";
import { ActivationBudget, ActivationFailure, requireValue, same, snapshot } from "./bounds.ts";
import type {
  ImmutableActivationV1,
  RuntimeActivationInputV1,
  RuntimeActivationOptionsV1,
  RuntimeActivationOperationV1,
  RuntimeActivationResultV1,
  RuntimeActivationStateV1,
  RuntimeRetirementInputV1,
  RuntimeActivationFaultInputV1,
} from "./types.ts";
export type * from "./types.ts";

const operationRef = (operation: ImmutableActivationV1<RuntimeActivationOperationV1>): string => {
  if (operation.kind === "effect") return operation.request.effect.effectRef;
  if (operation.kind === "authority-retirement") return operation.request.operationRef;
  return operation.continuation.fault.operation.operationRef;
};
function effectRequest(input: unknown): ConditionalRouteV1 | ExactCleanupV1 {
  const request = parseRuntimeEffectsV1("effectRequest", input);
  requireValue(request.kind === "set-route" || request.kind === "stop-retaining-state");
  requireValue(
    request.effect.requestDigest ===
      `sha256:${sha256Hex(canonicalRuntimeEffectRequestV1(request))}`,
  );
  return request;
}
function retirementOperation(
  request: RetireAssignmentV1,
  requestRef: string,
): ExactAuthorityOperationV1 {
  return parseRuntimeAuthorityV1("exactOperation", {
    schemaVersion: 1,
    installationId: request.target.installationId,
    namespaceId: request.target.namespaceId,
    agentId: request.target.agentId,
    operationRef: request.operationRef,
    operationKind: "retire",
    requestRef,
    canonicalPayloadDigest: `sha256:${sha256Hex(canonicalRuntimeAuthorityMutationV1(request))}`,
  });
}
function retirementResponse(request: RetireAssignmentV1, input: unknown, read: boolean) {
  const result = read
    ? parseRuntimeAuthorityV1("operationState", input)
    : parseRuntimeMutationResultV1("retire", input);
  const expected = retirementOperation(request, request.requestRef);
  if ("receipt" in result) {
    const receipt = result.receipt;
    requireValue(receipt.operationKind === "retire" && receipt.outcome.kind === "retire");
    requireValue(same(receipt.assignmentRef, request.target.assignmentRef));
    for (const key of [
      "installationId",
      "namespaceId",
      "agentId",
      "operationRef",
      "canonicalPayloadDigest",
    ] as const)
      requireValue(receipt[key] === expected[key], "response-mismatch");
    requireValue(
      receipt.outcome.responsibilityRef === request.responsibilityRef,
      "response-mismatch",
    );
  }
  if (result.result === "commit-unknown")
    requireValue(same(result.operation, expected), "response-mismatch");
  return result;
}
/** Historical completion is distinct from whether its observation is fresh now.
 * Expired terminal evidence remains retained; unknown/pending never becomes terminal. */
function effectTerminal(result: RuntimeEffectStateV1): boolean {
  if (["rejected", "not-submitted", "unsupported"].includes(result.status)) return true;
  return (
    result.status === "applied" &&
    (result.route?.status === "observed" || result.termination?.status === "terminated")
  );
}
function authorityTerminal(result: string): boolean {
  return ["applied", "exact-replay", "rejected-before-effect", "conflict", "committed"].includes(
    result,
  );
}
function validateState(input: ImmutableActivationV1<RuntimeActivationStateV1>) {
  const state = snapshot(input);
  requireValue(
    same(Object.keys(state).sort(), [
      "activationClosed",
      "cursor",
      "evidence",
      "operations",
      "schemaVersion",
      "version",
    ]),
    "invalid-state",
  );
  requireValue(
    state.schemaVersion === 1 &&
      Number.isSafeInteger(state.version) &&
      state.version >= 0 &&
      state.version < Number.MAX_SAFE_INTEGER,
    "invalid-state",
  );
  requireValue(
    typeof state.activationClosed === "boolean" &&
      Array.isArray(state.operations) &&
      state.operations.length <= 8,
    "invalid-state",
  );
  requireValue(
    state.cursor === null || Check(ContainmentControlCursorSchemaV1, state.cursor),
    "invalid-state",
  );
  requireValue(state.evidence !== null && typeof state.evidence === "object", "invalid-state");
  for (const operation of state.operations) {
    requireValue(
      typeof operation.originalRequestRef === "string" && operation.originalRequestRef.length > 0,
    );
    requireValue(
      operation.phase === "readback-only" || operation.phase === "resolved",
      "invalid-state",
    );
    requireValue(operation.kind === "effect" || state.activationClosed, "invalid-state");
    requireValue(operation.phase !== "resolved" || operation.result !== null, "invalid-state");
    if (operation.kind === "effect") {
      const request = effectRequest(operation.request);
      if (operation.result !== null) {
        const result = parseRuntimeEffectsResponseV1(
          "readEffect",
          request.effect,
          operation.result,
        );
        if (result.status !== "not-found") parseRuntimeEffectExchangeV1(request, result);
        requireValue(operation.phase !== "resolved" || effectTerminal(result), "invalid-state");
      }
    } else if (operation.kind === "authority-retirement") {
      const request = parseRuntimeAuthorityV1("retire", operation.request);
      if (operation.result !== null) {
        const result = operation.result;
        retirementResponse(
          request,
          result,
          ["committed", "not-found", "unavailable", "not-visible"].includes(result.result),
        );
        requireValue(
          operation.phase !== "resolved" || authorityTerminal(result.result),
          "invalid-state",
        );
      }
    } else {
      requireValue(operation.kind === "fault", "invalid-state");
      const fault = parseRuntimeEffectsV1("fault", operation.continuation.fault);
      const canonical = canonicalRuntimeFaultRequestV1(fault);
      requireValue(
        operation.continuation.scope === "fault-request-adapter-only" &&
          operation.continuation.canonicalRequestJson === canonical &&
          fault.operation.requestDigest === `sha256:${sha256Hex(canonical)}`,
        "invalid-state",
      );
      requireValue(
        ["submit-allowed", "readback-only", "resolved"].includes(operation.continuation.phase),
        "invalid-state",
      );
      if (operation.result !== null && "continuation" in operation.result)
        requireValue(same(operation.result.continuation, operation.continuation), "invalid-state");
      if (operation.phase === "resolved") {
        requireValue(
          operation.continuation.phase === "resolved" &&
            operation.result !== null &&
            "result" in operation.result &&
            "continuation" in operation.result,
          "invalid-state",
        );
        const result = parseRuntimeEffectsResponseV1(
          "readRequest",
          fault.operation,
          operation.result.result,
        );
        if ("receipt" in result)
          parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", fault, result);
        requireValue(
          operation.result.status === result.status &&
            ["accepted", "exact-replay", "conflict"].includes(result.status),
          "invalid-state",
        );
      }
    }
  }
  requireValue(
    new Set(state.operations.map(operationRef)).size === state.operations.length,
    "invalid-state",
  );
  return state;
}
function freshSources(value: unknown, now: string): boolean {
  if (value === null || typeof value !== "object") return true;
  if ("sourceObservedAt" in value && "validUntil" in value && "uncertaintyMs" in value) {
    if (
      typeof value.sourceObservedAt !== "string" ||
      typeof value.validUntil !== "string" ||
      typeof value.uncertaintyMs !== "number"
    )
      return false;
    const t = Date.parse(now),
      source = Date.parse(value.sourceObservedAt),
      until = Date.parse(value.validUntil),
      uncertainty = value.uncertaintyMs;
    if (!(
      source <= t + uncertainty &&
      t - source + uncertainty <= 15_000 &&
      t + uncertainty <= until
    ))
      return false;
  }
  return Object.values(value).every((child) => freshSources(child, now));
}
function effectResolved(result: RuntimeEffectStateV1, now: string): boolean {
  if (["rejected", "not-submitted", "unsupported"].includes(result.status)) return true;
  if (
    result.status !== "applied" ||
    !runtimeEffectEvidenceFreshV1(result.providerReceipt, now, null)
  )
    return false;
  if (result.route)
    return (
      result.route.status === "observed" &&
      runtimeEffectEvidenceFreshV1(result.route.dataPlaneEvidence, now, null)
    );
  return (
    result.termination?.status === "terminated" &&
    runtimeEffectEvidenceFreshV1(result.termination.terminationEvidence, now, null)
  );
}

class Progress {
  readonly budget: ActivationBudget;
  state: ImmutableActivationV1<RuntimeActivationStateV1>;
  retention: RuntimeActivationResultV1["stateRetention"] = "unchanged";
  proposed: ImmutableActivationV1<RuntimeActivationStateV1> | null = null;
  evaluation: RuntimeActivationResultV1["evaluation"] = null;
  operation: RuntimeActivationResultV1["operation"] = null;
  readonly options: RuntimeActivationOptionsV1;
  constructor(
    options: RuntimeActivationOptionsV1,
    state: ImmutableActivationV1<RuntimeActivationStateV1>,
    call: AuthorityCallV1,
  ) {
    this.options = options;
    this.state = validateState(state);
    this.budget = new ActivationBudget(options.clock, call);
  }
  requireCheckpoints(count: number) {
    requireValue(this.state.version <= Number.MAX_SAFE_INTEGER - 1 - count, "state-capacity");
  }
  async checkpoint(changes: Partial<ImmutableActivationV1<RuntimeActivationStateV1>>) {
    requireValue(this.state.version < Number.MAX_SAFE_INTEGER - 1, "state-capacity");
    this.proposed = snapshot({ ...this.state, ...changes, version: this.state.version + 1 });
    requireValue(!this.state.activationClosed || this.proposed.activationClosed, "invalid-state");
    this.retention = "unknown";
    const result = await this.budget.run(
      (call) => this.options.owner.checkpoint(this.state, this.proposed!, call),
      3_000,
    );
    requireValue(
      result === "retained",
      result === "conflict" ? "state-conflict" : "state-retention-unknown",
    );
    this.state = this.proposed;
    this.proposed = null;
    this.retention = "retained";
  }
  async append(operation: RuntimeActivationOperationV1, close = false) {
    this.requireCheckpoints(2);
    requireValue(
      this.state.operations.length < 8 &&
        !this.state.operations.some((old) => operationRef(old) === operationRef(operation)),
      "operation-already-retained",
    );
    this.operation = snapshot(operation);
    await this.checkpoint({
      activationClosed: close || this.state.activationClosed,
      operations: [...this.state.operations, operation],
    });
  }
  async record(operation: ImmutableActivationV1<RuntimeActivationOperationV1>) {
    const retained = this.state.operations.find(
      (old) => operationRef(old) === operationRef(operation),
    );
    if (retained?.phase === "resolved") {
      this.operation = retained;
      requireValue(
        same({ ...operation, phase: retained.phase, result: retained.result }, retained),
        "historical-result-mismatch",
      );
      const priorResult = retained.result;
      const nextResult = operation.result;
      const sameReceipt =
        retained.kind === "authority-retirement" &&
        priorResult !== null &&
        nextResult !== null &&
        "receipt" in priorResult &&
        "receipt" in nextResult &&
        same(priorResult.receipt, nextResult.receipt);
      requireValue(sameReceipt || same(priorResult, nextResult), "historical-result-mismatch");
      // A current lookup cannot overwrite original confirmed history or make it
      // unresolved again. Current observation freshness is assessed separately.
      return;
    }
    this.operation = snapshot(operation);
    await this.checkpoint({
      evidence: this.evaluation?.nextState ?? this.state.evidence,
      operations: this.state.operations.map((old) =>
        operationRef(old) === operationRef(operation) ? operation : old,
      ),
    });
  }
  result(
    status: RuntimeActivationResultV1["status"],
    reason: string,
    termination: RuntimeActivationResultV1["termination"] = "not-proved",
  ): RuntimeActivationResultV1 {
    return snapshot({
      status,
      reason,
      serving: "publication-unavailable",
      termination,
      state: this.state,
      stateRetention: this.retention,
      proposedState: this.proposed,
      evaluation: this.evaluation,
      operation: this.operation,
    });
  }
}

/** Finite orchestration over original acceptors. No producer authentication, claim
 * guard, profile store, containment evaluator, journal or serving writer is added.
 * The composition owner must supply genuine authenticated ports and serialize its
 * protected continuation. Every effect acceptor rechecks all current authority,
 * complete writer/store ownership and exact provider preconditions at acceptance. */
export class RuntimeActivationOrchestratorV1 {
  private readonly faults: ContainmentFaultRequestAdapterV1;
  private readonly options: RuntimeActivationOptionsV1;
  constructor(options: RuntimeActivationOptionsV1) {
    this.options = Object.freeze({ ...options });
    requireValue(
      options.owner && typeof options.owner.checkpoint === "function",
      "owner-unavailable",
    );
    this.faults = new ContainmentFaultRequestAdapterV1({
      sink: options.faults,
      clock: options.clock,
    });
  }
  private async invoke(
    state: ImmutableActivationV1<RuntimeActivationStateV1>,
    call: AuthorityCallV1,
    work: (progress: Progress) => Promise<RuntimeActivationResultV1>,
  ) {
    let progress: Progress | undefined;
    try {
      progress = new Progress(this.options, state, call);
      return await work(progress);
    } catch (error) {
      const reason =
        error instanceof ActivationFailure ? error.reason : "dependency-or-input-unavailable";
      if (progress) return progress.result("blocked", reason);
      // Invalid owner state remains invalid; never substitute an empty history.
      return snapshot({
        status: "blocked" as const,
        reason,
        serving: "publication-unavailable" as const,
        termination: "not-proved" as const,
        state: null,
        stateRetention: "unchanged" as const,
        proposedState: null,
        evaluation: null,
        operation: null,
      });
    }
  }
  activate(
    input: RuntimeActivationInputV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeActivationResultV1> {
    return this.invoke(input.state, call, async (progress) => {
      const request = snapshot(input);
      progress.requireCheckpoints(4);
      requireValue(progress.state.operations.length < 8, "state-capacity");
      requireValue(
        !progress.state.activationClosed &&
          !progress.state.operations.some((op) => op.phase === "readback-only"),
        "activation-closed-or-unresolved",
      );
      requireValue(request.selection !== null, "selection-unavailable");
      const decoded = decodeContainmentControlInputV1(request.expected);
      requireValue(decoded.kind === "valid", "selection-invalid");
      const expected = decoded.value,
        selection = request.selection;
      requireValue(
        Check(
          ContainmentControlInputSchemaV1.properties.containmentProfile,
          selection.runtimeProfile,
        ),
        "selection-invalid",
      );
      requireValue(
        expected.runtime.target.component === "harness" &&
          expected.runtime.binding.provider === "occ/kubernetes-gvisor",
        "unsupported-activation-target",
      );
      requireValue(
        same(expected.after, progress.state.cursor) &&
          same(expected.containmentProfile, selection.containmentProfile),
        "selection-or-cursor-mismatch",
      );
      requireValue(
        selection.controls.length === CONTAINMENT_CONTROL_KINDS_V1.length &&
          new Set(selection.controls.map((control) => control.control)).size ===
            CONTAINMENT_CONTROL_KINDS_V1.length,
        "selection-incomplete",
      );
      for (const kind of CONTAINMENT_CONTROL_KINDS_V1) {
        const supplied = selection.controls.find((entry) => entry.control === kind);
        requireValue(
          supplied && expected.requiredControls.some((entry) => same(entry, supplied)),
          "selection-incomplete",
        );
      }
      requireValue(
        expected.requiredControls.length === selection.controls.length &&
          selection.runtimeProfile.digest === expected.runtime.binding.profileDigests.runtime,
        "selection-mismatch",
      );
      const authorityRequest = parseRuntimeAuthorityV1("resolveRequest", request.authority);
      requireValue(authorityRequest.purpose === "readiness-probe", "unsupported-purpose");
      const target = expected.runtime.target;
      requireValue(
        authorityRequest.requestRef === call.requestRef &&
          same(authorityRequest.assignmentRef, target.assignmentRef),
        "authority-mismatch",
      );
      for (const key of ["installationId", "namespaceId", "agentId"] as const)
        requireValue(authorityRequest[key] === target[key], "authority-mismatch");
      const route = parseRuntimeEffectsV1("setRoute", effectRequest(request.route));
      requireValue(
        route.desiredRoute.kind === "active" &&
          same(route.effect.target, target) &&
          same(route.desiredRoute.binding, expected.runtime.binding),
        "route-mismatch",
      );
      const handoff = parseRuntimeEffectsV1("exactHandoff", request.handoff);
      requireValue(
        same(handoff.successor, target) && same(handoff.plan, route.plan),
        "handoff-mismatch",
      );
      requireValue(
        same(handoff.guard.scope, route.gate.scope) &&
          handoff.guard.planDigest === route.gate.planDigest &&
          handoff.guard.admittedChildCutoff === route.gate.admittedChildCutoff,
        "handoff-mismatch",
      );
      const writerRef = route.desiredRoute.priorWriterEvidence;
      requireValue(
        same(writerRef.reservation, handoff.reservation) &&
          same(writerRef.workspaceStore, handoff.workspaceStore) &&
          same(writerRef.stores, handoff.stores),
        "handoff-mismatch",
      );
      requireValue(
        request.stores.length === handoff.stores.length && request.stores.length > 0,
        "store-input-incomplete",
      );
      const stores = request.stores.map((store) => parseRuntimeEffectsV1("exactStore", store));
      requireValue(
        new Set(stores.map((store) => store.store.bindingRef)).size === stores.length,
        "store-input-incomplete",
      );
      for (const store of stores)
        requireValue(
          same(store.target, target) &&
            same(store.binding, expected.runtime.binding) &&
            handoff.stores.some((ref) => same(ref, store.store)),
          "store-mismatch",
        );
      let authority = parseRuntimeAuthorityV1(
        "resolveResult",
        await progress.budget.run(
          (bounded) => this.options.authority.resolve(authorityRequest, bounded),
          3_000,
        ),
      );
      const exchange = decodeContainmentControlExchangeV1(
        expected,
        await progress.budget.run((bounded) =>
          this.options.controls.readControls(expected, bounded),
        ),
      );
      requireValue(exchange.kind === "valid", "control-response-invalid");
      const observation = exchange.value;
      const evaluate = () =>
        evaluateContainmentEvidenceV1(
          {
            expected,
            observation,
            authorityRequest,
            authorityResult: authority,
            clock: progress.budget.check(),
          },
          progress.state.evidence,
        );
      progress.evaluation = evaluate();
      requireValue(progress.evaluation.nextState !== null, "invalid-evaluator-state");
      await progress.checkpoint({
        evidence: progress.evaluation.nextState,
        cursor:
          progress.evaluation.decision === "satisfied" && observation.status === "observed"
            ? observation.cursor
            : progress.state.cursor,
      });
      requireValue(
        progress.evaluation.decision === "satisfied" &&
          observation.status === "observed" &&
          observation.runtimeObservation.status === "complete",
        "containment-not-satisfied",
      );
      requireValue(
        same(observation.runtimeObservation.profile.desired, selection.runtimeProfile),
        "runtime-profile-mismatch",
      );
      const released = parseRuntimeEffectsResponseV1(
        "observePriorWriters",
        handoff,
        await progress.budget.run((bounded) =>
          this.options.workspace.observePriorWriters(handoff, bounded),
        ),
      );
      requireValue(released.status === "released", "prior-writers-unresolved");
      requireValue(
        writerRef.evidenceRef === released.canonicalOwnerSnapshot.evidenceRef &&
          writerRef.evidenceVersion === released.canonicalOwnerSnapshot.evidenceVersion,
        "writer-reference-mismatch",
      );
      requireValue(freshSources(released, progress.budget.check().now), "writer-evidence-stale");
      const storeObservations: StoreBindingResultV1[] = [];
      for (const store of stores) {
        const result = parseRuntimeEffectsResponseV1(
          "verifyStoreBinding",
          store,
          await progress.budget.run((bounded) =>
            this.options.workspace.verifyStoreBinding(store, bounded),
          ),
        );
        requireValue(
          result.status === "verified" &&
            released.observedStoreBindings.some((binding) => same(binding, result.store)),
          "store-binding-unverified",
        );
        requireValue(freshSources(result, progress.budget.check().now), "store-evidence-stale");
        storeObservations.push(result);
      }
      // Re-resolve the same original purpose after the handoff/store waits.
      authority = parseRuntimeAuthorityV1(
        "resolveResult",
        await progress.budget.run(
          (bounded) => this.options.authority.resolve(authorityRequest, bounded),
          3_000,
        ),
      );
      // The evaluator is reused; comparison never becomes an effect permit.
      progress.evaluation = evaluate();
      requireValue(progress.evaluation.nextState !== null, "invalid-evaluator-state");
      await progress.checkpoint({ evidence: progress.evaluation.nextState });
      requireValue(
        progress.evaluation.decision === "satisfied" &&
          freshSources(released, progress.budget.check().now),
        "evidence-no-longer-current",
      );
      const result = await this.effect(progress, route, () => {
        progress.evaluation = evaluate();
        // Retain the exact proposed evaluator state even if a later freshness
        // check, effect wait or response validation fails before its checkpoint.
        if (progress.evaluation.nextState !== null) {
          requireValue(progress.state.version < Number.MAX_SAFE_INTEGER - 1, "state-capacity");
          progress.proposed = snapshot({
            ...progress.state,
            evidence: progress.evaluation.nextState,
            version: progress.state.version + 1,
          });
        }
        if (progress.evaluation.decision !== "satisfied") {
          throw new ActivationFailure("evidence-no-longer-current");
        }
        requireValue(
          freshSources([released, ...storeObservations], progress.budget.check().now),
          "handoff-or-store-evidence-stale",
        );
      });
      if (
        result.status === "applied" &&
        result.route?.status === "observed" &&
        effectResolved(result, progress.budget.check().now)
      )
        return progress.result("route-observed", "serving-owner-publication-unavailable");
      return progress.result("blocked", "route-not-observed");
    });
  }
  private async effect(
    progress: Progress,
    request: ConditionalRouteV1 | ExactCleanupV1,
    beforeSubmit?: () => void,
  ) {
    const operation: RuntimeActivationOperationV1 = {
      kind: "effect",
      request,
      originalRequestRef: progress.budget.call.requestRef,
      phase: "readback-only",
      result: null,
    };
    // Retain possible submission BEFORE invoking the original acceptor, including
    // its own admission commit. A timeout can never restore submission permission.
    await progress.append(operation);
    const response = await progress.budget.run((call) => {
      beforeSubmit?.();
      return request.kind === "set-route"
        ? this.options.effects.setRoute(request, call)
        : this.options.effects.stopRetainingState(request, call);
    });
    const result = parseRuntimeEffectExchangeV1(request, response);
    await progress.record({
      ...operation,
      result,
      phase: effectResolved(result, progress.budget.check().now) ? "resolved" : "readback-only",
    });
    return result;
  }
  private async cleanupAuthority(
    progress: Progress,
    input: ResolveAssignmentRequestV1,
    target: RuntimeAssignmentTargetV1,
    binding: RuntimeBindingV1,
    operation: "remove-route" | "terminate-instance" | "remove-provider-object",
  ) {
    const request = parseRuntimeAuthorityV1("resolveRequest", input);
    requireValue(
      request.purpose === "cleanup" && request.requestedOperation === operation,
      "cleanup-purpose-mismatch",
    );
    requireValue(
      request.requestRef === progress.budget.call.requestRef &&
        same(request.assignmentRef, target.assignmentRef),
      "cleanup-target-mismatch",
    );
    for (const key of ["installationId", "namespaceId", "agentId"] as const)
      requireValue(request[key] === target[key], "cleanup-target-mismatch");
    const result = parseRuntimeAuthorityV1(
      "resolveResult",
      await progress.budget.run((call) => this.options.authority.resolve(request, call), 3_000),
    );
    requireValue(
      result.result === "cleanup-eligible" &&
        result.purpose === "cleanup" &&
        result.requestRef === request.requestRef,
      "cleanup-authority-unavailable",
    );
    requireValue(
      result.allowedOperation === operation &&
        result.operationRef === request.operationRef &&
        result.responsibilityVersion === request.expectedResponsibilityVersion,
      "cleanup-authority-mismatch",
    );
    if ("snapshot" in result)
      requireValue(
        same(result.snapshot.target, target) && same(result.snapshot.binding, binding),
        "cleanup-binding-mismatch",
      );
    else {
      requireValue(
        same(result.target, target) && operation === "remove-provider-object",
        "cleanup-target-mismatch",
      );
      requireValue(
        result.providerObject.provider === binding.provider &&
          result.providerObject.clusterRef === binding.clusterRef &&
          result.providerObject.kubernetesNamespaceUid === binding.kubernetesNamespaceUid &&
          result.providerObject.deploymentUid === binding.deploymentUid,
        "cleanup-object-mismatch",
      );
    }
    const now = progress.budget.check().now;
    requireValue(
      Date.parse(result.evaluatedAt) <= Date.parse(now) &&
        Date.parse(now) <= Date.parse(result.validUntil) &&
        freshSources(result, now),
      "cleanup-authority-stale",
    );
    // No target SVID, original human grant, or serving purpose is required here.
  }
  retire(
    input: RuntimeRetirementInputV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeActivationResultV1> {
    return this.invoke(input.state, call, async (progress) => {
      const request = snapshot(input);
      requireValue(
        !progress.state.operations.some((op) => op.phase === "readback-only"),
        "readback-required",
      );
      requireValue(progress.state.operations.length <= 5, "state-capacity");
      progress.requireCheckpoints(6);
      requireValue(
        !progress.state.operations.some((op) => op.originalRequestRef === call.requestRef),
        "fresh-cleanup-call-required",
      );
      const retirement = parseRuntimeAuthorityV1("retire", request.retirement);
      const route = parseRuntimeEffectsV1("setRoute", effectRequest(request.route));
      const cleanup = parseRuntimeEffectsV1("stopRetainingState", effectRequest(request.cleanup));
      requireValue(
        route.desiredRoute.kind === "inactive" &&
          same(route.effect.target, cleanup.effect.target) &&
          same(retirement.target, cleanup.effect.target),
        "retirement-target-mismatch",
      );
      requireValue(
        retirement.bindingVersion === cleanup.binding.bindingVersion &&
          retirement.requestRef === call.requestRef,
        "retirement-binding-mismatch",
      );
      requireValue(
        same(route.gate, cleanup.gate) && same(route.plan, cleanup.plan),
        "retirement-plan-mismatch",
      );
      requireValue(
        retirement.responsibilityRef === cleanup.effect.responsibility.responsibilityRef,
        "retirement-responsibility-mismatch",
      );
      requireValue(
        request.routeAuthority.operationRef === route.effect.responsibility.responsibilityRef &&
          request.routeAuthority.expectedResponsibilityVersion ===
            route.effect.responsibility.responsibilityVersion,
        "cleanup-responsibility-mismatch",
      );
      requireValue(
        request.cleanupAuthority.operationRef === cleanup.effect.responsibility.responsibilityRef &&
          request.cleanupAuthority.expectedResponsibilityVersion ===
            cleanup.effect.responsibility.responsibilityVersion,
        "cleanup-responsibility-mismatch",
      );
      await this.cleanupAuthority(
        progress,
        request.routeAuthority,
        cleanup.effect.target,
        cleanup.binding,
        "remove-route",
      );
      const operation: RuntimeActivationOperationV1 = {
        kind: "authority-retirement",
        request: retirement,
        originalRequestRef: call.requestRef,
        phase: "readback-only",
        result: null,
      };
      await progress.append(operation, true);
      const retired = retirementResponse(
        retirement,
        await progress.budget.run(
          (bounded) => this.options.authority.retire(retirement, bounded),
          3_000,
        ),
        false,
      );
      await progress.record({
        ...operation,
        result: retired,
        phase: authorityTerminal(retired.result) ? "resolved" : "readback-only",
      });
      requireValue(
        "receipt" in retired && retired.receipt.outcome.kind === "retire",
        "retirement-not-confirmed",
      );
      await this.cleanupAuthority(
        progress,
        request.routeAuthority,
        cleanup.effect.target,
        cleanup.binding,
        "remove-route",
      );
      const routed = await this.effect(progress, route);
      requireValue(
        routed.status === "applied" &&
          routed.route?.status === "observed" &&
          effectResolved(routed, progress.budget.check().now),
        "route-withdrawal-unresolved",
      );
      await this.cleanupAuthority(
        progress,
        request.cleanupAuthority,
        cleanup.effect.target,
        cleanup.binding,
        cleanup.action === "remove-exact" ? "remove-provider-object" : "terminate-instance",
      );
      const stopped = await this.effect(progress, cleanup);
      if (
        stopped.status === "applied" &&
        stopped.termination?.status === "terminated" &&
        effectResolved(stopped, progress.budget.check().now)
      )
        return progress.result(
          "retirement-observed",
          "exact-termination-observed-stores-retained",
          "observed",
        );
      return progress.result("blocked", "termination-unresolved");
    });
  }
  readOperation(
    state: ImmutableActivationV1<RuntimeActivationStateV1>,
    reference: string,
    call: AuthorityCallV1,
  ): Promise<RuntimeActivationResultV1> {
    return this.invoke(state, call, async (progress) => {
      progress.requireCheckpoints(1);
      const operation = progress.state.operations.find(
        (entry) => operationRef(entry) === reference,
      );
      requireValue(operation, "original-operation-unavailable");
      requireValue(operation.originalRequestRef !== call.requestRef, "fresh-read-call-required");
      if (operation.kind === "effect") {
        const request = effectRequest(operation.request);
        const result = parseRuntimeEffectsResponseV1(
          "readEffect",
          request.effect,
          await progress.budget.run(
            (bounded) => this.options.effects.readEffect(request.effect, bounded),
            3_000,
          ),
        );
        if (result.status !== "not-found") parseRuntimeEffectExchangeV1(request, result);
        await progress.record({
          ...operation,
          result,
          phase: effectResolved(result, progress.budget.check().now) ? "resolved" : "readback-only",
        });
        const terminated =
          result.status === "applied" &&
          result.termination?.status === "terminated" &&
          effectResolved(result, progress.budget.check().now);
        return progress.result(
          "readback",
          "original-effect-only-no-resubmission",
          terminated ? "observed" : "not-proved",
        );
      }
      if (operation.kind === "authority-retirement") {
        const request = parseRuntimeAuthorityV1("retire", operation.request);
        const exact = retirementOperation(request, call.requestRef);
        const result = retirementResponse(
          request,
          await progress.budget.run(
            (bounded) => this.options.authority.readOperation(exact, bounded),
            3_000,
          ),
          true,
        );
        await progress.record({
          ...operation,
          result,
          phase:
            result.result === "committed" || result.result === "conflict"
              ? "resolved"
              : "readback-only",
        });
        return progress.result("readback", "original-authority-operation-only-no-resubmission");
      }
      const result = await this.faults.readback(
        {
          ...operation.continuation,
          fault: parseRuntimeEffectsV1("fault", operation.continuation.fault),
        },
        progress.budget.call,
      );
      requireValue("continuation" in result, "fault-readback-unavailable");
      await progress.record({
        ...operation,
        result,
        continuation: result.continuation,
        phase: result.continuation.phase === "resolved" ? "resolved" : "readback-only",
      });
      return progress.result("readback", "original-fault-only-stop-not-proved");
    });
  }
  requestFault(
    input: RuntimeActivationFaultInputV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeActivationResultV1> {
    return this.invoke(input.state, call, async (progress) => {
      const request = snapshot(input);
      progress.requireCheckpoints(2);
      requireValue(progress.state.operations.length < 8, "state-capacity");
      requireValue(
        !progress.state.operations.some((op) => op.originalRequestRef === call.requestRef),
        "fresh-fault-call-required",
      );
      const prepared = this.faults.prepare(request.fault, request.expected);
      requireValue(prepared.status === "prepared", "original-fault-input-unavailable");
      const operation: RuntimeActivationOperationV1 = {
        kind: "fault",
        continuation: prepared.continuation,
        originalRequestRef: call.requestRef,
        phase: "readback-only",
        result: null,
      };
      await progress.append(operation, true);
      const result = await this.faults.submit(prepared.continuation, progress.budget.call);
      requireValue("continuation" in result, "fault-result-unavailable");
      await progress.record({
        ...operation,
        result,
        continuation: result.continuation,
        phase: result.continuation.phase === "resolved" ? "resolved" : "readback-only",
      });
      return progress.result("fault-request", "original-fault-request-only-stop-not-proved");
    });
  }
}
