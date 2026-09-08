# Turn journal contract

The versioned turn journal defines the OCC boundary for shared Agent admission,
execution consumption, completed-context publication and delivery. It includes
strict value decoders, pure consistency classifiers and a callback wrapper that
keeps initiation behind the outer transaction commit. PostgreSQL and explicitly
configured process-local memory implementations use the same journal protocol.
Integration with the actual channel, runtime and canonical-store owners remains
required before either implementation can operate a shared Agent.

## One journal and two storage authorities

OCC owns incoming receipt links, immutable admission decisions, the whole-Agent
reservation, the canonical attempt, consumption, completion heads and delivery
intent. A gateway-owned canonical store owns completed context bytes and immutable
checkpoint manifests. A checkpoint receipt is an input to publication; it does
not advance the OCC head. Workspace persistence and absence of mutators require
separate evidence from their actual trusted owners.

`TurnJournalReadV1` maps to a view supplied by the existing `PlatformStateStore.read`.
`TurnJournalUnitOfWorkV1` maps to the same connection and transaction supplied by
`PlatformStateStore.transact`. Binding those interfaces must not create a second
journal, side transaction or independent audit write. The outer transaction owns
all admission records and its audit intent. Failed mutation poisons that unit even
when its callback catches the error.

### Process-local memory implementation

`InMemoryPlatformState` accepts an optional `turnJournal` configuration. Omitting
it preserves the unavailable default: the Store cannot invoke journal work or
an initiation callback. Configuration requires the actual canonical route-key
function, all three Installation capacities, and a `bind(context)` provider for
admission, rejected and non-turn intake, authorization, and all seven evidence
observations. The provider borrows the existing repository scope, transaction
lifetime and current Installation. It receives no journal maps or commit control.
The evidence port exposes inspection methods; authority and verification issuers
remain with their original providers.
The configuration and capacities are retained independently of caller mutation;
each capacity is an integer from one through 100,000. An optional server-owned
millisecond clock supports deterministic component checks. It supplies neither
provenance nor authority, and invalid or backward readings within a transaction
fail closed. The unchanged Store still owns its separate initiation clock.

The memory journal owns fresh opaque state inside the platform snapshot. It
implements all eleven read and twelve mutation methods, including rejected and
non-turn owner carriers. Composite indexes retain the complete scoped tuples,
original event and logical ownership, and incoming conflict links. One Agent
reservation covers its conversations; there is no executable queue. Existing
owner, incoming-link and attempt capacities do not evict history. The common
pending limit remains 32 per Installation, and outcome history reserves capacity
for the terminal, cancellation, allocation, completion and release records.

Each transaction clones its indexes and owns decoded immutable input and returned
values. Verified handles and abort signals preserve their original identity.
The original transaction guard serializes mutations, poisons the unit after a
thrown mutation even if caught, and drains accepted work before publication.
Closing callback admission rejects escaped use while accepted operations finish.
The existing platform transaction publishes journal, resource, work and local
audit state together. Failure discards the working snapshot. The final owner
checks retained references and call liveness before publishing it, then confirms
the original guard synchronously. Only that exact outward unit can make its
newly created consumption claim eligible for the Store's one initiation.

Checkpoint allocation, completion CAS, cancellation, release and delivery use
the existing strict codecs and consistency rules. Public head reads remain
unresolved while a reservation is held; owned completion checks can inspect the
working head. Unknown outcomes keep consumption, and expiration alone never
releases a reservation. Delivery retains the original 120-second episode, at
most three CREATE attempts after definitive transient no-effect, and one
eligible known-ID status UPDATE. Missing legacy status classification cannot
be inferred as prior unknown.

Memory publication is an in-process commit only. It provides no crash recovery,
cross-process exclusion, durable transport acknowledgement, PostgreSQL isolation
or migration evidence. An external audit sink may already have received an
append when later local publication is refused; the memory owner cannot undo
external I/O. The product journal does not issue native, account, policy,
canonical-store, workspace or no-mutator evidence. Component tests can control
those input observations and external-effect endpoints, but the application
must use their real owners. Missing joins remain unavailable and cannot be
replaced with test-issued admission, completion or commit decisions.

### Pending PostgreSQL replay capacity

The replay schema reserves a permanent slot before a new channel installation
acquires activation responsibility. A pending reservation retains the exact
Installation, channel ID, creation operation and original transaction reference.
It starts at version 1 with no activated target or lineage. The Installation has
10,000 slots; retirement and purge do not reclaim them.

The internal PostgreSQL participant uses the existing journal guard and the
outer owner's client. It locks the Installation intake mutex before the exact
channel parents. The deferred channel-parent constraint permits a pending
reservation before its new parent INSERT only within the same transaction; a
missing parent prevents commit. An existing reservation preserves its original
correspondence and does not authorize another creation or audit.

Registration includes the schema's constraints, triggers and restricted
application grants. The application role can insert pending heads and lock them,
but cannot delete reservations or mutate their state, owner or lineage. The
activation validator remains unavailable, and retirement publication refuses
insertion. Measured clock health, activation and retirement authority are not
supplied by pending metadata.

The production and development PostgreSQL controller factories install the
[reserved channel creation command](channel-administration.md#reserved-channel-creation-in-postgresql),
which joins reservation, parent INSERT and mandatory same-client audit with the
service's authorization and original transaction commit handling. The
process-local journal has no corresponding durable replay-capacity implementation.

## Admission and native acknowledgement

The journal consumes the actual `openclaw/plugin-sdk/channel-inbound` envelope,
receipt and locator types. The selected transport verifier authenticates the
native event; current server policy resolves its original human, exact target,
common grant, audience and workspace. `VerifiedAdmissionInputV1` is a server-only
handle. Its configured provenance owner must reject copied, foreign, stale,
revoked or wrong-recipient handles on every use. A structural TypeScript brand,
JSON field or stored evidence reference establishes no authority.

Admission lookup checks both scoped event and logical-message ownership before
checking whether the Agent is busy. Exact duplicates retain their original
accepted, busy, denied or ignored decision. A changed actor, target or content
conflicts. When event and logical keys identify different original owners, both
records survive and the incoming conflict link is retained. Incoming linkage,
decision, immutable turn, expected head, reservation and audit intent commit in
one transaction. There is one active reservation per Agent and no executable
queue. Separate threads retain separate context and share the workspace gate.

The native transport may acknowledge durable responsibility only after the actual
journal committed the link for the submitted event, including a duplicate or
conflict, or an authorized exact readback proves that same link. A historically
committed original receipt alone does not prove that the new incoming link exists.
Unknown commit retains the exact locator and cannot produce a successful durable
acknowledgement. `findIncomingLink` reads the exact submitted event/content/identity
digests; ordinary original-owner lookup cannot prove that a changed payload or
logical twin has its own committed link. `digestJournalAdmissionIdentityV1` fixes
the content-free semantic correlation, excluding receipt allocation IDs.

An authenticated event with no resolved human or target can be retained by
`admitRejected` without inventing a principal, Agent, head or reservation. It uses
the same event/logical-owner indexes. Later provisioning or policy changes cannot
promote that original denied message into execution. The explicit rejected-owner
result and readback preserve its receipt without inventing missing target state.
The rejected intake path also preserves any previously resolved or non-turn
owner through explicit result carriers and exact status-only readback. Both
standalone and nested record codecs apply the same journal reference bounds.
Unauthenticated or unstable intake cannot claim such a receipt.

### Non-turn events

`ExactNonTurnIntakeV1` and `NonTurnReceiptV1` are a separate, non-executable
intake projection from the same transport verifier. They never fabricate a human
envelope or a logical message identity. Bot and unaddressed original messages
require complete equivalent-original eligibility. Edits, deletes and reactions
may reference a parent through a `related-only` key; they cannot take ownership
of that parent's admission decision. Their event receipt normally differs from
the parent receipt, which is not itself a conflict. Typing control has no logical
message. Other unsupported or ambiguously classified events remain outside this
closed profile. A later executable candidate also checks these same original
owners. Its separate non-turn-owner result cannot be coerced into a human SDK
receipt; the trusted native host must retain the exact incoming-link correlation.

`admitNonTurn` and `findNonTurnIntake` use the same journal and event namespace.
The handling receipt records this incoming link and preserves related original
owners. Missing stable authenticated event identity or a bounded digest yields
`not-responsible`. Status-only readback checks the full locator, digest, class,
relation and normalization profile. Provider protocol-control acknowledgements
are separate from durable journal responsibility.

Upstream native adapters receive an injected trusted host callback. They do not
need an Enterprise database dependency or another copy of its journal schema.
The Enterprise host maps its actual committed receipt to the exact native
invocation; absent integration must withhold durable responsibility claims.

## Dispatch and commit visibility

A reserved attempt identity is allocated before dispatch and does not imply that
an executable intent or consumption has committed. `recordDispatchIntent` binds
that one canonical attempt to current original-human authority, assignment,
reservation, content and expected context head. It cannot retarget an old attempt
to a replacement runtime.

`consumeAttempt` returns only a transaction-local pending claim. It exposes no
start method. `TurnJournalStoreV1.consumeAndInitiate` performs consumption at the
outer store transaction boundary and invokes one callback only for its newly
committed claimant. The `createJournalInitiatorV1` helper implements this callback
boundary when supplied the actual transactional owner and live guard. It does
not implement database uniqueness or validate an arbitrary claimant supplied by
an external caller.

Nested `OCC.transact` can return its callback result before its enclosing
transaction commits. It must not be used as the outer commit signal. Rollback,
lost commit acknowledgement, unavailable state or already-consumed readback
cannot invoke initiation. The wrapper never retries its callback. A crash after
consumption can lose liveness, leaving explicit uncertainty; it cannot justify a
replacement attempt or prompt/tool replay.

Initiation must occur within five seconds and before the earliest live proof
expiry. The guard checks currentness before the first effect and the consumer
uses `guard.assertCurrent()` after awaits and before its first effect. The supplied
guard enforces the same start deadline after each await; a new operation must use
its own current authority at later accepting boundaries.
Cancellation, guard loss or expiry cannot renew a consumed permission.

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
