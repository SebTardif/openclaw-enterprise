import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeWorkInvocationValueV2,
  decodeWorkOwnerValueV2,
} from "../../packages/contracts/src/work-authority-v2.ts";

const installationId = "ins_11111111-1111-4111-8111-111111111111";
const owner = () => ({ kind: "service", principalId: "principal:service", installationId });
const invocation = () => ({
  actorPrincipalId: "principal:human",
  sourceInvocationRef: "invocation:original",
  sourceEventRef: "event:original",
  originalTargetRef: "conversation:original",
  invocationDecisionRef: "decision:original",
});

test("service owner decodes as a diagnostic snapshot", () => {
  const input = owner();
  const result = decodeWorkOwnerValueV2(input);
  assert.equal(result.kind, "decoded");
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value, input);
});

test("user owner remains representable without service admission", () => {
  const input = { ...owner(), kind: "user", principalId: "principal:human" };
  assert.deepEqual(decodeWorkOwnerValueV2(input), { kind: "decoded", value: input });
});

test("owner kind uses the diagnostic vocabulary", () => {
  for (const kind of ["principal", "service_principal", "service_account", "SERVICE", ""]) {
    assert.deepEqual(decodeWorkOwnerValueV2({ ...owner(), kind }), { kind: "invalid" });
  }
});

test("Installation identity keeps its exact existing typed grammar", () => {
  for (const id of [
    "installation:one",
    "ns_11111111-1111-4111-8111-111111111111",
    "ins_11111111-1111-1111-8111-111111111111",
    "ins_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa".toUpperCase(),
    `${installationId}\n`,
  ]) {
    assert.equal(decodeWorkOwnerValueV2({ ...owner(), installationId: id }).kind, "invalid");
  }
});

test("principal reference accepts the original ASCII punctuation and length bounds", () => {
  for (const principalId of ["a", "A9._:/-", "a".repeat(200)]) {
    assert.equal(decodeWorkOwnerValueV2({ ...owner(), principalId }).kind, "decoded");
  }
  for (const principalId of ["", "a".repeat(201), "-a", "a b", "a\nb", "a\n", "é", "a@b"]) {
    assert.equal(decodeWorkOwnerValueV2({ ...owner(), principalId }).kind, "invalid");
  }
});

test("owner fields cannot be omitted or replaced by extra fields", () => {
  for (const field of Object.keys(owner())) {
    const input = owner();
    delete input[field];
    assert.equal(decodeWorkOwnerValueV2(input).kind, "invalid");
    input.unrecognized = "replacement";
    assert.equal(decodeWorkOwnerValueV2(input).kind, "invalid");
  }
  assert.equal(decodeWorkOwnerValueV2({ ...owner(), allowed: true }).kind, "invalid");
});

test("ServiceAccount resource and Identity object shapes are not owner values", () => {
  for (const input of [
    { kind: "service_account", id: "sa_11111111-1111-4111-8111-111111111111" },
    { kind: "service_principal", id: "principal:service", installationId },
    { ...owner(), serviceAccountId: "sa_11111111-1111-4111-8111-111111111111" },
  ]) {
    assert.equal(decodeWorkOwnerValueV2(input).kind, "invalid");
  }
});

test("invocation retains the exact five original provenance fields", () => {
  const input = invocation();
  const result = decodeWorkInvocationValueV2(input);
  assert.equal(result.kind, "decoded");
  assert.deepEqual(result.value, input);
  assert.notEqual(result.value, input);
});

test("human invocation and service owner may have distinct principal references", () => {
  const own = decodeWorkOwnerValueV2(owner());
  const invoked = decodeWorkInvocationValueV2(invocation());
  assert.equal(own.kind, "decoded");
  assert.equal(invoked.kind, "decoded");
  assert.notEqual(own.value.principalId, invoked.value.actorPrincipalId);
});

test("provenance references have bounds on every field", () => {
  for (const field of Object.keys(invocation())) {
    for (const value of ["a", "A9._:/-", "a".repeat(200)]) {
      assert.equal(
        decodeWorkInvocationValueV2({ ...invocation(), [field]: value }).kind,
        "decoded",
      );
    }
    for (const value of ["", "a".repeat(201), ":first", "a b", "a\nb", "a\r\n", "é"]) {
      assert.equal(
        decodeWorkInvocationValueV2({ ...invocation(), [field]: value }).kind,
        "invalid",
      );
    }
  }
});

test("invocation fields cannot be omitted or supplemented with claimed permission", () => {
  for (const field of Object.keys(invocation())) {
    const input = invocation();
    delete input[field];
    assert.equal(decodeWorkInvocationValueV2(input).kind, "invalid");
  }
  assert.equal(decodeWorkInvocationValueV2({ ...invocation(), current: true }).kind, "invalid");
});

test("owner and invocation shapes cannot be used interchangeably or merged", () => {
  assert.equal(decodeWorkOwnerValueV2(invocation()).kind, "invalid");
  assert.equal(decodeWorkInvocationValueV2(owner()).kind, "invalid");
  assert.equal(decodeWorkOwnerValueV2({ ...owner(), ...invocation() }).kind, "invalid");
  assert.equal(decodeWorkInvocationValueV2({ ...owner(), ...invocation() }).kind, "invalid");
});

test("owner principal and Installation fields cannot be swapped", () => {
  const input = owner();
  [input.principalId, input.installationId] = [input.installationId, input.principalId];
  assert.equal(decodeWorkOwnerValueV2(input).kind, "invalid");
});

test("reference syntax does not invent cross-field uniqueness or identity authenticity", () => {
  const sameRefs = Object.fromEntries(Object.keys(invocation()).map((field) => [field, "same"]));
  assert.equal(decodeWorkInvocationValueV2(sameRefs).kind, "decoded");
  // A reference's text cannot establish which principal an accepting owner resolves.
  assert.equal(decodeWorkOwnerValueV2({ ...owner(), principalId: "unresolved" }).kind, "decoded");
});

test("neither decoder coerces primitives or boxed strings", () => {
  for (const input of [null, undefined, true, 1, "{}", [], new Date(0)]) {
    assert.equal(decodeWorkOwnerValueV2(input).kind, "invalid");
    assert.equal(decodeWorkInvocationValueV2(input).kind, "invalid");
  }
  assert.equal(
    decodeWorkOwnerValueV2({ ...owner(), principalId: new String("a") }).kind,
    "invalid",
  );
  assert.equal(decodeWorkInvocationValueV2({ ...invocation(), sourceEventRef: 1 }).kind, "invalid");
});

test("oversized input strings are rejected without truncation", () => {
  const oversized = "a".repeat(16 * 1024 + 1);
  assert.equal(decodeWorkOwnerValueV2({ ...owner(), principalId: oversized }).kind, "invalid");
  assert.equal(
    decodeWorkInvocationValueV2({ ...invocation(), sourceInvocationRef: oversized }).kind,
    "invalid",
  );
});

test("null-prototype data and frozen input decode into detached immutable snapshots", () => {
  for (const [make, decoder] of [
    [owner, decodeWorkOwnerValueV2],
    [invocation, decodeWorkInvocationValueV2],
  ]) {
    const input = Object.freeze(Object.assign(Object.create(null), make()));
    const result = decoder(input);
    assert.equal(result.kind, "decoded");
    assert.deepEqual(result.value, make());
    assert.notEqual(result.value, input);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.value));
  }
});

test("mutation of input after decoding cannot alter either accepted snapshot", () => {
  const own = owner();
  const invoked = invocation();
  const decodedOwner = decodeWorkOwnerValueV2(own);
  const decodedInvocation = decodeWorkInvocationValueV2(invoked);
  assert.equal(decodedOwner.kind, "decoded");
  assert.equal(decodedInvocation.kind, "decoded");
  own.principalId = "different";
  invoked.originalTargetRef = "different";
  assert.equal(decodedOwner.value.principalId, "principal:service");
  assert.equal(decodedInvocation.value.originalTargetRef, "conversation:original");
  assert.throws(() => (decodedOwner.value.kind = "user"), TypeError);
  assert.throws(() => (decodedInvocation.value.originalTargetRef = "different"), TypeError);
});

test("own getters and setters are rejected without running them", () => {
  let calls = 0;
  for (const [make, decoder, field] of [
    [owner, decodeWorkOwnerValueV2, "principalId"],
    [invocation, decodeWorkInvocationValueV2, "sourceEventRef"],
  ]) {
    const input = make();
    Object.defineProperty(input, field, {
      enumerable: true,
      get() {
        calls += 1;
        throw new Error("getter must not run");
      },
      set() {
        calls += 1;
      },
    });
    assert.equal(decoder(input).kind, "invalid");
  }
  assert.equal(calls, 0);
});

test("toJSON hooks are rejected before serialization", () => {
  let calls = 0;
  const input = invocation();
  Object.defineProperty(input, "toJSON", {
    enumerable: true,
    get() {
      calls += 1;
      return () => invocation();
    },
  });
  assert.equal(decodeWorkInvocationValueV2(input).kind, "invalid");
  assert.equal(calls, 0);
});

test("symbols and non-enumerable fields are rejected", () => {
  for (const [make, decoder, field] of [
    [owner, decodeWorkOwnerValueV2, "principalId"],
    [invocation, decodeWorkInvocationValueV2, "sourceEventRef"],
  ]) {
    const symbolInput = make();
    symbolInput[Symbol("extra")] = "ignored";
    assert.equal(decoder(symbolInput).kind, "invalid");
    const hiddenInput = make();
    Object.defineProperty(hiddenInput, field, { enumerable: false });
    assert.equal(decoder(hiddenInput).kind, "invalid");
  }
});

test("inherited fields and custom prototypes are not plain diagnostic data", () => {
  for (const [make, decoder] of [
    [owner, decodeWorkOwnerValueV2],
    [invocation, decodeWorkInvocationValueV2],
  ]) {
    assert.equal(decoder(Object.create(make())).kind, "invalid");
    assert.equal(decoder(Object.assign(Object.create({}), make())).kind, "invalid");
  }
});

test("nested containers, cycles and sparse arrays cannot occupy reference fields", () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [{ nested: "a" }, cycle, ["a"], new Array(2)]) {
    assert.equal(decodeWorkOwnerValueV2({ ...owner(), principalId: value }).kind, "invalid");
    assert.equal(
      decodeWorkInvocationValueV2({ ...invocation(), sourceEventRef: value }).kind,
      "invalid",
    );
  }
});

test("reflection failure returns invalid without exposing an exception", () => {
  const { proxy, revoke } = Proxy.revocable(owner(), {});
  revoke();
  assert.deepEqual(decodeWorkOwnerValueV2(proxy), { kind: "invalid" });
});
