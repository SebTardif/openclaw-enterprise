import {
  RUNTIME_AUTHORITY_ROLE_POLICY_V1,
  parseRuntimeAuthorityV1,
  parseRuntimeMutationResultV1,
  type AuthorityCallV1,
  type AuthorityOperationStateV1,
  type BindRuntimeV1,
  type BindingResultV1,
  type EvidenceResultV1,
  type ExactAuthorityOperationV1,
  type ResolveAssignmentRequestV1,
  type ResolveAssignmentResultV1,
  type RetirementResultV1,
  type RetireAssignmentV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAuthorityContextFactoryV1,
  type RuntimeAuthorityVerifiedServiceV1,
  type RuntimeEvidenceInputV1,
  type RuntimeMutationV1,
  type RuntimeMutationResultV1,
  type RuntimeServiceTrustConfigurationV1,
} from "@openclaw-enterprise/contracts";
import type { PlatformStateStore } from "../state/platform-state.ts";
import type { RuntimeServiceOperationPolicy } from "./service-trust-schema.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import {
  RuntimeAuthorityConflictError,
  exactRuntimeAuthorityOperation,
  type RuntimeAuthorityWriteAttribution,
} from "./repository.ts";

/** Internal persistence orchestration only: no authentication, provider call or eligibility.
 * The unintegrated trusted acceptor must perform all required guarded checks before use. */
export async function commitRuntimeAuthorityMutation(
  store: PlatformStateStore,
  input: RuntimeMutationV1,
  attribution: RuntimeAuthorityWriteAttribution,
): Promise<RuntimeMutationResultV1> {
  const request = parseRuntimeAuthorityV1("mutation", input);
  const operation = exactRuntimeAuthorityOperation(request);
  try {
    return await store.transact((unit) =>
      unit.runtimeAuthority.appendMutation(request, attribution),
    );
  } catch (error) {
    if (error instanceof PostgresCommitOutcomeUnknownError)
      return {
        schemaVersion: 1,
        result: "commit-unknown",
        operation,
        nextAction: "exact-readback-only",
      };
    if (error instanceof RuntimeAuthorityConflictError)
      return { schemaVersion: 1, result: "conflict", reasonCode: error.reasonCode };
    throw error;
  }
}

/** Narrow dependency on the actual current protected service registry. No implementation or
 * default trust record is supplied. A pinned historical configuration is insufficient. */
export interface RuntimeAuthorityCurrentTrust {
  readonly configuration: Readonly<RuntimeServiceTrustConfigurationV1>;
  readonly operationPolicy: RuntimeServiceOperationPolicy;
}
export interface RuntimeAuthorityCurrentTrustReader {
  readCurrent(
    serviceIdentityRef: string,
    signal: AbortSignal,
  ): Promise<Readonly<RuntimeAuthorityCurrentTrust> | undefined>;
}
type RuntimeAuthorityCaller = Readonly<RuntimeAuthorityVerifiedServiceV1> & {
  readonly operationPolicy: RuntimeServiceOperationPolicy;
};
export interface RuntimeAuthorityClock {
  now(): Date;
  monotonicMilliseconds(): number;
}
/** Additional request correspondence only, never authentication or an operation grant.
 * The native owner compares its protected exchange and original request bytes. */
export interface RuntimeAuthorityRequestBindingVerifier {
  matchesRequest(
    method: "bind" | "readOperation",
    input: BindRuntimeV1 | ExactAuthorityOperationV1,
    call: AuthorityCallV1,
  ): boolean;
}
export interface RuntimeAuthorityServiceOptions {
  readonly store: PlatformStateStore;
  readonly installationId: string;
  readonly recipientRef: string;
  readonly clock: RuntimeAuthorityClock;
  readonly contextFactory?: Pick<RuntimeAuthorityContextFactoryV1<unknown>, "inspect">;
  readonly currentTrust?: RuntimeAuthorityCurrentTrustReader;
  readonly requestBinding?: RuntimeAuthorityRequestBindingVerifier;
}
function sameConfiguration(
  left: RuntimeServiceTrustConfigurationV1,
  right: RuntimeServiceTrustConfigurationV1,
): boolean {
  const a = parseRuntimeAuthorityV1("serviceTrust", left);
  const b = parseRuntimeAuthorityV1("serviceTrust", right);
  return (
    a.installationId === b.installationId &&
    a.configurationVersion === b.configurationVersion &&
    a.serviceIdentityRef === b.serviceIdentityRef &&
    a.serviceTrustProfileRef === b.serviceTrustProfileRef &&
    a.serviceTrustProfileDigest === b.serviceTrustProfileDigest &&
    a.trustRootsRef === b.trustRootsRef &&
    a.verifierProfileRef === b.verifierProfileRef &&
    a.permittedRecipientRef === b.permittedRecipientRef &&
    a.role === b.role &&
    a.allowedScope.kind === b.allowedScope.kind &&
    a.allowedScope.installationId === b.allowedScope.installationId &&
    (a.allowedScope.kind === "installation" ||
      (b.allowedScope.kind === "agent" &&
        a.allowedScope.namespaceId === b.allowedScope.namespaceId &&
        a.allowedScope.agentId === b.allowedScope.agentId))
  );
}

/** Authenticated service profiles constrain calls independently of role ceilings. Exact
 * original-service readback is available; binding and purpose guards remain unintegrated.
 * Stored binding/evidence is never sufficient for a positive purpose result. */
export class RuntimeAuthorityService implements RuntimeAssignmentAuthorityV1 {
  private readonly options: RuntimeAuthorityServiceOptions;
  private readonly pendingReadbacks = new Set<Promise<unknown>>();
  /** Native accepting-path cleanup owns these actual store reads after public cancellation.
   * It never waits for arbitrary external inspector/current-reader promises. */
  async joinPendingReadbacks(): Promise<void> {
    while (this.pendingReadbacks.size > 0) await Promise.allSettled([...this.pendingReadbacks]);
  }
  constructor(options: RuntimeAuthorityServiceOptions) {
    this.options = options;
  }
  private async bounded<T>(
    call: AuthorityCallV1,
    work: (boundedCall: AuthorityCallV1) => Promise<T>,
  ): Promise<T> {
    const timeout = Math.min(3000, Date.parse(call.deadline) - this.options.clock.now().getTime());
    if (!Number.isFinite(timeout) || timeout <= 0 || call.signal.aborted)
      throw new Error("Runtime authority call expired.");
    const began = this.options.clock.monotonicMilliseconds();
    const cancellation = new AbortController();
    const boundedCall = { ...call, signal: AbortSignal.any([call.signal, cancellation.signal]) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const running = Promise.resolve().then(() => work(boundedCall));
    try {
      const result = await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          cancel = () => {
            cancellation.abort();
            reject(new Error("Runtime authority call unavailable."));
          };
          timer = setTimeout(cancel, timeout);
          call.signal.addEventListener("abort", cancel, { once: true });
        }),
      ]);
      const elapsed = this.options.clock.monotonicMilliseconds() - began;
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed >= timeout ||
        call.signal.aborted ||
        this.options.clock.now().getTime() >= Date.parse(call.deadline)
      )
        throw new Error("Runtime authority call expired.");
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancel) call.signal.removeEventListener("abort", cancel);
      cancellation.abort();
      // The canonical store/transport join their own bounded resource cleanup. An
      // arbitrary dependency that ignores cancellation must not delay this deadline.
    }
  }
  private async caller(call: AuthorityCallV1): Promise<RuntimeAuthorityCaller | undefined> {
    const { contextFactory, currentTrust, clock } = this.options;
    if (
      !contextFactory ||
      !currentTrust ||
      call.signal.aborted ||
      call.recipientRef !== this.options.recipientRef
    )
      return undefined;
    const began = clock.monotonicMilliseconds();
    const validBounds = () =>
      Number.isFinite(Date.parse(call.deadline)) &&
      clock.now().getTime() < Date.parse(call.deadline) &&
      !call.signal.aborted &&
      clock.monotonicMilliseconds() - began < 3000;
    if (!validBounds()) return undefined;
    const verified = await contextFactory.inspect(call.context, call);
    if (
      !validBounds() ||
      !verified ||
      verified.configuration.installationId !== this.options.installationId ||
      verified.configuration.permittedRecipientRef !== call.recipientRef ||
      !Number.isFinite(Date.parse(verified.authenticatedAt)) ||
      !Number.isFinite(Date.parse(verified.expiresAt)) ||
      Date.parse(verified.authenticatedAt) > clock.now().getTime() ||
      Date.parse(verified.expiresAt) <= clock.now().getTime()
    )
      return undefined;
    const current = await currentTrust.readCurrent(
      verified.configuration.serviceIdentityRef,
      call.signal,
    );
    const again = await contextFactory.inspect(call.context, call);
    if (
      !validBounds() ||
      !current ||
      !again ||
      (current.operationPolicy !== "read-operation-only-v1" &&
        current.operationPolicy !== "initial-harness-bind-v1") ||
      current.configuration.role !== "lifecycle-authority" ||
      current.configuration.allowedScope.kind !== "agent" ||
      again.transportBinding !== verified.transportBinding ||
      !sameConfiguration(verified.configuration, current.configuration) ||
      !sameConfiguration(again.configuration, current.configuration)
    )
      return undefined;
    return { ...again, operationPolicy: current.operationPolicy };
  }
  private scopeAllowed(
    verified: RuntimeAuthorityVerifiedServiceV1,
    input: { installationId: string; namespaceId: string; agentId: string },
  ): boolean {
    const scope = verified.configuration.allowedScope;
    return (
      input.installationId === this.options.installationId &&
      scope.installationId === input.installationId &&
      (scope.kind === "installation" ||
        (scope.namespaceId === input.namespaceId && scope.agentId === input.agentId))
    );
  }
  private async mutation(
    input: RuntimeMutationV1,
    call: AuthorityCallV1,
    method: RuntimeMutationV1["kind"],
  ): Promise<RuntimeMutationResultV1> {
    try {
      const request = parseRuntimeAuthorityV1("mutation", input);
      if (request.kind !== method)
        return {
          schemaVersion: 1,
          result: "rejected-before-effect",
          reasonCode: "operation-denied",
        };
      const verified = await this.bounded(call, (boundedCall) => this.caller(boundedCall));
      if (
        !verified ||
        request.requestRef !== call.requestRef ||
        !this.scopeAllowed(verified, request.target)
      )
        return { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "scope-hidden" };
      const policy = RUNTIME_AUTHORITY_ROLE_POLICY_V1[verified.configuration.role];
      const permission =
        request.kind === "record-evidence"
          ? `record-evidence:${request.evidence.kind}`
          : request.kind;
      if (
        !(policy.mutations as readonly string[]).includes(permission) ||
        verified.operationPolicy !== "initial-harness-bind-v1" ||
        request.kind !== "bind" ||
        request.target.component !== "harness" ||
        request.binding.provider !== "occ/kubernetes-gvisor" ||
        request.expectedBindingVersion !== null
      )
        return {
          schemaVersion: 1,
          result: "rejected-before-effect",
          reasonCode: "operation-denied",
        };
      if (!this.options.requestBinding?.matchesRequest("bind", request, call))
        return { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "scope-hidden" };
      // TODO(runtime authority acceptor): bind independent observation/profile proofs and
      // preparation/selection/responsibility CAS to this exact platform unit before wiring
      // writes. Plain service admission and fixture records cannot supply those predicates.
      return {
        schemaVersion: 1,
        result: "rejected-before-effect",
        reasonCode: "lookup-unavailable",
      };
    } catch {
      return {
        schemaVersion: 1,
        result: "rejected-before-effect",
        reasonCode: "lookup-unavailable",
      };
    }
  }
  async bind(input: BindRuntimeV1, call: AuthorityCallV1): Promise<BindingResultV1> {
    return parseRuntimeMutationResultV1("bind", await this.mutation(input, call, "bind"));
  }
  async recordEvidence(
    input: RuntimeEvidenceInputV1,
    call: AuthorityCallV1,
  ): Promise<EvidenceResultV1> {
    return parseRuntimeMutationResultV1(
      "record-evidence",
      await this.mutation(input, call, "record-evidence"),
    );
  }
  async retire(input: RetireAssignmentV1, call: AuthorityCallV1): Promise<RetirementResultV1> {
    return parseRuntimeMutationResultV1("retire", await this.mutation(input, call, "retire"));
  }
  async resolve(
    input: ResolveAssignmentRequestV1,
    call: AuthorityCallV1,
  ): Promise<ResolveAssignmentResultV1> {
    const evaluatedAt = this.options.clock.now().toISOString();
    try {
      const request = parseRuntimeAuthorityV1("resolveRequest", input);
      const verified = await this.bounded(call, (boundedCall) => this.caller(boundedCall));
      if (
        !verified ||
        request.requestRef !== call.requestRef ||
        !this.scopeAllowed(verified, request) ||
        // Neither admitted operation profile permits purpose resolution.
        verified.operationPolicy === "read-operation-only-v1" ||
        verified.operationPolicy === "initial-harness-bind-v1" ||
        !(
          RUNTIME_AUTHORITY_ROLE_POLICY_V1[verified.configuration.role]
            .purposes as readonly string[]
        ).includes(request.purpose)
      )
        return {
          schemaVersion: 1,
          result: "not-visible",
          reasonCode: "scope-hidden",
          evaluatedAt,
          requestRef: call.requestRef,
        };
      // TODO(runtime purpose readers): preparation, selection, protected Compute/verifier,
      // cleanup exclusion and completed-context policy producers remain unintegrated.
      return {
        schemaVersion: 1,
        result: "unavailable",
        reasonCode: "lookup-unavailable",
        evaluatedAt,
        requestRef: call.requestRef,
      };
    } catch {
      return {
        schemaVersion: 1,
        result: "unavailable",
        reasonCode: "lookup-unavailable",
        evaluatedAt,
        requestRef: call.requestRef,
      };
    }
  }
  async readOperation(
    input: ExactAuthorityOperationV1,
    call: AuthorityCallV1,
  ): Promise<AuthorityOperationStateV1> {
    try {
      return await this.bounded<AuthorityOperationStateV1>(call, async (boundedCall) => {
        const request = parseRuntimeAuthorityV1("exactOperation", input);
        const verified = await this.caller(boundedCall);
        if (
          !verified ||
          request.requestRef !== call.requestRef ||
          !this.scopeAllowed(verified, request) ||
          !this.options.requestBinding?.matchesRequest("readOperation", request, boundedCall) ||
          RUNTIME_AUTHORITY_ROLE_POLICY_V1[verified.configuration.role].operationRead !==
            "original-service"
        )
          return { schemaVersion: 1, result: "not-visible", reasonCode: "scope-hidden" };
        if (boundedCall.signal.aborted)
          return { schemaVersion: 1, result: "unavailable", nextAction: "exact-readback-only" };
        const reading = this.options.store.read(
          async (unit) => {
            if ((await unit.installations.getInstallation())?.id !== this.options.installationId)
              return undefined;
            return unit.runtimeAuthority.findOperation(request, request.operationRef);
          },
          {
            signal: boundedCall.signal,
            timeoutMs: Math.min(
              3000,
              Date.parse(boundedCall.deadline) - this.options.clock.now().getTime(),
            ),
          },
        );
        this.pendingReadbacks.add(reading);
        let stored;
        try {
          stored = await reading;
        } finally {
          this.pendingReadbacks.delete(reading);
        }
        const rechecked = await this.caller(boundedCall);
        if (
          !rechecked ||
          rechecked.operationPolicy !== verified.operationPolicy ||
          rechecked.transportBinding !== verified.transportBinding ||
          !sameConfiguration(rechecked.configuration, verified.configuration) ||
          !this.options.requestBinding?.matchesRequest("readOperation", request, boundedCall)
        )
          return { schemaVersion: 1, result: "not-visible", reasonCode: "scope-hidden" };
        if (!stored)
          return { schemaVersion: 1, result: "not-found", nextAction: "exact-readback-only" };
        if (stored.receipt.acceptedServiceIdentityRef !== verified.configuration.serviceIdentityRef)
          return { schemaVersion: 1, result: "not-visible", reasonCode: "scope-hidden" };
        if (
          stored.receipt.operationKind !== request.operationKind ||
          stored.receipt.canonicalPayloadDigest !== request.canonicalPayloadDigest
        )
          return { schemaVersion: 1, result: "conflict", reasonCode: "operation-payload-mismatch" };
        return { schemaVersion: 1, result: "committed", receipt: stored.receipt };
      });
    } catch {
      return { schemaVersion: 1, result: "unavailable", nextAction: "exact-readback-only" };
    }
  }
}
