import {
  parseLifecycleAdmissionV1,
  projectLifecycleIntentHeadV1,
  projectLifecycleOperationReadV1,
  type LifecycleOperationReadProjectionV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { parseLifecycleObservationResponseV1 } from "@openclaw-enterprise/contracts/lifecycle-observation-v1";
import type { RuntimeScope } from "@openclaw-enterprise/contracts/runtime-assignment";
import { DependencyUnavailableError } from "../../errors.ts";
import {
  parseLifecycleStatusReadRequestV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadRequestV1,
  type LifecycleStatusReadValueV1,
} from "../../lifecycle/status-projector-v1.ts";
import type { PlatformReadView } from "../../ports/platform-read-view.ts";

/** Borrowed from one actual bounded READ ONLY transaction. This internal data
 * reader grants no HTTP/request authority and cannot acquire another client. */
interface Context {
  readonly installationId: string;
  readonly state: PlatformReadView;
  query(statement: string, parameters: readonly unknown[]): Promise<{ rows: unknown[] }>;
}
const unavailable = () => new DependencyUnavailableError("Lifecycle read state is unavailable.");
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

/** Persisted intent/selection/queue facts remain distinct from runtime facts.
 * TODO: Consume retained, qualified lifecycle observations when their original
 * producer is installed. Queue success never supplies serving or stop proof. */
export async function readPostgresLifecycleStatusV1<K extends LifecycleStatusReadMethodV1>(
  context: Context,
  method: K,
  input: LifecycleStatusReadRequestV1<K>,
): Promise<LifecycleStatusReadValueV1<K> | undefined> {
  const request = parseLifecycleStatusReadRequestV1(method, input);
  const scope: RuntimeScope = { namespaceId: request.namespaceId, agentId: request.agentId };
  const installation = await context.state.installations.getInstallation();
  if (installation?.id !== context.installationId) throw unavailable();
  const agent = await context.state.agents.findAgent(scope.namespaceId, scope.agentId);
  if (!agent) return undefined;

  async function operation(
    operationRef: string,
  ): Promise<LifecycleOperationReadProjectionV1 | undefined> {
    const intent = await context.state.runtimeAssignments.findRuntimeIntent(scope, operationRef);
    if (!intent) return undefined;
    if (intent.installationId !== context.installationId) throw unavailable();
    if (intent.desiredMode !== "running") {
      const retained = await context.state.lifecycleAdmissions.findCommitted(scope, operationRef);
      if (!retained) throw unavailable();
      return projectLifecycleOperationReadV1(retained.association);
    }
    // The actual existing deploy reader verifies the original immutable revision,
    // intent, work and audit association, independently of today's active head.
    const revision = await context.state.runtimeAdmissions.findCommittedAdmission(
      scope,
      operationRef,
      {
        actorId: intent.actorId,
        requestId: intent.requestId,
      },
    );
    if (!revision) throw unavailable();
    return parseLifecycleAdmissionV1("operationReadProjection", {
      operationRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
      acceptedAt: intent.createdAt,
      kind: "deploy",
      revisionSource: "saved-draft",
      desiredMode: "running",
      requestedRevisionId: revision.id,
    });
  }
  async function observation(operationRef: string) {
    const result = await context.query(
      `SELECT attempt_count, state FROM occ.controller_work
       WHERE namespace_id=$1 AND agent_id=$2 AND runtime_transition_ref=$3
       AND namespace_target IS NULL LIMIT 2`,
      [scope.namespaceId, scope.agentId, operationRef],
    );
    if (result.rows.length !== 1) throw unavailable();
    const work = row(result.rows[0]);
    const attempt = Number(work.attempt_count);
    if (
      !Number.isSafeInteger(attempt) ||
      attempt < 0 ||
      !["queued", "claimed", "succeeded", "failed_permanent"].includes(String(work.state))
    )
      throw unavailable();
    return {
      phase: work.state === "failed_permanent" ? "blocked" : "pending",
      attempt,
      step: "observe",
      reasonCode: work.state === "failed_permanent" ? "RECONCILIATION_EXHAUSTED" : "NOT_OBSERVED",
      retryAt: null,
      observedAt: null,
      recordedAt: null,
    } as const;
  }
  async function readValue(): Promise<unknown> {
    switch (method) {
      case "readStatus": {
        const intent = await context.state.runtimeAssignments.findRuntimeIntentHead(scope);
        const head = intent ? projectLifecycleIntentHeadV1(intent) : null;
        if (
          !head &&
          (
            await context.query(
              `SELECT transition_ref FROM occ.agent_runtime_intents
           WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 LIMIT 1`,
              [context.installationId, scope.namespaceId, scope.agentId],
            )
          ).rows.length !== 0
        )
          throw unavailable();
        if (head && !(await operation(head.operationRef))) throw unavailable();
        const progress = head
          ? await observation(head.operationRef)
          : {
              phase: "pending",
              attempt: 0,
              step: "observe",
              reasonCode: "LIFECYCLE_UNINITIALIZED",
              retryAt: null,
            };
        const unknown = {
          status: "unknown",
          observedAt: null,
          recordedAt: null,
          reasonCode: "NOT_OBSERVED",
        };
        return {
          ...scope,
          head,
          requestedRevisionId: head?.requestedRevisionId ?? null,
          selectedRevisionId: agent!.activeRevisionId ?? null,
          servingRevisionId: null,
          observedLifecycleGeneration: null,
          phase: progress.phase,
          attempt: progress.attempt,
          step: progress.step,
          reasonCode: progress.reasonCode,
          retryAt: progress.retryAt,
          // The closed data parser requires independent objects at each path.
          conditions: {
            accessDenied: { ...unknown },
            routeRemoved: { ...unknown },
            executionTerminated: { ...unknown },
            credentialRevocation: { ...unknown },
            stateRetention: { ...unknown },
          },
          serving: false,
          stopComplete: false,
          retention: "unknown",
        };
      }
      case "readOperation": {
        const exact = parseLifecycleStatusReadRequestV1("readOperation", request);
        const found = await operation(exact.operationRef);
        return found
          ? { operation: found, observation: await observation(exact.operationRef) }
          : undefined;
      }
      case "listOperations": {
        const page = parseLifecycleStatusReadRequestV1("listOperations", request);
        // One indexed owner/generation scan, at most 101 locators. Every retained
        // operation is checked within the SAME snapshot; no unbounded page walk.
        const result = await context.query(
          `SELECT transition_ref FROM occ.agent_runtime_intents
           WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND generation>$4
           ORDER BY generation ASC LIMIT $5`,
          [
            context.installationId,
            scope.namespaceId,
            scope.agentId,
            page.afterGeneration ?? 0,
            page.limit + 1,
          ],
        );
        const operations = [];
        for (const value of result.rows.slice(0, page.limit)) {
          const ref = row(value).transition_ref;
          if (typeof ref !== "string") throw unavailable();
          const found = await operation(ref);
          if (!found) throw unavailable();
          const { requestedRevisionId: _revision, ...minimal } = found;
          operations.push(minimal);
        }
        return {
          operations,
          nextAfterGeneration:
            result.rows.length > page.limit
              ? operations[operations.length - 1]!.lifecycleGeneration
              : null,
        };
      }
      case "readCapability": {
        const result = await context.query(
          `SELECT schema_version, protocol, stage, capability_version,
                  api_version, worker_version, maintenance_version, receiving_version
           FROM occ.lifecycle_capabilities WHERE installation_id=$1`,
          [context.installationId],
        );
        // Migration defaults are not a publication. Application SELECT cannot
        // create or advance the protected compatibility record.
        if (result.rows.length !== 1) throw unavailable();
        const value = row(result.rows[0]);
        return {
          schemaVersion: value.schema_version,
          protocol: value.protocol,
          stage: value.stage,
          capabilityVersion: Number(value.capability_version),
          supportedConsumerVersions: {
            api: value.api_version,
            worker: value.worker_version,
            maintenance: value.maintenance_version,
            receiving: value.receiving_version,
          },
        };
      }
    }
  }
  const value = await readValue();
  return value === undefined
    ? undefined
    : (parseLifecycleObservationResponseV1(
        method,
        request,
        value,
      ) as LifecycleStatusReadValueV1<K>);
}
