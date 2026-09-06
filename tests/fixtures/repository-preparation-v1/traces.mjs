import { parseRepositoryPreparationV1 } from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
import * as v from "./vectors.mjs";

// Normative adapter expectations only. These do not execute a credential owner,
// authority evaluator, Compute producer, storage transaction or readiness gate.
export const traceExpectations = Object.freeze([
  Object.freeze({
    name: "exact-candidate-reservation-and-single-mint-attempt",
    requiredActions: Object.freeze([
      "Compare the admitted candidate purpose, revision, repository, commit, incarnation and generations before acquisition.",
      "Commit immutable issuance intent and mandatory audit, then atomically claim one provider attempt before the fixed callback.",
      "A lost claim acknowledgement, restarted caller or new operation ID never permits a second possible mint for the issuance.",
      "Recheck exact current authority after asynchronous acquisition and before use; persist known token custody before delivery.",
    ]),
  }),
  Object.freeze({
    name: "replacement-or-cancellation-during-await",
    requiredActions: Object.freeze([
      "Fence new candidate credential use when replacement, cancellation, deadline or generation changes win the race.",
      "Attach late known tokens and unknown provider outcomes to the original candidate and retained attempt.",
      "Continue only independently preauthorized exact mitigation; never retarget the successor or independently serving grant.",
    ]),
  }),
  Object.freeze({
    name: "unknown-after-submission-and-cancel-acknowledgement",
    requiredActions: Object.freeze([
      "Treat a lost submit response, timeout or cancellation acknowledgement as insufficient proof of no clone or token effect.",
      "Read back the unchanged original operation and semantic digest before any reconciliation decision.",
      "Preserve pending and unknown outcomes; neither transport completion nor elapsed local deadline proves readiness, cleanup or provider termination.",
    ]),
  }),
  Object.freeze({
    name: "late-evidence-after-definite-cas-conflict",
    requiredActions: Object.freeze([
      "Only a definite conflict permits a separately authorized new reconciliation operation with current CAS.",
      "Retain the original issuance, provider attempt, applicable claim and authenticated outcome while recording historical truth.",
      "Do not edit the old operation digest, repeat possible effects or overwrite stronger terminal evidence.",
    ]),
  }),
  Object.freeze({
    name: "protected-compute-receipt-correspondence",
    requiredActions: Object.freeze([
      "Require the actual protected Compute producer context and exact request, effect, digest, revision, commit, incarnation and storage correspondence.",
      "Repeat currentness checks after receipt acquisition and preserve unknown or stale results.",
      "Parsed completion metadata and caller proof confer no readiness; the Runtime owner supplies Job applicability without Deployment coercion.",
    ]),
  }),
  Object.freeze({
    name: "candidate-cleanup-preserves-independent-serving-resources",
    requiredActions: Object.freeze([
      "Limit cleanup and credential mitigation to the exact failed candidate, incarnation and retained responsibility.",
      "Preserve serving revision resources and its independent original-turn credential attribution.",
      "Retain cleanup uncertainty until the protected producer reports exact evidence; local denial or token expiry is not staging cleanup proof.",
    ]),
  }),
  Object.freeze({
    name: "audit-outage-and-inventory-recovery",
    requiredActions: Object.freeze([
      "Deny new authority when mandatory audit or inventory acceptance is unavailable.",
      "Preserve independently preauthorized exact mitigation and durable audit obligation or explicit missing-evidence incidents.",
      "Keep pending, unknown, overlap and late outcomes in the original candidate inventory across restart; an empty snapshot page cannot prove global closure.",
    ]),
  }),
]);

/**
 * @template {import("@openclaw-enterprise/contracts/repository-preparation-v1").RepositoryPreparationSchemaNameV1} K
 * @param {K} schema
 * @param {unknown} value
 * @returns {{ schema: K, value: import("@openclaw-enterprise/contracts/repository-preparation-v1").RepositoryPreparationValueV1<K> }}
 */
function message(schema, value) {
  return { schema, value: parseRepositoryPreparationV1(schema, value) };
}
function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const invalidated = { ...v.tokenRecord(), invalidationVersion: 2, disposition: "mitigation-only" };
const unknownCommit = {
  kind: "commit-unknown",
  operationRef: v.reserve().operationRef,
  intentDigest: v.intentDigest("reserve", v.reserve()),
  nextAction: "exact-readback-only",
};
const auditObligation = {
  state: "obligation-recorded",
  eventRef: v.audit().eventRef,
  obligationRef: "obligation/candidate-revoke",
  commitRef: "commit/obligation",
};

export const protocolTraces = freeze([
  {
    ...traceExpectations[0],
    observations: [
      message("reserve", v.reserve()),
      message("reservationResult", v.reservationResult()),
      message("namedUse", v.namedUse()),
      message("mintOutcome", v.mintOutcome()),
      message("writeResult", v.writeResult()),
      message("delivery", v.delivery()),
      message("deliveryResult", v.deliveryResult()),
      message("checkoutRequest", v.checkoutRequest()),
      message("receiptResult", v.receiptResult()),
    ],
  },
  {
    ...traceExpectations[1],
    observations: [
      message("reserve", v.reserve()),
      message("namedUse", v.namedUse()),
      message("fence", { ...v.fence(), cause: "replaced" }),
      message("fenceResult", v.fenceResult()),
      message("mintOutcome", {
        ...v.mintOutcome(),
        observedAt: v.at(6_000),
        createdAt: v.at(6_000),
        deadline: v.at(11_000),
      }),
      message("record", { ...invalidated, inventoryVersion: 4, updatedAt: v.at(6_000) }),
      message("deliveryResult", { kind: "denied", reason: "authority-denied" }),
    ],
  },
  {
    ...traceExpectations[2],
    observations: [
      message("reservationResult", unknownCommit),
      message("readOperation", v.readOperation()),
      message("operationResult", { kind: "unavailable", nextAction: "exact-readback-only" }),
      message("checkoutRequest", v.checkoutRequest()),
      message("receiptResult", v.receiptResult("unknown", "provider-outcome-unknown")),
      message("receiptResult", v.receiptResult("cancelled", "cancelled")),
      message("receiptResult", v.receiptResult("unknown", "provider-outcome-unknown")),
      message("receiptResult", v.receiptResult("stale", "deadline-exceeded")),
      message("receiptResult", v.receiptResult("unknown", "provider-outcome-unknown")),
      message("operationResult", v.operationResult()),
    ],
  },
  {
    ...traceExpectations[3],
    observations: [
      message("mintOutcome", v.mintOutcome()),
      message("writeResult", { kind: "conflict", reason: "version-conflict" }),
      message("mintOutcome", {
        ...v.mintOutcome(),
        operationRef: "operation/prepare-reconcile",
        expectedInventoryVersion: 3,
      }),
      message("record", { ...invalidated, inventoryVersion: 4 }),
      message("revokeOutcome", v.revokeOutcome("unknown")),
    ],
  },
  {
    ...traceExpectations[4],
    observations: [
      message("checkoutRequest", v.checkoutRequest()),
      message("receiptResult", v.receiptResult("incomplete", "evidence-incomplete")),
      message("receiptResult", v.receiptResult("stale", "evidence-stale")),
      message("receiptResult", v.receiptResult("conflict", "operation-conflict")),
      message("receiptResult", v.receiptResult()),
    ],
  },
  {
    ...traceExpectations[5],
    observations: [
      message("inventoryUnion", {
        purpose: "original-turn-runtime",
        record: v.legacyReservedRecord(),
      }),
      message("fence", v.fence()),
      message("fenceResult", v.fenceResult()),
      message("record", invalidated),
      message("claim", v.claim()),
      message("claimResult", v.claimResult()),
      message("receiptResult", v.receiptResult("cancelled", "cancelled")),
      message("receiptResult", v.receiptResult("unknown", "provider-outcome-unknown")),
      message("inventoryUnion", {
        purpose: "original-turn-runtime",
        record: v.legacyReservedRecord(),
      }),
    ],
  },
  {
    ...traceExpectations[6],
    observations: [
      message("reservationResult", { kind: "unavailable", reason: "audit-unavailable" }),
      message("record", { ...invalidated, audit: auditObligation }),
      message("claimResult", { ...v.claimResult(), audit: auditObligation }),
      message("writeResult", {
        kind: "evidence-missing",
        operationRef: "operation/prepare-mint-outcome",
        incidentRef: "incident/candidate-inventory",
        providerOutcome: "accepted",
        nextAction: "retain-unknown-and-exact-mitigation",
      }),
      message("page", { ...v.page([]), unresolvedIssuanceCount: 1 }),
    ],
  },
  {
    name: "unknown-without-token-bytes-preserves-scope-and-expiry-evidence",
    requiredActions: [
      "Retain the candidate issuance and its capacity obligation while token bytes and provider outcome are unknown.",
      "Accept later provider-derived expiry evidence without inventing custody or prematurely releasing the issuance scope.",
      "Resolve only from conservative elapsed expiry or separately authorized broader revocation evidence; local cancellation and deadlines prove neither.",
    ],
    observations: [
      message("mintOutcome", v.mintOutcome("unknown")),
      message("record", v.tokenRecord("mint-unknown")),
      message("mintOutcome", {
        ...v.mintOutcome("unknown-expiry-established"),
        expectedInventoryVersion: 2,
      }),
      message("record", {
        ...v.tokenRecord("mint-unknown"),
        inventoryVersion: 3,
        expiry: v.expiry(),
      }),
      message("mintOutcome", { ...v.mintOutcome("unknown-expired"), expectedInventoryVersion: 3 }),
      message("record", { ...v.tokenRecord("resolved-without-token"), inventoryVersion: 4 }),
    ],
  },
]);
