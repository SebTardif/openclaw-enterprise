import type {
  AgentRevision,
  ComputeAgentBinding,
  Namespace,
  RuntimeAuthenticationAttachmentOutcomeV1,
  RuntimeAuthenticationProjectionV1,
  RuntimeAuthenticationReceiverV1,
} from "@openclaw-enterprise/contracts";
import type { Bounds, CoreAuthenticationBinding, LocalHandle } from "./handles.ts";
import type { ExternalRuntimeAuthenticationCapabilityV1 } from "./connection.ts";

/**
 * Broker-owned retained attempt and cleanup obligation, not a new access grant.
 * Owners authenticate same-kind handles and retain their records across restarts.
 */
export type RuntimeAuthenticationAttachmentV1 = LocalHandle<"runtime-authentication-attachment-v1">;

/**
 * Retained means the owner authenticated the original submitted or uncertain
 * attempt against the exact requested receiver. Inspect it without resubmission.
 */
export type RuntimeAuthenticationAttachmentPreparationV1 =
  | {
      readonly kind: "create";
      readonly attachment: RuntimeAuthenticationAttachmentV1;
      /** Exact nonsecret external provider references selected by the admitted profile. */
      readonly providers: readonly string[];
      /**
       * Immediately before create, atomically authenticate current authority, bounds and
       * exact receiver and consume this attempt once. A failed gate submits nothing.
       */
      assertAndConsume(): void;
    }
  | {
      readonly kind: "retained";
      readonly attachment: RuntimeAuthenticationAttachmentV1;
    };

/** Only a current, authenticated provider observation can establish attached. */
export type RuntimeAuthenticationAttachmentInspectionV1 =
  | {
      readonly state: "attached";
      readonly receiverUid: string;
      /** Finite epoch milliseconds, no later than the admitted session deadline. */
      readonly usableUntil: number;
    }
  | { readonly state: "pending" | "unknown" | "withdrawn" };

/** Unknown or pending withdrawal retains the original obligation for reconciliation. */
export interface RuntimeAuthenticationWithdrawalV1 {
  readonly state: "withdrawn" | "pending" | "unknown";
}

/**
 * External runtime attachment bridge owned by the existing credential broker.
 * Trusted composition supplies an implemented owner; these declarations supply no
 * Work admission, provider custody, attachment implementation or runtime evidence.
 *
 * Admission authenticates an existing {@link CoreAuthenticationBinding}, including
 * its genuine root/execution owner, Namespace, AgentRevision, principal, connection
 * generation, service, immutable profile and explicit bounded whole-session grant.
 * The registered mechanism must match {@link ExternalRuntimeAuthenticationCapabilityV1}.
 * Revision IDs, deployment authorization and provider configuration cannot replace
 * that binding. Unsupported lifetime or exact-receiver withdrawal fails closed.
 * The standing key stays with its external custodian through every method below.
 */
export interface RuntimeAuthenticationOwnerV1 {
  /** Configuration status does not admit an execution or prove an attached session. */
  status(input: {
    readonly binding: ComputeAgentBinding;
    readonly bounds: Bounds;
  }): Promise<{ readonly configured: boolean }>;

  /**
   * Resolve the genuine retained binding internally; do not mint authority from the
   * supplied revision. Return undefined when this revision has no admitted session.
   */
  prepare(input: {
    readonly revision: Readonly<AgentRevision>;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationProjectionV1 | undefined>;

  /**
   * Authenticate the projection and exact receiver, then durably retain the original
   * attempt and cleanup obligation before returning the one-use gate. Retry or alias
   * changes must not create replacement authority after an uncertain create.
   * Return the retained branch for the original submitted or uncertain attempt;
   * only inspection can determine whether its authentication is attached and usable.
   */
  prepareAttachment(input: {
    readonly projection: RuntimeAuthenticationProjectionV1;
    readonly receiver: RuntimeAuthenticationReceiverV1;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationAttachmentPreparationV1>;

  /**
   * Retain this attempt's create outcome idempotently, including unknown outcomes.
   * This does not promote create success or AlreadyExists to attached. Recording and
   * cleanup remain owned obligations after grant closure, expiry or caller abort.
   */
  observeAttachment(input: {
    readonly attachment: RuntimeAuthenticationAttachmentV1;
    readonly outcome: RuntimeAuthenticationAttachmentOutcomeV1;
    readonly bounds: Bounds;
  }): Promise<void>;

  /** Authenticate the exact receiver and current session from provider evidence. */
  inspect(input: {
    readonly attachment: RuntimeAuthenticationAttachmentV1;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationAttachmentInspectionV1>;

  /**
   * Withdraw this exact receiver's access; never delete or revoke its shared standing
   * provider key. Accept the retained cleanup handle after the access grant closes.
   */
  withdraw(input: {
    readonly attachment: RuntimeAuthenticationAttachmentV1;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationWithdrawalV1>;

  /**
   * Resolve retained obligations for this exact revision, including after restart.
   * Close further admission and reconcile all attempted receivers using the broker's
   * retained lifecycle ownership. This must not depend on an open Work or a process
   * map; withdrawn means every original obligation has confirmed withdrawal.
   */
  closeRevision(input: {
    readonly revision: Readonly<AgentRevision>;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationWithdrawalV1>;

  /**
   * Close every retained attachment in this Namespace, including receivers whose
   * Agent or revision metadata has been removed. The broker owns bounded durable
   * reconciliation; enumeration of current platform resources is insufficient.
   */
  closeNamespace(input: {
    readonly namespace: Readonly<Namespace>;
    readonly bounds: Bounds;
  }): Promise<RuntimeAuthenticationWithdrawalV1>;
}
