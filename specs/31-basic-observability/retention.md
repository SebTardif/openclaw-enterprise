# Basic observability: audit retention contract

**Status:** Proposed protected-History contract; not implemented or qualified.

**Owners:** State/SQL owns policy, receipt, expiry and live-ledger erasure; composition/operators own installed enforcement and supported restore.

## Decision

An authorized administrator selects one Installation-wide mode: **`days_30` by default**, or explicit **`indefinite`**. This entire contract gates [History and exact mutation recovery](../31-basic-observability.md#access-and-disclosure). It does not govern operator-owned diagnostic files. The existing [append-only SQL protection](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/migrations/0001_occ_immutability_and_grants.sql#L12) is a foundation, not this proposed retention implementation.

## Policy and trusted time

Persist mode, monotonic revision, database-stamped change time and monotonic expired-anchor frontier on the singleton Installation. Current `manage_audit_retention` authorizes compare-and-swap changes. Policy and mandatory event commit together in original State; the event follows the new mode. A stale revision fails even when the requested mode matches.

| Record | Trusted retention metadata                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New    | Database-stamped `received_at` and `retention_anchor_at`; `database_receipt` provenance.                                                                                                        |
| Legacy | Null `received_at`; supported OCC-produced `occurred_at` capped at migration time; explicit `legacy_occurrence` anchor. Reject or explicitly disposition insufficient producer/time provenance. |

The public tagged receipt distinguishes those cases. Preserve the audit primary key; add immutable bigint identity sequence and constrained historical Agent/operation/revision facts without a live-Agent foreign key. Every ledger row requires `audit_event_retention` metadata; absence is an integrity failure, never indefinite retention.

## Expiry and concurrency

`days_30` expires at trusted anchor plus 30 days; new indefinite events have no automatic age expiry. Disclosure hides logically expired records. The authorized worker deletes them from the **live ledger within another 24 hours**.

Append, sweep and disclosure take policy-row **`FOR SHARE`**; policy change takes its exclusive lock before append or expiry updates. `FOR KEY SHARE` is insufficient. Sample one `clock_timestamp()` after acquiring the lock. Use a narrow definer lock/read function without application UPDATE permission. Disclosure uses the parent's short READ COMMITTED State write transaction and IAM read-bound authorization, not generic repeatable-read/read-only access.

Acquire the parent's Installation/account/session/policy/resource guards before the first append trigger takes retention. An audit-only transaction cannot later acquire earlier guards; retention functions cannot call back into IAM after locking. Review every writer's SQL. Already accepted protective worker transitions require correct stamping/order, not an invented human session; new authority/effects retain their admission checks.

| Transition               | Exact retained-row behavior                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `days_30` → `indefinite` | Clear only expiries **strictly later** than change time. Already expired values remain expired, including equality.                    |
| `indefinite` → `days_30` | Set null expiries to `greatest(retention_anchor_at + 30 days, changeTime)`. Old records hide at change time and erase within 24 hours. |
| Either mode              | Preserve finite expired values and continue sweeping them.                                                                             |

Advance the irreversible expired-anchor frontier entering/leaving finite mode; finite mode also implies the frontier at current trusted time. Neither transitions nor restores resurrect expired records. Missing recovery evidence cannot be reconstructed. Indefinite provides no legal hold, unlimited storage, arbitrary deletion authority or credential-cleanup exception; required operations fail closed when local audit cannot commit.

**Proposal — owner decision pending:** State/Audit/API must settle expiry crossing during pages and exact recovery. Preserve post-lock sampling and transition arithmetic; bound transactions/cancellation and fail closed when the agreed release rule cannot hold. No silent resampling, extended eligibility or timer reset is approved.

## Database and runtime enforcement

Use the existing raw-SQL migration runner; backfill legacy rows under the migrator's exclusive table lock and restore final triggers before commit. All tables are logged. State and standalone work-queue writes require effective `fsync` and `synchronous_commit` waiting for local WAL flush; preserve unknown-COMMIT classification.

| Boundary             | Required enforcement                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every insert         | BEFORE INSERT locks policy/stamps trusted fields; AFTER INSERT atomically creates metadata. Privileges or equivalent construction prevent forged receipt, sequence and anchor. Include [direct queue CTEs](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/packages/occ/src/state/postgres-work-queue.ts#L216) and non-Agent account/login writers. |
| Ordinary application | No UPDATE/DELETE/TRUNCATE of facts, direct policy/metadata changes or sequence manipulation. Audit UPDATE remains unconditionally forbidden.                                                                                                                                                                                                                                                      |
| Delete guard         | Security-invoker trigger admits only the trusted purge-function owner after independently verifying elapsed recorded expiry.                                                                                                                                                                                                                                                                      |
| Purge function       | Fixed schema-qualified SQL and secure fixed search path with `pg_temp` last; enforced batch ceiling; no caller event IDs/cutoff. Lock an ordered eligible batch using `SKIP LOCKED`; delete ledger rows and cascade metadata through its foreign key.                                                                                                                                             |
| Purge authority      | Trusted migrator may own the function. A separately provisioned runtime role has only EXECUTE; `occ_app` is not a member. Current selected-IAM retention authority is additionally required. Return aggregate progress/sanitized failures only.                                                                                                                                                   |
| Policy update        | Sole metadata-update function locks exclusively first, checks expected revision, updates eligible expiries/frontier and appends mandatory evidence in original State. Initial metadata creation remains the insert trigger's duty.                                                                                                                                                                |

**Proposal — owner decision pending:** State/composition/IAM/SQL must bind current authorization and separate purge-role execution under one reviewed guarded boundary. Checking one connection then executing unguarded elsewhere, lending a foreign unit of work, granting purge to `occ_app`, or granting policy writes to History readers cannot satisfy it.

Composition provides authorized configuration and a bounded, restart-safe sweeper with pressure/overdue-erasure health. Verify effective function ACLs, `PUBLIC`/application exclusion, role memberships and fixed definer search path after migration **and restore**.

## Restore and copy ownership

The product owns its live ledger and product-created copies. Operators own independent backups, replicas, snapshots, WAL archives and downloads. Live deletion does not certify erasure from those copies.

Before any replica serves History or exact recovery, require authoritative current mode/revision/frontier or complete replay continuity through an independently established terminal policy revision. Apply filtering and required purge first. The restored database, a signature, file timestamp or largest restored revision cannot prove absence of later policy. Unprovable continuity keeps disclosure unavailable; unrelated diagnostics retain their own controls.

**Proposal — owner decision pending:** product, State and operators select a supported procedure that fences the source against further changes, exports its final committed checkpoint outside the rolled-back database, and imports under restricted restore mode. The concrete contract must define:

- State issuer, bounded/versioned envelope, integrity/custody and exact Installation binding against the operator-established target; complete authority/frontier continuity.
- Authorized export/import, custody access/replacement, missing/stale material and unsupported recovery outcomes; no implied History-read permission or ordinary application DML.
- Validation and application through the State/SQL guard protocol, reconciling current trusted database time with immutable facts, finite expiries, frontier and **original 30-day/24-hour obligations**.
- All-replica startup/readiness, restart-safe filtering/purge and acknowledged completion. Interrupted or unknown import/activation stays closed until exact committed state is established; a restored ready bit is insufficient.

This is operator recovery, not remote audit delivery or independent rollback detection. The authoritative custody/freshness procedure needs acceptance before implementation is accepted; no new recovery service is prescribed.

## Acceptance and follow-ups

Use real PostgreSQL roles and concurrent connections for forged stamps/sequence, missing metadata, exact-expiry transitions, post-lock timing, long waits/cancellation, append/change/sweep/disclosure races, residual finite purge under indefinite, stale CAS, rollback/lost acknowledgment, direct-DML denial, definer isolation, fresh/legacy migration and bigint pagination. Test current authorization and effective role/function ACLs through actual consumers.

Restore an older indefinite backup across subsequent finite expiry and return to indefinite. Wrong Installation, missing/stale continuity, malformed/unsupported checkpoint, unauthorized import, incomplete replay, later policy changes, interruption, restart, multiple replicas and unknown COMMIT must prevent premature disclosure. Record effective installed durability, sweeper restart/overdue health, actual custody/restore procedure and copy-specific erasure separately from database tests. These are required future checks, not recorded passes.

Arbitrary periods/classes and legal holds await a selected richer-policy use case: State/product/operators must qualify migration, transitions, races, erasure and restore. Remote custody or independent witnessing awaits a stronger recovery/trust requirement and the parent's acknowledgment/replay/custody evidence. Neither is an excuse to remove indefinite mode or today's restore gate.
