import { isDeepStrictEqual } from "node:util";
import {
  TURN_JOURNAL_LIMITS_V1,
  createJournalInitiatorV1,
  parseTurnJournalV1,
  type AttemptRecordV1,
  type ExactConsumptionOperationV1,
  type JournalCommitResultV1,
  type TurnJournalReadV1,
  type TurnJournalStoreV1,
  type TurnJournalUnitOfWorkV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { DependencyUnavailableError } from "../errors.ts";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type { PlatformStateStore } from "../ports/transaction.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import { takeCommittedTurnJournalClaim } from "./transaction-guard.ts";

export interface TurnJournalClock {
  now(): Date;
  monotonicMilliseconds(): number;
}

/** Mandatory current protected authority, evaluated against the original read
 * view. The implementation rechecks the original human/grant, exact target,
 * assignments, cancellation and every live proof; stored attribution cannot
 * satisfy this port. Denial, uncertainty and missing proofs must throw.
 */
export interface TurnJournalInitiationAuthority {
  assertCurrent(
    view: PlatformReadView,
    record: AttemptRecordV1,
    operation: ExactConsumptionOperationV1,
    call: AuthorityCallV1,
  ): Promise<Readonly<{ expiresAt: string; signal: AbortSignal }>>;
}

export interface TurnJournalStoreOptions {
  readonly state: PlatformStateStore;
  readonly clock: TurnJournalClock;
  readonly initiation: TurnJournalInitiationAuthority;
}

function unavailable(): DependencyUnavailableError {
  return new DependencyUnavailableError("The turn journal operation is unavailable.");
}

function readJournal(view: PlatformReadView): TurnJournalReadV1 {
  if (view.turnJournal === undefined) throw unavailable();
  return view.turnJournal;
}

function writeJournal(unit: PlatformUnitOfWork): TurnJournalUnitOfWorkV1 {
  if (unit.turnJournal === undefined) throw unavailable();
  return unit.turnJournal;
}

/** Uses only the configured PlatformStateStore's outer transaction and original
 * projections. The store owns no competing durable records or execution permits.
 */
export class TurnJournalStore implements TurnJournalStoreV1 {
  private readonly options: TurnJournalStoreOptions;

  constructor(options: TurnJournalStoreOptions) {
    if (typeof options.initiation?.assertCurrent !== "function") throw unavailable();
    this.options = Object.freeze({ ...options });
  }

  private remaining(call: AuthorityCallV1): number {
    const now = this.options.clock.now().getTime();
    const remaining = Date.parse(call.deadline) - now;
    if (
      call.signal.aborted ||
      !Number.isFinite(now) ||
      !Number.isFinite(remaining) ||
      remaining <= 0
    )
      throw unavailable();
    return Math.min(remaining, TURN_JOURNAL_LIMITS_V1.intakeDeadlineMs);
  }

  async read<T>(work: (view: TurnJournalReadV1) => Promise<T>, call: AuthorityCallV1): Promise<T> {
    const exactCall = Object.freeze({ ...call });
    const timeoutMs = Math.min(3000, this.remaining(exactCall));
    return this.options.state.read(
      async (view) => {
        this.remaining(exactCall);
        const result = await work(readJournal(view));
        this.remaining(exactCall);
        return result;
      },
      { signal: exactCall.signal, timeoutMs },
    );
  }

  private async commit<T>(
    transactionRef: string,
    work: (unit: PlatformUnitOfWork, journal: TurnJournalUnitOfWorkV1) => Promise<T>,
    call: AuthorityCallV1,
  ): Promise<JournalCommitResultV1<T>> {
    try {
      if (
        typeof transactionRef !== "string" ||
        transactionRef.length === 0 ||
        transactionRef.length > TURN_JOURNAL_LIMITS_V1.referenceCharacters ||
        Buffer.byteLength(transactionRef, "utf8") > TURN_JOURNAL_LIMITS_V1.referenceBytes
      )
        throw unavailable();
      this.remaining(call);
      const value = await this.options.state.transact(async (unit) => {
        this.remaining(call);
        const result = await work(unit, writeJournal(unit));
        this.remaining(call);
        return result;
      });
      return { kind: "committed", value };
    } catch (error) {
      if (error instanceof PostgresCommitOutcomeUnknownError)
        return { kind: "commit-unknown", transactionRef };
      return { kind: "unavailable" };
    }
  }

  transact<T>(
    transactionRef: string,
    work: (unit: TurnJournalUnitOfWorkV1) => Promise<T>,
    call: AuthorityCallV1,
  ): Promise<JournalCommitResultV1<T>> {
    return this.commit(
      transactionRef,
      (_unit, journal) => work(journal),
      Object.freeze({ ...call }),
    );
  }

  readonly consumeAndInitiate: TurnJournalStoreV1["consumeAndInitiate"] = async (
    input,
    initiate,
    originalCall,
  ) => {
    const cancellation = new AbortController();
    const call = Object.freeze({
      ...originalCall,
      signal: AbortSignal.any([originalCall.signal, cancellation.signal]),
    });
    const clock = this.options.clock;
    let transactionUnit: PlatformUnitOfWork | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const detach = new Set<() => void>();
    let latest: number;
    let lastMonotonic: number;
    let anchorMonotonic: number;
    let anchorWall: number;

    const assertWithinDeadline = () => {
      const now = clock.monotonicMilliseconds();
      if (
        call.signal.aborted ||
        !Number.isFinite(now) ||
        !Number.isFinite(latest) ||
        now < lastMonotonic ||
        now >= latest
      )
        throw unavailable();
      lastMonotonic = now;
      this.remaining(call);
    };

    const shortenDeadline = (expiresAt: string) => {
      assertWithinDeadline();
      const now = clock.monotonicMilliseconds();
      const wall = clock.now().getTime();
      const remaining = Date.parse(expiresAt) - wall;
      if (
        !Number.isFinite(now) ||
        now < lastMonotonic ||
        !Number.isFinite(wall) ||
        !Number.isFinite(remaining) ||
        remaining <= 0
      )
        throw unavailable();
      // A wall-clock rollback must not extend a proof first inspected after
      // consumption. All absolute expiries retain the invocation's original anchor.
      latest = Math.min(
        latest,
        anchorMonotonic + Date.parse(expiresAt) - anchorWall,
        now + remaining,
      );
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => cancellation.abort(), Math.max(1, Math.ceil(latest - now)));
      assertWithinDeadline();
    };

    const observeRevocation = (signal: AbortSignal) => {
      if (signal.aborted) throw unavailable();
      const revoke = () => cancellation.abort();
      signal.addEventListener("abort", revoke, { once: true });
      detach.add(() => signal.removeEventListener("abort", revoke));
      if (signal.aborted) cancellation.abort();
    };

    try {
      lastMonotonic = clock.monotonicMilliseconds();
      anchorMonotonic = lastMonotonic;
      anchorWall = clock.now().getTime();
      if (!Number.isFinite(lastMonotonic) || !Number.isFinite(anchorWall)) throw unavailable();
      latest = lastMonotonic + TURN_JOURNAL_LIMITS_V1.startWindowMs;
      shortenDeadline(call.deadline);

      const start = createJournalInitiatorV1({
        now: () => clock.monotonicMilliseconds(),
        consume: (consumption, boundedCall) =>
          this.commit(
            boundedCall.requestRef,
            (unit, journal) => {
              transactionUnit = unit;
              return journal.consumeAttempt(consumption, boundedCall);
            },
            boundedCall,
          ),
        inspectCommittedClaim: async (claim) => {
          if (transactionUnit === undefined) return undefined;
          const retained = takeCommittedTurnJournalClaim(transactionUnit, claim);
          if (retained === undefined) return undefined;
          shortenDeadline(retained.expiresAt);

          const assertCurrent = async () => {
            assertWithinDeadline();
            await this.options.state.read(
              async (view) => {
                assertWithinDeadline();
                const state = await readJournal(view).findAttempt(retained.operation.attempt, call);
                assertWithinDeadline();
                if (state.kind !== "found") throw unavailable();
                const record = parseTurnJournalV1("attempt", state.record);
                if (
                  "phase" in record ||
                  record.outcome.kind !== "consumed" ||
                  record.consumption === null ||
                  !isDeepStrictEqual(record.binding.attempt, retained.operation.attempt) ||
                  !isDeepStrictEqual(record.consumption.operation, retained.operation)
                )
                  throw unavailable();
                shortenDeadline(record.binding.expiresAt);
                const proof = await this.options.initiation.assertCurrent(
                  view,
                  record,
                  retained.operation,
                  call,
                );
                assertWithinDeadline();
                shortenDeadline(proof.expiresAt);
                observeRevocation(proof.signal);
                assertWithinDeadline();
              },
              {
                signal: call.signal,
                timeoutMs: Math.min(
                  3000,
                  this.remaining(call),
                  latest - clock.monotonicMilliseconds(),
                ),
              },
            );
            assertWithinDeadline();
          };

          return {
            attempt: retained.operation.attempt,
            signal: call.signal,
            validUntil: latest,
            ...(retained.executionIntent === undefined
              ? {}
              : { executionIntent: retained.executionIntent }),
            assertCurrent,
          };
        },
      });

      return await start(
        input,
        async (attempt, guard) => {
          // The contract helper never retries the callback. Bound an owner that
          // ignores cancellation and observe its eventual rejection after timeout.
          let rejectAbort: (() => void) | undefined;
          const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(unavailable());
            guard.signal.addEventListener("abort", rejectAbort, { once: true });
            if (guard.signal.aborted) rejectAbort();
          });
          void aborted.catch(() => {});
          try {
            assertWithinDeadline();
            await Promise.race([
              Promise.resolve().then(() => {
                assertWithinDeadline();
                return initiate(attempt, guard);
              }),
              aborted,
            ]);
            assertWithinDeadline();
          } finally {
            if (rejectAbort !== undefined) guard.signal.removeEventListener("abort", rejectAbort);
          }
        },
        call,
      );
    } catch {
      return { kind: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const remove of detach) remove();
      cancellation.abort();
    }
  };
}
