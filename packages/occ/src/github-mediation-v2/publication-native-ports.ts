import type {
  PublicationCallV1,
  PublicationCandidateV1,
  PublicationEffectV1,
  PublicationEffectOutcomeV1,
  PublicationSubmissionV1,
} from "../repository-publication-v1/contract.ts";

/** These types describe originals issued by the protected native connection
 * owner. Neither a wire record nor a dispatcher constructor issues them. The
 * actual owner must privately recognize every session and outcome below. */
declare const sessionBrand: unique symbol;
declare const outcomeBrand: unique symbol;
export interface GitHubPublicationNativeSessionV1 {
  readonly [sessionBrand]: true;
}
export interface GitHubPublicationNativeOutcomeV1 {
  readonly [outcomeBrand]: true;
}

export interface GitHubPublicationNativeBindingV1<Publisher extends object, Effect extends object> {
  readonly publisher: Publisher;
  readonly originalEffect: Effect;
  readonly call: PublicationCallV1;
  readonly effect: PublicationEffectV1;
  readonly actionDigest: string;
}

/** Mandatory construction operand from the ORIGINAL protected native owner.
 * There is intentionally no default, transport factory, read-permit adapter,
 * callback sink, credential accessor, caller URL or arbitrary HTTP request.
 *
 * prepare recognizes the exact publisher/effect/call, retains the original
 * registration/attachment, and resolves repository IDs to its qualified route.
 * It admits only the separate publication service/profile and current authority.
 * No provider effect occurs in prepare. A rejection MUST join/retire all hidden
 * native work before rejecting; an outward timeout is not physical retirement.
 *
 * Push PACK is a detached copy obtained from the genuine Git custodian, verified
 * against candidate.graph, and borrowed until prepare settles. The owner copies
 * it into its bounded session before settling; it independently verifies the
 * complete graph and expected-old fast-forward rule. It never accepts a caller
 * receive-pack command. All native and provider bounds are finite and retained
 * from the original call, including while preparation is pending.
 *
 * The session's result/drained promises exist BEFORE prepare returns. submit
 * only sends the one fixed committed response on that SAME native connection.
 * State.consumeUse precedes submit synchronously. submit can neither choose a
 * different operation nor release a token to a caller. The owner obtains the
 * use-specific token via its original credential custody and fixed receiver;
 * any required preparation occurs before this synchronous last send boundary.
 *
 * Cancellation closes the actual native/provider work and joins it. Result
 * observation is independently retained, including a known PR after cancellation
 * or uncertain drain. A result error cannot silently discard an already offered
 * observation. retire resolves only after original physical work is retired and
 * its result is settled; failures remain retryable on the SAME session. Outcome
 * recognition survives retire. No reconnect or implicit retry is permitted.
 */
export interface GitHubPublicationNativeOwnerV1<Publisher extends object, Effect extends object> {
  readonly preparePush: (
    publisher: Publisher,
    effect: Effect,
    candidate: PublicationCandidateV1,
    comparison: PublicationEffectV1,
    call: PublicationCallV1,
    pack: Uint8Array,
  ) => Promise<GitHubPublicationNativeSessionV1 | undefined>;
  readonly prepareDraftPullRequest: (
    publisher: Publisher,
    effect: Effect,
    candidate: PublicationCandidateV1,
    comparison: PublicationEffectV1,
    call: PublicationCallV1,
  ) => Promise<GitHubPublicationNativeSessionV1 | undefined>;
  readonly inspectPrepared: (
    original: GitHubPublicationNativeSessionV1,
  ) => GitHubPublicationNativeBindingV1<Publisher, Effect>;
  readonly retainSubmission: (
    original: GitHubPublicationNativeSessionV1,
  ) => PublicationSubmissionV1<GitHubPublicationNativeOutcomeV1>;
  readonly assertPrepared: (
    original: GitHubPublicationNativeSessionV1,
    call: PublicationCallV1,
  ) => undefined;
  /** Starts the preinstalled fixed submission synchronously; its return is not
   * an outward ticket. Even if it throws after possible send, the preinstalled
   * result/drain and retire methods remain the original physical-work join. */
  readonly submit: (original: GitHubPublicationNativeSessionV1) => undefined;
  readonly inspectOutcome: (
    session: GitHubPublicationNativeSessionV1,
    original: GitHubPublicationNativeOutcomeV1,
  ) => PublicationEffectOutcomeV1;
  readonly retire: (original: GitHubPublicationNativeSessionV1) => Promise<void>;
}
