# Turn journal contract

The versioned turn journal defines the OCC boundary for shared Agent admission,
execution consumption, completed-context publication and delivery. It includes
strict value decoders, pure consistency classifiers and a callback wrapper that
keeps initiation behind the outer transaction commit. A database implementation
and integration with the actual channel, runtime and canonical-store owners are
required before this contract can operate a shared Agent.

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
remains `delivery-unknown`. At most one exact known-ID outcome-status update is
allowed. A missing reply never regenerates the result by executing the turn again.

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
