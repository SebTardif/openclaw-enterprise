import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  canonical,
  definitionFor,
  schemaRecipe,
  objectSchema,
  protoCases,
} from "../helpers/credential-schema.mjs";

// Substitute only the fixed installed canonicalizer; compiler, Ajv, encoder and
// registry remain real. No production registration accepts these fault functions.
const installed = await import("../../packages/occ/src/credential-broker-v1/schema-primitives.ts");
const admittedPrimitives = installed.INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1;
let selectedFault;
mock.module(
  new URL("../../packages/occ/src/credential-broker-v1/schema-primitives.ts", import.meta.url).href,
  {
    namedExports: {
      ...installed,
      selectSchemaCanonicalizationV1(ref, admitted) {
        const real = installed.selectSchemaCanonicalizationV1(ref, admitted);
        return selectedFault ?? real;
      },
    },
  },
);
const { compileSchemaRegistrationV1 } =
  await import("../../packages/occ/src/credential-broker-v1/schema-admission.ts");
const { createCredentialSchemaRegistryV1 } =
  await import("../../packages/occ/src/credential-broker-v1/schema-registry.ts");
function withCanonicalizer(fault, admit) {
  selectedFault = fault;
  try {
    return admit();
  } finally {
    selectedFault = undefined;
  }
}
const compileFault = (input, fault) =>
  withCanonicalizer(fault, () => compileSchemaRegistrationV1(input, admittedPrimitives));
const denied = (run, code = "INVALID_VALUE") =>
  assert.throws(run, new RegExp("^Error: " + code + "$"));
const registryDefinition = definitionFor("fault-registry");
function registerFault(scope, fault, name = "configuration") {
  const input = schemaRecipe(
    { type: "string", maxLength: 32 },
    {
      definition: registryDefinition,
      role: "configuration",
      name,
      maxBytes: 128,
      maxDepth: 32,
    },
  );
  return withCanonicalizer(fault, () => scope.schemas.register(input));
}
function faultSetup(fault) {
  const registry = createCredentialSchemaRegistryV1([registryDefinition], { admittedPrimitives });
  const scope = registry.begin(registryDefinition);
  const codec = registerFault(scope, fault);
  scope.commit();
  return { registry, scope, codec };
}

// Ordinary schema/profile/digest/input vectors live in admission.test.mjs.
// This subprocess owns only behavior that needs substituted trusted-code faults.
await test("trusted-code fault scenarios", async (t) => {
  await t.test("admission captures its selected canonicalizer", () => {
    const input = schemaRecipe({ type: "integer", minimum: 1, maximum: 2 });
    let calls = 0;
    const compiled = compileFault(input, (value) => {
      calls++;
      return value;
    });
    // A later selection cannot replace the implementation captured at compilation.
    withCanonicalizer(
      () => {
        throw new Error("private");
      },
      () => {
        assert.equal(compiled.validateAndCanonicalize(2), 2);
      },
    );
    assert.equal(calls, 1);
  });

  await t.test("canonicalization receives frozen copies after input checks", () => {
    let calls = 0;
    const input = { name: "ok", count: 2, items: [true] };
    const compiled = compileFault(schemaRecipe(objectSchema), (candidate) => {
      calls++;
      assert.ok(Object.isFrozen(candidate));
      assert.ok(Object.isFrozen(candidate.items));
      assert.notEqual(candidate, input);
      return { ...candidate, count: 3 };
    });
    const output = compiled.validateAndCanonicalize(input);
    assert.equal(output.count, 3);
    assert.equal(input.count, 2);
    assert.ok(Object.isFrozen(output));
    denied(() => compiled.validateAndCanonicalize({ ...input, count: 9 }));
    assert.equal(calls, 1);
  });

  await t.test("post-output failures stay within schema and JSON bounds", async (t) => {
    const input = { name: "ok", count: 2, items: [true] };
    const cases = [
      ["schema maximum", () => ({ ...input, count: 9 })],
      ["closed properties", () => ({ ...input, extra: 1 })],
      ["nonfinite JSON", () => ({ ...input, count: Infinity })],
      ["non-JSON result", () => undefined],
      [
        "private exception",
        () => {
          throw new Error("private token");
        },
      ],
    ];
    for (const [name, fault] of cases)
      await t.test(name, () => {
        const compiled = compileFault(schemaRecipe(objectSchema), fault);
        denied(() => compiled.validateAndCanonicalize(input));
      });
    await t.test("canonical UTF-8 byte limit", () => {
      const compiled = compileFault(
        schemaRecipe({ type: "string", maxLength: 100 }, { maxBytes: 4 }),
        () => "éé",
      );
      denied(() => compiled.validateAndCanonicalize("é"));
    });
  });

  await t.test("own __proto__ is rejected before and after canonicalization", async (t) => {
    for (const { name, schema, forbidden, good, invalid } of protoCases())
      await t.test(name, () => {
        let calls = 0;
        let output = good;
        const fault = () => {
          calls++;
          return output;
        };
        denied(() => compileFault(schemaRecipe(forbidden), fault), "INVALID_SCHEMA");
        assert.equal(calls, 0);
        const compiled = compileFault(schemaRecipe(schema), fault);
        compiled.assertValid(good);
        assert.equal(calls, 0);
        assert.equal(canonical(compiled.validateAndCanonicalize(good)), canonical(good));
        assert.equal(calls, 1);
        calls = 0;
        denied(() => compiled.assertValid(invalid));
        denied(() => compiled.validateAndCanonicalize(invalid));
        assert.equal(calls, 0);
        output = invalid;
        denied(() => compiled.validateAndCanonicalize(good));
        assert.equal(calls, 1);
      });
  });
  await t.test(
    "trusted-code faults: Ajv precheck, invalid post-output and private throw are contained",
    () => {
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
    },
  );
  await t.test("trusted-code faults: non-idempotent canonicalization refuses restore", () => {
    const { codec } = faultSetup((value) => value + "x");
    const saved = codec.retain(codec.validate("a"));
    assert.equal(saved.canonicalJson, '"ax"');
    denied(() => codec.restore(saved), "INVALID_VALUE");
  });
  await t.test(
    "trusted-code faults: same-codec reentry, commit reentry and validate-time discard",
    () => {
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
    },
  );
  await t.test(
    "trusted-code faults: cross-codec reentry and restore-time discard revoke every handle",
    () => {
      const registry = createCredentialSchemaRegistryV1([registryDefinition], {
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
    },
  );

  // Reached only after every awaited scenario above; the parent also rejects any
  // failed/skipped child tests. This receipt survives legitimate case regrouping.
  t.diagnostic("schema-fault-scenarios-complete");
});
