import { types } from "node:util";
import { Check } from "typebox/value";
import type { Static, TSchema } from "typebox";
import {
  parseRuntimeEffectsV1,
  parseRuntimeEffectsResponseV1,
  type RuntimeEvidenceProvenanceV1,
} from "./runtime-effects-v1.ts";
import {
  CONTAINMENT_CONTROLS_LIMITS_V1 as limits,
  ContainmentControlInputSchemaV1,
  ContainmentControlResultSchemaV1,
  type ContainmentControlInputV1,
  type ContainmentControlResultV1,
  type ContainmentControlDecodeV1,
  type ImmutableContainmentControlV1,
} from "./containment-controls-v1.ts";

function invalid(): never {
  throw new Error("invalid-input");
}
function scalar(value: string): void {
  if (value.length > limits.maxInputBytes) invalid();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid();
  }
}
/** Descriptor-only bounded JSON-value snapshot; caller code is never invoked. */
function snapshot(input: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const charge = (n: number): void => {
    bytes += n;
    if (bytes > limits.maxInputBytes) invalid();
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) invalid();
    if (value === null || typeof value === "boolean") {
      charge(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      scalar(value);
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
      charge(String(value).length);
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.maxContainerEntries + (array ? 1 : 0)) invalid();
    if (array && keys.length !== value.length + 1) invalid();
    const count = keys.length - (array ? 1 : 0);
    charge(2 + Math.max(0, count - 1));
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") invalid();
      if (array && key === "length") continue;
      scalar(key);
      if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  };
  return copy(input, 0);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
function equal(a: unknown, b: unknown): void {
  if (canonical(a) !== canonical(b)) invalid();
}
function timestamp(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) invalid();
  return ms;
}
function checkInput(input: ContainmentControlInputV1): void {
  parseRuntimeEffectsV1("observationInput", input.runtime);
  if (
    input.runtime.target.component !== "harness" ||
    input.runtime.binding.provider !== "occ/kubernetes-gvisor"
  )
    invalid();
  const controls = input.requiredControls.map((entry) => entry.control);
  if (new Set(controls).size !== controls.length) invalid();
  if (input.after) timestamp(input.after.sourceObservedAt);
}
function checkProvenance(value: RuntimeEvidenceProvenanceV1): void {
  // Original schema plus original clock/identity invariants; this verifies no signature.
  parseRuntimeEffectsV1("provenance", value);
}
function checkResult(result: ContainmentControlResultV1): void {
  checkInput(result.input);
  if (result.status !== "observed") {
    if (result.status === "cancelled" && result.reasonCode !== "cancelled") invalid();
    if (result.status === "deadline-exceeded" && result.reasonCode !== "deadline-exceeded")
      invalid();
    return;
  }
  parseRuntimeEffectsResponseV1("observe", result.input.runtime, result.runtimeObservation);
  checkProvenance(result.observation);
  const cursor = result.cursor;
  equal(cursor.producerRef, result.observation.producerRef);
  equal(cursor.evidenceVersion, result.observation.evidenceVersion);
  equal(cursor.sourceObservedAt, result.observation.clock.sourceObservedAt);
  const sourceTime = timestamp(cursor.sourceObservedAt);
  const previous = result.input.after;
  if (previous) {
    equal(cursor.producerRef, previous.producerRef);
    if (
      cursor.epochVersion < previous.epochVersion ||
      sourceTime < timestamp(previous.sourceObservedAt)
    )
      invalid();
    if (cursor.epochVersion === previous.epochVersion) {
      equal(cursor.epochRef, previous.epochRef);
      if (cursor.evidenceVersion <= previous.evidenceVersion) invalid();
    } else if (cursor.epochRef === previous.epochRef) invalid();
  }
  const controls = result.controls.map((entry) => entry.control);
  if (new Set(controls).size !== controls.length) invalid();
  equal([...controls].sort(), result.input.requiredControls.map((entry) => entry.control).sort());
  for (const entry of result.controls) {
    const expected = result.input.requiredControls.find(
      (required) => required.control === entry.control,
    );
    if (!expected) invalid();
    equal(entry.desired, expected.desired);
    checkProvenance(entry.source);
    // A fresh projection receipt cannot replace old original producer observations.
    if (
      timestamp(entry.source.clock.sourceObservedAt) >
      sourceTime + result.observation.clock.uncertaintyMs
    )
      invalid();
    for (const stage of [entry.delivered, entry.effective]) {
      if (!stage) continue;
      checkProvenance(stage.evidence);
      equal(stage.evidence.producerRef, entry.source.producerRef);
      equal(stage.evidence.acceptedPortRef, entry.source.acceptedPortRef);
      if (
        stage.evidence.evidenceVersion > entry.source.evidenceVersion ||
        timestamp(stage.evidence.clock.sourceObservedAt) >
          timestamp(entry.source.clock.sourceObservedAt) + entry.source.clock.uncertaintyMs
      )
        invalid();
    }
    if (entry.outcome === "effective") {
      if (!entry.delivered || !entry.effective || entry.reasonCode !== null) invalid();
      for (const stage of [entry.delivered, entry.effective]) {
        equal(
          { profileRef: stage.profileRef, version: stage.version, digest: stage.digest },
          entry.desired,
        );
      }
    } else if (entry.reasonCode === null) invalid();
  }
}
function decode<S extends TSchema>(
  schema: S,
  input: unknown,
  check: (value: Static<S>) => void,
): ContainmentControlDecodeV1<Static<S>> {
  try {
    const value = snapshot(input);
    if (!Check(schema, value)) invalid();
    check(value as Static<S>);
    return Object.freeze({
      kind: "valid",
      value: value as ImmutableContainmentControlV1<Static<S>>,
    });
  } catch {
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  }
}
/** Shape/consistency only. No serialized context/proof is promoted to trusted data. */
export function decodeContainmentControlInputV1(
  input: unknown,
): ContainmentControlDecodeV1<ContainmentControlInputV1> {
  return decode(ContainmentControlInputSchemaV1, input, checkInput);
}
export function decodeContainmentControlResultV1(
  input: unknown,
): ContainmentControlDecodeV1<ContainmentControlResultV1> {
  return decode(ContainmentControlResultSchemaV1, input, checkResult);
}
/** Exact retained input correlation; even unavailable outcomes cannot be substituted.
 * Cursors order observations only and must be retained in protected consumer state.
 * Same-cursor readback remains available by decoding a result against its original
 * request; a new request with `after` requires advancement, otherwise returns unknown.
 */
export function decodeContainmentControlExchangeV1(
  expected: unknown,
  input: unknown,
): ContainmentControlDecodeV1<ContainmentControlResultV1> {
  const request = decodeContainmentControlInputV1(expected);
  const result = decodeContainmentControlResultV1(input);
  if (request.kind === "invalid" || result.kind === "invalid")
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  try {
    equal(request.value, result.value.input);
    return result;
  } catch {
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  }
}
