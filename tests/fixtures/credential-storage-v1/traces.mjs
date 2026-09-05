import { parseCredentialStorageV1 } from "../../../packages/contracts/src/index.ts";
import * as v from "./vectors.mjs";

/**
 * Normative adapter scenarios, NOT executions of an inventory, authority issuer,
 * secret backend, provider, audit sink or delivery callback. The conformance
 * test executes only the exported parser against these protocol values.
 * Expected actions require separate real adapter acceptance tests.
 *
 * @template {import("../../../packages/contracts/src/index.ts").CredentialStorageSchemaNameV1} K
 * @param {K} schema
 * @param {unknown} value
 * @returns {{ schema: K, value: import("../../../packages/contracts/src/index.ts").CredentialStorageValueV1<K> }}
 */
function message(schema, value) {
  return { schema, value: parseCredentialStorageV1(schema, value) };
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

const unknownCommit = {
  kind: "commit-unknown",
  operationRef: "operation/reserve",
  intentDigest: v.locator().intentDigest,
  nextAction: "exact-readback-only",
};
const noExpiry = v.tokenRecord();
noExpiry.expiry = { kind: "expiry-unproven" };
noExpiry.disposition = "mitigation-only";
const scopeMismatch = v.tokenRecord();
scopeMismatch.returnedScope.status = "mismatch";
scopeMismatch.disposition = "mitigation-only";
const invalidated = v.tokenRecord();
invalidated.invalidationVersion = 2;
invalidated.disposition = "mitigation-only";
const unknownDelivery = v.tokenRecord();
unknownDelivery.inventoryVersion = 3;
unknownDelivery.delivery = {
  state: "unknown",
  deliveryRef: "delivery/example",
  deliveryOperationRef: "operation/deliver",
  observedAt: v.now,
};
const revokeUnknown = v.tokenRecord();
revokeUnknown.inventoryVersion = 4;
revokeUnknown.disposition = "mitigation-only";
revokeUnknown.revocation = {
  state: "unknown",
  version: 3,
  revocationOperationRef: "operation/revoke",
  attemptRef: "provider-attempt/revoke",
  observedAt: v.now,
};
const obligated = structuredClone(revokeUnknown);
obligated.audit = {
  state: "obligation-recorded",
  eventRef: v.audit().eventRef,
  obligationRef: "audit-obligation/revoke",
  commitRef: "commit/revoke-obligation",
};
const missingEvidence = structuredClone(revokeUnknown);
missingEvidence.audit = {
  state: "evidence-missing",
  eventRef: v.audit().eventRef,
  incidentRef: "incident/revoke-evidence",
};
const expired = structuredClone(revokeUnknown);
expired.revocation = {
  state: "expired",
  version: 4,
  observedAt: v.at(3_602_000),
  expiry: v.expiry(),
  clockEvidenceRef: "evidence/clock",
  uncertaintyMs: 2_000,
};
const unresolvedIssuance = v.reserve();
unresolvedIssuance.operationRef = "operation/reserve-unresolved";
const unresolvedRow = v.tokenRecord("mint-unknown", unresolvedIssuance);
unresolvedRow.target.recordRef = "record/unknown";
const firstPage = v.affectedPage([unresolvedRow, v.tokenRecord()]);
firstPage.next = v.cursor();
const changedFilter = v.affectedQuery();
changedFilter.filter.invalidationVersion = 3;
const takeoverRequest = {
  ...v.claimRevocation(),
  createdAt: v.at(6_000),
  deadline: v.at(11_000),
  expectedInventoryVersion: 4,
  expectedRevocationVersion: 3,
  previousAttempt: {
    kind: "reconcile",
    attemptRef: "provider-attempt/revoke",
    providerOutcome: "unknown",
  },
};
const takeoverResult = v.claimResult("unknown");
takeoverResult.receipt = v.receipt(takeoverRequest, 5);
takeoverResult.receipt.committedAt = v.at(6_000);
takeoverResult.record.inventoryVersion = 5;
takeoverResult.record.updatedAt = v.at(6_000);
takeoverResult.record.revocation.version = 4;
takeoverResult.record.revocation.claimedAt = v.at(6_000);
takeoverResult.record.revocation.claimNotAfter = v.at(11_000);
takeoverResult.claimVersion = 4;
takeoverResult.claimNotAfter = v.at(11_000);

/** Values are schema-typed by message(), then the full scenario graph is frozen. */
export const protocolTraces = freeze([
  {
    name: "intent-before-mint-and-inventory-before-delivery",
    observations: [
      message("reserve", v.reserve()),
      message("reservationResult", v.reservationResult()),
      message("namedUse", v.namedUse()),
      message("useResult", v.useResult()),
      message("mintOutcome", v.mintOutcome()),
      message("writeResult", v.writeResult()),
      message("deliver", v.deliver()),
      message("deliveryResult", v.deliveryResult()),
    ],
    expectedAdapterActions: [
      "Commit the exact issuance intent and required audit before invoking the fixed provider adapter.",
      "Before callback, atomically CAS-claim the single preknown provider attempt and durably link issuance, named-use operation and attempt in the same protected journal.",
      "Preserve that claim across replicas, restart and acknowledgement loss; a new named-use operation or fresh authority cannot invoke a second possible mint.",
      "Keep accepted token custody inside the protected owner until its inventory write is known committed.",
      "Persist delivery intent, then compare and consume current original-turn authority at release.",
    ],
  },
  {
    name: "duplicate-operation-reconciles-without-second-mint",
    observations: [
      message("reserve", v.reserve()),
      message("reservationResult", {
        kind: "existing",
        record: v.tokenRecord("reserved"),
        nextAction: "reconcile-only",
      }),
      message("reserve", { ...v.reserve(), callerServiceRef: "service/other" }),
      message("reservationResult", { kind: "conflict", reason: "operation-conflict" }),
    ],
    expectedAdapterActions: [
      "Return existing state for an exact operation and semantic body; do not invoke the provider again.",
      "Reject changed ownership, assignment, scope, versions or body under the same operation identity.",
    ],
  },
  {
    name: "accepted-token-with-unproved-expiry-is-mitigation-only",
    observations: [
      message("mintOutcome", { ...v.mintOutcome(), expiry: { kind: "expiry-unproven" } }),
      message("record", noExpiry),
    ],
    expectedAdapterActions: [
      "Retain known token custody and exact revocation material in inventory.",
      "Suppress delivery and refresh authority; absent expiry evidence cannot become an expired or absent token.",
    ],
  },
  {
    name: "accepted-token-with-mismatched-scope-is-mitigation-only",
    observations: [
      message("mintOutcome", { ...v.mintOutcome(), returnedScope: scopeMismatch.returnedScope }),
      message("record", scopeMismatch),
    ],
    expectedAdapterActions: [
      "Inventory the accepted token even when its returned scope does not match the requested grant.",
      "Suppress delivery and retain only independently preauthorized exact mitigation.",
    ],
  },
  {
    name: "late-provider-response-after-rotation",
    observations: [
      message("reserve", v.reserve()),
      message("rotate", v.rotate()),
      message("rotationResult", v.rotationResult()),
      message("mintOutcome", {
        ...v.mintOutcome(),
        createdAt: v.at(6_000),
        deadline: v.at(11_000),
        observedAt: v.at(6_000),
      }),
      message("writeResult", { kind: "conflict", reason: "version-conflict" }),
      message("mintOutcome", {
        ...v.mintOutcome(),
        operationRef: "operation/mint-outcome-reconcile",
        expectedInventoryVersion: 2,
        createdAt: v.at(7_000),
        deadline: v.at(12_000),
        observedAt: v.at(6_000),
      }),
      message("record", { ...invalidated, inventoryVersion: 3, updatedAt: v.at(7_000) }),
    ],
    expectedAdapterActions: [
      "Atomically replace the binding, advance invalidation, and persist the affected scan intent.",
      "Fence old-version selection while preserving the original issuer's late outcome responsibility.",
      "Record the late old-version token as mitigation-only; do not deliver or relabel it as a new-version mint.",
      "After a definite CAS conflict, a separately authorized reconciliation operation may use current inventory CAS while retaining the original issuance, provider attempt, token and authenticated outcome.",
      "Do not change the prior operation's CAS or digest, start new provider work or overwrite stronger terminal evidence. Unknown commit acknowledgement instead requires exact readback of the unchanged original operation first.",
    ],
  },
  {
    name: "narrowing-races-with-delivery",
    observations: [
      message("deliver", v.deliver()),
      message("record", invalidated),
      message("deliveryResult", { kind: "denied", reason: "authority-denied" }),
    ],
    expectedAdapterActions: [
      "Compare current grant, policy, secret, mode, assignment and invalidation at the actual release boundary.",
      "Suppress a release that loses the invalidation race and retain the token for exact revocation.",
      "Track a release that wins the race as potentially delivered; later narrowing cannot erase it.",
    ],
  },
  {
    name: "known-provider-acceptance-before-inventory-failure",
    observations: [
      message("mintOutcome", v.mintOutcome()),
      message("writeResult", {
        kind: "evidence-missing",
        operationRef: "operation/mint-outcome",
        incidentRef: "incident/inventory",
        providerOutcome: "accepted",
        nextAction: "retain-unknown-and-exact-mitigation",
      }),
    ],
    expectedAdapterActions: [
      "Suppress delivery because no durable inventory acceptance is known.",
      "Retain protected custody and exact reconciliation responsibility; expose the missing-evidence incident.",
      "Do not claim a successful write, absent issuance, rollback or permission to mint again.",
    ],
  },
  {
    name: "reservation-persistence-ack-loss",
    observations: [
      message("reservationResult", unknownCommit),
      message("readOperation", v.readOperation()),
      message("operationResult", v.operationResult()),
    ],
    expectedAdapterActions: [
      "Read back the exact original operation and digest after an unknown commit acknowledgement.",
      "Treat found state as observation only; readback cannot construct a current effect handle.",
    ],
  },
  {
    name: "broker-restart-and-unavailable-readback",
    observations: [
      message("record", v.tokenRecord("mint-unknown")),
      message("readOperation", v.readOperation()),
      message("operationResult", { kind: "unavailable", nextAction: "exact-readback-only" }),
      message("operationResult", { kind: "not-found", nextAction: "exact-readback-only" }),
    ],
    expectedAdapterActions: [
      "Recover the durable original operation across replicas and restarts without reusing a process-local handle.",
      "Keep unresolved issuance and its capacity slot while readback is unavailable or not found.",
      "Neither restart nor a missing read result permits a duplicate mint or delivery.",
    ],
  },
  {
    name: "delivery-callback-or-ack-loss",
    observations: [
      message("deliver", v.deliver()),
      message("deliveryResult", {
        kind: "delivery-unknown",
        operationRef: "operation/deliver",
        deliveryRef: "delivery/example",
        nextAction: "exact-readback-only",
      }),
      message("record", unknownDelivery),
      message("operationResult", {
        kind: "found",
        operationRef: "operation/deliver",
        intentDigest: v.intentDigest("deliver", v.deliver()),
        originalMethod: "deliverRecordedToken",
        state: "effect-unknown",
        record: unknownDelivery,
        nextAction: "observation-only",
      }),
    ],
    expectedAdapterActions: [
      "Preserve the delivery operation and reference: bytes may already have reached the selected runtime.",
      "Reconcile exact delivery state without replaying the callback or inferring rollback.",
    ],
  },
  {
    name: "revoke-response-loss-and-claim-takeover",
    observations: [
      message("claimRevocation", v.claimRevocation()),
      message("claimResult", v.claimResult()),
      message("revocationOutcome", v.revocationOutcome("unknown")),
      message("record", revokeUnknown),
      message("claimRevocation", takeoverRequest),
      message("claimResult", takeoverResult),
    ],
    expectedAdapterActions: [
      "Allow only the CAS winner to start one exact revocation attempt.",
      "Retain response loss as unknown, with the same provider attempt identity.",
      "A takeover first reconciles that attempt: claim lease expiry does not prove provider completion.",
      "A definite conflict recording late revocation evidence permits a fresh reconciliation operation/current CAS while retaining the original provider attempt and claim, even after its lease expires. Commit acknowledgement loss first reads the unchanged original operation.",
    ],
  },
  {
    name: "unknown-issuance-with-no-token-bytes-retains-scope-until-proven-expiry",
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
    expectedAdapterActions: [
      "Keep the exact issuance scope reserved while provider issuance is unknown and no token bytes are available.",
      "Record later provider expiry evidence without inventing token custody or releasing scope before that expiry.",
      "Resolve without token bytes only when retained expiry and conservative clock evidence prove no live token remains.",
    ],
  },
  {
    name: "unknown-issuance-resolves-through-separately-authorized-broader-revocation",
    observations: [
      message("record", v.tokenRecord("mint-unknown")),
      message("mintOutcome", {
        ...v.mintOutcome("unknown-broader-revocation-confirmed"),
        expectedInventoryVersion: 2,
      }),
      message("record", {
        ...v.tokenRecord("resolved-without-token"),
        inventoryVersion: 3,
        updatedAt: v.now,
        resolution: {
          kind: "broader-revocation-confirmed",
          observedAt: v.now,
          broaderRevocation: v.broaderRevocation(),
        },
      }),
    ],
    expectedAdapterActions: [
      "Retain unknown issuance without fabricating a token handle for token-specific revocation.",
      "Require independent exact responsibility and provider confirmation for a broader revocation that covers the unknown issuance.",
      "Record resolution evidence while keeping its scope and authority separate from ordinary token-specific mitigation.",
    ],
  },
  {
    name: "provider-expiry-requires-clock-evidence",
    observations: [
      message("revocationOutcome", v.revocationOutcome("expired")),
      message("record", expired),
    ],
    expectedAdapterActions: [
      "Establish provider expiry from retained provider evidence and a clock lower bound after expiry.",
      "Keep expired distinct from provider-confirmed revocation; never substitute lease or retry deadline expiry.",
      "Retain terminal audit evidence for the required minimum; unresolved outcomes are not evicted for age.",
    ],
  },
  {
    name: "audit-outage-blocks-new-authority-and-retains-mitigation-obligation",
    observations: [
      message("reservationResult", { kind: "unavailable", reason: "audit-unavailable" }),
      message("record", obligated),
      message("claimRevocation", takeoverRequest),
      message("claimResult", {
        ...takeoverResult,
        audit: obligated.audit,
        record: { ...takeoverResult.record, audit: obligated.audit },
      }),
    ],
    expectedAdapterActions: [
      "Block issuance and delivery that lack mandatory audit acceptance.",
      "Continue independently preauthorized exact disable, attenuation and revocation during sink outage.",
      "Retain the durable audit obligation when the operation store remains available.",
    ],
  },
  {
    name: "mitigation-audit-and-inventory-evidence-unavailable",
    observations: [
      message("record", missingEvidence),
      message("writeResult", {
        kind: "evidence-missing",
        operationRef: "operation/revoke-outcome",
        incidentRef: "incident/revoke-evidence",
        providerOutcome: "unknown",
        nextAction: "retain-unknown-and-exact-mitigation",
      }),
    ],
    expectedAdapterActions: [
      "Do not suppress independently preauthorized exact mitigation because audit delivery is unavailable.",
      "Expose missing evidence and preserve unknown outcomes; do not claim an unavailable durable write succeeded.",
      "Do not invent wider emergency authority when secret, inventory or authority owners are unavailable.",
    ],
  },
  {
    name: "snapshot-pagination-changes-and-unresolved-issuance",
    observations: [
      message("affectedQuery", v.affectedQuery()),
      message("affectedPage", firstPage),
      message("affectedQuery", { ...v.affectedQuery(), cursor: v.cursor() }),
      message("affectedPage", { kind: "snapshot-invalid", nextAction: "restart-exact-filter" }),
      message("affectedQuery", changedFilter),
      message("affectedPage", { ...v.affectedPage([], changedFilter), unresolvedIssuanceCount: 1 }),
    ],
    expectedAdapterActions: [
      "Bind continuation to the exact authorized filter and retained snapshot version.",
      "Restart the exact authorized filter when a snapshot expires or changes; never splice pages across snapshots.",
      "A final empty page covers only its persisted snapshot; unresolved issuance still prevents a no-token conclusion.",
    ],
  },
]);
