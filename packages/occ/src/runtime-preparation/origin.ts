import { immutableCopy } from "@openclaw-enterprise/utils";
import type { WorkloadProfileSessionLookupV1 } from "../ports/workload-profile-session-security.ts";
import { canonicalRuntimePreparation, requirePreparation } from "./types.ts";

/** Historical authentication association retained by the original admission
 * transaction. This contains no bearer and grants no current authorization.
 * A worker must lock the original current session/account and IAM again. */
export interface RuntimePreparationSessionOriginV1 extends WorkloadProfileSessionLookupV1 {
  readonly accountIncarnation: string;
  readonly accountVersion: number;
}

export function parseRuntimePreparationSessionOriginV1(
  input: unknown,
): RuntimePreparationSessionOriginV1 {
  canonicalRuntimePreparation(input, 8192);
  requirePreparation(input !== null && typeof input === "object" && !Array.isArray(input));
  const value = input as RuntimePreparationSessionOriginV1;
  requirePreparation(
    Object.keys(value).sort().join(",") ===
      [
        "installationId",
        "accountId",
        "issuer",
        "subject",
        "sessionId",
        "sessionCredentialDigest",
        "accountIncarnation",
        "accountVersion",
      ]
        .sort()
        .join(","),
  );
  for (const key of [
    "installationId",
    "accountId",
    "issuer",
    "subject",
    "sessionId",
    "accountIncarnation",
  ] as const)
    requirePreparation(
      typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 1024,
    );
  requirePreparation(
    value.issuer === `occ:installation:${value.installationId}:better-auth` &&
      value.subject === value.accountId &&
      /^[0-9a-f]{64}$/.test(value.sessionCredentialDigest) &&
      Number.isSafeInteger(value.accountVersion) &&
      value.accountVersion > 0,
  );
  return immutableCopy(value);
}
