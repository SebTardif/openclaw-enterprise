import { RUNTIME_AUTHORITY_LIMITS_V1 } from "./schemas.ts";

/** Internal decoding errors contain rule descriptions, never input values. */
export class RuntimeAuthorityValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid runtime authority V1 value: ${reason}.`);
    this.name = "RuntimeAuthorityValidationError";
  }
}

export function reject(reason = "expected bounded plain JSON data"): never {
  throw new RuntimeAuthorityValidationError(reason);
}

/** Snapshot only plain, bounded JSON data; never invoke getters or toJSON hooks. */
export function snapshotJsonData(
  input: unknown,
  depth = 0,
  budget = { remaining: RUNTIME_AUTHORITY_LIMITS_V1.maxJsonBytes },
): unknown {
  if (depth > RUNTIME_AUTHORITY_LIMITS_V1.maxDepth || --budget.remaining < 0) reject();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) reject();
    return input;
  }
  if (typeof input === "string") {
    if (/[\ud800-\udfff]/u.test(input)) reject();
    budget.remaining -= new TextEncoder().encode(input).byteLength;
    if (budget.remaining < 0) reject();
    return input;
  }
  if (typeof input !== "object") reject();
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 1024) reject();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== input.length + 1) reject();
    return Array.from({ length: input.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(input, String(index));
      if (!d || !("value" in d) || !d.enumerable) reject();
      return snapshotJsonData(d.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      reject();
    snapshotJsonData(key, depth + 1, budget);
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !("value" in d) || !d.enumerable) reject();
    result[key] = snapshotJsonData(d.value, depth + 1, budget);
  }
  return result;
}

export function freezeJsonData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJsonData(child);
    Object.freeze(value);
  }
  return value;
}

/** Stable object-key order; callers must validate JSON data before serialization. */
export function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(input)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
    .join(",")}}`;
}

/** Bounded JSON scanner preserves duplicate-key detection, including escaped duplicate names. */
export function parseJson(input: string): unknown {
  if (
    typeof input !== "string" ||
    input.length > RUNTIME_AUTHORITY_LIMITS_V1.maxJsonBytes ||
    new TextEncoder().encode(input).byteLength > RUNTIME_AUTHORITY_LIMITS_V1.maxJsonBytes
  )
    reject();
  let at = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(input[at] ?? "!")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const character = input[at++];
      if (character === "\\") {
        at++;
        continue;
      }
      if (character === '"') return JSON.parse(input.slice(start, at));
    }
    return reject();
  };
  const value = (depth: number): unknown => {
    if (depth > RUNTIME_AUTHORITY_LIMITS_V1.maxDepth) reject();
    ws();
    if (input[at] === '"') return string();
    if (input[at] === "{") {
      at++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      if (input[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        ws();
        if (input[at] !== '"') reject();
        const key = string();
        if (Object.hasOwn(result, key)) reject("JSON contains a duplicate property");
        ws();
        if (input[at++] !== ":") reject();
        result[key] = value(depth + 1);
        ws();
        const next = input[at++];
        if (next === "}") return result;
        if (next !== ",") reject();
      }
    }
    if (input[at] === "[") {
      at++;
      ws();
      const result: unknown[] = [];
      if (input[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        ws();
        const next = input[at++];
        if (next === "]") return result;
        if (next !== ",") reject();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      input.slice(at),
    );
    if (!token) reject();
    at += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    // JSON.parse rounds before schema validation. Counters must have exact canonical
    // decimal integer lexemes, so neither fractional rounding nor exponent aliases pass.
    if (
      typeof parsed === "number" &&
      (!/^(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(parsed))
    )
      reject("JSON counters require safe decimal integer literals");
    return parsed;
  };
  const result = value(0);
  ws();
  if (at !== input.length) reject();
  return result;
}
