import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeRootWorkIdentityV1,
  encodeRootWorkIdentityV1,
  digestRootWorkIdentityV1,
} from "../../packages/contracts/src/index.ts";

// Real public DATA codec only. No fake Work/IAM owner or affirmative authority test.
function packet() {
  return {
    schemaVersion: "root-work-v1",
    installationId: "installation-1",
    namespaceId: "namespace-1",
    agentId: "agent-1",
    agentRevisionId: "revision-1",
    rootWorkId: "root-1",
    executionId: "execution-1",
    requesterPrincipalId: "requester-1",
    servicePrincipalId: "service-1",
    assignmentId: "assignment-1",
    assignmentGeneration: "generation-1",
    selectedIam: { driverId: "iam-1", configurationGeneration: "configuration-1" },
    immutableCeilingDigest: "a".repeat(64),
    durationPolicy: {
      policyId: "duration-1",
      policyVersion: "1",
      kind: "finite",
      originalDeadline: 2000,
    },
    policyVersion: "policy-1",
    cancellation: {
      ownerPrincipalId: "canceller-1",
      authorizationId: "cancel-auth-1",
      dependencyIds: ["dependency-b", "dependency-a"],
    },
    admittedAt: 1000,
  };
}

const expectedCanonical =
  '{"schemaVersion":"root-work-v1","installationId":"installation-1","namespaceId":"namespace-1","agentId":"agent-1","agentRevisionId":"revision-1","rootWorkId":"root-1","executionId":"execution-1","requesterPrincipalId":"requester-1","servicePrincipalId":"service-1","assignmentId":"assignment-1","assignmentGeneration":"generation-1","selectedIam":{"driverId":"iam-1","configurationGeneration":"configuration-1"},"immutableCeilingDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","durationPolicy":{"policyId":"duration-1","policyVersion":"1","kind":"finite","originalDeadline":2000},"policyVersion":"policy-1","cancellation":{"ownerPrincipalId":"canceller-1","authorizationId":"cancel-auth-1","dependencyIds":["dependency-b","dependency-a"]},"admittedAt":1000}';

const entrypoints = [decodeRootWorkIdentityV1, encodeRootWorkIdentityV1, digestRootWorkIdentityV1];
const invalidData = (error) =>
  error instanceof TypeError && error.message === "Invalid root-work-v1 data.";

function reject(value, context) {
  // Public encoding/digest also validate runtime inputs, including typed imitations.
  for (const entrypoint of entrypoints) {
    assert.throws(() => entrypoint(value), invalidData, context);
  }
}

test("root DATA public codec has one canonical UTF-8 encoding and SHA-256", () => {
  const original = packet();
  const shuffled = Object.fromEntries(Object.entries(original).reverse());
  shuffled.selectedIam = Object.fromEntries(Object.entries(original.selectedIam).reverse());
  shuffled.durationPolicy = Object.fromEntries(Object.entries(original.durationPolicy).reverse());
  shuffled.cancellation = Object.fromEntries(Object.entries(original.cancellation).reverse());
  assert.equal(encodeRootWorkIdentityV1(shuffled), expectedCanonical);
  assert.equal(
    digestRootWorkIdentityV1(shuffled),
    createHash("sha256").update(expectedCanonical, "utf8").digest("hex"),
  );
  assert.deepEqual(decodeRootWorkIdentityV1(JSON.parse(expectedCanonical)), original);
  assert.equal(encodeRootWorkIdentityV1(decodeRootWorkIdentityV1(original)), expectedCanonical);
  // Dependency order is retained identity data, not silently sorted or deduplicated.
  const reordered = packet();
  reordered.cancellation.dependencyIds.reverse();
  assert.notEqual(digestRootWorkIdentityV1(reordered), digestRootWorkIdentityV1(original));
});

test("root DATA decode detaches and deeply freezes every retained field", () => {
  const original = packet();
  const decoded = decodeRootWorkIdentityV1(original);
  original.servicePrincipalId = "replacement";
  original.selectedIam.driverId = "replacement";
  original.durationPolicy.originalDeadline = 3000;
  original.cancellation.ownerPrincipalId = "replacement";
  original.cancellation.dependencyIds.push("replacement");
  assert.equal(encodeRootWorkIdentityV1(decoded), expectedCanonical);
  for (const value of [
    decoded,
    decoded.selectedIam,
    decoded.durationPolicy,
    decoded.cancellation,
    decoded.cancellation.dependencyIds,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => {
    decoded.servicePrincipalId = "replacement";
  }, TypeError);
  assert.throws(() => {
    decoded.selectedIam.configurationGeneration = "replacement";
  }, TypeError);
  assert.throws(() => decoded.cancellation.dependencyIds.push("replacement"), TypeError);
  const nullPrototype = Object.assign(Object.create(null), packet());
  for (const field of ["selectedIam", "durationPolicy", "cancellation"]) {
    nullPrototype[field] = Object.assign(Object.create(null), nullPrototype[field]);
  }
  assert.equal(
    encodeRootWorkIdentityV1(decodeRootWorkIdentityV1(nullPrototype)),
    expectedCanonical,
  );
});

test("root DATA decode rejects malformed and foreign schema families", () => {
  for (const value of [
    null,
    undefined,
    false,
    1,
    expectedCanonical,
    [],
    new Date(),
    new Map(),
    { ...packet(), schemaVersion: "root-work-v2" },
    { ...packet(), schemaVersion: "runtime-authentication-v1" },
  ]) {
    reject(value, "non-record or foreign schema");
  }
  class ForeignPacket {
    constructor() {
      Object.assign(this, packet());
    }
  }
  reject(new ForeignPacket(), "class-bearing record");
  const inherited = Object.create(packet());
  reject(inherited, "inherited required fields");
  reject(Object.assign(Object.create({ foreign: true }), packet()), "custom prototype");
});

test("root DATA decode closes required, unknown, symbolic and hidden keys at every record", () => {
  for (const field of Object.keys(packet())) {
    const candidate = packet();
    delete candidate[field];
    reject(candidate, `missing ${field}`);
  }
  for (const select of [
    (p) => p,
    (p) => p.selectedIam,
    (p) => p.durationPolicy,
    (p) => p.cancellation,
  ]) {
    for (const key of ["unknown", "__proto__", Symbol("foreign")]) {
      const candidate = packet();
      Object.defineProperty(select(candidate), key, { value: "foreign", enumerable: true });
      reject(candidate, "excess own field");
    }
    const candidate = packet();
    const record = select(candidate);
    const key = Object.keys(record)[0];
    Object.defineProperty(record, key, { value: record[key], enumerable: false });
    reject(candidate, "hidden required field");
  }
});

test("root DATA decode rejects accessors without invoking getters or toJSON", () => {
  let calls = 0;
  for (const select of [
    (p) => p,
    (p) => p.selectedIam,
    (p) => p.durationPolicy,
    (p) => p.cancellation,
  ]) {
    const candidate = packet();
    const record = select(candidate);
    const key = Object.keys(record)[0];
    Object.defineProperty(record, key, {
      get() {
        calls += 1;
        throw new Error("unsafe getter");
      },
      enumerable: true,
    });
    reject(candidate, "accessor field");
  }
  const candidate = packet();
  candidate.toJSON = () => {
    calls += 1;
    return packet();
  };
  reject(candidate, "serialization hook");
  const indexed = packet();
  Object.defineProperty(indexed.cancellation.dependencyIds, "0", {
    get() {
      calls += 1;
      return "dependency-b";
    },
    enumerable: true,
  });
  reject(indexed, "array accessor");
  assert.equal(calls, 0);
});

test("root DATA public codec rejects proxies without invoking traps", async (t) => {
  const positions = [
    [],
    ["selectedIam"],
    ["durationPolicy"],
    ["cancellation"],
    ["cancellation", "dependencyIds"],
  ];
  for (const path of positions) {
    for (const variant of ["transparent", "throwing", "revoked"]) {
      for (const entrypoint of entrypoints) {
        await t.test(`${path.join(".") || "root"} ${variant} ${entrypoint.name}`, () => {
          let candidate = packet();
          const parent = path.slice(0, -1).reduce((value, key) => value[key], candidate);
          const key = path.at(-1);
          const target = key === undefined ? candidate : parent[key];
          let calls = 0;
          const trap = () => {
            calls += 1;
            throw new Error("unsafe proxy trap");
          };
          const handler =
            variant === "throwing"
              ? { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap }
              : {};
          const { proxy, revoke } = Proxy.revocable(target, handler);
          if (variant === "revoked") revoke();
          if (key === undefined) candidate = proxy;
          else parent[key] = proxy;
          // Rejection must precede reflection, including Array.isArray on revoked proxies.
          try {
            assert.throws(() => entrypoint(candidate), invalidData);
          } finally {
            assert.equal(calls, 0, "codec must not invoke input Proxy traps");
          }
        });
      }
    }
  }
});

test("root DATA identifiers enforce nonempty well-formed bounded UTF-8", () => {
  const invalidIds = [
    "",
    " ",
    "with space",
    "with\nnewline",
    "\u0000",
    "\u007f",
    "\ud800",
    "\udfff",
    "a".repeat(257),
    "é".repeat(129),
    1,
    null,
  ];
  const outerIds = [
    "installationId",
    "namespaceId",
    "agentId",
    "agentRevisionId",
    "rootWorkId",
    "executionId",
    "requesterPrincipalId",
    "servicePrincipalId",
    "assignmentId",
    "assignmentGeneration",
    "policyVersion",
  ];
  for (const field of outerIds) {
    for (const value of invalidIds) reject({ ...packet(), [field]: value }, `invalid ${field}`);
  }
  for (const [nested, field] of [
    ["selectedIam", "driverId"],
    ["selectedIam", "configurationGeneration"],
    ["durationPolicy", "policyId"],
    ["durationPolicy", "policyVersion"],
    ["cancellation", "ownerPrincipalId"],
    ["cancellation", "authorizationId"],
  ]) {
    for (const value of invalidIds) {
      const candidate = packet();
      candidate[nested][field] = value;
      reject(candidate, `invalid ${nested}.${field}`);
    }
  }
  for (const value of [
    "a".repeat(256),
    "é".repeat(128),
    "😀".repeat(64),
    "provider/Case:opaque-id",
  ]) {
    const candidate = { ...packet(), rootWorkId: value };
    assert.equal(decodeRootWorkIdentityV1(candidate).rootWorkId, value);
  }
});

test("root DATA digests require exact lowercase SHA-256", () => {
  for (const value of [
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    "sha256:" + "a".repeat(64),
    1,
    null,
  ]) {
    reject({ ...packet(), immutableCeilingDigest: value }, "malformed digest");
  }
});

test("root DATA duration preserves explicit finite or uncapped original horizons", () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    -1,
    -0,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1000",
    null,
  ]) {
    reject({ ...packet(), admittedAt: value }, "invalid admitted timestamp");
    const candidate = packet();
    candidate.durationPolicy.originalDeadline = value;
    reject(candidate, "invalid finite horizon");
  }
  for (const value of [999, 1000]) {
    const candidate = packet();
    candidate.durationPolicy.originalDeadline = value;
    reject(candidate, "horizon no later than admission");
  }
  const finite = packet();
  finite.admittedAt = 0;
  finite.durationPolicy.originalDeadline = Number.MAX_SAFE_INTEGER;
  assert.equal(
    decodeRootWorkIdentityV1(finite).durationPolicy.originalDeadline,
    Number.MAX_SAFE_INTEGER,
  );
  const uncapped = packet();
  uncapped.durationPolicy = {
    policyId: "duration-1",
    policyVersion: "1",
    kind: "uncapped",
    originalDeadline: null,
  };
  assert.deepEqual(decodeRootWorkIdentityV1(uncapped).durationPolicy, uncapped.durationPolicy);
  for (const duration of [
    { ...uncapped.durationPolicy, originalDeadline: 2000 },
    { ...finite.durationPolicy, kind: "unbounded" },
  ]) {
    reject(
      { ...packet(), durationPolicy: duration },
      "crossed or unrecognized policy discriminant",
    );
  }
});

test("root DATA cancellation dependencies are exact bounded dense immutable lists", () => {
  const candidate = packet();
  candidate.cancellation.dependencyIds = Array.from(
    { length: 64 },
    (_, index) => `dependency-${index}`,
  );
  const decoded = decodeRootWorkIdentityV1(candidate);
  assert.equal(decoded.cancellation.dependencyIds.length, 64);
  candidate.cancellation.dependencyIds.push("dependency-64");
  reject(candidate, "too many dependencies");
  for (const value of [
    ["duplicate", "duplicate"],
    [""],
    ["é".repeat(129)],
    Array(2),
    new Set(),
    null,
  ]) {
    const invalid = packet();
    invalid.cancellation.dependencyIds = value;
    reject(invalid, "malformed dependency list");
  }
  for (const key of ["unknown", Symbol("foreign")]) {
    const invalid = packet();
    Object.defineProperty(invalid.cancellation.dependencyIds, key, { value: 1 });
    reject(invalid, "array excess field");
  }
  const subclass = packet();
  class ForeignList extends Array {}
  subclass.cancellation.dependencyIds = new ForeignList("dependency-b");
  reject(subclass, "array subclass");
  const empty = packet();
  empty.cancellation.dependencyIds = [];
  assert.deepEqual(decodeRootWorkIdentityV1(empty).cancellation.dependencyIds, []);
});
