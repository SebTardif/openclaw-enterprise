import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CREDENTIAL_SCHEMA_PRIMITIVES_V1,
  INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1,
} from "../../packages/occ/src/credential-broker-v1/schema-primitives.ts";
import { compileSchemaRegistrationV1 as actualCompile } from "../../packages/occ/src/credential-broker-v1/schema-admission.ts";

import {
  canonical,
  definitionFor,
  schemaRecipe as registration,
  objectSchema,
  protoCases,
  schemaDigest,
} from "../helpers/credential-schema.mjs";

const admittedPrimitives = INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1;
const primitives = CREDENTIAL_SCHEMA_PRIMITIVES_V1;

const compileSchemaRegistrationV1 = (input) => actualCompile(input, admittedPrimitives);

const definition = definitionFor();
const schemaDenied = (value) =>
  assert.throws(() => compileSchemaRegistrationV1(value), /^Error: INVALID_SCHEMA$/);
const valueDenied = (compiled, value) =>
  assert.throws(() => compiled.validate(value), /^Error: INVALID_VALUE$/);

test("real Ajv evaluates closed draft-07 schema cases", async (t) => {
  const cases = [
    {
      name: "closed object and nested bounds",
      schema: { $schema: "http://json-schema.org/draft-07/schema#", ...objectSchema },
      accepts: { name: "ok", count: 2, items: [true] },
      rejects: {
        "minimum string length": { name: "", count: 2, items: [true] },
        "maximum string length": { name: "longer", count: 2, items: [true] },
        "integer type": { name: "ok", count: 2.5, items: [true] },
        "numeric maximum": { name: "ok", count: 4, items: [true] },
        "no type coercion": { name: "ok", count: "2", items: [true] },
        "minimum items": { name: "ok", count: 2, items: [] },
        "maximum items": { name: "ok", count: 2, items: [true, false, true] },
        "item type": { name: "ok", count: 2, items: [1] },
        "required property": { name: "ok", count: 2 },
        "additional property": { name: "ok", count: 2, items: [true], extra: 1 },
      },
    },
    {
      name: "enum",
      schema: { type: "string", maxLength: 5, enum: ["yes", "no"] },
      accepts: "yes",
      rejects: { "outside enum": "other" },
    },
    {
      name: "const",
      schema: { type: "integer", const: 2 },
      accepts: 2,
      rejects: { "different constant": 3 },
    },
    {
      name: "exclusive bounds",
      schema: { type: "number", exclusiveMinimum: 1, exclusiveMaximum: 3 },
      accepts: 2,
      rejects: { "exclusive minimum": 1 },
    },
    { name: "null", schema: { type: "null" }, accepts: null, rejects: { "wrong type": false } },
  ];
  for (const { name, schema, accepts, rejects } of cases)
    await t.test(name, async (t) => {
      const compiled = compileSchemaRegistrationV1(registration(schema));
      const result = compiled.validate(accepts);
      assert.equal(canonical(result.value), canonical(accepts));
      assert.equal(result.canonicalJson, canonical(accepts));
      for (const [reason, value] of Object.entries(rejects))
        await t.test(reason, () => valueDenied(compiled, value));
    });
});

test("unsupported, reference, async and unbounded schemas deny at admission", () => {
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
    schemaDenied(registration(schema));
});

test("schema, binding, limits and primitive capture resist subsequent mutation", () => {
  const input = registration({ type: "integer", minimum: 1, maximum: 2 });
  const compiled = compileSchemaRegistrationV1(input);
  input.jsonSchema.maximum = 99;
  input.binding.schema.name = "changed";
  input.binding.definition.backendId = "other";
  input.maxBytes = 1;
  input.canonicalization = { ...primitives.canonicalization, digest: "sha256:" + "0".repeat(64) };
  valueDenied(compiled, 3);
  assert.equal(compiled.binding.schema.name, "facts");
  assert.equal(compiled.binding.definition.backendId, "github");
  assert.equal(compiled.maxBytes, 1024);
  assert.equal(compiled.validate(2).value, 2);
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

test("invalid identity, limits and non-JSON input fail before accessor or proxy effects", () => {
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
  assert.equal(compiled.validate("é").canonicalJson, '"é"');
  valueDenied(compiled, "éé");
  valueDenied(compiled, undefined);
  valueDenied(compiled, new String("x"));
});

test("schema byte, nesting and node caps deny before compilation", () => {
  schemaDenied(registration({ type: "boolean", description: "x".repeat(65536) }));
  let nested = { type: "boolean" };
  for (let index = 0; index < 33; index++) nested = { type: "array", maxItems: 1, items: nested };
  schemaDenied(registration(nested));
  const properties = Object.fromEntries(
    Array.from({ length: 1024 }, (_, index) => ["p" + index, { type: "boolean" }]),
  );
  schemaDenied(registration({ type: "object", properties, additionalProperties: false }));
});

test("real Ajv evaluator returns immutable matching value and canonical bytes", () => {
  const input = { name: "ok", count: 2, items: [true] };
  const compiled = compileSchemaRegistrationV1(registration(objectSchema));
  const output = compiled.validate(input);
  assert.notEqual(output.value, input);
  assert.notEqual(output.value.items, input.items);
  for (const value of [output, output.value, output.value.items]) assert.ok(Object.isFrozen(value));
  // Later caller mutation cannot change either half of the admitted snapshot.
  input.count = 3;
  input.items[0] = false;
  const expected = '{"count":2,"items":[true],"name":"ok"}';
  assert.equal(canonical(output.value), expected);
  assert.equal(output.canonicalJson, expected);
  valueDenied(compiled, { ...input, count: 9 });
});

test("own __proto__ is denied before interpretation", async (t) => {
  for (const {
    name,
    schema,
    forbidden,
    forbiddenProperties,
    good,
    invalid,
    invalidLeaf,
  } of protoCases()) {
    await t.test(name, () => {
      assert.ok(Object.hasOwn(forbiddenProperties, "__proto__"));
      schemaDenied(registration(forbidden));
      const compiled = compileSchemaRegistrationV1(registration(schema));
      const result = compiled.validate(good);
      assert.equal(canonical(result.value), canonical(good));
      assert.equal(result.canonicalJson, canonical(good));
      assert.ok(Object.hasOwn(invalidLeaf, "__proto__"));
      valueDenied(compiled, invalid);
    });
  }
});

// These direct checks protect the compiler boundary independently of registry admission.
test("actual admission refuses wrong primitive identities/kinds or missing core admission", () => {
  const schema = { type: "boolean" };
  const bindDigest = (input) => {
    input.binding.schema.digest = schemaDigest(
      input.jsonSchema,
      input.maxBytes,
      input.maxDepth,
      input.canonicalization,
    );
  };
  for (const target of ["interpreter", "canonicalization"]) {
    const good = registration(schema);
    assert.equal(compileSchemaRegistrationV1(good).validate(true).value, true);
    for (const patch of [
      { name: "not-installed" },
      { version: 2 },
      { digest: "sha256:" + "b".repeat(64) },
      target === "interpreter" ? primitives.canonicalization : primitives.interpreter,
    ]) {
      const input = registration(schema);
      if (target === "interpreter")
        input.binding.definition = {
          ...definition,
          interpreter: { ...primitives.interpreter, ...patch },
        };
      else input.canonicalization = { ...primitives.canonicalization, ...patch };
      // Primitive guard receives an otherwise valid current schema digest.
      bindDigest(input);
      schemaDenied(input);
      assert.equal(compileSchemaRegistrationV1(registration(schema)).validate(false).value, false);
    }
  }
  for (const refs of [[], [primitives.interpreter], [primitives.canonicalization]])
    assert.throws(() => actualCompile(registration(schema), refs), /^Error: INVALID_SCHEMA$/);
});
test("actual admission refuses executable and hostile registration/ref fields without invocation", () => {
  let effects = 0;
  const hook = () => {
    effects++;
    return true;
  };
  const good = registration({ type: "boolean" });
  const bad = [
    ...["validateAndCanonicalize", "factory", "resolver", "implementation"].map((key) => ({
      ...good,
      [key]: hook,
    })),
    Object.defineProperty({ ...good }, "hidden", { value: hook }),
    { ...good, [Symbol("extra")]: hook },
    Object.defineProperty({ ...good }, "canonicalization", { enumerable: true, get: hook }),
    new Proxy(good, { getPrototypeOf: hook, ownKeys: hook, get: hook }),
    {
      ...good,
      canonicalization: new Proxy(primitives.canonicalization, { get: hook, ownKeys: hook }),
    },
    {
      ...good,
      canonicalization: Object.defineProperty({ ...primitives.canonicalization }, "digest", {
        enumerable: true,
        get: hook,
      }),
    },
  ];
  for (const input of bad) {
    schemaDenied(input);
    assert.equal(
      compileSchemaRegistrationV1(registration({ type: "boolean" })).validate(true).value,
      true,
    );
  }
  assert.equal(effects, 0);
});
