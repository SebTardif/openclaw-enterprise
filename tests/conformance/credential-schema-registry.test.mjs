import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCredentialSchemaRegistryV1 } from "../../packages/occ/src/credential-broker-v1/schema-registry.ts";
import {
  CREDENTIAL_SCHEMA_PRIMITIVES_V1 as primitives,
  INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1 as admittedPrimitives,
} from "../../packages/occ/src/credential-broker-v1/schema-primitives.ts";
import { CORE_SCHEMA_PRIMITIVE_MANIFEST_V1 } from "../../packages/occ/src/credential-broker-v1/schema-primitive-manifest.ts";
import {
  canonical,
  digest,
  schemaDigest,
  definitionFor,
  schemaRecipe,
  retainedDigest,
} from "../helpers/credential-schema.mjs";
const definition = definitionFor("example");
const registration = (maxBytes = 128, maxLength = 32) =>
  schemaRecipe(
    { type: "string", maxLength },
    { definition, role: "configuration", name: "configuration", maxBytes, maxDepth: 32 },
  );
function registryFor(definitions = [definition], refs = admittedPrimitives) {
  return createCredentialSchemaRegistryV1(definitions, { admittedPrimitives: refs });
}
function setup(maxBytes, maxLength) {
  const registry = registryFor(),
    scope = registry.begin(definition),
    input = registration(maxBytes, maxLength),
    codec = scope.schemas.register(input);
  scope.commit();
  return { registry, scope, codec, input };
}
const denied = (run, code) =>
  assert.throws(run, code ? new RegExp("^Error: " + code + "$") : /^Error: INVALID_[A-Z]+$/);

test("real installed compiler/Ajv/canonical lifecycle binds independent schema and retained vectors", () => {
  const { registry, codec, input } = setup();
  registry.assertCodec(codec, input.binding);
  const value = codec.validate("hello"),
    saved = codec.retain(value);
  assert.equal(saved.canonicalJson, '"hello"');
  assert.equal(
    input.binding.schema.digest,
    digest(
      "oce-schema-recipe-v1",
      '{"canonicalization":' +
        canonical(primitives.canonicalization) +
        ',"jsonSchema":{"maxLength":32,"type":"string"},"maxBytes":128,"maxDepth":32,"profile":"oce-closed-draft7-v1"}',
    ),
  );
  assert.equal(saved.digest, retainedDigest(input.binding, '"hello"'));
  const restored = codec.restore(saved);
  assert.notEqual(restored, value);
  assert.deepEqual(codec.retain(restored), saved);
  assert.notEqual(codec.retain(value).definition, saved.definition);
  for (const v of [
    codec,
    codec.binding,
    codec.binding.schema,
    codec.binding.definition,
    codec.binding.definition.interpreter,
    value,
    saved,
    saved.definition,
    saved.schema,
  ])
    assert.ok(Object.isFrozen(v));
  assert.throws(() => {
    saved.schema.version = 2;
  }, TypeError);
});

test("foreign registries/codecs, cloned handles and every definition/schema/role mismatch deny", () => {
  const a = setup(),
    b = setup(),
    value = a.codec.validate("hello"),
    foreign = b.codec.validate("hello"),
    saved = a.codec.retain(value);
  denied(() => a.codec.retain(foreign));
  denied(() => a.codec.retain({ ...value }));
  denied(() => a.registry.assertCodec(b.codec, b.input.binding));
  denied(() => a.registry.assertCodec({ ...a.codec }, a.input.binding));
  for (const key of Object.keys(definition)) {
    const binding = structuredClone(a.input.binding);
    binding.definition[key] =
      key === "interpreter"
        ? { ...primitives.interpreter, digest: "sha256:" + "0".repeat(64) }
        : key === "recipeVersion"
          ? 2
          : binding.definition[key] + "-other";
    denied(() => a.registry.assertCodec(a.codec, binding));
    denied(() => a.codec.restore({ ...saved, definition: binding.definition }));
  }
  for (const key of ["name", "version", "digest"]) {
    const binding = structuredClone(a.input.binding);
    binding.definition.interpreter[key] = key === "version" ? 2 : "other";
    denied(() => a.registry.assertCodec(a.codec, binding));
    denied(() => a.codec.restore({ ...saved, definition: binding.definition }));
  }
  for (const key of ["namespace", "name", "version", "digest"]) {
    const binding = structuredClone(a.input.binding);
    binding.schema[key] = key === "version" ? 2 : "other";
    denied(() => a.registry.assertCodec(a.codec, binding));
    denied(() => a.codec.restore({ ...saved, schema: binding.schema }));
  }
  denied(() => a.registry.assertCodec(a.codec, { ...a.input.binding, role: "evidence" }));
  denied(() => a.codec.restore({ ...saved, role: "evidence" }));
  const same = registryFor(),
    scope = same.begin(definition),
    first = scope.schemas.register(registration()),
    otherInput = registration();
  otherInput.binding.schema.name = "other";
  const other = scope.schemas.register(otherInput);
  scope.commit();
  denied(() => first.retain(other.validate("hello")));
});

test("borrowed registry/scope/owner/codec receivers refuse without changing the owner", () => {
  const a = setup(),
    b = setup(),
    value = a.codec.validate("hello"),
    saved = a.codec.retain(value);
  denied(() => a.registry.begin.call(b.registry, definition), "INVALID_OWNER");
  denied(() => a.registry.assertCodec.call(b.registry, a.codec, a.input.binding), "INVALID_OWNER");
  denied(() => a.scope.commit.call(b.scope), "INVALID_OWNER");
  denied(() => a.scope.discard.call(b.scope), "INVALID_OWNER");
  denied(() => a.scope.schemas.register.call(b.scope.schemas, registration()), "INVALID_OWNER");
  denied(() => a.codec.validate.call(b.codec, "hello"), "INVALID_CODEC");
  denied(() => a.codec.retain.call(b.codec, value), "INVALID_CODEC");
  denied(() => a.codec.restore.call(b.codec, saved), "INVALID_CODEC");
  assert.deepEqual(a.codec.retain(a.codec.restore(saved)), saved);
});

test("pending use, duplicate tuples, once-only commit and permanent idempotent discard", () => {
  const registry = registryFor();
  denied(() => registry.begin({ ...definition, backendId: "unknown" }));
  const scope = registry.begin({ ...definition });
  denied(() => registry.begin(definition));
  const input = registration(),
    codec = scope.schemas.register(input),
    otherInput = registration();
  otherInput.binding.schema.name = "other";
  const other = scope.schemas.register(otherInput);
  denied(() => scope.schemas.register(registration()));
  denied(() => scope.schemas.register(registration(128, 31)));
  denied(() => codec.validate("hello"), "INVALID_CODEC");
  denied(() => registry.assertCodec(codec, input.binding), "INVALID_CODEC");
  scope.commit();
  denied(() => scope.commit(), "INVALID_SCOPE");
  denied(() => scope.schemas.register(input), "INVALID_SCOPE");
  const value = codec.validate("hello"),
    saved = codec.retain(value),
    otherValue = other.validate("other"),
    otherSaved = other.retain(otherValue);
  // Discard revokes every codec and previously issued handle in the scope.
  scope.discard();
  scope.discard();
  for (const [current, binding, handle, retained] of [
    [codec, input.binding, value, saved],
    [other, otherInput.binding, otherValue, otherSaved],
  ]) {
    denied(() => registry.assertCodec(current, binding), "INVALID_CODEC");
    denied(() => current.validate("hello"), "INVALID_CODEC");
    denied(() => current.retain(handle), "INVALID_CODEC");
    denied(() => current.restore(retained), "INVALID_CODEC");
  }
  denied(() => scope.commit(), "INVALID_SCOPE");
  denied(() => scope.schemas.register(input), "INVALID_SCOPE");
  denied(() => registry.begin(definition), "INVALID_DEFINITION");
  const pending = registryFor().begin(definition);
  pending.discard();
  pending.discard();
  denied(() => pending.commit());
  denied(() => pending.schemas.register(input));
});

test("constructor/registration mutation cannot replace admitted definitions/primitives/schema/limits", () => {
  const definitions = [structuredClone(definition)],
    refs = structuredClone(admittedPrimitives),
    options = { admittedPrimitives: refs };
  const registry = createCredentialSchemaRegistryV1(definitions, options);
  definitions[0].recipeDigest = "changed";
  refs[0].digest = "changed";
  options.admittedPrimitives = [];
  const scope = registry.begin(definition),
    input = registration(),
    codec = scope.schemas.register(input);
  input.jsonSchema.type = "number";
  input.maxBytes = 1;
  input.maxDepth = 1;
  input.binding.definition.backendId = "changed";
  input.binding.definition.interpreter.digest = "changed";
  input.canonicalization = { name: "untrusted", version: 1, digest: "sha256:" + "0".repeat(64) };
  scope.commit();
  assert.equal(codec.retain(codec.validate("hello")).canonicalJson, '"hello"');
  denied(() => codec.validate(123), "INVALID_VALUE");
  denied(() => codec.validate("x".repeat(33)), "INVALID_VALUE");
});

test("strict restore checks exact envelope, valid digest, canonical text and schema", () => {
  const { codec, input } = setup(),
    saved = codec.retain(codec.validate("hello"));
  for (const key of Object.keys(saved)) {
    const missing = { ...saved };
    delete missing[key];
    denied(() => codec.restore(missing), "INVALID_VALUE");
  }
  denied(() => codec.restore({ ...saved, extra: true }), "INVALID_VALUE");
  denied(() => codec.restore({ ...saved, digest: "sha256:" + "0".repeat(64) }), "INVALID_VALUE");
  for (const text of [' "hello"', '"hello" ', '"\\u0068ello"', "{", '"' + "x".repeat(33) + '"'])
    denied(
      () =>
        codec.restore({
          ...saved,
          canonicalJson: text,
          digest: retainedDigest(input.binding, text),
        }),
      "INVALID_VALUE",
    );
  assert.deepEqual(codec.retain(codec.restore(saved)), saved);
});

test("schema-valid retained text reaches the canonical guard", async (t) => {
  const cases = [
    {
      name: "object spelling",
      schema: {
        type: "object",
        properties: { a: { type: "integer" }, z: { type: "integer" } },
        required: ["a", "z"],
        additionalProperties: false,
      },
      accepts: { a: 1, z: 1 },
      rejects: {
        "duplicate key": '{"a":1,"a":1,"z":1}',
        "key order": '{"z":1,"a":1}',
        "trailing space": '{"a":1,"z":1} ',
        "escaped key": '{"\\u0061":1,"z":1}',
      },
    },
    {
      name: "zero spelling",
      schema: { type: "number" },
      accepts: 0,
      rejects: { "negative zero": "-0", decimal: "0.0", exponent: "0e0", "leading space": " 0" },
    },
    {
      name: "one spelling",
      schema: { type: "number" },
      accepts: 1,
      rejects: { decimal: "1.0", exponent: "1e0", "uppercase exponent": "1E+0" },
    },
  ];
  for (const { name, schema, accepts, rejects } of cases)
    await t.test(name, async (t) => {
      const registry = registryFor(),
        scope = registry.begin(definition);
      const input = schemaRecipe(schema, {
        definition,
        role: "configuration",
        name: "configuration",
        maxBytes: 128,
        maxDepth: 32,
      });
      const codec = scope.schemas.register(input);
      scope.commit();
      const saved = codec.retain(codec.validate(accepts));
      assert.deepEqual(codec.retain(codec.restore(saved)), saved);
      for (const [reason, text] of Object.entries(rejects))
        await t.test(reason, () => {
          // Correct binding/digest and schema-valid parsed data isolate canonical text rejection.
          assert.equal(canonical(JSON.parse(text)), canonical(accepts));
          denied(
            () =>
              codec.restore({
                ...saved,
                canonicalJson: text,
                digest: retainedDigest(input.binding, text),
              }),
            "INVALID_VALUE",
          );
        });
    });
});

test("maximum canonical payload restores despite escaped retained-envelope overhead", () => {
  const { codec } = setup(65536, 65536);
  for (const input of ["x".repeat(65534), "\n".repeat(32767)]) {
    const saved = codec.retain(codec.validate(input));
    assert.equal(Buffer.byteLength(saved.canonicalJson), 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 65536);
    assert.deepEqual(codec.retain(codec.restore(saved)), saved);
  }
  denied(() => codec.validate("x".repeat(65535)), "INVALID_VALUE");
  const saved = codec.retain(codec.validate("x"));
  denied(() => codec.restore({ ...saved, canonicalJson: "x".repeat(65537) }), "INVALID_VALUE");
  const bounded = setup(5, 32);
  assert.equal(bounded.codec.retain(bounded.codec.validate("abc")).canonicalJson, '"abc"');
  denied(() => bounded.codec.validate("abcd"), "INVALID_VALUE");
});

test("root-zero depth applies identically to validation and restore", () => {
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["x"],
    properties: {
      x: {
        type: "object",
        additionalProperties: false,
        required: ["y"],
        properties: { y: { type: "boolean" } },
      },
    },
  };
  for (const maxDepth of [1, 2]) {
    const registry = registryFor(),
      scope = registry.begin(definition),
      input = registration();
    input.jsonSchema = jsonSchema;
    input.maxDepth = maxDepth;
    input.binding.schema.digest = schemaDigest(jsonSchema, 128, maxDepth);
    const codec = scope.schemas.register(input);
    scope.commit();
    if (maxDepth === 1) denied(() => codec.validate({ x: { y: true } }), "INVALID_VALUE");
    else {
      const saved = codec.retain(codec.validate({ x: { y: true } }));
      assert.equal(saved.canonicalJson, '{"x":{"y":true}}');
      assert.deepEqual(codec.retain(codec.restore(saved)), saved);
    }
  }
});

test("hostile definition/binding/candidate/envelope/options refuse without caller code effects", () => {
  let effects = 0;
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        effects++;
        return Object.prototype;
      },
      ownKeys() {
        effects++;
        return [];
      },
      get() {
        effects++;
        return true;
      },
    },
  );
  const getter = Object.defineProperty({ ...definition }, "backendId", {
    enumerable: true,
    get() {
      effects++;
      return "example";
    },
  });
  denied(() => registryFor([proxy]));
  denied(() => registryFor([getter]));
  denied(() => createCredentialSchemaRegistryV1([definition], proxy));
  denied(() =>
    createCredentialSchemaRegistryV1(
      [definition],
      Object.defineProperty({}, "admittedPrimitives", {
        enumerable: true,
        get() {
          effects++;
          return admittedPrimitives;
        },
      }),
    ),
  );
  const { registry, codec, input } = setup();
  denied(() => registry.begin(proxy));
  denied(() => registry.assertCodec(codec, proxy));
  denied(() => codec.validate(proxy));
  denied(() =>
    codec.validate(
      Object.defineProperty({}, "x", {
        enumerable: true,
        get() {
          effects++;
          return "x";
        },
      }),
    ),
  );
  const saved = codec.retain(codec.validate("hello")),
    envelope = Object.defineProperty({ ...saved }, "canonicalJson", {
      enumerable: true,
      get() {
        effects++;
        return '"hello"';
      },
    });
  denied(() => codec.restore(envelope));
  denied(() => codec.restore(proxy));
  denied(() => codec.restore(Object.defineProperty({ ...saved }, "hidden", { value: true })));
  denied(() => codec.restore({ ...saved, [Symbol("extra")]: true }));
  denied(() => registry.assertCodec(codec, { ...input.binding, definition: getter }));
  assert.equal(effects, 0);
});

test("recipe/primitive identities are exact, bounded and nonconflicting", () => {
  denied(() => createCredentialSchemaRegistryV1([definition]), "INVALID_PRIMITIVE");
  for (const refs of [
    [...admittedPrimitives, admittedPrimitives[0]],
    [primitives.interpreter, { ...primitives.interpreter, digest: "sha256:" + "b".repeat(64) }],
  ])
    denied(() => registryFor([definition], refs), "INVALID_PRIMITIVE");
  denied(() => registryFor([definition, structuredClone(definition)]), "INVALID_DEFINITION");
  denied(
    () => registryFor([definition, { ...definition, recipeDigest: "sha256:" + "b".repeat(64) }]),
    "INVALID_DEFINITION",
  );
  for (const patch of [
    { recipeId: "" },
    { recipeId: "é".repeat(129) },
    { backendId: "x\n" },
    { recipeVersion: 0 },
    { recipeVersion: 1.5 },
    { recipeVersion: Number.MAX_SAFE_INTEGER + 1 },
    { recipeDigest: "SHA256:" + "a".repeat(64) },
    { recipeDigest: "sha256:" + "A".repeat(64) },
    { extra: true },
    { interpreter: { ...primitives.interpreter, hidden: true } },
  ])
    denied(() => registryFor([{ ...definition, ...patch }]), "INVALID_DEFINITION");
  const max = {
    ...definition,
    backendId: "é".repeat(128),
    recipeId: "x".repeat(256),
    recipeVersion: Number.MAX_SAFE_INTEGER,
  };
  registryFor([max]).begin(max);
  for (const field of ["name", "version", "digest"]) {
    const ref = { ...primitives.interpreter };
    ref[field] =
      field === "version" ? 0 : field === "name" ? "x".repeat(257) : "sha256:" + "A".repeat(64);
    denied(
      () => registryFor([definition], [ref, primitives.canonicalization]),
      "INVALID_PRIMITIVE",
    );
  }
});

test("unknown name/wrong version/wrong digest/kind and missing Installation primitive admission deny", () => {
  for (const patch of [
    { name: "unknown-interpreter" },
    { version: 2 },
    { digest: "sha256:" + "b".repeat(64) },
  ]) {
    const bad = { ...definition, interpreter: { ...primitives.interpreter, ...patch } };
    denied(() => registryFor([bad]), "INVALID_DEFINITION");
    const registry = registryFor();
    denied(() => registry.begin(bad), "INVALID_DEFINITION");
    const scope = registry.begin(definition),
      input = registration();
    input.binding.definition = bad;
    denied(() => scope.schemas.register(input), "INVALID_SCHEMA");
    const good = scope.schemas.register(registration());
    scope.commit();
    assert.equal(good.retain(good.validate("ok")).canonicalJson, '"ok"');
  }
  denied(
    () => registryFor([{ ...definition, interpreter: primitives.canonicalization }]),
    "INVALID_DEFINITION",
  );
  denied(() => registryFor([definition], [primitives.canonicalization]), "INVALID_DEFINITION");
  const registry = registryFor([definition], [primitives.interpreter]),
    scope = registry.begin(definition);
  denied(() => scope.schemas.register(registration()), "INVALID_SCHEMA");
  for (const patch of [
    { name: "unknown-canonicalization" },
    { version: 2 },
    { digest: "sha256:" + "b".repeat(64) },
    primitives.interpreter,
  ]) {
    const registry = registryFor(),
      scope = registry.begin(definition),
      input = registration();
    input.canonicalization = { ...primitives.canonicalization, ...patch };
    // Recompute a correct digest so primitive selection, rather than digest mismatch, refuses.
    input.binding.schema.digest = schemaDigest(
      input.jsonSchema,
      input.maxBytes,
      input.maxDepth,
      input.canonicalization,
    );
    denied(() => scope.schemas.register(input), "INVALID_SCHEMA");
    const good = scope.schemas.register(registration());
    scope.commit();
    assert.equal(good.retain(good.validate("ok")).canonicalJson, '"ok"');
  }
});

test("data-only registration rejects every executable/hidden/symbol/accessor/proxy injection", () => {
  let effects = 0;
  const hook = () => {
    effects++;
    return "owned";
  };
  const patches = [
    { validateAndCanonicalize: hook },
    { factory: hook },
    { resolver: hook },
    { module: "evil.mjs" },
    { path: "/evil" },
    { url: "https://evil.invalid" },
    { implementation: hook },
    { canonicalization: hook },
    { binding: hook },
  ];
  const hostile = [
    ...patches.map((patch) => ({ ...registration(), ...patch })),
    Object.defineProperty(registration(), "hidden", { value: hook }),
    { ...registration(), [Symbol("hook")]: hook },
    Object.defineProperty(registration(), "canonicalization", { enumerable: true, get: hook }),
    new Proxy(registration(), { getPrototypeOf: hook, ownKeys: hook, get: hook }),
  ];
  for (const input of hostile) {
    const registry = registryFor(),
      scope = registry.begin(definition);
    denied(() => scope.schemas.register(input), "INVALID_SCHEMA");
    const good = scope.schemas.register(JSON.parse(JSON.stringify(registration())));
    scope.commit();
    assert.equal(good.retain(good.validate("ok")).canonicalJson, '"ok"');
  }
  assert.equal(effects, 0);
});

test("generated installed primitive manifest independently binds final source closure and Ajv", () => {
  const paths = [
    "packages/occ/src/credential-broker-v1/schema-admission.ts",
    "packages/occ/src/credential-broker-v1/schema-json.ts",
    "packages/occ/src/credential-broker-v1/schema-primitives.ts",
    "packages/occ/src/credential-gateway-v1/schema.ts",
  ];
  const files = paths.map((path) => ({
    path,
    sha256: createHash("sha256")
      .update(readFileSync(new URL("../../" + path, import.meta.url)))
      .digest("hex"),
  }));
  for (const [index, kind, name] of [
    [0, "schema-interpreter", "oce-closed-schema-interpreter"],
    [1, "canonicalization", "oce-json-canonical"],
  ]) {
    const expected = { kind, name, version: 1, files, dependencies: { ajv: "8.20.0" } },
      entry = CORE_SCHEMA_PRIMITIVE_MANIFEST_V1[index];
    assert.equal(entry.kind, kind);
    assert.equal(entry.name, name);
    assert.equal(entry.version, 1);
    assert.deepEqual(entry.files, files);
    assert.deepEqual(entry.dependencies, { ajv: "8.20.0" });
    assert.equal(entry.digest, digest("oce-core-schema-primitive-v1", canonical(expected)));
    assert.equal(admittedPrimitives[index].digest, entry.digest);
    assert.ok(Object.isFrozen(admittedPrimitives[index]));
  }
  const ajvPackage = JSON.parse(
    readFileSync(new URL("../../packages/occ/node_modules/ajv/package.json", import.meta.url)),
  );
  assert.equal(ajvPackage.version, "8.20.0");
});

test("full original legacy retained vector refuses without relabeling or byte mutation", () => {
  const legacyDefinition = {
    backendId: "example",
    packageName: "example-package",
    packageVersion: "1.0.0",
    packageIntegrity: "sha512-example",
    contractVersion: "credential-backend-v1",
  };
  const legacy = {
    definition: legacyDefinition,
    role: "configuration",
    schema: {
      namespace: "example",
      name: "configuration",
      version: 1,
      digest: "sha256:93b6f5a6f1f02dfeee7bdd90d2b7bbee431dfa9c00c774d9b6f2315c7b77b705",
    },
    canonicalJson: '"hello"',
    digest: "sha256:b3bf1f5803b0d3ec6da42f34ae544cf2a513891e5936136c128322e8cf872995",
  };
  assert.equal(legacy.digest, retainedDigest(legacy, legacy.canonicalJson));
  const before = JSON.stringify(legacy);
  Object.freeze(legacyDefinition);
  Object.freeze(legacy.schema);
  Object.freeze(legacy);
  denied(() => registryFor([legacyDefinition]), "INVALID_DEFINITION");
  const { registry, codec } = setup();
  denied(() => registry.begin(legacyDefinition), "INVALID_DEFINITION");
  denied(() => codec.restore(legacy), "INVALID_VALUE");
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(
    codec.retain(codec.restore(codec.retain(codec.validate("hello")))),
    codec.retain(codec.validate("hello")),
  );
});

test("public OCC self-import executes JSON-round-tripped current recipe lifecycle", () => {
  const input = registration();
  const program =
    'import assert from "node:assert/strict";import {createCredentialSchemaRegistryV1,INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1} from "@openclaw-enterprise/occ";const input=' +
    JSON.stringify(input) +
    ';const options={admittedPrimitives:INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1};const registry=createCredentialSchemaRegistryV1([input.binding.definition],options);const scope=registry.begin(input.binding.definition);const codec=scope.schemas.register(input);scope.commit();registry.assertCodec(codec,input.binding);const foreignRegistry=createCredentialSchemaRegistryV1([input.binding.definition],options);const foreignScope=foreignRegistry.begin(input.binding.definition);const foreignCodec=foreignScope.schemas.register(input);foreignScope.commit();assert.throws(()=>registry.assertCodec(foreignCodec,input.binding),/INVALID_CODEC/);const handle=codec.validate("public"),saved=codec.retain(handle),restored=codec.restore(saved);assert.notEqual(handle,restored);assert.deepEqual(codec.retain(restored),saved);scope.discard();assert.throws(()=>codec.restore(saved),/INVALID_CODEC/);console.log(JSON.stringify({resolved:import.meta.resolve("@openclaw-enterprise/occ"),lifecycle:"PASS"}));';
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: new URL("../../packages/occ/", import.meta.url),
      encoding: "utf8",
      timeout: 15000,
    }),
  );
  assert.equal(result.lifecycle, "PASS");
  assert.equal(result.resolved, new URL("../../packages/occ/src/index.ts", import.meta.url).href);
});
