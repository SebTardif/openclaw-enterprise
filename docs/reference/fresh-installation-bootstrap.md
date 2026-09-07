# Fresh Installation bootstrap

Fresh bootstrap commits the server-generated Installation before creating its local administrator account. Account writes therefore obtain their Installation from the canonical database row. The account identifier and credential association come from the actual authentication writer.

The original state store retains the successful fresh-insert association. It captures the administrator IAM seed before asynchronous transaction acquisition, then persists that seed before authorizing the default Namespace. IAM, Namespace reconciliation work and the bootstrap audit share the original controller transaction.

An existing Installation follows the existing administrator-account and Principal verification path. An Installation identifier or empty IAM tables cannot authorize bootstrap finalization. Conflicting, repeated or uncertain attempts are refused.

## Failure handling

The Installation reservation and authentication writes are separate from the final controller transaction. Failure of that final transaction does not roll back earlier account or service-key effects. Retained account-security records and tombstones keep their Installation association; bootstrap does not delete the Installation to simulate rollback.

An unknown commit outcome requires resolution using the original attempt identifiers. Do not blindly repeat bootstrap or delete the account, service key or protected output in that situation. Interrupted bootstrap is not automatically adopted as a fresh attempt.

For a known failed finalization, bootstrap attempts to revoke only the returned service key and delete only the returned account. Each cleanup records an acknowledgment or unavailable outcome. An account-creation failure without a returned identifier cannot authorize deletion by email. An unavailable cleanup remains unresolved.

Protected credential output retains its existing exclusive creation and private permissions. Existing output files remain in place after a failed attempt because the writer does not return an ownership receipt for safe later removal. They can contain credentials whose revocation was attempted; preserve the failure record and resolve the exact attempt before reusing those files. Diagnostics contain attempt identifiers and bounded failure codes, never passwords or service-key values.

Failure records distinguish the operation that failed, a committed or unknown outcome, an incomplete Installation, and unavailable account/compensation outcomes. A cleanup acknowledgment is not evidence that the whole bootstrap rolled back. The pending field indicates that protected output writing started; it does not assert that every file was durably written.

## Scope

This flow creates fresh local accounts through the existing authentication writer. It does not backfill historical account-security records, enroll native channel users, grant additional database privileges, or establish the other authority-version producers. Existing users require their separately authorized migration or enrollment path.
