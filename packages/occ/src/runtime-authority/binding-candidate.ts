import {
  parseRuntimeAuthorityV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  parseRuntimeMutationResultV1,
  runtimeEffectEvidenceFreshV1,
  type AuthorityCallV1,
  type BindRuntimeV1,
  type BindingResultV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAssignmentRecordV1,
  type RuntimeEffectAdmissionV1,
  type RuntimeEffectsV1,
  type RuntimeEvidenceProvenanceV1,
  type RuntimeGateGuardV1,
  type RuntimeObservationInputV1,
  type RuntimePreparedChildV1,
  type RuntimeReadCallV1,
} from "@openclaw-enterprise/contracts";
import { exactRuntimeAuthorityOperation, runtimeAllocationTarget } from "./repository.ts";
import type { RuntimeAuthorityClock } from "./service.ts";

export class RuntimeBindingCandidateError extends Error {
  constructor() {
    super("The runtime binding candidate could not be established.");
    this.name = "RuntimeBindingCandidateError";
  }
}

function requireCandidate(condition: unknown): asserts condition {
  if (!condition) throw new RuntimeBindingCandidateError();
}

function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = Object.entries(left).sort(([x], [y]) => x.localeCompare(y));
  const b = Object.entries(right).sort(([x], [y]) => x.localeCompare(y));
  return (
    a.length === b.length &&
    a.every(([key, value], i) => key === b[i]?.[0] && same(value, b[i]?.[1]))
  );
}

async function bounded<T>(
  call: AuthorityCallV1,
  clock: RuntimeAuthorityClock,
  ceiling: number,
  work: (call: AuthorityCallV1) => Promise<T>,
): Promise<T> {
  const milliseconds = Math.min(ceiling, Date.parse(call.deadline) - clock.now().getTime());
  requireCandidate(Number.isFinite(milliseconds) && milliseconds > 0 && !call.signal.aborted);
  const started = clock.monotonicMilliseconds();
  const cancellation = new AbortController();
  const signal = AbortSignal.any([call.signal, cancellation.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        requireCandidate(!signal.aborted);
        return work({ ...call, signal });
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          cancellation.abort();
          reject(new RuntimeBindingCandidateError());
        };
        timer = setTimeout(abort, milliseconds);
        call.signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    const elapsed = clock.monotonicMilliseconds() - started;
    requireCandidate(
      Number.isFinite(elapsed) &&
        elapsed >= 0 &&
        elapsed < milliseconds &&
        !signal.aborted &&
        clock.now().getTime() < Date.parse(call.deadline),
    );
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) call.signal.removeEventListener("abort", abort);
    cancellation.abort();
  }
}

export interface RuntimeBindingCandidateOptions {
  readonly assignment: RuntimeAssignmentRecordV1;
  readonly child: RuntimePreparedChildV1;
  readonly guard: RuntimeGateGuardV1;
  readonly operation: Pick<BindRuntimeV1, "operationRef" | "requestRef">;
  readonly admission: Pick<RuntimeEffectAdmissionV1, "readGate">;
  readonly effects: Pick<RuntimeEffectsV1, "discover" | "observe">;
  readonly authorityCall: AuthorityCallV1;
  readonly computeCall: RuntimeReadCallV1;
  readonly clock: RuntimeAuthorityClock;
}

/** Collects an exact binding proposal using the accepted preparation and Compute ports.
 * This is not producer authentication or binding admission. The caller must retain the
 * returned canonical request before submission; recovery never recollects its evidence.
 * TODO(runtime binding integration): wire the actual protected Compute producer and OCC
 * preparation/profile acceptor before using this consumer in reconciliation. */
export async function prepareRuntimeBindingCandidate(
  options: RuntimeBindingCandidateOptions,
): Promise<BindRuntimeV1> {
  try {
    const assignment = parseRuntimeAuthorityV1("assignmentRecord", options.assignment);
    const child = parseRuntimeEffectsV1("preparedChild", options.child);
    const guard = parseRuntimeEffectsV1("gateGuard", options.guard);
    const target = runtimeAllocationTarget(assignment.allocation);
    const operation = { ...options.operation };
    requireCandidate(
      assignment.binding.status === "unbound" &&
        assignment.authority.state === "allocated" &&
        target.component === "harness" &&
        same(target, child.effect.target) &&
        child.request.kind === "create" &&
        child.request.action === "materialize" &&
        child.request.admittedRuntime.provider === "occ/kubernetes-gvisor" &&
        child.request.admittedRuntime.runtimeProfileRef ===
          assignment.allocation.runtimeProfileRef &&
        same(guard.scope, {
          installationId: target.installationId,
          namespaceId: target.namespaceId,
          agentId: target.agentId,
        }) &&
        guard.mode === "running" &&
        guard.lifecycleGeneration === target.lifecycleGeneration &&
        guard.responsibility.kind === "preparation" &&
        same(guard.responsibility, child.effect.responsibility) &&
        guard.intentRef === child.guard.intentRef &&
        guard.requestedFenceEpoch === child.guard.requestedFenceEpoch &&
        guard.gateVersion >= child.guard.gateVersion &&
        guard.admittedChildCutoff >= child.guard.admittedChildCutoff &&
        guard.planRef === child.guard.planRef &&
        guard.planVersion === child.guard.planVersion &&
        guard.planDigest === child.guard.planDigest,
    );
    const create = child.request;
    const checkGate = async () => {
      const state = parseRuntimeEffectsV1(
        "gateState",
        await bounded(options.authorityCall, options.clock, 3000, (call) =>
          options.admission.readGate(guard, call),
        ),
      );
      requireCandidate(
        state.status === "observed" &&
          state.authority === "current" &&
          state.ordinaryAdmission === "open" &&
          same(state.guard, guard) &&
          same(state.plan, create.plan) &&
          state.children.some((retained) => same(retained, child)),
      );
      requireFresh([state.evidence], options.clock);
    };
    await checkGate();
    requireCandidate(child.predicate.kind === "expected-object");
    const exactCreate = parseRuntimeEffectsV1("exactCreate", {
      schemaVersion: 1,
      effect: child.effect,
      providerTarget: child.providerTarget,
      expectedObject: {
        target: child.providerTarget,
        uid: child.predicate.uid,
        resourceVersion: child.predicate.resourceVersion,
        fenceEpoch: child.predicate.fenceEpoch,
      },
    });
    const discovered = parseRuntimeEffectsResponseV1(
      "discover",
      exactCreate,
      await bounded(options.computeCall, options.clock, 10_000, (call) =>
        options.effects.discover(exactCreate, call),
      ),
    );
    requireCandidate(discovered.status === "exact");
    const candidate: RuntimeObservationInputV1 = parseRuntimeEffectsV1("observationInput", {
      schemaVersion: 1,
      kind: "preallocated-candidate",
      target,
      expectedEvidenceVersion: null,
      createEffect: exactCreate,
      responsibility: child.effect.responsibility,
      preparation: create.preparation,
    });
    const observed = parseRuntimeEffectsResponseV1(
      "observe",
      candidate,
      await bounded(options.computeCall, options.clock, 10_000, (call) =>
        options.effects.observe(candidate, call),
      ),
    );
    requireCandidate(observed.status === "complete");
    requireCandidate(
      same(discovered.object.target, observed.object.target) &&
        discovered.object.uid === observed.object.uid &&
        observed.binding.provider === create.admittedRuntime.provider &&
        observed.binding.admittedConfigurationDigest ===
          create.admittedRuntime.configurationDigest &&
        observed.binding.profileDigests.runtime === create.admittedRuntime.runtimeProfileDigest,
    );
    for (const profile of [
      observed.profile.desired,
      observed.profile.delivered,
      observed.profile.effective,
    ]) {
      requireCandidate(
        profile.profileRef === observed.profile.desired.profileRef &&
          profile.digest === observed.profile.desired.digest &&
          profile.version === observed.profile.desired.version,
      );
    }
    // The admitted composite profile and image-set digests have no derivation rule
    // here. Their authoritative correspondence remains the binding acceptor's check;
    // do not equate them with one runtime-profile or individual image digest.
    await checkGate();
    requireFresh(
      [
        discovered.correlationEvidence,
        observed.observation,
        observed.ownerChainEvidence,
        observed.executionCorrespondenceEvidence,
        observed.profile.delivered.evidence,
        observed.profile.effective.evidence,
      ],
      options.clock,
    );
    return parseRuntimeAuthorityV1("bind", {
      schemaVersion: 1,
      kind: "bind",
      ...operation,
      target,
      expectedLifecycleGeneration: target.lifecycleGeneration,
      expectedAssignmentRecordVersion: assignment.authority.assignmentRecordVersion,
      expectedBindingVersion: null,
      binding: observed.binding,
      responsibilityRef: child.effect.responsibility.responsibilityRef,
      expectedResponsibilityVersion: child.effect.responsibility.responsibilityVersion,
      observation: {
        observationRef: observed.observation.evidenceRef,
        ownerChainEvidenceRef: observed.ownerChainEvidence.evidenceRef,
        createEffectCorrelationRef: discovered.correlationEvidence.evidenceRef,
        instanceEvidenceRef: observed.executionCorrespondenceEvidence.evidenceRef,
        ...observed.observation.clock,
      },
    });
  } catch {
    throw new RuntimeBindingCandidateError();
  }
}

function requireFresh(
  evidence: readonly RuntimeEvidenceProvenanceV1[],
  clock: RuntimeAuthorityClock,
): void {
  const now = clock.now().toISOString();
  // Initial unbound proposal only. The accepting producer still checks its protected
  // current evidence versions; a synthetic or newly received record is not authority.
  requireCandidate(evidence.every((item) => runtimeEffectEvidenceFreshV1(item, now, null)));
}

/** Submit ONLY the original durably retained proposal through the real authority port.
 * There is no repository write or permission fallback here. A potentially submitted
 * failure keeps exact readback identity and never triggers another observation or bind. */
export async function submitRuntimeBindingCandidate(
  input: BindRuntimeV1,
  authority: Pick<RuntimeAssignmentAuthorityV1, "bind">,
  call: AuthorityCallV1,
  clock: RuntimeAuthorityClock,
): Promise<BindingResultV1> {
  const request = parseRuntimeAuthorityV1("bind", input);
  const operation = { ...exactRuntimeAuthorityOperation(request), operationKind: "bind" as const };
  if (
    call.requestRef !== request.requestRef ||
    call.signal.aborted ||
    !Number.isFinite(Date.parse(call.deadline)) ||
    clock.now().getTime() >= Date.parse(call.deadline)
  )
    return { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "lookup-unavailable" };
  let submitted = false;
  try {
    const result = parseRuntimeMutationResultV1(
      "bind",
      await bounded(call, clock, 3000, (boundedCall) => {
        submitted = true;
        return authority.bind(request, boundedCall);
      }),
    );
    if (result.result === "commit-unknown") requireCandidate(same(result.operation, operation));
    if (result.result === "applied" || result.result === "exact-replay") {
      const receipt = result.receipt;
      for (const key of [
        "installationId",
        "namespaceId",
        "agentId",
        "operationRef",
        "operationKind",
        "canonicalPayloadDigest",
      ] as const)
        requireCandidate(receipt[key] === operation[key]);
      requireCandidate(
        same(receipt.assignmentRef, request.target.assignmentRef) &&
          receipt.assignmentRecordVersion === request.expectedAssignmentRecordVersion + 1 &&
          receipt.outcome.kind === "bind" &&
          same(receipt.outcome.binding, request.binding),
      );
    }
    return result;
  } catch {
    return submitted
      ? { schemaVersion: 1, result: "commit-unknown", operation, nextAction: "exact-readback-only" }
      : { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "lookup-unavailable" };
  }
}
