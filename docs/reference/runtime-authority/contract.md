# Runtime assignment storage

`runtimeAssignments` and `runtimeAuthority` retain the intent, allocation and
initial provider binding of an Agent execution inside `PlatformStateStore`
callbacks. Both memory and PostgreSQL implement the repositories.

The current controller does not produce or consume these records. This storage
component must land together with an owning Agent/Token workflow that uses it.
The records alone do not activate a runtime or grant access.

## Intent and allocation

An Agent retains its Agent-owned `servicePrincipalId`. An allocation copies that
stable subject together with the exact Installation, Namespace, Agent, revision,
component and profile references. Each execution receives a new `assignmentRef`
and component `runtimeGeneration`. Its `createEffectRef` identifies the original
create operation before any provider effect starts.

Intent initialization begins at generation one. Advancement and allocation use
expected-generation comparisons. Allocation requires the current running intent.
Gateway and harness allocations remain distinct. An exact create-effect replay
returns its original allocation even after the intent stops; changed owner,
generation, component or profiles conflict.

The state owner resolves the Installation, Agent principal and revision owner.
PostgreSQL foreign keys retain their relationship to the immutable intent.
Foreign owner locators return no record. Physical owner deletion cannot cascade
through retained history.

## Initial gVisor binding

An initial harness binding retains the exact Pod, deployment, replica set, runsc
sandbox, runtime instance and restart discriminator. It also retains the admitted
configuration, images, policy and provider/runtime/identity profile digests.
`expectedBindingVersion` must be null. Once bound, a new operation cannot refresh
or replace the instance; exact replay returns the original receipt.

The observation records the source time, receipt time, finite validity window,
owner-chain reference and create-effect correlation. Parsing checks supplied
values and their relationships. It does not authenticate the observation or
establish current runtime eligibility.

## Validation, replay and transaction outcomes

The curated `@openclaw-enterprise/contracts` entry point exports the versioned
types, parsers and canonical mutation encoder. The object parser produces
immutable snapshots of closed data. The raw JSON parser additionally rejects
duplicate keys and ambiguous numeric literals before ordinary JSON decoding
loses those distinctions. Errors identify a failed rule without echoing values.

Each accepted binding appends an immutable receipt. Replay first compares the
operation identity, full canonical payload and accepted service identity before
checking current intent or versions. Only request correlation may change. A
replay creates no effect and does not prove present authority.

An authority mutation failure rejects the enclosing transaction even when its
callback catches the error. Binding and receipt writes share the platform
transaction. Read views expose no mutations. See
[platform repositories](../platform-repositories.md).

Trusted core code can call `runAuthorityParticipantIn(originalUow, consume)` on
the State owner to enroll a complete authority consume callback in that same
transaction. State accepts only its exact live unit-of-work object. Enrollment
and callback invocation are synchronous, so one-use evidence can be spent before
the first await. Whole callbacks run concurrently; individual authority mutations
retain their original serialized order. The ordinary `runtimeAuthority.appendMutation`
binding also uses this participant lifetime.

When the outer transaction callback settles, State closes fresh admissions and
drains accepted callbacks and their repository work before COMMIT, rollback, or
connection release. An accepted callback can continue original reads and nested
mutations while draining. Each callback and child operation loses admission when
its own Promise settles; a detached sibling cannot use an inherited context to
start fresh work after its callback closes. New top-level participants cannot
enroll during drain.

State observes the original native Promise returned by each callback before
normalizing its result. This includes Promise subclasses and Promises from
other JavaScript realms, whether pending or already settled. Read and queue
projections preserve that original callback boundary. A native settlement
observer closes admission before reactions attached earlier by the callback.

The shared observer stays active from module import through process exit, with
weak Promise keys and a private stop handle. Stopping it between transactions
would lose settlement history for deferred Promises created between owners;
overlapping State owners therefore share uninterrupted observation. A Promise
created before the module was imported has no observed creation history: State
conservatively closes its callback's fresh admission on return while still
delivering its result and draining accepted children. Arbitrary thenables and
Promise proxies are outside the declared native Promise callback contract and
receive the same conservative closure. The observer's process-wide cost still
needs qualification in an installed workload; component tests do not establish
application throughput.

An accepted authority callback failure, or a nested repository/query failure,
remains sticky even if caught or unawaited. State preserves the first authority
failure and rolls back the transaction after draining accepted work. Ordinary
caught repository conflicts outside authority callbacks keep their existing
behavior.

This lifetime mechanism does not supply a ROOT/current-entitlement snapshot,
Installation policy fence, IAM decision, or provider authorization. Those owning
components must retain their original transaction and supply their checks.

Lost PostgreSQL COMMIT acknowledgments retain
`PostgresCommitOutcomeUnknownError`. Read the exact original operation identity
before retrying an effect. Missing or unavailable readback does not prove the
transaction failed and cannot justify a replacement operation identity.

## Original credential State participant

Trusted credential consumers import `OriginalCredentialStateBinderV1`,
`OriginalCredentialUnitV1`, `KnownCredentialCommitV1`, `CredentialCommitOutcomeV1`
and the original `PlatformUnitOfWork` from
`@openclaw-enterprise/occ/internal/credential-state-v1`. The concrete
`PostgresPlatformState` implements the binder separately from its storage operand.

`bindCredentialUnitIn(uow)` accepts only that State's exact live mutable unit.
It refuses copied, foreign, read-only and settled units. The borrowed unit exposes
its original `uow`, synchronous participant enrollment through `run(work)`, and
`query(statement, parameters)`. Both operations share the original failure latch,
callback closure and accepted-work drain. The unit exposes no client, lifetime
finishing operation or guard reset. Queries accept one SELECT, INSERT, UPDATE,
DELETE, WITH or LOCK statement, with an optional trailing semicolon and comments.
Transaction/session commands and additional statements are refused. Ambiguous
backslash escapes in ordinary string literals are refused; use parameters or
explicit PostgreSQL escape strings.

`recognizeCredentialCommit(unit)` refuses active transactions immediately. After
the exact original transaction settles, it recognizes that transaction once.
Only an acknowledged outer COMMIT after successful guard/drain and clean connection
release and listener cleanup returns `committed` with the original nominal evidence.
Callback completion, staged writes and allocated references cannot establish it.
A definite rollback returns `not-committed`. Lost acknowledgment or uncertainty
after COMMIT returns `unknown` with `nextAction: "reconcile-only"`, including when
exact durable readback confirms the writes. Readback cannot recreate a process-local
submission permit. Foreign owners and copied units cannot recognize an outcome.

This evidence is the State boundary. The original issuance owner must separately
match retained inventory and envelope identities before producing issuance evidence
or usable material. These contract and compiler consumers do not install admission,
inventory/retention, Work/IAM, gateway runtime or provider authorization.

[Storage verification](../../testing/runtime-assignment.md) covers persistence,
constraints and transport uncertainty. The owning workflow must separately
supply authenticated service attribution, protected observations and authorized
admission.
