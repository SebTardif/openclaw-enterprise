import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, mock } from "node:test";
import { types } from "node:util";
import {
  CREDENTIAL_SCHEMA_PRIMITIVES_V1,
  INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1,
} from "../../packages/occ/src/credential-broker-v1/schema-primitives.ts";
const admittedPrimitives = INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1;
const primitives = CREDENTIAL_SCHEMA_PRIMITIVES_V1;
// Isolated fault substitution changes only the internal installed canonicalizer.
// The actual compiler, Ajv, JSON encoder and registry remain in use.
const installed = await import("../../packages/occ/src/credential-broker-v1/schema-primitives.ts");
let selectedHook;
mock.module(
  new URL("../../packages/occ/src/credential-broker-v1/schema-primitives.ts", import.meta.url).href,
  {
    namedExports: {
      ...installed,
      selectSchemaCanonicalizationV1(ref, admitted) {
        const real = installed.selectSchemaCanonicalizationV1(ref, admitted);
        const captured = selectedHook;
        return captured ? (candidate) => captured(candidate) : real;
      },
    },
  },
);
const actualAdmission =
  await import("../../packages/occ/src/credential-broker-v1/schema-admission.ts");
const actualRegistry =
  await import("../../packages/occ/src/credential-broker-v1/schema-registry.ts");
function compileSchemaRegistrationV1(input) {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Reflect.ownKeys(input).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable;
    })
  )
    return actualAdmission.compileSchemaRegistrationV1(input, admittedPrimitives);
  const { validateAndCanonicalize, ...data } = input;
  if (typeof validateAndCanonicalize !== "function")
    return actualAdmission.compileSchemaRegistrationV1(input, admittedPrimitives);
  selectedHook = validateAndCanonicalize;
  try {
    return actualAdmission.compileSchemaRegistrationV1(data, admittedPrimitives);
  } finally {
    selectedHook = undefined;
  }
}

// Independent encoding for ordinary test vectors, rather than the production encoder.
const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? "[" + value.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
          .join(",") +
        "}";
const definition = {
  backendId: "github",
  recipeId: "example-recipe",
  recipeVersion: 1,
  recipeDigest: "sha256:" + "a".repeat(64),
  contractVersion: "credential-backend-recipe-v1",
  interpreter: primitives.interpreter,
};
const digest = (jsonSchema, maxBytes, maxDepth) =>
  "sha256:" +
  createHash("sha256")
    .update(
      "oce-schema-recipe-v1\0" +
        canonical({
          canonicalization: primitives.canonicalization,
          profile: "oce-closed-draft7-v1",
          jsonSchema,
          maxBytes,
          maxDepth,
        }),
    )
    .digest("hex");
const registration = (jsonSchema, overrides = {}) => {
  const maxBytes = overrides.maxBytes ?? 1024;
  const maxDepth = overrides.maxDepth ?? 8;
  return {
    binding: {
      definition: { ...definition },
      role: "operation",
      schema: {
        namespace: "github",
        name: "facts",
        version: 1,
        digest: digest(jsonSchema, maxBytes, maxDepth),
      },
    },
    jsonSchema,
    maxBytes,
    maxDepth,
    canonicalization: primitives.canonicalization,
    validateAndCanonicalize: (candidate) => candidate,
    ...overrides,
  };
};
const objectSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 5 },
    count: { type: "integer", minimum: 1, maximum: 3 },
    items: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 },
  },
  required: ["name", "count", "items"],
  additionalProperties: false,
};
const schemaDenied = (value) =>
  assert.throws(() => compileSchemaRegistrationV1(value), /^Error: INVALID_SCHEMA$/);
const valueDenied = (compiled, value) =>
  assert.throws(() => compiled.assertValid(value), /^Error: INVALID_VALUE$/);

test("real Ajv evaluates the admitted closed draft-07 object and nested bounds", () => {
  const compiled = compileSchemaRegistrationV1(
    registration({ $schema: "http://json-schema.org/draft-07/schema#", ...objectSchema }),
  );
  compiled.assertValid({ name: "ok", count: 2, items: [true] });
  for (const value of [
    { name: "", count: 2, items: [true] },
    { name: "longer", count: 2, items: [true] },
    { name: "ok", count: 2.5, items: [true] },
    { name: "ok", count: 4, items: [true] },
    { name: "ok", count: "2", items: [true] },
    { name: "ok", count: 2, items: [] },
    { name: "ok", count: 2, items: [true, false, true] },
    { name: "ok", count: 2, items: [1] },
    { name: "ok", count: 2 },
    { name: "ok", count: 2, items: [true], extra: 1 },
  ])
    valueDenied(compiled, value);
});

test("scalar const, enum, null and exclusive numeric bounds are evaluated", () => {
  for (const [schema, good, bad] of [
    [{ type: "string", maxLength: 5, enum: ["yes", "no"] }, "yes", "other"],
    [{ type: "integer", const: 2 }, 2, 3],
    [{ type: "number", exclusiveMinimum: 1, exclusiveMaximum: 3 }, 2, 1],
    [{ type: "null" }, null, false],
  ]) {
    const compiled = compileSchemaRegistrationV1(registration(schema));
    compiled.assertValid(good);
    valueDenied(compiled, bad);
  }
});

test("unsupported, reference, async and unbounded schemas deny without hooks", () => {
  let calls = 0;
  for (const schema of [
    true,
    {},
    { type: ["string", "null"] },
    { type: "string" },
    { type: "array", items: { type: "boolean" } },
    { type: "object", properties: {} },
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: false, required: ["missing"] },
    { type: "array", maxItems: 2, items: [{ type: "boolean" }] },
    { type: "array", maxItems: 1025, items: { type: "boolean" } },
    { type: "string", maxLength: 65537 },
    { type: "number", minimum: "1" },
    { type: "boolean", enum: [] },
    ...[
      "$ref",
      "$id",
      "$async",
      "$defs",
      "definitions",
      "format",
      "pattern",
      "default",
      "allOf",
      "anyOf",
      "not",
      "if",
      "unevaluatedProperties",
    ].map((key) => ({ type: "boolean", [key]: true })),
    { $schema: "https://json-schema.org/draft/2020-12/schema", type: "boolean" },
    {
      type: "array",
      maxItems: 1,
      items: { $schema: "http://json-schema.org/draft-07/schema#", type: "boolean" },
    },
  ])
    schemaDenied(
      registration(schema, {
        validateAndCanonicalize() {
          calls++;
          return null;
        },
      }),
    );
  assert.equal(calls, 0);
});

test("schema, binding, limits and hook capture resist subsequent mutation", () => {
  const input = registration({ type: "integer", minimum: 1, maximum: 2 });
  const compiled = compileSchemaRegistrationV1(input);
  input.jsonSchema.maximum = 99;
  input.binding.schema.name = "changed";
  input.binding.definition.backendId = "other";
  input.maxBytes = 1;
  input.validateAndCanonicalize = () => {
    throw new Error("private");
  };
  compiled.assertValid(2);
  valueDenied(compiled, 3);
  assert.equal(compiled.binding.schema.name, "facts");
  assert.equal(compiled.binding.definition.backendId, "github");
  assert.equal(compiled.maxBytes, 1024);
  assert.equal(compiled.validateAndCanonicalize(2), 2);
  for (const value of [
    compiled,
    compiled.jsonSchema,
    compiled.binding,
    compiled.binding.schema,
    compiled.binding.definition,
  ])
    assert.ok(Object.isFrozen(value));
});

test("exact canonical domain digest binds schema and both declared limits", () => {
  const input = registration({ type: "boolean" });
  assert.equal(
    input.binding.schema.digest,
    "sha256:" +
      createHash("sha256")
        .update(
          "oce-schema-recipe-v1\0" +
            '{"canonicalization":' +
            canonical(primitives.canonicalization) +
            ',"jsonSchema":{"type":"boolean"},"maxBytes":1024,"maxDepth":8,"profile":"oce-closed-draft7-v1"}',
        )
        .digest("hex"),
  );
  compileSchemaRegistrationV1(input);
  for (const change of [
    (value) => value.maxBytes++,
    (value) => value.maxDepth++,
    (value) => (value.jsonSchema.title = "changed"),
    (value) => (value.binding.schema.digest = value.binding.schema.digest.toUpperCase()),
    (value) => (value.binding.schema.digest = "sha256:" + "0".repeat(64)),
  ]) {
    const value = registration({ type: "boolean" });
    change(value);
    schemaDenied(value);
  }
});

test("invalid identity, limits and non-JSON input fail before accessor or hook effects", () => {
  let calls = 0;
  const input = registration({ type: "boolean" });
  const getter = Object.defineProperty({ ...input }, "jsonSchema", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("private");
    },
  });
  const proxy = new Proxy(input, {
    getPrototypeOf() {
      calls++;
      return Object.prototype;
    },
  });
  const malformed = Object.defineProperty({ type: "boolean" }, "title", {
    enumerable: true,
    get() {
      calls++;
      return "private";
    },
  });
  schemaDenied(getter);
  schemaDenied(proxy);
  schemaDenied({ ...input, jsonSchema: malformed });
  for (const patch of [
    { maxBytes: 0 },
    { maxBytes: 65537 },
    { maxBytes: 1.5 },
    { maxDepth: 0 },
    { maxDepth: 33 },
    { maxDepth: NaN },
    { validateAndCanonicalize: null },
  ])
    schemaDenied({ ...input, ...patch });
  for (const change of [
    (value) => (value.binding.role = "unknown"),
    (value) => (value.binding.schema.version = 0),
    (value) => (value.binding.schema.name = ""),
    (value) => (value.binding.definition.contractVersion = "other"),
    (value) => (value.binding.definition.backendId = "x".repeat(257)),
    (value) => (value.binding.schema.extra = true),
  ]) {
    const value = registration({ type: "boolean" });
    change(value);
    schemaDenied(value);
  }
  assert.equal(calls, 0);
  const compiled = compileSchemaRegistrationV1(
    registration({ type: "string", maxLength: 100 }, { maxBytes: 4, maxDepth: 1 }),
  );
  compiled.assertValid("é");
  valueDenied(compiled, "éé");
  valueDenied(compiled, undefined);
  valueDenied(compiled, new String("x"));
  const throwing = compileSchemaRegistrationV1(
    registration(
      { type: "boolean" },
      {
        validateAndCanonicalize() {
          throw new Error("private token");
        },
      },
    ),
  );
  assert.throws(() => throwing.validateAndCanonicalize(true), /^Error: INVALID_VALUE$/);
});

test("schema byte, nesting and node caps deny before compilation or hooks", () => {
  schemaDenied(registration({ type: "boolean", description: "x".repeat(65536) }));
  let nested = { type: "boolean" };
  for (let index = 0; index < 33; index++) nested = { type: "array", maxItems: 1, items: nested };
  schemaDenied(registration(nested));
  const properties = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => ["p" + index, { type: "boolean" }]),
  );
  schemaDenied(registration({ type: "object", properties, additionalProperties: false }));
});

test("hook receives a bounded frozen copy and its output repeats JSON and Ajv checks", () => {
  let calls = 0;
  const input = { name: "ok", count: 2, items: [true] };
  const compiled = compileSchemaRegistrationV1(
    registration(objectSchema, {
      validateAndCanonicalize(candidate) {
        calls++;
        assert.ok(Object.isFrozen(candidate));
        assert.ok(Object.isFrozen(candidate.items));
        assert.notEqual(candidate, input);
        return { ...candidate, count: 3 };
      },
    }),
  );
  const output = compiled.validateAndCanonicalize(input);
  assert.equal(output.count, 3);
  assert.equal(input.count, 2);
  assert.ok(Object.isFrozen(output));
  assert.throws(
    () => compiled.validateAndCanonicalize({ ...input, count: 9 }),
    /^Error: INVALID_VALUE$/,
  );
  assert.equal(calls, 1);
  for (const invalid of [
    { ...input, count: 9 },
    { ...input, extra: 1 },
    { ...input, count: Infinity },
    undefined,
  ]) {
    const post = compileSchemaRegistrationV1(
      registration(objectSchema, { validateAndCanonicalize: () => invalid }),
    );
    assert.throws(() => post.validateAndCanonicalize(input), /^Error: INVALID_VALUE$/);
  }
  const bytes = compileSchemaRegistrationV1(
    registration(
      { type: "string", maxLength: 100 },
      { maxBytes: 4, validateAndCanonicalize: () => "éé" },
    ),
  );
  assert.throws(() => bytes.validateAndCanonicalize("é"), /^Error: INVALID_VALUE$/);
});

// Own __proto__ keys must survive construction; object-literal setter syntax would
// miss the Ajv property-validation gap at the eight/nine ordinary-field boundary.
const ordinaryProperties = (count) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => ["p" + index, { type: "boolean" }]),
  );
const ordinaryValue = (count) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => ["p" + index, true]));
const placeSchema = (leaf, placement) => {
  if (placement === "root") return leaf;
  return {
    type: "object",
    properties: {
      payload: placement === "nested-object" ? leaf : { type: "array", items: leaf, maxItems: 1 },
    },
    required: ["payload"],
    additionalProperties: false,
  };
};
const placeValue = (leaf, placement) =>
  placement === "root" ? leaf : { payload: placement === "nested-object" ? leaf : [leaf] };

for (const count of [8, 9]) {
  for (const required of [false, true]) {
    for (const placement of ["root", "nested-object", "array-item-object"]) {
      const label = `${placement}, ${count} ordinary fields, ${required ? "required" : "optional"}`;
      const properties = ordinaryProperties(count);
      const leaf = {
        type: "object",
        properties,
        ...(required ? { required: Object.keys(properties) } : {}),
        additionalProperties: false,
      };
      const schema = placeSchema(leaf, placement);
      const good = placeValue(ordinaryValue(count), placement);
      // JSON.parse creates a real own data property, including at nested nodes.
      const invalidLeaf = JSON.parse(
        canonical({ ...ordinaryValue(count), ["__proto__"]: "INVALID-STRING" }),
      );
      const invalid = placeValue(invalidLeaf, placement);

      test(`schema admission rejects declared own __proto__ before hooks: ${label}`, () => {
        let calls = 0;
        const forbiddenProperties = Object.fromEntries([
          ...Object.entries(properties),
          ["__proto__", { type: "integer", minimum: 1 }],
        ]);
        const forbidden = placeSchema(
          {
            ...leaf,
            properties: forbiddenProperties,
            ...(required ? { required: Object.keys(forbiddenProperties) } : {}),
          },
          placement,
        );
        assert.ok(Object.hasOwn(forbiddenProperties, "__proto__"));
        schemaDenied(
          registration(forbidden, {
            validateAndCanonicalize(candidate) {
              calls++;
              return candidate;
            },
          }),
        );
        assert.equal(calls, 0);
      });

      test(`closed-schema input rejects own __proto__ through both APIs before hooks: ${label}`, () => {
        let calls = 0;
        const compiled = compileSchemaRegistrationV1(
          registration(schema, {
            validateAndCanonicalize(candidate) {
              calls++;
              return candidate;
            },
          }),
        );
        compiled.assertValid(good);
        assert.equal(calls, 0);
        assert.equal(canonical(compiled.validateAndCanonicalize(good)), canonical(good));
        assert.equal(calls, 1);
        calls = 0;
        assert.ok(Object.hasOwn(invalidLeaf, "__proto__"));
        valueDenied(compiled, invalid);
        assert.equal(calls, 0);
        assert.throws(() => compiled.validateAndCanonicalize(invalid), /^Error: INVALID_VALUE$/);
        assert.equal(calls, 0);
      });

      test(`closed-schema hook output rejects injected own __proto__ after one hook: ${label}`, () => {
        let calls = 0;
        let output = good;
        const compiled = compileSchemaRegistrationV1(
          registration(schema, {
            validateAndCanonicalize() {
              calls++;
              return output;
            },
          }),
        );
        compiled.assertValid(good);
        assert.equal(calls, 0);
        assert.equal(canonical(compiled.validateAndCanonicalize(good)), canonical(good));
        assert.equal(calls, 1);
        calls = 0;
        output = invalid;
        assert.throws(() => compiled.validateAndCanonicalize(good), /^Error: INVALID_VALUE$/);
        assert.equal(calls, 1);
      });
    }
  }
}

const registryDefinition = { ...definition, backendId: "fault-registry" };
function registryInput(hook, name = "configuration", maxBytes = 128) {
  const input = registration({ type: "string", maxLength: 32 }, { maxBytes, maxDepth: 32 });
  input.binding.definition = registryDefinition;
  input.binding.role = "configuration";
  input.binding.schema.name = name;
  return { input, hook };
}
function registerFault(scope, hook, name) {
  const { input } = registryInput(hook, name);
  delete input.validateAndCanonicalize;
  selectedHook = hook;
  try {
    return scope.schemas.register(input);
  } finally {
    selectedHook = undefined;
  }
}
function faultSetup(hook) {
  const registry = actualRegistry.createCredentialSchemaRegistryV1([registryDefinition], {
    admittedPrimitives,
  });
  const scope = registry.begin(registryDefinition);
  const codec = registerFault(scope, hook);
  scope.commit();
  return { registry, scope, codec };
}
const denied = (run, code) => assert.throws(run, new RegExp("^Error: " + code + "$"));
test("trusted-code faults: Ajv precheck, invalid post-output and private throw are contained", () => {
  let calls = 0;
  const a = faultSetup((value) => {
    calls++;
    return value;
  });
  denied(() => a.codec.validate(123), "INVALID_VALUE");
  denied(() => a.codec.validate("x".repeat(33)), "INVALID_VALUE");
  assert.equal(calls, 0);
  assert.equal(a.codec.retain(a.codec.validate("hello")).canonicalJson, '"hello"');
  const b = faultSetup(() => {
    calls++;
    return 123;
  });
  denied(() => b.codec.validate("hello"), "INVALID_VALUE");
  assert.equal(calls, 2);
  const c = faultSetup(() => {
    throw new Error("private-hook-content");
  });
  denied(() => c.codec.validate("hello"), "INVALID_VALUE");
});
test("trusted-code faults: non-idempotent canonicalization refuses restore", () => {
  const { codec } = faultSetup((value) => value + "x");
  const saved = codec.retain(codec.validate("a"));
  assert.equal(saved.canonicalJson, '"ax"');
  denied(() => codec.restore(saved), "INVALID_VALUE");
});
test("trusted-code faults: same-codec reentry, commit reentry and validate-time discard", () => {
  let codec,
    scope,
    revoke = false,
    nested = 0;
  const a = faultSetup((value) => {
    denied(() => codec.validate(value), "INVALID_SCOPE");
    denied(() => scope.commit(), "INVALID_SCOPE");
    nested++;
    if (revoke) scope.discard();
    return value;
  });
  codec = a.codec;
  scope = a.scope;
  const old = codec.validate("hello"),
    saved = codec.retain(old);
  assert.equal(nested, 1);
  revoke = true;
  denied(() => codec.validate("hello"), "INVALID_CODEC");
  denied(() => codec.retain(old), "INVALID_CODEC");
  denied(() => codec.restore(saved), "INVALID_CODEC");
  scope.discard();
});
test("trusted-code faults: cross-codec reentry and restore-time discard revoke every handle", () => {
  const registry = actualRegistry.createCredentialSchemaRegistryV1([registryDefinition], {
    admittedPrimitives,
  });
  const scope = registry.begin(registryDefinition);
  let other,
    revoke = false,
    calls = 0;
  const first = registerFault(scope, (value) => {
    calls++;
    denied(() => other.validate(value), "INVALID_SCOPE");
    if (revoke) scope.discard();
    return value;
  });
  other = registerFault(scope, undefined, "other");
  scope.commit();
  const old = first.validate("hello"),
    saved = first.retain(old),
    otherOld = other.validate("other");
  revoke = true;
  denied(() => first.restore(saved), "INVALID_VALUE");
  assert.equal(calls, 2);
  denied(() => first.retain(old), "INVALID_CODEC");
  denied(() => other.retain(otherOld), "INVALID_CODEC");
});
