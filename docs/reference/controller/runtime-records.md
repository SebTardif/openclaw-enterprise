# Runtime intent, allocation, and transaction records

OCC state repositories expose `runtimeAssignments` for immutable per-Agent intent
history and unbound runtime allocations. The current intent head advances by
expected-generation compare-and-set. Allocations require a ready Namespace,
an exact current running intent and an admitted AgentRevision; their gateway and
harness generations advance independently under an Agent lock. Runtime mutations
within one unit of work also execute serially, including calls awaited together
with `Promise.allSettled`; stale generations conflict against the preceding
mutation’s state. PostgreSQL
constraints and triggers preserve ownership, immutable history and monotonic
sequences. The in-memory adapter preserves the same observable transaction
behavior within one process.

The controller delegates its shared mutation boundary to
[MutationRunner](../../../packages/occ/src/application/mutation-runner.ts). Nested
transactions, mutations, and reads join its current unit of work. The outer
transaction creates a missing Installation or rejects a different Installation ID
before running its work. Registered Driver compensations belong to that outer
unit and run in reverse order on an ordinary failure. A deployment admission
failure marks the unit as failed even if its caller catches the rejection.
`forRepositories` copies explicit repository and method selections for read and
mutation callbacks and supplies frozen projections of bound method delegates,
including when a read joins a mutable unit. The store retains ownership of
commit, accepted-operation draining, and repository-handle lifetime.
`PostgresCommitOutcomeUnknownError` is rethrown without compensation or replay;
recovery still uses the caller's retained admission locator.

The [identified V2 deploy command](../lifecycle-deploy-v2.md) and canonical
deployment service admit running intents. An explicit expected lifecycle
generation initializes an absent head or advances the exact running generation;
disabled or stopped heads conflict. Admission does not allocate provider
instances, bind runtime identities, or establish current execution authority.
Historical revisions without an admission association are not backfilled from
active pointers or healthy workloads. Profile references identify stored values;
persistence does not approve a profile or attest a guest.

`runtimeAdmissions` retains the exact immutable original revision association,
intent, original reconcile work, and successful audit for committed-admission
readback. Completed or permanently failed work and a later head do not erase
original acceptance. Unknown-commit recovery runs through a fresh authorized
read after the failed transaction unwinds. Missing, mismatched, or unavailable
proof remains unavailable. Retain the exact command and original attribution;
never automatically create another operation identity or provider submission.
The [deployment reference](../agents/deployment.md#revisions-and-deployment)
owns accepted-operation disclosure and the V2 reference owns replay enrollment.

For direct internal intent or allocation mutations, before opening a transaction,
the trusted caller retains a fresh UUID-v4
`transitionRef` or `createEffectRef`. After `PostgresCommitOutcomeUnknownError`,
read the exact locator under the same Namespace/Agent scope before deciding any
next action. Intent locator reuse conflicts. Exact allocation effect replay
returns the original immutable record, including after head advancement; changed
component, generation or profile inputs conflict. Historical readback grants no
current runtime authority. Actor and diagnostic request references are retained
independently of identity revocation; they are bounded reference strings, not
credentials or implicit idempotency keys. Attribution and profile references
contain 1–200 ASCII letters, digits, dots, underscores, colons, slashes or hyphens.

For contributor checks, see [controller testing](../../testing/controller.md).
