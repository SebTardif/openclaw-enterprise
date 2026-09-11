import { types } from "node:util";
import {
  createPublicationCandidateV1,
  parsePublicationApprovalV1,
  parsePublicationApproverPolicyV1,
  parsePublicationCandidateV1,
  parsePublicationEffectOutcomeV1,
  parsePublicationEffectV1,
  parsePublicationRequestV1,
  parsePublicationStatusV1,
  parsePublicationWorkBindingV1,
  publicationCanonicalV1,
  publicationDigestV1,
  publicationOutcomeMatchesV1,
  publicationPolicyAllowsV1,
  publicationReferenceV1,
  publicationRefuseV1,
  type GitObjectCaptureV1,
  type PublicationApprovalV1,
  type PublicationApproverPolicyV1,
  type PublicationCallV1,
  type PublicationCandidateV1,
  type PublicationClockV1,
  type PublicationDispatcherV1,
  type PublicationEffectKindV1,
  type PublicationEffectV1,
  type PublicationOriginalsV1,
  type PublicationStateSourceV1,
  type PublicationStatusV1,
  type PublicationUseLeaseV1,
  type PublicationWorkSourceV1,
} from "./contract.ts";
import { GitObjectCustodyV1, type GitObjectInputV1 } from "./git-object-custody.ts";

export type PublicationResultV1<T> =
  | Readonly<{ kind: "complete"; value: T }>
  | Readonly<{ kind: "unknown"; reference: string; lastKnownStatus: PublicationStatusV1 | null }>
  | Readonly<{ kind: "refused" }>;

export interface PublicationOwnerOptionsV1<B extends PublicationOriginalsV1> {
  readonly policy: PublicationApproverPolicyV1;
  readonly clock: PublicationClockV1;
  readonly custody: GitObjectCustodyV1;
  readonly work: PublicationWorkSourceV1<B>;
  readonly state: PublicationStateSourceV1<B>;
  readonly dispatcher: PublicationDispatcherV1<B>;
  readonly maxPending: number;
}
function callBinding(
  value: PublicationCallV1,
): Readonly<{ requestRef: string; signal: AbortSignal }> {
  if (!value || typeof value !== "object" || types.isProxy(value)) publicationRefuseV1();
  const ref = Object.getOwnPropertyDescriptor(value, "requestRef");
  const signal = Object.getOwnPropertyDescriptor(value, "signal");
  if (
    !ref ||
    !("value" in ref) ||
    !publicationReferenceV1(ref.value) ||
    !signal ||
    !("value" in signal) ||
    !(signal.value instanceof AbortSignal)
  )
    publicationRefuseV1();
  return Object.freeze({ requestRef: ref.value, signal: signal.value });
}
const same = (a: unknown, b: unknown): boolean =>
  publicationCanonicalV1(a) === publicationCanonicalV1(b);
function synchronousUndefined(value: unknown, observed: Promise<unknown>[]): void {
  if (value === undefined) return;
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const pending = Promise.resolve(value);
    observed.push(pending);
    void pending.catch(() => undefined);
  }
  publicationRefuseV1();
}

/** Prepare/approve/publish application. State, IAM, Work and DS are the actual
 * construction-paired original suppliers; this class supplies no replacement
 * authority, journal, credential access or upstream transport. */
export class RepositoryPublicationOwnerV1<B extends PublicationOriginalsV1> {
  readonly #policy: PublicationApproverPolicyV1;
  readonly #policyDigest: string;
  readonly #readClock: PublicationClockV1["read"];
  readonly #work: PublicationWorkSourceV1<B>;
  readonly #state: PublicationStateSourceV1<B>;
  readonly #ds: PublicationDispatcherV1<B>;
  readonly #capture: GitObjectCustodyV1["capture"];
  readonly #inspectCapture: GitObjectCustodyV1["inspect"];
  readonly #restoreCapture: GitObjectCustodyV1["restore"];
  readonly #assertCapture: GitObjectCustodyV1["assertRequest"];
  readonly #maxPending: number;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #calls = new WeakMap<
    PublicationCallV1,
    Readonly<{ requestRef: string; signal: AbortSignal }>
  >();
  #closing = false;
  #closed: Promise<void> | undefined;
  constructor(options: PublicationOwnerOptionsV1<B>) {
    // Cheap policy/limit/clock validation precedes interaction with any original
    // supplier. Missing configuration can never default to an allowed approver.
    this.#policy = parsePublicationApproverPolicyV1(options.policy);
    this.#policyDigest = publicationDigestV1("approver-policy", this.#policy);
    if (
      !Number.isSafeInteger(options.maxPending) ||
      options.maxPending < 1 ||
      options.maxPending > 64 ||
      !(options.custody instanceof GitObjectCustodyV1)
    )
      publicationRefuseV1();
    this.#maxPending = options.maxPending;
    this.#readClock = options.clock.read.bind(options.clock);
    this.#now();
    const work = options.work;
    const state = options.state;
    const ds = options.dispatcher;
    this.#work = Object.freeze({
      acquire: work.acquire.bind(work),
      inspect: work.inspect.bind(work),
      assertCurrent: work.assertCurrent.bind(work),
      release: work.release.bind(work),
    });
    this.#state = Object.freeze({
      prepareCandidate: state.prepareCandidate.bind(state),
      inspectCandidate: state.inspectCandidate.bind(state),
      acquireApproval: state.acquireApproval.bind(state),
      inspectApproval: state.inspectApproval.bind(state),
      claimEffect: state.claimEffect.bind(state),
      inspectEffect: state.inspectEffect.bind(state),
      acquireUse: state.acquireUse.bind(state),
      recordOutcome: state.recordOutcome.bind(state),
      recordNotSubmitted: state.recordNotSubmitted.bind(state),
      recordUncertain: state.recordUncertain.bind(state),
      statusForEffect: state.statusForEffect.bind(state),
      readStatus: state.readStatus.bind(state),
      releaseEffect: state.releaseEffect.bind(state),
    });
    this.#ds = Object.freeze({
      preparePush: ds.preparePush.bind(ds),
      prepareDraftPullRequest: ds.prepareDraftPullRequest.bind(ds),
      inspectPrepared: ds.inspectPrepared.bind(ds),
      submit: ds.submit.bind(ds),
      inspectOutcome: ds.inspectOutcome.bind(ds),
      releasePrepared: ds.releasePrepared.bind(ds),
    });
    this.#capture = options.custody.capture.bind(options.custody);
    this.#inspectCapture = options.custody.inspect.bind(options.custody);
    this.#restoreCapture = options.custody.restore.bind(options.custody);
    this.#assertCapture = options.custody.assertRequest.bind(options.custody);
  }
  #now(): { lower: number; upper: number } {
    const sample = this.#readClock();
    if (
      !sample ||
      !Number.isSafeInteger(sample.wallMs) ||
      sample.wallMs < 0 ||
      !Number.isSafeInteger(sample.uncertaintyMs) ||
      sample.uncertaintyMs < 0 ||
      sample.uncertaintyMs > 2000 ||
      !Number.isSafeInteger(sample.wallMs + sample.uncertaintyMs)
    )
      publicationRefuseV1();
    return {
      lower: sample.wallMs - sample.uncertaintyMs,
      upper: sample.wallMs + sample.uncertaintyMs,
    };
  }
  #call(value: PublicationCallV1): PublicationCallV1 {
    const fixed = callBinding(value);
    const previous = this.#calls.get(value);
    if (previous && (fixed.requestRef !== previous.requestRef || fixed.signal !== previous.signal))
      publicationRefuseV1();
    this.#calls.set(value, fixed);
    return value;
  }
  #active(call: PublicationCallV1): void {
    const fixed = this.#calls.get(call);
    const current = callBinding(call);
    if (
      !fixed ||
      current.requestRef !== fixed.requestRef ||
      current.signal !== fixed.signal ||
      this.#closing ||
      fixed.signal.aborted
    )
      publicationRefuseV1();
  }
  #run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#pending.size >= this.#maxPending)
      return Promise.reject(new Error("Repository publication is unavailable"));
    const result = Promise.resolve().then(fn);
    this.#pending.add(result);
    void result.finally(() => this.#pending.delete(result)).catch(() => undefined);
    return result;
  }
  #candidate(
    original: B["candidate"],
    expectedRef?: string,
  ): { candidateRef: string; candidate: PublicationCandidateV1 } {
    const value = this.#state.inspectCandidate(original);
    if (
      !publicationReferenceV1(value.candidateRef) ||
      (expectedRef !== undefined && value.candidateRef !== expectedRef)
    )
      publicationRefuseV1();
    return {
      candidateRef: value.candidateRef,
      candidate: parsePublicationCandidateV1(value.candidate),
    };
  }
  #approval(
    original: B["approval"],
    candidateRef: string,
    candidate: PublicationCandidateV1,
    expectedRef?: string,
  ): PublicationApprovalV1 {
    const a = parsePublicationApprovalV1(this.#state.inspectApproval(original));
    const time = this.#now();
    if (
      a.candidateRef !== candidateRef ||
      a.actionDigest !== candidate.actionDigest ||
      (expectedRef !== undefined && a.approvalRef !== expectedRef) ||
      a.policyRef !== this.#policy.policyRef ||
      a.policyRevision !== this.#policy.revision ||
      a.policyDigest !== this.#policyDigest ||
      a.expiresAtMs - a.approvedAtMs > this.#policy.approvalLifetimeMs ||
      a.approvedAtMs > time.upper ||
      a.expiresAtMs <= time.upper ||
      !publicationPolicyAllowsV1(this.#policy, candidate, a.approverPrincipalId)
    )
      publicationRefuseV1();
    return a;
  }
  prepare(
    actor: B["actor"],
    request: unknown,
    objects: readonly GitObjectInputV1[],
    callValue: PublicationCallV1,
  ): Promise<
    PublicationResultV1<Readonly<{ candidateRef: string; candidate: PublicationCandidateV1 }>>
  > {
    const fixed = parsePublicationRequestV1(request);
    const call = this.#call(callValue);
    return this.#run(async () => {
      this.#active(call);
      const work = await this.#work.acquire(actor, fixed, call);
      if (!work) return Object.freeze({ kind: "refused" });
      const observedAssertions: Promise<unknown>[] = [];
      try {
        this.#active(call);
        synchronousUndefined(this.#work.assertCurrent(work, call), observedAssertions);
        const binding = parsePublicationWorkBindingV1(this.#work.inspect(work, call));
        const capture = await this.#capture(fixed, objects, call.signal);
        this.#active(call);
        synchronousUndefined(this.#work.assertCurrent(work, call), observedAssertions);
        if (!same(binding, parsePublicationWorkBindingV1(this.#work.inspect(work, call))))
          publicationRefuseV1();
        const candidate = createPublicationCandidateV1(
          binding,
          fixed,
          this.#inspectCapture(capture),
        );
        this.#assertCapture(capture, fixed);
        const committed = await this.#state.prepareCandidate(work, candidate, capture, call);
        if (committed.kind === "unknown") {
          if (!publicationReferenceV1(committed.reference)) publicationRefuseV1();
          return Object.freeze({
            kind: "unknown",
            reference: committed.reference,
            lastKnownStatus: null,
          });
        }
        if (committed.kind !== "committed") return Object.freeze({ kind: "refused" });
        const value = this.#candidate(committed.original);
        if (!same(value.candidate, candidate)) publicationRefuseV1();
        return Object.freeze({ kind: "complete", value: Object.freeze(value) });
      } finally {
        await Promise.allSettled(observedAssertions);
        await this.#joinFinalizer(() => this.#work.release(work));
      }
    });
  }
  approve(
    actor: B["actor"],
    candidateRef: string,
    callValue: PublicationCallV1,
  ): Promise<PublicationResultV1<PublicationApprovalV1>> {
    if (!publicationReferenceV1(candidateRef)) publicationRefuseV1();
    const call = this.#call(callValue);
    return this.#run(async () => {
      this.#active(call);
      const lease = await this.#state.acquireApproval(actor, candidateRef, this.#policy, call);
      if (!lease) return Object.freeze({ kind: "refused" });
      // Capture the original source's cleanup before any material/record read.
      const release = lease.release.bind(lease);
      const current = lease.assertCurrent.bind(lease);
      const commit = lease.commit.bind(lease);
      const observedAssertions: Promise<unknown>[] = [];
      try {
        this.#active(call);
        synchronousUndefined(current(), observedAssertions);
        const held = this.#candidate(lease.candidate, candidateRef);
        const principalId = lease.principalId;
        const approvedAtMs = lease.approvedAtMs;
        const expiresAtMs = lease.expiresAtMs;
        const time = this.#now();
        if (
          !publicationReferenceV1(principalId) ||
          !publicationPolicyAllowsV1(this.#policy, held.candidate, principalId) ||
          !Number.isSafeInteger(approvedAtMs) ||
          !Number.isSafeInteger(expiresAtMs) ||
          approvedAtMs < 0 ||
          approvedAtMs > time.upper ||
          expiresAtMs <= time.upper ||
          expiresAtMs <= approvedAtMs ||
          expiresAtMs - approvedAtMs > this.#policy.approvalLifetimeMs
        )
          publicationRefuseV1();
        // Recover actual retained bytes before recording approval; no workspace
        // re-read or amended commit can silently substitute the candidate.
        const capture = await this.#restoreCapture(
          held.candidate.graph,
          held.candidate.request,
          call.signal,
        );
        this.#active(call);
        synchronousUndefined(current(), observedAssertions);
        this.#assertCapture(capture, held.candidate.request);
        if (
          !same(this.#candidate(lease.candidate, candidateRef).candidate, held.candidate) ||
          lease.principalId !== principalId ||
          lease.approvedAtMs !== approvedAtMs ||
          lease.expiresAtMs !== expiresAtMs ||
          this.#now().upper >= expiresAtMs
        )
          publicationRefuseV1();
        const result = await commit();
        if (result.kind === "unknown") {
          if (!publicationReferenceV1(result.reference)) publicationRefuseV1();
          return Object.freeze({
            kind: "unknown",
            reference: result.reference,
            lastKnownStatus: null,
          });
        }
        if (result.kind !== "committed") return Object.freeze({ kind: "refused" });
        const value = this.#approval(result.original, candidateRef, held.candidate);
        if (
          value.approverPrincipalId !== principalId ||
          value.approvedAtMs !== approvedAtMs ||
          value.expiresAtMs !== expiresAtMs
        )
          publicationRefuseV1();
        return Object.freeze({ kind: "complete", value });
      } finally {
        await Promise.allSettled(observedAssertions);
        await this.#joinFinalizer(release);
      }
    });
  }
  async #effect(
    publisher: B["publisher"],
    candidateRef: string,
    approvalRef: string,
    kind: PublicationEffectKindV1,
    call: PublicationCallV1,
    previous: PublicationStatusV1 | null,
  ): Promise<PublicationResultV1<PublicationStatusV1>> {
    this.#active(call);
    const claim = await this.#state.claimEffect(
      publisher,
      candidateRef,
      approvalRef,
      kind,
      this.#policy,
      call,
    );
    if (claim.kind === "unknown") {
      if (!publicationReferenceV1(claim.reference)) publicationRefuseV1();
      return Object.freeze({
        kind: "unknown",
        reference: claim.reference,
        lastKnownStatus: previous,
      });
    }
    if (claim.kind === "existing") {
      const status = parsePublicationStatusV1(claim.status);
      const existing = this.#candidate(claim.candidate, candidateRef).candidate;
      if (status.actionDigest !== existing.actionDigest) publicationRefuseV1();
      for (const row of [status.push, status.pullRequest])
        if (row && !publicationOutcomeMatchesV1(existing, row.effect, row.outcome))
          publicationRefuseV1();
      if (
        status.candidateRef !== candidateRef ||
        (previous && status.actionDigest !== previous.actionDigest) ||
        (status.push && status.push.effect.approvalRef !== approvalRef) ||
        (status.pullRequest && status.pullRequest.effect.approvalRef !== approvalRef)
      )
        publicationRefuseV1();
      return Object.freeze({ kind: "complete", value: status });
    }
    if (claim.kind !== "committed")
      return previous
        ? Object.freeze({ kind: "complete", value: previous })
        : Object.freeze({ kind: "refused" });
    const original = claim.original;
    let prepared: B["prepared"] | undefined;
    let use: PublicationUseLeaseV1<B> | undefined;
    let releaseUse: (() => Promise<void>) | undefined;
    let submitted = false;
    let recorded = false;
    let finalResult: PublicationResultV1<PublicationStatusV1> = Object.freeze({
      kind: "unknown",
      reference: candidateRef,
      lastKnownStatus: previous,
    });
    let candidate: PublicationCandidateV1 | undefined;
    let effect: PublicationEffectV1 | undefined;
    let retainedOutcome: B["outcome"] | null = null;
    let observedResult: Promise<void> | undefined;
    const observedAssertions: Promise<unknown>[] = [];
    try {
      this.#active(call);
      const held = this.#state.inspectEffect(original);
      effect = parsePublicationEffectV1(held.effect);
      const captured = this.#candidate(held.candidate, candidateRef);
      candidate = captured.candidate;
      if (
        effect.kind !== kind ||
        effect.candidateRef !== candidateRef ||
        effect.approvalRef !== approvalRef ||
        effect.actionDigest !== candidate.actionDigest ||
        (previous && previous.actionDigest !== candidate.actionDigest) ||
        (kind === "create-draft-pr" &&
          (!previous?.push ||
            previous.push.outcome.kind !== "pushed" ||
            effect.confirmedPushEffectRef !== previous.push.effect.effectRef))
      )
        publicationRefuseV1();
      this.#approval(held.approval, candidateRef, candidate, approvalRef);
      let capture: GitObjectCaptureV1 | undefined;
      if (kind === "push")
        capture = await this.#restoreCapture(candidate.graph, candidate.request, call.signal);
      this.#active(call);
      this.#approval(held.approval, candidateRef, candidate, approvalRef);
      if (capture) this.#assertCapture(capture, candidate.request);
      prepared =
        kind === "push"
          ? await this.#ds.preparePush(publisher, original, candidate, capture!, call)
          : await this.#ds.prepareDraftPullRequest(publisher, original, candidate, call);
      if (!prepared) publicationRefuseV1();
      this.#active(call);
      const dispatch = this.#ds.inspectPrepared(prepared);
      if (
        dispatch.effectRef !== effect.effectRef ||
        dispatch.actionDigest !== effect.actionDigest ||
        dispatch.kind !== kind
      )
        publicationRefuseV1();
      use = await this.#state.acquireUse(original, prepared, call);
      if (!use) publicationRefuseV1();
      releaseUse = use.release.bind(use);
      const currentUse = use.assertCurrent.bind(use);
      const beginUse = use.beginSubmittedUse.bind(use);
      this.#active(call);
      synchronousUndefined(currentUse(), observedAssertions);
      if (
        use.effect !== original ||
        !same(this.#candidate(use.candidate, candidateRef).candidate, candidate)
      )
        publicationRefuseV1();
      this.#approval(use.approval, candidateRef, candidate, approvalRef);
      // No await crosses the final State fence and actual fixed DS submission.
      // Mark uncertain conservatively before invoking either, including throws.
      submitted = true;
      synchronousUndefined(beginUse(), observedAssertions);
      const ticket = this.#ds.submit(prepared, use.original);
      const result = ticket.result;
      if (!types.isPromise(result)) publicationRefuseV1();
      // Retain the available result before another ticket field can throw or
      // refuse. Observe rejection now, even while actual retirement is pending.
      observedResult = Promise.allSettled([result]).then(([settled]) => {
        if (settled!.status === "fulfilled") retainedOutcome = settled!.value;
      });
      const drained = ticket.drained;
      if (!types.isPromise(drained)) publicationRefuseV1();
      const settled = await Promise.allSettled([result, drained]);
      if (settled[0]!.status === "fulfilled") retainedOutcome = settled[0]!.value;
      if (settled[0]!.status !== "fulfilled" || settled[1]!.status !== "fulfilled")
        publicationRefuseV1();
      const outcomeOriginal = settled[0]!.value;
      const observed = this.#ds.inspectOutcome(outcomeOriginal);
      const outcome = parsePublicationEffectOutcomeV1(observed.outcome);
      if (
        observed.effectRef !== effect.effectRef ||
        observed.actionDigest !== effect.actionDigest ||
        !publicationOutcomeMatchesV1(candidate, effect, outcome)
      )
        publicationRefuseV1();
      recorded = (await this.#state.recordOutcome(original, outcomeOriginal)) === "committed";
    } catch {
      // The original State claim survives exceptions/cancellation. Cleanup below
      // joins physical DS retirement before releasing the submitted-use lease.
    } finally {
      // Only idempotent finalizers are retried. They cannot submit another
      // effect, replace an original operand, or turn uncertainty into success.
      await Promise.allSettled(observedAssertions);
      if (prepared) await this.#joinFinalizer(() => this.#ds.releasePrepared(prepared!));
      // Prepared retirement may finish the original result. Join its retained
      // settlement before releasing use or transferring State observer custody.
      await observedResult;
      if (releaseUse) await this.#joinFinalizer(releaseUse);
      if (!recorded) {
        try {
          if (submitted) await this.#state.recordUncertain(original, retainedOutcome);
          else await this.#state.recordNotSubmitted(original);
        } catch {
          /* The previously committed original claim remains unknown. */
        }
      }
      try {
        // Read through the still-held original observer BEFORE its release.
        const status = parsePublicationStatusV1(await this.#state.statusForEffect(original));
        if (
          status.candidateRef !== candidateRef ||
          (candidate && status.actionDigest !== candidate.actionDigest)
        )
          publicationRefuseV1();
        if (candidate)
          for (const row of [status.push, status.pullRequest])
            if (row && !publicationOutcomeMatchesV1(candidate, row.effect, row.outcome))
              publicationRefuseV1();
        finalResult = Object.freeze({ kind: "complete", value: status });
      } catch {
        finalResult = Object.freeze({
          kind: "unknown",
          reference: effect?.effectRef ?? candidateRef,
          lastKnownStatus: previous,
        });
      } finally {
        await this.#joinFinalizer(() => this.#state.releaseEffect(original));
      }
    }
    return finalResult;
  }
  async #joinFinalizer(finalizer: () => Promise<void>): Promise<void> {
    for (;;) {
      try {
        await finalizer();
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 30000));
      }
    }
  }

  publish(
    publisher: B["publisher"],
    candidateRef: string,
    approvalRef: string,
    callValue: PublicationCallV1,
  ): Promise<PublicationResultV1<PublicationStatusV1>> {
    if (!publicationReferenceV1(candidateRef) || !publicationReferenceV1(approvalRef))
      publicationRefuseV1();
    const call = this.#call(callValue);
    return this.#run(async () => {
      const push = await this.#effect(publisher, candidateRef, approvalRef, "push", call, null);
      if (
        push.kind !== "complete" ||
        push.value.state !== "pushed" ||
        push.value.push?.outcome.kind !== "pushed" ||
        push.value.pullRequest !== null ||
        this.#closing ||
        call.signal.aborted
      )
        return push;
      return this.#effect(
        publisher,
        candidateRef,
        approvalRef,
        "create-draft-pr",
        call,
        push.value,
      );
    });
  }
  status(
    actor: B["actor"],
    candidateRef: string,
    callValue: PublicationCallV1,
  ): Promise<PublicationStatusV1> {
    if (!publicationReferenceV1(candidateRef)) publicationRefuseV1();
    const call = this.#call(callValue);
    return this.#run(async () => {
      this.#active(call);
      const status = parsePublicationStatusV1(
        await this.#state.readStatus(actor, candidateRef, call),
      );
      if (status.candidateRef !== candidateRef) publicationRefuseV1();
      return status;
    });
  }
  /** Stops new application work and waits for original submissions and source
   * finalizers. The service assembler closes shared custody/clock sources afterward. */
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#closed = (async () => {
      await Promise.allSettled([...this.#pending]);
    })();
    return this.#closed;
  }
}
