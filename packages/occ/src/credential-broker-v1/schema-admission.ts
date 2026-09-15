import { createHash } from "node:crypto";
import { types } from "node:util";
import { Ajv } from "ajv";
import type {
  JsonValue,
  SchemaBinding,
  SchemaRegistration,
} from "../credential-gateway-v1/schema.ts";
import { snapshotCanonicalJsonV1 } from "./schema-json.ts";

const PROFILE = "oce-closed-draft7-v1";
const DRAFT = "http://json-schema.org/draft-07/schema#";
const ROLES = new Set([
  "configuration",
  "resource",
  "operation",
  "credential-profile",
  "observation",
  "evidence",
  "locator",
  "cursor",
]);
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

function field(value: unknown, key: string): unknown {
  if (!record(value)) deny();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) deny();
  return descriptor.value;
}

function exactKeys(value: RecordValue, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) deny();
}

function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function positive(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function bindingSnapshot(input: unknown): SchemaBinding {
  const value = snapshotCanonicalJsonV1(input, { maxBytes: 4096, maxDepth: 4 }).value;
  if (!record(value)) deny();
  exactKeys(value, ["definition", "role", "schema"]);
  const { definition, role, schema } = value;
  if (!record(definition) || !record(schema)) deny();
  exactKeys(definition, [
    "backendId",
    "packageName",
    "packageVersion",
    "packageIntegrity",
    "contractVersion",
  ]);
  exactKeys(schema, ["namespace", "name", "version", "digest"]);
  if (
    !text(definition.backendId, 256) ||
    !text(definition.packageName, 214) ||
    !text(definition.packageVersion, 128) ||
    !text(definition.packageIntegrity, 1024) ||
    definition.contractVersion !== "credential-backend-v1" ||
    typeof role !== "string" ||
    !ROLES.has(role) ||
    !text(schema.namespace, 256) ||
    !text(schema.name, 256) ||
    !positive(schema.version, Number.MAX_SAFE_INTEGER) ||
    typeof schema.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(schema.digest)
  )
    deny();
  return value as unknown as SchemaBinding;
}

function admitProfile(schema: JsonValue): void {
  let nodes = 0;
  const count = (value: JsonValue): void => {
    if (++nodes > 2048) deny();
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) count(item);
    }
  };
  count(schema);
  const walk = (value: JsonValue, root: boolean): void => {
    if (!record(value)) deny();
    const type = value.type;
    if (
      typeof type !== "string" ||
      !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type)
    )
      deny();
    const allowed = new Set(["type", "title", "description"]);
    if (root) allowed.add("$schema");
    if (type === "object")
      ["properties", "required", "additionalProperties"].forEach((key) => allowed.add(key));
    else if (type === "array") ["items", "minItems", "maxItems"].forEach((key) => allowed.add(key));
    else {
      ["const", "enum"].forEach((key) => allowed.add(key));
      if (type === "string") ["minLength", "maxLength"].forEach((key) => allowed.add(key));
      if (type === "number" || type === "integer")
        ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].forEach((key) =>
          allowed.add(key),
        );
    }
    if (Object.keys(value).some((key) => !allowed.has(key))) deny();
    if (Object.hasOwn(value, "$schema") && value.$schema !== DRAFT) deny();
    for (const key of ["title", "description"])
      if (Object.hasOwn(value, key) && typeof value[key] !== "string") deny();
    if (type === "object") {
      if (!record(value.properties) || value.additionalProperties !== false) deny();
      // Ajv skips __proto__ validation but can count it as declared when checking
      // additional properties. Deny this own name at every object before compile.
      if (Object.hasOwn(value.properties, "__proto__")) deny();
      for (const child of Object.values(value.properties)) walk(child, false);
      if (Object.hasOwn(value, "required")) {
        const required = value.required;
        if (
          !Array.isArray(required) ||
          new Set(required).size !== required.length ||
          required.some(
            (key) => typeof key !== "string" || !Object.hasOwn(value.properties as object, key),
          )
        )
          deny();
      }
    } else if (type === "array") {
      if (!Object.hasOwn(value, "items")) deny();
      walk(value.items!, false);
      if (
        typeof value.maxItems !== "number" ||
        !Number.isSafeInteger(value.maxItems) ||
        value.maxItems < 0 ||
        value.maxItems > 1024
      )
        deny();
      if (
        Object.hasOwn(value, "minItems") &&
        (typeof value.minItems !== "number" ||
          !Number.isSafeInteger(value.minItems) ||
          value.minItems < 0 ||
          value.minItems > value.maxItems)
      )
        deny();
    } else if (type === "string") {
      if (
        typeof value.maxLength !== "number" ||
        !Number.isSafeInteger(value.maxLength) ||
        value.maxLength < 0 ||
        value.maxLength > 65536
      )
        deny();
      if (
        Object.hasOwn(value, "minLength") &&
        (typeof value.minLength !== "number" ||
          !Number.isSafeInteger(value.minLength) ||
          value.minLength < 0 ||
          value.minLength > value.maxLength)
      )
        deny();
    }
    if (Object.hasOwn(value, "const") && value.const !== null && typeof value.const === "object")
      deny();
    if (
      Object.hasOwn(value, "enum") &&
      (!Array.isArray(value.enum) ||
        value.enum.length === 0 ||
        value.enum.some((item) => item !== null && typeof item === "object"))
    )
      deny();
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"])
      if (Object.hasOwn(value, key) && typeof value[key] !== "number") deny();
  };
  walk(schema, true);
}

/** Internal admitted evaluator, consumed by the core schema registry. */
export interface CompiledSchemaV1 {
  readonly binding: SchemaBinding;
  readonly jsonSchema: JsonValue;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly validateAndCanonicalize: (candidate: JsonValue) => JsonValue;
  assertValid(candidate: JsonValue): void;
}

/** Copy and bind all schema facts before any semantic hook can execute. */
export function compileSchemaRegistrationV1(registration: SchemaRegistration): CompiledSchemaV1 {
  try {
    const maxBytes = field(registration, "maxBytes");
    const maxDepth = field(registration, "maxDepth");
    if (!positive(maxBytes, 65536) || !positive(maxDepth, 32)) deny();
    const binding = bindingSnapshot(field(registration, "binding"));
    const captured = field(registration, "validateAndCanonicalize");
    if (typeof captured !== "function" || types.isProxy(captured)) deny();
    const schema = snapshotCanonicalJsonV1(field(registration, "jsonSchema"), {
      maxBytes: 65536,
      maxDepth: 32,
    });
    admitProfile(schema.value);
    // These keys are already in the canonical encoder's UTF-16 order. Embedding its
    // admitted schema bytes avoids applying the schema byte cap to domain overhead.
    const payload = `{"jsonSchema":${schema.canonicalJson},"maxBytes":${maxBytes},"maxDepth":${maxDepth},"profile":"${PROFILE}"}`;
    const digest =
      "sha256:" +
      createHash("sha256")
        .update("oce-schema-v1\0" + payload, "utf8")
        .digest("hex");
    if (binding.schema.digest !== digest) deny();
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
    const validate = ajv.compile(schema.value as object);
    if ("$async" in validate && validate.$async) deny();
    const validatedSnapshot = (candidate: unknown) => {
      try {
        const snapshot = snapshotCanonicalJsonV1(candidate, { maxBytes, maxDepth });
        if (!validate(snapshot.value)) deny("INVALID_VALUE");
        return snapshot;
      } catch {
        deny("INVALID_VALUE");
      }
    };
    return Object.freeze({
      binding,
      jsonSchema: schema.value,
      maxBytes,
      maxDepth,
      validateAndCanonicalize: (candidate: JsonValue): JsonValue => {
        const input = validatedSnapshot(candidate);
        try {
          const result: unknown = Reflect.apply(captured, undefined, [input.value]);
          return validatedSnapshot(result).value;
        } catch {
          deny("INVALID_VALUE");
        }
      },
      assertValid(candidate: JsonValue): void {
        validatedSnapshot(candidate);
      },
    });
  } catch {
    deny();
  }
}
