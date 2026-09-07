import {
  RUNTIME_AUTHORITY_LIMITS_V1,
  parseRuntimeAuthorityV1,
  type AuthorityCallV1,
  type ResolveAssignmentRequestV1,
  type ResolveAssignmentResultV1,
  type RuntimeAssignmentAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  decodeRuntimeIdentityV1,
  type RuntimeIdentityCheckResultV1,
  type RuntimeIdentityFailureV1,
  type RuntimeIdentityInvalidationV1,
  type RuntimeIdentityLimitsV1,
  type RuntimeIdentityOpenStreamResultV1,
  type RuntimeIdentityPurposeGuardV1,
  type RuntimeIdentityStreamV1,
  type RuntimeWorkloadVerifierV1,
  type VerifiedWorkloadV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  captureRuntimeIdentityClockV1,
  RuntimeIdentityStreamLifetimeV1,
  type RuntimeIdentityClockV1,
} from "./stream-lifetime-v1.ts";
import {
  getRuntimeWorkloadVerifierRegistrationV1,
  getRuntimeWorkloadVerifierSettlementV1,
} from "./peer-verifier-v1.ts";

export type { RuntimeIdentityClockV1 } from "./stream-lifetime-v1.ts";
export interface RuntimeIdentityPurposeGuardOptionsV1<OwnedConnection> {
  readonly verifier: RuntimeWorkloadVerifierV1<OwnedConnection>;
  readonly authority: Pick<RuntimeAssignmentAuthorityV1, "resolve">;
  readonly limits: RuntimeIdentityLimitsV1;
  readonly clock?: RuntimeIdentityClockV1;
}

const refPattern = /^[A-Za-z0-9._:/-]{1,200}$/u;
const positive = (result: ResolveAssignmentResultV1) =>
  result.result === "current" ||
  result.result === "candidate-eligible" ||
  result.result === "cleanup-eligible";
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
const transportFailure = (
  requestRef: string,
  reasonCode: Extract<RuntimeIdentityFailureV1, { kind: "transport-failure" }>["reasonCode"],
): RuntimeIdentityFailureV1 => ({
  schemaVersion: 1,
  kind: "transport-failure",
  reasonCode,
  requestRef,
});
const verificationFailure = (
  requestRef: string,
  reasonCode: Extract<RuntimeIdentityFailureV1, { kind: "verification-failure" }>["reasonCode"],
): RuntimeIdentityFailureV1 => ({
  schemaVersion: 1,
  kind: "verification-failure",
  reasonCode,
  requestRef,
});

function snapshotCall(call: AuthorityCallV1): AuthorityCallV1 {
  // Read original custody once; never serialize or manufacture the opaque context.
  const { context, signal, requestRef, recipientRef, deadline } = call;
  if (
    !context ||
    typeof context !== "object" ||
    !(signal instanceof AbortSignal) ||
    typeof requestRef !== "string" ||
    !refPattern.test(requestRef) ||
    typeof recipientRef !== "string" ||
    !refPattern.test(recipientRef) ||
    typeof deadline !== "string" ||
    !Number.isFinite(Date.parse(deadline)) ||
    new Date(deadline).toISOString() !== deadline
  )
    throw new Error("Invalid runtime identity call.");
  return Object.freeze({ context, signal, requestRef, recipientRef, deadline });
}

/** Actual composition of owner-installed dependencies. This module supplies no authority
 * store, context mint, transport inspector or fallback producer. */
export function createRuntimeIdentityPurposeGuardV1<OwnedConnection>(
  options: RuntimeIdentityPurposeGuardOptionsV1<OwnedConnection>,
): RuntimeIdentityPurposeGuardV1 {
  const decoded = decodeRuntimeIdentityV1("limits", options.limits);
  if (decoded.kind !== "valid") throw new Error("Invalid runtime identity limits.");
  const limits = decoded.value;
  const clock = captureRuntimeIdentityClockV1(options.clock);
  const inspect = options.verifier.inspect.bind(options.verifier);
  const verifier = options.verifier;
  if (!getRuntimeWorkloadVerifierSettlementV1(verifier, new AbortController().signal))
    throw new Error("Runtime verifier settlement participant is required.");
  const resolve = options.authority.resolve.bind(options.authority);
  const connections = new Map<object, number>();
  let pending = 0;

  function invalidationFailure(lifetime: RuntimeIdentityStreamLifetimeV1, requestRef: string) {
    switch (lifetime.reason) {
      case "cancelled":
        return transportFailure(requestRef, "cancelled");
      case "deadline-exceeded":
        return transportFailure(requestRef, "deadline-exceeded");
      case "buffer-exhausted":
        return transportFailure(requestRef, "buffer-exhausted");
      default:
        return transportFailure(requestRef, "connection-closed");
    }
  }

  /** Verify response correspondence without evaluating or changing its authority outcome. */
  function validateObservation(
    value: unknown,
    proof: VerifiedWorkloadV1,
    request: ResolveAssignmentRequestV1,
  ): ResolveAssignmentResultV1 {
    const result = parseRuntimeAuthorityV1("resolveResult", value);
    if (
      result.requestRef !== request.requestRef ||
      ("purpose" in result && result.purpose !== request.purpose)
    )
      throw new Error("Mismatched runtime purpose response.");
    const now = clock.now();
    const evaluated = Date.parse(result.evaluatedAt);
    if (
      !Number.isFinite(now) ||
      evaluated > now + limits.clockSkewAllowanceMs ||
      now - evaluated > RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs
    )
      throw new Error("Stale runtime purpose response.");
    if (!positive(result)) return result;
    if (!("validUntil" in result) || Date.parse(result.validUntil) <= now)
      throw new Error("Expired runtime purpose response.");
    const original = getRuntimeWorkloadVerifierRegistrationV1(verifier, proof);
    if (!original || original.assignment.binding.status !== "bound")
      throw new Error("Missing owned runtime binding.");
    const allocation = original.assignment.allocation;
    const expectedTarget = {
      installationId: allocation.installationId,
      namespaceId: allocation.namespaceId,
      agentId: allocation.agentId,
      assignmentRef: proof.assignmentRef,
      revisionId: allocation.revisionId,
      component: allocation.component,
      lifecycleGeneration: allocation.lifecycleGeneration,
      runtimeGeneration: allocation.runtimeGeneration,
      createEffectRef: allocation.createEffectRef,
    };

    const sameScope = (target: { installationId: string; namespaceId: string; agentId: string }) =>
      target.installationId === request.installationId &&
      target.namespaceId === request.namespaceId &&
      target.agentId === request.agentId;
    const target =
      "snapshot" in result
        ? result.snapshot.target
        : "target" in result
          ? result.target
          : undefined;
    if (
      target &&
      (!sameScope(target) ||
        target.assignmentRef.id !== request.assignmentRef.id ||
        target.component !== proof.component ||
        canonical(target) !== canonical(expectedTarget))
    )
      throw new Error("Mismatched runtime target.");
    const bound =
      "snapshot" in result ? result.snapshot : "targetKind" in result ? result : undefined;
    if (bound) {
      if (
        bound.identityProfileRef !== allocation.identityProfileRef ||
        bound.providerProfileRef !== allocation.providerProfileRef ||
        bound.runtimeProfileRef !== allocation.runtimeProfileRef ||
        bound.assignmentRecordVersion < original.assignment.authority.assignmentRecordVersion ||
        canonical(bound.profileDigests) !==
          canonical(original.assignment.binding.instance.profileDigests)
      )
        throw new Error("Mismatched runtime profile or record version.");
    }
    if (
      "snapshot" in result &&
      canonical(result.snapshot.binding) !== canonical(original.assignment.binding.instance)
    )
      throw new Error("Mismatched runtime bound instance.");
    if (
      "operationRef" in request &&
      "operationRef" in result &&
      (request.operationRef !== result.operationRef ||
        request.expectedResponsibilityVersion !== result.responsibilityVersion)
    )
      throw new Error("Mismatched runtime responsibility.");
    if (
      request.purpose === "cleanup" &&
      result.result === "cleanup-eligible" &&
      request.requestedOperation !== result.allowedOperation
    )
      throw new Error("Mismatched cleanup operation.");
    if (result.result === "candidate-eligible" && result.purpose === "completed-context-restore") {
      const binding = result.binding;
      const assignment =
        proof.component === "gateway" ? binding.gatewayAssignmentRef : binding.harnessAssignmentRef;
      if (
        request.purpose !== "completed-context-restore" ||
        !sameScope(binding) ||
        assignment.id !== request.assignmentRef.id ||
        request.operationRef !== binding.restoreRef ||
        binding.lifecycleGeneration !== allocation.lifecycleGeneration ||
        binding.admittedRevisionRef !== allocation.revisionId ||
        (proof.component === "gateway"
          ? binding.gatewayBindingVersion
          : binding.harnessBindingVersion) !== proof.bindingVersion ||
        request.expectedResponsibilityVersion !== binding.responsibilityVersion ||
        request.purposeContract !== result.purposeContract ||
        request.requestedSuboperation !== result.allowedSuboperation
      )
        throw new Error("Mismatched restore operation.");
    }
    if ("identityEvidence" in result) {
      const identity = result.identityEvidence;
      if (
        identity.registrationId !== proof.registrationId ||
        identity.registrationVersion !== proof.registrationVersion ||
        identity.bundleSetVersion !== proof.bundleSetVersion ||
        identity.identityProfileRef !== proof.identityProfileRef
      )
        throw new Error("Mismatched runtime registration.");
    }
    // Walk only the already bounded, closed canonical result. Preserve source times and
    // apply stricter profile ages to each original source, never delivery time.
    function sources(node: unknown, maxAge: number): void {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.sourceObservedAt === "string") {
        const observed = Date.parse(record.sourceObservedAt);
        if (
          observed > now + limits.clockSkewAllowanceMs ||
          now - observed >= maxAge ||
          typeof record.validUntil !== "string" ||
          Date.parse(record.validUntil) <= now ||
          typeof record.uncertaintyMs !== "number" ||
          record.uncertaintyMs > limits.clockSkewAllowanceMs
        )
          throw new Error("Stale runtime source evidence.");
      }
      for (const [key, child] of Object.entries(record)) {
        const age = /identity/i.test(key)
          ? limits.identityEvidenceMaxAgeMs
          : /policy/i.test(key)
            ? limits.policyEvidenceMaxAgeMs
            : maxAge;
        sources(child, age);
      }
    }
    sources(result, limits.runtimeEvidenceMaxAgeMs);
    return result;
  }

  function execute(
    proof: VerifiedWorkloadV1,
    originalRequest: ResolveAssignmentRequestV1,
    originalCall: AuthorityCallV1,
    lifetime?: RuntimeIdentityStreamLifetimeV1,
  ): Promise<RuntimeIdentityCheckResultV1> {
    let request: ResolveAssignmentRequestV1;
    let call: AuthorityCallV1;
    try {
      request = parseRuntimeAuthorityV1("resolveRequest", originalRequest);
      call = snapshotCall(originalCall);
      if (request.requestRef !== call.requestRef) throw new Error("Mismatched request.");
    } catch {
      return Promise.resolve(transportFailure("request/invalid", "protocol-invalid"));
    }
    if (lifetime && !lifetime.current())
      return Promise.resolve(invalidationFailure(lifetime, request.requestRef));
    if (call.signal.aborted)
      return Promise.resolve(transportFailure(request.requestRef, "cancelled"));
    const started = clock.monotonicNow();
    const wallStart = clock.now();
    const wallEnd = Math.min(Date.parse(call.deadline), lifetime?.wallDeadline ?? Infinity);
    const duration = Math.min(
      wallEnd - wallStart,
      RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
      limits.assignmentDeadlineMs,
      limits.policyDeadlineMs,
    );
    const end = Math.min(started + duration, lifetime?.monotonicDeadline ?? Infinity);
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(wallStart) ||
      !Number.isFinite(end) ||
      end <= started
    )
      return Promise.resolve(transportFailure(request.requestRef, "deadline-exceeded"));
    if (pending >= limits.maxPendingChecks)
      return Promise.resolve(transportFailure(request.requestRef, "buffer-exhausted"));
    pending++;
    const cancellation = new AbortController();
    const combined = AbortSignal.any([
      call.signal,
      cancellation.signal,
      ...(lifetime ? [lifetime.signal] : []),
    ]);
    // Both dependencies see the same tightened absolute deadline and opaque original context.
    const boundedCall = Object.freeze({
      ...call,
      deadline: new Date(Math.min(wallEnd, wallStart + end - started)).toISOString(),
      signal: combined,
    });
    let expired = false;
    const failure = (): RuntimeIdentityFailureV1 | undefined => {
      if (lifetime && !lifetime.current()) return invalidationFailure(lifetime, request.requestRef);
      if (call.signal.aborted) return transportFailure(request.requestRef, "cancelled");
      const mono = clock.monotonicNow();
      const wall = clock.now();
      if (
        expired ||
        !Number.isFinite(mono) ||
        !Number.isFinite(wall) ||
        mono < started ||
        mono >= end ||
        wall >= wallEnd
      )
        return transportFailure(request.requestRef, "deadline-exceeded");
      return undefined;
    };
    let cancelTimer = () => {};
    let cancelListener = () => {};
    const stopped = new Promise<RuntimeIdentityCheckResultV1>((done) => {
      const abort = () =>
        done(failure() ?? transportFailure(request.requestRef, "connection-closed"));
      combined.addEventListener("abort", abort, { once: true });
      cancelListener = () => combined.removeEventListener("abort", abort);
      cancelTimer = clock.schedule(() => {
        expired = true;
        cancellation.abort("deadline-exceeded");
      }, end - started);
    });
    const ownedInspections: Promise<void>[] = [];
    const inspectOwned = () => {
      const inspection = inspect(proof, boundedCall);
      const settled = getRuntimeWorkloadVerifierSettlementV1(verifier, combined);
      if (!settled) throw new Error("Runtime verifier settlement participant missing.");
      ownedInspections.push(settled);
      return inspection;
    };
    const work = Promise.resolve().then(async (): Promise<RuntimeIdentityCheckResultV1> => {
      try {
        const before = failure();
        if (before) return before;
        const verified = await inspectOwned();
        const afterIdentity = failure();
        if (afterIdentity) return afterIdentity;
        if (verified.kind !== "verified") {
          const decodedFailure = decodeRuntimeIdentityV1("failure", verified);
          return decodedFailure.kind === "valid" &&
            decodedFailure.value.requestRef === request.requestRef
            ? decodedFailure.value
            : verificationFailure(request.requestRef, "observation-invalid");
        }
        if (
          verified.proof !== proof ||
          proof.recipientRef !== call.recipientRef ||
          proof.assignmentRef.id !== request.assignmentRef.id ||
          !proof.transportBinding ||
          Date.parse(proof.expiresAt) <= clock.now()
        )
          return verificationFailure(request.requestRef, "binding-mismatch");
        const origin = getRuntimeWorkloadVerifierRegistrationV1(verifier, proof)?.assignment
          .allocation;
        if (
          !origin ||
          origin.installationId !== request.installationId ||
          origin.namespaceId !== request.namespaceId ||
          origin.agentId !== request.agentId
        )
          return verificationFailure(request.requestRef, "binding-mismatch");
        const value = await resolve(request, boundedCall);
        const afterAuthority = failure();
        if (afterAuthority) return afterAuthority;
        // Reinspect after the authority await so an old registration/native incarnation
        // cannot survive a current-purpose lookup that was paused in the meantime.
        const again = await inspectOwned();
        const afterAgain = failure();
        if (afterAgain) return afterAgain;
        if (again.kind !== "verified" || again.proof !== proof)
          return verificationFailure(request.requestRef, "binding-mismatch");
        return { kind: "resolved", observation: validateObservation(value, proof, request) };
      } catch {
        return verificationFailure(request.requestRef, "lookup-unavailable");
      } finally {
        await Promise.allSettled(ownedInspections);
      }
    });
    // Track the underlying work, not the shorter public Promise.race.
    if (lifetime) lifetime.track(work);
    void work.then(
      () => {
        pending--;
      },
      () => {
        pending--;
      },
    );
    return Promise.race([work, stopped])
      .then((result) => failure() ?? result)
      .finally(() => {
        cancelTimer();
        cancelListener();
        cancellation.abort();
      });
  }

  function evidenceDeadline(result: ResolveAssignmentResultV1, wall: number, mono: number): number {
    let deadline = "validUntil" in result ? Date.parse(result.validUntil) : wall;
    function visit(node: unknown, age: number): void {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.sourceObservedAt === "string")
        deadline = Math.min(
          deadline,
          Date.parse(record.sourceObservedAt) + age,
          Date.parse(record.validUntil as string),
        );
      for (const [key, value] of Object.entries(record))
        visit(
          value,
          /identity/i.test(key)
            ? limits.identityEvidenceMaxAgeMs
            : /policy/i.test(key)
              ? limits.policyEvidenceMaxAgeMs
              : age,
        );
    }
    visit(result, limits.runtimeEvidenceMaxAgeMs);
    return mono + deadline - wall;
  }

  async function openStream(
    proof: VerifiedWorkloadV1,
    input: ResolveAssignmentRequestV1,
    callInput: AuthorityCallV1,
    streamLimits: RuntimeIdentityLimitsV1,
  ): Promise<RuntimeIdentityOpenStreamResultV1> {
    let request: ResolveAssignmentRequestV1;
    let call: AuthorityCallV1;
    try {
      request = parseRuntimeAuthorityV1("resolveRequest", input);
      call = snapshotCall(callInput);
      const parsedLimits = decodeRuntimeIdentityV1("limits", streamLimits);
      if (
        parsedLimits.kind !== "valid" ||
        Object.keys(limits).some(
          (key) =>
            limits[key as keyof RuntimeIdentityLimitsV1] !==
            parsedLimits.value[key as keyof RuntimeIdentityLimitsV1],
        )
      )
        return verificationFailure(request.requestRef, "profile-invalid");
      if (
        request.requestRef !== call.requestRef ||
        !proof.transportBinding ||
        typeof proof.transportBinding !== "object"
      )
        throw new Error("Invalid stream binding.");
    } catch {
      return transportFailure("request/invalid", "protocol-invalid");
    }
    const binding = proof.transportBinding;
    const count = connections.get(binding) ?? 0;
    if (
      (count === 0 && connections.size >= limits.maxConnections) ||
      count >= limits.maxStreamsPerConnection
    )
      return transportFailure(request.requestRef, "buffer-exhausted");
    const started = clock.monotonicNow();
    const wall = clock.now();
    const wallDeadline = Math.min(
      Date.parse(call.deadline),
      Date.parse(proof.expiresAt),
      Date.parse(proof.verifiedAt) + limits.connectionMaxAgeMs,
    );
    if (
      !Number.isFinite(wall) ||
      !Number.isFinite(started) ||
      !Number.isFinite(wallDeadline) ||
      wallDeadline <= wall
    )
      return transportFailure(request.requestRef, "deadline-exceeded");
    connections.set(binding, count + 1);
    const lifetime = new RuntimeIdentityStreamLifetimeV1({
      clock,
      requestRef: request.requestRef,
      signal: call.signal,
      started,
      monotonicDeadline: started + wallDeadline - wall,
      wallDeadline,
      closeDeadlineMs: limits.streamCloseDeadlineMs,
      release() {
        const remaining = (connections.get(binding) ?? 1) - 1;
        if (remaining > 0) connections.set(binding, remaining);
        else connections.delete(binding);
      },
    });
    const initial = await execute(proof, request, call, lifetime);
    if (!lifetime.current()) return invalidationFailure(lifetime, request.requestRef);
    if (initial.kind !== "resolved" || !positive(initial.observation)) {
      lifetime.invalidate("authority-changed");
      return initial.kind === "resolved"
        ? { kind: "not-opened", observation: initial.observation }
        : initial;
    }

    function observe(result: RuntimeIdentityCheckResultV1): void {
      if (!lifetime.current()) return;
      if (result.kind !== "resolved" || !positive(result.observation)) {
        lifetime.invalidate(result.kind === "resolved" ? "authority-changed" : "identity-changed");
        return;
      }
      const mono = clock.monotonicNow();
      const now = clock.now();
      lifetime.arm("evidence", evidenceDeadline(result.observation, now, mono), "evidence-stale");
      lifetime.arm("health", mono + limits.identityHealthMaxAgeMs, "watch-lost");
    }
    function schedulePoll(): void {
      lifetime.schedulePoll(Math.min(limits.streamRecheckMs, limits.identityHealthPollMs), () => {
        void execute(proof, request, call, lifetime).then((result) => {
          observe(result);
          if (lifetime.current()) schedulePoll();
        });
      });
    }
    observe(initial);
    if (!lifetime.current()) return invalidationFailure(lifetime, request.requestRef);
    schedulePoll();
    const stream = Object.freeze({
      signal: lifetime.signal,
      async check(nextCall: AuthorityCallV1): Promise<RuntimeIdentityCheckResultV1> {
        if (!lifetime.current()) return invalidationFailure(lifetime, request.requestRef);
        let next: AuthorityCallV1;
        try {
          next = snapshotCall(nextCall);
          if (
            next.context !== call.context ||
            next.requestRef !== call.requestRef ||
            next.recipientRef !== call.recipientRef
          )
            throw new Error("Different stream call custody.");
        } catch {
          lifetime.invalidate("authority-changed");
          return transportFailure(request.requestRef, "protocol-invalid");
        }
        const result = await execute(proof, request, next, lifetime);
        if (!lifetime.current()) return invalidationFailure(lifetime, request.requestRef);
        observe(result);
        return result.kind === "resolved" && positive(result.observation) && !lifetime.current()
          ? invalidationFailure(lifetime, request.requestRef)
          : result;
      },
      invalidate(reason: RuntimeIdentityInvalidationV1) {
        lifetime.invalidate(reason);
      },
      close: () => lifetime.close(),
    });
    // Provider-only construction of the nominal interface. State and operation custody are
    // closed over, so copying fields neither mints nor transfers another stream's authority.
    return { kind: "opened", stream: stream as RuntimeIdentityStreamV1 };
  }

  return Object.freeze({
    check: (
      proof: VerifiedWorkloadV1,
      request: ResolveAssignmentRequestV1,
      call: AuthorityCallV1,
    ) => execute(proof, request, call),
    openStream,
  });
}
