import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ValidatedSchemaValue } from "../credential-gateway-v1/handles.ts";
import type {
  DefinitionRef,
  PrimitiveRef,
  JsonValue,
  RegisteredSchemaCodec,
  RetainedSchemaValue,
  SchemaBinding,
  SchemaRegistration,
  SchemaRegistrationOwner,
} from "../credential-gateway-v1/schema.ts";
import { compileSchemaRegistrationV1 } from "./schema-admission.ts";
import type { CompiledSchemaV1 } from "./schema-admission.ts";
import { snapshotCanonicalJsonV1 } from "./schema-json.ts";
import {
  snapshotSchemaDefinitionV1,
  snapshotAdmittedSchemaPrimitivesV1,
  schemaOwnRecordV1,
  selectSchemaInterpreterV1,
} from "./schema-primitives.ts";

export interface CredentialSchemaRegistryV1 {
  begin(definition: DefinitionRef): SchemaRegistrationScopeV1;
  assertCodec(codec: unknown, expected: SchemaBinding): asserts codec is RegisteredSchemaCodec;
}
export interface SchemaRegistrationScopeV1 {
  readonly schemas: SchemaRegistrationOwner;
  commit(): void;
  discard(): void;
}
type ScopeState = { phase: "pending" | "committed" | "discarded"; busy: boolean };
type CodecState = {
  scope: ScopeState;
  compiled: CompiledSchemaV1;
  bindingKey: string;
  values: WeakMap<object, { readonly value: JsonValue; readonly canonicalJson: string }>;
};
function deny(code = "INVALID_VALUE"): never {
  throw new Error(code);
}
function ownRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)) deny();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) deny();
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    deny();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) deny();
    copy[key] = descriptor.value;
  }
  return copy;
}
function canonical(input: unknown, maxBytes = 4096, maxDepth = 4) {
  return snapshotCanonicalJsonV1(input, { maxBytes, maxDepth });
}
function valueDigest(binding: SchemaBinding, canonicalJson: string): string {
  // The payload may exceed the data byte limit due to escaped envelope overhead.
  // Each embedded field has already passed its independent bound.
  const payload =
    '{"canonicalJson":' +
    JSON.stringify(canonicalJson) +
    ',"definition":' +
    canonical(binding.definition).canonicalJson +
    ',"role":' +
    JSON.stringify(binding.role) +
    ',"schema":' +
    canonical(binding.schema).canonicalJson +
    "}";
  return (
    "sha256:" +
    createHash("sha256")
      .update("oce-schema-value-v1\0" + payload, "utf8")
      .digest("hex")
  );
}

/** Core-local schema ownership. Trusted startup supplies admitted installed identities. */
export function createCredentialSchemaRegistryV1(
  admittedDefinitions: readonly DefinitionRef[],
  options: { readonly admittedPrimitives: readonly PrimitiveRef[] },
): CredentialSchemaRegistryV1 {
  let admittedPrimitives: readonly PrimitiveRef[];
  try {
    const data = schemaOwnRecordV1(options, ["admittedPrimitives"]);
    admittedPrimitives = snapshotAdmittedSchemaPrimitivesV1(data.admittedPrimitives);
  } catch {
    deny("INVALID_PRIMITIVE");
  }
  const admitted = new Set<string>();
  const logicalDefinitions = new Set<string>();
  try {
    const copied = canonical(admittedDefinitions, 65536, 5).value;
    if (!Array.isArray(copied)) deny();
    for (const input of copied) {
      const definition = snapshotSchemaDefinitionV1(input);
      selectSchemaInterpreterV1(definition.interpreter, admittedPrimitives);
      const logicalKey = JSON.stringify([
        definition.backendId,
        definition.recipeId,
        definition.recipeVersion,
      ]);
      if (logicalDefinitions.has(logicalKey)) deny();
      logicalDefinitions.add(logicalKey);
      const key = canonical(definition).canonicalJson;
      if (admitted.has(key)) deny();
      admitted.add(key);
    }
  } catch {
    deny("INVALID_DEFINITION");
  }
  const begunDefinitions = new Set<string>();
  const codecs = new WeakMap<object, CodecState>();
  const active = (state: CodecState): void => {
    if (state.scope.phase !== "committed") deny("INVALID_CODEC");
  };
  const registry: CredentialSchemaRegistryV1 = Object.freeze({
    begin(this: CredentialSchemaRegistryV1, definition: DefinitionRef): SchemaRegistrationScopeV1 {
      if (this !== registry) deny("INVALID_OWNER");
      let key: string;
      try {
        key = canonical(snapshotSchemaDefinitionV1(definition)).canonicalJson;
      } catch {
        deny("INVALID_DEFINITION");
      }
      if (!admitted.has(key) || begunDefinitions.has(key)) deny("INVALID_DEFINITION");
      begunDefinitions.add(key);
      const state: ScopeState = { phase: "pending", busy: false };
      const tuples = new Set<string>();
      const schemas: SchemaRegistrationOwner = Object.freeze({
        register(
          this: SchemaRegistrationOwner,
          registration: SchemaRegistration,
        ): RegisteredSchemaCodec {
          if (this !== schemas) deny("INVALID_OWNER");
          if (state.phase !== "pending" || state.busy) deny("INVALID_SCOPE");
          let compiled: CompiledSchemaV1;
          try {
            compiled = compileSchemaRegistrationV1(registration, admittedPrimitives);
          } catch {
            deny("INVALID_SCHEMA");
          }
          if (canonical(compiled.binding.definition).canonicalJson !== key) deny("INVALID_SCHEMA");
          const tuple = canonical({
            role: compiled.binding.role,
            namespace: compiled.binding.schema.namespace,
            name: compiled.binding.schema.name,
            version: compiled.binding.schema.version,
          }).canonicalJson;
          if (tuples.has(tuple)) deny("INVALID_SCHEMA");
          const codecState: CodecState = {
            scope: state,
            compiled,
            bindingKey: canonical(compiled.binding).canonicalJson,
            values: new WeakMap(),
          };
          const authenticate = (receiver: unknown): void => {
            if (receiver !== codec) deny("INVALID_CODEC");
            active(codecState);
          };
          const issue = (result: {
            readonly value: JsonValue;
            readonly canonicalJson: string;
          }): ValidatedSchemaValue => {
            active(codecState);
            const handle = Object.freeze({});
            codecState.values.set(handle, result);
            return handle as ValidatedSchemaValue;
          };
          const evaluate = (
            input: unknown,
          ): { readonly value: JsonValue; readonly canonicalJson: string } => {
            if (state.busy) deny("INVALID_SCOPE");
            state.busy = true;
            try {
              const result = compiled.validateAndCanonicalize(input as JsonValue);
              active(codecState);
              return canonical(result, compiled.maxBytes, compiled.maxDepth);
            } finally {
              state.busy = false;
            }
          };
          const codec = Object.freeze({
            binding: compiled.binding,
            validate(this: RegisteredSchemaCodec, input: unknown): ValidatedSchemaValue {
              authenticate(this);
              return issue(evaluate(input));
            },
            retain(this: RegisteredSchemaCodec, value: ValidatedSchemaValue): RetainedSchemaValue {
              authenticate(this);
              if (state.busy) deny("INVALID_SCOPE");
              const saved =
                value && typeof value === "object" ? codecState.values.get(value) : undefined;
              if (!saved) deny();
              const binding = canonical(compiled.binding).value as unknown as SchemaBinding;
              return Object.freeze({
                ...binding,
                canonicalJson: saved.canonicalJson,
                digest: valueDigest(binding, saved.canonicalJson),
              });
            },
            restore(this: RegisteredSchemaCodec, value: RetainedSchemaValue): ValidatedSchemaValue {
              authenticate(this);
              if (state.busy) deny("INVALID_SCOPE");
              try {
                const data = ownRecord(value, [
                  "definition",
                  "role",
                  "schema",
                  "canonicalJson",
                  "digest",
                ]);
                const binding = canonical({
                  definition: data.definition,
                  role: data.role,
                  schema: data.schema,
                });
                if (binding.canonicalJson !== codecState.bindingKey) deny();
                const text = data.canonicalJson;
                if (
                  typeof text !== "string" ||
                  text.length > compiled.maxBytes ||
                  Buffer.byteLength(text, "utf8") > compiled.maxBytes
                )
                  deny();
                if (
                  typeof data.digest !== "string" ||
                  !/^sha256:[0-9a-f]{64}$/u.test(data.digest) ||
                  data.digest !== valueDigest(compiled.binding, text)
                )
                  deny();
                const parsed: unknown = JSON.parse(text);
                const snapshot = canonical(parsed, compiled.maxBytes, compiled.maxDepth);
                if (snapshot.canonicalJson !== text) deny();
                const result = evaluate(snapshot.value);
                if (result.canonicalJson !== text) deny();
                return issue(result);
              } catch {
                deny();
              }
            },
          }) as unknown as RegisteredSchemaCodec;
          codecs.set(codec, codecState);
          tuples.add(tuple);
          return codec;
        },
      });
      const scope: SchemaRegistrationScopeV1 = Object.freeze({
        schemas,
        commit(this: SchemaRegistrationScopeV1): void {
          if (this !== scope) deny("INVALID_OWNER");
          if (state.phase !== "pending" || state.busy) deny("INVALID_SCOPE");
          state.phase = "committed";
        },
        discard(this: SchemaRegistrationScopeV1): void {
          if (this !== scope) deny("INVALID_OWNER");
          state.phase = "discarded";
        },
      });
      return scope;
    },
    assertCodec(
      this: CredentialSchemaRegistryV1,
      codec: unknown,
      expected: SchemaBinding,
    ): asserts codec is RegisteredSchemaCodec {
      if (this !== registry) deny("INVALID_OWNER");
      const state = codec && typeof codec === "object" ? codecs.get(codec) : undefined;
      if (!state) deny("INVALID_CODEC");
      active(state);
      if (state.scope.busy) deny("INVALID_SCOPE");
      try {
        if (canonical(expected).canonicalJson !== state.bindingKey) deny();
      } catch {
        deny("INVALID_CODEC");
      }
    },
  });
  return registry;
}
