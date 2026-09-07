import { decodeWorkloadProfileWithdrawV2 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { WorkloadProfileDefinitionSourceV2 } from "../../workload-profiles/admitted-use.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import { DriverSelection } from "../../application/driver-selection.ts";
import { PostgresCommitOutcomeUnknownError } from "../../ports/transaction-errors.ts";
import { normalizeAnyProfilePreparation, profileUuid } from "../../workload-profiles/types.ts";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
} from "../../workload-profiles/canonical.ts";
import {
  deriveWorkloadProfileManifestV2,
  deriveWorkloadProfileManifest,
} from "../../workload-profiles/projections.ts";
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
  readonly definitions?: WorkloadProfileDefinitionSourceV2;
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

  const consume = account.consume.bind(account);
  const execute = async <T>(
    invocation: Parameters<WorkloadProfileServicePort["prepare"]>[0],
    request: Parameters<WorkloadProfileAccountParticipant["consume"]>[1],
    signal: AbortSignal,
    work: (unit: GuardedWorkloadProfileUnit, lease: WorkloadProfileAccountLease) => Promise<T>,
  ): Promise<T> => {
    let close: (() => unknown) | undefined;
    let failed = false;
    let closed = false;
    try {
      return await state.workloadProfileTransaction(
        selection,
        async (unit) => {
          const consumed = await consume(invocation, request, unit.account);
          const release = consumed?.release;
          if (typeof release !== "function")
            throw new DependencyUnavailableError(
              "The authentic account participant is unavailable.",
            );
          close = release.bind(consumed);
          if (closed || signal.aborted)
            throw new DependencyUnavailableError("The profile request is closed.");
          const current = consumed.assertCurrent;
          if (typeof current !== "function")
            throw new DependencyUnavailableError(
              "The authentic account participant is unavailable.",
            );
          unit.retainCurrentness(current.bind(consumed));
          return work(unit, consumed);
        },
        { signal, timeoutMs: 3000 },
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Actual owner cleanup precedes local participant release, including unknown COMMIT.
      closed = true;
      try {
        const result = close?.();
        if (result !== undefined) {
          await Promise.resolve(result);
          throw new DependencyUnavailableError("The account cleanup was not synchronous.");
        }
      } catch (error) {
        // Preserve the first failure, even when it is the legal value undefined.
        if (!failed) throw error;
      }
    }
  };
  const service: WorkloadProfileServicePort = {
    prepare: async (invocation, input, signal) => {
      const normalized = normalizeAnyProfilePreparation(input);
      // Full closed content validation happens before pool/lock acquisition and is
      // independently repeated by the actual preparation repository.
      (normalized.request.schemaVersion === 2
        ? deriveWorkloadProfileManifestV2
        : deriveWorkloadProfileManifest)(encoder.encode(normalized.request.manifest.canonicalUtf8));
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
      const normalized = normalizeAnyProfilePreparation(
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
    accept: async (invocation, operationRef, signal) => {
      profileUuid(operationRef);
      const request = Object.freeze({
        method: "accept" as const,
        operationRef,
        canonicalInput: JSON.stringify({ operationRef }),
      });
      try {
        const accepted = await execute(invocation, request, signal, (unit, lease) =>
          unit.accept(operationRef, lease, options.definitions),
        );
        return immutableCopy({
          kind: "acknowledged" as const,
          operationRef,
          action: accepted.action,
          scope: accepted.history.head.scope,
        });
      } catch (error) {
        if (error instanceof PostgresCommitOutcomeUnknownError)
          return Object.freeze({
            kind: "commit-unknown" as const,
            operationRef,
            recovery: "exact-readback-only" as const,
          });
        throw error;
      }
    },
    withdraw: async (invocation, admissionRef, input, signal) => {
      profileUuid(admissionRef);
      const decoded = decodeWorkloadProfileWithdrawV2(input);
      if (decoded.kind !== "valid" || decoded.value.expectedAdmission.admissionRef !== admissionRef)
        throw new ScopeViolationError("The profile withdrawal is unavailable.");
      const canonicalInput = new TextDecoder().decode(
        canonicalizeWorkloadProfileJson(decoded.value, "operator-envelope"),
      );
      const request = Object.freeze({
        method: "withdraw" as const,
        admissionRef,
        operationRef: decoded.value.operationRef,
        canonicalInput,
      });
      try {
        const history = await execute(invocation, request, signal, (unit, lease) =>
          unit.withdraw(admissionRef, decoded.value, lease),
        );
        return immutableCopy({
          kind: "acknowledged" as const,
          operationRef: request.operationRef,
          action: "withdraw" as const,
          scope: history.head.scope,
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
    readProfile: async (invocation, admissionRef, signal) => {
      profileUuid(admissionRef);
      const request = Object.freeze({
        method: "readProfile" as const,
        admissionRef,
        canonicalInput: JSON.stringify({ admissionRef }),
      });
      const head = await execute(invocation, request, signal, (unit, lease) =>
        unit.readProfile(admissionRef, lease),
      );
      if (!head) throw new ScopeViolationError("The profile admission is unavailable.");
      return immutableCopy({
        scope: head.scope,
        selection: head.selection,
        status: head.state === "admitted" ? ("active" as const) : ("withdrawn" as const),
        manifest: {
          format: head.canonicalFormat,
          canonicalUtf8: head.canonicalManifest,
          manifestDigest: head.selection.manifestDigest,
        },
      });
    },
  };
  return Object.freeze(service);
}
