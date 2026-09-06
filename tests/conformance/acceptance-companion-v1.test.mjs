import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";
import {
  ACCEPTANCE_CLASSES_V1,
  ACCEPTANCE_DEMOS_V1,
  ACCEPTANCE_HANDOFFS_V1,
  ACCEPTANCE_LEAVES_V1,
  ACCEPTANCE_LIMITS_V1,
  ACCEPTANCE_OUTCOMES_V1,
  ACCEPTANCE_REGISTRY_SHA256_V1,
  ACCEPTANCE_VECTORS_V1,
  AssertionCompanionSchemaV1,
  ProducerReceiptSchemaV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  ACCEPTANCE_SCHEMA_DIGESTS_V1,
  bindProducerReceiptV1,
  decodeAssertionCompanionV1,
  decodeProducerReceiptV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  registry,
  REGISTRY_DIGEST,
  OUTCOMES,
  CLASSES,
} from "../../scripts/release-evidence/registry.mjs";
import {
  encode,
  syntheticCompanion,
  syntheticReceipt,
  syntheticEndUnavailableReceipt,
} from "../fixtures/acceptance-companion-v1/producer.ts";
import { readClaim } from "../fixtures/acceptance-companion-v1/consumer.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const specBytes = () => encode(syntheticCompanion());
const claim = () => structuredClone(syntheticReceipt(specBytes()));
const decodeSpec = (value) => decodeAssertionCompanionV1(encode(value));
const decodeClaim = (value) => decodeProducerReceiptV1(encode(value));
const reject = (result, code) => assert.deepEqual(result, { ok: false, code });
const evidence = (domain, label = domain) =>
  digestAcceptanceBytesV1(domain, encode({ synthetic: label }));

test("closed catalog retains every accepted leaf, original registry parent, demonstration and vector", () => {
  assert.equal(Object.keys(ACCEPTANCE_LEAVES_V1).length, 324);
  assert.equal(Object.keys(ACCEPTANCE_DEMOS_V1).length, 66);
  assert.equal(Object.keys(ACCEPTANCE_VECTORS_V1).length, 49);
  assert.deepEqual(Object.keys(ACCEPTANCE_HANDOFFS_V1), [
    "E1",
    "E2",
    "E3",
    "E4",
    "E5",
    "E6",
    "E7",
    "E8",
    "E9",
  ]);
  assert.equal(REGISTRY_DIGEST, `sha256:${ACCEPTANCE_REGISTRY_SHA256_V1}`);
  assert.deepEqual(ACCEPTANCE_CLASSES_V1, CLASSES);
  assert.deepEqual(ACCEPTANCE_OUTCOMES_V1.slice(0, 5), OUTCOMES);
  const parents = registry().cases;
  for (const [id, leaf] of Object.entries(ACCEPTANCE_LEAVES_V1)) {
    const parent = parents.find((item) => item.id === leaf.parentCaseId);
    assert.ok(parent, id);
    assert.ok(
      parent.assertions.some((item) => item.id === leaf.parentAssertionId),
      id,
    );
    assert.equal(parent.requirement, leaf.requirement);
    assert.ok(parent.channel === "none" || parent.channel === leaf.channel);
    for (const demo of leaf.demoCaseIds)
      assert.ok(ACCEPTANCE_DEMOS_V1[demo].assertionIds.includes(id));
  }
  const exceptions = Object.entries(ACCEPTANCE_DEMOS_V1).filter(
    ([, demo]) => demo.applicability === "not_applicable",
  );
  assert.deepEqual(
    exceptions.map(([id]) => id),
    ["TEAMS-15"],
  );
  assert.deepEqual(ACCEPTANCE_DEMOS_V1["TEAMS-15"].assertionIds, []);
  for (const vector of Object.values(ACCEPTANCE_VECTORS_V1)) {
    for (const id of vector.assertionIds) assert.ok(ACCEPTANCE_LEAVES_V1[id]);
    assert.ok(vector.requiredByGates.includes("R10"));
  }
});

test("all 324 synthetic producer records validate through real exports without authenticating execution", () => {
  for (const id of Object.keys(ACCEPTANCE_LEAVES_V1)) {
    const spec = syntheticCompanion(id);
    assert.equal(Check(AssertionCompanionSchemaV1, spec), true, id);
    const bytes = encode(spec);
    const receipt = syntheticReceipt(bytes);
    assert.equal(Check(ProducerReceiptSchemaV1, receipt), true, id);
    const joined = bindProducerReceiptV1(bytes, encode(receipt));
    assert.equal(joined.ok, true, `${id}: ${joined.code}`);
    assert.equal(joined.authentication, "unverified");
  }
});

test("independent reader retains unit versus live and physical termination unknown", () => {
  const bytes = specBytes();
  const receipt = claim();
  assert.deepEqual(readClaim(bytes, encode(receipt)), {
    outcome: "pass",
    declaredClass: "unit",
    executionState: "observed",
    authentication: "unverified",
  });
  receipt.execution.executionClass = "live";
  const joined = bindProducerReceiptV1(bytes, encode(receipt));
  assert.equal(joined.ok, true);
  assert.equal(joined.authentication, "unverified");
  assert.equal(joined.receipt.value.execution.capture.state, "missing");
  assert.equal(joined.receipt.value.review.state, "missing");
  assert.equal(joined.receipt.value.observations[0].state, "unknown");
});

test("original UTF-8 bytes, whitespace and property order determine evidence identity", () => {
  const compact = specBytes();
  const pretty = new TextEncoder().encode(JSON.stringify(syntheticCompanion(), null, 2) + "\n");
  const a = decodeAssertionCompanionV1(compact);
  const b = decodeAssertionCompanionV1(pretty);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.value, b.value);
  assert.notEqual(a.identity.sha256, b.identity.sha256);
  assert.equal(b.identity.sha256, sha(pretty));
  assert.equal(b.identity.byteLength, pretty.byteLength);
  assert.deepEqual(b.originalBytes(), pretty);
  const receipt = syntheticReceipt(compact);
  reject(bindProducerReceiptV1(pretty, encode(receipt)), "binding-mismatch");
});

test("decoder snapshots caller bytes and freezes nested values, schemas and metadata", () => {
  const bytes = specBytes();
  const before = bytes.slice();
  const result = decodeAssertionCompanionV1(bytes);
  assert.equal(result.ok, true);
  bytes.fill(0);
  result.originalBytes().fill(0);
  assert.deepEqual(result.originalBytes(), before);
  assert.throws(() => {
    result.value.leaf.required = false;
  }, TypeError);
  assert.throws(() => {
    ACCEPTANCE_LEAVES_V1["R1-outside-install"].demoCaseIds.push("TEAMS-15");
  }, TypeError);
  assert.throws(() => {
    AssertionCompanionSchemaV1.additionalProperties = true;
  }, TypeError);
});

test("byte boundary accepts the exact limit and rejects one more before parsing", () => {
  const text = new TextDecoder().decode(specBytes());
  const exact = new TextEncoder().encode(text.padEnd(ACCEPTANCE_LIMITS_V1.maxJsonBytes, " "));
  assert.equal(decodeAssertionCompanionV1(exact).ok, true);
  reject(decodeAssertionCompanionV1(new Uint8Array(exact.length + 1)), "too-large");
});

test("byte-only input rejects arbitrary objects, proxy traps, shared buffers and invalid UTF-8", () => {
  for (const input of [null, {}, "{}", [], new Uint16Array(4), new Uint8Array(0)])
    reject(decodeAssertionCompanionV1(input), "invalid-input");
  reject(
    decodeAssertionCompanionV1(
      new Proxy(new Uint8Array(4), {
        get() {
          throw new Error("must not read");
        },
      }),
    ),
    "invalid-input",
  );
  reject(decodeAssertionCompanionV1(new Uint8Array(new SharedArrayBuffer(8))), "invalid-input");
  reject(decodeAssertionCompanionV1(new Uint8Array([0xc3, 0x28])), "invalid-utf8");
  const bytes = specBytes();
  reject(decodeAssertionCompanionV1(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])), "invalid-json");
});

test("raw JSON rejects duplicate escaped keys and malformed tokens without echoing data", () => {
  const text = new TextDecoder().decode(specBytes());
  const duplicate = text.replace(
    '{"schemaVersion":',
    '{"schema\\u0056ersion":"assertion-companion/v1","schemaVersion":',
  );
  reject(decodeAssertionCompanionV1(new TextEncoder().encode(duplicate)), "duplicate-key");
  for (const input of [
    '{"x":1,}',
    '{"x":01}',
    "[1,]",
    '{"x":1e999}',
    "{} trailing",
    '{"x":"unterminated}',
    '{"x":"bad\n"}',
  ])
    reject(decodeAssertionCompanionV1(new TextEncoder().encode(input)), "invalid-json");
  for (const input of ["null", "true", "[]", "1"])
    reject(decodeAssertionCompanionV1(new TextEncoder().encode(input)), "invalid-shape");
});

test("depth, per-container and node ceilings apply before schema traversal", () => {
  reject(
    decodeAssertionCompanionV1(new TextEncoder().encode("[".repeat(16) + "0" + "]".repeat(16))),
    "limit-exceeded",
  );
  reject(decodeAssertionCompanionV1(encode(Array(1_025).fill(0))), "limit-exceeded");
  reject(
    decodeAssertionCompanionV1(encode(Array.from({ length: 17 }, () => Array(1_024).fill(0)))),
    "limit-exceeded",
  );
  reject(decodeAssertionCompanionV1(encode(Array(1_024).fill(0))), "invalid-shape");
});

test("future versions, missing versions and schema-digest drift fail closed", () => {
  const spec = syntheticCompanion();
  spec.schemaVersion = "assertion-companion/v2";
  reject(decodeSpec(spec), "unsupported-version");
  delete spec.schemaVersion;
  reject(decodeSpec(spec), "invalid-shape");
  const second = syntheticCompanion();
  second.schemaDigest = "0".repeat(64);
  reject(decodeSpec(second), "schema-mismatch");
  const receipt = claim();
  receipt.schemaDigest = ACCEPTANCE_SCHEMA_DIGESTS_V1.companion;
  reject(decodeClaim(receipt), "schema-mismatch");
});

test("unknown fields and enum values are rejected at every boundary", () => {
  for (const change of [
    (spec) => {
      spec.extra = true;
    },
    (spec) => {
      spec.leaf.extra = true;
    },
    (spec) => {
      spec.handoffs.E10 = spec.handoffs.E1;
    },
    (spec) => {
      spec.leaf.id = "R1-unallocated";
    },
    (spec) => {
      spec.inputManifest = { ...spec.inputManifest, domain: "result" };
    },
  ]) {
    const spec = syntheticCompanion();
    change(spec);
    reject(decodeSpec(spec), "invalid-shape");
  }
  for (const change of [
    (receipt) => {
      receipt.outcome = "successful";
    },
    (receipt) => {
      receipt.execution.executionClass = "integration";
    },
    (receipt) => {
      receipt.custody.secret = "disallowed";
    },
    (receipt) => {
      receipt.execution.capture.state = "authenticated";
    },
  ]) {
    const receipt = claim();
    change(receipt);
    reject(decodeClaim(receipt), "invalid-shape");
  }
});

test("known identifiers with wrong original parent, producer, channel or requiredness are refused", () => {
  for (const change of [
    (spec) => {
      spec.leaf.parentCaseId = "r2-revision";
    },
    (spec) => {
      spec.leaf.parentAssertionId = "missing-prerequisite";
    },
    (spec) => {
      spec.leaf.primaryProducer = "P-AUD";
    },
    (spec) => {
      spec.leaf.channel = "slack";
    },
    (spec) => {
      spec.leaf.required = false;
    },
  ]) {
    const spec = syntheticCompanion();
    change(spec);
    reject(decodeSpec(spec), "metadata-mismatch");
  }
});

test("all 66 original applicability rows remain present with only the accepted exception", () => {
  const spec = syntheticCompanion();
  spec.demoApplicability.pop();
  reject(decodeSpec(spec), "invalid-shape");
  const duplicate = syntheticCompanion();
  duplicate.demoApplicability[0] = duplicate.demoApplicability[1];
  reject(decodeSpec(duplicate), "metadata-mismatch");
  for (const change of [
    (row) => {
      row.applicability = "required";
    },
    (row) => {
      row.review = null;
    },
  ]) {
    const current = syntheticCompanion();
    change(current.demoApplicability.find((row) => row.demoCaseId === "TEAMS-15"));
    reject(decodeSpec(current), "metadata-mismatch");
  }
});

test("demo leaf joins retain ordered producer substeps without inventing historical step identities", () => {
  const id = Object.keys(ACCEPTANCE_LEAVES_V1).find(
    (key) => ACCEPTANCE_LEAVES_V1[key].demoCaseIds.length > 0,
  );
  for (const change of [
    (spec) => {
      spec.demonstrations = [];
    },
    (spec) => {
      spec.demonstrations[0].substeps = [];
    },
    (spec) => {
      spec.demonstrations[0].substeps[0].order = 2;
    },
    (spec) => {
      spec.demonstrations[0].substeps.push({ ...spec.demonstrations[0].substeps[0], order: 2 });
    },
  ]) {
    const spec = syntheticCompanion(id);
    change(spec);
    reject(decodeSpec(spec), "metadata-mismatch");
  }
});

test("vector bindings preserve R4-to-R10 dependency and all three original proof slots", () => {
  const id = ACCEPTANCE_VECTORS_V1.R01.assertionIds[0];
  const valid = syntheticCompanion(id);
  assert.deepEqual(valid.vectors[0].requiredByGates, ["R4", "R10"]);
  for (const change of [
    (spec) => {
      spec.vectors = [];
    },
    (spec) => {
      spec.vectors[0].requiredByGates = ["R4"];
    },
    (spec) => {
      spec.vectors[0].subchecks[2].slot = "stimulus";
    },
    (spec) => {
      spec.vectors[0].subchecks[2].subcheckId = spec.vectors[0].subchecks[1].subcheckId;
    },
  ]) {
    const spec = syntheticCompanion(id);
    change(spec);
    reject(decodeSpec(spec), "metadata-mismatch");
  }
});

test("missing receipt, explicit unrun, unknown, blocked and rejected collection remain distinct", () => {
  const receipt = claim();
  receipt.collection = "missing";
  receipt.outcome = null;
  receipt.result = { state: "missing" };
  receipt.procedure = { state: "missing" };
  receipt.execution = { state: "unrun" };
  receipt.checks = [];
  receipt.observations = [];
  assert.equal(decodeClaim(receipt).ok, true);
  assert.equal(bindProducerReceiptV1(specBytes(), encode(receipt)).ok, true);
  const omitted = structuredClone(receipt);
  delete omitted.outcome;
  reject(decodeClaim(omitted), "invalid-shape");
  for (const outcome of ["unrun", "skipped", "unknown", "blocked"]) {
    const current = { ...receipt, collection: "received", outcome };
    const decoded = decodeClaim(current);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.value.outcome, outcome);
  }
  const rejected = { ...receipt, collection: "rejected", outcome: "blocked" };
  assert.equal(decodeClaim(rejected).value.collection, "rejected");
  const invalidPass = { ...receipt, collection: "received", outcome: "pass" };
  reject(decodeClaim(invalidPass), "inconsistent-receipt");
});

test("receipt refuses a missing execution procedure, missing successful result and stale review join", () => {
  for (const change of [
    (receipt) => {
      receipt.procedure = { state: "missing" };
    },
    (receipt) => {
      receipt.result = { state: "missing" };
    },
    (receipt) => {
      receipt.execution = { state: "unrun" };
    },
    (receipt) => {
      receipt.outcome = "unrun";
    },
  ]) {
    const receipt = claim();
    change(receipt);
    reject(decodeClaim(receipt), "inconsistent-receipt");
  }
  const receipt = claim();
  receipt.review = {
    state: "recorded",
    digest: evidence("review"),
    inputManifest: receipt.inputManifest,
    result: evidence("result", "different"),
    reviewerRef: "independent-reviewer",
    humanReviewerRef: null,
    coordinatorRef: "coordinator",
    disposition: "unknown",
    unresolvedFindings: [],
  };
  reject(decodeClaim(receipt), "inconsistent-receipt");
});

test("self-declared capture and accepted review still supply no execution authenticity", () => {
  const receipt = claim();
  receipt.execution.capture = {
    state: "claimed",
    authorityRef: "declared-capture",
    executorBinding: evidence("evidence", "executor"),
    sourceAttemptBinding: evidence("evidence", "source-attempt"),
  };
  receipt.review = {
    state: "recorded",
    digest: evidence("review"),
    inputManifest: receipt.inputManifest,
    result: receipt.result.digest,
    reviewerRef: "independent-reviewer",
    humanReviewerRef: "declared-human",
    coordinatorRef: "coordinator",
    disposition: "accepted",
    unresolvedFindings: [],
  };
  assert.equal(decodeClaim(receipt).authentication, "unverified");
  receipt.review.reviewerRef = receipt.execution.executorRef;
  reject(decodeClaim(receipt), "inconsistent-receipt");
});

test("primary assemblers and supporting producer receipts retain separate ownership", () => {
  const receipt = claim();
  receipt.producer = "P-AUD";
  reject(decodeClaim(receipt), "metadata-mismatch");
  receipt.role = "supporting";
  assert.equal(decodeClaim(receipt).ok, true);
  receipt.producer = "P-UPS";
  assert.equal(decodeClaim(receipt).ok, true);
  receipt.producer = "P-CTL";
  reject(decodeClaim(receipt), "metadata-mismatch");
});

test("same receipt joins only exact run, leaf, input, procedure and original companion bytes", () => {
  for (const change of [
    (receipt) => {
      receipt.runId = "another-run";
    },
    (receipt) => {
      receipt.inputManifest = evidence("input", "other");
    },
    (receipt) => {
      receipt.procedure.digest = evidence("procedure", "other");
    },
    (receipt) => {
      receipt.companion = evidence("companion", "other");
    },
  ]) {
    const receipt = claim();
    change(receipt);
    reject(bindProducerReceiptV1(specBytes(), encode(receipt)), "binding-mismatch");
  }
});

test("a claimed primary pass cannot hide missing or failing companion subchecks", () => {
  const id = ACCEPTANCE_VECTORS_V1.R01.assertionIds[0];
  const bytes = encode(syntheticCompanion(id));
  for (const change of [
    (receipt) => {
      receipt.checks.pop();
    },
    (receipt) => {
      receipt.checks[1].outcome = "unknown";
    },
    (receipt) => {
      receipt.checks[1].subject.subcheckId = "different-subcheck";
    },
  ]) {
    const receipt = syntheticReceipt(bytes);
    change(receipt);
    reject(bindProducerReceiptV1(bytes, encode(receipt)), "binding-mismatch");
  }
});

test("duplicate semantic check identities cannot hide through object-key ordering", () => {
  const receipt = claim();
  const first = receipt.checks[0];
  receipt.checks.push({ ...first, subject: { leafId: first.subject.leafId, kind: "leaf" } });
  reject(decodeClaim(receipt), "inconsistent-receipt");
});

test("counts, artifact lengths, timestamps and declared clock uncertainty are bounded", () => {
  for (const change of [
    (receipt) => {
      receipt.checks = Array(257).fill(receipt.checks[0]);
    },
    (receipt) => {
      receipt.result.digest.byteLength = 1_073_741_825;
    },
    (receipt) => {
      receipt.result.digest.byteLength = 1.5;
    },
    (receipt) => {
      receipt.execution.started.uncertaintyMs = -1;
    },
  ]) {
    const receipt = claim();
    change(receipt);
    reject(decodeClaim(receipt), "invalid-shape");
  }
  for (const change of [
    (receipt) => {
      receipt.receivedAt = "2026-02-30T00:00:00.000Z";
    },
    (receipt) => {
      receipt.custody.retainedUntil = "2025-12-01T00:00:00.000Z";
    },
  ]) {
    const receipt = claim();
    change(receipt);
    reject(decodeClaim(receipt), "inconsistent-receipt");
  }
});

test("redaction, independent rejection and invalidation remain separate from a declared pass", () => {
  const receipt = claim();
  receipt.custody.redaction = "complete";
  reject(decodeClaim(receipt), "inconsistent-receipt");
  receipt.custody.redaction = "rejected";
  receipt.collection = "rejected";
  receipt.invalidation = {
    state: "invalidated",
    replacementInput: evidence("input", "new-input"),
    reason: evidence("review", "invalidation"),
  };
  const decoded = decodeClaim(receipt);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.outcome, "pass");
  assert.equal(decoded.value.collection, "rejected");
  assert.equal(decoded.value.invalidation.state, "invalidated");
  assert.equal(decoded.authentication, "unverified");
  receipt.invalidation.replacementInput = receipt.inputManifest;
  reject(decodeClaim(receipt), "inconsistent-receipt");
});

test("Q1 retains observed launch and unavailable end separately from unrun and physical settlement", () => {
  const bytes = specBytes();
  const started = claim().execution.started;
  for (const outcome of ["unknown", "blocked"]) {
    const receipt = syntheticEndUnavailableReceipt(bytes);
    receipt.outcome = outcome;
    const encoded = encode(receipt);
    const joined = bindProducerReceiptV1(bytes, encoded);
    assert.equal(joined.ok, true);
    assert.equal(joined.authentication, "unverified");
    assert.equal(joined.receipt.value.execution.state, "end-unavailable");
    assert.deepEqual(joined.receipt.value.execution.started, started);
    assert.equal(joined.receipt.value.execution.capture.state, "claimed");
    assert.equal(joined.receipt.value.observations[0].state, "unknown");
    for (const key of ["ended", "monotonicClockRef", "monotonicDurationMs"]) {
      assert.equal(Object.hasOwn(joined.receipt.value.execution, key), false);
    }
    assert.deepEqual(joined.receipt.originalBytes(), encoded);
    assert.deepEqual(readClaim(bytes, encoded), {
      outcome,
      declaredClass: "unit",
      executionState: "end-unavailable",
      authentication: "unverified",
    });
  }
});

test("Q1 refuses completion outcomes, unrun relabeling and missing collection for observed launch", () => {
  for (const outcome of ["pass", "fail", "unrun", "skipped", "not_applicable", null]) {
    const receipt = syntheticEndUnavailableReceipt(specBytes());
    receipt.outcome = outcome;
    reject(decodeClaim(receipt), "inconsistent-receipt");
  }
  const missing = syntheticEndUnavailableReceipt(specBytes());
  missing.collection = "missing";
  missing.outcome = null;
  reject(decodeClaim(missing), "inconsistent-receipt");
  const relabeled = syntheticEndUnavailableReceipt(specBytes());
  relabeled.execution.state = "unrun";
  reject(decodeClaim(relabeled), "invalid-shape");
});

test("Q1 refuses invented unavailable clocks, duration values and missing launch fields", () => {
  for (const field of ["ended", "monotonicClockRef", "monotonicDurationMs"]) {
    for (const value of [null, 0, "2026-01-01T00:00:01.000Z", claim().execution.ended]) {
      const receipt = syntheticEndUnavailableReceipt(specBytes());
      receipt.execution[field] = value;
      reject(decodeClaim(receipt), "invalid-shape");
    }
  }
  for (const field of ["started", "capture"]) {
    const receipt = syntheticEndUnavailableReceipt(specBytes());
    delete receipt.execution[field];
    reject(decodeClaim(receipt), "invalid-shape");
  }
  const extra = structuredClone(syntheticEndUnavailableReceipt(specBytes()));
  extra.execution.started.receiptTimeInstead = extra.receivedAt;
  reject(decodeClaim(extra), "invalid-shape");
});

test("Q1 requires frozen procedure and valid start while preserving missing result and capture", () => {
  const missingProcedure = syntheticEndUnavailableReceipt(specBytes());
  missingProcedure.procedure = { state: "missing" };
  reject(decodeClaim(missingProcedure), "inconsistent-receipt");
  const badClock = structuredClone(syntheticEndUnavailableReceipt(specBytes()));
  badClock.execution.started.observedAt = "2026-02-30T00:00:00.000Z";
  reject(decodeClaim(badClock), "inconsistent-receipt");
  const missingEvidence = syntheticEndUnavailableReceipt(specBytes());
  missingEvidence.result = { state: "missing" };
  missingEvidence.execution.capture = { state: "missing" };
  const decoded = decodeClaim(missingEvidence);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.outcome, "unknown");
  assert.equal(decoded.authentication, "unverified");
});

test("Q1 applies independent-review checks and never promotes partial successful subchecks", () => {
  const bytes = specBytes();
  const receipt = syntheticEndUnavailableReceipt(bytes);
  receipt.checks[0].outcome = "pass";
  receipt.review = {
    state: "recorded",
    digest: evidence("review"),
    inputManifest: receipt.inputManifest,
    result: receipt.result.digest,
    reviewerRef: receipt.execution.executorRef,
    humanReviewerRef: null,
    coordinatorRef: "synthetic-coordinator",
    disposition: "unknown",
    unresolvedFindings: [],
  };
  reject(decodeClaim(receipt), "inconsistent-receipt");
  receipt.review.reviewerRef = "synthetic-independent-reviewer";
  const joined = bindProducerReceiptV1(bytes, encode(receipt));
  assert.equal(joined.ok, true);
  assert.equal(joined.receipt.value.checks[0].outcome, "pass");
  assert.equal(joined.receipt.value.outcome, "unknown");
  assert.equal(joined.receipt.value.execution.state, "end-unavailable");
  assert.equal(joined.authentication, "unverified");
});

test("Q1 receipt-definition successor refuses the old identity and preserves companion identity", () => {
  const previous = "b7964df399d61f90f1c79808e3f68fb6e7f5a1c25c4c37055e903fcd2fdef62a";
  assert.notEqual(ACCEPTANCE_SCHEMA_DIGESTS_V1.receipt, previous);
  assert.equal(
    ACCEPTANCE_SCHEMA_DIGESTS_V1.companion,
    "04e70c36d36645ad67262e32042af8481acb827fbdf2c960a678f91dd0ba4253",
  );
  const legacy = claim();
  legacy.schemaDigest = previous;
  const legacyBytes = encode(legacy);
  const retained = legacyBytes.slice();
  reject(decodeProducerReceiptV1(legacyBytes), "schema-mismatch");
  assert.deepEqual(legacyBytes, retained);
  const current = syntheticEndUnavailableReceipt(specBytes());
  assert.equal(current.schemaVersion, "producer-receipt/v1");
  assert.equal(decodeClaim(current).ok, true);
});
