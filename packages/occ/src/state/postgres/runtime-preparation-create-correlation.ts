import type { RuntimeAuthorityScopeV1 } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import {
  parseRuntimePreparationCreateLocatorV1,
  resolveRuntimePreparationCreateReferenceV1,
  type RuntimePreparationCreateCorrelationReadV1,
  type RuntimePreparationCreateLocatorV1,
  type RuntimePreparationCreateReferenceReaderV1,
  type RuntimePreparationCreateReferenceResultV1,
  type RuntimePreparationCreateSubmissionV1,
} from "../../runtime-preparation/create-reference.ts";
import {
  decodeRuntimePreparationOperation,
  projectRuntimePreparation,
  retainedRuntimePreparationRequest,
} from "../../runtime-preparation/repository.ts";
import type { RuntimePreparationDeploymentResponseV1 } from "../../runtime-preparation/submission.ts";
import {
  canonicalRuntimePreparation,
  requirePreparation,
} from "../../runtime-preparation/types.ts";

interface OriginalReadContext {
  assertActive(): void;
  assertScope(scope: RuntimeAuthorityScopeV1): void;
  rows(statement: string, parameters: readonly unknown[]): Promise<readonly unknown[]>;
}

/** This captures the original owner's methods; it does not authenticate a
 * caller-created context or give the caller a query/client replacement slot. */
function captureOriginalContext(context: QueryRepositoryFactoryContext): OriginalReadContext {
  const transaction = context.transaction;
  const assert = transaction.assertActive;
  requirePreparation(typeof assert === "function");
  const assertActive = assert.bind(transaction);
  assertActive();
  const query = context.query;
  const method = query.query;
  requirePreparation(typeof method === "function");
  const execute = method.bind(query);
  const ownerScope = context.scope;
  const installationId = ownerScope.installationId,
    namespaceId = ownerScope.namespaceId;
  requirePreparation(typeof installationId === "string" && installationId.length > 0);
  assertActive();
  return Object.freeze({
    assertActive,
    assertScope(scope: RuntimeAuthorityScopeV1) {
      assertActive();
      requirePreparation(
        scope.installationId === installationId &&
          (namespaceId === undefined || scope.namespaceId === namespaceId),
      );
    },
    async rows(statement: string, parameters: readonly unknown[]) {
      assertActive();
      const result = await execute(statement, parameters);
      assertActive();
      requirePreparation(Array.isArray(result.rows));
      return result.rows;
    },
  });
}

function columnRow(value: unknown): Record<string, unknown> {
  canonicalRuntimePreparation(value);
  requirePreparation(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(row: Record<string, unknown>, key: string, maximum = 1024): string {
  const value = row[key];
  requirePreparation(typeof value === "string" && value.length > 0 && value.length <= maximum);
  return value;
}
function version(row: Record<string, unknown>): number {
  const value = text(row, "preparation_version", 16);
  requirePreparation(/^[1-9][0-9]*$/.test(value));
  const parsed = Number(value);
  requirePreparation(Number.isSafeInteger(parsed) && String(parsed) === value);
  return parsed;
}
function timestamp(row: Record<string, unknown>, key: string): string {
  const value = text(row, key, 24);
  const parsed = Date.parse(value);
  requirePreparation(Number.isFinite(parsed) && new Date(parsed).toISOString() === value);
  return value;
}
function operationRow(value: unknown) {
  requirePreparation(value !== null && typeof value === "object" && !Array.isArray(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, "record");
  requirePreparation(descriptor !== undefined && descriptor.enumerable && "value" in descriptor);
  return decodeRuntimePreparationOperation(descriptor.value);
}

const markerColumns = `SELECT s.effect_ref,s.submission_ref::text AS submission_ref,
  s.installation_id,s.namespace_id,s.agent_id,s.revision_id,s.preparation_ref,
  s.preparation_version::text AS preparation_version,s.request_digest,s.provider_wire_digest,
  to_char(s.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
  r.namespace_name,r.deployment_name,r.deployment_uid,r.resource_version,
  to_char(r.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
  FROM occ.runtime_preparation_submissions s
  LEFT JOIN occ.runtime_preparation_submission_responses r USING(effect_ref)`;
interface MarkerRead {
  readonly submission: RuntimePreparationCreateSubmissionV1;
  readonly response?: RuntimePreparationDeploymentResponseV1;
}
async function readMarker(
  context: OriginalReadContext,
  scope: RuntimeAuthorityScopeV1,
  key: RuntimePreparationCreateLocatorV1,
): Promise<MarkerRead | undefined> {
  const selected = key.kind === "submission" ? "s.submission_ref=$1::uuid" : "s.effect_ref=$1";
  const reference = key.kind === "submission" ? key.submissionRef : key.createEffectRef;
  const rows = await context.rows(
    `${markerColumns}
    WHERE ${selected} AND s.installation_id=$2 AND s.namespace_id=$3 AND s.agent_id=$4`,
    [reference, scope.installationId, scope.namespaceId, scope.agentId],
  );
  requirePreparation(rows.length <= 1);
  if (rows.length === 0) return undefined;
  // Snapshot all marker/response scalars before the next awaited read. No native
  // response provenance or fence epoch is inferred from these stored columns.
  const row = columnRow(rows[0]);
  const submission: RuntimePreparationCreateSubmissionV1 = Object.freeze({
    submissionRef: text(row, "submission_ref"),
    effectRef: text(row, "effect_ref"),
    installationId: text(row, "installation_id"),
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revisionId: text(row, "revision_id"),
    preparationRef: text(row, "preparation_ref"),
    preparationVersion: version(row),
    requestDigest: text(row, "request_digest"),
    providerWireDigest: text(row, "provider_wire_digest"),
    submittedAt: timestamp(row, "submitted_at"),
  });
  requirePreparation(
    submission.installationId === scope.installationId &&
      submission.namespaceId === scope.namespaceId &&
      submission.agentId === scope.agentId &&
      (key.kind === "submission"
        ? submission.submissionRef === reference
        : submission.effectRef === reference),
  );
  const responseKeys = [
    "namespace_name",
    "deployment_name",
    "deployment_uid",
    "resource_version",
    "received_at",
  ];
  if (responseKeys.every((name) => row[name] === null)) return Object.freeze({ submission });
  const response = Object.freeze({
    namespace: text(row, "namespace_name", 253),
    name: text(row, "deployment_name", 253),
    uid: text(row, "deployment_uid"),
    resourceVersion: text(row, "resource_version"),
    receivedAt: timestamp(row, "received_at"),
  });
  return Object.freeze({ submission, response });
}

async function readProjected(
  context: OriginalReadContext,
  inputScope: RuntimeAuthorityScopeV1,
  inputLocator: RuntimePreparationCreateLocatorV1,
): Promise<RuntimePreparationCreateReferenceResultV1> {
  context.assertActive();
  canonicalRuntimePreparation(inputScope);
  requirePreparation(
    Object.keys(inputScope).sort().join(",") === "agentId,installationId,namespaceId" &&
      Object.values(inputScope).every((value) => typeof value === "string" && value.length > 0),
  );
  const scope = immutableCopy(inputScope);
  const locator = parseRuntimePreparationCreateLocatorV1(inputLocator);
  context.assertScope(scope);
  const finish = (read: RuntimePreparationCreateCorrelationReadV1) => {
    context.assertActive();
    const result = resolveRuntimePreparationCreateReferenceV1(scope, locator, read);
    context.assertActive();
    return result;
  };
  let marker =
    locator.kind === "submission" ? await readMarker(context, scope, locator) : undefined;
  if (locator.kind === "submission" && marker === undefined)
    return finish(Object.freeze({ status: "absent" }));
  const effectRef =
    locator.kind === "create-effect" ? locator.createEffectRef : marker?.submission.effectRef;
  requirePreparation(effectRef !== undefined);
  const childRows = await context.rows(
    `SELECT record FROM occ.runtime_preparation_operations
    WHERE child_effect_ref=$1 AND installation_id=$2 AND namespace_id=$3 AND agent_id=$4`,
    [effectRef, scope.installationId, scope.namespaceId, scope.agentId],
  );
  requirePreparation(childRows.length <= 1);
  if (childRows.length === 0) {
    requirePreparation(marker === undefined);
    return finish(Object.freeze({ status: "absent" }));
  }
  const childOperation = operationRow(childRows[0]);
  const selected = retainedRuntimePreparationRequest(childOperation);
  requirePreparation(
    selected.kind === "retain-child" &&
      selected.child.request.kind === "create" &&
      selected.child.providerTarget.apiKind === "Deployment" &&
      selected.child.effect.effectRef === effectRef &&
      childOperation.target.installationId === scope.installationId &&
      childOperation.target.namespaceId === scope.namespaceId &&
      childOperation.target.agentId === scope.agentId,
  );
  // The assignment owner-create reference is checked by the original child
  // decoder; it is never substituted for this selected child's effect identity.
  if (locator.kind === "create-effect") marker = await readMarker(context, scope, locator);
  const submission = marker?.submission;
  if (submission !== undefined)
    requirePreparation(
      submission.effectRef === selected.child.effect.effectRef &&
        submission.revisionId === childOperation.target.revisionId &&
        submission.preparationRef === childOperation.preparationRef &&
        submission.preparationVersion >= childOperation.localVersion &&
        submission.requestDigest === selected.child.effect.requestDigest &&
        submission.providerWireDigest === selected.child.providerWire.bytesDigest,
    );
  const selectedVersion = submission?.preparationVersion ?? childOperation.localVersion;
  // Read the complete immutable prefix at the selected original version. Later
  // closure/supersession, current head and old worker/profile lifetime are irrelevant.
  const rows = await context.rows(
    `SELECT record FROM occ.runtime_preparation_operations
    WHERE preparation_ref=$1 AND installation_id=$2 AND namespace_id=$3 AND agent_id=$4 AND local_version<=$5
    ORDER BY local_version`,
    [
      childOperation.preparationRef,
      scope.installationId,
      scope.namespaceId,
      scope.agentId,
      selectedVersion,
    ],
  );
  const history = Object.freeze(rows.map(operationRow));
  requirePreparation(history.length === selectedVersion);
  const preparation = projectRuntimePreparation(history);
  requirePreparation(preparation !== undefined);
  return finish(
    Object.freeze({
      status: "retained",
      childOperation,
      history,
      preparation,
      child: selected.child,
      providerWireUtf8: selected.providerWireUtf8,
      ...(submission === undefined ? {} : { submission }),
      ...(marker?.response === undefined ? {} : { response: marker.response }),
    }),
  );
}

/** Private historical data only. The original transaction owner supplies this
 * context and read rights. Missing records establish no provider non-submission. */
export async function readRuntimePreparationCreateCorrelationV1(
  originalContext: QueryRepositoryFactoryContext,
  scope: RuntimeAuthorityScopeV1,
  locator: RuntimePreparationCreateLocatorV1,
): Promise<RuntimePreparationCreateCorrelationReadV1> {
  const result = await readProjected(captureOriginalContext(originalContext), scope, locator);
  return result.status === "located" ? result.retained : result;
}

/** Concrete borrowed construction seam; no State installation, connection,
 * transaction control, native context, observation evidence or effect authority. */
export function createRuntimePreparationCreateReferenceReaderV1(
  originalContext: QueryRepositoryFactoryContext,
): RuntimePreparationCreateReferenceReaderV1 {
  const context = captureOriginalContext(originalContext);
  const read: RuntimePreparationCreateReferenceReaderV1["read"] = (scope, locator) =>
    readProjected(context, scope, locator);
  return Object.freeze({ read });
}
