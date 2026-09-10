import { performance } from "node:perf_hooks";
import { types } from "node:util";
import {
  parsePublicationCandidateV1,
  parsePublicationEffectV1,
  parsePublicationEffectOutcomeV1,
  parsePublicationGraphV1,
  publicationCanonicalV1,
  publicationReferenceV1,
  publicationRefuseV1,
  type GitObjectCaptureV1,
  type PublicationCallV1,
  type PublicationCandidateV1,
  type PublicationDispatcherV1,
  type PublicationEffectV1,
  type PublicationEffectOutcomeV1,
  type PublicationOriginalsV1,
  type PublicationSubmissionV1,
} from "../repository-publication-v1/contract.ts";
import { GitObjectCustodyV1 } from "../repository-publication-v1/git-object-custody.ts";
import { verifyGitHubPublicationPackV1 } from "./publication-wire.ts";
import type { RepositoryPublicationDispatchParticipantV1 } from "../ports/repository-publication-dispatch-v1.ts";
import type {
  GitHubPublicationNativeOwnerV1,
  GitHubPublicationNativeSessionV1,
  GitHubPublicationNativeOutcomeV1,
} from "./publication-native-ports.ts";

declare const preparedBrand: unique symbol;
declare const outcomeBrand: unique symbol;
export interface GitHubPublicationPreparedV1 {
  readonly [preparedBrand]: true;
}
export interface GitHubPublicationOutcomeV1 {
  readonly [outcomeBrand]: true;
}
/** State keeps its original actor/Work/candidate/approval/effect/use types. Only
 * the two receipts actually issued by this dispatcher are selected here. */
export type GitHubPublicationOriginalsV1<B extends PublicationOriginalsV1> = Omit<
  B,
  "prepared" | "outcome"
> &
  Readonly<{
    prepared: GitHubPublicationPreparedV1;
    outcome: GitHubPublicationOutcomeV1;
  }>;

type CallSnapshot = { requestRef: string; signal: AbortSignal };
type Row<B extends PublicationOriginalsV1> = {
  original: GitHubPublicationPreparedV1;
  publisher: B["publisher"];
  effectOriginal: B["effect"];
  candidateOriginal: B["candidate"];
  approvalOriginal: B["approval"];
  effect: PublicationEffectV1;
  candidate: PublicationCandidateV1;
  call: PublicationCallV1;
  capturedCall: CallSnapshot;
  capture: GitObjectCaptureV1 | undefined;
  expiresMono: number;
  closing: boolean;
  retired: boolean;
  attempted: boolean;
  fault: boolean;
  native: GitHubPublicationNativeSessionV1 | undefined;
  nativeTicket: PublicationSubmissionV1<GitHubPublicationNativeOutcomeV1> | undefined;
  ticket: PublicationSubmissionV1<GitHubPublicationOutcomeV1> | undefined;
  preparationFinished: Promise<void>;
  finishPreparation: () => void;
  retirement: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  aborted: () => void;
};

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addEvent = EventTarget.prototype.addEventListener;
const removeEvent = EventTarget.prototype.removeEventListener;
function aborted(signal: AbortSignal): boolean {
  try {
    return abortedGetter.call(signal) === true;
  } catch {
    return publicationRefuseV1();
  }
}
function originalObject(value: unknown): asserts value is object {
  if (!value || typeof value !== "object" || types.isProxy(value)) publicationRefuseV1();
}
function captureCall(call: PublicationCallV1): CallSnapshot {
  originalObject(call);
  if (Reflect.ownKeys(call).length !== 2) publicationRefuseV1();
  const request = Object.getOwnPropertyDescriptor(call, "requestRef");
  const signal = Object.getOwnPropertyDescriptor(call, "signal");
  if (
    !request ||
    !("value" in request) ||
    !publicationReferenceV1(request.value) ||
    !signal ||
    !("value" in signal)
  )
    publicationRefuseV1();
  aborted(signal.value);
  return { requestRef: request.value, signal: signal.value };
}
function ticketFrom(
  value: PublicationSubmissionV1<GitHubPublicationNativeOutcomeV1>,
): PublicationSubmissionV1<GitHubPublicationNativeOutcomeV1> {
  originalObject(value);
  // Preserve the original owner's declared promise types. These descriptor and
  // promise checks establish shape only; native inspectOutcome recognizes the outcome.
  const result: TypedPropertyDescriptor<Promise<GitHubPublicationNativeOutcomeV1>> | undefined =
    Object.getOwnPropertyDescriptor(value, "result");
  const drained: TypedPropertyDescriptor<Promise<void>> | undefined =
    Object.getOwnPropertyDescriptor(value, "drained");
  if (
    !result ||
    !("value" in result) ||
    !types.isPromise(result.value) ||
    !drained ||
    !("value" in drained) ||
    !types.isPromise(drained.value)
  )
    publicationRefuseV1();
  return Object.freeze({ result: result.value, drained: drained.value });
}
function ignoreRejection(promise: Promise<unknown>): void {
  // Observation suppresses unhandled-rejection reporting without replacing the
  // original promise that the caller and physical retirement continue to join.
  void promise.catch(() => undefined);
}

/** Concrete publication dispatcher. Private WeakMaps recognize issued operands;
 * inspection records and wire data cannot enroll a receipt. Its finite local
 * timer only withdraws/cleans up; it supplies no Work clock or authority grant. */
export class GitHubPublicationDispatcherV1<
  B extends PublicationOriginalsV1,
> implements PublicationDispatcherV1<GitHubPublicationOriginalsV1<B>> {
  readonly #native: GitHubPublicationNativeOwnerV1<B["publisher"], B["effect"]>;
  readonly #capture: Pick<GitObjectCustodyV1, "inspect" | "assertRequest" | "readPack">;
  readonly #maximumEntries: number;
  readonly #maximumPreparedMilliseconds: number;
  readonly #prepared = new WeakMap<GitHubPublicationPreparedV1, Row<B>>();
  readonly #effects = new WeakSet<B["effect"]>();
  readonly #uses = new WeakSet<B["use"]>();
  readonly #calls = new WeakMap<PublicationCallV1, CallSnapshot>();
  readonly #outcomes = new WeakMap<
    GitHubPublicationOutcomeV1,
    {
      effectRef: string;
      actionDigest: string;
      outcome: PublicationEffectOutcomeV1 | undefined;
      // Enroll the offered ORIGINAL before inspection. Even failed inspection
      // leaves an attributable original receipt for State.recordUncertain.
      nativeOutcome: GitHubPublicationNativeOutcomeV1;
      nativeSession: GitHubPublicationNativeSessionV1;
    }
  >();
  #state: RepositoryPublicationDispatchParticipantV1<GitHubPublicationOriginalsV1<B>> | undefined;
  #entries = 0;

  constructor(
    options: Readonly<{
      custody: GitObjectCustodyV1;
      native: GitHubPublicationNativeOwnerV1<B["publisher"], B["effect"]>;
      maximumEntries: number;
      maximumPreparedMilliseconds: number;
    }>,
  ) {
    if (
      !(options.custody instanceof GitObjectCustodyV1) ||
      !Number.isSafeInteger(options.maximumEntries) ||
      options.maximumEntries < 1 ||
      options.maximumEntries > 64 ||
      !Number.isSafeInteger(options.maximumPreparedMilliseconds) ||
      options.maximumPreparedMilliseconds < 1 ||
      options.maximumPreparedMilliseconds > 120000
    )
      publicationRefuseV1();
    this.#maximumEntries = options.maximumEntries;
    this.#maximumPreparedMilliseconds = options.maximumPreparedMilliseconds;
    // Use the original class methods, never instance overrides that can turn a
    // caller-created capture record into a successful recognizer result.
    this.#capture = Object.freeze({
      inspect: GitObjectCustodyV1.prototype.inspect.bind(options.custody),
      assertRequest: GitObjectCustodyV1.prototype.assertRequest.bind(options.custody),
      readPack: GitObjectCustodyV1.prototype.readPack.bind(options.custody),
    });
    const n = options.native;
    originalObject(n);
    this.#native = Object.freeze({
      preparePush: n.preparePush.bind(n),
      prepareDraftPullRequest: n.prepareDraftPullRequest.bind(n),
      inspectPrepared: n.inspectPrepared.bind(n),
      retainSubmission: n.retainSubmission.bind(n),
      assertPrepared: n.assertPrepared.bind(n),
      submit: n.submit.bind(n),
      inspectOutcome: n.inspectOutcome.bind(n),
      retire: n.retire.bind(n),
    });
  }

  bindState(
    participant: RepositoryPublicationDispatchParticipantV1<GitHubPublicationOriginalsV1<B>>,
  ): undefined {
    if (this.#state) publicationRefuseV1();
    originalObject(participant);
    this.#state = Object.freeze({
      inspectEffect: participant.inspectEffect.bind(participant),
      assertUse: participant.assertUse.bind(participant),
      consumeUse: participant.consumeUse.bind(participant),
    });
    return undefined;
  }

  #assertCall(row: Row<B>): void {
    const call = captureCall(row.call);
    if (
      call.requestRef !== row.capturedCall.requestRef ||
      call.signal !== row.capturedCall.signal ||
      aborted(call.signal) ||
      row.closing ||
      row.retired ||
      performance.now() >= row.expiresMono
    )
      publicationRefuseV1();
  }
  #assertEffect(row: Row<B>): void {
    const inspected = this.#state!.inspectEffect(row.effectOriginal);
    if (
      inspected.candidate !== row.candidateOriginal ||
      inspected.approval !== row.approvalOriginal ||
      publicationCanonicalV1(parsePublicationEffectV1(inspected.effect)) !==
        publicationCanonicalV1(row.effect)
    )
      publicationRefuseV1();
  }
  #row(original: GitHubPublicationPreparedV1): Row<B> {
    const row = this.#prepared.get(original);
    if (!row) publicationRefuseV1();
    return row;
  }
  #retire(row: Row<B>): Promise<void> {
    if (row.retired) return Promise.resolve();
    row.closing = true;
    if (row.retirement) return row.retirement;
    const retirement = (async () => {
      await row.preparationFinished;
      if (row.native) {
        // Native acknowledgement is mandatory; a timer, signal or rejected
        // outward drain alone never frees the original physical-work slot.
        const retired = this.#native.retire(row.native);
        if (!types.isPromise(retired)) publicationRefuseV1();
        await retired;
        if (row.nativeTicket)
          await Promise.allSettled([row.nativeTicket.result, row.nativeTicket.drained]);
        if (row.ticket) await Promise.allSettled([row.ticket.result, row.ticket.drained]);
      }
      row.retired = true;
      if (row.timer) clearTimeout(row.timer);
      removeEvent.call(row.capturedCall.signal, "abort", row.aborted);
      row.capture = undefined;
      this.#entries--;
    })();
    row.retirement = retirement;
    void retirement.catch(() => {
      if (row.retirement === retirement) {
        row.retirement = undefined;
        // A failed preparation may never expose its receipt to the caller.
        // Keep that original cleanup owned here; retry only retirement, never
        // preparation, State consumption, token release or provider submission.
        if (row.timer) clearTimeout(row.timer);
        row.timer = setTimeout(row.aborted, 30000);
      }
    });
    return retirement;
  }

  async #prepare(
    publisher: B["publisher"],
    originalEffect: B["effect"],
    value: PublicationCandidateV1,
    capture: GitObjectCaptureV1 | undefined,
    call: PublicationCallV1,
    kind: "push" | "create-draft-pr",
  ): Promise<GitHubPublicationPreparedV1 | undefined> {
    if (!this.#state || this.#entries >= this.#maximumEntries) publicationRefuseV1();
    originalObject(publisher);
    originalObject(originalEffect);
    if (this.#effects.has(originalEffect)) publicationRefuseV1();
    const candidate = parsePublicationCandidateV1(value);
    const inspected = this.#state.inspectEffect(originalEffect);
    originalObject(inspected.candidate);
    originalObject(inspected.approval);
    const effect = parsePublicationEffectV1(inspected.effect);
    if (effect.kind !== kind || effect.actionDigest !== candidate.actionDigest)
      publicationRefuseV1();
    const snapshot = captureCall(call);
    const priorCall = this.#calls.get(call);
    if (
      aborted(snapshot.signal) ||
      (priorCall &&
        (priorCall.signal !== snapshot.signal || priorCall.requestRef !== snapshot.requestRef))
    )
      publicationRefuseV1();
    this.#calls.set(call, snapshot);
    if (kind === "push") {
      if (!capture) publicationRefuseV1();
      this.#capture.assertRequest(capture, candidate.request);
      if (
        publicationCanonicalV1(parsePublicationGraphV1(this.#capture.inspect(capture))) !==
        publicationCanonicalV1(candidate.graph)
      )
        publicationRefuseV1();
    }
    let finishPreparation!: () => void;
    const preparationFinished = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    // The cast only labels an object allocated HERE and enrolled below; it does
    // not construct a Work/State/capture/native operand or confer permission.
    const original = Object.freeze(Object.create(null)) as GitHubPublicationPreparedV1;
    const row: Row<B> = {
      original,
      publisher,
      effectOriginal: originalEffect,
      candidateOriginal: inspected.candidate,
      approvalOriginal: inspected.approval,
      effect,
      candidate,
      call,
      capturedCall: snapshot,
      capture,
      expiresMono: performance.now() + this.#maximumPreparedMilliseconds,
      closing: false,
      retired: false,
      attempted: false,
      fault: false,
      native: undefined,
      nativeTicket: undefined,
      ticket: undefined,
      preparationFinished,
      finishPreparation,
      retirement: undefined,
      timer: undefined,
      aborted: () => {
        ignoreRejection(this.#retire(row));
      },
    };
    this.#effects.add(originalEffect);
    this.#prepared.set(original, row);
    this.#entries++;
    row.timer = setTimeout(row.aborted, this.#maximumPreparedMilliseconds);
    addEvent.call(snapshot.signal, "abort", row.aborted, { once: true });
    let pack: Buffer | undefined;
    let failed = false;
    try {
      this.#assertCall(row);
      if (kind === "push") {
        const offered = await this.#capture.readPack(capture!);
        // The original readPack already returns its own detached buffer. Make a
        // second bounded copy for this borrower, and erase both on release.
        try {
          if (
            !types.isUint8Array(offered) ||
            offered.byteLength !== candidate.graph.packBytes ||
            offered.byteLength < 32 ||
            offered.byteLength > 80 * 1024 * 1024
          )
            publicationRefuseV1();
          pack = Buffer.from(offered);
        } finally {
          if (types.isUint8Array(offered)) offered.fill(0);
        }
        verifyGitHubPublicationPackV1(candidate, pack);
        this.#capture.assertRequest(capture!, candidate.request);
      }
      this.#assertEffect(row);
      this.#assertCall(row);
      row.native =
        kind === "push"
          ? await this.#native.preparePush(
              publisher,
              originalEffect,
              candidate,
              effect,
              call,
              pack!,
            )
          : await this.#native.prepareDraftPullRequest(
              publisher,
              originalEffect,
              candidate,
              effect,
              call,
            );
      if (!row.native) failed = true;
      else {
        const binding = this.#native.inspectPrepared(row.native);
        if (
          binding.publisher !== publisher ||
          binding.originalEffect !== originalEffect ||
          binding.call !== call ||
          binding.actionDigest !== candidate.actionDigest ||
          publicationCanonicalV1(parsePublicationEffectV1(binding.effect)) !==
            publicationCanonicalV1(effect)
        )
          publicationRefuseV1();
        const retained = ticketFrom(this.#native.retainSubmission(row.native));
        row.nativeTicket = retained;
        const result = retained.result.then(
          (nativeOutcome) => {
            originalObject(nativeOutcome);
            const issued = Object.freeze(Object.create(null)) as GitHubPublicationOutcomeV1;
            this.#outcomes.set(issued, {
              effectRef: effect.effectRef,
              actionDigest: candidate.actionDigest,
              outcome: undefined,
              nativeOutcome,
              nativeSession: row.native!,
            });
            return issued;
          },
          () => publicationRefuseV1(),
        );
        const drained = retained.drained.then(
          () => {
            if (row.fault) publicationRefuseV1();
          },
          () => publicationRefuseV1(),
        );
        row.ticket = Object.freeze({ result, drained });
        ignoreRejection(result);
        ignoreRejection(drained);
        this.#assertEffect(row);
        this.#assertCall(row);
        if (this.#native.assertPrepared(row.native, call) !== undefined) publicationRefuseV1();
        this.#assertCall(row);
      }
    } catch {
      failed = true;
    } finally {
      pack?.fill(0);
      finishPreparation();
    }
    if (failed || row.closing || aborted(snapshot.signal) || performance.now() >= row.expiresMono) {
      await this.#retire(row);
      return undefined;
    }
    return original;
  }

  preparePush(
    publisher: B["publisher"],
    effect: B["effect"],
    candidate: PublicationCandidateV1,
    capture: GitObjectCaptureV1,
    call: PublicationCallV1,
  ): Promise<GitHubPublicationPreparedV1 | undefined> {
    return this.#prepare(publisher, effect, candidate, capture, call, "push");
  }
  prepareDraftPullRequest(
    publisher: B["publisher"],
    effect: B["effect"],
    candidate: PublicationCandidateV1,
    call: PublicationCallV1,
  ): Promise<GitHubPublicationPreparedV1 | undefined> {
    return this.#prepare(publisher, effect, candidate, undefined, call, "create-draft-pr");
  }
  inspectPrepared(original: GitHubPublicationPreparedV1): Readonly<{
    effectRef: string;
    actionDigest: string;
    kind: "push" | "create-draft-pr";
  }> {
    const row = this.#row(original);
    this.#assertCall(row);
    if (!row.native || !row.ticket) publicationRefuseV1();
    return Object.freeze({
      effectRef: row.effect.effectRef,
      actionDigest: row.candidate.actionDigest,
      kind: row.effect.kind,
    });
  }
  submit(
    original: GitHubPublicationPreparedV1,
    use: B["use"],
  ): PublicationSubmissionV1<GitHubPublicationOutcomeV1> {
    const row = this.#row(original);
    if (!this.#state || !row.native || !row.ticket || row.attempted) publicationRefuseV1();
    originalObject(use);
    if (this.#uses.has(use)) publicationRefuseV1();
    this.#assertCall(row);
    row.attempted = true;
    this.#uses.add(use);
    try {
      this.#assertEffect(row);
      if (this.#state.assertUse(use, original, row.call) !== undefined) publicationRefuseV1();
      if (this.#native.assertPrepared(row.native, row.call) !== undefined) publicationRefuseV1();
      this.#assertCall(row);
      // NO await, caller callback, new body/route or token accessor can intervene.
      if (this.#state.consumeUse(use, original, row.call) !== undefined) publicationRefuseV1();
      if (this.#native.submit(row.native) !== undefined) publicationRefuseV1();
    } catch {
      // The original ticket was installed before this once-only attempt. A
      // throw after possible send cannot hide its eventual known observation.
      row.fault = true;
      ignoreRejection(this.#retire(row));
    }
    return row.ticket;
  }
  inspectOutcome(original: GitHubPublicationOutcomeV1): Readonly<{
    effectRef: string;
    actionDigest: string;
    outcome: PublicationEffectOutcomeV1;
  }> {
    const held = this.#outcomes.get(original);
    if (!held) publicationRefuseV1();
    // The first successful parse is immutable. Failed inspection does not
    // invalidate the receipt or discard its original native observation; State
    // can retain that exact receipt before asynchronous uncertain recording.
    if (!held.outcome)
      held.outcome = parsePublicationEffectOutcomeV1(
        this.#native.inspectOutcome(held.nativeSession, held.nativeOutcome),
      );
    return Object.freeze({
      effectRef: held.effectRef,
      actionDigest: held.actionDigest,
      outcome: held.outcome,
    });
  }
  releasePrepared(original: GitHubPublicationPreparedV1): Promise<void> {
    return this.#retire(this.#row(original));
  }
}
