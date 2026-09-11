# Journal storage and admission

Part of the [Turn journal contract](../turn-journal.md) reference.

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
implements the original eleven read and twelve mutation methods, including rejected and
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
[reserved channel creation command](../channel-administration.md#reserved-channel-creation-in-postgresql),
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
