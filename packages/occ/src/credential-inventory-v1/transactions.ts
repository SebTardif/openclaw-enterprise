import { createHash } from "node:crypto";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  canonicalCredentialStorageRequestV1,
  type OutstandingTokenRecordV1,
} from "@openclaw-enterprise/contracts";
import type { InventoryMutationV1 } from "./ports.ts";
export const INVENTORY_LIMITS_V1 = Object.freeze({
  perAgent: CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerAgent,
  perInstallation: CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerInstallation,
  unresolvedPerScope: CREDENTIAL_STORAGE_LIMITS_V1.maxConcurrentIssuancePerScope,
  claimMs: CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
});
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
export function isLiveInventoryRecordV1(row: OutstandingTokenRecordV1): boolean {
  return (
    row.state === "reserved" ||
    row.state === "mint-unknown" ||
    (row.state === "outstanding" &&
      row.revocation.state !== "confirmed" &&
      row.revocation.state !== "expired")
  );
}
