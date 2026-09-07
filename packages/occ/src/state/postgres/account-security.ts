import type {
  LocalAccountSecurityLookupV1,
  LocalAccountSecurityRecordLeaseV1,
  LocalAccountSecurityRecordReaderV1,
  LocalAccountSecurityRecordV1,
} from "../../account-authority/local-account-security.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { TurnCommandOwnedUnitV1 } from "../../ports/turn-command.ts";
import { TurnCommandScopeV1 } from "./turn-command-scope.ts";

/** Constructed only inside the original turn owner's account callback. The
 * tracked query lifetime may reopen for preparation; owner/token never change.
 * These internal inputs do not authenticate a caller or provide SQL privileges. */
export interface PostgresAccountSecurityContextV1 extends QueryRepositoryFactoryContext {
  readonly owner: TurnCommandScopeV1;
  readonly token: TurnCommandOwnedUnitV1;
  /** Original owner rejects acquisition after policy or protected parent locks. */
  assertAcquisitionOrder(): void;
}

const unavailable = () =>
  new DependencyUnavailableError("The account security record is unavailable.");

function decodeRecord(
  value: unknown,
  lookup: Readonly<LocalAccountSecurityLookupV1>,
): Readonly<LocalAccountSecurityRecordV1> {
  if (value === null || typeof value !== "object") throw unavailable();
  const row = value as Record<string, unknown>;
  const version = row.account_version;
  if (
    typeof version !== "string" ||
    !/^[1-9][0-9]*$/u.test(version) ||
    !Number.isSafeInteger(Number(version)) ||
    row.installation_id !== lookup.installationId ||
    row.account_id !== lookup.accountId ||
    row.issuer !== lookup.issuer ||
    row.subject !== lookup.subject ||
    typeof row.incarnation !== "string" ||
    row.incarnation.length === 0 ||
    (row.state !== "provisioning" && row.state !== "active" && row.state !== "deleted") ||
    (row.current_user_id !== null && typeof row.current_user_id !== "string") ||
    (row.credential_account_id !== null && typeof row.credential_account_id !== "string")
  )
    throw unavailable();
  // Constraints and the fixed helper own state/parent validity. This conversion
  // checks the selected nonsecret result shape and original lookup correspondence.
  return Object.freeze({
    ...lookup,
    incarnation: row.incarnation,
    accountVersion: Number(version),
    state: row.state,
    currentUserId: row.current_user_id,
    credentialAccountId: row.credential_account_id,
  });
}

/** Borrows the same transaction; never acquires a connection or releases locks.
 * TODO(turn account assembly): bind the genuine owner/order/query context and
 * install the original restricted helper privilege. No production reader or
 * complete account version-vector authority is installed by this factory.
 */
export function createPostgresAccountSecurityReaderV1(
  context: PostgresAccountSecurityContextV1,
): LocalAccountSecurityRecordReaderV1 {
  const { owner, token } = context;
  let started = false;
  let released = false;
  let preparing = false;
  let failed = false;
  let failure: unknown;
  const fail = (error: unknown): never => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    TurnCommandScopeV1.prototype.poison.call(owner, failure);
    throw failure;
  };
  const assertOwner = () => {
    if (failed) throw failure;
    if (released) throw unavailable();
    // Invoke the actual private-field-bearing implementation: a structurally
    // positive object or copied token cannot stand in for this owner association.
    TurnCommandScopeV1.prototype.assertOwned.call(owner, token);
  };
  const assertIO = () => {
    assertOwner();
    context.transaction.assertActive();
    if (context.scope.installationId !== token.installationId)
      throw new ScopeViolationError("The account reader belongs to another Installation.");
  };
  const read = async (lookup: Readonly<LocalAccountSecurityLookupV1>) => {
    assertIO();
    const result = await context.query.query(
      `SELECT installation_id, account_id, issuer, subject, incarnation,
              account_version::text AS account_version, state,
              current_user_id, credential_account_id
         FROM occ.read_locked_account_security_v1($1, $2, $3, $4)`,
      [lookup.installationId, lookup.accountId, lookup.issuer, lookup.subject],
    );
    assertIO();
    if (result.rowCount === 0 && result.rows.length === 0) return undefined;
    if (result.rowCount !== 1 || result.rows.length !== 1) throw unavailable();
    return decodeRecord(result.rows[0], lookup);
  };
  return Object.freeze({
    lock: async (input: LocalAccountSecurityLookupV1) => {
      try {
        assertIO();
        if (started) throw unavailable();
        started = true;
        context.assertAcquisitionOrder();
        const lookup = Object.freeze({
          installationId: input.installationId,
          accountId: input.accountId,
          issuer: input.issuer,
          subject: input.subject,
        });
        if (
          lookup.installationId !== token.installationId ||
          typeof lookup.accountId !== "string" ||
          lookup.accountId.length === 0 ||
          lookup.issuer !== `occ:installation:${token.installationId}:better-auth` ||
          lookup.subject !== lookup.accountId
        )
          throw new ScopeViolationError("The account lookup belongs to another identity.");
        const record = await read(lookup);
        if (record === undefined) return undefined;
        const lease: LocalAccountSecurityRecordLeaseV1 = Object.freeze({
          record,
          prepareCommit: async () => {
            try {
              assertIO();
              if (preparing) throw unavailable();
              preparing = true;
              const current = await read(lookup);
              if (
                current === undefined ||
                current.incarnation !== record.incarnation ||
                current.accountVersion !== record.accountVersion ||
                current.state !== record.state ||
                current.currentUserId !== record.currentUserId ||
                current.credentialAccountId !== record.credentialAccountId
              )
                throw unavailable();
            } catch (error) {
              fail(error);
            } finally {
              preparing = false;
            }
          },
          assertCurrent: () => {
            try {
              assertOwner();
              if (preparing) throw unavailable();
              return undefined;
            } catch (error) {
              return fail(error);
            }
          },
          release: () => {
            released = true;
          },
        });
        return lease;
      } catch (error) {
        return fail(error);
      }
    },
  });
}
