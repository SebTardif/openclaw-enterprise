import { types } from "node:util";
import { ScopeViolationError } from "../errors.ts";

/** A closed, separate variant in the original controller work store. Its actor
 * is the original profile invalidation writer; no initiating human permission is borrowed. */
export interface RuntimeProfileWorkV1 {
  readonly schemaVersion: 3;
  readonly handler: "ReconcileRuntimeProfileV1";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly intentRef: string;
  readonly lifecycleGeneration: number;
  readonly operationRef: string;
  readonly invalidationRef: string;
  readonly admissionRef: string;
  readonly previousVersion: 1;
  readonly currentVersion: 2;
  readonly responsibilityRef: string;
  readonly responsibilityVersion: 1;
  readonly requestedFenceEpoch: number;
  readonly gateVersion: number;
  readonly workId: string;
}

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const fields = [
  "schemaVersion",
  "handler",
  "installationId",
  "namespaceId",
  "agentId",
  "intentRef",
  "lifecycleGeneration",
  "operationRef",
  "invalidationRef",
  "admissionRef",
  "previousVersion",
  "currentVersion",
  "responsibilityRef",
  "responsibilityVersion",
  "requestedFenceEpoch",
  "gateVersion",
  "workId",
] as const;
const invalid = (): never => {
  throw new ScopeViolationError("The runtime profile work encoding is invalid.");
};

export function parseRuntimeProfileWorkV1(input: unknown): Readonly<RuntimeProfileWorkV1> {
  if (input === null || typeof input !== "object" || Array.isArray(input) || types.isProxy(input))
    return invalid();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== fields.length ||
    fields.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    return invalid();
  const value = input as RuntimeProfileWorkV1;
  if (
    value.schemaVersion !== 3 ||
    value.handler !== "ReconcileRuntimeProfileV1" ||
    value.responsibilityVersion !== 1
  )
    return invalid();
  if (value.previousVersion !== 1 || value.currentVersion !== 2) return invalid();
  for (const [key, prefix] of [
    ["installationId", "ins_"],
    ["namespaceId", "ns_"],
    ["agentId", "agt_"],
    ["intentRef", ""],
    ["operationRef", ""],
    ["invalidationRef", ""],
    ["admissionRef", ""],
    ["responsibilityRef", ""],
  ] as const) {
    if (
      typeof value[key] !== "string" ||
      new RegExp(`^${prefix}${uuid}$`, "u").exec(value[key])?.[0] !== value[key]
    )
      return invalid();
  }
  for (const key of ["lifecycleGeneration", "requestedFenceEpoch", "gateVersion"] as const)
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) return invalid();
  if (
    typeof value.workId !== "string" ||
    /^[A-Za-z0-9._:/-]{1,512}$/u.exec(value.workId)?.[0] !== value.workId
  )
    return invalid();
  return Object.freeze(
    Object.fromEntries(fields.map((key) => [key, value[key]])),
  ) as unknown as RuntimeProfileWorkV1;
}

export function encodeRuntimeProfileWorkV1(input: unknown): string {
  return JSON.stringify(parseRuntimeProfileWorkV1(input));
}

/** Canonical-only decoding rejects duplicate keys, rounded numbers and aliases
 * before a decoded work locator reaches the original queue association reader. */
export function decodeRuntimeProfileWorkV1(input: string): Readonly<RuntimeProfileWorkV1> {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > 4096) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return invalid();
  }
  const decoded = parseRuntimeProfileWorkV1(value);
  if (encodeRuntimeProfileWorkV1(decoded) !== input) return invalid();
  return decoded;
}
