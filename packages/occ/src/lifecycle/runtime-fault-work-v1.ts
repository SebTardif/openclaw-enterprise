import { types } from "node:util";
import { ScopeViolationError } from "../errors.ts";

/** A closed, separate variant in the original controller work store. Its actor
 * is the retained fault writer; no initiating human permission is borrowed. */
export interface RuntimeFaultWorkV1 {
  readonly schemaVersion: 2;
  readonly handler: "ReconcileRuntimeFaultV1";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly intentRef: string;
  readonly lifecycleGeneration: number;
  readonly operationRef: string;
  readonly requestDigest: string;
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
  "requestDigest",
  "responsibilityRef",
  "responsibilityVersion",
  "requestedFenceEpoch",
  "gateVersion",
  "workId",
] as const;
const invalid = (): never => {
  throw new ScopeViolationError("The runtime fault work encoding is invalid.");
};

export function parseRuntimeFaultWorkV1(input: unknown): Readonly<RuntimeFaultWorkV1> {
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
  const value = input as RuntimeFaultWorkV1;
  if (
    value.schemaVersion !== 2 ||
    value.handler !== "ReconcileRuntimeFaultV1" ||
    value.responsibilityVersion !== 1
  )
    return invalid();
  if (
    typeof value.requestDigest !== "string" ||
    /^sha256:[0-9a-f]{64}$/u.exec(value.requestDigest)?.[0] !== value.requestDigest
  )
    return invalid();
  for (const [key, prefix] of [
    ["installationId", "ins_"],
    ["namespaceId", "ns_"],
    ["agentId", "agt_"],
    ["intentRef", ""],
    ["operationRef", ""],
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
  ) as unknown as RuntimeFaultWorkV1;
}

export function encodeRuntimeFaultWorkV1(input: unknown): string {
  return JSON.stringify(parseRuntimeFaultWorkV1(input));
}

/** Canonical-only decoding rejects duplicate keys, rounded numbers and aliases
 * before a decoded work locator reaches the original queue association reader. */
export function decodeRuntimeFaultWorkV1(input: string): Readonly<RuntimeFaultWorkV1> {
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > 4096) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return invalid();
  }
  const decoded = parseRuntimeFaultWorkV1(value);
  if (encodeRuntimeFaultWorkV1(decoded) !== input) return invalid();
  return decoded;
}
