import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createCredentialSchemaRegistryV1 } from "../../packages/occ/src/credential-broker-v1/schema-registry.ts";

const definition = {
  backendId: "example",
  packageName: "example-package",
  packageVersion: "1.0.0",
  packageIntegrity: "sha512-example",
  contractVersion: "credential-backend-v1",
};
const digest = (domain, payload) =>
  "sha256:" +
  createHash("sha256")
    .update(domain + "\0" + payload)
    .digest("hex");
function registration(hook = (value) => value, maxBytes = 128, maxLength = 32) {
  // Independent literal canonical schema protocol; no supplier encoder is used.
  const schemaDigest = digest(
    "oce-schema-v1",
    '{"jsonSchema":{"maxLength":' +
      maxLength +
      ',"type":"string"},"maxBytes":' +
      maxBytes +
      ',"maxDepth":32,"profile":"oce-closed-draft7-v1"}',
  );
  return {
    binding: {
      definition: { ...definition },
      role: "configuration",
      schema: { namespace: "example", name: "configuration", version: 1, digest: schemaDigest },
    },
    jsonSchema: { type: "string", maxLength },
    maxBytes,
    maxDepth: 32,
    validateAndCanonicalize: hook,
  };
}
function setup(hook, maxBytes, maxLength) {
  const registry = createCredentialSchemaRegistryV1([definition]);
  const scope = registry.begin(definition);
  const input = registration(hook, maxBytes, maxLength);
  const codec = scope.schemas.register(input);
  scope.commit();
  return { registry, scope, codec, input };
}
const denied = (run, code) =>
  assert.throws(run, code ? new RegExp("^Error: " + code + "$") : /^Error: INVALID_[A-Z]+$/);
function retainedDigest(binding, canonicalJson) {
  const d = binding.definition,
    s = binding.schema;
  const payload =
    '{"canonicalJson":' +
    JSON.stringify(canonicalJson) +
    ',"definition":{"backendId":' +
    JSON.stringify(d.backendId) +
    ',"contractVersion":"credential-backend-v1","packageIntegrity":' +
    JSON.stringify(d.packageIntegrity) +
    ',"packageName":' +
    JSON.stringify(d.packageName) +
    ',"packageVersion":' +
    JSON.stringify(d.packageVersion) +
    '},"role":' +
    JSON.stringify(binding.role) +
    ',"schema":{"digest":' +
    JSON.stringify(s.digest) +
    ',"name":' +
    JSON.stringify(s.name) +
    ',"namespace":' +
    JSON.stringify(s.namespace) +
    ',"version":' +
    s.version +
    "}}";
  return digest("oce-schema-value-v1", payload);
}

test("real compiler/Ajv/canonical lifecycle uses independent schema and value digests", () => {
  const { registry, codec, input } = setup();
  registry.assertCodec(codec, input.binding);
  const value = codec.validate("hello");
  const retained = codec.retain(value);
  assert.equal(retained.canonicalJson, '"hello"');
  assert.equal(
    input.binding.schema.digest,
    "sha256:93b6f5a6f1f02dfeee7bdd90d2b7bbee431dfa9c00c774d9b6f2315c7b77b705",
  );
  assert.equal(
    retained.digest,
    "sha256:b3bf1f5803b0d3ec6da42f34ae544cf2a513891e5936136c128322e8cf872995",
  );
  assert.equal(retained.digest, retainedDigest(input.binding, '"hello"'));
  const restored = codec.restore(retained);
  assert.notEqual(restored, value);
  assert.deepEqual(codec.retain(restored), retained);
  const second = codec.retain(value);
  assert.notEqual(second.definition, retained.definition);
  for (const v of [
    codec,
    codec.binding,
    codec.binding.schema,
    value,
    retained,
    retained.definition,
    retained.schema,
  ])
    assert.ok(Object.isFrozen(v));
  assert.throws(() => {
    retained.schema.version = 2;
  }, TypeError);
});

test("foreign registries, foreign codecs, cloned handles and all mismatched bindings deny before hooks", () => {
  let calls = 0;
  const a = setup((v) => {
      calls++;
      return v;
    }),
    b = setup();
  const value = a.codec.validate("hello");
  const foreign = b.codec.validate("hello");
  denied(() => a.codec.retain(foreign));
  denied(() => a.codec.retain({ ...value }));
  denied(() => a.registry.assertCodec(b.codec, b.input.binding));
  denied(() => a.registry.assertCodec({ ...a.codec }, a.input.binding));
  for (const key of Object.keys(definition)) {
    const binding = structuredClone(a.input.binding);
    binding.definition[key] += "-other";
    denied(() => a.registry.assertCodec(a.codec, binding));
    denied(() => a.codec.restore({ ...a.codec.retain(value), definition: binding.definition }));
  }
  for (const key of ["namespace", "name", "version", "digest"]) {
    const binding = structuredClone(a.input.binding);
    binding.schema[key] = key === "version" ? 2 : "other";
    denied(() => a.registry.assertCodec(a.codec, binding));
    denied(() => a.codec.restore({ ...a.codec.retain(value), schema: binding.schema }));
  }
  denied(() => a.registry.assertCodec(a.codec, { ...a.input.binding, role: "evidence" }));
  denied(() => a.codec.restore({ ...a.codec.retain(value), role: "evidence" }));
  assert.equal(calls, 1);
});

test("borrowed registry, scope, owner and codec receivers deny without semantic effects", () => {
  let calls = 0;
  const a = setup((v) => {
      calls++;
      return v;
    }),
    b = setup();
  const value = a.codec.validate("hello"),
    saved = a.codec.retain(value);
  denied(() => a.registry.begin.call(b.registry, definition));
  denied(() => a.registry.assertCodec.call(b.registry, a.codec, a.input.binding));
  denied(() => a.scope.commit.call(b.scope));
  denied(() => a.scope.discard.call(b.scope));
  denied(() => a.scope.schemas.register.call(b.scope.schemas, registration()));
  denied(() => a.codec.validate.call(b.codec, "hello"));
  denied(() => a.codec.retain.call(b.codec, value));
  denied(() => a.codec.restore.call(b.codec, saved));
  assert.equal(calls, 1);
});

test("pending registration seals once, rejects duplicate tuples, and never resurrects discarded scopes", () => {
  const registry = createCredentialSchemaRegistryV1([definition]);
  denied(() => registry.begin({ ...definition, backendId: "unknown" }));
  const scope = registry.begin({ ...definition });
  denied(() => registry.begin(definition));
  const input = registration();
  const codec = scope.schemas.register(input);
  denied(() => scope.schemas.register(registration()));
  denied(() => scope.schemas.register(registration(undefined, 128, 31)));
  denied(() => codec.validate("hello"));
  denied(() => registry.assertCodec(codec, input.binding));
  scope.commit();
  denied(() => scope.commit());
  denied(() => scope.schemas.register(input));
  const value = codec.validate("hello"),
    saved = codec.retain(value);
  scope.discard();
  scope.discard();
  denied(() => registry.assertCodec(codec, input.binding));
  denied(() => codec.validate("hello"));
  denied(() => codec.retain(value));
  denied(() => codec.restore(saved));
  denied(() => scope.commit());
  denied(() => scope.schemas.register(input));
  const pending = createCredentialSchemaRegistryV1([definition]).begin(definition);
  pending.discard();
  pending.discard();
  denied(() => pending.commit());
  denied(() => pending.schemas.register(input));
});

test("real Ajv denies invalid input before hook and invalid hook output after hook", () => {
  let calls = 0;
  const a = setup((v) => {
    calls++;
    return v;
  });
  denied(() => a.codec.validate(123), "INVALID_VALUE");
  assert.equal(calls, 0);
  denied(() => a.codec.validate("x".repeat(33)), "INVALID_VALUE");
  assert.equal(calls, 0);
  const b = setup(() => {
    calls++;
    return 123;
  });
  denied(() => b.codec.validate("hello"), "INVALID_VALUE");
  assert.equal(calls, 1);
  const c = setup(() => {
    throw new Error("private-hook-content");
  });
  denied(() => c.codec.validate("hello"), "INVALID_VALUE");
});

test("registration mutation cannot replace captured schema, limits, identity or hook", () => {
  const registry = createCredentialSchemaRegistryV1([definition]),
    scope = registry.begin(definition);
  const input = registration(),
    codec = scope.schemas.register(input);
  input.jsonSchema.type = "number";
  input.maxBytes = 1;
  input.maxDepth = 1;
  input.binding.definition.backendId = "changed";
  input.validateAndCanonicalize = () => 123;
  definition.backendId = "changed";
  scope.commit();
  assert.equal(codec.retain(codec.validate("hello")).canonicalJson, '"hello"');
  definition.backendId = "example";
});

test("strict restore rejects changed envelopes, invalid digests, malformed and noncanonical JSON", () => {
  let calls = 0;
  const { codec, input } = setup((v) => {
    calls++;
    return v;
  });
  const saved = codec.retain(codec.validate("hello"));
  for (const key of Object.keys(saved)) {
    const missing = { ...saved };
    delete missing[key];
    denied(() => codec.restore(missing), "INVALID_VALUE");
  }
  denied(() => codec.restore({ ...saved, extra: true }), "INVALID_VALUE");
  denied(() => codec.restore({ ...saved, digest: "sha256:" + "0".repeat(64) }), "INVALID_VALUE");
  for (const text of [
    ' "hello"',
    '"hello" ',
    '"\\u0068ello"',
    "{",
    '{"a":1,"a":1}',
    '{"z":1,"a":1}',
    "-0",
    "1.0",
  ]) {
    denied(
      () =>
        codec.restore({
          ...saved,
          canonicalJson: text,
          digest: retainedDigest(input.binding, text),
        }),
      "INVALID_VALUE",
    );
  }
  assert.equal(calls, 1);
  assert.equal(codec.retain(codec.restore(saved)).canonicalJson, '"hello"');
  assert.equal(calls, 2);
});

test("restore repeats semantic validation and rejects non-idempotent hook output", () => {
  const { codec } = setup((v) => v + "x");
  const saved = codec.retain(codec.validate("a"));
  assert.equal(saved.canonicalJson, '"ax"');
  denied(() => codec.restore(saved), "INVALID_VALUE");
});

test("semantic reentry denies and hook discard prevents issuance and invalidates earlier handles", () => {
  let codec,
    scope,
    revoke = false,
    nested = 0;
  const a = setup((v) => {
    denied(() => codec.validate(v), "INVALID_SCOPE");
    nested++;
    denied(() => scope.commit(), "INVALID_SCOPE");
    if (revoke) scope.discard();
    return v;
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

test("maximum canonical payload restores with independently bounded escaped envelope overhead", () => {
  const { codec } = setup(undefined, 65536, 65536);
  for (const input of ["x".repeat(65534), "\n".repeat(32767)]) {
    const saved = codec.retain(codec.validate(input));
    assert.equal(Buffer.byteLength(saved.canonicalJson), 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 65536);
    assert.deepEqual(codec.retain(codec.restore(saved)), saved);
  }
  denied(() => codec.validate("x".repeat(65535)), "INVALID_VALUE");
  const saved = codec.retain(codec.validate("x"));
  denied(() => codec.restore({ ...saved, canonicalJson: "x".repeat(65537) }), "INVALID_VALUE");
  const bounded = setup(undefined, 5, 32);
  assert.equal(bounded.codec.retain(bounded.codec.validate("abc")).canonicalJson, '"abc"');
  denied(() => bounded.codec.validate("abcd"), "INVALID_VALUE");
});

test("hostile definition, expected binding, candidate and retained envelopes deny without getter/proxy effects", () => {
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
    },
  );
  const getter = Object.defineProperty({}, "backendId", {
    enumerable: true,
    get() {
      effects++;
      return "example";
    },
  });
  denied(() => createCredentialSchemaRegistryV1([proxy]));
  denied(() => createCredentialSchemaRegistryV1([getter]));
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
  const saved = codec.retain(codec.validate("hello"));
  const envelope = Object.defineProperty({ ...saved }, "canonicalJson", {
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

test("public OCC package self-import executes the real committed registry lifecycle", () => {
  const input = registration();
  const program =
    'import assert from "node:assert/strict";' +
    'import {createCredentialSchemaRegistryV1} from "@openclaw-enterprise/occ";' +
    "const input=" +
    JSON.stringify(input) +
    ";input.validateAndCanonicalize=v=>v;" +
    "const registry=createCredentialSchemaRegistryV1([input.binding.definition]);" +
    "const scope=registry.begin(input.binding.definition);const codec=scope.schemas.register(input);scope.commit();" +
    "registry.assertCodec(codec,input.binding);" +
    "const foreignRegistry=createCredentialSchemaRegistryV1([input.binding.definition]);" +
    "const foreignScope=foreignRegistry.begin(input.binding.definition);const foreignCodec=foreignScope.schemas.register(input);foreignScope.commit();" +
    "assert.throws(()=>registry.assertCodec(foreignCodec,input.binding),/INVALID_CODEC/);" +
    'const handle=codec.validate("public");const saved=codec.retain(handle);' +
    "const restored=codec.restore(saved);assert.notEqual(handle,restored);assert.equal(saved.canonicalJson,'\"public\"');" +
    "scope.discard();assert.throws(()=>codec.restore(saved),/INVALID_CODEC/);" +
    'console.log(JSON.stringify({resolved:import.meta.resolve("@openclaw-enterprise/occ"),lifecycle:"PASS"}));';
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: new URL("../../packages/occ/", import.meta.url),
    encoding: "utf8",
    timeout: 15000,
  });
  const result = JSON.parse(output);
  assert.equal(result.lifecycle, "PASS");
  assert.equal(result.resolved, new URL("../../packages/occ/src/index.ts", import.meta.url).href);
});

test("registry validation and restoration enforce exact configured root-zero depth", () => {
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
  const schemaBytes =
    '{"additionalProperties":false,"properties":{"x":{"additionalProperties":false,"properties":{"y":{"type":"boolean"}},"required":["y"],"type":"object"}},"required":["x"],"type":"object"}';
  for (const maxDepth of [1, 2]) {
    let calls = 0;
    const registry = createCredentialSchemaRegistryV1([definition]),
      scope = registry.begin(definition);
    const input = registration();
    input.jsonSchema = jsonSchema;
    input.maxDepth = maxDepth;
    input.validateAndCanonicalize = (v) => {
      calls++;
      return v;
    };
    input.binding.schema.digest = digest(
      "oce-schema-v1",
      '{"jsonSchema":' +
        schemaBytes +
        ',"maxBytes":128,"maxDepth":' +
        maxDepth +
        ',"profile":"oce-closed-draft7-v1"}',
    );
    const codec = scope.schemas.register(input);
    scope.commit();
    if (maxDepth === 1) {
      denied(() => codec.validate({ x: { y: true } }), "INVALID_VALUE");
      assert.equal(calls, 0);
    } else {
      const saved = codec.retain(codec.validate({ x: { y: true } }));
      assert.equal(saved.canonicalJson, '{"x":{"y":true}}');
      assert.deepEqual(codec.retain(codec.restore(saved)), saved);
      assert.equal(calls, 2);
    }
  }
});

test("same-scope cross-codec reentry denies and restore-time discard revokes every issued handle", () => {
  const registry = createCredentialSchemaRegistryV1([definition]),
    scope = registry.begin(definition);
  let other,
    revoke = false,
    calls = 0;
  const first = scope.schemas.register(
    registration((v) => {
      calls++;
      denied(() => other.validate(v), "INVALID_SCOPE");
      if (revoke) scope.discard();
      return v;
    }),
  );
  const input = registration();
  input.binding.schema.name = "other";
  other = scope.schemas.register(input);
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
