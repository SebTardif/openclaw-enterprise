# Journal completion and delivery

Part of the [Turn journal contract](../turn-journal.md) reference.

## Completion, cancellation and release

The journal allocates an exact checkpoint ID before any gateway write. The
canonical adapter prepares only completed successful records, verifies its
immutable manifest and returns a checkpoint observation. Publication still
requires the exact native successful terminal, canonical bytes, workspace flush
and no-mutator evidence, original assignments, held reservation and unchanged
expected head. One CAS advances head and sequence while recording the completed
outcome and pending delivery intent. Immutable consumption remains available after
running and uncertain outcomes. Exact reconciliation may publish an already
prepared checkpoint for an execution/checkpoint-unknown attempt only with the
same positive successful-terminal and canonical/workspace evidence; it cannot
turn failed, interrupted or cancelled work into completed context.

`recordOutcome` preserves failed, interrupted, cancelled and unknown execution
without manufacturing a checkpoint. `commitCancellation` records the requesting
principal separately from the original initiator and races with dispatch and
completion under the same versioned record. Cancellation requested is not
termination. A before-dispatch result needs affirmative proof that no executable
intent or consumption exists; absence of an acknowledgement cannot supply it.

`releaseReservation` uses trusted evidence covering the exact closed inventory of
possible mutators and unresolved creates or restores. Historical reply success,
lease expiry, a route seal, an empty discovery result or caller-provided flags
cannot establish release. A late assignment or attempt cannot advance the head
or release another owner's reservation. Historical business outcome can remain
unknown even after separately proved termination; no replay follows. Exact
status-only allocation, cancellation and release reads resolve their original
operation after commit uncertainty. Absence is not permission to retry a mutation
or allocate replacement identities.

## Delivery

Delivery has its own operation and current original-human, route and audience
checks. The journal claims the slot before native send and records the provider
outcome afterward. The closed slots are completed result, outcome status and
cancellation acknowledgement. Each has at most three create attempts within a
two-minute episode; retry needs definitive no-effect evidence. An ambiguous send
remains `delivery-unknown`.

`ExactDeliveryOperationV1.statusNoticeCode` classifies only `outcome-status`
operations. Its closed values are `failed`, `interrupted`, `cancelled`,
`outcome-unknown`, `unavailable-before-dispatch` and `resolved-completed`.
Unknown and unavailable-before-dispatch classify creates; resolved-completed
classifies an update. Failed, interrupted and cancelled can classify an initial
notice or the single resolution of a delivered unknown notice. New status
reservations require the actual immutable output provenance to bind that code,
output reference and digest to the exact attempt
and outcome version, with matching canonical journal state. The optional wire
field preserves old records: a missing legacy classification is readable but
unclassified, and never proves a previously unknown notice. A generic status
slot or output reference cannot supply that missing classification.

At most one outcome-status update may reconcile a positively delivered
`outcome-unknown` create to newly established `failed`, `interrupted`, `cancelled`
or `resolved-completed` status. It retains the exact known provider message ID,
original attempt, actor, destination and reply binding. Its retained outcome
version must be strictly newer than the prior unknown notice and equal the
current canonical attempt version. Fresh original-human and complete-audience
checks and the original two-minute episode still apply. A previously delivered
terminal notice does not qualify as unknown.

A resolved-completed update requires the original successful completion operation
and its exact request identity, checkpoint and atomically published head. The
publication version must be newer than the prior unknown notice and no greater
than the current attempt version; it is not reconstructed from the delivery
version. A later head cannot substitute its checkpoint for the original
publication. Public head-read refusal while the reservation is held does not
make release a prerequisite for delivery. The completed-result slot remains
separate, and completed state does not authorize a new outcome-status create.

An unknown create without a positively known message ID cannot be updated. An
unknown update cannot write again, and uncertain commit readback does not grant
send permission. A missing reply never regenerates the result by executing the
turn again.

Successful completion remains historical state when current permission later
denies delivery or continuation. No delivery acknowledgement proves every channel
reader saw the message.

## Values and verification

Journal wire values are closed, bounded, copied and frozen. Unknown keys,
accessors, foreign prototypes, invalid Unicode, duplicate JSON names, rounded or
unsafe counters, credential URLs and invalid identity correlations are rejected
with constant error text. Decoding establishes data shape, never trusted
provenance. The completed-context module retains the shared context/attempt,
checkpoint, snapshot, canonical-byte and quiet-import contracts. It cannot
restore credentials, old grants, native homes or historical executable items.

Run the focused definition checks with the installed compatible tools:

```sh
node --test tests/conformance/turn-journal-v1.contract.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/turn-journal-v1/tsconfig.json
```

The two adapter examples compile independently against the exported module. Tests
exercise its real codecs, consistency classifiers and callback visibility. They
do not certify PostgreSQL concurrency or restart behavior, application roles,
provider authentication, gateway SQLite durability, native quiet restoration,
workspace persistence, multi-replica exclusion or the full absence of mutators.
Those remain integration requirements for the corresponding actual owners.
