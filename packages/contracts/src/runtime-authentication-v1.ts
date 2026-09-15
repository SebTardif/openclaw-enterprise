/** Kind separation only; the trusted broker owner authenticates every handle at runtime. */
declare const runtimeAuthenticationProjection: unique symbol;

/**
 * Nonsecret projection of an admitted external authentication session. Never persist
 * this handle in an AgentRevision, reconstruct it from IDs, or treat its metadata
 * as authorization. The broker retains the genuine execution and grant binding.
 */
export interface RuntimeAuthenticationProjectionV1 {
  readonly [runtimeAuthenticationProjection]: "runtime-authentication-projection-v1";
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly executionId: string;
  readonly servicePrincipalId: string;
  readonly sandboxDriverId: string;
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly serviceId: string;
  /** Digest of the exact immutable credential profile admitted by the broker. */
  readonly profileDigest: string;
  /** Absolute epoch milliseconds, bounded by the grant and enforced by the mechanism. */
  readonly expiresAt: number;
  /** Explicit session permission; this projection does not promise per-request mediation. */
  readonly session: {
    readonly permission: "whole-session";
    readonly lifetime: "bounded";
    readonly withdrawal: "exact-receiver";
  };
}

/** Candidate placement facts. The owner must bind these to the admitted execution. */
export interface RuntimeAuthenticationReceiverV1 {
  readonly sandboxDriverId: string;
  readonly gatewayEndpoint: string;
  readonly workspace: string;
  readonly namespaceName: string;
  readonly resourceName: string;
}

/**
 * A create response is an observation, not proof that authentication is attached.
 * Ambiguous create or AlreadyExists outcomes remain unknown until owner inspection.
 */
export type RuntimeAuthenticationAttachmentOutcomeV1 =
  | { readonly kind: "created"; readonly receiverUid?: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "not-submitted" };

/**
 * In-process handoff from Compute to the selected Sandbox. Provider references are
 * nonsecret external identifiers; standing provider keys never cross this port.
 * Call the owner gate immediately before submitting the exact create request, and
 * report its outcome even when create fails or cancellation makes it ambiguous.
 */
export interface RuntimeAuthenticationDeliveryV1 {
  readonly providers: readonly string[];
  /** Rechecks current owner authority, exact receiver and expiry; succeeds only once. */
  assertAndConsume(): void;
  observe(outcome: RuntimeAuthenticationAttachmentOutcomeV1): Promise<void>;
}

/** Compute retains the owner and authenticates the Sandbox's exact planned receiver. */
export interface RuntimeAuthenticationRequestV1 {
  prepare(
    receiver: RuntimeAuthenticationReceiverV1,
    signal: AbortSignal,
  ): Promise<RuntimeAuthenticationDeliveryV1>;
}
