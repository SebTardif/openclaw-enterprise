import {
  parseRuntimeEffectsV1,
  parseRuntimeEffectExchangeV1,
  parseRuntimeEffectsResponseV1,
  runtimeEffectEvidenceFreshV1,
  type RuntimeEffectsV1,
  type WorkspaceHandoffEvidenceV1,
  type RuntimeEffectCallV1,
  type RuntimeFenceStateV1,
  type PriorWriterResultV1,
  type RuntimeEffectStateV1,
  type RuntimeFenceRequestV1,
  type ExactHandoffV1,
  type ConditionalRouteV1,
  type RuntimeEvidenceProvenanceV1,
  type RuntimeGateGuardV1,
} from "../../../packages/contracts/src/runtime-effects-v1.ts";

/** Independent consumer: this classification cannot initiate or retry an effect. */
export function nextEffectAction(
  input: RuntimeEffectStateV1,
): "read-original" | "inspect-applied" | "report-terminal" | "unavailable" {
  const value = parseRuntimeEffectsV1("effectState", input);
  switch (value.status) {
    case "unknown":
    case "not-found":
      return "read-original";
    case "applied":
      return "inspect-applied";
    case "not-submitted":
    case "rejected":
      return "report-terminal";
    case "unsupported":
      return "unavailable";
  }
}
function same(a: unknown, b: unknown): boolean {
  // Parsed values have only data fields. Scope and gate comparison below is explicit;
  // object property insertion order is not used as a replay/authorization mechanism.
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ak = Object.keys(a).sort(),
    bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => same(Reflect.get(a, k), Reflect.get(b, k)));
}
function allFresh(
  value: unknown,
  now: string,
  priorVersions: Readonly<Record<string, number>>,
): boolean {
  if (!value || typeof value !== "object") return true;
  if ("producerRef" in value && "clock" in value && "evidenceRef" in value) {
    const evidence = value as RuntimeEvidenceProvenanceV1;
    if (!runtimeEffectEvidenceFreshV1(evidence, now, priorVersions[evidence.evidenceRef] ?? null))
      return false;
  }
  return Object.values(value).every((child) => allFresh(child, now, priorVersions));
}
/** This is a necessary evidence check, not a permit. The actual accepting boundary
 * must independently authenticate producers, recover the complete current canonical
 * owner set, and check authority in the same guarded operation that accepts mutation.
 */
export function replacementBarrier(
  fenceInput: RuntimeFenceStateV1,
  handoffInput: PriorWriterResultV1,
  trustedNow: string,
  priorVersions: Readonly<Record<string, number>>,
): "barrier-observed" | "blocked" {
  const fence = parseRuntimeEffectsV1("fenceState", fenceInput);
  const handoff = parseRuntimeEffectsV1("priorWriterResult", handoffInput);
  if (fence.status !== "established" || handoff.status !== "released") return "blocked";
  if (
    !same(fence.request.guard, handoff.input.guard) ||
    !same(fence.request.plan, handoff.input.plan)
  )
    return "blocked";
  if (!allFresh(fence, trustedNow, priorVersions) || !allFresh(handoff, trustedNow, priorVersions))
    return "blocked";
  return "barrier-observed";
}
/** Completing a protective responsibility does not make it the next preparation
 * owner. The next ordinary gate has its own current responsibility and a version
 * at or after the completion receipt, with the same exact intent/epoch/plan/cutoff.
 */
export function successorPreparationMatchesFence(
  current: RuntimeGateGuardV1,
  fenceInput: RuntimeFenceStateV1,
): boolean {
  const fence = parseRuntimeEffectsV1("fenceState", fenceInput);
  const gate = parseRuntimeEffectsV1("gateGuard", current);
  if (
    fence.status !== "established" ||
    gate.responsibility.kind !== "preparation" ||
    gate.gateVersion < fence.completion.committedGateVersion
  )
    return false;
  const {
    responsibility: _currentResponsibility,
    gateVersion: _currentVersion,
    ...currentIdentity
  } = gate;
  const {
    responsibility: _oldResponsibility,
    gateVersion: _oldVersion,
    ...fencedIdentity
  } = fence.request.guard;
  return same(currentIdentity, fencedIdentity);
}

/** A representative orchestration consumer. Actual injected producers implement
 * storage/provider behavior; this example supplies no synthetic positive producer.
 */
export async function routeAfterReplacement(
  effects: RuntimeEffectsV1,
  writers: WorkspaceHandoffEvidenceV1,
  fenceRequest: RuntimeFenceRequestV1,
  handoffRequest: ExactHandoffV1,
  routeRequest: ConditionalRouteV1,
  call: RuntimeEffectCallV1,
  trustedNow: string,
  priorVersions: Readonly<Record<string, number>>,
): Promise<"blocked" | "effect-observed" | "read-original"> {
  const fence = parseRuntimeEffectsResponseV1(
    "readFence",
    fenceRequest,
    await effects.readFence(fenceRequest, call),
  );
  const handoff = parseRuntimeEffectsResponseV1(
    "observePriorWriters",
    handoffRequest,
    await writers.observePriorWriters(handoffRequest, call),
  );
  if (replacementBarrier(fence, handoff, trustedNow, priorVersions) !== "barrier-observed")
    return "blocked";
  if (handoff.status !== "released" || routeRequest.desiredRoute.kind !== "active")
    return "blocked";
  const expected = routeRequest.desiredRoute.priorWriterEvidence;
  if (
    !successorPreparationMatchesFence(routeRequest.gate, fence) ||
    !same(routeRequest.desiredRoute.selectedTarget, handoff.input.successor) ||
    !same(expected.reservation, handoff.input.reservation) ||
    !same(expected.workspaceStore, handoff.input.workspaceStore) ||
    !same(expected.stores, handoff.input.stores) ||
    expected.closedPlanDigest !== handoff.input.plan.planDigest ||
    expected.admittedChildCutoff !== handoff.input.guard.admittedChildCutoff ||
    expected.evidenceRef !== handoff.canonicalOwnerSnapshot.evidenceRef ||
    expected.evidenceVersion !== handoff.canonicalOwnerSnapshot.evidenceVersion
  )
    return "blocked";
  const result = parseRuntimeEffectExchangeV1(
    routeRequest,
    await effects.setRoute(routeRequest, call),
  );
  if (result.status === "unknown") return "read-original";
  if (result.status !== "applied") return "blocked";
  // Control-object application does not assert effective traffic or serving eligibility.
  return "effect-observed";
}
