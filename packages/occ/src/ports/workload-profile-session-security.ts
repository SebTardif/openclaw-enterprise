import type { WorkloadProfileAccountUnit } from "../services/workload-profile/port.ts";

export interface WorkloadProfileSessionLookupV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly sessionCredentialDigest: string;
}
export interface WorkloadProfileSessionReadLeaseV1 extends WorkloadProfileSessionLookupV1 {
  readonly incarnation: string;
  readonly accountVersion: number;
  readonly state: "provisioning" | "active" | "deleted";
  readonly currentUserId: string | null;
  readonly credentialAccountId: string | null;
  readonly sessionUserId: string;
  readonly expiresAt: string;
  /** Genuine captured outer owner/client and retained expiry, after acquisition IO closes. */
  assertCurrent(): undefined;
  /** Ends only this local observation. SQL locks remain owned through terminal cleanup. */
  release(): void;
}
export interface WorkloadProfileSessionSecurityReaderV1 {
  /** Only the exact canonical unit enrolled in this PostgresPlatformState is accepted.
   * The private original auth producer supplies the consumed-session lookup; this
   * declaration or lookup data does not authenticate a request or grant SQL access. */
  lock(
    unit: WorkloadProfileAccountUnit,
    lookup: WorkloadProfileSessionLookupV1,
  ): Promise<WorkloadProfileSessionReadLeaseV1 | undefined>;
}
