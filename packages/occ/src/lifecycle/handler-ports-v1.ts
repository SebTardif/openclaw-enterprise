import type {
  LifecycleOperationReadRequestV1,
  ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  LifecycleCapabilityV1,
  LifecycleHandlerResultV1,
  LifecycleOperationPageRequestV1,
  LifecycleOperationPageV1,
  LifecycleOperationStatusV1,
  LifecycleStatusV1,
  RuntimeEffectAdmissionV1,
  RuntimeEffectsV1,
  WorkspaceHandoffEvidenceV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { RuntimeScope } from "@openclaw-enterprise/contracts/runtime-assignment";
import type {
  AuthorityCallV1,
  RuntimeAssignmentAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  LifecycleReadCallV1,
  LifecycleReadResultV1,
  LifecycleWorkerReadPortV1,
} from "./ports-v1.ts";
import type { WorkClaim } from "../ports/repositories/work.ts";

/** Existing queue claim correlation accompanies independently authenticated
 * service custody. Its shape, token and work locator are not a current lease or
 * effect grant. The actual handler verifies the original claim with its queue
 * owner and preserves claim-loss identity; neither a caller's Date nor a parsed
 * result may renew it. This call is in-process and has no serializable factory.
 */
export interface LifecycleHandlerCallV1 extends AuthorityCallV1 {
  readonly claim: Readonly<WorkClaim>;
}

/** Definition of the future admitted-work handler. Registration, queue codec,
 * constraints and compatible API/worker/maintenance/receiving processes must be
 * installed together before this handler can run. The installed revision-backed
 * queue cannot accept protective/resume work merely because this port exists.
 *
 * The handler first resolves the complete immutable admission/audit/work pair,
 * current intent and independently authenticated service purpose. It checks the
 * claim and current authority before and after waits and at every actual effect
 * acceptor. A read snapshot or earlier successful result supplies no grant.
 * Current running work needs original actor/reference/profile authority;
 * disabled/stopped work cannot prepare, restore, activate or repair execution.
 * Exact accepted cleanup retains independent responsibility after human revoke,
 * without create/resume/purge/successor authority or release of unknown writers.
 *
 * Preserve the original operation, request digest, responsibility and effect
 * identities before any possible submission. Each lookup/provider call is
 * bounded by its canonical ceiling and remaining enclosing deadline. Claim loss,
 * cancellation, deadline expiry and transport loss after possible submission
 * preserve unknown outcome. They do not justify absence, completion, a replacement
 * generation, reminted locator or blind retry. Fresh exact readback after unwind
 * uses the actual owner and current service/read authorization.
 *
 * Closing a request does not erase admitted cleanup or writer exclusion. Any
 * further bounded cleanup runs under the actual retained responsibility and a
 * fresh valid service call; extending the expired call or reusing human authority
 * is insufficient. Backoff/observation exhaustion remains blocked or unknown.
 */
export interface LifecycleHandlerPortV1 {
  reconcile(
    work: ReconcileAgentLifecycleV1,
    call: LifecycleHandlerCallV1,
  ): Promise<LifecycleHandlerResultV1>;
}

/** The owning observation producer derives results from its authentic records
 * and exact source receipts. The caller supplies only the canonical work locator
 * and private service context, never an aggregate claimed status to publish.
 *
 * Source and receipt times remain distinct. Actual scope, current generation,
 * source provenance, freshness, complete possible-create/runtime coverage and
 * cancellation responsibility are checked by the producer. A received timestamp,
 * terminal work state, database selection or schema-valid DTO cannot establish
 * serving, denial, termination, writer safety or retained state. Missing evidence
 * remains pending/unknown; observation never performs a lifecycle mutation.
 * The accepting publisher still needs its actual atomic current-version guard.
 */
export interface LifecycleObservationProducerPortV1 {
  observe(
    work: ReconcileAgentLifecycleV1,
    call: AuthorityCallV1,
  ): Promise<LifecycleHandlerResultV1>;
}

/** Exact existing provider interfaces for a future composition. This interface
 * does not construct, select, authenticate or qualify any provider. An actual
 * handler resolves these from its server-owned composition and rejects missing,
 * unsupported, changed or unqualified capabilities. It does not trust a caller-
 * supplied implementation merely because it has these TypeScript members.
 *
 * RuntimeEffectsV1 retains its exact effect/fence/cleanup identities;
 * RuntimeEffectAdmissionV1 remains the single canonical preparation/fault gate;
 * WorkspaceHandoffEvidenceV1 remains the owner of complete prior-writer/store
 * evidence. Do not flatten them into a generic stop flag or replacement journal.
 */
export interface LifecycleHandlerProvidersV1 {
  readonly authority: RuntimeAssignmentAuthorityV1;
  readonly effects: RuntimeEffectsV1;
  readonly effectAdmission: RuntimeEffectAdmissionV1;
  readonly workspace: WorkspaceHandoffEvidenceV1;
  readonly work: LifecycleWorkerReadPortV1;
  readonly observations: LifecycleObservationProducerPortV1;
}

/** Current authorized Agent reads only; management mutation permission does not
 * grant these projections. The reader resolves Installation from actual request/
 * store custody, restricts the exact Namespace/Agent, and denies hidden/foreign
 * targets without existence disclosure. Revision documents independently require
 * both Agent and AgentRevision permission; none is embedded here.
 *
 * Historical operation reads preserve their original immutable CTL-40 projection
 * after head advancement and never restart work. Discovery pages contain only
 * minimal immutable operation fields, not retained revision/actor/audit/work or
 * runtime details. Items and integer cursor come from the same authorized owner-
 * restricted bounded page. No foreign-row count, partial page or cursor is proof
 * of absence or enough to identify a lost request automatically.
 *
 * Status keeps desired/selected/serving revisions separate. Disabled convergence
 * requires affirmative access denial, effective route withdrawal and recorded
 * cancellation request. Stopped completion additionally requires current stopped
 * intent and all possible creates/runtimes resolved absent or terminated. Actual
 * credentials, retention and all-writer exclusion stay independently reported.
 * Read results are observations, never effect permits or current-authority cache.
 */
export interface LifecycleStatusReadPortV1 {
  readStatus(
    scope: RuntimeScope,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleStatusV1>>;

  readOperation(
    request: LifecycleOperationReadRequestV1,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleOperationStatusV1>>;

  listOperations(
    request: LifecycleOperationPageRequestV1,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleOperationPageV1>>;

  /** Server-owned compatibility observation, not a toggle or authority grant.
   * The real publisher verifies installed versions, actual drain/retained-stop
   * capability and old-writer exclusion. Missing capability cannot enable a
   * route. Live requires every affected process to participate; an older writer
   * must refuse startup, leases and mutations. No per-process opt-out is allowed.
   */
  readCapability(
    scope: RuntimeScope,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleReadResultV1<LifecycleCapabilityV1>>;
}
