import { types } from "node:util";
import type { DefinitionRef, PrimitiveRef } from "../credential-gateway-v1/schema.ts";
import { CORE_SCHEMA_PRIMITIVE_MANIFEST_V1 } from "./schema-primitive-manifest.ts";
import { snapshotCanonicalJsonV1 } from "./schema-json.ts";

function deny(): never {
  throw new Error("INVALID_PRIMITIVE");
}

/** Copy exact enumerable own data without invoking caller code. Internal only. */
export function schemaOwnRecordV1(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)) deny();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) deny();
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    deny();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) deny();
    result[key] = descriptor.value;
  }
  return result;
}
function isPrimitiveName(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    Buffer.byteLength(input, "utf8") <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(input)
  );
}
function isPrimitiveVersion(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0;
}
function isPrimitiveDigest(input: unknown): input is string {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/u.test(input);
}
export function snapshotSchemaPrimitiveRefV1(input: unknown): PrimitiveRef {
  const data = schemaOwnRecordV1(input, ["name", "version", "digest"]);
  if (
    !isPrimitiveName(data.name) ||
    !isPrimitiveVersion(data.version) ||
    !isPrimitiveDigest(data.digest)
  )
    deny();
  return Object.freeze({ name: data.name, version: data.version, digest: data.digest });
}
export function snapshotSchemaDefinitionV1(input: unknown): DefinitionRef {
  const data = schemaOwnRecordV1(input, [
    "backendId",
    "recipeId",
    "recipeVersion",
    "recipeDigest",
    "contractVersion",
    "interpreter",
  ]);
  if (
    !isPrimitiveName(data.backendId) ||
    !isPrimitiveName(data.recipeId) ||
    !isPrimitiveVersion(data.recipeVersion) ||
    !isPrimitiveDigest(data.recipeDigest) ||
    data.contractVersion !== "credential-backend-recipe-v1"
  )
    deny();
  return Object.freeze({
    backendId: data.backendId,
    recipeId: data.recipeId,
    recipeVersion: data.recipeVersion,
    recipeDigest: data.recipeDigest,
    contractVersion: data.contractVersion,
    interpreter: snapshotSchemaPrimitiveRefV1(data.interpreter),
  });
}
const interpreter = Object.freeze({
  name: "oce-closed-schema-interpreter",
  version: 1,
  digest: CORE_SCHEMA_PRIMITIVE_MANIFEST_V1[0].digest,
});
const canonicalization = Object.freeze({
  name: "oce-json-canonical",
  version: 1,
  digest: CORE_SCHEMA_PRIMITIVE_MANIFEST_V1[1].digest,
});
/** Immutable descriptors only; possession does not authenticate Installation admission. */
export const CREDENTIAL_SCHEMA_PRIMITIVES_V1 = Object.freeze({ interpreter, canonicalization });
export const INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1: readonly PrimitiveRef[] = Object.freeze([
  interpreter,
  canonicalization,
]);
function samePrimitiveRef(a: PrimitiveRef, b: PrimitiveRef): boolean {
  return a.name === b.name && a.version === b.version && a.digest === b.digest;
}
export function snapshotAdmittedSchemaPrimitivesV1(input: unknown): readonly PrimitiveRef[] {
  const copied = snapshotCanonicalJsonV1(input, { maxBytes: 65536, maxDepth: 4 }).value;
  if (!Array.isArray(copied)) deny();
  const identities = new Set<string>();
  return Object.freeze(
    copied.map((value) => {
      const ref = snapshotSchemaPrimitiveRefV1(value);
      const key = JSON.stringify([ref.name, ref.version]);
      if (
        identities.has(key) ||
        !INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1.some((installed) =>
          samePrimitiveRef(ref, installed),
        )
      )
        deny();
      identities.add(key);
      return ref;
    }),
  );
}
function assertAdmittedPrimitive(
  input: unknown,
  expected: PrimitiveRef,
  admitted: readonly PrimitiveRef[],
): void {
  const ref = snapshotSchemaPrimitiveRefV1(input);
  if (!samePrimitiveRef(ref, expected) || !admitted.some((value) => samePrimitiveRef(value, ref)))
    deny();
}
/** The actual closed Ajv compiler calls this before interpreting any schema. */
export function selectSchemaInterpreterV1(input: unknown, admitted: readonly PrimitiveRef[]): void {
  assertAdmittedPrimitive(input, interpreter, admitted);
}
/** Admit only the fixed JSON protocol; registrations supply no executable implementation. */
export function assertSchemaCanonicalizationV1(
  input: unknown,
  admitted: readonly PrimitiveRef[],
): void {
  assertAdmittedPrimitive(input, canonicalization, admitted);
}
