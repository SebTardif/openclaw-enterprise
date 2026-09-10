# Repository Work operation owner

`RepositoryWorkOperationOwnerV2` implements the broker's
`GitHubMediationOperationOwner<P, R, V>` interface. It owns preparation and release
identity, repository-use comparisons, one-use dispatch and joined cleanup.
Its constructor requires actual original native, State and protected-custody
sources. The module installs no default source, grant, database or token store.

The default V2 profile is the closed `metadata:read` operation for an
exact GitHub repository owner and name. An explicit constructor selection
`{ protocolVersion: 3 }` enables Git read V3 for discovery and upload-pack;
the incoming request cannot choose or change that selection. Token issuance is a separate operation.
It cannot substitute for current `work.repository.use` policy at preparation,
dispatch or later online checks. Git mutation and publication are separate uses.

## GitHub read release status

The [GitHub read MVP milestone](../../specs/github-read-mvp-release.md) requires
an authenticated metadata and clone/fetch flow on one explicit configuration,
with publication unavailable. That milestone is **not released**. This operation
owner remains a component: its current original admission and complete service
assembly are required before a deployment can offer that flow. Constructor
selection and controlled component tests do not establish a supported
installation or successful repository access.

## Original bindings

The owner retains the existing Work operation, versioned logical Work, complete
execution attempt, assignment version, incarnation, generation, protected origin,
receiver and execution profile. It compares the full Work scope to the execution
scope and the original native association. It also fixes the repository identity,
profile revision, request digest, attachment, DNS binding, upstream address,
service principal and original horizon.

The State projection contains the own Work plus complete ordered root-to-parent
ancestry. Withdrawal projections are ordered own first, then those ancestors.
Every member must remain open with the exact withdrawal revision and a sufficient
original horizon. The projection is bounded, detached and frozen before later
callbacks can change its source. It is data: matching JSON never authenticates a
private transaction, policy, complete ancestry or native exchange.

`RepositoryWorkPrivateBindingsV2` describes the original source-owned origin,
preparation, token and committed-receipt types. Unbound slots default to `never`.
The owner creates its own P/R objects and recognizes them through private maps;
copied, serialized, foreign-owner and previously spent handles refuse.

## Operation sequence

1. `prepare` acquires the actual native origin and original State preparation,
   compares current repository-use policy and records a fixed operation horizon.
   It transfers late-acquisition cleanup before inspecting returned data. No token
   mint or confidential write occurs here.
2. `dispatch` spends the preparation's dispatch attempt before awaiting anything.
   Token preparation runs outside the final State transaction. After that wait,
   current Work, ancestry, policy, native origin and all fixed operands are checked
   again. State must commit distinct business-dispatch and credential-exposure
   responsibility under the same locks used by closure.
3. Only the State owner's known outer COMMIT acknowledgment can supply the
   privately recognized receipt used to create R. A staged result, recovered row,
   missing response or matching commit reference cannot do so. Unknown commit
   retains the original operation through P and returns no release permission.
4. `writeRelease` consumes transmission before any asynchronous supplier access.
   It snapshots bounded nonshared bytes and compares the exact maintained broker
   `dispatch-once` metadata, including original session, effect, request, release,
   DNS/TLS and time fields. The original fixed custody writer receives those
   metadata bytes and the original committed receipt; no caller sink or token
   getter is exposed. A failed or partial write cannot be repeated.
5. `check` reacquires current original use eligibility. It cannot change any
   fixed binding or extend the operation horizon. Losing the existing online
   lease closes the preparation; a later check cannot revive it.
6. `settle` joins outstanding work and invokes original State observation/recovery
   and custody cleanup once. Business outcome is distinct from credential
   exposure. A later `not-dispatched` report does not erase a committed release;
   an unknown commit cannot be downgraded to noncommit by that report.

## Lifetime and clocks

The broker aborts each message's bounded signal when that message finishes. P
therefore retains a separately owned native session lease. Later calls preserve
the original context, transport, request and recipient while combining narrower
cancellation signals. Whole-call object identity and signal identity are not
authentication rules.

`maximumPreparations`, `maximumOperationMilliseconds`,
`maximumLeaseMilliseconds` and `clockAllowanceMilliseconds` are explicit
constructor operands. There are no numeric production defaults. The owner uses
the maintained bracketed wall/monotonic clock helpers and anchors the operation
deadline to its original sample. Clock discontinuity, cancellation and expired
bounds refuse. Final currentness must be synchronous and return `undefined`;
unexpected asynchronous work is refused and joined.

Shutdown closes admission and cancels every owned acquisition and active call
before joining any of them. Late handles and known or uncertain commits retain
their original cleanup responsibility. The source must implement bounded joined
cleanup; the owner never treats a timeout as proof that unjoined work disappeared.
Releasing Work's borrowed session lease leaves the broker's terminal metadata
reply usable. Final transport closure remains the broker/native owner's action.

## Required production construction

The original State binding is `PostgresPlatformState.repositoryWorkBindingV2()`.
Its `participant` recognizes original transaction contexts and known committed
releases; `bindOriginalSources(work, custody)` returns the one original store.
The Work adapter must use that store's `run`, complete `readForMutation`, staging
and post-unwind recovery. A separate transaction or a callback returning
`committed` does not establish the required commit boundary.

Initial Work admission, preparation of an existing Work and committed dispatch
need distinct original operation associations. An absent Work head is not an
admission grant. The current service/repository policy, complete ancestry,
protected attachment and execution association, exact DNS preparation, recorded
inventory token and retained historical observer must come from their genuine
owners. The native session source, State-held assignment source, Work policy
participant and same-unit custody participant must be paired at construction.

The component suite exercises the actual Work owner and actual broker with
explicitly controlled internal peers to test sequencing, bounds and refusals.
It does not establish original service admission, PostgreSQL locking/COMMIT,
protected token persistence, live native identity or a complete repository flow.
Those composed checks require the actual participants above. External GitHub
responses may be substituted at the external boundary during those checks.

## Preparation effect and native session identities

The State source's `readPreparationOriginal` reads the recorded preparation
operation from its exact private preparation. The Work owner binds that operation
with the complete current Work data, checks its scope/invocation/request against
the distinct business dispatch original, and returns it to the broker. The wire
`effect_ref` identifies this preparation. The State transaction and inventory keep
their separate dispatch original; neither operation is an alias for the other.

The broker creates its 32-hex `session_ref` after preparation returns. That nonce
is retained in the exact dispatch/response metadata. It is distinct from the
native Session diagnostic stored by State. The original native prepared writer
checks the full wire request, including nonce, effect, request, Work binding,
DNS/IP and certificate, against its private original exchange before disclosure.

## Explicit Git read V3

The same owner and State adapter accept a literal protocol type parameter. V2
keeps its metadata-only request and policy arm. V3 requires `git:read` and the
exact ordered permissions `contents:read`, `metadata:read`. Extra, missing,
reordered or write permissions refuse. Source types and private P/R types retain
the selected version; a V2 owner cannot occupy a V3 broker, or conversely.

V3 validates the original broker's `OpenRead<3>` declaration and semantic digest,
including Git operation, fixed `version=2` Git protocol, body byte count and body
SHA256. Discovery requires the empty body; upload-pack keeps the broker's bounded
nonempty body. The original State projection retains the exact immutable
`WorkRepositoryGitReadV3` as `repositoryRequest`. Its operation, body and digest
are compared before preparation, after awaited token work and during later use.
A different self-consistent body/digest cannot replace the prepared request.
The Work binding includes that retained descriptor. Actual body-byte verification
and native exchange recognition remain the original native producer's duties.

State persists and compares the same descriptor in preparation and dispatch.
Dispatch's wire digest and original preparation effect must agree; the broker's
later nonce remains separate from native Session identity. These additional
comparisons do not relax known-COMMIT release, one-use transmission, P lifetime,
late observation or provider settlement. Metadata V2 acquires no contents
permission even when the administrator's policy also allows Git reads.

## Native authentication across State units

Construction captures both original native methods: `assertNativeCurrent(origin,
call)` authenticates the original exchange; `assertCurrent(origin, call)` includes
State currentness. The owner captures its immutable native comparison binding
before State preparation. It does not call `inspect` again between Work units,
which would reopen an initial SQL readset. Its outer checks use the native-only
method, while the State adapter requires the full method after same-unit policy
and readset completion. A captured binding is data, not current authority; each
use still depends on genuine State, custody and native participants. No missing
method falls back to the other method, and no expired original lease is renewed
by this transfer. Historical settlement retains its separately owned observer.

## Fresh native RPC enrollment

The native construction operand requires inspectNative(origin, call) alongside
initial inspect and both synchronous currentness methods. The owner captures each
original receiver once. Initial preparation retains a detached full binding;
subsequent live RPC entry awaits original inspectNative before its first native
fence. Context, transport, attachment, receiver, execution and service must match
the retained association. A changed binding refuses instead of rebasing it.

The original native owner authenticates the fresh Exchange without acquiring
State assignments. It cannot renew an existing call cutoff or operation/lease
horizon. No full-inspect or synchronous-assert fallback exists. Same-unit State
policy/readset qualification remains separate. Entered inspection stays owned
until its actual continuation settles, including cancellation and late rejection.
Historical settlement retains its independent observer instead of live admission.

Component cases exercise original Work behavior with controlled native peers;
they do not establish Runtime transport, PostgreSQL or provider acceptance.
