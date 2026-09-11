# Repository Work State adapter

`RepositoryWorkStateAdapterV2` connects the repository operation owner to
`PostgresPlatformState.repositoryWorkBindingV2()`. It implements the operation
owner's State methods using the original State transaction, private participants,
query repository and committed-release witness. It creates no connection pool or
alternative transaction manager.

## Construction and selection

Construction captures one State binding, native origin source, selection source,
custody source and transaction duration. Methods and receivers are captured once.
The State binding accepts its original Work and custody sources once. Missing
generic private types remain `never`; a structural object does not establish
membership in any of these sources.

Generic assembly can forward `WorkRepositoryProtocolOptionsV2<V>` directly as the
adapter's sixth argument and the operation owner's third argument. Its fixed
`protocolVersion` property selects one literal version; sources cannot infer or
widen that choice. Omitted options select metadata V2. Git V3 requires explicit
`protocolVersion: 3`, and a `2 | 3` selection is rejected. Forward the original
options object rather than spreading a conditional argument tuple. This constructor
choice does not authenticate any native, State or custody participant.

The selection source must recognize the Runtime-owned origin and its same
State-owned assignment. It supplies the complete current Work projection, original
admission, distinct phase operations, exact native session diagnostic, inventory
repository target and independently retained observation responsibility.

`current.original` identifies dispatch. Preparation, dispatch and observation
have different operation references but the same original scope, invocation and
prefixed request digest. An initial admission also has its own operation. The
current repository ID is the GitHub repository ID in `RepositoryTargetV2`; the
App and GitHub installation identifiers are retained separately in that target.
Repository names or a token-issuance policy cannot supply these associations.

The adapter retains the actual original admission, preparation, dispatch and
observation objects separately from immutable comparison snapshots. Original
State participant calls receive those same privately issued objects, including
fresh committed-use and late observation. Reinspection cannot replace them with
shape-equivalent copies. Mutating an original's data also refuses currentness;
detaching comparison data never enrolls that copy as authority.

The original source acquisition retains entered native/issue lifetime or the
separate historical observer, and registers its cleanup join before asynchronous
acquisition. Its captured `SourceLease.prepareUse()` completes use qualification
only after State has acquired custody and the Installation/Namespace/Agent locks.
For live use, completion calls the original `selection.retainPolicy`, retains its
release before reading later members, and captures the policy document and
synchronous currentness method. The State selection can borrow the actual policy
head through `participant.acquireCurrentPolicy(context, original, call, policyRef)`
only in this phase. Work validates that document's version, profile, permissions,
execution and time bounds; the existence of a locked row alone grants no use.

Before completion, `assertCurrent` checks only entered original source/native
lifetime, the operation's unchanged data and the original call bounds. Every
qualifier and `prepareCommit` requires successful completion. Reentrant or repeated
completion refuses; a fresh State transaction acquires a fresh source lease.
State exposes no unit before completion succeeds and prepares each separately
retained participant once. Cancellation invalidates use immediately while cleanup
joins entered completion, late acquisitions and unexpected asynchronous final
assertions. Before entering callbacks, Work captures the original receiver of
`context.joinAccepted`. A non-void assertion result is registered there before
Work refuses it, while also remaining in Work's local release join. State holds
the actual transaction and dependent participants until that entered continuation
settles; waiting only during reverse participant release would be too late.
Registration during a synchronous fence poisons currentness and grants no query,
unit, reentry or use permission. Release publishes one join and does not discard
those promises.

Historical completion instead uses the independently retained observation lease.
It neither acquires current Work policy nor requires the old live native use to
remain open. `observationCall` supplies its original bounded cleanup call; the
adapter does not renew the cancelled repository call or manufacture a context.
Observation can append qualified history, but cannot authorize new live use.

## Transaction sequence

1. Acquire the original selection and validate its complete Work/native/request
   correspondence. Before opening an initial admission transaction, compare the
   complete candidate Work record with the original selection data: scope,
   Work and revisions, parent/root, state, horizon, execution and policy. Then
   commit its independently authorized admission in a separate transaction.
   Existing Work keeps its original admission. Each transaction completes its
   actual policy phase after custody and parent locks, before reading or writing
   Work through its unit; detached candidate comparison is not that completion.
2. Read the complete locked Work lineage and stage a distinct preparation with
   exact Work revision, request, receiver, session, DNS and repository target.
   Only an acknowledged transaction returns the private preparation object.
3. After external waits, reacquire current policy and the same State readset.
   A changed ancestor, withdrawal, execution, policy or fixed target refuses.
4. Dispatch records business dispatch and credential-release responsibility in
   the same original transaction. The custody participant validates its original
   material through the borrowed inventory. Work receives no credential bytes.
5. Capture the actual State committed witness, then recognize its exact private
   preparation, token and original receiver/session objects. A recovered row or a
   copied witness cannot supply a release.

The opaque preparation is local membership, not an authorization replacement.
Data comparison complements original policy and transaction recognition. It does
not admit a Work, authenticate a caller or grant repository access by itself.

## Fresh committed use and settlement

State's `acquireCommittedRelease` starts a new bounded transaction using its
retained original operation. The adapter recognizes that exact operation after
the earlier adapter call has returned; it does not rely on a transient asynchronous
context to manufacture membership. The returned State lease holds the fresh
readset through the fixed custody writer's immediate currentness/decrypt/write
sequence and joins the original transaction when released.
Its newly acquired Work source completes the same policy phase again under the
fresh transaction's locks. Earlier successful completion is never carried into
this reentry as current authority.

Beginning settlement closes new live acquisitions before any cleanup wait.
Historical recovery and outcome append use independently authenticated observation
authority. They remain distinct from open-Work eligibility and can retain evidence
after Work or native closure. Unknown acknowledgment cannot mint a new release,
become proof of noncommit, or authorize a dispatch retry. Original State and
inventory histories retain their durable responsibilities after local handle
release.

The adapter publishes one settlement join. It transfers participant cleanup before
reading later members, joins late acquisitions through the State owner and retains
unexpected asynchronous final assertions before refusing them. Releasing a
transaction participant does not destroy the separately owned native Session.

## Inventory issuance and independent cleanup

[Inventory issuance and cleanup](repository-work-state-v2/inventory.md#inventory-issuance-and-independent-cleanup) defines exact permissions, phase-operation custody, known mint and revocation claims, held provider-use transactions and independent postclosure observation. These requirements apply to both V2 and explicit V3; recovered operations never grant a new provider submission.

## Validation scope

The focused adapter suite is designed to execute this adapter together with the actual State
binding, query repository and transaction phase. Its outer SQL transport and
policy/native/custody peers are explicitly controlled protocol fixtures. Those
tests exercise private recognition, phase separation, late cleanup, currentness,
unknown outcomes and postclosure observation. They do not establish PostgreSQL
durability, a production policy admission, protected token persistence, native
identity, live GitHub access or a complete composed repository flow.

Phase cases use the original State policy repository and private
`acquireCurrentPolicy` participant over a controlled SQL transport. They cover
custody/parent-lock ordering, pre-completion refusal, late policy changes,
abort/timeout joining, cleanup ownership before member access, separate historical
completion and fresh committed-use reentry. Delayed-assertion cases fault native,
policy, issue and historical peers with entered promises at acquisition,
completion and later fences. The actual State context registers those promises
with an explicitly controlled outer transaction drain. Cases require refusal
without early transaction retirement or dependent release, for both resolution
and rejection. They are component tests; the controlled outer drain is not
evidence of PostgreSQL transaction cleanup. A supplied SQL envelope is a controlled
peer input, not a production policy writer or a PostgreSQL durability result.

Production construction requires the real assignment and admin-managed repository
policy source, original State database, protected custody and accepting native
service. The service assembly must supply them; this module supplies no default
policy, invented root Work or arbitrary confidential sink.

The adapter captures the original `selection.prepareStateUse(selection, origin,
call)` and native `assertNativeCurrent(origin, call)` methods once. Live adapter
runs await retirement of the initial assignment SQL readset before opening their
State transaction. Native-only authentication spans this gap. No current State
authority exists until `prepareUse` retains the original policy and same-unit
readset through the State selector. Completed source fences require full original
native+State currentness; pre-completion fences use only native membership.

The initial native binding is retained as comparison data, and later selection
inspection cannot replace original operation objects. Work does not call native
`inspect` between units or reopen the old readset. Fresh committed-use acquisition
initiated by the original State witness enrolls its own selection handoff during
source acquisition, with no initial readset still held. Its completion and cleanup
remain owned by that State acquisition. Historical observation performs neither
live handoff nor current policy acquisition. Missing genuine methods refuse; no
full-currentness fallback, new SQL owner or callback-created authority is supplied.

The original State selector must recognize inventory phase originals and each
historical recovery operation it accepts. The native custody recognizer and fixed
writer must also use the actual held phase appropriate to their operation. This
adapter does not broaden those suppliers' private membership or infer authority
from a known commit or a copied operation. Production assembly must bind those
original participants; component protocol peers do not prove that construction.

## Stable native identity and the broker wire binding

Selection `sessionRef` is the original `github-native/<connectionId>` diagnostic
from the constructor-held native Session. Preparation and dispatch both store
that stable value, and custody pairs the original native service-source receiver
object with the original private Session. The diagnostic is comparison data; it
cannot authenticate either object.

The broker chooses its independent 32-hex wire nonce only after preparation.
The adapter captures the actual `DispatchRead` separately, validates its nonce
shape and compares its effect to the recorded preparation operation. It stores
neither the nonce as native identity nor the dispatch original as wire effect.
`readPreparationOriginal` returns the recorded data only for an active private P.
Original native preparation must authenticate the complete wire exchange; the
adapter never predicts a future nonce or creates a replacement exchange.

## Versioned Git selection and persistence

`RepositoryWorkStateAdapterV2<B, 3>` requires explicit construction with
`{ protocolVersion: 3 }`, following the transaction-duration operand. The owner,
original native source, selection source and broker must use that same literal
version. The default remains V2. A crossed incoming protocol refuses before
selection acquisition.

`RepositoryWorkSelectionDataV2<3>.current` supplies the Git policy arm and exact
`repositoryRequest: WorkRepositoryGitReadV3`. `prepare` retains actual original
phase objects separately from detached data and asks the original State owner to
persist that descriptor with its preparation. `commitDispatch` stages the same
descriptor with the distinct dispatch original. The State preparation/dispatch
codec and its fresh committed-use validation must retain and compare the field;
dropping it cannot qualify a V3 persisted request. V2 records omit it.

State owns authentic assignment, initial Work admission, policy selection and
JSON persistence. The adapter cannot fill a missing original source from request
fields, permission strings or reconstructed operation objects. The existing
same-unit inventory, known mint/cleanup claims, independent observer call and
submitted-use settlement requirements apply unchanged to both protocol arms.

## Native enrollment before State use

The adapter captures mandatory native.inspectNative with its original receiver.
Preparation preserves initial full inspection and enrolls the native RPC before
selection acquisition. Direct current/dispatch calls, live inventory entry and
fresh committed-use source acquisition also await enrollment before their first
cutoff-dependent native fence. Internal same-call entries cannot extend the
original Runtime cutoff. Each response is detached and compared with retained
context/transport/attachment/receiver/execution/service. The original call object
is passed through and all five fields must remain unchanged.

Enrollment performs no SQL acquisition. Initial readset retirement still precedes
Work's transaction; full native-plus-State currentness starts only after prepareUse
owns the same-unit readset and policy. State source acquisition registers entered
enrollment with original joinAccepted after retaining its source lease.
Settlement invalidates further use immediately and joins pending native enrollment
before releasing selection. Live inventory retains its independent drain.
Historical recovery/outcome/revocation use their original observer after closure.

These consumer guarantees still require genuine Runtime authentication, State
operation enrollment and protected provider custody. Comparison data and controlled
test peers supply none of those production authorities.
