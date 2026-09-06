import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  LifecycleAdmissionAssociationV1,
  LifecycleIntentHeadProjectionV1,
  LifecycleIntentV1,
  LifecycleMutationReceiptV1,
  LifecycleMutationRequestV1,
  LifecycleMutationResultV1,
  LifecycleOperationReadProjectionV1,
  LifecycleOperationReadRequestV1,
  ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { RuntimeScope } from "@openclaw-enterprise/contracts/runtime-assignment";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";

export type { LifecycleIntentHeadProjectionV1 };

/** In-process request custody only. The accepting implementation must verify the
 * actual handle, recipient, current account/session and selected policy on every
 * call. Neither this interface nor an earlier account observation is permission.
 * Installation is resolved from the authenticated controller and owning store.
 */
export interface LifecycleReadCallV1 {
  readonly authenticated: AuthenticatedRequestHandleV1;
  readonly signal: AbortSignal;
}

/** The controller retains these two identifiers before opening the admission
 * transaction. They are never decoded from a management body. transitionRef is
 * the one-use operation locator, not workId; requestId is diagnostic correlation.
 * The implementation must bind their real process custody and reject reuse,
 * including an identical second POST. This structural type supplies no proof.
 */
export interface LifecycleAdmissionCallV1 extends LifecycleReadCallV1 {
  readonly retained: Readonly<Pick<LifecycleIntentV1, "transitionRef" | "requestId">>;
}

declare const lifecycleRecoveryHandle: unique symbol;

/** Process-local recovery custody, never authority. Only the actual admission
 * owner may issue this after the uncertain unit has completely unwound. Its
 * private state retains the full immutable expected association, not just the
 * transition locator. No decoder, public constructor or implementation is
 * supplied. Consumers must not treat TypeScript branding as runtime protection:
 * the owner must reject foreign/copied handles and verify every use privately.
 */
export interface LifecycleRecoveryHandleV1 {
  readonly [lifecycleRecoveryHandle]: true;
}

export type LifecycleAdmissionOutcomeV1 =
  | Exclude<LifecycleMutationResultV1, { readonly kind: "commit-unknown" }>
  | {
      readonly kind: "commit-unknown";
      readonly recovery: LifecycleRecoveryHandleV1;
    };

export type LifecycleReadFailureV1 = Extract<
  LifecycleMutationResultV1,
  { readonly kind: "unavailable" | "rejected" }
>;

export type LifecycleRecoveryResultV1 =
  | {
      readonly kind: "confirmed";
      readonly receipt: Extract<LifecycleMutationReceiptV1, { readonly disposition: "accepted" }>;
    }
  | { readonly kind: "unconfirmed" }
  | LifecycleReadFailureV1;

/** Admission owns the authoritative atomic unit and returns accepted only after
 * confirmed COMMIT. It holds actual current authorization/profile comparisons
 * through commit, validates owner and CAS under the existing lock order, and
 * persists intent/history/head, any new revision, audit, original work and every
 * required cleanup responsibility together. No RPC or provider effect enters
 * this unit. A caught admission failure still makes the enclosing unit rollback-
 * only. No admitted result is produced by these interface declarations.
 *
 * A same-mode protective no-op still requires matching CAS and current mutation
 * authority. It emits the closed unchanged receipt without a new mutation audit,
 * work, intent or read-protected fields. Mutation authority need not imply read.
 * Counter exhaustion conflicts for material changes, never wraps or resets.
 *
 * admit is not an idempotency API. Unknown submission never authorizes another
 * POST or locator reuse. The future implementation keeps immutable expectations
 * privately through all failure paths and exposes recovery only after unwind.
 */
export interface LifecycleAdmissionPortV1 {
  admit(
    request: LifecycleMutationRequestV1,
    call: LifecycleAdmissionCallV1,
  ): Promise<LifecycleAdmissionOutcomeV1>;

  /** Fresh authorized read, never the failed ambient unit. Match Installation,
   * owner, original actor/request, exact command/source, generation/revision,
   * transition, audit and original work. A later head or completed/failed work
   * does not erase a complete historical acceptance. Partial or mismatched rows,
   * unavailable storage and missing current read authority cannot confirm it.
   * unconfirmed is not proof of rollback/absence and does not permit retry.
   * Recovery does not reactivate runtime or grant the original actor new rights.
   */
  recoverAfterUnwind(
    retained: LifecycleRecoveryHandleV1,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleRecoveryResultV1>;
}

export type LifecycleReadResultV1<T> =
  { readonly kind: "read"; readonly value: T } | LifecycleReadFailureV1;

/** Every query requires current exact Agent read and exact owner restriction.
 * The Installation comes from authenticated controller/store state. Foreign and
 * hidden targets share the closed not-found failure. Revision documents still
 * require both Agent and AgentRevision reads; these values contain IDs only.
 * No actor, request, audit, work, transcript, credential or runtime observation
 * enters these projections. Full status/observation ports remain separate.
 */
export interface LifecycleReadPortV1 {
  readCurrentIntent(
    scope: RuntimeScope,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleIntentHeadProjectionV1 | null>>;
  readOperation(
    request: LifecycleOperationReadRequestV1,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleOperationReadProjectionV1>>;
}

export type LifecycleWorkerReadResultV1 =
  | {
      readonly kind: "read";
      readonly association: LifecycleAdmissionAssociationV1;
      readonly currentIntent: LifecycleIntentV1 | null;
    }
  | LifecycleReadFailureV1;

/** Internal reader for an independently authenticated service. The real owner
 * verifies private service/recipient/purpose context and the complete original
 * persisted association before disclosure; a parsed work payload is not that
 * proof. The current head and historical association are read together, without
 * manufacturing missing observations or changing either record.
 *
 * A returned snapshot is not current-use or effect authority. The actual worker
 * still checks its claim, current intent, original actor/reference authority for
 * running work and all required profiles at each accepting boundary. Accepted
 * exact cleanup uses its own independent responsibility after human revocation;
 * it cannot activate, resume, purge or target a successor. Existing runtime
 * authority/effect ports retain these guards. No worker implementation, queue
 * registration, cleanup role or adapter is installed by this interface.
 */
export interface LifecycleWorkerReadPortV1 {
  readAdmittedWork(
    request: ReconcileAgentLifecycleV1,
    call: AuthorityCallV1,
  ): Promise<LifecycleWorkerReadResultV1>;
}
