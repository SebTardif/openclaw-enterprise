import { immutableCopy } from "@openclaw-enterprise/utils";
import { types } from "node:util";
import {
  decodeWorkloadProfilePrepareEnvelopeV1,
  type WorkloadProfilePrepareV1,
  type WorkloadProfileScopeV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
  operatorIntentDigest,
  operatorOperationDigest,
  workloadProfileDigest,
} from "./canonical.ts";

/** Internal attribution only. These identifiers do not authenticate a human. */
export interface ProfileOperationActor {
  readonly accountRef: string;
  readonly principalRef: string;
}
export interface ProfileOperationLocator {
  readonly installationId: string;
  readonly actor: ProfileOperationActor;
  readonly operationRef: string;
}
export const PROFILE_ALLOCATION_KINDS = Object.freeze([
  "manifestRef",
  "admissionRef",
  "providerRef",
  "runtimeRef",
  "identityRef",
  "containmentRef",
  "storageRef",
  "historyRef",
  "auditRef",
  "terminalTemplateRef",
  "terminalHistoryRef",
  "terminalAuditRef",
  "terminalInvalidationRef",
] as const);
export type ProfileAllocationKind = (typeof PROFILE_ALLOCATION_KINDS)[number];
export type ProfileAllocatedIdentities = Readonly<Record<ProfileAllocationKind, string>>;
export interface ProfileIdentityAllocator {
  allocate(kind: ProfileAllocationKind): string;
}
export interface NormalizedProfilePreparation {
  readonly request: Readonly<WorkloadProfilePrepareV1>;
  readonly canonicalClientIntent: string;
  readonly clientIntentDigest: string;
}
/** Retained lexical content is inert. It has not passed the closed manifest
 * dictionary, human acceptance guard, or downstream current-use gate. */
export interface StoredProfilePreparation {
  readonly schemaVersion: 1;
  readonly kind: "inert-profile-preparation";
  readonly scope: WorkloadProfileScopeV1;
  readonly actor: ProfileOperationActor;
  readonly operationRef: string;
  readonly action: "admit" | "replace";
  readonly canonicalClientIntent: string;
  readonly clientIntentDigest: string;
  readonly allocated: ProfileAllocatedIdentities;
  readonly canonicalOperation: string;
  readonly operationDigest: string;
  readonly preparedAt: string;
}
export interface ProfileCapacity {
  readonly ordinaryOperations: number;
  readonly pendingOrdinaryOperations: number;
  readonly terminalSlots: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
export class InvalidProfileOperationError extends Error {
  constructor() {
    super("Invalid workload profile operation.");
  }
}
function invalid(): never {
  throw new InvalidProfileOperationError();
}
export function profileUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== 36 || !uuid.test(value)) invalid();
}
export function profileInstallation(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("ins_")) invalid();
  profileUuid(value.slice(4));
}
function keys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value))
    invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
}
export function profileActor(input: unknown): ProfileOperationActor {
  canonicalizeWorkloadProfileJson(input, "operator-envelope");
  keys(input, ["accountRef", "principalRef"]);
  for (const ref of [input.accountRef, input.principalRef])
    if (
      typeof ref !== "string" ||
      ref.length === 0 ||
      ref.length > 1024 ||
      controls.test(ref) ||
      encoder.encode(ref).byteLength > 1024
    )
      invalid();
  const value = immutableCopy(input);
  keys(value, ["accountRef", "principalRef"]);
  return value as unknown as ProfileOperationActor;
}
export function profileLocator(input: ProfileOperationLocator): ProfileOperationLocator {
  canonicalizeWorkloadProfileJson(input, "operator-envelope");
  keys(input, ["installationId", "actor", "operationRef"]);
  profileInstallation(input.installationId);
  profileUuid(input.operationRef);
  return immutableCopy({ ...input, actor: profileActor(input.actor) });
}
export function normalizeProfilePreparation(input: unknown): NormalizedProfilePreparation {
  const decoded = decodeWorkloadProfilePrepareEnvelopeV1(input);
  if (decoded.kind !== "valid") invalid();
  const request = decoded.value;
  const manifest = decodeWorkloadProfileJson(encoder.encode(request.manifest.canonicalUtf8));
  if (
    decoder.decode(manifest.canonicalBytes) !== request.manifest.canonicalUtf8 ||
    workloadProfileDigest("manifestDigest", manifest.value) !== request.manifest.manifestDigest
  )
    invalid();
  const canonicalClientIntent = decoder.decode(
    canonicalizeWorkloadProfileJson(request, "operator-envelope"),
  );
  return immutableCopy({
    request,
    canonicalClientIntent,
    clientIntentDigest: operatorIntentDigest(request),
  });
}
export function profileAllocatedIdentities(input: unknown): ProfileAllocatedIdentities {
  canonicalizeWorkloadProfileJson(input, "operator-envelope");
  keys(input, PROFILE_ALLOCATION_KINDS);
  for (const kind of PROFILE_ALLOCATION_KINDS) profileUuid(input[kind]);
  if (new Set(Object.values(input)).size !== PROFILE_ALLOCATION_KINDS.length) invalid();
  const value = immutableCopy(input);
  keys(value, PROFILE_ALLOCATION_KINDS);
  return value as ProfileAllocatedIdentities;
}
export function profileTimestamp(input: unknown): asserts input is string {
  if (
    typeof input !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  )
    invalid();
}
export function profileOperationEnvelope(
  record: Omit<StoredProfilePreparation, "canonicalOperation" | "operationDigest">,
) {
  return {
    schemaVersion: 1,
    kind: record.kind,
    scope: record.scope,
    actor: record.actor,
    operationRef: record.operationRef,
    action: record.action,
    clientIntentDigest: record.clientIntentDigest,
    allocated: record.allocated,
    preparedAt: record.preparedAt,
  };
}
export function createProfilePreparation(
  installationId: string,
  actor: ProfileOperationActor,
  normalized: NormalizedProfilePreparation,
  allocated: ProfileAllocatedIdentities,
  preparedAt: string,
): StoredProfilePreparation {
  profileInstallation(installationId);
  profileTimestamp(preparedAt);
  const record = {
    schemaVersion: 1 as const,
    kind: "inert-profile-preparation" as const,
    scope: {
      installationId,
      namespaceId: normalized.request.namespaceId,
      component: "harness" as const,
    },
    actor: profileActor(actor),
    operationRef: normalized.request.operationRef,
    action: normalized.request.action,
    canonicalClientIntent: normalized.canonicalClientIntent,
    clientIntentDigest: normalized.clientIntentDigest,
    allocated: profileAllocatedIdentities(allocated),
    preparedAt,
  };
  const envelope = profileOperationEnvelope(record);
  return immutableCopy({
    ...record,
    canonicalOperation: decoder.decode(
      canonicalizeWorkloadProfileJson(envelope, "operator-envelope"),
    ),
    operationDigest: operatorOperationDigest(envelope),
  });
}
/** Decode every retained field and recompute both domains before any readback. */
export function decodeStoredProfilePreparation(input: unknown): StoredProfilePreparation {
  // The record contains independently bounded canonical strings and can exceed
  // the request byte limit. Inspect each closed field, never recanonicalize it as a request.
  keys(input, [
    "schemaVersion",
    "kind",
    "scope",
    "actor",
    "operationRef",
    "action",
    "canonicalClientIntent",
    "clientIntentDigest",
    "allocated",
    "canonicalOperation",
    "operationDigest",
    "preparedAt",
  ]);
  if (input.schemaVersion !== 1 || input.kind !== "inert-profile-preparation") invalid();
  if (
    typeof input.canonicalClientIntent !== "string" ||
    typeof input.canonicalOperation !== "string" ||
    input.canonicalClientIntent.length > 65_536 ||
    input.canonicalOperation.length > 65_536
  )
    invalid();
  const value = decodeWorkloadProfileJson(
    encoder.encode(input.canonicalClientIntent),
    "operator-envelope",
  ).value;
  const normalized = normalizeProfilePreparation(value);
  keys(input.scope, ["installationId", "namespaceId", "component"]);
  profileInstallation(input.scope.installationId);
  profileTimestamp(input.preparedAt);
  const rebuilt = createProfilePreparation(
    input.scope.installationId,
    profileActor(input.actor),
    normalized,
    profileAllocatedIdentities(input.allocated),
    input.preparedAt,
  );
  for (const field of [
    "operationRef",
    "action",
    "canonicalClientIntent",
    "clientIntentDigest",
    "canonicalOperation",
    "operationDigest",
    "preparedAt",
  ] as const)
    if (input[field] !== rebuilt[field]) invalid();
  if (input.scope.namespaceId !== rebuilt.scope.namespaceId || input.scope.component !== "harness")
    invalid();
  return rebuilt;
}

/** Length framing makes even opaque account/provider identities unambiguous. */
export function profileOperationKey(locator: ProfileOperationLocator): string {
  return [locator.installationId, locator.actor.principalRef, locator.operationRef]
    .map((part) => `${encoder.encode(part).byteLength}:${part}`)
    .join("");
}
