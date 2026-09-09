import {
  parseTurnJournalV1,
  type ExactConsumptionOperationV1,
  type JournalExecutionIntentV1,
  type PendingInitiationClaimV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import { ScopeViolationError } from "../errors.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";

interface ClaimState {
  readonly owner: TurnJournalTransactionGuard;
  readonly operation: ExactConsumptionOperationV1;
  readonly expiresAt: string;
  readonly executionIntent?: JournalExecutionIntentV1;
  taken: boolean;
}

const transactionOwners = new WeakMap<PlatformUnitOfWork, TurnJournalTransactionGuard>();
const claims = new WeakMap<PendingInitiationClaimV1, ClaimState>();

/** The original PostgreSQL or memory transaction owner alone binds and confirms this internal guard.
 * Returned business decisions may commit; a thrown mutation failure poisons the
 * whole transaction, even when the outer callback catches the rejection.
 */
export class TurnJournalTransactionGuard {
  private accepting = true;
  private active = true;
  private executing = false;
  private failed = false;
  private failure: unknown;
  private finished = false;
  private committed = false;
  private unit: PlatformUnitOfWork | undefined;
  private pending: Promise<void> = Promise.resolve();

  bind(unit: PlatformUnitOfWork): void {
    this.assertActive();
    if (this.unit !== undefined || transactionOwners.has(unit))
      throw new ScopeViolationError("The turn journal transaction is already bound.");
    this.unit = unit;
    transactionOwners.set(unit, this);
  }

  assertActive(): void {
    if (!this.active) throw new ScopeViolationError("The turn journal transaction is closed.");
  }

  mutate<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new ScopeViolationError("The turn journal transaction is closed."));
    const result = this.pending.then(async () => {
      this.assertCommittable();
      try {
        this.assertActive();
        this.executing = true;
        const value = await work();
        this.assertActive();
        return value;
      } catch (error) {
        this.failed = true;
        this.failure = error;
        throw error;
      } finally {
        this.executing = false;
      }
    });
    // Observe every accepted operation, including one the callback never awaits.
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Called only after inserting a new immutable consumption in this transaction.
   * This opaque local identity carries no authority until the real owner confirms
   * its commit boundary. Readback and copied/serialized values cannot manufacture membership.
   */
  createClaim(
    operation: ExactConsumptionOperationV1,
    expiresAt: string,
    executionIntent?: JournalExecutionIntentV1,
  ): PendingInitiationClaimV1 {
    this.assertActive();
    this.assertCommittable();
    if (!this.executing || this.unit === undefined || !Number.isFinite(Date.parse(expiresAt)))
      throw new ScopeViolationError("The turn journal consumption claim is unavailable.");
    const exact = parseTurnJournalV1("consumption", operation);
    const claim = Object.freeze({ operation: exact }) as PendingInitiationClaimV1;
    claims.set(claim, {
      owner: this,
      operation: exact,
      expiresAt,
      taken: false,
      ...(executionIntent === undefined
        ? {}
        : { executionIntent: parseTurnJournalV1("executionIntent", executionIntent) }),
    });
    return claim;
  }

  async finish(): Promise<void> {
    // Close admissions before the first await. Accepted work retains backend access
    // while draining; no later mutation can join the transaction before COMMIT.
    this.accepting = false;
    await this.pending;
    this.assertCommittable();
    this.finished = true;
  }

  /** Pure local marker after verified PostgreSQL COMMIT or memory snapshot publication.
   * Invalid lifecycle state withholds claims without throwing after publication.
   */
  confirmCommitted(): void {
    if (this.active && this.finished && !this.failed && this.unit !== undefined)
      this.committed = true;
  }

  close(): void {
    this.accepting = false;
    this.active = false;
  }

  private assertCommittable(): void {
    if (this.failed) throw this.failure;
  }

  /** Internal inspection additionally requires the original transaction unit. */
  ownsCommitted(unit: PlatformUnitOfWork): boolean {
    return this.committed && this.unit === unit && transactionOwners.get(unit) === this;
  }
}

/** Single-use inspection for the store's newly completed outer transaction.
 * The unit is retained from that exact callback; a reopened read has no membership.
 */
export function takeCommittedTurnJournalClaim(
  unit: PlatformUnitOfWork,
  claim: PendingInitiationClaimV1,
):
  | Readonly<{
      operation: ExactConsumptionOperationV1;
      expiresAt: string;
      executionIntent?: JournalExecutionIntentV1;
    }>
  | undefined {
  const state = claims.get(claim);
  if (state === undefined || state.taken || !state.owner.ownsCommitted(unit)) return undefined;
  state.taken = true;
  return Object.freeze({
    operation: state.operation,
    expiresAt: state.expiresAt,
    ...(state.executionIntent === undefined ? {} : { executionIntent: state.executionIntent }),
  });
}
