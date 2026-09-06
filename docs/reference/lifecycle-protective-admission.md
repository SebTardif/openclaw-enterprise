# Protective lifecycle admission storage

Protective admission stores a disabled or stopped runtime intent and its original
work, attributable audit, cleanup responsibility and pending audit-export record
in the existing platform transaction. It is an internal persistence operation.
The public account-authenticated admission service and lifecycle worker cutover
are not installed by this storage extension.

The internal `lifecycleAdmissions.applyProtective` operation returns either a
minimal unchanged result or a provisional retained record. Only the outer
transaction owner's successful return establishes commit. The caller supplies
server-retained operation, work, audit and responsibility identifiers and the
exact disable/stop request; these inputs are not account authorization evidence.

## Original transaction and ordered use

The [repository port](../../packages/occ/src/ports/repositories/lifecycle-admission.ts)
is part of the existing platform unit of work. The
[unit phase](../../packages/occ/src/lifecycle/protective-admission-unit.ts) admits
one protective operation in an otherwise unused unit. An earlier ordinary
repository operation or borrowed query prevents entering this phase. An outward
repository operation or borrowed query after entry poisons the unit. Installation
identity reads retain their existing exception to phase selection.

Accepted protective work drains before commit or rollback. Caught and unawaited
failures preserve the first error and poison the whole unit; closing admissions
synchronously prevents new operations while accepted backend continuations
finish. The original owner retains pool, client, transaction lifetime, error
classification and terminal cleanup. No repository starts a nested transaction.

The PostgreSQL adapter requires READ COMMITTED, resolves the original initialized
singleton Installation, then locks the exact Namespace and Agent before reading
the head and retained allocations. Protective history can remain attached to an
owned nonready or tombstoned Namespace; ordinary running and allocation lookups
keep their existing readiness checks. PostgreSQL intent-insertion triggers share
these locks with legacy writers. The memory adapter uses the original serialized
snapshot clone and commit.

TODO: insert the actual protected account participant inside this isolated
operation, before the Namespace and Agent locks. It must retain the real request,
current account/session/security evidence, selected IAM instance and qualified
`lifecycle-manager` entitlement for exact `agent.disable` or `agent.stop` through
the owning transaction's terminal cleanup. Generic `operate`, Installation
administrator status and stored actor metadata do not supply this participant.
No positive callback, public handler or account transaction bridge is installed.

## Intent lineage and original correspondence

Running intent always has a selected revision. A first protective intent may
retain `revisionId: null` only when no revision-bearing runtime lineage has been
admitted; an unrelated saved draft does not select that lineage. A successor
retains the predecessor's revision, including null, exactly. Protective writes
cannot erase a selected revision. A delayed legacy intent cannot supersede a
version 1 protective head.

The expected generation is compared before same-mode no-op. A stale same-mode
request conflicts. A valid same-mode request creates no intent, work, audit,
responsibility or export row and returns only unchanged mode and generation.
A material change increments the safe integer generation exactly once. Stop is
terminal for this protective branch; it does not admit a later disable.

An already retained operation identifier conflicts before changed-head/no-op
decisions. Exact recovery uses the original identifier in a separate fresh read;
it does not allocate replacement identifiers or repeat the mutation. The
`findCommitted` repository projection verifies the original immutable request,
intent, work, audit, cleanup and export correspondence without requiring the
operation to remain current or its work to remain queued. Its caller remains
responsible for fresh current authorization and exact original expectations.

Unknown COMMIT retains the existing `PostgresCommitOutcomeUnknownError` identity.
No compensation or blind replay is introduced. Readback occurs after the failed
unit unwinds and releases its connection. A later head or terminal work neither
erases historical acceptance nor proves physical cleanup.

## Existing queue and explicit compatibility barrier

Both protocols use `controller_work` and its existing four states. Existing rows
have `work_schema_version = 0` and retain their original shape, idempotency keys,
revision-admission foreign key, tokens, leases and retry semantics. All legacy
queue methods and old operation projections explicitly select version 0, and the
legacy row decoder refuses another version. The cross-version unique resource
claim constraint and in-flight resource exclusion remain intact.

Version 1 rows use `ReconcileAgentLifecycleV1`, the original operation/work IDs,
Agent, generation and actor, and the exact nullable protective revision. They
begin as ordinary pristine queued records. Generated discriminator columns
preserve the legacy deploy foreign key and select the new lifecycle association
foreign key. No sentinel revision, distant availability date, hidden queue state
or caller readiness flag selects this branch.

Every version 1 work update must pass the same database gate, including claim,
renewal, recovery, failure and completion. The trigger rejects an absent optional
`occ_lifecycle_worker_v1` role before checking membership of the actual invoker.
It requires READ COMMITTED, acquires an Installation-scoped shared transaction
advisory lock, then reads the matching live capability in a distinct VOLATILE
statement. API, worker, maintenance and receiving versions must all equal 1.
The trigger rechecks marker existence and invoker membership after the lock wait.
Role writers do not share this lock; this fresh compatibility observation does
not provide atomic exclusion of role revocation. Capability writes take the
paired exclusive transaction lock. Missing records,
unsupported isolation and unavailable versions refuse the update.

The application has SELECT only on capabilities. The migration creates no
cluster role or membership and supplies no activation API. Future operator role
provisioning, compatible consumers and cutover require their own implementation
and qualification. A live storage compatibility marker alone does not provide
account authority, a handler, an accepting effect fence or physical cleanup.

## Cleanup and audit-export obligations

One immutable `runtime_cleanup_responsibilities` record retains the protective
origin, scope, predecessor and responsibility version. Its membership table
references actual original allocation records, preserving assignment,
create-effect, lifecycle/runtime generation and profile identities. Membership
covers rows observed and retained under the shared Agent lock. Its status stays
`unresolved`; it is not a closed provider-effect inventory. An empty membership
cannot prove that no create is possible, and late outcomes stay attributable to
the original immutable references.

The local attributable audit and `audit_export_outbox` pending row commit with
the intent and work. Memory commit does not call the remote audit sink for these
outboxed events; the original audit publisher remains unchanged for other events.
The PostgreSQL adapter uses the original audit serializer. No exporter, cleanup
completion method or second journal is introduced. Durable rows do not establish
RuntimeFaultSink acceptance, an effective stop, or permission for a successor.

## Schema and verification

[Migration 0027](../../migrations/0027_lifecycle_protective_admission.sql) adds the
explicit intent/work branches and five tables. Deferred constraints require the
complete original record family at commit. Existing schema objects are passed
once to the [schema factory](../../packages/occ/src/state/postgres/lifecycle-admission-schema.ts),
so foreign keys keep their original parent table and column identities. Drizzle
cannot express FK deferrability; the four cyclic foreign keys are explicitly
`DEFERRABLE INITIALLY DEFERRED` in the migration. The existing database work-ID
code-point length limit remains; it can be stricter than the contract validator's
grapheme count for long combining sequences.

[Conformance cases](../../tests/conformance/lifecycle-protective-admission.test.mjs)
exercise the actual memory store and separately label pure decision boundaries.
[PostgreSQL admission cases](../../tests/integration/postgres-lifecycle-protective-admission.test.mjs)
exercise atomic rows, privileges, queue exclusion, concurrent CAS, role absence,
isolation and an observed advisory-lock wait followed by capability withdrawal.
[Recovery cases](../../tests/integration/postgres-lifecycle-admission-recovery.test.mjs)
use fresh-process readback and the real protocol acknowledgement-loss fixture.

The PostgreSQL suites require separately prepared dedicated loopback application
and migrator URLs. Permitted-role concurrency additionally requires an
independently provisioned constrained worker-member URL. Tests create no roles
or memberships. Source definitions and pure decisions cannot establish database
constraint, snapshot, restart, native authority or provider behavior; those
claims require the corresponding actual executions.
