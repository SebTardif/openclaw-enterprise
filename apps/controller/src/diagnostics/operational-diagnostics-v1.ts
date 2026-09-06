import {
  parseLifecycleAdmissionV1,
  type LifecycleOperationReadRequestV1,
  type LifecycleScopeV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import {
  parseLifecycleObservationResponseV1,
  type LifecycleOperationStatusV1,
  type LifecycleStatusV1,
} from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import {
  parseSecurityEvent,
  SECURITY_EVENT_POLICY,
  type SecurityEventV1,
} from "@openclaw-enterprise/contracts/security-events";
// OccLogger is this exact Pino alias. Import it directly so this leaf does not
// pull the controller's unrelated runtime/SDK composition through its barrel.
import type { Logger as OccLogger } from "pino";

export const OPERATIONAL_DIAGNOSTICS_SCHEMA_V1 = "operational-diagnostics/v1" as const;
export const OPERATIONAL_DIAGNOSTICS_LIMITS_V1 = Object.freeze({
  maxPayloadBytes: SECURITY_EVENT_POLICY.maxEventBytes,
  maxRecordsPerCall: 6,
});

type FailureCode = "INVALID_DIAGNOSTIC" | "LOCAL_LOG_SUBMISSION_FAILED";
export interface DiagnosticSubmissionV1 {
  readonly submitted: number;
  readonly suppressed: number;
  readonly failed: number;
  readonly rejected: number;
  readonly failureCode: FailureCode | null;
  /** A completed Pino call is not a destination, durable or remote receipt. */
  readonly downstreamDelivery: "unobserved";
}

export interface OperationalDiagnosticsV1 {
  emitLifecycleStatus(scope: LifecycleScopeV1, status: LifecycleStatusV1): DiagnosticSubmissionV1;
  emitLifecycleOperation(
    request: LifecycleOperationReadRequestV1,
    status: LifecycleOperationStatusV1,
  ): DiagnosticSubmissionV1;
  emitSecurityEvent(event: SecurityEventV1): DiagnosticSubmissionV1;
  /** Process-lifetime aggregate counters, never per-tenant metrics or current sink health. */
  localSubmissions(): DiagnosticSubmissionV1;
}

type RecordValue = string | number | boolean | null;
type DiagnosticRecord = Readonly<Record<string, RecordValue>>;
type PendingRecord = { readonly level: "info" | "warn"; readonly record: DiagnosticRecord };
const CONDITION_NAMES = [
  "accessDenied",
  "routeRemoved",
  "executionTerminated",
  "credentialRevocation",
  "stateRetention",
] as const;

function envelope(event: string): DiagnosticRecord {
  return { event, diagnosticSchema: OPERATIONAL_DIAGNOSTICS_SCHEMA_V1 };
}

function observationTimes(observedAt: string | null, recordedAt: string | null): DiagnosticRecord {
  return {
    observedAt,
    recordedAt,
    observedAtAvailable: observedAt !== null,
    recordedAtAvailable: recordedAt !== null,
  };
}

function zero(): DiagnosticSubmissionV1 {
  return Object.freeze({
    submitted: 0,
    suppressed: 0,
    failed: 0,
    rejected: 0,
    failureCode: null,
    downstreamDelivery: "unobserved",
  });
}

function saturatingAdd(previous: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, previous + increment);
}

/**
 * A best-effort operational copy of existing canonical values. The composition
 * must supply its original logger and authentic producer/current authorized read
 * results. Parsing supplies correspondence, never authentication or read rights.
 * No mandatory audit append, authority decision, lifecycle read or retry occurs.
 */
export function createOperationalDiagnosticsV1(logger: OccLogger): OperationalDiagnosticsV1 {
  let totals = zero();

  function finish(result: DiagnosticSubmissionV1): DiagnosticSubmissionV1 {
    totals = Object.freeze({
      submitted: saturatingAdd(totals.submitted, result.submitted),
      suppressed: saturatingAdd(totals.suppressed, result.suppressed),
      failed: saturatingAdd(totals.failed, result.failed),
      rejected: saturatingAdd(totals.rejected, result.rejected),
      // The most recent failure stays visible; later submissions are not recovery proof.
      failureCode: result.failureCode ?? totals.failureCode,
      downstreamDelivery: "unobserved",
    });
    return Object.freeze(result);
  }

  function emit(build: () => readonly PendingRecord[]): DiagnosticSubmissionV1 {
    let records: readonly PendingRecord[];
    try {
      records = build();
      if (records.length > OPERATIONAL_DIAGNOSTICS_LIMITS_V1.maxRecordsPerCall) throw new Error();
      // Validate the entire bounded group before submitting any part of it.
      for (const { record } of records) {
        if (
          Buffer.byteLength(JSON.stringify(record), "utf8") >
          OPERATIONAL_DIAGNOSTICS_LIMITS_V1.maxPayloadBytes
        )
          throw new Error();
      }
    } catch {
      return finish({ ...zero(), rejected: 1, failureCode: "INVALID_DIAGNOSTIC" });
    }

    let submitted = 0;
    let suppressed = 0;
    let failed = 0;
    for (const { level, record } of records) {
      try {
        if (!logger.isLevelEnabled(level)) {
          suppressed += 1;
          continue;
        }
        logger[level](record);
        submitted += 1;
      } catch {
        // Keep raw destination errors out of both records and return values.
        // Continuing this finite group does not retry a failed record.
        failed += 1;
      }
    }
    return finish({
      submitted,
      suppressed,
      failed,
      rejected: 0,
      failureCode: failed === 0 ? null : "LOCAL_LOG_SUBMISSION_FAILED",
      downstreamDelivery: "unobserved",
    });
  }

  return Object.freeze({
    emitLifecycleStatus(scopeInput: LifecycleScopeV1, statusInput: LifecycleStatusV1) {
      return emit(() => {
        const status = parseLifecycleObservationResponseV1("readStatus", scopeInput, statusInput);
        const correlation = {
          namespaceId: status.namespaceId,
          agentId: status.agentId,
          operationRef: status.head?.operationRef ?? null,
          lifecycleGeneration: status.head?.lifecycleGeneration ?? null,
          observedLifecycleGeneration: status.observedLifecycleGeneration,
          attempt: status.attempt,
        };
        const records: PendingRecord[] = [
          {
            level: status.phase === "blocked" ? "warn" : "info",
            record: {
              ...envelope("diagnostics.lifecycle"),
              ...correlation,
              desiredMode: status.head?.desiredMode ?? null,
              requestedRevisionId: status.requestedRevisionId,
              selectedRevisionId: status.selectedRevisionId,
              servingRevisionId: status.servingRevisionId,
              phase: status.phase,
              step: status.step,
              reasonCode: status.reasonCode,
              retryAt: status.retryAt,
              serving: status.serving,
              stopComplete: status.stopComplete,
              retention: status.retention,
            },
          },
        ];
        for (const name of CONDITION_NAMES) {
          const condition = status.conditions[name];
          records.push({
            level: condition.status === "unknown" ? "warn" : "info",
            record: {
              ...envelope("diagnostics.condition"),
              ...correlation,
              condition: name,
              conditionStatus: condition.status,
              reasonCode: condition.reasonCode,
              ...observationTimes(condition.observedAt, condition.recordedAt),
            },
          });
        }
        return records;
      });
    },

    emitLifecycleOperation(
      requestInput: LifecycleOperationReadRequestV1,
      statusInput: LifecycleOperationStatusV1,
    ) {
      return emit(() => {
        const request = parseLifecycleAdmissionV1("operationReadRequest", requestInput);
        const status = parseLifecycleObservationResponseV1("readOperation", request, statusInput);
        return [
          {
            level: status.observation.phase === "blocked" ? "warn" : "info",
            record: {
              ...envelope("diagnostics.operation"),
              namespaceId: request.namespaceId,
              agentId: request.agentId,
              operationRef: status.operation.operationRef,
              lifecycleGeneration: status.operation.lifecycleGeneration,
              operationKind: status.operation.kind,
              desiredMode: status.operation.desiredMode,
              requestedRevisionId: status.operation.requestedRevisionId,
              acceptedAt: status.operation.acceptedAt,
              attempt: status.observation.attempt,
              phase: status.observation.phase,
              step: status.observation.step,
              reasonCode: status.observation.reasonCode,
              retryAt: status.observation.retryAt,
              ...observationTimes(status.observation.observedAt, status.observation.recordedAt),
            },
          },
        ];
      });
    },

    emitSecurityEvent(eventInput: SecurityEventV1) {
      return emit(() => {
        const event = parseSecurityEvent(eventInput);
        return [
          {
            level:
              event.result === "denied" || event.result === "failed" || event.result === "unknown"
                ? "warn"
                : "info",
            record: {
              ...envelope("diagnostics.security"),
              securityEventId: event.id,
              installationId: event.installationId,
              namespaceId: event.namespaceId ?? null,
              agentId: event.correlation.agentId ?? null,
              revisionId: event.correlation.revisionId ?? null,
              attemptId: event.correlation.attemptId ?? null,
              requestId: event.requestId ?? null,
              assignmentId:
                event.workload.state === "verified" ? event.workload.assignmentId : null,
              runtimeGeneration:
                event.workload.state === "verified" ? event.workload.generation : null,
              source: event.source,
              category: event.category,
              action: event.action,
              decision: event.decision,
              phase: event.phase,
              result: event.result,
              reasonCode: event.reasonCode,
              occurredAt: event.occurredAt,
              receivedAt: event.receivedAt,
              observedAt: event.observation?.observedAt ?? null,
              observationSource: event.observation?.source ?? null,
              observedAtAvailable: event.observation !== undefined,
            },
          },
        ];
      });
    },

    localSubmissions: () => totals,
  });
}
