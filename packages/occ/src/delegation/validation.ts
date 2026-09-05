import { types } from "node:util";

/** Read data descriptors only: validation must not execute caller accessors or proxy traps. */
export function dataRecord(
  input: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || types.isProxy(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

export function dataArray(input: unknown, limit: number): readonly unknown[] | undefined {
  if (typeof input !== "object" || input === null || types.isProxy(input) || !Array.isArray(input))
    return undefined;
  const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) return undefined;
  if (Reflect.ownKeys(input).length !== length + 1) return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}

export function reference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value);
}

export function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function assignmentReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}
