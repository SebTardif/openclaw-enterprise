import type { HostedSelectedConnectInputV1 } from "openclaw/plugin-sdk/codex-hosted-harness";
import {
  parseTurnJournalV1,
  TURN_JOURNAL_LIMITS_V1,
  type JournalExecutionStartV1,
  type JournalDeniedV1,
  type JournalUnavailableV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import { parseCompletedContextV1 } from "@openclaw-enterprise/contracts/completed-context-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  CompletedContextJournalService,
  type CompletedContextJournalOptions,
  type CompletedContextPublicationResult,
  type PrepareCheckpointPublication,
} from "./completed-context.ts";
import { sameJournalValue } from "./rows.ts";

export type NativeJournalCompletionEvent = Parameters<HostedSelectedConnectInputV1["onEvent"]>[0];

/** An acquired ORIGINAL native-event/currentness lifetime. These values are only
 * correlation data. The source must recognize the original callback event in
 * its private socket/task custody, verify a successful terminal event and its
 * thread/start binding, and retain the canonical preparation expectation. Text,
 * a parsed start, a copied event or local socket close cannot produce this lease.
 * release joins this acquisition only; it never certifies no-mutator release.
 */
export interface NativeJournalCompletionLease {
  readonly start: JournalExecutionStartV1;
  readonly nativeThreadId: string;
  readonly publication: PrepareCheckpointPublication;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}

export interface NativeJournalCompletionSource {
  /** Must acquire actual current terminal-observation/persistence authority;
   * continuing execution permission or a start receipt alone is insufficient.
   * Retain the exact original expectation through failure and lost commit ACK.
   * The producer owns cancellation and must settle a late acquisition so this
   * consumer can join its release. No factory/default producer is supplied here.
   */
  acquire(
    event: NativeJournalCompletionEvent,
    call: AuthorityCallV1,
  ): Promise<
    | Readonly<{ kind: "acquired"; lease: NativeJournalCompletionLease }>
    | JournalDeniedV1
    | JournalUnavailableV1
  >;
}

export interface NativeJournalCompletionOptions extends CompletedContextJournalOptions {
  readonly source: NativeJournalCompletionSource;
}

export type NativeJournalCompletionResult =
  | CompletedContextPublicationResult
  | Readonly<{
      /** A publication result was returned, but fresh currentness or joined
       * cleanup did not permit its outward release. It may already be committed.
       * Recover the original source-owned expectation with authorized readback;
       * this result is neither rollback proof nor a new preparation permit. */
      kind: "publication-withheld";
      nextAction: "exact-readback-only";
    }>;

const unavailable = (): JournalUnavailableV1 => ({ kind: "unavailable" });
const withheld = (): NativeJournalCompletionResult => ({
  kind: "publication-withheld",
  nextAction: "exact-readback-only",
});

function thread(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TURN_JOURNAL_LIMITS_V1.referenceCharacters ||
    Buffer.byteLength(value, "utf8") > TURN_JOURNAL_LIMITS_V1.referenceBytes
  )
    throw new Error("Native completion binding is unavailable.");
  return value;
}

function publication(input: PrepareCheckpointPublication): PrepareCheckpointPublication {
  return Object.freeze({
    allocation: parseTurnJournalV1("checkpointAllocation", input.allocation),
    operation: parseTurnJournalV1("completionOperation", input.operation),
    preparation: parseCompletedContextV1("prepareCompletedInput", input.preparation),
    allocationTransactionRef: input.allocationTransactionRef,
    publicationTransactionRef: input.publicationTransactionRef,
  });
}

/** Inactive, single-completion consumer for one selected native owner. The
 * composition owner forwards only its original completion event, never every
 * streaming text event. Constructing this object does not connect a Harness,
 * subscribe, start execution, prepare a native session or grant any authority.
 *
 * The same original store supplies both retained-start reads and the existing
 * allocation -> canonical preparation -> publication service. That service's
 * evidence owner still verifies native terminal/workspace/no-mutator facts, and
 * the journal re-inspects provenance inside its publication transaction. This
 * adapter creates no verified handles, transaction owners or initiation claims.
 *
 * TODO(first native Agent composition): the original HostedNativeOwner/native
 * event and persistence owners must supply the acquired source above, genuine
 * canonical adapter/evidence, and a qualified callback route before installation.
 * No production caller or shared SDK/native-owner modification is supplied here.
 */
export class NativeJournalCompletionConsumer {
  readonly #options: NativeJournalCompletionOptions;
  readonly #completion: CompletedContextJournalService;
  readonly #acquire: NativeJournalCompletionSource["acquire"];
  #entered = false;

  constructor(options: NativeJournalCompletionOptions) {
    if (typeof options.source?.acquire !== "function")
      throw new Error("Original native completion source is required.");
    this.#options = Object.freeze({ ...options });
    this.#acquire = options.source.acquire.bind(options.source);
    this.#completion = new CompletedContextJournalService(this.#options);
  }

  #current(call: AuthorityCallV1): void {
    const now = (this.#options.now?.() ?? new Date()).getTime();
    if (
      !call.context ||
      !(call.signal instanceof AbortSignal) ||
      call.signal.aborted ||
      !Number.isFinite(now) ||
      !Number.isFinite(Date.parse(call.deadline)) ||
      now >= Date.parse(call.deadline)
    )
      throw new Error("Native completion authority ended.");
  }

  /** One entrance including denial, uncertainty and synchronous reentry. A new
   * consumer is not recovery authority: existing allocation/start records do
   * not permit another canonical write, and producer custody must reject replay.
   * No native execution, delivery or reservation release is attempted here. */
  async publish(
    originalEvent: NativeJournalCompletionEvent,
    originalCall: AuthorityCallV1,
  ): Promise<NativeJournalCompletionResult> {
    if (this.#entered) return unavailable();
    this.#entered = true;
    let release: (() => Promise<void>) | undefined;
    let returnedPublication = false;
    let result: NativeJournalCompletionResult = unavailable();
    const call = Object.freeze({ ...originalCall });
    try {
      this.#current(call);
      // Capture correlation before awaiting while retaining the original event
      // object for the actual source's private membership check.
      const eventStart = parseTurnJournalV1("executionStart", originalEvent.start);
      const nativeThreadId = thread(originalEvent.nativeThreadId);
      const acquired = await this.#acquire(originalEvent, call);
      // An acquisition result cannot inject a publication or any other outcome.
      if (acquired.kind !== "acquired")
        return acquired.kind === "denied" ? { kind: "denied" } : unavailable();
      const lease = acquired.lease;
      release = lease.release.bind(lease);
      const assertCurrent = lease.assertCurrent.bind(lease);
      const bounded = Object.freeze({
        ...call,
        signal: AbortSignal.any([call.signal, lease.signal]),
      });
      const start = parseTurnJournalV1("executionStart", lease.start);
      const exact = publication(lease.publication);
      if (
        !sameJournalValue(start, eventStart) ||
        !sameJournalValue(eventStart, parseTurnJournalV1("executionStart", originalEvent.start)) ||
        nativeThreadId !== thread(lease.nativeThreadId) ||
        nativeThreadId !== originalEvent.nativeThreadId ||
        !sameJournalValue(start.intent.execution.attempt, exact.allocation.attempt) ||
        !sameJournalValue(exact.allocation.attempt, exact.operation.attempt)
      ) {
        result = { kind: "conflict" };
      } else {
        const current = async (): Promise<void> => {
          this.#current(bounded);
          await assertCurrent();
          this.#current(bounded);
        };
        await current();
        const retained = await this.#options.store.read(
          (view) => view.findExecution(start.intent.execution, bounded),
          bounded,
        );
        await current();
        if (retained.kind !== "started") {
          result = retained.kind === "denied" ? retained : unavailable();
        } else if (!sameJournalValue(parseTurnJournalV1("executionStart", retained.start), start)) {
          result = { kind: "conflict" };
        } else {
          // Only the real original service owns transaction sequencing and
          // immutable preparation. A start read is correlation, not permission.
          result = await this.#completion.prepareAndPublish(exact, bounded);
          returnedPublication = true;
          await current();
        }
      }
    } catch {
      result = returnedPublication ? withheld() : unavailable();
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          result = returnedPublication ? withheld() : unavailable();
        }
      }
    }
    // Acquired lifetime cleanup may close its own signal. The ORIGINAL caller
    // still fences outward disclosure across that joined await, as in the
    // private native-context adapter; this never releases a provider effect.
    try {
      this.#current(call);
    } catch {
      result = returnedPublication ? withheld() : unavailable();
    }
    return result;
  }
}
