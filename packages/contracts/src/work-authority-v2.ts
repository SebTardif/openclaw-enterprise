import { Type } from "typebox";
import { Check } from "typebox/value";
import { InstallationId } from "./api/common.ts";

const Ref = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const Closed = { additionalProperties: false } as const;
const OwnerSchema = Type.Object(
  {
    kind: Type.Enum(["service", "user"]),
    principalId: Ref,
    installationId: InstallationId,
  },
  Closed,
);
const InvocationSchema = Type.Object(
  {
    actorPrincipalId: Ref,
    sourceInvocationRef: Ref,
    sourceEventRef: Ref,
    originalTargetRef: Ref,
    invocationDecisionRef: Ref,
  },
  Closed,
);

/** Diagnostic identity data. Decoding does not resolve or authenticate a principal. */
export type WorkOwnerValueV2 = Readonly<Type.Static<typeof OwnerSchema>>;

/** Original invocation attribution, separate from current service effect authority. */
export type WorkInvocationValueV2 = Readonly<Type.Static<typeof InvocationSchema>>;

type DecodeResult<T> = Readonly<{ kind: "decoded"; value: T }> | Readonly<{ kind: "invalid" }>;

const Invalid = Object.freeze({ kind: "invalid" } as const);
const OwnerFields = ["kind", "principalId", "installationId"] as const;
const InvocationFields = [
  "actorPrincipalId",
  "sourceInvocationRef",
  "sourceEventRef",
  "originalTargetRef",
  "invocationDecisionRef",
] as const;

function decode<T extends Type.TSchema>(
  schema: T,
  fields: readonly string[],
  input: unknown,
): DecodeResult<Readonly<Type.Static<T>>> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return Invalid;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return Invalid;

    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return Invalid;

    // These values are flat. Capture only own data strings before schema checks or
    // serialization, so getters and input toJSON methods are never invoked.
    const snapshot: Record<string, string> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length > 1024 ||
        /[^\x20-\x7e]/.test(descriptor.value)
      )
        return Invalid;
      snapshot[field] = descriptor.value;
    }

    if (
      !Check(schema, snapshot) ||
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 16 * 1024
    )
      return Invalid;

    return Object.freeze({
      kind: "decoded",
      value: Object.freeze(snapshot) as Readonly<Type.Static<T>>,
    });
  } catch {
    return Invalid;
  }
}

/** Accepts both diagnostic owner kinds; service-only admission belongs to its consumer. */
export function decodeWorkOwnerValueV2(input: unknown): DecodeResult<WorkOwnerValueV2> {
  return decode(OwnerSchema, OwnerFields, input);
}

/** Validates representation only; an earlier invocation decision is not a permit. */
export function decodeWorkInvocationValueV2(input: unknown): DecodeResult<WorkInvocationValueV2> {
  return decode(InvocationSchema, InvocationFields, input);
}
