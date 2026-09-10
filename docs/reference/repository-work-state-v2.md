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

`retainPolicy` borrows actual current policy under the original State context.
`retainObservation` supplies the separate historical observer under that context.
Both leases have synchronous currentness, asynchronous preparation and joined
release. State prepares each retained participant once. `observationCall` must
return the original bounded cleanup call; the adapter does not renew the cancelled
repository call or manufacture a replacement context.

## Transaction sequence

1. Acquire the original selection and validate its complete Work/native/request
   correspondence. Before opening an initial admission transaction, compare the
   complete candidate Work record with that policy-qualified selection: scope,
   Work and revisions, parent/root, state, horizon, execution and policy. Then
   commit its independently authorized admission in a separate transaction. Existing Work keeps its original admission.
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

The fixed protected custody producer receives `adapter.inventory`. It acquires a
private inventory responsibility from the actual preparation and native origin.
`selection.acquireInventory` must supply the original State-owned reservation,
phase-operation selection, separate token-issue lease, and independently retained
observer. Omission refuses inventory issuance; a repository-use policy alone does
not authorize token issuance. Reservation fixes the complete Work/execution,
repository target, credential binding, permission profile, requested permissions,
and original horizon. V2 requires exactly `{ metadata: "read" }`; explicit V3
requires exactly `{ contents: "read", metadata: "read" }`. Inventory permission
objects are compared by exact keys and values, independently of the ordered
Work policy tuple. Neither arm grants an extra provider permission.

`transition` accepts the closed V2 reserve, mint-claim, mint-result, retirement,
resolution, cleanup-claim and cleanup-result mutations. It obtains original phase
operations from the construction-captured State selection and retains their exact
object identities. The original business request digest and the inventory
mutation digest remain separate. Operation references cannot be rebound, reused
for another purpose, or borrowed from business dispatch. Each responsibility
retains at most 128 distinct phase operations; exceeding that implementation
bound refuses further enrollment and preserves the retained history.

Reserve and claim use the actual State readset and hold both current Work policy
and original token-issue authority. Every mutation passes both Work and custody
qualifiers in that same State unit. Only a staged claim followed by acknowledged
outer COMMIT and private State recognition returns a private mint claim.
`existing` is reconciliation-only. Unknown COMMIT or a recovered operation cannot
create a mint claim, retry the provider, or prove noncommit.

`acquireMint` consumes that original claim once and enters State's fresh held
mint-use transaction. Custody keeps the returned lease through awaited key and
signing work, calls `beginSubmittedUse` immediately before the one provider
submission, and uses `assertCurrent` for subsequent permission checks. The
provider's bounded outward result may precede actual completion. Custody must
join its original `settleAttempt` before releasing the held mint lease.

Late result/revocation and exact operation recovery use the inventory observer's
own bounded call. They survive old Work/native closure, but cannot authorize new
issuance. Work settlement closes live admission while the inventory responsibility
retains its separate operation membership and source lifetime. `release` joins
entered operations and mint-use leases before releasing that observer and the
selection. It does not clear durable inventory holds or invent provider evidence.

The current operation owner calls `custody.prepareToken` during dispatch, after
State has returned P. No mint occurs before P in this implementation. Moving mint
into preparation requires an explicit original lifecycle composition; the opaque
P must not be fabricated to reach these inventory methods early.

An acknowledged, newly staged `claimRepositoryRevocation` returns a separate
private `cleanupClaim`. `acquireRevocation(I, cleanupClaim)` obtains the original
inventory observer call internally and asks State for its fresh cleanup-use lease.
It returns that exact bounded call with the held operation, currentness checks,
one-submission latch and joined release. The protected provider uses those original
bounds for DELETE; it must not create a replacement deadline or reuse the closed
user call. State and both original participants check the same current cleanup
claim, token/revocation references and attempt without requiring open Work.
The inventory responsibility remains held until the provider's original
`settleAttempt` and the returned cleanup lease have joined. Recovery and replay
never create a cleanup claim. Data-only operation results do not authorize DELETE.

## Validation scope

The focused adapter suite executes this adapter together with the actual State
binding, query repository and transaction phase. Its outer SQL transport and
policy/native/custody peers are explicitly controlled protocol fixtures. Those
tests exercise private recognition, phase separation, late cleanup, currentness,
unknown outcomes and postclosure observation. They do not establish PostgreSQL
durability, a production policy admission, protected token persistence, native
identity, live GitHub access or a complete composed repository flow.

Production construction requires the real assignment and admin-managed repository
policy source, original State database, protected custody and accepting native
service. The service assembly must supply them; this module supplies no default
policy, invented root Work or arbitrary confidential sink.

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
