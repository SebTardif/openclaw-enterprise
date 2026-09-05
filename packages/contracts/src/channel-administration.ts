import { Type } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";

const Reference = Type.String({ minLength: 1, maxLength: 1024 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Closed = { additionalProperties: false } as const;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Explicit registration on one existing IAM AccessBinding; never inferred from a Role name. */
export const ChannelAdministrationMappingSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    version: Version,
    status: Type.Enum(["enabled", "disabled"]),
    installationId: Reference,
    roleId: Reference,
    semanticClass: Type.Literal("installation-administrator"),
  },
  Closed,
);
export type ChannelAdministrationMappingV1 = DeepReadonly<
  Type.Static<typeof ChannelAdministrationMappingSchemaV1>
>;

/** Same-snapshot granting evidence. It contains no session proof or account/security epoch. */
export const ChannelAdministrationEvidenceSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    installationId: Reference,
    mappings: Type.Array(
      Type.Object({ bindingId: Reference, roleId: Reference, version: Version }, Closed),
      { maxItems: 64 },
    ),
  },
  Closed,
);
export type ChannelAdministrationEvidenceV1 = DeepReadonly<
  Type.Static<typeof ChannelAdministrationEvidenceSchemaV1>
>;

export type ChannelAdministrationDecodeResultV1<T> =
  Readonly<{ kind: "valid"; value: T }> | Readonly<{ kind: "invalid" }>;

function jsonValue(value: unknown, seen: Set<object>, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof value === "string")
    return (
      value.length > 0 &&
      value.length <= 1024 &&
      value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value) &&
      new TextEncoder().encode(value).byteLength <= 1024
    );
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (
    array
      ? Object.getPrototypeOf(value) !== Array.prototype
      : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (array ? value.length > 64 || keys.length !== value.length + 1 : keys.length > 6) return false;
  seen.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array) {
      if (key === "length") continue;
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      )
        return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    if (!jsonValue(descriptor.value, seen, depth + 1)) return false;
  }
  return true;
}

export function decodeChannelAdministrationMappingV1(
  input: unknown,
): ChannelAdministrationDecodeResultV1<ChannelAdministrationMappingV1> {
  try {
    if (!jsonValue(input, new Set()) || !Check(ChannelAdministrationMappingSchemaV1, input))
      return { kind: "invalid" };
    return { kind: "valid", value: immutableCopy(input) };
  } catch {
    return { kind: "invalid" };
  }
}

export function decodeChannelAdministrationEvidenceV1(
  input: unknown,
): ChannelAdministrationDecodeResultV1<ChannelAdministrationEvidenceV1> {
  try {
    if (!jsonValue(input, new Set()) || !Check(ChannelAdministrationEvidenceSchemaV1, input))
      return { kind: "invalid" };
    const bindings = new Set<string>();
    for (const mapping of input.mappings) {
      if (bindings.has(mapping.bindingId)) return { kind: "invalid" };
      bindings.add(mapping.bindingId);
    }
    return { kind: "valid", value: immutableCopy(input) };
  } catch {
    return { kind: "invalid" };
  }
}
