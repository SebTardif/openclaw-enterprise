import { randomUUID } from "node:crypto";
import { INVENTORY_LIMITS_V1 } from "./transactions.ts";
import {
  canonicalRepositoryInventoryV2,
  parseRepositoryTokenMutationV2,
  parseRepositoryTokenRecordV2,
  repositoryInventoryDigestV2,
  type RepositoryInventoryOperationV2,
  type RepositoryLeaseInventoryTransactionV2,
  type RepositoryTokenMutationV2,
  type RepositoryTokenRecordV2,
} from "./repository-lease-v2.ts";

export type RepositoryInventoryTransitionV2 =
  | Readonly<{ kind: "staged"; operation: RepositoryInventoryOperationV2 }>
  | Readonly<{
      kind: "existing";
      operation: RepositoryInventoryOperationV2;
      nextAction: "reconcile-only";
    }>
  | Readonly<{ kind: "conflict" | "capacity" | "target-held" | "expired" }>;
export interface RepositoryInventoryClockV2 {
  read(): Readonly<{ now: number; uncertaintyMs: number }>;
}
const same = (a: unknown, b: unknown) =>
  canonicalRepositoryInventoryV2(a) === canonicalRepositoryInventoryV2(b);
const conflict = Object.freeze({ kind: "conflict" } as const);

/** Storage transition under the ORIGINAL accepted inventory unit only. This
 * function does not open a unit, authenticate authority, append mandatory audit,
 * invoke a provider or release material. The original participant must couple
 * audit/custody/currentness and complete facts before acknowledging outer COMMIT.
 * Every returned staged operation remains provisional until that acknowledgment.
 */
export async function transitionRepositoryInventoryV2(
  tx: RepositoryLeaseInventoryTransactionV2,
  raw: RepositoryTokenMutationV2,
  clock: RepositoryInventoryClockV2,
): Promise<RepositoryInventoryTransitionV2> {
  const input = parseRepositoryTokenMutationV2(raw);
  const now = () => {
    tx.assertActive();
    const time = clock.read();
    if (
      !Number.isSafeInteger(time.now) ||
      !Number.isSafeInteger(time.uncertaintyMs) ||
      time.uncertaintyMs < 0 ||
      time.uncertaintyMs > 2000
    )
      throw new Error("Repository inventory clock is unavailable.");
    return time;
  };
  const prior = await tx.findOperation(input.operationRef);
  now();
  if (prior)
    return prior.digest === repositoryInventoryDigestV2(input)
      ? { kind: "existing", operation: prior, nextAction: "reconcile-only" }
      : conflict;
  const append = async (
    record: RepositoryTokenRecordV2,
  ): Promise<RepositoryInventoryTransitionV2> => {
    const operation: RepositoryInventoryOperationV2 = {
      input,
      digest: repositoryInventoryDigestV2(input),
      record,
      commitRef: tx.commitRef,
      recordedAt: new Date(now().now).toISOString(),
      state:
        record.state === "reserved"
          ? "intent-recorded"
          : record.state === "mint-unknown"
            ? "effect-unknown"
            : record.state === "outstanding" && record.revocation?.state === "claimed"
              ? "effect-pending"
              : record.state === "outstanding" &&
                  record.revocation !== undefined &&
                  record.revocation.state !== "confirmed"
                ? "effect-unknown"
                : "completed",
    };
    await tx.appendOperation(operation);
    now();
    return { kind: "staged", operation };
  };
  if (input.method === "reserveRepositoryToken") {
    const lease = await tx.findLease(input.lease.accessLeaseRef);
    now();
    if (lease && !same(lease, input.lease)) return conflict;
    const capacity = await tx.capacity(input.lease.target, input.lease.accessLeaseRef);
    const time = now();
    if (
      time.now + time.uncertaintyMs >= Date.parse(input.deadline) ||
      time.now + time.uncertaintyMs >= Date.parse(input.lease.notAfter)
    )
      return { kind: "expired" };
    if (capacity.targetHeld) return { kind: "target-held" };
    if (
      capacity.installationLive >= INVENTORY_LIMITS_V1.perInstallation ||
      capacity.leaseLive >= 2 ||
      capacity.mintActive ||
      capacity.freeSlot === undefined
    )
      return { kind: "capacity" };
    if (!lease) await tx.insertLease(input.lease);
    const record: RepositoryTokenRecordV2 = {
      schemaVersion: 2,
      target: {
        issuanceOperationRef: input.operationRef,
        recordRef: randomUUID(),
        intentDigest: repositoryInventoryDigestV2(input),
      },
      inventoryVersion: 1,
      issuance: input,
      updatedAt: new Date(now().now).toISOString(),
      state: "reserved",
      expiry: { kind: "expiry-unproven" },
      disposition: "scope-held",
    };
    await tx.insertRecord(record, capacity.freeSlot);
    return append(record);
  }
  const record = await tx.findRecord(input.target.recordRef);
  now();
  if (
    !record ||
    !same(input.target, record.target) ||
    !same(input.scope, record.issuance.scope) ||
    input.expectedInventoryVersion !== record.inventoryVersion ||
    record.inventoryVersion === Number.MAX_SAFE_INTEGER
  )
    return conflict;
  const common = {
    schemaVersion: 2 as const,
    target: record.target,
    inventoryVersion: record.inventoryVersion + 1,
    issuance: record.issuance,
    updatedAt: new Date(now().now).toISOString(),
    expiry: record.expiry,
    ...(record.revocation === undefined ? {} : { revocation: record.revocation }),
  };
  let next: RepositoryTokenRecordV2;
  switch (input.method) {
    case "claimRepositoryRevocation": {
      if (
        record.state !== "outstanding" ||
        record.tokenRef !== input.tokenRef ||
        record.protectedRevocationRef !== input.protectedRevocationRef
      )
        return conflict;
      const prior = record.revocation;
      if (
        (prior?.version ?? 0) !== input.expectedRevocationVersion ||
        prior?.version === Number.MAX_SAFE_INTEGER ||
        prior?.state === "confirmed"
      )
        return conflict;
      const time = now();
      // Expiry permits takeover of the same attempt, never a fresh token or a
      // replacement cleanup attempt. Account for clock uncertainty before takeover.
      if (
        prior?.state === "claimed" &&
        time.now - time.uncertaintyMs < Date.parse(prior.claimNotAfter)
      )
        return conflict;
      if (
        prior === undefined
          ? input.previousAttempt.kind !== "none"
          : input.previousAttempt.kind !== "reconcile" ||
            input.previousAttempt.providerAttemptRef !== prior.providerAttemptRef ||
            input.revocationOperationRef !== prior.revocationOperationRef ||
            input.previousAttempt.providerOutcome !==
              (prior.state === "claimed" ? "unknown" : prior.state)
      )
        return conflict;
      const claimRef = randomUUID();
      const claimVersion = (prior?.version ?? 0) + 1;
      const providerAttemptRef = prior?.providerAttemptRef ?? randomUUID();
      const claimedAt = new Date(time.now).toISOString();
      const claimNotAfter = new Date(time.now + INVENTORY_LIMITS_V1.claimMs).toISOString();
      await tx.appendRevocationClaim({
        schemaVersion: 2,
        input,
        claimRef,
        claimVersion,
        providerAttemptRef,
        claimedAt,
        claimNotAfter,
      });
      next = {
        ...record,
        ...common,
        disposition: "mitigation-only",
        revocation: {
          state: "claimed",
          version: claimVersion,
          revocationOperationRef: input.revocationOperationRef,
          providerAttemptRef,
          claimRef,
          claimVersion,
          claimedAt,
          claimNotAfter,
          priorOutcome:
            prior === undefined ? "none" : prior.state === "claimed" ? "unknown" : prior.state,
        },
      };
      break;
    }
    case "recordRepositoryRevocation": {
      if (
        record.state !== "outstanding" ||
        record.tokenRef !== input.tokenRef ||
        record.protectedRevocationRef !== input.protectedRevocationRef ||
        record.revocation === undefined ||
        record.revocation.state === "confirmed" ||
        record.revocation.version === Number.MAX_SAFE_INTEGER ||
        record.revocation.providerAttemptRef !== input.providerAttemptRef ||
        record.revocation.revocationOperationRef !== input.revocationOperationRef
      )
        return conflict;
      // A definitive confirmation for the same provider attempt can settle a
      // later reconciliation claim. Stale nonterminal evidence cannot retire a
      // newer active claim and thereby permit another cleanup worker early.
      if (
        input.outcome !== "confirmed" &&
        (record.revocation.claimRef !== input.claimRef ||
          record.revocation.claimVersion !== input.claimVersion)
      )
        return conflict;
      const claim = await tx.findRevocationClaim(input.claimRef);
      now();
      if (
        !claim ||
        claim.claimVersion !== input.claimVersion ||
        claim.providerAttemptRef !== input.providerAttemptRef ||
        claim.input.revocationOperationRef !== input.revocationOperationRef ||
        !same(claim.input.target, input.target) ||
        !same(claim.input.scope, input.scope) ||
        claim.input.tokenRef !== input.tokenRef ||
        claim.input.protectedRevocationRef !== input.protectedRevocationRef ||
        Date.parse(input.observedAt) < Date.parse(claim.claimedAt)
      )
        return conflict;
      const revocation = {
        state: input.outcome,
        version: record.revocation.version + 1,
        revocationOperationRef: input.revocationOperationRef,
        providerAttemptRef: input.providerAttemptRef,
        claimRef: input.claimRef,
        claimVersion: input.claimVersion,
        claimedAt: claim.claimedAt,
        claimNotAfter: claim.claimNotAfter,
        priorOutcome:
          claim.input.previousAttempt.kind === "none"
            ? ("none" as const)
            : claim.input.previousAttempt.providerOutcome,
        observedAt: input.observedAt,
        evidenceRef: input.evidenceRef,
      };
      next =
        input.outcome === "confirmed"
          ? {
              ...common,
              revocation,
              state: "resolved-without-token",
              disposition: "resolved-no-live-token",
              providerAttemptRef: record.providerAttemptRef,
              evidenceRef: input.evidenceRef,
            }
          : { ...record, ...common, revocation, disposition: "mitigation-only" };
      break;
    }
    case "claimRepositoryMint": {
      const old = await tx.findMintClaim(record.target.recordRef);
      now();
      if (
        old ||
        record.state !== "reserved" ||
        !same(input.custodyIdentity.lease, record.issuance.lease) ||
        input.custodyIdentity.key.bindingRef !== record.issuance.bindingRef
      )
        return conflict;
      const capacity = await tx.capacity(
        record.issuance.lease.target,
        record.issuance.lease.accessLeaseRef,
      );
      const time = now();
      if (
        time.now + time.uncertaintyMs >= Date.parse(record.issuance.deadline) ||
        time.now + time.uncertaintyMs >= Date.parse(record.issuance.lease.notAfter)
      )
        return { kind: "expired" };
      if (capacity.targetHeld) return { kind: "target-held" };
      await tx.insertMintClaim({
        schemaVersion: 2,
        custodyIdentity: input.custodyIdentity,
        issuanceOperationRef: record.target.issuanceOperationRef,
        recordRef: record.target.recordRef,
        issuanceIntentDigest: record.target.intentDigest,
        useOperationRef: input.operationRef,
        useIntentDigest: repositoryInventoryDigestV2(input),
        providerAttemptRef: input.providerAttemptRef,
        inventoryVersion: common.inventoryVersion,
      });
      next = {
        ...common,
        state: "mint-unknown",
        disposition: "scope-held",
        providerAttemptRef: input.providerAttemptRef,
      };
      break;
    }
    case "recordRepositoryMint": {
      const claim = await tx.findMintClaim(record.target.recordRef);
      now();
      if (
        !claim ||
        claim.providerAttemptRef !== input.providerAttemptRef ||
        record.state !== "mint-unknown" ||
        record.providerAttemptRef !== input.providerAttemptRef
      )
        return conflict;
      if (input.outcome === "definitely-rejected" || input.outcome === "definitely-not-dispatched")
        next = {
          ...common,
          state: "not-issued",
          disposition: "resolved-no-live-token",
          providerAttemptRef: input.providerAttemptRef,
          evidenceRef: input.evidenceRef,
        };
      else if (input.outcome === "unknown") {
        if (
          record.expiry.kind === "provider-expiry" &&
          (input.expiry.kind !== "provider-expiry" ||
            record.expiry.expiresAt !== input.expiry.expiresAt)
        )
          return conflict;
        next = {
          ...common,
          expiry: input.expiry,
          state: "mint-unknown",
          disposition: "scope-held",
          providerAttemptRef: input.providerAttemptRef,
        };
      } else {
        if (
          input.tokenRef !== claim.custodyIdentity.tokenRef ||
          input.protectedRevocationRef !== claim.custodyIdentity.protectedRevocationRef
        )
          return conflict;
        // Material and evidence provenance are checked by the original custody /
        // mitigation participant before this metadata transition. Late or broader
        // material never becomes eligible merely because its bytes are known.
        const time = now();
        const expiryMatches =
          record.expiry.kind !== "provider-expiry" ||
          (input.expiry.kind === "provider-expiry" &&
            record.expiry.expiresAt === input.expiry.expiresAt);
        const eligible =
          expiryMatches &&
          input.scopeAccepted &&
          input.expiry.kind === "provider-expiry" &&
          Date.parse(input.expiry.expiresAt) > time.now + time.uncertaintyMs &&
          same(input.returnedPermissions, record.issuance.requestedPermissions) &&
          Date.parse(record.issuance.lease.notAfter) > time.now + time.uncertaintyMs &&
          Date.parse(record.issuance.deadline) > time.now + time.uncertaintyMs;
        // Contradictory expiry cannot discard a recognizable token. Retain it
        // for exact cleanup without claiming a proven terminal horizon; earlier
        // expiry observations remain in the same immutable operation history.
        next = {
          ...common,
          expiry: expiryMatches ? input.expiry : { kind: "expiry-unproven" },
          state: "outstanding",
          providerAttemptRef: input.providerAttemptRef,
          tokenRef: input.tokenRef,
          protectedRevocationRef: input.protectedRevocationRef,
          returnedPermissions: input.returnedPermissions,
          evidenceRef: input.evidenceRef,
          disposition: eligible ? "current-check-required" : "mitigation-only",
        };
      }
      break;
    }
    case "retireRepositoryToken":
      if (record.state !== "outstanding") return conflict;
      next = {
        ...record,
        ...common,
        disposition: "mitigation-only",
        evidenceRef: input.evidenceRef,
      };
      break;
    case "resolveRepositoryToken": {
      if (input.outcome === "definitely-not-dispatched") {
        const claim = await tx.findMintClaim(record.target.recordRef);
        now();
        if (record.state !== "reserved" || claim) return conflict;
        next = {
          ...common,
          state: "not-issued",
          disposition: "resolved-no-live-token",
          providerAttemptRef: null,
          evidenceRef: input.evidenceRef,
        };
        break;
      }
      if (record.state !== "outstanding" && record.state !== "mint-unknown") return conflict;
      if (input.outcome === "expired") {
        const time = now();
        // Neither wall-clock age nor an invented new expiry frees capacity. The
        // original evidenced expiry must match and both uncertainties apply.
        if (
          record.expiry.kind !== "provider-expiry" ||
          !same(record.expiry, input.expiry) ||
          time.now - Math.max(time.uncertaintyMs, input.uncertaintyMs) <
            Date.parse(input.expiry.expiresAt)
        )
          return conflict;
      }
      next = {
        ...common,
        state: "resolved-without-token",
        disposition: "resolved-no-live-token",
        providerAttemptRef: record.providerAttemptRef,
        evidenceRef: input.evidenceRef,
      };
      break;
    }
  }
  next = parseRepositoryTokenRecordV2(next);
  await tx.replaceRecord(record.inventoryVersion, next);
  return append(next);
}
