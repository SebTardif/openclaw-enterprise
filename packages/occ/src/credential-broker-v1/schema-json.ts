import { types } from "node:util";
import type { JsonValue } from "../credential-gateway-v1/schema.ts";

const MAX_BYTES = 65_536;
const MAX_DEPTH = 32;
const MAX_NODES = 8_192;

function deny(): never {
  throw new Error("INVALID_VALUE");
}

function ordinaryObject(input: unknown): input is object {
  return input !== null && typeof input === "object" && !types.isProxy(input);
}

function dataProperty(input: object, key: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) deny();
  return descriptor;
}

/** Internal finite-JSON protocol; this does not authenticate data or detect secrets. */
export function snapshotCanonicalJsonV1(
  input: unknown,
  limits: { maxBytes: number; maxDepth: number },
): { readonly value: JsonValue; readonly canonicalJson: string } {
  // Inspect descriptors, including limits, without invoking caller accessors or proxy traps.
  if (!ordinaryObject(limits)) deny();
  const maxBytes: unknown = dataProperty(limits, "maxBytes").value;
  const maxDepth: unknown = dataProperty(limits, "maxDepth").value;
  if (
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_BYTES ||
    typeof maxDepth !== "number" ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > MAX_DEPTH
  )
    deny();

  let nodes = 0;
  let minimumBytes = 0;
  const ancestors = new Set<object>();
  const reserve = (bytes: number): void => {
    minimumBytes += bytes;
    if (minimumBytes > maxBytes) deny();
  };
  const stringSize = (value: string): number => {
    // Bound the byte scan and later scalar encoding before allocating escaped text.
    if (value.length > maxBytes) deny();
    return Buffer.byteLength(value, "utf8") + 2;
  };
  const snapshot = (candidate: unknown, depth: number): JsonValue => {
    if (depth > maxDepth || ++nodes > MAX_NODES) deny();
    if (candidate === null) {
      reserve(4);
      return null;
    }
    if (typeof candidate === "boolean") {
      reserve(candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) deny();
      reserve(1);
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (typeof candidate === "string") {
      reserve(stringSize(candidate));
      return candidate;
    }
    if (!ordinaryObject(candidate) || ancestors.has(candidate)) deny();
    const array = Array.isArray(candidate);
    const prototype = Object.getPrototypeOf(candidate);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      deny();
    ancestors.add(candidate);
    reserve(2);
    let result: JsonValue;
    if (array) {
      const length: unknown = dataProperty(candidate, "length").value;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length >= MAX_NODES
      )
        deny();
      const keys = Reflect.ownKeys(candidate);
      if (keys.length !== length + 1) deny();
      if (length > 0) reserve(length - 1);
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = dataProperty(candidate, String(index));
        if (!descriptor.enumerable) deny();
        copy.push(snapshot(descriptor.value, depth + 1));
      }
      result = Object.freeze(copy);
    } else {
      const keys = Reflect.ownKeys(candidate);
      if (keys.length >= MAX_NODES || keys.some((key) => typeof key !== "string")) deny();
      if (keys.length > 0) reserve(keys.length - 1);
      const copy: { [key: string]: JsonValue } = Object.create(null);
      for (const key of keys as string[]) {
        const descriptor = dataProperty(candidate, key);
        if (!descriptor.enumerable) deny();
        reserve(stringSize(key) + 1);
        copy[key] = snapshot(descriptor.value, depth + 1);
      }
      result = Object.freeze(copy);
    }
    ancestors.delete(candidate);
    return result;
  };

  // Complete JSON admission before serialization. The encoder only sees our frozen copy.
  const value = snapshot(input, 0);
  const chunks: string[] = [];
  let encodedBytes = 0;
  const emit = (chunk: string): void => {
    encodedBytes += Buffer.byteLength(chunk, "utf8");
    if (encodedBytes > maxBytes) deny();
    chunks.push(chunk);
  };
  const encode = (candidate: JsonValue): void => {
    if (candidate === null || typeof candidate !== "object") {
      emit(JSON.stringify(candidate));
    } else if (Array.isArray(candidate)) {
      emit("[");
      candidate.forEach((item, index) => {
        if (index > 0) emit(",");
        encode(item);
      });
      emit("]");
    } else {
      emit("{");
      Object.keys(candidate)
        .sort()
        .forEach((key, index) => {
          if (index > 0) emit(",");
          emit(JSON.stringify(key));
          emit(":");
          encode((candidate as { readonly [key: string]: JsonValue })[key]!);
        });
      emit("}");
    }
  };
  encode(value);
  return Object.freeze({ value, canonicalJson: chunks.join("") });
}
