import type { RuntimePreparationCurrentUseLeaseV1 } from "../../runtime-preparation/current-use.ts";
import type { RuntimePreparationSubmissionResultV1 } from "../../runtime-preparation/submission.ts";
import { requirePreparation } from "../../runtime-preparation/types.ts";
import type { WorkloadProfileOwnedOperationV2 } from "../../workload-profiles/admitted-use.ts";

/** Borrow the original authenticated transaction. Existing bytes never create
 * another submission opportunity, even if the response is still unknown. */
export async function readRuntimePreparationSubmissionV1(
  lease: RuntimePreparationCurrentUseLeaseV1,
  io: WorkloadProfileOwnedOperationV2,
): Promise<RuntimePreparationSubmissionResultV1 | undefined> {
  lease.assertCurrent();
  const request = lease.request;
  const result = await io.query(
    `SELECT s.*,r.namespace_name,r.deployment_name,r.deployment_uid,
      r.resource_version,to_char(r.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
    FROM occ.runtime_preparation_submissions s
    LEFT JOIN occ.runtime_preparation_submission_responses r USING(effect_ref)
    WHERE s.effect_ref=$1`,
    [request.effectRef],
  );
  lease.assertCurrent();
  if (result.rows.length === 0) return undefined;
  requirePreparation(result.rows.length === 1);
  const row = result.rows[0] as Record<string, unknown>;
  requirePreparation(
    row.installation_id === request.selection.installationId &&
      row.namespace_id === request.selection.namespaceId &&
      row.agent_id === request.selection.agentId &&
      row.revision_id === request.selection.revisionId &&
      row.preparation_ref === request.preparationRef &&
      row.request_digest === lease.child.effect.requestDigest &&
      row.provider_wire_digest === lease.child.providerWire.bytesDigest,
  );
  if (row.deployment_uid == null)
    return Object.freeze({ status: "unknown", effectRef: request.effectRef });
  for (const key of [
    "namespace_name",
    "deployment_name",
    "deployment_uid",
    "resource_version",
    "received_at",
  ])
    requirePreparation(typeof row[key] === "string" && (row[key] as string).length > 0);
  requirePreparation(
    row.deployment_name === lease.child.providerTarget.name &&
      (lease.child.predicate.kind !== "expected-object" ||
        row.deployment_uid === lease.child.predicate.uid),
  );
  return Object.freeze({
    status: "retained",
    effectRef: request.effectRef,
    response: Object.freeze({
      namespace: row.namespace_name as string,
      name: row.deployment_name as string,
      uid: row.deployment_uid as string,
      resourceVersion: row.resource_version as string,
      receivedAt: row.received_at as string,
    }),
  });
}
