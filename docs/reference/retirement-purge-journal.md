# Retirement journal interface

The versioned retirement journal defines one atomic publication and exact historical
metadata reads. Its codecs, reference consumers and in-memory model do not install
a retirement backend or confer management authority. Implementations compose the
existing sole journal, lifecycle phase and retirement participant.

## Commands and immutable identity

`RetirementPurgeJournalV1` defines three complete commands:

- `publishRetirementManifest(originalTransactionRef, input, call)` publishes the
  permanent retirement barrier, full manifest, stopped-lifecycle association,
  mandatory audit and durable progress responsibility in one outer transaction.
- `recordRetiredStoreObservation(originalTransactionRef, input, call)` records one
  exact store observation and immutable receipt with its versioned progress.
- `findRetirementManifest(query, freshCall)` reads exact historical metadata. Its
  closed `retirement` and `observation` branches share the full original binding,
  manifest, audit and responsibility. Observation reads also bind their original
  transaction and exact observation, returning current progress plus the unchanged
  first receipt.

Both mutation locators are known before invocation and compared with genuine
protected input inspection. Request IDs are not implicit durable transaction
references. The publication transaction remains in the binding; observation
transactions identify their own original receipt. Unknown outcomes never allocate
replacement locators.

The common retirement binding separates the expected stopped-head transition
UUID and lifecycle generation from the new purge operation in the manifest. The
barrier reference/version and activation/replay lineage reference/version project
one immutable publication owned by the sole retirement participant. There is no
additional independent retirement epoch or numeric equality between these counters.

The lineage resolves the exact complete content-free per-target activation,
not-before, acceptance/pruning and clock-evidence tuple for the manifest inventory.
It remains resolvable at least as long as the permanent barrier. It cannot become
an independently mutable store, new clock assertion or lifecycle-generation alias.
The value definition does not assert that a configured producer already exists.

## Atomic publication and races

An implementation enters one original outer transaction and internally composes
the real retirement participant. It exposes no SQL, nested transaction, borrowed
connection or caller-composable partial phase. An outward protective call followed
by journal calls, or outward pre-locking before a protective call, cannot implement
this contract. Accepted mutation failure poisons the whole unit even if caught.
Work drains before the outer decision; local success is provisional until commit.

The lifecycle Namespace, Agent and current-head locks and installation/admission
selection locks require one compatible order across all relevant writers. In
particular, Agent then advisory lock conflicts with intake holding that advisory
lock while waiting for Agent. Implementations must establish the actual placement
and coverage for activation, intake, dispatch, checkpoint, head and delivery writers;
the reference model supplies no SQL or current-writer coverage proof.

If activation/publication wins first, retirement rejects the stale target inventory.
If retirement wins first, later old-generation acceptance rejects. Previously
accepted uncertain external effects retain their owners and still need observation
or containment. Database serialization does not physically cancel them. An old
identity cannot resume or target a replacement PVC UID.

## Exact history and observation receipts

Initial publication reuse conflicts. There is no retry-as-existing publication
success. After commit uncertainty the original owner unwinds before a fresh,
independently authorized historical read. The complete expected transaction,
stopped transition/generation, barrier, lineage, full canonical manifest, audit and
responsibility must match. Later lifecycle head changes do not erase history.
Absent, denied, unavailable, timeout and still-settling results cannot authorize
resubmission, deletion, resume, release or a replacement locator.

Observation recording checks current observation authority before receipt lookup.
The immutable receipt binds its first transaction, publication, target, deletion
operation, observation/evidence identities, sequence, source time and contents.
An exact historical duplicate returns `existing` with current progress and that
unchanged receipt, even after another target advanced global progress. It does
not rewrite first evidence or claim the intervening advances. Changed content
under the same identity conflicts; new observations require the current expected
progress version and advance exactly one applicable target.

`recordedAtRecordVersion` is the first observation's global advance. A new
`recorded` result must contain that exact current row/version. Historical results
may carry older receipts, but cannot contradict terminal absence, monotonic source
time or immutable observation identity. A target's sequence distance cannot exceed
the intervening global version distance. Same-version history must show the same
observation. These are pure pairwise checks, not proof of a genuine provider receipt.

A retirement read has no observation receipt. An observation read must contain its
exact retained receipt; unrelated current progress is insufficient. The reference
unknown-result consumer has only a read method and returns metadata, never a permit.

## Closed codecs and authority boundary

`parsePurgeCallableV1`, `parsePurgeCallableJsonV1` and `encodePurgeCallableV1` cover
bindings, records, inspection views, queries, receipts and all result/commit branches.
The new envelope is bounded to 768 KiB, depth 24, 49,152 nodes and arrays of 256;
canonical nested values retain their stricter original limits and manifest digest.
Returned data is detached and deeply frozen. Unknown fields, malformed references,
accessors, exotic prototypes, hidden/symbol keys, cycles, sparse arrays, unsafe
integers and malformed Unicode reject with a sanitized error. JavaScript proxy
traps remain a language limitation; external ingress should use bounded serialized
input.

The JSON profile is canonical-only: use the encoder. Duplicate keys, extra
whitespace, alternate escapes and numeric spellings reject. No decoder produces an
opaque verified input. Only actual configured original owners can supply and
inspect those handles against current management/account/resource policy, complete
inventory, authentic provider observations, stopped-head and writer obligations.
A parsed view, boolean, nominal type or receipt cannot establish those facts.

The conformance fixtures qualify codecs, pure correlations and a synthetic protocol
model. They do not certify PostgreSQL concurrency/restart, complete lock coverage,
current authority, physical stop/no-writer state, real deletion or durable retention.
Those remain explicit accepting implementation and deployment obligations.
