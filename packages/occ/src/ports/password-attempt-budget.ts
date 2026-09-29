/**
 * A server-owned password-attempt budget. The caller supplies only the
 * purpose-separated digest of the verifier's normalized account identifier.
 * Neither unavailable nor unknown permits password work or automatic replay.
 */
export type PasswordAttemptReservation =
  | Readonly<{ status: "allowed" }>
  | Readonly<{ status: "limited"; retryAfterSeconds: number }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "unknown" }>;

export interface PasswordAttemptBudget {
  reserve(subjectDigest: Uint8Array): Promise<PasswordAttemptReservation>;
}
