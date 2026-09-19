# Basic observability: audit retention contract

[Overview](../31-basic-observability.md) · [Interfaces](interfaces.md#retention-interface-index) · [Security](security.md)

**Status:** Proposed protected-History contract. Not implemented or qualified.

**Owners:** State/SQL owns policy, receipt, expiry and live-ledger erasure. Composition/operators own installed enforcement and supported restore.

## Decision

An authorized administrator selects one Installation-wide mode: **`days_30` by default**, or explicit **`indefinite`**. This entire contract gates [History and exact mutation recovery](interfaces.md#disclosure-transaction). It does not govern operator-owned diagnostic files. The existing [append-only SQL protection](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/migrations/0001_occ_immutability_and_grants.sql#L12) is a foundation, not this proposed retention implementation.

## Policy and trusted time

Persist mode, monotonic revision, database-stamped change time and a monotonic expired-anchor frontier on the singleton Installation. The frontier records irreversible expiry progress so an older policy or restore cannot make expired evidence visible again.

Current `manage_audit_retention` authorizes compare-and-swap changes against an expected revision. Policy and mandatory event commit together in original State. The event follows the new mode. A stale revision fails even when the requested mode matches the current mode.

New records receive database-stamped `received_at` and `retention_anchor_at`, tagged as `database_receipt`. Producer observation time remains separate from the trusted retention clock.

Legacy records retain null `received_at`. Supported OCC-produced `occurred_at`, capped at migration time, supplies an explicitly tagged `legacy_occurrence` anchor. Reject or explicitly disposition records lacking sufficient producer/time provenance. The [public tagged receipt](interfaces.md#facts-and-events) distinguishes these cases.

Preserve the audit primary key. Add an immutable bigint identity sequence and constrained historical Agent/operation/revision facts without a live-Agent foreign key. Every ledger row requires `audit_event_retention` metadata. Missing metadata is an integrity failure, never indefinite retention.

## Expiry and concurrency

`days_30` expires at trusted anchor plus 30 days. New indefinite events have no automatic age expiry. Disclosure hides logically expired records. The authorized worker deletes them from the **live ledger within another 24 hours**.

Append, sweep and disclosure take policy-row **`FOR SHARE`**. Policy change takes its exclusive lock before appending evidence or changing expiries. `FOR KEY SHARE` is insufficient. A narrow definer lock/read function provides the shared lock without giving the application UPDATE permission.

Sample one `clock_timestamp()` after acquiring that lock. Disclosure uses the short READ COMMITTED State write transaction with IAM read-bound authorization described in [interfaces](interfaces.md#disclosure-transaction), not generic repeatable-read or read-only access.

Acquire Installation, account/session, policy and protected-resource guards before the first append trigger takes retention. An audit-only transaction cannot later acquire earlier guards. Retention functions cannot call back into IAM after locking. Review every writer's SQL, including already accepted protective worker transitions. Those workers require correct stamping/order without an invented human session. New authority/effects retain their admission checks.

The transitions preserve exact equality behavior:

1. **`days_30` to `indefinite`.** Clear only expiries strictly later than change time. Already expired values remain expired, including equality.
2. **`indefinite` to `days_30`.** Set null expiries to `greatest(retention_anchor_at + 30 days, changeTime)`. Old records hide at change time and erase within 24 hours.
3. **Either mode.** Preserve finite expired values and keep sweeping them even when the current mode is indefinite.

Advance the irreversible expired-anchor frontier when entering or leaving finite mode. Finite mode also implies the frontier at current trusted time. Neither transitions nor restores resurrect expired records. Missing recovery evidence cannot be reconstructed.

Indefinite provides no legal hold, unlimited storage, arbitrary deletion authority or credential-cleanup exception. Required operations fail closed when local audit cannot commit.

**Proposal, owner decision pending:** State/Audit/API must settle expiry crossing during pages and exact recovery. Preserve post-lock sampling and transition arithmetic. Bound transactions/cancellation and fail closed when the agreed release rule cannot hold. No silent resampling, extended eligibility or timer reset is approved. [Interfaces](interfaces.md#disclosure-transaction) owns the release decision.

## Database and runtime enforcement

Use the existing raw-SQL migration runner. Backfill legacy rows under the migrator's exclusive table lock and restore final triggers before commit. All tables are logged. State and standalone work-queue writes require effective `fsync` and `synchronous_commit` waiting for local write-ahead log (WAL) flush. Preserve unknown-COMMIT classification.

### Every insert and ordinary application role

A BEFORE INSERT trigger locks policy and stamps trusted fields. An AFTER INSERT trigger atomically creates retention metadata. Privileges or equivalent construction prevent forged receipt, sequence and anchor. This includes [direct queue CTEs](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/packages/occ/src/state/postgres-work-queue.ts#L216) and non-Agent account/login writers, not only lifecycle API appends.

Ordinary application roles cannot UPDATE, DELETE or TRUNCATE facts, directly change policy/metadata or manipulate sequence. Audit UPDATE remains unconditionally forbidden.

### Restricted purge

A security-invoker delete trigger admits only the trusted purge-function owner after independently verifying that recorded expiry has elapsed. The purge function uses fixed schema-qualified SQL and a secure fixed search path with `pg_temp` last. It enforces a batch ceiling and accepts no caller event IDs or cutoff.

The function locks an ordered eligible batch with `SKIP LOCKED`, deletes ledger rows and cascades metadata removal through its foreign key. A trusted migrator may own the function. A separately provisioned runtime role has only EXECUTE and `occ_app` is not a member. Current selected-IAM retention authority is additionally required. Return aggregate progress and sanitized failures only.

**Proposal, owner decision pending:** State/composition/IAM/SQL must bind current authorization and separate purge-role execution under one reviewed guarded boundary. Checking one connection and executing unguarded elsewhere cannot satisfy it. Neither can lending a foreign unit of work, granting purge to `occ_app` or granting policy writes to History readers.

### Policy change and runtime checks

The sole metadata-update function takes the exclusive lock first, checks expected revision, updates eligible expiries/frontier and appends mandatory evidence in original State. Initial metadata creation remains the insert trigger's duty.

Composition provides authorized configuration and a bounded, restart-safe sweeper with pressure/overdue-erasure health. Verify effective function ACLs, `PUBLIC`/application exclusion, role memberships and fixed definer search path after migration **and restore**. A role's intended name is insufficient evidence of its effective privileges.

## Restore and copy ownership

The product owns its live ledger and product-created copies. Operators own independent backups, replicas, snapshots, WAL archives and downloads. Live deletion does not certify erasure from those copies.

Before any replica serves History or exact recovery, require authoritative current mode/revision/frontier or complete replay continuity through an independently established terminal policy revision. Apply filtering and required purge first. A restored database, signature, file timestamp or largest restored revision cannot prove absence of later policy. Unprovable continuity keeps disclosure unavailable. Unrelated diagnostics retain their own controls.

**Proposal, owner decision pending:** product, State and operators select a supported procedure that fences the source against further changes, exports its final committed checkpoint outside the rolled-back database, and imports under restricted restore mode. The concrete contract must establish these steps:

1. **Issue and retain authoritative material.** Define the State issuer, bounded/versioned envelope, integrity/custody and exact Installation binding against the operator-established target. Preserve complete authority/frontier continuity.
2. **Authorize export and import.** Define custody access/replacement, missing or stale material and unsupported recovery outcomes. Export/import authority implies neither History-read permission nor ordinary application DML.
3. **Validate and apply.** Use the State/SQL guard protocol. Reconcile current trusted database time with immutable facts, finite expiries, frontier and the **original 30-day/24-hour obligations**.
4. **Activate every replica.** Gate startup/readiness on restart-safe filtering/purge and acknowledged completion. Interrupted or unknown import/activation stays closed until exact committed state is established. A restored ready bit is insufficient.

This is operator recovery, not remote audit delivery or independent rollback detection. The authoritative custody/freshness procedure needs acceptance before implementation is accepted. No new recovery service is prescribed.

## Acceptance and follow-ups

Use real PostgreSQL roles and concurrent connections to test forged stamps/sequence, missing metadata, exact-expiry transitions, post-lock timing, long waits/cancellation and append/change/sweep/disclosure races. Also prove residual finite purge under indefinite, stale CAS, rollback/lost acknowledgment, direct-DML denial, definer isolation, fresh/legacy migration and bigint pagination. Test current authorization and effective role/function ACLs through actual consumers.

Restore an older indefinite backup across subsequent finite expiry and return to indefinite. Wrong Installation, missing/stale continuity, malformed/unsupported checkpoint, unauthorized import, incomplete replay or later policy changes must prevent premature disclosure. Exercise interruption, restart, multiple replicas and unknown COMMIT too.

Record effective installed durability, sweeper restart/overdue health, the actual custody/restore procedure and copy-specific erasure deadlines separately from database tests. These are required future checks, not recorded passes.

Arbitrary periods/classes and legal holds await a selected richer-policy use case. State/product/operators must qualify migration, transitions, races, erasure and restore. Remote custody or independent witnessing awaits a stronger recovery/trust requirement and [acknowledgment/replay/custody evidence](security.md#accepted-limits-and-closure). Neither is an excuse to remove indefinite mode or today's restore gate.
