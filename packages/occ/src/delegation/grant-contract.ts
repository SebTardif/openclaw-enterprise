import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  assignmentReference,
  dataArray,
  dataRecord,
  positive,
  reference,
  timestamp,
} from "./validation.ts";

export const DELEGATION_MAX_OPERATIONS = 32;

export interface ModelOperationV1 {
  readonly kind: "model.generate";
  readonly providerBindingRef: string;
  readonly modelId: string;
  readonly transportProfileRef: "codex-responses-http-v1";
}

export interface GrantHolderV1 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly servicePrincipalId: string;
  readonly assignmentRef: Readonly<{ schemaVersion: 1; id: string }>;
  readonly component: "harness";
  readonly lifecycleGeneration: number;
  readonly runtimeGeneration: number;
  readonly providerProfileRef: string;
  readonly runtimeProfileRef: string;
  readonly identityProfileRef: string;
}

export interface GrantTurnV1 {
  readonly principalId: string;
  readonly conversationRef: string;
  readonly turnRef: string;
  readonly attemptRef: string;
  readonly commonGrantRef: string;
}

/** Root-only immutable ceiling. Parsing it establishes no identity, issuance or currentness. */
export interface RootGrantV1 {
  readonly schemaVersion: 1;
  readonly grantRef: string;
  readonly mediationContextRef: string;
  readonly holder: GrantHolderV1;
  readonly turn: GrantTurnV1;
  readonly audienceRef: string;
  readonly operations: readonly ModelOperationV1[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly maxRequests: number;
  readonly maxConcurrentRequests: number;
  readonly status: "active" | "closed" | "revoked";
}

export function isMediationContextRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function parseModelOperationV1(input: unknown): ModelOperationV1 | undefined {
  const value = dataRecord(input, ["kind", "providerBindingRef", "modelId", "transportProfileRef"]);
  if (
    !value ||
    value.kind !== "model.generate" ||
    value.transportProfileRef !== "codex-responses-http-v1" ||
    !reference(value.providerBindingRef) ||
    !reference(value.modelId)
  )
    return undefined;
  return Object.freeze({
    kind: "model.generate",
    providerBindingRef: value.providerBindingRef,
    modelId: value.modelId,
    transportProfileRef: "codex-responses-http-v1",
  });
}

export function sameModelOperation(left: ModelOperationV1, right: ModelOperationV1): boolean {
  return (
    left.kind === right.kind &&
    left.providerBindingRef === right.providerBindingRef &&
    left.modelId === right.modelId &&
    left.transportProfileRef === right.transportProfileRef
  );
}

export function parseModelOperations(input: unknown): readonly ModelOperationV1[] | undefined {
  const items = dataArray(input, DELEGATION_MAX_OPERATIONS);
  if (!items) return undefined;
  const result: ModelOperationV1[] = [];
  for (const item of items) {
    const operation = parseModelOperationV1(item);
    if (!operation || result.some((existing) => sameModelOperation(existing, operation)))
      return undefined;
    result.push(operation);
  }
  return Object.freeze(result);
}

const holderReferences = [
  "installationId",
  "namespaceId",
  "agentId",
  "agentRevisionId",
  "servicePrincipalId",
  "providerProfileRef",
  "runtimeProfileRef",
  "identityProfileRef",
] as const;

export function parseGrantHolderV1(input: unknown): GrantHolderV1 | undefined {
  const value = dataRecord(input, [
    ...holderReferences,
    "assignmentRef",
    "component",
    "lifecycleGeneration",
    "runtimeGeneration",
  ]);
  if (!value || !holderReferences.every((field) => reference(value[field]))) return undefined;
  const assignment = dataRecord(value.assignmentRef, ["schemaVersion", "id"]);
  if (
    !assignment ||
    assignment.schemaVersion !== 1 ||
    !assignmentReference(assignment.id) ||
    value.component !== "harness" ||
    !positive(value.lifecycleGeneration) ||
    !positive(value.runtimeGeneration)
  )
    return undefined;
  return immutableCopy({
    ...(Object.fromEntries(holderReferences.map((field) => [field, value[field]])) as Record<
      (typeof holderReferences)[number],
      string
    >),
    assignmentRef: { schemaVersion: 1, id: assignment.id },
    component: "harness",
    lifecycleGeneration: value.lifecycleGeneration,
    runtimeGeneration: value.runtimeGeneration,
  });
}

const turnReferences = [
  "principalId",
  "conversationRef",
  "turnRef",
  "attemptRef",
  "commonGrantRef",
] as const;

export function parseGrantTurnV1(input: unknown): GrantTurnV1 | undefined {
  const value = dataRecord(input, turnReferences);
  if (!value || !turnReferences.every((field) => reference(value[field]))) return undefined;
  return immutableCopy(value as unknown as GrantTurnV1);
}

export function sameGrantHolder(left: GrantHolderV1, right: GrantHolderV1): boolean {
  return (
    holderReferences.every((field) => left[field] === right[field]) &&
    left.assignmentRef.id === right.assignmentRef.id &&
    left.component === right.component &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.runtimeGeneration === right.runtimeGeneration
  );
}

export function sameGrantTurn(left: GrantTurnV1, right: GrantTurnV1): boolean {
  return turnReferences.every((field) => left[field] === right[field]);
}

export function parseRootGrantV1(input: unknown): RootGrantV1 | undefined {
  const value = dataRecord(input, [
    "schemaVersion",
    "grantRef",
    "mediationContextRef",
    "holder",
    "turn",
    "audienceRef",
    "operations",
    "issuedAt",
    "notBefore",
    "expiresAt",
    "maxRequests",
    "maxConcurrentRequests",
    "status",
  ]);
  if (!value) return undefined;
  const holder = parseGrantHolderV1(value.holder);
  const turn = parseGrantTurnV1(value.turn);
  const operations = parseModelOperations(value.operations);
  if (
    value.schemaVersion !== 1 ||
    !reference(value.grantRef) ||
    !isMediationContextRef(value.mediationContextRef) ||
    !reference(value.audienceRef) ||
    !holder ||
    !turn ||
    !operations ||
    operations.length === 0 ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.notBefore) ||
    !timestamp(value.expiresAt) ||
    value.issuedAt > value.notBefore ||
    value.notBefore >= value.expiresAt ||
    !positive(value.maxRequests) ||
    !positive(value.maxConcurrentRequests) ||
    value.maxConcurrentRequests > value.maxRequests ||
    !["active", "closed", "revoked"].includes(value.status as string)
  )
    return undefined;
  return immutableCopy({
    schemaVersion: 1,
    grantRef: value.grantRef,
    mediationContextRef: value.mediationContextRef,
    holder,
    turn,
    audienceRef: value.audienceRef,
    operations,
    issuedAt: value.issuedAt,
    notBefore: value.notBefore,
    expiresAt: value.expiresAt,
    maxRequests: value.maxRequests,
    maxConcurrentRequests: value.maxConcurrentRequests,
    status: value.status as RootGrantV1["status"],
  });
}
