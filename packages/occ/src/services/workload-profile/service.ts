import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import { DriverSelection } from "../../application/driver-selection.ts";
import { PostgresCommitOutcomeUnknownError } from "../../ports/transaction-errors.ts";
import { normalizeProfilePreparation, profileUuid } from "../../workload-profiles/types.ts";
import { decodeWorkloadProfileJson } from "../../workload-profiles/canonical.ts";
import { deriveWorkloadProfileManifest } from "../../workload-profiles/projections.ts";
import type {
  WorkloadProfileAccountLease,
  WorkloadProfileAccountParticipant,
  WorkloadProfileServicePort,
  WorkloadProfileTransactionStore,
  GuardedWorkloadProfileUnit,
} from "./port.ts";

export interface WorkloadProfileServiceOptions {
  readonly state: WorkloadProfileTransactionStore;
  readonly selection: DriverSelection;
  /** Trusted original account-owner composition only; currently no implementation. */
  readonly account: WorkloadProfileAccountParticipant;
}
const encoder = new TextEncoder();

/** Storage and registered IAM class never stand in for actual account authority.
 * No controller composition installs the mandatory participant yet. */
export function createWorkloadProfileService(
  options?: WorkloadProfileServiceOptions,
): WorkloadProfileServicePort {
  const unavailable = async (): Promise<never> => {
    throw new DependencyUnavailableError("Workload profile authority is unavailable.");
  };
  // TODO: the original account authority must implement actual one-use request
  // custody and same-unit session/security participation before routes can enable
  // these methods. Memory auth has no shared transaction and remains unsupported.
  if (options === undefined || options.account === undefined)
    return Object.freeze({
      prepare: unavailable,
      accept: unavailable,
      withdraw: unavailable,
      readOperation: unavailable,
      readProfile: unavailable,
    });
  const { state, selection, account } = options;
  if (
    typeof state?.workloadProfileTransaction !== "function" ||
    !(selection instanceof DriverSelection) ||
    typeof account.consume !== "function"
  )
    throw new DependencyUnavailableError("The protected profile composition is unavailable.");

  const execute = async <T>(
    invocation: Parameters<WorkloadProfileServicePort["prepare"]>[0],
    request: Parameters<WorkloadProfileAccountParticipant["consume"]>[1],
    signal: AbortSignal,
    work: (unit: GuardedWorkloadProfileUnit, lease: WorkloadProfileAccountLease) => Promise<T>,
  ): Promise<T> => {
    let lease: WorkloadProfileAccountLease | undefined;
    let closed = false;
    try {
      return await state.workloadProfileTransaction(
        selection,
        async (unit) => {
          const consumed = await account.consume(invocation, request, unit.account);
          if (closed || signal.aborted) {
            consumed?.release();
            throw new DependencyUnavailableError("The profile request is closed.");
          }
          lease = consumed;
          if (
            lease === undefined ||
            typeof lease.assertCurrent !== "function" ||
            typeof lease.release !== "function"
          )
            throw new DependencyUnavailableError(
              "The authentic account participant is unavailable.",
            );
          const held = lease;
          unit.retainCurrentness(() => held.assertCurrent());
          return work(unit, held);
        },
        { signal, timeoutMs: 3000 },
      );
    } finally {
      // Actual owner cleanup precedes local participant release, including unknown COMMIT.
      closed = true;
      lease?.release();
    }
  };
  const service: WorkloadProfileServicePort = {
    prepare: async (invocation, input, signal) => {
      const normalized = normalizeProfilePreparation(input);
      // Full closed content validation happens before pool/lock acquisition and is
      // independently repeated by the actual preparation repository.
      deriveWorkloadProfileManifest(encoder.encode(normalized.request.manifest.canonicalUtf8));
      const request = Object.freeze({
        method: "prepare" as const,
        operationRef: normalized.request.operationRef,
        canonicalInput: normalized.canonicalClientIntent,
      });
      try {
        const record = await execute(invocation, request, signal, (unit, lease) =>
          unit.prepare(normalized.request, lease),
        );
        return immutableCopy({
          kind: "acknowledged" as const,
          operationRef: record.operationRef,
          action: record.action,
          scope: record.scope,
        });
      } catch (error) {
        if (error instanceof PostgresCommitOutcomeUnknownError)
          return Object.freeze({
            kind: "commit-unknown" as const,
            operationRef: request.operationRef,
            recovery: "exact-readback-only" as const,
          });
        throw error;
      }
    },
    readOperation: async (invocation, operationRef, signal) => {
      profileUuid(operationRef);
      const request = Object.freeze({
        method: "readOperation" as const,
        operationRef,
        canonicalInput: JSON.stringify({ operationRef }),
      });
      const record = await execute(invocation, request, signal, (unit, lease) =>
        unit.readOperation(operationRef, lease),
      );
      if (record === undefined)
        throw new ScopeViolationError("The profile operation is unavailable.");
      const normalized = normalizeProfilePreparation(
        decodeWorkloadProfileJson(encoder.encode(record.canonicalClientIntent), "operator-envelope")
          .value,
      );
      return immutableCopy({
        kind: "inert-preparation" as const,
        operationRef: record.operationRef,
        action: record.action,
        scope: record.scope,
        manifest: normalized.request.manifest,
        preparedAt: record.preparedAt,
      });
    },
    // TODO: active admission, withdrawal and current-use/invalidation consumers
    // require their actual authoritative producers; inert preparation is insufficient.
    accept: unavailable,
    withdraw: unavailable,
    readProfile: unavailable,
  };
  return Object.freeze(service);
}
