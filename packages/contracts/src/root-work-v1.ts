import { createHash } from "node:crypto";
import { types } from "node:util";

/** Explicit original Work horizon; even uncapped Work requires finite use leases. */
export type RootDurationPolicyV1 =
  | {
      readonly policyId: string;
      readonly policyVersion: string;
      readonly kind: "finite";
      readonly originalDeadline: number;
    }
  | {
      readonly policyId: string;
      readonly policyVersion: string;
      readonly kind: "uncapped";
      readonly originalDeadline: null;
    };

export interface RootCancellationPolicyV1 {
  readonly ownerPrincipalId: string;
  readonly authorizationId: string;
  readonly dependencyIds: readonly string[];
}

/** Retained DATA only. Neither decoding nor possession authenticates a Work. */
export interface RootWorkIdentityV1 {
  readonly schemaVersion: "root-work-v1";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly agentRevisionId: string;
  readonly rootWorkId: string;
  readonly executionId: string;
  readonly requesterPrincipalId: string;
  readonly servicePrincipalId: string;
  readonly assignmentId: string;
  readonly assignmentGeneration: string;
  readonly selectedIam: {
    readonly driverId: string;
    readonly configurationGeneration: string;
  };
  readonly immutableCeilingDigest: string;
  readonly durationPolicy: RootDurationPolicyV1;
  readonly policyVersion: string;
  readonly cancellation: RootCancellationPolicyV1;
  readonly admittedAt: number;
}

/** Authenticated invocation metadata; the original controller/Work owner verifies it. */
export interface RootDeploymentInvocationV1 {
  readonly kind: "authenticated-deployment";
  readonly invocationId: string;
  readonly requesterPrincipalId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly requestedAt: number;
  readonly deadline: number;
}

/** Full retained policy, not a digest substituted for service entitlement. */
export interface RootWorkPolicyV1 {
  readonly kind: "retained-service-policy";
  readonly servicePrincipalId: string;
  readonly servicePolicyId: string;
  readonly servicePolicyVersion: string;
  readonly policyVersion: string;
  readonly scopeCeiling: readonly {
    readonly action: string;
    readonly canonicalResource: string;
  }[];
  readonly eligibleDataDomains: readonly string[];
  readonly audienceRefs: readonly string[];
  readonly aggregateLimits: readonly {
    readonly name: string;
    readonly maximum: number;
  }[];
  readonly durationPolicy: RootDurationPolicyV1;
  readonly cancellation: RootCancellationPolicyV1;
  readonly immutableCeilingDigest: string;
}

const identityKeys = [
  "schemaVersion",
  "installationId",
  "namespaceId",
  "agentId",
  "agentRevisionId",
  "rootWorkId",
  "executionId",
  "requesterPrincipalId",
  "servicePrincipalId",
  "assignmentId",
  "assignmentGeneration",
  "selectedIam",
  "immutableCeilingDigest",
  "durationPolicy",
  "policyVersion",
  "cancellation",
  "admittedAt",
] as const;
const textEncoder = new TextEncoder();

function invalid(): never {
  // Keep rejected input out of errors and logs.
  throw new TypeError("Invalid root-work-v1 data.");
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  // Read descriptors, never user-defined getters; also reject non-JSON hidden fields.
  const detached: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      return invalid();
    detached[key] = descriptor.value;
  }
  return detached;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\s\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value) ||
    textEncoder.encode(value).byteLength > 256
  )
    return invalid();
  return value;
}

function timestamp(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    return invalid();
  return value;
}

function dependencies(value: unknown): readonly string[] {
  if (
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 64
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  )
    return invalid();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      return invalid();
    result.push(identifier(descriptor.value));
  }
  if (new Set(result).size !== result.length) return invalid();
  return Object.freeze(result);
}

/** Closed, bounded, detached DATA decode. It never issues a Core authentication handle. */
export function decodeRootWorkIdentityV1(value: unknown): Readonly<RootWorkIdentityV1> {
  const root = closedRecord(value, identityKeys);
  if (root.schemaVersion !== "root-work-v1") return invalid();
  const selectedIam = closedRecord(root.selectedIam, ["driverId", "configurationGeneration"]);
  const duration = closedRecord(root.durationPolicy, [
    "policyId",
    "policyVersion",
    "kind",
    "originalDeadline",
  ]);
  const cancellation = closedRecord(root.cancellation, [
    "ownerPrincipalId",
    "authorizationId",
    "dependencyIds",
  ]);
  const admittedAt = timestamp(root.admittedAt);
  const durationBase = {
    policyId: identifier(duration.policyId),
    policyVersion: identifier(duration.policyVersion),
  };
  let durationPolicy: RootDurationPolicyV1;
  if (duration.kind === "finite") {
    const originalDeadline = timestamp(duration.originalDeadline);
    if (originalDeadline <= admittedAt) return invalid();
    durationPolicy = Object.freeze({ ...durationBase, kind: "finite", originalDeadline });
  } else if (duration.kind === "uncapped" && duration.originalDeadline === null) {
    durationPolicy = Object.freeze({ ...durationBase, kind: "uncapped", originalDeadline: null });
  } else {
    return invalid();
  }
  if (
    typeof root.immutableCeilingDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(root.immutableCeilingDigest)
  )
    return invalid();
  // Construction order is the sole canonical wire order. Every nested value is new.
  return Object.freeze({
    schemaVersion: "root-work-v1",
    installationId: identifier(root.installationId),
    namespaceId: identifier(root.namespaceId),
    agentId: identifier(root.agentId),
    agentRevisionId: identifier(root.agentRevisionId),
    rootWorkId: identifier(root.rootWorkId),
    executionId: identifier(root.executionId),
    requesterPrincipalId: identifier(root.requesterPrincipalId),
    servicePrincipalId: identifier(root.servicePrincipalId),
    assignmentId: identifier(root.assignmentId),
    assignmentGeneration: identifier(root.assignmentGeneration),
    selectedIam: Object.freeze({
      driverId: identifier(selectedIam.driverId),
      configurationGeneration: identifier(selectedIam.configurationGeneration),
    }),
    immutableCeilingDigest: root.immutableCeilingDigest,
    durationPolicy,
    policyVersion: identifier(root.policyVersion),
    cancellation: Object.freeze({
      ownerPrincipalId: identifier(cancellation.ownerPrincipalId),
      authorizationId: identifier(cancellation.authorizationId),
      dependencyIds: dependencies(cancellation.dependencyIds),
    }),
    admittedAt,
  });
}

/** Validates again so a typed caller cannot bypass the closed canonical DATA schema. */
export function encodeRootWorkIdentityV1(value: Readonly<RootWorkIdentityV1>): string {
  return JSON.stringify(decodeRootWorkIdentityV1(value));
}

/** SHA-256 of the codec's UTF-8 canonical bytes; a DATA digest confers no authority. */
export function digestRootWorkIdentityV1(value: Readonly<RootWorkIdentityV1>): string {
  return createHash("sha256").update(encodeRootWorkIdentityV1(value), "utf8").digest("hex");
}
