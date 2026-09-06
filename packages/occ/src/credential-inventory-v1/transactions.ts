import { createHash, randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  OutstandingTokenRecordSchemaV1,
  canonicalCredentialStorageRequestV1,
  credentialAffectedFilterDigestV1,
  parseCredentialStorageV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CredentialAuditEvidenceV1,
  AffectedTokenPageV1,
  AffectedTokenQueryV1,
  ClaimRevocationV1,
  CredentialOperationResultV1,
  EphemeralTokenHandleV1,
  ExactCredentialOperationV1,
  InventoryWriteResultV1,
  IssuanceReservationResultV1,
  MintOutcomeV1,
  OutstandingTokenRecordV1,
  ReserveIssuanceV1,
  RevocationClaimResultV1,
  RevocationOutcomeV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CredentialInventoryTransactionV1 as Tx,
  InventoryMutationV1,
  InventoryOperationV1,
  InventorySnapshotV1,
  MintClaimInputV1,
  MintClaimResultV1,
} from "./ports.ts";

export const INVENTORY_LIMITS_V1 = Object.freeze({
  perAgent: CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerAgent,
  perInstallation: CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerInstallation,
  unresolvedPerScope: CREDENTIAL_STORAGE_LIMITS_V1.maxConcurrentIssuancePerScope,
  snapshotMs: CREDENTIAL_STORAGE_LIMITS_V1.snapshotMaxAgeMs,
  claimMs: CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
  terminalRetentionMs: CREDENTIAL_STORAGE_LIMITS_V1.terminalRetentionMs,
});
const conflict = (reason: "operation-conflict" | "version-conflict" = "operation-conflict") =>
  ({ kind: "conflict", reason }) as const;
const unavailable = { kind: "unavailable", reason: "audit-unavailable" } as const;
export function canonicalInventoryValueV1(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalInventoryValueV1).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalInventoryValueV1((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function inventoryDigestV1(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalInventoryValueV1(value)).digest("hex");
}
/** For already codec-validated input only; exactly the storage contract's semantic fields. */
export function inventoryIntentDigestV1(input: InventoryMutationV1): string {
  const schema = {
    reserveIssuance: "reserve",
    withNamedCredential: "namedUse",
    recordMintOutcome: "mintOutcome",
    claimRevocation: "claimRevocation",
    recordRevocation: "revocationOutcome",
  } as const;
  return (
    "sha256:" +
    createHash("sha256")
      .update(canonicalCredentialStorageRequestV1(schema[input.method], input))
      .digest("hex")
  );
}
const same = (a: unknown, b: unknown) =>
  canonicalInventoryValueV1(a) === canonicalInventoryValueV1(b);
const ref = () => randomUUID();
const iso = (time: number) => new Date(time).toISOString();
export function isLiveInventoryRecordV1(row: OutstandingTokenRecordV1): boolean {
  return (
    row.state === "reserved" ||
    row.state === "mint-unknown" ||
    (row.state === "outstanding" &&
      row.revocation.state !== "confirmed" &&
      row.revocation.state !== "expired")
  );
}
/** No sweep is implemented. Unresolved responsibility never expires by age. */
export function terminalInventoryRetentionElapsedV1(
  row: OutstandingTokenRecordV1,
  now: number,
): boolean {
  return (
    Number.isFinite(now) &&
    !isLiveInventoryRecordV1(row) &&
    now >= Date.parse(row.updatedAt) + INVENTORY_LIMITS_V1.terminalRetentionMs
  );
}
function matches(
  row: OutstandingTokenRecordV1,
  input: Exclude<InventoryMutationV1, ReserveIssuanceV1 | MintClaimInputV1>,
): boolean {
  return (
    same(row.target, input.target) &&
    same(row.issuance.scope, input.scope) &&
    same(row.issuance.profile, input.profile) &&
    row.issuance.callerServiceRef === input.callerServiceRef
  );
}
async function append(
  tx: Tx,
  input: InventoryMutationV1,
  row: OutstandingTokenRecordV1,
  now: number,
  state: InventoryOperationV1["state"] = "completed",
): Promise<InventoryOperationV1> {
  const operation = {
    input,
    digest: inventoryIntentDigestV1(input),
    state,
    record: row,
    commitRef: tx.commitRef,
    recordedAt: iso(now),
  };
  await tx.appendOperation(operation);
  tx.assertActive();
  return operation;
}
/** Empty timestamp is intentionally NOT a valid public receipt. The facade fills
 * it with the owner's actual outer-commit acknowledgment time before any return. */
function provisionalReceipt(operation: InventoryOperationV1) {
  return {
    schemaVersion: 1 as const,
    operationRef: operation.input.operationRef,
    intentDigest: operation.digest,
    commitRef: operation.commitRef,
    inventoryVersion: operation.record.inventoryVersion,
    committedAt: "",
  };
}
function recorded(operation: InventoryOperationV1): InventoryWriteResultV1 {
  return { kind: "recorded", receipt: provisionalReceipt(operation), record: operation.record };
}
/** Replay only the closed, unchanged receipt for this exact historical operation.
 * Missing or malformed owner acknowledgment does not erase known commit evidence. */
function replayRecorded(operation: InventoryOperationV1): InventoryWriteResultV1 {
  const missing = { kind: "unavailable", reason: "inventory-unavailable" } as const;
  try {
    const result = parseCredentialStorageV1("writeResult", {
      kind: "recorded",
      receipt: operation.originalReceipt,
      record: operation.record,
    });
    if (result.kind !== "recorded") return missing;
    if (
      result.receipt.operationRef !== operation.input.operationRef ||
      result.receipt.intentDigest !== operation.digest ||
      result.receipt.commitRef !== operation.commitRef ||
      result.receipt.inventoryVersion !== operation.record.inventoryVersion
    )
      return missing;
    return result;
  } catch {
    return missing;
  }
}
function canIncrement(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && version < Number.MAX_SAFE_INTEGER;
}
/** Snapshot and validate the actual audit owner's closed projection before any
 * inventory publication. Neither an event from another operation nor a receipt
 * from another transaction can serve as corresponding evidence. */
async function appendAudit(
  tx: Tx,
  input: InventoryMutationV1,
  mitigation: boolean,
): Promise<CredentialAuditEvidenceV1> {
  const returned = await tx.appendAudit(input, mitigation);
  if (
    !returned ||
    typeof returned !== "object" ||
    Object.getPrototypeOf(returned) !== Object.prototype ||
    Reflect.ownKeys(returned).some((key) => typeof key !== "string")
  )
    throw new Error("Invalid credential audit projection.");
  const descriptors = Object.getOwnPropertyDescriptors(returned);
  if (
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  )
    throw new Error("Invalid credential audit projection.");
  const audit = Object.freeze(
    Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    ),
  );
  if (
    !Check(OutstandingTokenRecordSchemaV1.anyOf[0].properties.audit, audit) ||
    audit.eventRef !== input.originalAuditRef ||
    ("commitRef" in audit && audit.commitRef !== tx.commitRef)
  )
    throw new Error("Credential audit correspondence failed.");
  return audit as CredentialAuditEvidenceV1;
}
async function exact(tx: Tx, input: InventoryMutationV1) {
  tx.assertActive();
  const prior = await tx.findOperation(input.operationRef);
  return prior === undefined
    ? undefined
    : prior.digest === inventoryIntentDigestV1(input)
      ? prior
      : null;
}
/** These transaction functions require parsed input and prior accepting-owner
 * authorization. They produce provisional results only; never provider effects. */
export async function reserveInventoryV1(
  tx: Tx,
  input: ReserveIssuanceV1,
  now: number,
): Promise<IssuanceReservationResultV1> {
  const old = await exact(tx, input);
  if (old === null) return conflict();
  if (old) {
    const current = await tx.findRecord(old.record.target.recordRef);
    return { kind: "existing", record: current ?? old.record, nextAction: "reconcile-only" };
  }
  const counts = await tx.liveCounts();
  if (
    counts.installation >= INVENTORY_LIMITS_V1.perInstallation ||
    counts.agent >= INVENTORY_LIMITS_V1.perAgent ||
    counts.unresolved >= INVENTORY_LIMITS_V1.unresolvedPerScope
  )
    return { kind: "capacity-exhausted", reason: "capacity-exhausted" };
  const audit = await appendAudit(tx, input, false);
  if (audit.state !== "accepted") return unavailable;
  const row: Extract<OutstandingTokenRecordV1, { state: "reserved" }> = {
    schemaVersion: 1,
    target: {
      issuanceOperationRef: input.operationRef,
      recordRef: ref(),
      intentDigest: inventoryIntentDigestV1(input),
    },
    inventoryVersion: 1,
    issuance: input,
    invalidationVersion: input.invalidationVersion,
    audit,
    updatedAt: iso(now),
    state: "reserved",
    expiry: { kind: "expiry-unproven" },
    disposition: "scope-held",
  };
  await tx.insertRecord(row);
  const operation = await append(tx, input, row, now, "intent-recorded");
  return { kind: "reserved", receipt: provisionalReceipt(operation), record: row, audit };
}
export async function claimInventoryMintV1(
  tx: Tx,
  input: MintClaimInputV1,
  now: number,
): Promise<MintClaimResultV1> {
  const old = await exact(tx, input);
  if (old === null) return conflict();
  if (old) return { kind: "existing", nextAction: "reconcile-only" };
  const row = await tx.findRecord(input.issuance.recordRef);
  if (
    !row ||
    !same(row.target, input.issuance) ||
    !same(row.issuance.scope, input.scope) ||
    !same(row.issuance.profile, input.profile) ||
    !same(row.issuance.original, input.original) ||
    !same(row.issuance.binding, input.binding) ||
    !same(row.issuance.grant, input.grant) ||
    row.issuance.callerServiceRef !== input.callerServiceRef
  )
    return conflict();
  if (await tx.findMintClaim(row.target.recordRef))
    return { kind: "existing", nextAction: "reconcile-only" };
  if (
    row.inventoryVersion !== input.expectedInventoryVersion ||
    !canIncrement(row.inventoryVersion)
  )
    return conflict("version-conflict");
  if (row.state !== "reserved") return conflict();
  const audit = await appendAudit(tx, input, false);
  if (audit.state !== "accepted") return unavailable;
  const claim = {
    issuanceOperationRef: row.target.issuanceOperationRef,
    recordRef: row.target.recordRef,
    issuanceIntentDigest: row.target.intentDigest,
    useOperationRef: input.operationRef,
    useIntentDigest: inventoryIntentDigestV1(input),
    providerAttemptRef: input.providerAttemptRef,
    inventoryVersion: row.inventoryVersion + 1,
  };
  await tx.insertMintClaim(claim);
  const next: OutstandingTokenRecordV1 = {
    ...row,
    state: "mint-unknown",
    providerAttemptRef: input.providerAttemptRef,
    inventoryVersion: row.inventoryVersion + 1,
    audit,
    updatedAt: iso(now),
  };
  await tx.replaceRecord(row.inventoryVersion, next);
  await append(tx, input, next, now, "effect-pending");
  return { kind: "claimed", claim };
}
export async function recordInventoryMintV1(
  tx: Tx,
  input: MintOutcomeV1,
  material: EphemeralTokenHandleV1 | undefined,
  now: number,
): Promise<InventoryWriteResultV1> {
  const old = await exact(tx, input);
  if (old === null) return conflict();
  if (old) return replayRecorded(old);
  const row = await tx.findRecord(input.target.recordRef);
  if (!row || !matches(row, input)) return conflict();
  const claim = await tx.findMintClaim(row.target.recordRef);
  if (
    !claim ||
    claim.providerAttemptRef !== input.providerAttemptRef ||
    claim.issuanceIntentDigest !== input.target.intentDigest
  )
    return conflict();
  if (
    row.inventoryVersion !== input.expectedInventoryVersion ||
    !canIncrement(row.inventoryVersion)
  )
    return conflict("version-conflict");
  if (row.state !== "mint-unknown") return conflict();
  if (input.outcome === "accepted") {
    if (material === undefined) return { kind: "denied", reason: "invalid-input" };
    await tx.retainToken(input, material);
  } else if (material !== undefined) return { kind: "denied", reason: "invalid-input" };
  const audit = await appendAudit(tx, input, true);
  const common = {
    schemaVersion: 1 as const,
    target: row.target,
    inventoryVersion: row.inventoryVersion + 1,
    issuance: row.issuance,
    invalidationVersion: row.invalidationVersion,
    audit,
    updatedAt: iso(now),
  };
  let next: OutstandingTokenRecordV1;
  switch (input.outcome) {
    case "accepted":
      next = {
        ...common,
        state: "outstanding",
        tokenRef: input.tokenRef,
        protectedRevocationRef: input.protectedRevocationRef,
        expiry: input.expiry,
        returnedScope: input.returnedScope,
        delivery: { state: "not-delivered" },
        revocation: { state: "unrequested", version: 1 },
        disposition: "mitigation-only",
      };
      break;
    case "definitely-rejected":
      next = {
        ...common,
        state: "not-issued",
        noIssuanceEvidenceRef: input.noIssuanceEvidenceRef,
        disposition: "no-effect",
      };
      break;
    case "unknown":
      // We do not erase stronger provider-expiry evidence with a later timeout.
      next = {
        ...common,
        state: "mint-unknown",
        providerAttemptRef: input.providerAttemptRef,
        expiry: row.expiry,
        disposition: "scope-held",
      };
      break;
    case "unknown-expiry-established":
      next = {
        ...common,
        state: "mint-unknown",
        providerAttemptRef: input.providerAttemptRef,
        expiry: input.expiry,
        disposition: "scope-held",
      };
      break;
    case "unknown-expired":
      if (
        now - input.uncertaintyMs < Date.parse(input.expiry.expiresAt) ||
        (row.expiry.kind === "provider-expiry" && row.expiry.expiresAt !== input.expiry.expiresAt)
      )
        return conflict();
      next = {
        ...common,
        state: "resolved-without-token",
        disposition: "resolved-no-live-token",
        resolution: {
          kind: "expired",
          observedAt: input.observedAt,
          expiry: input.expiry,
          clockEvidenceRef: input.clockEvidenceRef,
          uncertaintyMs: input.uncertaintyMs,
        },
      };
      break;
    case "unknown-broader-revocation-confirmed":
      next = {
        ...common,
        state: "resolved-without-token",
        disposition: "resolved-no-live-token",
        resolution: {
          kind: "broader-revocation-confirmed",
          observedAt: input.observedAt,
          broaderRevocation: input.broaderRevocation,
        },
      };
  }
  await tx.replaceRecord(row.inventoryVersion, next);
  return recorded(
    await append(
      tx,
      input,
      next,
      now,
      next.state === "mint-unknown" ? "effect-unknown" : "completed",
    ),
  );
}
export async function claimInventoryRevocationV1(
  tx: Tx,
  input: ClaimRevocationV1,
  now: number,
): Promise<RevocationClaimResultV1> {
  const old = await exact(tx, input);
  if (old === null) return conflict();
  if (old)
    return {
      kind: "busy",
      revocationOperationRef: input.revocationOperationRef,
      nextAction: "reconcile-only",
    };
  const row = await tx.findRecord(input.target.recordRef);
  if (
    !row ||
    !matches(row, input) ||
    row.state !== "outstanding" ||
    row.tokenRef !== input.tokenRef
  )
    return conflict();
  if (
    row.inventoryVersion !== input.expectedInventoryVersion ||
    row.revocation.version !== input.expectedRevocationVersion ||
    !canIncrement(row.inventoryVersion) ||
    !canIncrement(row.revocation.version)
  )
    return conflict("version-conflict");
  const prior = row.revocation;
  if (prior.state === "confirmed" || prior.state === "expired") return conflict();
  if (prior.state === "claimed" && now < Date.parse(prior.claimNotAfter))
    return {
      kind: "busy",
      revocationOperationRef: prior.revocationOperationRef,
      nextAction: "reconcile-only",
    };
  if (
    prior.state === "unrequested"
      ? input.previousAttempt.kind !== "none"
      : input.previousAttempt.kind !== "reconcile" ||
        input.previousAttempt.attemptRef !== prior.attemptRef ||
        input.revocationOperationRef !== prior.revocationOperationRef ||
        input.previousAttempt.providerOutcome !==
          (prior.state === "claimed" ? "unknown" : prior.state)
  )
    return conflict();
  const audit = await appendAudit(tx, input, true);
  const claimRef = ref(),
    claimVersion = prior.version + 1;
  // Lease expiry only permits reconciliation of the SAME provider attempt.
  const attemptRef = prior.state === "unrequested" ? ref() : prior.attemptRef;
  const claimNotAfter = iso(now + INVENTORY_LIMITS_V1.claimMs);
  const next: OutstandingTokenRecordV1 = {
    ...row,
    inventoryVersion: row.inventoryVersion + 1,
    audit,
    updatedAt: iso(now),
    disposition: "mitigation-only",
    revocation: {
      state: "claimed",
      version: claimVersion,
      revocationOperationRef: input.revocationOperationRef,
      attemptRef,
      claimRef,
      claimedAt: iso(now),
      claimNotAfter,
      priorOutcome:
        prior.state === "unrequested"
          ? "none"
          : prior.state === "claimed"
            ? "unknown"
            : prior.state,
    },
  };
  await tx.appendRevocationClaim({
    input,
    claimRef,
    claimVersion,
    providerAttemptRef: attemptRef,
    claimedAt: iso(now),
    claimNotAfter,
  });
  await tx.replaceRecord(row.inventoryVersion, next);
  const operation = await append(tx, input, next, now, "effect-pending");
  const token = await tx.loadRevocationToken(row);
  return {
    kind: "claimed",
    receipt: provisionalReceipt(operation),
    record: next,
    claimRef,
    claimVersion,
    claimNotAfter,
    audit,
    nextAction:
      prior.state === "unrequested" ? "attempt-exact-revocation" : "reconcile-previous-attempt",
    token,
  };
}
export async function recordInventoryRevocationV1(
  tx: Tx,
  input: RevocationOutcomeV1,
  now: number,
): Promise<InventoryWriteResultV1> {
  const old = await exact(tx, input);
  if (old === null) return conflict();
  if (old) return replayRecorded(old);
  const row = await tx.findRecord(input.target.recordRef);
  if (
    !row ||
    !matches(row, input) ||
    row.state !== "outstanding" ||
    row.tokenRef !== input.tokenRef
  )
    return conflict();
  const claim = await tx.findRevocationClaim(input.claimRef);
  if (
    !claim ||
    claim.claimVersion !== input.claimVersion ||
    claim.providerAttemptRef !== input.providerAttemptRef ||
    claim.input.revocationOperationRef !== input.revocationOperationRef ||
    !same(claim.input.target, input.target) ||
    claim.input.tokenRef !== input.tokenRef ||
    !same(claim.input.scope, input.scope)
  )
    return conflict();
  if (
    row.inventoryVersion !== input.expectedInventoryVersion ||
    !canIncrement(row.inventoryVersion) ||
    !canIncrement(row.revocation.version)
  )
    return conflict("version-conflict");
  if (row.revocation.state === "confirmed" || row.revocation.state === "expired") return conflict();
  if (
    input.outcome === "expired" &&
    (now - input.uncertaintyMs < Date.parse(input.expiry.expiresAt) ||
      (row.expiry.kind === "provider-expiry" && row.expiry.expiresAt !== input.expiry.expiresAt))
  )
    return conflict();
  const audit = await appendAudit(tx, input, true);
  const version = row.revocation.version + 1;
  let revocation: Extract<OutstandingTokenRecordV1, { state: "outstanding" }>["revocation"];
  if (input.outcome === "expired")
    revocation = {
      state: "expired",
      version,
      observedAt: input.observedAt,
      expiry: input.expiry,
      clockEvidenceRef: input.clockEvidenceRef,
      uncertaintyMs: input.uncertaintyMs,
    };
  else if (input.outcome === "confirmed")
    revocation = {
      state: "confirmed",
      version,
      revocationOperationRef: input.revocationOperationRef,
      attemptRef: input.providerAttemptRef,
      observedAt: input.observedAt,
      confirmationEvidenceRef: input.confirmationEvidenceRef,
    };
  else
    revocation = {
      state: input.outcome,
      version,
      revocationOperationRef: input.revocationOperationRef,
      attemptRef: input.providerAttemptRef,
      observedAt: input.observedAt,
    };
  const next: OutstandingTokenRecordV1 = {
    ...row,
    inventoryVersion: row.inventoryVersion + 1,
    updatedAt: iso(now),
    audit,
    revocation,
    disposition: "mitigation-only",
  };
  await tx.replaceRecord(row.inventoryVersion, next);
  return recorded(
    await append(
      tx,
      input,
      next,
      now,
      input.outcome === "confirmed" || input.outcome === "expired" ? "completed" : "effect-unknown",
    ),
  );
}
function cursorToken(snapshot: InventorySnapshotV1, recordRef: string): string {
  return createHash("sha256")
    .update(snapshot.continuation + ":" + recordRef)
    .digest("base64url");
}
export async function listInventoryAffectedV1(
  tx: Tx,
  input: AffectedTokenQueryV1,
  now: number,
  uncertaintyMs = 0,
): Promise<AffectedTokenPageV1> {
  tx.assertActive();
  const filterDigest = credentialAffectedFilterDigestV1(input);
  let snapshot: InventorySnapshotV1 | undefined;
  let offset = 0;
  if (input.cursor) {
    snapshot = await tx.findSnapshot(input.cursor.snapshotRef);
    if (
      !snapshot ||
      snapshot.snapshotVersion !== input.cursor.snapshotVersion ||
      snapshot.filterDigest !== filterDigest ||
      input.cursor.filterDigest !== filterDigest ||
      snapshot.callerServiceRef !== input.callerServiceRef ||
      !same(snapshot.profile, input.profile) ||
      !same(snapshot.filter, input.filter) ||
      now + uncertaintyMs >= Date.parse(snapshot.expiresAt)
    )
      return { kind: "snapshot-invalid", nextAction: "restart-exact-filter" };
    const index = snapshot.records.findIndex(
      (row) => row.target.recordRef === input.cursor!.afterRecordRef,
    );
    if (
      index < 0 ||
      cursorToken(snapshot, input.cursor.afterRecordRef) !== input.cursor.continuation
    )
      return { kind: "snapshot-invalid", nextAction: "restart-exact-filter" };
    offset = index + 1;
  } else {
    const rows = await tx.listLive(input.filter.bindingRef);
    if (
      rows.length > INVENTORY_LIMITS_V1.perAgent ||
      rows.some(
        (row) =>
          !same(row.issuance.scope, input.filter.scope) ||
          row.issuance.binding.bindingRef !== input.filter.bindingRef ||
          !isLiveInventoryRecordV1(row),
      )
    )
      throw new Error("Inventory owner returned inconsistent scope.");
    snapshot = {
      snapshotRef: ref(),
      snapshotVersion: 1,
      callerServiceRef: input.callerServiceRef,
      filter: input.filter,
      profile: input.profile,
      filterDigest,
      createdAt: iso(now),
      expiresAt: iso(now + INVENTORY_LIMITS_V1.snapshotMs),
      records: [...rows].sort((a, b) => (a.target.recordRef < b.target.recordRef ? -1 : 1)),
      continuation: ref(),
    };
    await tx.insertSnapshot(snapshot);
  }
  const records = snapshot.records.slice(offset, offset + input.limit);
  const last = records.at(-1);
  const next =
    last && offset + records.length < snapshot.records.length
      ? {
          snapshotRef: snapshot.snapshotRef,
          snapshotVersion: snapshot.snapshotVersion,
          filterDigest,
          afterRecordRef: last.target.recordRef,
          continuation: cursorToken(snapshot, last.target.recordRef),
        }
      : null;
  tx.assertActive();
  return {
    kind: "page",
    snapshotRef: snapshot.snapshotRef,
    snapshotVersion: snapshot.snapshotVersion,
    filter: snapshot.filter,
    filterDigest,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    records,
    next,
    outstandingCount: snapshot.records.filter((row) => row.state === "outstanding").length,
    unresolvedIssuanceCount: snapshot.records.filter(
      (row) => row.state === "reserved" || row.state === "mint-unknown",
    ).length,
    coverage: "persisted-snapshot-only",
  };
}
export async function readInventoryOperationV1(
  tx: Tx,
  input: ExactCredentialOperationV1,
): Promise<CredentialOperationResultV1> {
  tx.assertActive();
  const operation = await tx.findOperation(input.originalOperationRef);
  if (!operation) return { kind: "not-found", nextAction: "exact-readback-only" };
  if (
    operation.digest !== input.originalIntentDigest ||
    operation.input.method !== input.originalMethod ||
    operation.input.callerServiceRef !== input.callerServiceRef ||
    !same(operation.input.scope, input.scope) ||
    !same(operation.input.profile, input.profile)
  )
    return { kind: "not-visible" };
  return {
    kind: "found",
    operationRef: operation.input.operationRef,
    intentDigest: operation.digest,
    originalMethod: operation.input.method,
    state: operation.state,
    record: operation.record,
    nextAction: "observation-only",
  };
}
