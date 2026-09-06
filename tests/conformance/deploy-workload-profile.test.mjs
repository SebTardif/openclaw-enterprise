import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  WORKLOAD_PROFILE_LIMITS_V1,
  WorkloadProfileIdSchemaV1,
  WorkloadProfileDigestSchemaV1,
  WorkloadProfileVersionSchemaV1,
  WorkloadProfileScopeSchemaV1,
  WorkloadProfileSelectionSchemaV1,
  WorkloadProfileUseSchemaV1,
  WorkloadProfilePrepareSchemaV1,
  WorkloadProfileWithdrawSchemaV1,
  ProfileInvalidationRequestSchemaV1,
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV1,
  decodeWorkloadProfilePrepareEnvelopeV1,
  decodeWorkloadProfileWithdrawV1,
  decodeProfileInvalidationRequestV1,
} from "../../packages/contracts/src/workload-profile-v1.ts";

const contractsRequire = createRequire(
  new URL("../../packages/contracts/package.json", import.meta.url),
);
const { Check } = await import(contractsRequire.resolve("typebox/value"));

// This file verifies actual closed data contracts. No Agent draft/deploy path,
// current authority, complete manifest validation or runtime admission is exercised.
const id = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const format = "oce.workload-profile.canonical-json.v1";
const selection = () => ({
  manifestRef: id(1),
  manifestDigest: digest,
  admissionRef: id(2),
  admissionVersion: 3,
});
const scope = () => ({
  installationId: `ins_${id(3)}`,
  namespaceId: `ns_${id(4)}`,
  component: "harness",
});
const roleNames = ["provider", "runtime", "identity", "containment", "storage"];
const roles = () =>
  Object.fromEntries(
    roleNames.map((name, index) => [
      name,
      {
        ref: id(10 + index),
        version: index + 1,
        contentDigest: digest,
      },
    ]),
  );
const use = () => ({
  schemaVersion: 1,
  ...scope(),
  ...selection(),
  canonicalFormat: format,
  profileRefs: roles(),
  admittedConfigurationDigest: digest,
});
const prepare = () => ({
  schemaVersion: 1,
  operationRef: id(20),
  namespaceId: scope().namespaceId,
  component: "harness",
  action: "admit",
  expectedAdmission: null,
  manifest: { format, canonicalUtf8: "{}", manifestDigest: digest },
});
const replace = () => ({ ...prepare(), action: "replace", expectedAdmission: selection() });
const withdraw = () => ({ schemaVersion: 1, operationRef: id(21), expectedAdmission: selection() });
const invalidation = () => ({
  schemaVersion: 1,
  kind: "profile-admission-invalidated",
  requestRef: id(22),
  operationRef: id(23),
  ...scope(),
  manifestRef: id(1),
  manifestDigest: digest,
  admissionRef: id(2),
  previousVersion: 3,
  currentVersion: 4,
  reason: "withdrawn",
  acceptedAt: "2024-02-29T23:59:59.123Z",
});
const decodeCases = [
  ["selection", decodeWorkloadProfileSelectionV1, selection, WorkloadProfileSelectionSchemaV1],
  ["use binding", decodeWorkloadProfileUseV1, use, WorkloadProfileUseSchemaV1],
  [
    "admit envelope",
    decodeWorkloadProfilePrepareEnvelopeV1,
    prepare,
    WorkloadProfilePrepareSchemaV1,
  ],
  [
    "replace envelope",
    decodeWorkloadProfilePrepareEnvelopeV1,
    replace,
    WorkloadProfilePrepareSchemaV1,
  ],
  ["withdrawal", decodeWorkloadProfileWithdrawV1, withdraw, WorkloadProfileWithdrawSchemaV1],
  [
    "invalidation",
    decodeProfileInvalidationRequestV1,
    invalidation,
    ProfileInvalidationRequestSchemaV1,
  ],
];
const invalid = (decode, value) => assert.deepEqual(decode(value), { kind: "invalid" });
function accepted(decode, value, schema) {
  const result = decode(value);
  assert.equal(result.kind, "valid");
  assert.equal(Check(schema, result.value), true, "accepted copy must still satisfy its schema");
  return result.value;
}
function assertFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozen(child);
}

test("profile data limits remain explicit and immutable", () => {
  assert.deepEqual(WORKLOAD_PROFILE_LIMITS_V1, {
    canonicalBytes: 65_536,
    pendingOrdinaryOperations: 32,
    operationAndTerminalSlots: 4_096,
    lookupMs: 3_000,
  });
  assert.equal(Object.isFrozen(WORKLOAD_PROFILE_LIMITS_V1), true);
});

for (const [name, decode, make, schema] of decodeCases) {
  test(`${name} decoder returns an independent deeply frozen schema-valid copy`, () => {
    const input = make();
    const result = accepted(decode, input, schema);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    assertFrozen(result);
    for (const [key, value] of Object.entries(input)) {
      if (value !== null && typeof value === "object") {
        assert.notEqual(result[key], value);
        value.untrustedAddition = true;
        assert.equal(Object.hasOwn(result[key], "untrustedAddition"), false);
      }
    }
    input.untrustedAddition = true;
    assert.equal(Object.hasOwn(result, "untrustedAddition"), false);
    assert.throws(() => {
      result.untrustedAddition = true;
    }, TypeError);
  });

  test(`${name} rejects missing fields and external authority fields`, () => {
    const input = make();
    for (const key of Object.keys(input)) {
      const missing = { ...input };
      delete missing[key];
      invalid(decode, missing);
    }
    for (const [key, value] of [
      ["approved", true],
      ["currentAuthority", true],
      ["actor", { accountRef: "account" }],
      ["grantRefs", []],
      ["selectedDriver", "caller-choice"],
      ["accepted", true],
    ])
      invalid(decode, { ...make(), [key]: value });
  });

  test(`${name} rejects malformed object kinds and unsupported property descriptors`, () => {
    for (const value of [null, undefined, true, 1, "{}", [], new Date(0), new Map(), new Set()]) {
      invalid(decode, value);
    }
    const input = make();
    const key = Object.keys(input)[0];
    const nonenumerable = { ...input };
    Object.defineProperty(nonenumerable, key, { enumerable: false });
    invalid(decode, nonenumerable);
    invalid(decode, { ...input, [Symbol("authority")]: true });
    invalid(decode, Object.assign(Object.create({ inheritedAuthority: true }), input));
    let invoked = 0;
    const getter = { ...input };
    Object.defineProperty(getter, key, {
      enumerable: true,
      get() {
        invoked += 1;
        return input[key];
      },
    });
    invalid(decode, getter);
    assert.equal(invoked, 0);
  });

  test(`${name} rejects proxies before invoking traps`, () => {
    let invoked = 0;
    const trap = () => {
      invoked += 1;
      throw new Error("proxy trap must not execute");
    };
    const proxy = new Proxy(make(), {
      get: trap,
      ownKeys: trap,
      getPrototypeOf: trap,
      getOwnPropertyDescriptor: trap,
    });
    invalid(decode, proxy);
    invalid(decode, new Proxy(make(), {}));
    assert.equal(invoked, 0);
  });

  test(`${name} never returns a malformed success from an exotic copy`, () => {
    // A changed prototype does not remove built-in internal slots. The decoder
    // must reject objects whose structured copy loses the validated data shape.
    for (const value of [new Date(0), new Map(), new Set(), new Number(1)]) {
      Object.setPrototypeOf(value, Object.prototype);
      Object.assign(value, make());
      invalid(decode, value);
    }
  });
}

test("UUID and digest schemas require exact lowercase scoped wire identities", () => {
  assert.equal(Check(WorkloadProfileIdSchemaV1, id(1)), true);
  for (const value of [
    "",
    id(1) + "\n",
    " " + id(1),
    id(1).replace("-4000-", "-7000-"),
    id(1).replace("-8000-", "-7000-"),
    id(0xab).toUpperCase(),
    `ins_${id(1)}`,
    1,
  ])
    assert.equal(Check(WorkloadProfileIdSchemaV1, value), false);
  assert.equal(Check(WorkloadProfileDigestSchemaV1, digest), true);
  for (const value of [
    digest.toUpperCase(),
    digest + "\n",
    digest.slice(7),
    "sha256:" + "g".repeat(64),
    "sha256:" + "a".repeat(63),
    "sha256:" + "a".repeat(65),
  ]) {
    assert.equal(Check(WorkloadProfileDigestSchemaV1, value), false);
    invalid(decodeWorkloadProfileSelectionV1, { ...selection(), manifestDigest: value });
  }
});

test("scope requires exact Installation and Namespace prefixes and harness component", () => {
  assert.equal(Check(WorkloadProfileScopeSchemaV1, scope()), true);
  for (const change of [
    { installationId: id(3) },
    { installationId: `ns_${id(3)}` },
    { installationId: scope().installationId + "\n" },
    { namespaceId: id(4) },
    { namespaceId: `ins_${id(4)}` },
    { namespaceId: `agt_${id(4)}` },
    { namespaceId: null },
    { component: "gateway" },
    { component: "Harness" },
    { resourceId: id(4) },
  ]) {
    assert.equal(Check(WorkloadProfileScopeSchemaV1, { ...scope(), ...change }), false);
    invalid(decodeWorkloadProfileUseV1, { ...use(), ...change });
    invalid(decodeProfileInvalidationRequestV1, { ...invalidation(), ...change });
  }
});

test("selection retains only its four explicit intended-identity fields", () => {
  const result = accepted(
    decodeWorkloadProfileSelectionV1,
    selection(),
    WorkloadProfileSelectionSchemaV1,
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "admissionRef",
    "admissionVersion",
    "manifestDigest",
    "manifestRef",
  ]);
  for (const field of ["manifestRef", "admissionRef"]) {
    for (const value of [undefined, null, id(1) + "\r", "latest", "default", digest, 1]) {
      invalid(decodeWorkloadProfileSelectionV1, { ...selection(), [field]: value });
    }
  }
  // Saved identity data does not itself claim a current admission decision.
  assert.equal(Object.hasOwn(result, "active"), false);
});

test("versions are positive safe integers without coercion", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(Check(WorkloadProfileVersionSchemaV1, value), true);
    accepted(
      decodeWorkloadProfileSelectionV1,
      { ...selection(), admissionVersion: value },
      WorkloadProfileSelectionSchemaV1,
    );
  }
  for (const value of [
    -0,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
    "1",
    true,
    null,
  ]) {
    invalid(decodeWorkloadProfileSelectionV1, { ...selection(), admissionVersion: value });
    const input = use();
    input.profileRefs.runtime.version = value;
    invalid(decodeWorkloadProfileUseV1, input);
  }
});

test("use binding retains exact selected roles without inferring equality of their versions", () => {
  const input = use();
  const result = accepted(decodeWorkloadProfileUseV1, input, WorkloadProfileUseSchemaV1);
  assert.deepEqual(result.profileRefs, input.profileRefs);
  assert.deepEqual(Object.keys(result.profileRefs), roleNames);
  assert.equal(new Set(Object.values(result.profileRefs).map((role) => role.ref)).size, 5);
  input.profileRefs.runtime.ref = id(99);
  assert.equal(result.profileRefs.runtime.ref, id(11));
  for (const change of [
    { schemaVersion: 2 },
    { schemaVersion: "1" },
    { canonicalFormat: "json" },
    { admittedConfigurationDigest: id(1) },
  ]) {
    invalid(decodeWorkloadProfileUseV1, { ...use(), ...change });
  }
});

test("use binding rejects missing, duplicated, extra or externally approved role data", () => {
  for (const name of roleNames) {
    const missing = use();
    delete missing.profileRefs[name];
    invalid(decodeWorkloadProfileUseV1, missing);
    for (const field of ["ref", "version", "contentDigest"]) {
      const nestedMissing = use();
      delete nestedMissing.profileRefs[name][field];
      invalid(decodeWorkloadProfileUseV1, nestedMissing);
    }
    const extra = use();
    extra.profileRefs[name].qualified = true;
    invalid(decodeWorkloadProfileUseV1, extra);
  }
  const duplicate = use();
  duplicate.profileRefs.runtime.ref = duplicate.profileRefs.provider.ref;
  invalid(decodeWorkloadProfileUseV1, duplicate);
  const unknown = use();
  unknown.profileRefs.gateway = { ...unknown.profileRefs.provider };
  invalid(decodeWorkloadProfileUseV1, unknown);
  invalid(decodeWorkloadProfileUseV1, { ...use(), profileRefs: [] });
});

test("nested role getters and proxies cannot supply use-binding data", () => {
  let invoked = 0;
  const input = use();
  Object.defineProperty(input.profileRefs.runtime, "ref", {
    enumerable: true,
    get() {
      invoked += 1;
      return id(11);
    },
  });
  invalid(decodeWorkloadProfileUseV1, input);
  const withProxy = use();
  withProxy.profileRefs.identity = new Proxy(withProxy.profileRefs.identity, {
    getPrototypeOf() {
      invoked += 1;
      throw new Error("called");
    },
  });
  invalid(decodeWorkloadProfileUseV1, withProxy);
  assert.equal(invoked, 0);
});

test("ordinary prepare union distinguishes admit-null from exact replacement selection", () => {
  accepted(decodeWorkloadProfilePrepareEnvelopeV1, prepare(), WorkloadProfilePrepareSchemaV1);
  accepted(decodeWorkloadProfilePrepareEnvelopeV1, replace(), WorkloadProfilePrepareSchemaV1);
  for (const input of [
    { ...prepare(), expectedAdmission: selection() },
    { ...replace(), expectedAdmission: null },
    { ...replace(), expectedAdmission: { ...selection(), admissionVersion: "3" } },
    { ...prepare(), action: "withdraw" },
    { ...prepare(), action: "replace" },
    { ...prepare(), schemaVersion: 2 },
    { ...prepare(), component: "gateway" },
  ])
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, input);
});

test("prepare and withdrawal bodies exclude server-owned Installation and allocation fields", () => {
  for (const [key, value] of [
    ["installationId", scope().installationId],
    ["accountRef", "account"],
    ["principalRef", "principal"],
    ["manifestRef", id(1)],
    ["admissionRef", id(2)],
    ["operationDigest", digest],
    ["allocated", { manifestRef: id(1) }],
    ["terminalTemplateRef", id(24)],
    ["currentSession", "session"],
  ]) {
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, { ...prepare(), [key]: value });
    invalid(decodeWorkloadProfileWithdrawV1, { ...withdraw(), [key]: value });
  }
  for (const input of [
    { ...withdraw(), expectedAdmission: null },
    { ...withdraw(), action: "withdraw" },
    { ...withdraw(), namespaceId: scope().namespaceId },
  ]) {
    invalid(decodeWorkloadProfileWithdrawV1, input);
  }
});

test("manifest envelope is closed transport data and does not assert content admission", () => {
  const result = accepted(
    decodeWorkloadProfilePrepareEnvelopeV1,
    prepare(),
    WorkloadProfilePrepareSchemaV1,
  );
  assert.deepEqual(Object.keys(result.manifest).sort(), [
    "canonicalUtf8",
    "format",
    "manifestDigest",
  ]);
  // The envelope deliberately does not claim that {} is a complete manifest or
  // that the supplied syntactic digest matches it. The content owner checks both.
  assert.equal(result.manifest.canonicalUtf8, "{}");
  for (const change of [
    { format: "application/json" },
    { canonicalUtf8: "" },
    { canonicalUtf8: {} },
    { manifestDigest: "sha256:abc" },
    { admitted: true },
    { runtimeQualified: true },
  ])
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, {
      ...prepare(),
      manifest: { ...prepare().manifest, ...change },
    });
  for (const field of ["format", "canonicalUtf8", "manifestDigest"]) {
    const input = prepare();
    delete input.manifest[field];
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, input);
  }
});

test("envelope byte bound accepts exact 64 KiB ASCII and multibyte content only", () => {
  const encoder = new TextEncoder();
  for (const canonicalUtf8 of [
    '"' + "a".repeat(65_534) + '"',
    '"' + "é".repeat(32_767) + '"',
    '"' + "😀".repeat(16_383) + "é" + '"',
  ]) {
    assert.equal(encoder.encode(canonicalUtf8).byteLength, 65_536);
    const input = prepare();
    input.manifest.canonicalUtf8 = canonicalUtf8;
    accepted(decodeWorkloadProfilePrepareEnvelopeV1, input, WorkloadProfilePrepareSchemaV1);
    input.manifest.canonicalUtf8 += "a";
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, input);
  }
});

test("all decoded strings reject unpaired Unicode surrogates", () => {
  for (const canonicalUtf8 of ["\ud800", "\udfff", "\ud800x", "x\udc00"]) {
    const input = prepare();
    input.manifest.canonicalUtf8 = canonicalUtf8;
    invalid(decodeWorkloadProfilePrepareEnvelopeV1, input);
  }
  const input = prepare();
  input.manifest.canonicalUtf8 = '"😀"';
  accepted(decodeWorkloadProfilePrepareEnvelopeV1, input, WorkloadProfilePrepareSchemaV1);
  invalid(decodeWorkloadProfileSelectionV1, { ...selection(), manifestRef: "\ud800" });
});

test("invalidation records require exactly the next admission version", () => {
  for (const currentVersion of [2, 3, 5, 0, -1, 4.5, "4", Number.MAX_SAFE_INTEGER + 1]) {
    invalid(decodeProfileInvalidationRequestV1, { ...invalidation(), currentVersion });
  }
  accepted(
    decodeProfileInvalidationRequestV1,
    {
      ...invalidation(),
      previousVersion: Number.MAX_SAFE_INTEGER - 1,
      currentVersion: Number.MAX_SAFE_INTEGER,
    },
    ProfileInvalidationRequestSchemaV1,
  );
  invalid(decodeProfileInvalidationRequestV1, {
    ...invalidation(),
    previousVersion: Number.MAX_SAFE_INTEGER,
    currentVersion: Number.MAX_SAFE_INTEGER,
  });
  for (const reason of ["withdrawn", "replaced"]) {
    accepted(
      decodeProfileInvalidationRequestV1,
      { ...invalidation(), reason },
      ProfileInvalidationRequestSchemaV1,
    );
  }
  for (const change of [
    { kind: "runtime-fault" },
    { reason: "authority-loss" },
    { schemaVersion: 2 },
  ]) {
    invalid(decodeProfileInvalidationRequestV1, { ...invalidation(), ...change });
  }
});

for (const acceptedAt of [
  "",
  "not-a-time",
  "2024-02-30T23:59:59.123Z",
  "2023-02-29T23:59:59.123Z",
  "2024-13-01T23:59:59.123Z",
  "2024-02-29T24:00:00.000Z",
  "2024-02-29T23:60:00.000Z",
  "2024-02-29T23:59:59Z",
  "2024-02-29T23:59:59.12Z",
  "2024-02-29T23:59:59.1234Z",
  "2024-02-29t23:59:59.123z",
  "2024-02-29T23:59:59.123+00:00",
  "2024-02-29T23:59:59.123Z\n",
]) {
  test(`invalidation rejects invalid or noncanonical acceptedAt ${JSON.stringify(acceptedAt)}`, () => {
    invalid(decodeProfileInvalidationRequestV1, { ...invalidation(), acceptedAt });
  });
}

test("invalidation is a retained request and excludes stop-proof or caller authority claims", () => {
  const result = accepted(
    decodeProfileInvalidationRequestV1,
    invalidation(),
    ProfileInvalidationRequestSchemaV1,
  );
  assert.equal(result.kind, "profile-admission-invalidated");
  for (const [key, value] of [
    ["stopped", true],
    ["fenceAccepted", true],
    ["stopProof", digest],
    ["currentAuthority", true],
    ["runtimeGeneration", 4],
  ]) {
    invalid(decodeProfileInvalidationRequestV1, { ...invalidation(), [key]: value });
  }
});
