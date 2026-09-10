import { types } from "node:util";
import { ScopeViolationError } from "../../errors.ts";

function fail(): never {
  throw new ScopeViolationError("The repository Work operation is unavailable.");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) return fail();
    result[key] = descriptor.value;
  }
  if (Reflect.ownKeys(value).length !== Object.keys(result).length) return fail();
  return result;
}
export function canonicalRepositoryWorkV2(value: unknown): string {
  let nodes = 0;
  const encode = (input: unknown, depth: number): string => {
    if (++nodes > 8192 || depth > 24) return fail();
    if (input === null || typeof input === "boolean" || typeof input === "string")
      return JSON.stringify(input);
    if (typeof input === "number" && Number.isSafeInteger(input) && !Object.is(input, -0))
      return String(input);
    if (input && typeof input === "object" && types.isProxy(input)) return fail();
    if (Array.isArray(input)) {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(descriptors).length !== input.length + 1) return fail();
      return `[${Array.from({ length: input.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) return fail();
        return encode(descriptor.value, depth + 1);
      }).join(",")}]`;
    }
    const entries = object(input);
    return `{${Object.keys(entries)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(entries[key], depth + 1)}`)
      .join(",")}}`;
  };
  const result = encode(value, 0);
  if (Buffer.byteLength(result) > 131072) return fail();
  return result;
}
export { object as repositoryWorkObjectV2, fail as repositoryWorkUnavailableV2 };
