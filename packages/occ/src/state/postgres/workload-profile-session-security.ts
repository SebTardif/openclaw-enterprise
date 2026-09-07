import { performance } from "node:perf_hooks";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type {
  WorkloadProfileSessionLookupV1,
  WorkloadProfileSessionReadLeaseV1,
} from "../../ports/workload-profile-session-security.ts";

/** Internal borrowed operations supplied only after the actual state recognizes
 * its canonical profile account unit. These callbacks are not an authority issuer. */
interface ProfileSessionOwnerV1 {
  readonly installationId: string;
  readonly signal: AbortSignal;
  assertAcquiring(): void;
  assertCurrent(): undefined;
  query(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<{
    rows: unknown[];
    rowCount: number | null;
  }>;
  retainCurrentness(check: () => undefined): void;
  poison(error: unknown): void;
  release(): void;
}

const unavailable = () =>
  new DependencyUnavailableError("The current profile session security is unavailable.");
const reference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

/** Fixed helper only: never checks out a connection or returns raw token data.
 * State registers the accepted promise and cleanup in the original phase before
 * this read can return. Database locks belong to that owner through terminal. */
export async function readPostgresWorkloadProfileSessionV1(
  owner: ProfileSessionOwnerV1,
  input: WorkloadProfileSessionLookupV1,
): Promise<WorkloadProfileSessionReadLeaseV1 | undefined> {
  try {
    owner.assertAcquiring();
    const lookup = Object.freeze({
      installationId: input.installationId,
      accountId: input.accountId,
      issuer: input.issuer,
      subject: input.subject,
      sessionId: input.sessionId,
      sessionCredentialDigest: input.sessionCredentialDigest,
    });
    if (
      lookup.installationId !== owner.installationId ||
      !reference(lookup.accountId) ||
      lookup.accountId.length > 200 ||
      lookup.issuer !== `occ:installation:${owner.installationId}:better-auth` ||
      lookup.subject !== lookup.accountId ||
      !reference(lookup.sessionId) ||
      !/^[0-9a-f]{64}$/u.test(lookup.sessionCredentialDigest)
    )
      throw new ScopeViolationError("The profile session lookup belongs to another identity.");
    if (owner.signal.aborted) throw unavailable();
    // Starting before the SQL wait conservatively charges the full wait against
    // the freshly sampled database duration. It can deny early, never extend it.
    const began = performance.now();
    const result = await owner.query(
      `SELECT installation_id, account_id, issuer, subject, incarnation::text,
              account_version, state, current_user_id, credential_account_id,
              session_id, session_user_id, session_credential_digest,
              to_char(session_expires_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
              remaining_ms
         FROM occ.read_locked_workload_profile_session_v1($1,$2,$3,$4,$5,$6)`,
      [
        lookup.installationId,
        lookup.accountId,
        lookup.issuer,
        lookup.subject,
        lookup.sessionId,
        lookup.sessionCredentialDigest,
      ],
    );
    owner.assertAcquiring();
    if (result.rowCount === 0 && result.rows.length === 0) return undefined;
    if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
    const value = result.rows[0];
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    const row = value as Record<string, unknown>;
    const accountVersion = row.account_version;
    const remaining = row.remaining_ms;
    const expiresAt = row.expires_at;
    if (
      row.installation_id !== lookup.installationId ||
      row.account_id !== lookup.accountId ||
      row.issuer !== lookup.issuer ||
      row.subject !== lookup.subject ||
      row.state !== "active" ||
      row.current_user_id !== lookup.accountId ||
      !reference(row.credential_account_id) ||
      !reference(row.incarnation) ||
      typeof accountVersion !== "string" ||
      !/^[1-9][0-9]*$/u.test(accountVersion) ||
      !Number.isSafeInteger(Number(accountVersion)) ||
      row.session_id !== lookup.sessionId ||
      row.session_user_id !== lookup.accountId ||
      row.session_credential_digest !== lookup.sessionCredentialDigest ||
      typeof remaining !== "string" ||
      !/^[1-9][0-9]*$/u.test(remaining) ||
      !Number.isSafeInteger(Number(remaining)) ||
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString() !== expiresAt
    )
      throw unavailable();
    const absoluteExpiry = Date.parse(expiresAt);
    const deadline = began + Number(remaining);
    let released = false;
    const current = (): undefined => {
      try {
        owner.assertCurrent();
        if (
          released ||
          owner.signal.aborted ||
          performance.now() >= deadline ||
          Date.now() >= absoluteExpiry
        )
          throw unavailable();
        return undefined;
      } catch (error) {
        owner.poison(error);
        throw error;
      }
    };
    const lease: WorkloadProfileSessionReadLeaseV1 = Object.freeze({
      ...lookup,
      incarnation: row.incarnation,
      accountVersion: Number(accountVersion),
      state: "active",
      currentUserId: lookup.accountId,
      credentialAccountId: row.credential_account_id,
      sessionUserId: lookup.accountId,
      expiresAt,
      assertCurrent: current,
      release: () => {
        if (released) return;
        released = true;
        owner.release();
      },
    });
    // Installation in the actual owner's fence precedes exposure to any getter
    // or consumer. The final fence performs no SQL and never reuses acquisition IO.
    owner.retainCurrentness(current);
    return lease;
  } catch (error) {
    owner.poison(error);
    throw error;
  }
}
