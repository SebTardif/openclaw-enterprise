import {
  parseLifecycleAdmissionV1,
  type LifecycleAdmissionAssociationV1,
  type LifecycleIntentV1,
  type ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { types } from "node:util";
import type {
  PlatformOperation,
  ClaimedWork,
  ControllerWork,
  WorkClaim,
} from "../ports/repositories/work.ts";

export type { LifecycleAdmissionAssociationV1, LifecycleIntentV1, ReconcileAgentLifecycleV1 };
export type { PlatformOperation, ClaimedWork, ControllerWork, WorkClaim };

/** These parsers validate data snapshots, never storage provenance or authority. */
export class LifecycleWorkErrorV1 extends Error {
  readonly code = "INVALID_WORK";
  constructor() {
    super("Invalid lifecycle work V1 value.");
    this.name = "LifecycleWorkErrorV1";
  }
}

function invalid(): never {
  throw new LifecycleWorkErrorV1();
}

function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || types.isProxy(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      return invalid();
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !property.enumerable || !("value" in property) || property.value === undefined)
      return invalid();
    output[key] = property.value;
  }
  if (required.some((key) => !Object.hasOwn(output, key))) return invalid();
  return output;
}

function text(input: unknown, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.length > max)
    return invalid();
  return input;
}

function counter(input: unknown, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum)
    return invalid();
  return input;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function claimToken(input: unknown): string {
  const value = text(input);
  return uuid.test(value) ? value : invalid();
}

function date(input: unknown): Date {
  if (!types.isDate(input) || types.isProxy(input)) return invalid();
  const value = Date.prototype.getTime.call(input);
  return Number.isFinite(value) ? new Date(value) : invalid();
}

function transitionPair(value: Record<string, unknown>): {
  readonly runtimeTransitionRef?: string;
  readonly lifecycleGeneration?: number;
} {
  const hasRef = Object.hasOwn(value, "runtimeTransitionRef");
  const hasGeneration = Object.hasOwn(value, "lifecycleGeneration");
  if (hasRef !== hasGeneration) return invalid();
  if (!hasRef) return {};
  const runtimeTransitionRef = text(value.runtimeTransitionRef);
  if (
    !uuid.test(runtimeTransitionRef) ||
    runtimeTransitionRef !== runtimeTransitionRef.toLowerCase()
  )
    return invalid();
  return { runtimeTransitionRef, lifecycleGeneration: counter(value.lifecycleGeneration, 1) };
}

/** Parse the installed in-process work shape. Dates stay Dates and are copied.
 * This does not check foreign keys, persisted ownership, or database claim state.
 */
export function parseControllerWorkV1(input: unknown): Readonly<ControllerWork> {
  const value = record(
    input,
    [
      "idempotencyKey",
      "namespaceId",
      "actorId",
      "state",
      "availableAt",
      "attemptCount",
      "createdAt",
      "updatedAt",
    ],
    [
      "agentId",
      "revisionId",
      "runtimeTransitionRef",
      "lifecycleGeneration",
      "namespaceTarget",
      "claimToken",
      "leaseExpiresAt",
      "completedAt",
    ],
  );
  const pair = transitionPair(value);
  const hasAgent = Object.hasOwn(value, "agentId");
  const hasRevision = Object.hasOwn(value, "revisionId");
  if (hasAgent !== hasRevision) return invalid();
  let target: Pick<ControllerWork, "agentId" | "revisionId" | "namespaceTarget">;
  if (hasAgent) {
    if (Object.hasOwn(value, "namespaceTarget")) return invalid();
    target = { agentId: text(value.agentId), revisionId: text(value.revisionId) };
  } else {
    if (
      pair.runtimeTransitionRef !== undefined ||
      (value.namespaceTarget !== "ready" && value.namespaceTarget !== "deleted")
    )
      return invalid();
    target = { namespaceTarget: value.namespaceTarget };
  }
  const state = value.state;
  if (
    state !== "queued" &&
    state !== "claimed" &&
    state !== "succeeded" &&
    state !== "failed_permanent"
  )
    return invalid();
  const claimed = state === "claimed";
  const terminal = state === "succeeded" || state === "failed_permanent";
  if (
    Object.hasOwn(value, "claimToken") !== claimed ||
    Object.hasOwn(value, "leaseExpiresAt") !== claimed ||
    Object.hasOwn(value, "completedAt") !== terminal
  )
    return invalid();
  return Object.freeze({
    idempotencyKey: text(value.idempotencyKey, 512),
    namespaceId: text(value.namespaceId),
    actorId: text(value.actorId),
    ...target,
    ...pair,
    state,
    availableAt: date(value.availableAt),
    attemptCount: counter(value.attemptCount, 0),
    createdAt: date(value.createdAt),
    updatedAt: date(value.updatedAt),
    ...(claimed
      ? { claimToken: claimToken(value.claimToken), leaseExpiresAt: date(value.leaseExpiresAt) }
      : {}),
    ...(terminal ? { completedAt: date(value.completedAt) } : {}),
  });
}

/** The installed operation kinds remain namespace and agent_revision. */
export function parsePlatformOperationV1(input: unknown): Readonly<PlatformOperation> {
  const value = record(
    input,
    ["action", "kind", "namespaceId", "resourceId", "actorId"],
    ["target", "runtimeTransitionRef", "lifecycleGeneration"],
  );
  if (value.action !== "reconcile") return invalid();
  const pair = transitionPair(value);
  const common = {
    action: "reconcile" as const,
    namespaceId: text(value.namespaceId),
    resourceId: text(value.resourceId),
    actorId: text(value.actorId),
  };
  if (value.kind === "namespace") {
    if (
      pair.runtimeTransitionRef !== undefined ||
      (value.target !== "ready" && value.target !== "deleted")
    )
      return invalid();
    return Object.freeze({ ...common, kind: "namespace", target: value.target });
  }
  if (value.kind !== "agent_revision" || Object.hasOwn(value, "target")) return invalid();
  return Object.freeze({ ...common, ...pair, kind: "agent_revision" });
}

export function parseWorkClaimV1(input: unknown): Readonly<WorkClaim> {
  const value = record(input, ["idempotencyKey", "claimToken"]);
  return Object.freeze({
    idempotencyKey: text(value.idempotencyKey, 512),
    claimToken: claimToken(value.claimToken),
  });
}

/** Inert handler input; no installed queue registration is performed. */
export function parseReconcileAgentLifecycleV1(input: unknown): ReconcileAgentLifecycleV1 {
  return parseLifecycleAdmissionV1("workInput", input);
}

function sameIntent(left: LifecycleIntentV1, right: LifecycleIntentV1): boolean {
  return (
    left.installationId === right.installationId &&
    left.namespaceId === right.namespaceId &&
    left.agentId === right.agentId &&
    left.transitionRef === right.transitionRef &&
    left.generation === right.generation &&
    left.desiredMode === right.desiredMode &&
    left.revisionId === right.revisionId &&
    left.actorId === right.actorId &&
    left.requestId === right.requestId &&
    left.createdAt === right.createdAt
  );
}

/** Compare complete original records supplied by the retained-storage reader.
 * A later head or terminal work state does not alter historical correspondence.
 */
export function lifecycleAssociationsEqualV1(expected: unknown, retained: unknown): boolean {
  const left = parseLifecycleAdmissionV1("association", expected);
  const right = parseLifecycleAdmissionV1("association", retained);
  return (
    sameIntent(left.intent, right.intent) &&
    left.auditEventId === right.auditEventId &&
    left.workId === right.workId &&
    left.request.kind === right.request.kind &&
    left.request.namespaceId === right.request.namespaceId &&
    left.request.agentId === right.request.agentId &&
    left.request.expectedLifecycleGeneration === right.request.expectedLifecycleGeneration &&
    (left.request.kind !== "resume" ||
      (right.request.kind === "resume" &&
        left.request.revisionSource === right.request.revisionSource))
  );
}

export function lifecycleWorkMatchesAssociationV1(input: unknown, retained: unknown): boolean {
  const work = parseReconcileAgentLifecycleV1(input);
  const association = parseLifecycleAdmissionV1("association", retained);
  return (
    work.namespaceId === association.intent.namespaceId &&
    work.agentId === association.intent.agentId &&
    work.operationRef === association.intent.transitionRef &&
    work.lifecycleGeneration === association.intent.generation &&
    work.workId === association.workId
  );
}

export type InstalledLifecycleWorkCorrespondenceV1 =
  "matches-installed-deploy" | "unsupported-transition" | "association-mismatch";

/** Only original deploy work has the installed revision-keyed correspondence.
 * Resume, protective transitions and maintenance remain separate definitions.
 * Matching snapshots does not establish that their rows committed together.
 */
export function inspectInstalledLifecycleWorkV1(
  input: unknown,
  retained: unknown,
  operationInput: unknown,
  workInput: unknown,
): InstalledLifecycleWorkCorrespondenceV1 {
  const association = parseLifecycleAdmissionV1("association", retained);
  const operation = parsePlatformOperationV1(operationInput);
  const work = parseControllerWorkV1(workInput);
  if (!lifecycleWorkMatchesAssociationV1(input, association)) return "association-mismatch";
  if (association.request.kind !== "deploy") return "unsupported-transition";
  const intent = association.intent;
  if (
    association.workId !== `agent_revision:${intent.revisionId}:reconcile` ||
    work.idempotencyKey !== association.workId ||
    work.namespaceId !== intent.namespaceId ||
    work.agentId !== intent.agentId ||
    work.revisionId !== intent.revisionId ||
    work.actorId !== intent.actorId ||
    work.runtimeTransitionRef !== intent.transitionRef ||
    work.lifecycleGeneration !== intent.generation ||
    operation.kind !== "agent_revision" ||
    operation.namespaceId !== intent.namespaceId ||
    operation.resourceId !== intent.revisionId ||
    operation.actorId !== intent.actorId ||
    operation.runtimeTransitionRef !== intent.transitionRef ||
    operation.lifecycleGeneration !== intent.generation
  )
    return "association-mismatch";
  return "matches-installed-deploy";
}

export type LifecycleWorkSnapshotPreflightV1 =
  | "snapshot-matches"
  | "association-mismatch"
  | "head-mismatch"
  | "claim-mismatch"
  | "unsupported-transition";

/** Necessary snapshot comparisons only, not a permit, lease renewal or authority
 * check. The real worker must reload retained data and recheck after waits; each
 * accepting effect boundary independently enforces current purpose and ownership.
 */
export function lifecycleWorkSnapshotPreflightV1(
  input: unknown,
  retained: unknown,
  operationInput: unknown,
  workInput: unknown,
  currentHead: unknown,
  claimInput: unknown,
  installationId: string,
  now: Date,
): LifecycleWorkSnapshotPreflightV1 {
  const association = parseLifecycleAdmissionV1("association", retained);
  const correspondence = inspectInstalledLifecycleWorkV1(
    input,
    association,
    operationInput,
    workInput,
  );
  const work = parseControllerWorkV1(workInput);
  const claim = parseWorkClaimV1(claimInput);
  const instant = date(now).getTime();
  if (correspondence !== "matches-installed-deploy") return correspondence;
  if (association.intent.installationId !== installationId) return "association-mismatch";
  if (currentHead === null) return "head-mismatch";
  const head = parseLifecycleAdmissionV1("intent", currentHead);
  if (!sameIntent(association.intent, head)) return "head-mismatch";
  if (
    work.state !== "claimed" ||
    claim.idempotencyKey !== work.idempotencyKey ||
    claim.claimToken !== work.claimToken ||
    work.leaseExpiresAt === undefined ||
    work.leaseExpiresAt.getTime() <= instant
  )
    return "claim-mismatch";
  return "snapshot-matches";
}
