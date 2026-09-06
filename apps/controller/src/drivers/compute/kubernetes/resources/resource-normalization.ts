import { isProxy } from "node:util/types";
import { Check } from "typebox/value";
import {
  RuntimeResourceVectorSchemaV1,
  parseRuntimeResourceAccountingV1,
  validateRuntimeResourceAccountingV1,
  type RuntimeResourceAccountingEnvelopeV1,
  type RuntimeResourceAccountingResultV1,
  type RuntimeResourceVectorV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

export type ResourceName = "cpu" | "memory" | "ephemeral-storage";
export interface NormalizedResourceRequirements {
  readonly requests: Readonly<Record<ResourceName, string>>;
  readonly limits: Readonly<Record<ResourceName, string>>;
}
export type ResourceNormalizationIssueCode =
  | "invalid-input"
  | "missing-quantity"
  | "invalid-quantity"
  | "request-exceeds-limit"
  | "resource-conflict"
  | "quota-exceeded"
  | "quantity-overflow";
export interface ResourceNormalizationIssue {
  readonly code: ResourceNormalizationIssueCode;
  readonly path: string;
}
export type ResourceRequirementsNormalizationResult =
  | {
      readonly status: "normalized";
      readonly vector: RuntimeResourceVectorV1;
      readonly resources: NormalizedResourceRequirements;
    }
  | {
      readonly status: "incomplete" | "invalid";
      readonly issues: readonly ResourceNormalizationIssue[];
    };
export type ResourceEnvelopeNormalizationResult =
  | {
      readonly status: "accounted" | "incomplete";
      readonly envelope: RuntimeResourceAccountingEnvelopeV1;
      readonly accounting: RuntimeResourceAccountingResultV1;
    }
  | {
      readonly status: "invalid";
      readonly envelope: null;
      readonly accounting: RuntimeResourceAccountingResultV1;
    };
export interface ResourceComparisonResult {
  readonly status: "match" | "conflict" | "incomplete" | "invalid";
  readonly issues: readonly ResourceNormalizationIssue[];
}
export interface ResourceQuotaResult {
  readonly status: "fits" | "exceeded" | "invalid";
  readonly issues: readonly ResourceNormalizationIssue[];
}
const names = ["cpu", "memory", "ephemeral-storage"] as const;
const sides = ["requests", "limits"] as const;
const dimensions = {
  cpu: "cpuMilli",
  memory: "memoryBytes",
  "ephemeral-storage": "ephemeralStorageBytes",
} as const;
const empty = (): { [K in keyof RuntimeResourceVectorV1]: { request: number; limit: number } } => ({
  cpuMilli: { request: 0, limit: 0 },
  memoryBytes: { request: 0, limit: 0 },
  ephemeralStorageBytes: { request: 0, limit: 0 },
});
function fail(): never {
  throw new Error("Invalid resource normalization input.");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Internal shared data boundary for these pure projections. No coercion, getters,
 * proxy traps or caller-owned object references enter the normalized result. */
export function snapshotResourceInput(
  value: unknown,
  depth = 0,
  budget = { left: 262144 },
): unknown {
  if (depth > 32 || --budget.left < 0) fail();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail();
    return value;
  }
  if (typeof value === "string") {
    budget.left -= value.length;
    if (budget.left < 0 || /[\ud800-\udfff]/u.test(value)) fail();
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) fail();
  const array = Array.isArray(value);
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024)) fail();
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    fail();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) fail();
  const copy: Record<string, unknown> = array
    ? ([] as unknown as Record<string, unknown>)
    : Object.create(null);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail();
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail();
    budget.left -= key.length;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) fail();
    copy[key] = snapshotResourceInput(field.value, depth + 1, budget);
  }
  return freeze(copy);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  if (Object.keys(value).some((key) => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}
/** Supported positive/zero decimal quantity grammar, without whitespace or sign:
 * decimal coefficient plus optional n/u/m/k/K/M/G/T/P/E, exponent e/E[+-]digits,
 * or Ki/Mi/Gi/Ti/Pi/Ei for byte quantities. Exponents are bounded to +/-30.
 * The exact result must be integral millicpu/bytes and a safe integer; no rounding. */
export function normalizeResourceQuantity(name: ResourceName, value: unknown): number {
  if (!names.includes(name) || typeof value !== "string" || value.length > 64) fail();
  const match =
    /^(\d+(?:\.\d*)?|\.\d+)(?:(e[+-]?\d+|E[+-]?\d+)|(n|u|m|k|K|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei))?$/.exec(
      value,
    );
  if (!match) fail();
  const coefficient = match[1]!;
  const suffix = match[3] ?? "";
  const fractional = coefficient.includes(".")
    ? coefficient.length - coefficient.indexOf(".") - 1
    : 0;
  const powers: Readonly<Record<string, number>> = {
    "": 0,
    n: -9,
    u: -6,
    m: -3,
    k: 3,
    K: 3,
    M: 6,
    G: 9,
    T: 12,
    P: 15,
    E: 18,
  };
  let exponent = match[2] ? Number(match[2].slice(1)) : (powers[suffix] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) fail();
  let numerator = BigInt(coefficient.replace(".", ""));
  if (suffix.endsWith("i")) {
    if (name === "cpu") fail();
    numerator *= 1024n ** BigInt(["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"].indexOf(suffix) + 1);
  }
  exponent += (name === "cpu" ? 3 : 0) - fractional;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else {
    const divisor = 10n ** BigInt(-exponent);
    if (numerator % divisor !== 0n) fail();
    numerator /= divisor;
  }
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER)) fail();
  return Number(numerator);
}
function canonicalVector(input: unknown, requireOrderedPairs = true): RuntimeResourceVectorV1 {
  const copy = snapshotResourceInput(input);
  if (!Check(RuntimeResourceVectorSchemaV1, copy)) fail();
  const vector = copy as RuntimeResourceVectorV1;
  if (requireOrderedPairs)
    for (const dimension of Object.values(dimensions))
      if (vector[dimension].request > vector[dimension].limit) fail();
  return vector;
}
export function resourceRequirementsFromVector(
  input: RuntimeResourceVectorV1,
): NormalizedResourceRequirements {
  const vector = canonicalVector(input);
  const result = {
    requests: {} as Record<ResourceName, string>,
    limits: {} as Record<ResourceName, string>,
  };
  for (const name of names)
    for (const side of sides) {
      const quantity = vector[dimensions[name]][side === "requests" ? "request" : "limit"];
      result[side][name] = name === "cpu" ? `${quantity}m` : String(quantity);
    }
  return freeze(result);
}
export function normalizeResourceRequirements(
  input: unknown,
): ResourceRequirementsNormalizationResult {
  const issues: ResourceNormalizationIssue[] = [];
  const vector = empty();
  let invalid = false;
  try {
    const top =
      input === undefined
        ? (Object.create(null) as Record<string, unknown>)
        : record(snapshotResourceInput(input), sides);
    for (const side of sides) {
      const values =
        top[side] === undefined
          ? (Object.create(null) as Record<string, unknown>)
          : record(top[side], names);
      for (const name of names) {
        const path = `${side}.${name}`;
        if (values[name] === undefined) {
          issues.push({ code: "missing-quantity", path });
          continue;
        }
        try {
          vector[dimensions[name]][side === "requests" ? "request" : "limit"] =
            normalizeResourceQuantity(name, values[name]);
        } catch {
          invalid = true;
          issues.push({ code: "invalid-quantity", path });
        }
      }
    }
    for (const name of names) {
      const dimension = vector[dimensions[name]];
      if (
        dimension.request > dimension.limit &&
        !issues.some((issue) => issue.path.endsWith(`.${name}`))
      ) {
        invalid = true;
        issues.push({ code: "request-exceeds-limit", path: name });
      }
    }
    if (issues.length) return freeze({ status: invalid ? "invalid" : "incomplete", issues });
    return freeze({
      status: "normalized",
      vector,
      resources: resourceRequirementsFromVector(vector),
    });
  } catch {
    return freeze({ status: "invalid", issues: [{ code: "invalid-input", path: "$root" }] });
  }
}
export function normalizeResourceAccountingEnvelope(
  input: unknown,
): ResourceEnvelopeNormalizationResult {
  try {
    const envelope = parseRuntimeResourceAccountingV1(snapshotResourceInput(input));
    const accounting = validateRuntimeResourceAccountingV1(envelope);
    if (accounting.status === "invalid")
      return freeze({ status: "invalid", envelope: null, accounting });
    return freeze({ status: accounting.status, envelope, accounting });
  } catch {
    return freeze({
      status: "invalid",
      envelope: null,
      accounting: validateRuntimeResourceAccountingV1(null),
    });
  }
}
export function compareResourceRequirements(
  selected: RuntimeResourceVectorV1,
  candidate: unknown,
): ResourceComparisonResult {
  let expected: RuntimeResourceVectorV1;
  try {
    expected = canonicalVector(selected);
  } catch {
    return freeze({ status: "invalid", issues: [{ code: "invalid-input", path: "selected" }] });
  }
  const normalized = normalizeResourceRequirements(candidate);
  if (normalized.status !== "normalized") return normalized;
  const issues: ResourceNormalizationIssue[] = [];
  for (const name of names)
    for (const side of sides) {
      const key = side === "requests" ? "request" : "limit";
      if (expected[dimensions[name]][key] !== normalized.vector[dimensions[name]][key])
        issues.push({ code: "resource-conflict", path: `${side}.${name}` });
    }
  return freeze({ status: issues.length ? "conflict" : "match", issues });
}
export function compareResourceQuota(
  demand: RuntimeResourceVectorV1,
  hard: RuntimeResourceVectorV1,
  used: RuntimeResourceVectorV1,
): ResourceQuotaResult {
  const issues: ResourceNormalizationIssue[] = [];
  try {
    // Quota request and limit caps are independent policy thresholds; the
    // resource requirements themselves still require request <= limit.
    const selected = canonicalVector(demand);
    const available = canonicalVector(hard, false);
    const consumed = canonicalVector(used);
    for (const name of names)
      for (const side of sides) {
        const dimension = dimensions[name];
        const key = side === "requests" ? "request" : "limit";
        const total = selected[dimension][key] + consumed[dimension][key];
        if (!Number.isSafeInteger(total))
          issues.push({ code: "quantity-overflow", path: `${side}.${name}` });
        else if (total > available[dimension][key])
          issues.push({ code: "quota-exceeded", path: `${side}.${name}` });
      }
    let status: ResourceQuotaResult["status"] = issues.length ? "exceeded" : "fits";
    if (issues.some((issue) => issue.code === "quantity-overflow")) status = "invalid";
    return freeze({ status, issues });
  } catch {
    return freeze({ status: "invalid", issues: [{ code: "invalid-input", path: "$root" }] });
  }
}
