import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeRuntimeIdentityV1,
  RUNTIME_IDENTITY_DECODING_LIMITS_V1,
  RUNTIME_IDENTITY_VERIFICATION_FAILURES_V1,
  RUNTIME_IDENTITY_TRANSPORT_FAILURES_V1,
  RuntimeIdentitySchemasV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  RUNTIME_AUTHORITY_PURPOSES_V1,
  parseRuntimeAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  fixtureIdentityLimits,
  fixtureWorkloadDiagnostic,
} from "../fixtures/runtime-identity-v1/verifier-producer.ts";
import {
  consumerPurposeDisposition,
  consumerResultDisposition,
  fixturePurposeRequests,
  validatePurposeExample,
} from "../fixtures/runtime-identity-v1/stream-guard-consumer.ts";

const diagnostic = () => structuredClone(fixtureWorkloadDiagnostic);
const limits = () => structuredClone(fixtureIdentityLimits);
const invalid = (name, value) =>
  assert.deepEqual(decodeRuntimeIdentityV1(name, value), { kind: "invalid" });

test("the actual public decoder copies/freeze diagnostics without verifier authority", () => {
  const input = diagnostic();
  const result = decodeRuntimeIdentityV1("workloadDiagnostic", input);
  assert.equal(result.kind, "valid");
  assert.deepEqual(result.value, input);
  assert.ok(Object.isFrozen(result.value));
  assert.ok(Object.isFrozen(result.value.assignmentRef));
  assert.equal(Object.getOwnPropertySymbols(result.value).length, 0);
  assert.equal("transportBinding" in result.value, false);
  input.assignmentRef.id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal(result.value.assignmentRef.id, fixtureWorkloadDiagnostic.assignmentRef.id);
});

test("a labelled finite fixture parses; no admission or live limit selection is returned", () => {
  const result = decodeRuntimeIdentityV1("limits", limits());
  assert.equal(result.kind, "valid");
  assert.ok(Object.isFrozen(result.value));
  assert.deepEqual(Object.keys(result).sort(), ["kind", "value"]);
});

for (const name of [
  "verifiedWorkload",
  "transportBinding",
  "stream",
  "toString",
  "__proto__",
  "future",
]) {
  test(`no decoder schema constructs ${name}`, () => invalid(name, diagnostic()));
}
test("the schema registry includes only diagnostic/configuration/failure values", () => {
  assert.deepEqual(Object.keys(RuntimeIdentitySchemasV1).sort(), [
    "failure",
    "limits",
    "workloadDiagnostic",
  ]);
});

for (const [field, value] of [
  ["schemaVersion", 2],
  ["bindingVersion", 2],
  ["component", "mediator"],
  ["registrationVersion", 0],
  ["registrationVersion", 1.5],
  ["bundleSetVersion", Number.MAX_SAFE_INTEGER + 1],
  ["identityProfileRef", "profile/example\n"],
  ["recipientRef", ""],
  ["connectionRef", "a".repeat(201)],
  ["peerEvidenceRef", "https://example.org/?credential=value"],
  ["spiffeId", "\ud800"],
  ["verifiedAt", "2026-09-06T00:00:00Z"],
  ["verifiedAt", "2026-09-06T00:00:00.000+00:00"],
]) {
  test(`diagnostic rejects invalid ${field} (${String(value).slice(0, 30)})`, () => {
    const valueToDecode = diagnostic();
    valueToDecode[field] = value;
    invalid("workloadDiagnostic", valueToDecode);
  });
}
test("missing and unexpected fields fail closed at each object level", () => {
  for (const field of Object.keys(diagnostic())) {
    const value = diagnostic();
    delete value[field];
    invalid("workloadDiagnostic", value);
  }
  invalid("workloadDiagnostic", { ...diagnostic(), authenticated: true });
  const value = diagnostic();
  value.assignmentRef.authority = true;
  invalid("workloadDiagnostic", value);
});
test("calendar normalization is rejected independently of valid lifetime ordering", () => {
  const value = diagnostic();
  value.verifiedAt = "2026-02-30T00:00:00.000Z";
  value.expiresAt = "2026-03-03T00:00:00.000Z";
  assert.ok(Date.parse(value.verifiedAt) < Date.parse(value.expiresAt));
  invalid("workloadDiagnostic", value);
});
test("zero/reversed proof lifetime is rejected without checking a real clock", () => {
  for (const expiry of [fixtureWorkloadDiagnostic.verifiedAt, "2026-09-05T00:00:00.000Z"]) {
    invalid("workloadDiagnostic", { ...diagnostic(), expiresAt: expiry });
  }
  // A syntactically valid historical observation stays diagnostic; decoding claims no freshness.
  assert.equal(decodeRuntimeIdentityV1("workloadDiagnostic", diagnostic()).kind, "valid");
});
test("canonical assignment references reuse the existing UUID schema", () => {
  for (const id of [
    "not-a-uuid",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "aaaaaaaa-aaaa-aaaa-8aaa-aaaaaaaaaaaa",
  ]) {
    const value = diagnostic();
    value.assignmentRef.id = id;
    invalid("workloadDiagnostic", value);
  }
});

test("per-string UTF-8 bounds have a valid multibyte control", () => {
  const value = diagnostic();
  value.spiffeId = "界".repeat(682);
  assert.equal(decodeRuntimeIdentityV1("workloadDiagnostic", value).kind, "valid");
  value.spiffeId += "界";
  invalid("workloadDiagnostic", value);
});
test("aggregate bytes are bounded independently of per-field lengths", () => {
  const value = diagnostic();
  value.spiffeId = "x".repeat(2048);
  for (const key of [
    "identityProfileRef",
    "registrationId",
    "peerEvidenceRef",
    "recipientRef",
    "connectionRef",
  ])
    value[key] = "a".repeat(200);
  assert.ok(
    Buffer.byteLength(JSON.stringify(value)) < RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxBytes,
  );
  assert.equal(decodeRuntimeIdentityV1("workloadDiagnostic", value).kind, "valid");
  // JSON escaping increases aggregate encoded bytes while the field remains exactly 2 KiB.
  value.spiffeId = "\\".repeat(2048);
  assert.ok(
    Buffer.byteLength(JSON.stringify(value)) > RUNTIME_IDENTITY_DECODING_LIMITS_V1.maxBytes,
  );
  invalid("workloadDiagnostic", value);
});
test("accessors, hidden/symbol fields and nonplain objects cannot bypass a closed schema", () => {
  let reads = 0;
  const accessor = diagnostic();
  Object.defineProperty(accessor, "recipientRef", {
    enumerable: true,
    get() {
      reads++;
      return "recipient/example";
    },
  });
  invalid("workloadDiagnostic", accessor);
  assert.equal(reads, 0);
  const hidden = diagnostic();
  Object.defineProperty(hidden, "extra", { value: 1 });
  invalid("workloadDiagnostic", hidden);
  const symbol = diagnostic();
  symbol[Symbol("extra")] = true;
  invalid("workloadDiagnostic", symbol);
  const inherited = Object.create(diagnostic());
  invalid("workloadDiagnostic", inherited);
  invalid("workloadDiagnostic", new Date());
});
test("cyclic, sparse/named arrays and deeply nested inputs are bounded failures", () => {
  const cycle = diagnostic();
  cycle.assignmentRef = cycle;
  invalid("workloadDiagnostic", cycle);
  const named = [];
  named.extra = "outside-json";
  invalid("workloadDiagnostic", named);
  invalid("workloadDiagnostic", new Array(2));
  let nested = {};
  for (let i = 0; i < 30; i++) nested = { nested };
  invalid("workloadDiagnostic", nested);
});

test("every local limits field is required and unknown fields are refused", () => {
  for (const field of Object.keys(limits())) {
    const value = limits();
    delete value[field];
    invalid("limits", value);
  }
  invalid("limits", { ...limits(), allowCachedAuthority: true });
});
for (const value of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`finite positive limits reject ${String(value)}`, () => {
    invalid("limits", { ...limits(), maxPendingChecks: value });
    invalid("limits", { ...limits(), streamCloseDeadlineMs: value });
  });
}
for (const field of [
  "runtimeEvidenceMaxAgeMs",
  "policyEvidenceMaxAgeMs",
  "identityEvidenceMaxAgeMs",
]) {
  test(`${field} preserves the existing observation ceiling`, () => {
    assert.equal(decodeRuntimeIdentityV1("limits", { ...limits(), [field]: 15000 }).kind, "valid");
    invalid("limits", { ...limits(), [field]: 15001 });
  });
}
test("lookup, recheck and clock bounds retain existing runtime authority ceilings", () => {
  for (const [field, ceiling] of [
    ["assignmentDeadlineMs", 3000],
    ["policyDeadlineMs", 3000],
    ["streamRecheckMs", 5000],
    ["clockSkewAllowanceMs", 2000],
  ]) {
    assert.equal(
      decodeRuntimeIdentityV1("limits", { ...limits(), [field]: ceiling }).kind,
      "valid",
    );
    invalid("limits", { ...limits(), [field]: ceiling + 1 });
  }
  assert.equal(
    decodeRuntimeIdentityV1("limits", { ...limits(), clockSkewAllowanceMs: 0 }).kind,
    "valid",
  );
});
test("renewal, polling, buffering and aggregate numeric limits must be consistent", () => {
  for (const patch of [
    { renewBeforeExpiryMs: 60000 },
    { renewalRetryBudgetMs: 10001 },
    { identityHealthPollMs: 2001 },
    { connectionMaxAgeMs: 999 },
    { maxFrameBytes: 4097 },
    { maxConnections: Number.MAX_SAFE_INTEGER },
    { maxBufferedBytes: Number.MAX_SAFE_INTEGER },
  ])
    invalid("limits", { ...limits(), ...patch });
});

test("all closed failure codes decode without raw provider/certificate details", () => {
  for (const [kind, codes] of [
    ["verification-failure", RUNTIME_IDENTITY_VERIFICATION_FAILURES_V1],
    ["transport-failure", RUNTIME_IDENTITY_TRANSPORT_FAILURES_V1],
  ]) {
    for (const reasonCode of codes) {
      const value = { schemaVersion: 1, kind, reasonCode, requestRef: "request/example" };
      assert.equal(decodeRuntimeIdentityV1("failure", value).kind, "valid");
      invalid("failure", { ...value, rawProviderError: "opaque-sensitive-text" });
    }
  }
});
test("domain and transport errors cannot be swapped or upgraded into currentness", () => {
  invalid("failure", {
    schemaVersion: 1,
    kind: "verification-failure",
    reasonCode: "cancelled",
    requestRef: "r",
  });
  invalid("failure", {
    schemaVersion: 1,
    kind: "transport-failure",
    reasonCode: "peer-expired",
    requestRef: "r",
  });
  invalid("failure", {
    schemaVersion: 1,
    kind: "transport-failure",
    reasonCode: "current",
    requestRef: "r",
  });
  invalid("failure", {
    schemaVersion: 1,
    kind: "transport-failure",
    reasonCode: "deadline-exceeded",
    requestRef: "r",
    result: "current",
  });
});

test("independent consumer covers the exact seven canonical purposes and seven results", () => {
  assert.deepEqual(
    Object.keys(consumerPurposeDisposition).sort(),
    [...RUNTIME_AUTHORITY_PURPOSES_V1].sort(),
  );
  assert.deepEqual(Object.keys(consumerResultDisposition).sort(), [
    "candidate-eligible",
    "cleanup-eligible",
    "current",
    "not-current",
    "not-visible",
    "pending",
    "unavailable",
  ]);
  for (const request of fixturePurposeRequests) {
    const parsed = validatePurposeExample(request);
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.ok(Object.isFrozen(parsed));
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), request);
  }
});
test("canonical purpose requests keep preaccepted responsibilities and closed suboperations", () => {
  for (const request of fixturePurposeRequests) {
    assert.throws(() => validatePurposeExample({ ...request, purpose: "arbitrary-effect" }));
    if ("operationRef" in request) {
      const noOperation = { ...request };
      delete noOperation.operationRef;
      assert.throws(() => validatePurposeExample(noOperation));
    }
  }
  const restore = fixturePurposeRequests.find((x) => x.purpose === "completed-context-restore");
  assert.throws(() => validatePurposeExample({ ...restore, requestedSuboperation: "resume" }));
});
test("actual canonical result decoding rejects incomplete current claims and transport-shaped success", () => {
  const pending = {
    schemaVersion: 1,
    result: "pending",
    purpose: "readiness-probe",
    reasonCode: "evidence-incomplete",
    evaluatedAt: "2026-09-06T00:00:00.000Z",
    requestRef: "request/example",
  };
  const parsed = parseRuntimeAuthorityV1("resolveResult", pending);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), pending);
  assert.throws(() =>
    parseRuntimeAuthorityV1("resolveResult", {
      ...pending,
      result: "current",
      reasonCode: "conditions-satisfied",
    }),
  );
  assert.throws(() =>
    parseRuntimeAuthorityV1("resolveResult", {
      schemaVersion: 1,
      kind: "transport-failure",
      reasonCode: "deadline-exceeded",
      requestRef: "r",
    }),
  );
});
