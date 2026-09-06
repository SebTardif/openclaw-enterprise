import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  compareRecoveryCheckpointV1,
  compareRecoveryProducerTupleV1,
  evaluateSameBuildRecoveryPreflightV1,
} from "@openclaw-enterprise/occ/persistence/same-build-recovery-preflight-v1";
import {
  canonicalBytes,
  checkpoint,
  input,
  tuple,
} from "../fixtures/same-build-recovery-preflight-v1/values.mjs";

const incompatible = (result, reasonCode) => {
  assert.equal(result.kind, "incompatible");
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(Object.isFrozen(result), true);
};

test("identical existing producer tuples have an inert exact descriptor match", () => {
  assert.deepEqual(compareRecoveryProducerTupleV1(tuple(), tuple()), {
    scope: "producer-tuple",
    kind: "compatible",
    reasonCode: "exact-descriptor-match",
  });
});

for (const field of [
  "enterpriseCommit",
  "upstreamCommit",
  "codexCommit",
  "nativeImportAdapterDigest",
  "artifactLedgerRef",
]) {
  test(`changed material ${field} cannot match the original tuple`, () => {
    const changed = tuple();
    changed[field] =
      field === "artifactLedgerRef"
        ? "artifact-ledger/fixture-build-2"
        : "a".repeat(changed[field].length);
    incompatible(compareRecoveryProducerTupleV1(tuple(), changed), "descriptor-mismatch");
  });
}

for (const [field, changed] of Object.entries({
  codexVersion: "0.154.0",
  gatewayProtocol: 5,
  nativeStateSchema: 16,
  nativeAgentSchema: 20,
  adapterSchema: 2,
  contextFormat: "completed-context-text-v2",
  nativeImportContract: 2,
})) {
  test(`unsupported ${field} fails even if both supplied versions agree`, () => {
    const value = { ...tuple(), [field]: changed };
    incompatible(compareRecoveryProducerTupleV1(value, value), "invalid-descriptor");
  });
}

for (const field of Object.keys(tuple())) {
  test(`missing tuple field ${field} never compares equal to another missing field`, () => {
    const value = tuple();
    delete value[field];
    incompatible(compareRecoveryProducerTupleV1(value, value), "invalid-descriptor");
  });
}

test("an exact expected checkpoint compares its full metadata and original canonical bytes", () => {
  assert.equal(
    createHash("sha256").update(canonicalBytes).digest("hex"),
    checkpoint().contentDigest,
  );
  assert.deepEqual(compareRecoveryCheckpointV1(checkpoint(), checkpoint(), canonicalBytes), {
    scope: "checkpoint",
    kind: "compatible",
    reasonCode: "exact-descriptor-match",
  });
});

for (const field of Object.keys(checkpoint()).filter((field) => field !== "producerTuple")) {
  test(`changed checkpoint ${field} is rejected`, () => {
    const changed = checkpoint();
    const value = changed[field];
    if (field === "schemaVersion") changed[field] = 2;
    else if (field === "contentDigest" || field === "admittedConfigurationDigest")
      changed[field] = "a".repeat(64);
    else if (typeof value === "number") changed[field] += 1;
    else changed[field] = `${value}-changed`;
    assert.equal(
      compareRecoveryCheckpointV1(checkpoint(), changed, canonicalBytes).kind,
      "incompatible",
    );
  });
}

for (const field of Object.keys(checkpoint())) {
  test(`truncated checkpoint missing ${field} is rejected even on both sides`, () => {
    const value = checkpoint();
    delete value[field];
    incompatible(compareRecoveryCheckpointV1(value, value, canonicalBytes), "invalid-descriptor");
  });
}

for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "7", 7n]) {
  test(`invalid completed sequence ${String(value)} cannot pass through numeric coercion`, () => {
    const ref = { ...checkpoint(), completionSequence: value };
    incompatible(compareRecoveryCheckpointV1(ref, ref, canonicalBytes), "invalid-descriptor");
  });
}

test("maximum safe completion sequence is preserved without increment, wrap or truncation", () => {
  const ref = { ...checkpoint(), completionSequence: Number.MAX_SAFE_INTEGER };
  assert.equal(compareRecoveryCheckpointV1(ref, ref, canonicalBytes).kind, "compatible");
});

for (const field of ["byteLength", "itemCount"]) {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    test(`${field} rejects nonintegral, negative and unsafe input ${String(value)}`, () => {
      const ref = { ...checkpoint(), [field]: value };
      incompatible(compareRecoveryCheckpointV1(ref, ref, canonicalBytes), "invalid-descriptor");
    });
  }
}

test("item count and canonical size overflow remain incompatible", () => {
  for (const change of [{ itemCount: 16_385 }, { byteLength: 8 * 1024 * 1024 + 1 }]) {
    const ref = { ...checkpoint(), ...change };
    incompatible(compareRecoveryCheckpointV1(ref, ref, canonicalBytes), "invalid-descriptor");
  }
});

test("altered bytes, digest, truncation and pretty-printed JSON never replace original canonical bytes", () => {
  const altered = Uint8Array.from(canonicalBytes);
  altered[50] ^= 1;
  for (const bytes of [
    altered,
    canonicalBytes.subarray(0, -1),
    Buffer.from(JSON.stringify(JSON.parse(canonicalBytes), null, 2)),
  ]) {
    incompatible(
      compareRecoveryCheckpointV1(checkpoint(), checkpoint(), bytes),
      "canonical-bytes-mismatch",
    );
  }
  const falseDigest = { ...checkpoint(), contentDigest: "a".repeat(64) };
  incompatible(
    compareRecoveryCheckpointV1(falseDigest, falseDigest, canonicalBytes),
    "canonical-bytes-mismatch",
  );
});

for (const value of [null, undefined]) {
  test(`missing descriptor ${String(value)} remains incompatible`, () => {
    incompatible(compareRecoveryProducerTupleV1(tuple(), value), "missing-descriptor");
    incompatible(
      compareRecoveryCheckpointV1(value, checkpoint(), canonicalBytes),
      "missing-descriptor",
    );
  });
}

test("unknown envelope/version fields cannot be treated as material tuple equality", () => {
  const withEnvelope = { ...tuple(), envelopeVersion: 1 };
  incompatible(compareRecoveryProducerTupleV1(withEnvelope, withEnvelope), "invalid-descriptor");
});

test("accessor fields are not evaluated as decoded descriptor values", () => {
  const value = tuple();
  Object.defineProperty(value, "codexVersion", {
    get() {
      throw new Error("must not evaluate accessor");
    },
  });
  incompatible(compareRecoveryProducerTupleV1(value, value), "invalid-descriptor");
});

test("checkpoint producer assignments remain historical: this comparison creates no replacement mapping", () => {
  const ref = checkpoint();
  ref.producingGatewayAssignmentRef = "77777777-7777-4777-8777-777777777777";
  ref.producingHarnessAssignmentRef = "88888888-8888-4888-8888-888888888888";
  assert.equal(
    compareRecoveryCheckpointV1(ref, structuredClone(ref), canonicalBytes).kind,
    "compatible",
  );
});

test("full preflight stays unavailable after exact comparisons while native candidate declaration is absent", () => {
  const value = input();
  const before = structuredClone(value);
  assert.deepEqual(evaluateSameBuildRecoveryPreflightV1(value), {
    scope: "same-build-recovery-preflight",
    kind: "unavailable",
    reasonCode: "native-candidate-descriptor-unavailable",
  });
  assert.deepEqual(value, before);
});

test("full preflight reports actual known incompatibility before its missing native boundary", () => {
  const value = input();
  value.candidateTuple.artifactLedgerRef = "artifact-ledger/changed-image";
  incompatible(evaluateSameBuildRecoveryPreflightV1(value), "descriptor-mismatch");
  value.candidateTuple = tuple();
  value.checkpoint.completionSequence = 6;
  incompatible(evaluateSameBuildRecoveryPreflightV1(value), "descriptor-mismatch");
});

test("a changed nested checkpoint material tuple fails even when candidate material matches that changed tuple", () => {
  const value = input();
  value.checkpoint.producerTuple.artifactLedgerRef = "artifact-ledger/changed-checkpoint-image";
  value.candidateTuple = structuredClone(value.checkpoint.producerTuple);
  incompatible(
    compareRecoveryCheckpointV1(value.expectedCheckpoint, value.checkpoint, value.canonicalBytes),
    "descriptor-mismatch",
  );
  incompatible(evaluateSameBuildRecoveryPreflightV1(value), "descriptor-mismatch");
});
