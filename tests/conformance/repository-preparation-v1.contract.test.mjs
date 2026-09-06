import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryPreparationSchemasV1,
  REPOSITORY_PREPARATION_LIMITS_V1 as limits,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";
import {
  parseRepositoryPreparationV1 as parse,
  parseRepositoryPreparationJsonV1 as parseJson,
  canonicalRepositoryPreparationRequestV1 as canonical,
  parsePreparationReceiptExchangeV1 as parseExchange,
  preparationAffectedFilterDigestV1 as filterDigest,
  preparationCheckoutRequestDigestV1 as checkoutDigest,
} from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
import {
  parseCredentialStorageV1 as parseOriginal,
  canonicalCredentialStorageRequestV1 as canonicalOriginal,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import * as v from "../fixtures/repository-preparation-v1/vectors.mjs";
import { protocolTraces } from "../fixtures/repository-preparation-v1/traces.mjs";

const invalid = (kind, input) => assert.throws(() => parse(kind, input));
const invalidJson = (kind, text) => assert.throws(() => parseJson(kind, text));
const invalidExchange = (request, result, clock = v.clock()) =>
  assert.throws(() => parseExchange(request, result, clock));
function frozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) frozen(child);
  }
}
function paths(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    ...(Array.isArray(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, child]) => paths(child, [...path, key])),
  ];
}
const atPath = (value, path) => path.reduce((current, key) => current[key], value);
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

test("actual supported subpaths expose every preparation dictionary with detached immutable parsing", () => {
  assert.deepEqual(
    Object.keys(v.samples).sort(),
    Object.keys(RepositoryPreparationSchemasV1).sort(),
  );
  for (const [kind, make] of Object.entries(v.samples)) {
    const input = make();
    const result = parse(kind, input);
    assert.deepEqual(result, input, kind);
    assert.notEqual(result, input, kind);
    assert.deepEqual(parseJson(kind, JSON.stringify(input)), result, kind);
    frozen(result);
  }
  const input = v.reserve();
  const result = parse("reserve", input);
  input.preparation.commit.oid = "b".repeat(40);
  input.preparation.gate.lifecycleGeneration = 2;
  assert.equal(result.preparation.commit.oid, "a".repeat(40));
  assert.equal(result.preparation.gate.lifecycleGeneration, 1);
});

test("every nested dictionary rejects unknown fields and unsupported schema versions", () => {
  for (const [kind, make] of Object.entries(v.samples)) {
    for (const path of paths(make())) {
      const input = make();
      const object = atPath(input, path);
      object.unrecognized = true;
      invalid(kind, input);
      delete object.unrecognized;
      if (Object.hasOwn(object, "schemaVersion")) {
        object.schemaVersion = 2;
        invalid(kind, input);
      }
    }
  }
  for (const kind of ["future", "constructor", "__proto__", "toString", null])
    invalid(kind, v.reserve());
});

test("preparation cannot coerce original turns, assignment identities or Job applicability", () => {
  for (const purpose of ["original-turn-runtime", "model-use", "repository-mint", "", "future"]) {
    invalid("subject", { ...v.subject(), purpose });
    invalid("reserve", { ...v.reserve(), credentialPurpose: purpose });
  }
  invalid("reserve", v.legacyReserve());
  assert.throws(() => parseOriginal("reserve", v.reserve()));
  invalid("purpose", { purpose: v.purpose, original: v.legacyOriginalBinding() });
  invalid("purpose", { purpose: "original-turn-runtime", preparation: v.subject() });
  invalid("inventoryUnion", { purpose: v.purpose, record: v.legacyReservedRecord() });
  invalid("inventoryUnion", { purpose: "original-turn-runtime", record: v.tokenRecord() });
  invalid("authorityUnion", { purpose: "original-turn-runtime", observation: v.authority() });
  for (const field of [
    "original",
    "turnRef",
    "conversationRef",
    "assignmentRef",
    "component",
    "apiKind",
    "jobUid",
    "deploymentUid",
  ]) {
    invalid("subject", { ...v.subject(), [field]: "caller-selected" });
    invalid("checkoutReceipt", { ...v.checkoutReceipt(), [field]: "caller-selected" });
  }
});

test("closed tagged values reject unknown variants and absent required preparation fields", () => {
  const tags = new Set([
    "purpose",
    "credentialPurpose",
    "method",
    "state",
    "status",
    "outcome",
    "effect",
    "algorithm",
    "mode",
    "cause",
    "kind",
    "originalMethod",
  ]);
  for (const [kind, make] of Object.entries(v.samples)) {
    for (const path of paths(make())) {
      for (const [field, value] of Object.entries(atPath(make(), path))) {
        if (!tags.has(field) || typeof value !== "string") continue;
        const input = make();
        atPath(input, path)[field] = "unsupported-variant";
        invalid(kind, input);
      }
    }
  }
  for (const field of [
    "purpose",
    "preparationRef",
    "incarnationRef",
    "revisionId",
    "revisionDigest",
    "gate",
    "authorizationGeneration",
    "admission",
    "grant",
    "profile",
    "repositoryId",
    "commit",
    "originProfile",
    "staging",
    "notAfter",
  ]) {
    const input = v.subject();
    delete input[field];
    invalid("subject", input);
  }
  for (const field of ["providerAttemptRef", "expectedInventoryVersion", "issuance"]) {
    const input = v.namedUse();
    delete input[field];
    invalid("namedUse", input);
  }
});

test("closed result branches preserve unknown, unavailable and evidence-missing vocabulary", () => {
  const commonFailure = [
    { kind: "denied", reason: "authority-denied" },
    { kind: "conflict", reason: "version-conflict" },
    { kind: "unavailable", reason: "inventory-unavailable" },
    { kind: "capacity-exhausted", reason: "capacity-exhausted" },
  ];
  for (const kind of [
    "reservationResult",
    "writeResult",
    "page",
    "claimResult",
    "fenceResult",
    "useResult",
    "deliveryResult",
  ]) {
    for (const failure of commonFailure) parse(kind, failure);
    invalid(kind, { kind: "unavailable", reason: "scope-hidden" });
  }
  const commitUnknown = {
    kind: "commit-unknown",
    operationRef: v.reserve().operationRef,
    intentDigest: v.locator().intentDigest,
    nextAction: "exact-readback-only",
  };
  for (const kind of ["reservationResult", "writeResult", "claimResult", "fenceResult"])
    parse(kind, commitUnknown);
  parse("reservationResult", {
    kind: "existing",
    record: v.tokenRecord("mint-unknown"),
    nextAction: "reconcile-only",
  });
  parse("claimResult", {
    kind: "busy",
    revocationOperationRef: "operation/prepare-revoke",
    nextAction: "reconcile-only",
  });
  parse("page", { kind: "snapshot-invalid", nextAction: "restart-exact-filter" });
  for (const kind of ["not-found", "unavailable"])
    parse("operationResult", { kind, nextAction: "exact-readback-only" });
  parse("operationResult", { kind: "not-visible" });
  const { record, ...withoutRecord } = v.operationResult();
  parse("operationResult", withoutRecord);
  invalid("operationResult", { ...withoutRecord, nextAction: "mint-again" });
});

test("admitted read-only preparation scope binds repository, native profile and canonical commit", () => {
  for (const commit of [
    { algorithm: "sha256", oid: "a".repeat(64) },
    { algorithm: "sha1", oid: "A".repeat(40) },
    { algorithm: "sha1", oid: "main" },
    { algorithm: "sha1", oid: "a".repeat(39) },
  ])
    invalid("subject", { ...v.subject(), commit });
  for (const repositoryId of ["0", "01", "*", 101, "1".repeat(21)])
    invalid("subject", { ...v.subject(), repositoryId });
  for (const mode of ["mediated", "history-isolated"])
    invalid("subject", { ...v.subject(), profile: { ...v.credentialProfile(), mode } });
  for (const repositoryIds of [["202"], ["101", "202"], []])
    invalid("reserve", { ...v.reserve(), grant: { ...v.grant(), repositoryIds } });
  invalid("reserve", {
    ...v.reserve(),
    grant: { ...v.grant(), permissions: [{ name: "contents", access: "write" }] },
  });
  for (const key of ["gate", "profile", "staging"]) {
    const input = v.subject();
    input[key].scope.agentId = `agt_${v.id(90)}`;
    invalid("subject", input);
  }
  const foreign = v.reserve();
  foreign.binding.account.version = 2;
  invalid("reserve", foreign);
  const differentProfile = v.reserve();
  differentProfile.profile.profile.version = 2;
  invalid("reserve", differentProfile);
});

test("original-turn requests, digests and readback stay unchanged outside preparation", () => {
  const original = v.legacyReserve();
  assert.deepEqual(parseOriginal("reserve", original), original);
  const bytes = canonicalOriginal("reserve", original);
  assert.equal(Buffer.byteLength(bytes), 3924);
  assert.equal(v.hash(bytes), v.LEGACY_RESERVE_DIGEST);
  assert.equal(
    canonical("requestUnion", { purpose: "original-turn-runtime", request: original }),
    bytes,
  );
  assert.deepEqual(
    parse("requestUnion", { purpose: "original-turn-runtime", request: original }).request,
    original,
  );
  assert.deepEqual(
    parseOriginal("readOperation", v.legacyReadOperation()),
    v.legacyReadOperation(),
  );
  assert.deepEqual(parseOriginal("operationResult", v.legacyReadback()), v.legacyReadback());
  assert.deepEqual(
    parse("exchangeUnion", {
      purpose: "original-turn-runtime",
      request: v.legacyReadOperation(),
      result: v.legacyReadback(),
    }).result,
    v.legacyReadback(),
  );
  assert.deepEqual(
    parse("purpose", { purpose: "original-turn-runtime", original: v.legacyOriginalBinding() })
      .original,
    v.legacyOriginalBinding(),
  );
  const wrapped = parse("inventoryUnion", {
    purpose: "original-turn-runtime",
    record: v.legacyReservedRecord(),
  });
  assert.deepEqual(wrapped.record, v.legacyReservedRecord());
  assert.equal(
    v.hash(canonicalOriginal("reserve", wrapped.record.issuance)),
    v.LEGACY_RESERVE_DIGEST,
  );
});

test("canonical preparation requests bind their purpose and immutable intent with exact CAS", () => {
  const input = v.reserve();
  const bytes = canonical("reserve", input);
  const { requestId, createdAt, deadline, ...semantic } = input;
  assert.deepEqual(JSON.parse(bytes), semantic);
  assert.equal(canonical("reserve", reverseKeys(input)), bytes);
  assert.equal(
    canonical("reserve", {
      ...input,
      requestId: `req_${v.id(90)}`,
      createdAt: v.at(1_000),
      deadline: v.at(6_000),
    }),
    bytes,
  );
  assert.notEqual(v.hash(bytes), v.LEGACY_RESERVE_DIGEST);
  for (const mutate of [
    (value) => {
      value.preparation.commit.oid = "b".repeat(40);
    },
    (value) => {
      value.preparation.incarnationRef = "incarnation/candidate-2";
    },
    (value) => {
      value.preparation.revisionId = `rev_${v.id(90)}`;
    },
    (value) => {
      value.preparation.gate.lifecycleGeneration = 2;
    },
    (value) => {
      value.preparation.authorizationGeneration = 2;
    },
    (value) => {
      value.preparation.grant.version = 2;
    },
    (value) => {
      value.preparation.staging.bindingVersion = 2;
    },
    (value) => {
      value.binding.secretVersion = 2;
    },
    (value) => {
      value.authorityVersion = 2;
    },
    (value) => {
      value.invalidationVersion = 2;
    },
    (value) => {
      value.operationRef = "operation/other";
    },
  ]) {
    const changed = v.reserve();
    mutate(changed);
    assert.notEqual(canonical("reserve", changed), bytes);
  }
  for (const patch of [
    { providerAttemptRef: "provider-attempt/other" },
    { expectedInventoryVersion: 2 },
  ]) {
    assert.notEqual(
      canonical("namedUse", { ...v.namedUse(), ...patch }),
      canonical("namedUse", v.namedUse()),
    );
  }
  assert.throws(() => canonical("record", v.tokenRecord()));
  assert.equal(canonical("requestUnion", { purpose: v.purpose, request: input }), bytes);
});

test("purpose-tagged exchanges retain exact operations, target identity and readback intent", () => {
  for (const [purpose, request, result] of [
    [v.purpose, v.reserve(), v.reservationResult()],
    [
      "original-turn-runtime",
      v.legacyReserve(),
      { kind: "existing", record: v.legacyReservedRecord(), nextAction: "reconcile-only" },
    ],
  ]) {
    const retry = {
      ...request,
      requestId: `req_${v.id(90)}`,
      createdAt: v.at(1_000),
      deadline: v.at(6_000),
    };
    assert.equal(
      canonical("requestUnion", { purpose, request: retry }),
      canonical("requestUnion", { purpose, request }),
    );
    parse("exchangeUnion", { purpose, request: retry, result });
  }
  for (const [request, result] of [
    [v.reserve(), v.reservationResult()],
    [v.namedUse(), v.useResult()],
    [v.mintOutcome(), v.writeResult()],
    [v.delivery(), v.deliveryResult()],
    [v.claim(), v.claimResult()],
    [v.affected(), v.page()],
    [v.readOperation(), v.operationResult()],
    [v.fence(), v.fenceResult()],
  ]) {
    parse("requestUnion", { purpose: v.purpose, request });
    parse("exchangeUnion", { purpose: v.purpose, request, result });
    invalid("requestUnion", { purpose: "original-turn-runtime", request });
    invalid("exchangeUnion", { purpose: "original-turn-runtime", request, result });
  }
  invalid("requestUnion", { purpose: v.purpose, request: v.legacyReserve() });
  invalid("requestUnion", { purpose: "original-turn-runtime", request: v.mintOutcome("unknown") });
  invalid("exchangeUnion", { purpose: v.purpose, request: v.reserve(), result: v.writeResult() });
  for (const patch of [
    { operationRef: "operation/other" },
    { intentDigest: v.digest },
    { originalMethod: "recordMintOutcome" },
  ]) {
    invalid("exchangeUnion", {
      purpose: v.purpose,
      request: v.readOperation(),
      result: { ...v.operationResult(), ...patch },
    });
  }
  const request = { ...v.mintOutcome(), operationRef: "operation/other-record" };
  invalid("exchangeUnion", { purpose: v.purpose, request, result: v.writeResult() });
  invalid("exchangeUnion", {
    purpose: v.purpose,
    request: v.delivery(),
    result: { ...v.deliveryResult(), deliveryRef: "delivery/other" },
  });
  invalid("exchangeUnion", {
    purpose: v.purpose,
    request: v.fence(),
    result: { ...v.fenceResult(), responsibilityRef: "responsibility/other" },
  });
  invalid("exchangeUnion", {
    purpose: v.purpose,
    request: v.affected(),
    result: { ...v.page(), filter: { ...v.affected().filter, cause: "rotation" } },
  });
});

test("both purpose exchanges bind busy claims and missing evidence to the reported operation", () => {
  for (const purpose of ["original-turn-runtime", v.purpose]) {
    const requests = [v.claim(), v.mintOutcome(), v.revokeOutcome("confirmed")].map((request) => {
      if (purpose === v.purpose) return request;
      const { credentialPurpose, preparation, ...original } = request;
      return { ...original, target: v.legacyReservedRecord().target };
    });
    const [claim, mint, revoke] = requests;
    const busy = {
      kind: "busy",
      revocationOperationRef: claim.revocationOperationRef,
      nextAction: "reconcile-only",
    };
    parse("exchangeUnion", { purpose, request: claim, result: busy });
    invalid("exchangeUnion", {
      purpose,
      request: claim,
      result: { ...busy, revocationOperationRef: "operation/other-revocation" },
    });
    for (const request of [mint, revoke]) {
      const result = {
        kind: "evidence-missing",
        operationRef: request.operationRef,
        incidentRef: "incident/outcome-evidence",
        providerOutcome: request.outcome,
        nextAction: "retain-unknown-and-exact-mitigation",
      };
      parse("exchangeUnion", { purpose, request, result });
      invalid("exchangeUnion", {
        purpose,
        request,
        result: { ...result, providerOutcome: "unknown" },
      });
    }

    // A late unknown report may return stronger retained inventory truth.
    const unknown = v.revokeOutcome("unknown");
    const { credentialPurpose, preparation, ...originalUnknown } = unknown;
    const request =
      purpose === v.purpose
        ? unknown
        : { ...originalUnknown, target: v.legacyReservedRecord().target };
    const current = v.tokenRecord();
    const { credentialPurpose: rowPurpose, ...originalRow } = current;
    const row =
      purpose === v.purpose
        ? current
        : { ...originalRow, issuance: v.legacyReserve(), target: v.legacyReservedRecord().target };
    row.inventoryVersion = 4;
    row.disposition = "mitigation-only";
    row.revocation = {
      state: "confirmed",
      version: 3,
      revocationOperationRef: request.revocationOperationRef,
      attemptRef: request.providerAttemptRef,
      observedAt: v.now,
      confirmationEvidenceRef: "evidence/retained-confirmation",
    };
    const intentDigest =
      purpose === v.purpose
        ? v.intentDigest("revokeOutcome", request)
        : v.hash(canonicalOriginal("revocationOutcome", request));
    const receipt = {
      schemaVersion: 1,
      operationRef: request.operationRef,
      intentDigest,
      commitRef: "commit/retained-confirmation",
      inventoryVersion: row.inventoryVersion,
      committedAt: v.now,
    };
    const retained = parse("exchangeUnion", {
      purpose,
      request,
      result: { kind: "recorded", receipt, record: row },
    });
    assert.equal(retained.request.outcome, "unknown");
    assert.equal(retained.result.record.revocation.state, "confirmed");
  }
});

test("checkout digests bind immutable preparation intent and exclude per-call correlation", () => {
  const request = v.checkoutRequest();
  const bytes = canonical("checkoutRequest", request);
  const { requestId, requestDigest, createdAt, deadline, ...intent } = request;
  assert.deepEqual(JSON.parse(bytes), { domain: "repository-checkout-v1", ...intent });
  assert.equal(v.hash(bytes), request.requestDigest);
  assert.equal(checkoutDigest(reverseKeys(request)), request.requestDigest);
  const retry = {
    ...request,
    requestId: `req_${v.id(90)}`,
    createdAt: v.at(1_000),
    deadline: v.at(6_000),
  };
  assert.equal(checkoutDigest(retry), request.requestDigest);
  parse("checkoutRequest", retry);
  for (const mutate of [
    (value) => {
      value.preparation.commit.oid = "b".repeat(40);
    },
    (value) => {
      value.preparation.incarnationRef = "incarnation/other";
    },
    (value) => {
      value.preparation.authorizationGeneration = 2;
    },
    (value) => {
      value.effectRef = v.id(90);
    },
  ]) {
    const changed = v.checkoutRequest();
    mutate(changed);
    invalid("checkoutRequest", changed);
    assert.notEqual(checkoutDigest(changed), request.requestDigest);
  }
});

test("inventory rows and fresh receipts preserve exact candidate issuance identity", () => {
  for (const mutate of [
    (value) => {
      value.issuance.preparation.incarnationRef = "incarnation/other";
    },
    (value) => {
      value.issuance.preparation.commit.oid = "b".repeat(40);
    },
    (value) => {
      value.issuance.preparation.gate.lifecycleGeneration = 2;
    },
    (value) => {
      value.target.issuanceOperationRef = "operation/other";
    },
    (value) => {
      value.target.intentDigest = v.LEGACY_RESERVE_DIGEST;
    },
  ]) {
    const input = v.tokenRecord();
    mutate(input);
    invalid("record", input);
  }
  for (const patch of [
    { operationRef: "operation/other" },
    { intentDigest: v.digest },
    { inventoryVersion: 2 },
  ]) {
    invalid("reservationResult", {
      ...v.reservationResult(),
      receipt: { ...v.receipt(), ...patch },
    });
  }
  for (const [kind, value] of [
    ["writeResult", v.writeResult()],
    ["claimResult", v.claimResult()],
  ]) {
    parse(kind, value);
    assert.notEqual(value.receipt.operationRef, value.record.issuance.operationRef);
  }
});

test("known late and scope-mismatched tokens remain inventory obligations for exact mitigation", () => {
  for (const patch of [
    { invalidationVersion: 2 },
    { expiry: { kind: "expiry-unproven" } },
    { returnedScope: { status: "mismatch", evidenceRef: "evidence/returned-scope" } },
    { returnedScope: { status: "unproved", evidenceRef: "evidence/returned-scope" } },
  ]) {
    invalid("record", { ...v.tokenRecord(), ...patch });
    const retained = parse("record", {
      ...v.tokenRecord(),
      ...patch,
      disposition: "mitigation-only",
    });
    assert.equal(retained.tokenRef, "token/candidate");
    assert.equal(retained.issuance.preparation.incarnationRef, v.subject().incarnationRef);
  }
  const late = {
    ...v.mintOutcome(),
    createdAt: v.at(900_001),
    deadline: v.at(905_001),
    observedAt: v.at(900_001),
  };
  parse("mintOutcome", late);
  invalid("mintOutcome", { ...late, original: v.legacyOriginalBinding() });
});

test("unknown issuance has no invented token custody or implicit no-effect transition", () => {
  for (const outcome of [
    "accepted",
    "definitely-rejected",
    "unknown",
    "unknown-expiry-established",
    "unknown-expired",
    "unknown-broader-revocation-confirmed",
  ])
    parse("mintOutcome", v.mintOutcome(outcome));
  for (const state of [
    "reserved",
    "mint-unknown",
    "not-issued",
    "resolved-without-token",
    "outstanding",
  ])
    parse("record", v.tokenRecord(state));
  for (const state of ["reserved", "mint-unknown", "not-issued", "resolved-without-token"])
    invalid("record", { ...v.tokenRecord(state), tokenRef: "token/invented" });
  invalid("mintOutcome", { ...v.mintOutcome("unknown"), tokenRef: "token/invented" });
  invalid("mintOutcome", { ...v.mintOutcome("unknown-expired"), observedAt: v.at(3_601_999) });
  parse("record", { ...v.tokenRecord("mint-unknown"), expiry: v.expiry() });
});

test("claim takeover retains prior provider uncertainty and conservative expiry", () => {
  for (const prior of ["none", "pending", "unknown", "failed-terminal"])
    parse("claimResult", v.claimResult(prior));
  invalid("claimResult", { ...v.claimResult("unknown"), nextAction: "attempt-exact-revocation" });
  for (const patch of [
    { claimRef: "claim/other" },
    { claimVersion: 3 },
    { claimNotAfter: v.at(4_999) },
  ])
    invalid("claimResult", { ...v.claimResult(), ...patch });
  for (const outcome of ["confirmed", "pending", "unknown", "failed-terminal", "expired"])
    parse("revokeOutcome", v.revokeOutcome(outcome));
  invalid("revokeOutcome", { ...v.revokeOutcome("expired"), observedAt: v.at(3_601_999) });
  invalid("revokeOutcome", { ...v.revokeOutcome("expired"), expiry: { kind: "expiry-unproven" } });
  invalid("claimResult", { ...v.claimResult(), token: {} });
});

test("fence and receipt variants do not claim readiness, cleanup completion or provider cessation", () => {
  for (const cause of [
    "completed",
    "cancelled",
    "replaced",
    "deadline",
    "authority-lost",
    "rotation",
    "recovery",
  ])
    parse("fence", { ...v.fence(), cause });
  invalid("fence", { ...v.fence(), expectedGrantVersion: 2 });
  invalid("fence", { ...v.fence(), invalidationVersion: 1 });
  invalid("fence", { ...v.fence(), invalidationVersion: 3 });
  const reasons = {
    incomplete: ["not-submitted", "evidence-incomplete", "capability-unavailable"],
    unknown: ["provider-outcome-unknown", "authority-unavailable"],
    rejected: [
      "authority-denied",
      "scope-mismatch",
      "commit-mismatch",
      "incarnation-mismatch",
      "storage-mismatch",
    ],
    cancelled: ["cancelled"],
    stale: ["deadline-exceeded", "replaced", "evidence-stale"],
    conflict: ["operation-conflict"],
  };
  for (const [status, allowed] of Object.entries(reasons)) {
    for (const reason of Object.values(reasons).flat()) {
      const value = v.receiptResult(status, reason);
      if (allowed.includes(reason)) {
        parse("receiptResult", value);
        invalid("receiptResult", { ...value, ready: true });
      } else invalid("receiptResult", value);
    }
  }
  parse("receiptResult", { status: "not-visible" });
  for (const field of [
    "ready",
    "cleanupComplete",
    "providerStopped",
    "authorized",
    "proof",
    "handle",
  ]) {
    invalid("fenceResult", { ...v.fenceResult(), [field]: true });
    invalid("receiptResult", { ...v.receiptResult(), [field]: true });
  }
  invalid("fenceResult", { ...v.fenceResult(), nextAction: "activate-candidate" });
  invalid("receiptResult", { ...v.receiptResult("unknown"), nextAction: "submit-again" });
});

test("checkout receipts match effect, commit, revision, incarnation and staging exactly", () => {
  for (const mutate of [
    (value) => {
      value.effectRef = v.id(90);
    },
    (value) => {
      value.effectRequestDigest = `sha256:${"b".repeat(64)}`;
    },
    (value) => {
      value.actualCommit.oid = "b".repeat(40);
    },
    (value) => {
      value.incarnationRef = "incarnation/other";
    },
    (value) => {
      value.revisionId = `rev_${v.id(90)}`;
    },
    (value) => {
      value.staging.bindingVersion = 2;
    },
    (value) => {
      value.staging.logicalStoreRef = "store/serving";
    },
    (value) => {
      value.staging.scope.agentId = `agt_${v.id(90)}`;
    },
  ]) {
    const input = v.checkoutReceipt();
    mutate(input);
    invalid("checkoutReceipt", input);
  }
  parseExchange(v.checkoutRequest(), v.receiptResult(), v.clock());
  for (const mutate of [
    (value) => {
      value.operationRef = "operation/other-checkout";
    },
    (value) => {
      value.effectRef = v.id(90);
    },
    (value) => {
      value.preparation.incarnationRef = "incarnation/other";
    },
    (value) => {
      value.preparation.gate.lifecycleGeneration = 2;
    },
    (value) => {
      value.preparation.authorizationGeneration = 2;
    },
    (value) => {
      value.preparation.commit.oid = "b".repeat(40);
    },
  ]) {
    const expected = v.checkoutRequest();
    mutate(expected);
    expected.requestDigest = checkoutDigest(expected);
    parse("checkoutRequest", expected);
    invalidExchange(expected, v.receiptResult());
  }
  invalidExchange({ ...v.checkoutRequest(), requestDigest: v.digest }, v.receiptResult());
  invalidExchange(v.checkoutRequest(), { ...v.receiptResult(), handle: {} });
});

test("receipt read-call retries retain semantic identity and the original effect deadline", () => {
  const original = v.checkoutRequest();
  const result = v.receiptResult();
  const recorrelation = { ...original, requestId: `req_${v.id(90)}` };
  assert.deepEqual(parseExchange(recorrelation, result, v.clock()), result);

  const freshRead = { ...recorrelation, createdAt: v.at(1_000), deadline: v.at(6_000) };
  assert.equal(checkoutDigest(freshRead), original.requestDigest);
  const readClock = {
    sourceObservedAt: v.at(2_000),
    receivedAt: v.at(2_000),
    validUntil: v.at(6_000),
    uncertaintyMs: 0,
  };
  const retained = parseExchange(freshRead, result, readClock);
  assert.deepEqual(retained, result);
  assert.equal(retained.receipt.request.createdAt, original.createdAt);
  assert.equal(retained.receipt.request.deadline, original.deadline);
  assert.deepEqual(
    parseExchange(freshRead, v.receiptResult("unknown"), readClock),
    v.receiptResult("unknown"),
  );

  // Even independently valid evidence and a fresh read-call deadline cannot
  // extend the producer's retained effect deadline.
  const longerEvidence = structuredClone(result);
  longerEvidence.receipt.provenance.clock.validUntil = v.at(6_000);
  parse("checkoutRequest", freshRead);
  parse("receiptResult", longerEvidence);
  const beforeExpiry = { ...readClock, sourceObservedAt: v.at(4_999), receivedAt: v.at(4_999) };
  assert.deepEqual(parseExchange(freshRead, longerEvidence, beforeExpiry), longerEvidence);
  const afterExpiry = { ...readClock, sourceObservedAt: v.at(5_001), receivedAt: v.at(5_001) };
  invalidExchange(freshRead, longerEvidence, afterExpiry);
});

test("receipt freshness is checked with bounded source age, uncertainty and current deadline", () => {
  const result = v.receiptResult();
  for (const field of ["sourceObservedAt", "receivedAt", "validUntil", "uncertaintyMs"]) {
    const missing = v.clock();
    delete missing[field];
    invalidExchange(v.checkoutRequest(), result, missing);
  }
  for (const validUntil of ["not-a-date", "2026-02-30T00:00:00.000Z", null]) {
    invalidExchange(v.checkoutRequest(), result, { ...v.clock(), validUntil });
    const changed = structuredClone(result);
    changed.receipt.provenance.clock.validUntil = validUntil;
    invalid("receiptResult", changed);
  }
  invalidExchange(v.checkoutRequest(), result, { ...v.clock(), callerProof: true });
  for (const patch of [
    { uncertaintyMs: 2_001 },
    { uncertaintyMs: -1 },
    { sourceObservedAt: v.at(1_000), receivedAt: v.now },
    { validUntil: v.at(-1) },
  ]) {
    const changed = structuredClone(result);
    Object.assign(changed.receipt.provenance.clock, patch);
    invalidExchange(v.checkoutRequest(), changed);
  }
  invalidExchange(v.checkoutRequest(), result, {
    ...v.clock(),
    sourceObservedAt: v.at(6_000),
    receivedAt: v.at(6_000),
    validUntil: v.at(10_000),
  });
});

test("receipt and evaluation clocks retain the intrinsic Runtime interval and uncertainty bounds", () => {
  const request = v.checkoutRequest();
  const boundary = { ...v.clock(), validUntil: v.at(15_000) };
  const receipt = v.receiptResult();
  receipt.receipt.provenance.clock = boundary;
  assert.deepEqual(parse("receiptResult", receipt), receipt);
  assert.deepEqual(parseExchange(request, receipt, boundary), receipt);
  const overlong = { ...boundary, validUntil: v.at(15_001) };
  const invalidReceipt = structuredClone(receipt);
  invalidReceipt.receipt.provenance.clock = overlong;
  invalid("receiptResult", invalidReceipt);
  invalidExchange(request, invalidReceipt);
  invalidExchange(request, receipt, overlong);

  const uncertaintyBoundary = { ...v.clock(), sourceObservedAt: v.at(1_000), uncertaintyMs: 1_000 };
  const uncertainReceipt = v.receiptResult();
  uncertainReceipt.receipt.provenance.clock = uncertaintyBoundary;
  parse("receiptResult", uncertainReceipt);
  assert.deepEqual(parseExchange(request, uncertainReceipt, v.clock()), uncertainReceipt);
  assert.deepEqual(
    parseExchange(request, v.receiptResult(), uncertaintyBoundary),
    v.receiptResult(),
  );
  const futureSource = { ...uncertaintyBoundary, sourceObservedAt: v.at(1_001) };
  const futureReceipt = v.receiptResult();
  futureReceipt.receipt.provenance.clock = futureSource;
  invalid("receiptResult", futureReceipt);
  invalidExchange(request, v.receiptResult(), futureSource);
});

test("preparation, authority and invocation deadlines keep their separate finite bounds", () => {
  parse("subject", { ...v.subject(), notAfter: v.at(limits.preparationMaxMs) });
  for (const notAfter of [v.now, v.at(limits.preparationMaxMs + 1), "2026-02-30T00:00:00.000Z"])
    invalid("subject", { ...v.subject(), notAfter });
  for (const deadline of [v.now, v.at(limits.storageCallMaxMs + 1)]) {
    invalid("reserve", { ...v.reserve(), deadline });
  }
  parse("checkoutRequest", { ...v.checkoutRequest(), deadline: v.at(limits.preparationMaxMs) });
  for (const deadline of [v.now, v.at(limits.preparationMaxMs + 1)])
    invalid("checkoutRequest", { ...v.checkoutRequest(), deadline });
  invalid("authority", { ...v.authority(), comparedAt: v.at(-1), startNotAfter: v.at(999) });
  invalid("authority", { ...v.authority(), leaseNotAfter: v.at(900_001) });
  invalid("authority", { ...v.authority(), startNotAfter: v.at(5_001) });
});

test("exact affected snapshots cannot mix candidates, filters, pages or understated live counts", () => {
  const input = v.affected();
  assert.equal(filterDigest(input), filterDigest({ ...input, requestId: `req_${v.id(90)}` }));
  invalid("affected", { ...input, cursor: { ...v.cursor(), filterDigest: v.digest } });
  const foreign = v.tokenRecord();
  foreign.issuance.preparation.incarnationRef = "incarnation/other";
  foreign.target = v.locator(foreign.issuance);
  invalid("page", v.page([foreign]));
  invalid("page", { ...v.page(), next: { ...v.cursor(), snapshotVersion: 2 } });
  invalid("page", { ...v.page(), next: { ...v.cursor(), afterRecordRef: "record/other" } });
  invalid("page", { ...v.page(), outstandingCount: 0 });
  invalid("page", v.page([v.tokenRecord(), v.tokenRecord()]));
  invalid("page", { ...v.page([]), next: v.cursor() });
  parse("page", { ...v.page([]), unresolvedIssuanceCount: 1 });
});

test("mandatory audit failure fences new authority and retains explicit mitigation evidence", () => {
  const audit = {
    state: "obligation-recorded",
    eventRef: `aud_${v.id(8)}`,
    obligationRef: "obligation/candidate",
    commitRef: "commit/obligation",
  };
  invalid("reservationResult", { ...v.reservationResult(), audit });
  parse("claimResult", { ...v.claimResult(), audit });
  parse("record", { ...v.tokenRecord(), audit, disposition: "mitigation-only" });
  const fenceEvidenceMissing = {
    kind: "evidence-missing",
    operationRef: v.fence().operationRef,
    incidentRef: "incident/fence-inventory",
    nextAction: "retain-unknown-and-exact-mitigation",
  };
  assert.deepEqual(parse("fenceResult", fenceEvidenceMissing), fenceEvidenceMissing);
  parse("exchangeUnion", { purpose: v.purpose, request: v.fence(), result: fenceEvidenceMissing });
  invalid("fenceResult", { ...fenceEvidenceMissing, providerOutcome: "accepted" });
  invalid("exchangeUnion", {
    purpose: v.purpose,
    request: v.fence(),
    result: { ...fenceEvidenceMissing, providerOutcome: "accepted" },
  });
  parse("writeResult", {
    kind: "evidence-missing",
    operationRef: "operation/prepare-mint-outcome",
    incidentRef: "incident/inventory",
    providerOutcome: "accepted",
    nextAction: "retain-unknown-and-exact-mitigation",
  });
  parse("useResult", {
    kind: "effect-unknown",
    reason: "provider-outcome-unknown",
    operationRef: "operation/prepare-use",
    nextAction: "exact-readback-only",
  });
  parse("deliveryResult", {
    kind: "delivery-unknown",
    operationRef: "operation/prepare-deliver",
    deliveryRef: "delivery/candidate",
    nextAction: "exact-readback-only",
  });
});

test("JSON boundaries reject accessors, proxies, duplicate keys and hidden precision loss", () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error("must not execute");
  };
  const input = v.subject();
  Object.defineProperty(input, "commit", { enumerable: true, get: trap });
  invalid("subject", input);
  invalid("subject", new Proxy(v.subject(), { get: trap, getPrototypeOf: trap, ownKeys: trap }));
  const nested = v.subject();
  nested.gate = new Proxy(nested.gate, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  invalid("subject", nested);
  assert.equal(calls, 0);
  invalid("subject", Object.assign(Object.create({ inherited: true }), v.subject()));
  const symbol = v.subject();
  symbol[Symbol("hidden")] = true;
  invalid("subject", symbol);
  const hidden = v.subject();
  Object.defineProperty(hidden, "hidden", { value: true });
  invalid("subject", hidden);
  const cyclic = v.subject();
  cyclic.commit = cyclic;
  invalid("subject", cyclic);
  parse("subject", Object.assign(Object.create(null), v.subject()));
  const raw = JSON.stringify(v.subject());
  invalidJson(
    "subject",
    raw.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
  );
  for (const lexeme of [
    "1.0000000000000001",
    "9007199254740991.1",
    "1.0",
    "1e0",
    "-0",
    "9007199254740992",
  ])
    invalidJson(
      "subject",
      raw.replace('"authorizationGeneration":1', `"authorizationGeneration":${lexeme}`),
    );
  invalidJson("subject", raw.replace('"schemaVersion":1', '"schemaVersion":1.0000000000000001'));
  parseJson(
    "subject",
    raw.replace('"authorizationGeneration":1', '"authorizationGeneration":9007199254740991'),
  );
  parseJson("subject", raw);
});

test("plain-data size, depth and safe numeric ceilings are explicit", () => {
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    invalid("subject", { ...v.subject(), authorizationGeneration: version });
  let deep = {};
  for (let i = 0; i <= limits.maxJsonDepth; i++) deep = { nested: deep };
  invalid("subject", { ...v.subject(), commit: deep });
  for (const [kind, input, max] of [
    ["reserve", v.reserve(), limits.maxRequestBytes],
    ["receiptResult", { status: "not-visible" }, limits.maxResponseBytes],
  ]) {
    const raw = JSON.stringify(input);
    const padding = max - Buffer.byteLength(raw);
    parseJson(kind, raw + " ".repeat(padding));
    invalidJson(kind, raw + " ".repeat(padding + 1));
  }
});

test("immutable protocol traces validate actual values and do not execute adapter obligations", () => {
  frozen(protocolTraces);
  for (const trace of protocolTraces) {
    for (const observation of trace.observations)
      assert.deepEqual(parse(observation.schema, observation.value), observation.value, trace.name);
  }
});
