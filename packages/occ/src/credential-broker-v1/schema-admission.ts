import { createHash } from "node:crypto";
import { types } from "node:util";
import { Ajv } from "ajv";
import type {
  JsonValue,
  PrimitiveRef,
  SchemaBinding,
  SchemaRegistration,
  SchemaRef,
  SchemaRole,
} from "../credential-gateway-v1/schema.ts";
import { snapshotCanonicalJsonV1 } from "./schema-json.ts";
import {
  schemaOwnRecordV1,
  snapshotSchemaDefinitionV1,
  selectSchemaInterpreterV1,
  assertSchemaCanonicalizationV1,
  snapshotSchemaPrimitiveRefV1,
} from "./schema-primitives.ts";

const PROFILE = "oce-closed-draft7-v1";
const DRAFT = "http://json-schema.org/draft-07/schema#";
const ROLES = [
  "configuration",
  "resource",
  "operation",
  "credential-profile",
  "observation",
  "evidence",
  "locator",
  "cursor",
] as const;
type RecordValue = { readonly [key: string]: JsonValue };

function deny(code: "INVALID_SCHEMA" | "INVALID_VALUE" = "INVALID_SCHEMA"): never {
  throw new Error(code);
}

function record(value: unknown): value is RecordValue {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Field readers only inspect owned, immutable canonical snapshots. Returning the
// original record preserves its null prototype and recursively frozen children.
function readFields<T extends object>(
  input: unknown,
  readers: { readonly [Key in keyof T]: (value: unknown) => T[Key] },
): T {
  const data = schemaOwnRecordV1(input, Object.keys(readers));
  for (const key of Object.keys(readers) as (keyof T & string)[]) readers[key](data[key]);
  return input as T;
}

function boundedText(maximum: number): (value: unknown) => string {
  return (value) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value, "utf8") > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      deny();
    return value;
  };
}

function positiveInteger(maximum: number): (value: unknown) => number {
  return (value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum)
      deny();
    return value;
  };
}

function readDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) deny();
  return value;
}

function readRole(value: unknown): SchemaRole {
  const role = ROLES.find((candidate) => candidate === value);
  if (role === undefined) deny();
  return role;
}

function readSchemaRef(value: unknown): SchemaRef {
  return readFields<SchemaRef>(value, {
    namespace: boundedText(256),
    name: boundedText(256),
    version: positiveInteger(Number.MAX_SAFE_INTEGER),
    digest: readDigest,
  });
}

function bindingSnapshot(input: unknown): SchemaBinding {
  const snapshot = snapshotCanonicalJsonV1(input, { maxBytes: 4096, maxDepth: 4 });
  return readFields<SchemaBinding>(snapshot.value, {
    definition: snapshotSchemaDefinitionV1,
    role: readRole,
    schema: readSchemaRef,
  });
}

function admitNodeBudget(value: JsonValue): void {
  let nodes = 0;
  const count = (item: JsonValue): void => {
    if (++nodes > 2048) deny();
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) count(child);
    }
  };
  count(value);
}

function admitRange(value: RecordValue, minimum: string, maximum: string, limit: number): void {
  const upper = value[maximum];
  const lower = value[minimum];
  if (typeof upper !== "number" || !Number.isSafeInteger(upper) || upper < 0 || upper > limit)
    deny();
  if (
    Object.hasOwn(value, minimum) &&
    (typeof lower !== "number" || !Number.isSafeInteger(lower) || lower < 0 || lower > upper)
  )
    deny();
}

function admitObject(value: RecordValue): void {
  const properties = value.properties;
  if (!record(properties) || value.additionalProperties !== false) deny();
  // Ajv skips __proto__ validation but can count it as declared when checking
  // additional properties. Deny this own name at every object before compile.
  if (Object.hasOwn(properties, "__proto__")) deny();
  for (const child of Object.values(properties)) admitSchemaNode(child, false);
  if (Object.hasOwn(value, "required")) {
    const required = value.required;
    if (
      !Array.isArray(required) ||
      new Set(required).size !== required.length ||
      required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))
    )
      deny();
  }
}

function admitArray(value: RecordValue): void {
  if (!Object.hasOwn(value, "items")) deny();
  admitSchemaNode(value.items!, false);
  admitRange(value, "minItems", "maxItems", 1024);
}

function admitScalar(value: RecordValue): void {
  if (Object.hasOwn(value, "const") && value.const !== null && typeof value.const === "object")
    deny();
  if (
    Object.hasOwn(value, "enum") &&
    (!Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      value.enum.some((item) => item !== null && typeof item === "object"))
  )
    deny();
}

function admitString(value: RecordValue): void {
  admitRange(value, "minLength", "maxLength", 65536);
  admitScalar(value);
}

const NUMERIC_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"];
function admitNumber(value: RecordValue): void {
  admitScalar(value);
  for (const key of NUMERIC_KEYS)
    if (Object.hasOwn(value, key) && typeof value[key] !== "number") deny();
}

const PROFILE_RULES = {
  object: { keys: ["properties", "required", "additionalProperties"], admit: admitObject },
  array: { keys: ["items", "minItems", "maxItems"], admit: admitArray },
  string: { keys: ["const", "enum", "minLength", "maxLength"], admit: admitString },
  number: { keys: ["const", "enum", ...NUMERIC_KEYS], admit: admitNumber },
  integer: { keys: ["const", "enum", ...NUMERIC_KEYS], admit: admitNumber },
  boolean: { keys: ["const", "enum"], admit: admitScalar },
  null: { keys: ["const", "enum"], admit: admitScalar },
};

function admitSchemaNode(value: JsonValue, root: boolean): void {
  if (!record(value)) deny();
  const type = value.type;
  if (typeof type !== "string" || !Object.hasOwn(PROFILE_RULES, type)) deny();
  const rule = PROFILE_RULES[type as keyof typeof PROFILE_RULES];
  const allowed = new Set(["type", "title", "description", ...rule.keys]);
  if (root) allowed.add("$schema");
  if (Object.keys(value).some((key) => !allowed.has(key))) deny();
  if (Object.hasOwn(value, "$schema") && value.$schema !== DRAFT) deny();
  for (const key of ["title", "description"])
    if (Object.hasOwn(value, key) && typeof value[key] !== "string") deny();
  rule.admit(value);
}

function admitProfile(schema: JsonValue): void {
  admitNodeBudget(schema);
  admitSchemaNode(schema, true);
}

/** Internal admitted evaluator, consumed by the core schema registry. */
export interface CompiledSchemaV1 {
  readonly binding: SchemaBinding;
  readonly jsonSchema: JsonValue;
  readonly maxBytes: number;
  readonly maxDepth: number;
  validate(candidate: unknown): ReturnType<typeof snapshotCanonicalJsonV1>;
}

function admitRegistration(
  registration: SchemaRegistration,
  admittedPrimitives: readonly PrimitiveRef[],
) {
  const data = schemaOwnRecordV1(registration, [
    "binding",
    "jsonSchema",
    "maxBytes",
    "maxDepth",
    "canonicalization",
  ]);
  const maxBytes = positiveInteger(65536)(data.maxBytes);
  const maxDepth = positiveInteger(32)(data.maxDepth);
  const binding = bindingSnapshot(data.binding);
  selectSchemaInterpreterV1(binding.definition.interpreter, admittedPrimitives);
  const canonicalization = snapshotSchemaPrimitiveRefV1(data.canonicalization);
  assertSchemaCanonicalizationV1(canonicalization, admittedPrimitives);
  const schema = snapshotCanonicalJsonV1(data.jsonSchema, { maxBytes: 65536, maxDepth: 32 });
  admitProfile(schema.value);
  return { binding, canonicalization, schema, maxBytes, maxDepth };
}

function assertSchemaDigest(registration: ReturnType<typeof admitRegistration>): void {
  const { binding, canonicalization, schema, maxBytes, maxDepth } = registration;
  // These keys are already in the canonical encoder's UTF-16 order. Embedding its
  // admitted schema bytes avoids applying the schema byte cap to domain overhead.
  const primitiveBytes = snapshotCanonicalJsonV1(canonicalization, {
    maxBytes: 4096,
    maxDepth: 4,
  }).canonicalJson;
  const payload = `{"canonicalization":${primitiveBytes},"jsonSchema":${schema.canonicalJson},"maxBytes":${maxBytes},"maxDepth":${maxDepth},"profile":"${PROFILE}"}`;
  const digest =
    "sha256:" +
    createHash("sha256")
      .update("oce-schema-recipe-v1\0" + payload, "utf8")
      .digest("hex");
  if (binding.schema.digest !== digest) deny();
}

function compileValidator(
  schema: JsonValue,
  maxBytes: number,
  maxDepth: number,
): CompiledSchemaV1["validate"] {
  const ajv = new Ajv({
    strict: true,
    ownProperties: true,
    allErrors: false,
    logger: false,
    validateSchema: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  const validate = ajv.compile(schema as object);
  if ("$async" in validate && validate.$async) deny();
  return (candidate: unknown) => {
    try {
      const snapshot = snapshotCanonicalJsonV1(candidate, { maxBytes, maxDepth });
      if (!validate(snapshot.value)) deny("INVALID_VALUE");
      return snapshot;
    } catch {
      deny("INVALID_VALUE");
    }
  };
}

/** Bind the closed schema to the admitted fixed JSON protocol. */
export function compileSchemaRegistrationV1(
  registration: SchemaRegistration,
  admittedPrimitives: readonly PrimitiveRef[],
): CompiledSchemaV1 {
  try {
    const admitted = admitRegistration(registration, admittedPrimitives);
    assertSchemaDigest(admitted);
    const { binding, schema, maxBytes, maxDepth } = admitted;
    return Object.freeze({
      binding,
      jsonSchema: schema.value,
      maxBytes,
      maxDepth,
      validate: compileValidator(schema.value, maxBytes, maxDepth),
    });
  } catch {
    deny();
  }
}
