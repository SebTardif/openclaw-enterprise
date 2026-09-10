# Inactive Work authority ports V2

`packages/occ/src/lifecycle/work-authority-ports-v2.ts` declares the first callable
Work interface. It has no runtime exports, implementation, registration or package
export. Its types describe inputs and outcomes for the original authority,
transaction, journal and identity owners. Importing the module creates no Work,
transaction, issuer, feed, claim, credential, native process or sender.

The declarations preserve the original service-work semantic agreement and its
receiver-activation and late-observation successor. Actual implementation and exact
private type bindings remain with the original suppliers. Type compatibility does
not authenticate a participant or prove that an operation committed.

## Identity, invocation and execution

Logical Work, invocation, original operation, delivery, inert candidate and release
have distinct nominal data types. These brands supply compile-time distinctions;
they are neither parsers nor authority. Work does not reuse a controller queue ID,
claim token, reservation, lifecycle operation or journal attempt as its identity.

`WorkScopeV2` retains the existing Installation/Namespace/Agent key and the exact
Agent revision. A lineage projection contains the original root, immediate parent,
ordered ancestors, own version and immutable horizons. The original transaction
owner must resolve completeness, scope, acyclicity, membership and the accepted
finite depth/fanout profile under its locks. An array or a type assertion cannot
establish any of those facts. No cross-Agent ancestry policy is selected here.

The owner is the existing canonical `ServicePrincipal`, independently resolved for
that Agent/revision. It is distinct from the invoking human, ServiceAccount and
execution identity. `work.invoke` requires the original authenticated human/native
event and current invocation rights. Service admission separately requires current
service IAM and explicit `service-work-responsibility` over the exact scope,
purpose and ceiling. An earlier invocation decision is attribution, not continuing
service authority. Attached-child initiation needs its own original accepted
supplier mapping; these declarations do not synthesize another human event.

A nonexecuting Work explicitly has no attempt. An actual execution association
contains the complete existing `ExactAttemptV1`, assignment/version, execution
incarnation/generation, receiver, protected-origin reference, execution profile and
original predecessor termination association. The original Runtime and journal
owners authenticate these facts. Recording an association cannot start an attempt,
restore a claimant or authorize a second reservation.

The previously integrated `WorkOwnerValueV2` and `WorkInvocationValueV2` remain
unchanged. They currently lack a contracts package export. `WorkDiagnosticBindingsV2`
therefore leaves their binding explicit and defaults both slots to `never`. The
original contracts owner must allocate the exact additive export before ordinary
package consumers bind those existing types. This module does not duplicate their
schema or import another package through a private relative path.

## Original transaction custody

| Declaration                                      | Original responsibility                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `WorkInvocationComparisonPortV2.consume`         | Retain the authentic invocation and current comparison in the original unit.                                              |
| `WorkServicePolicyPortV2.acquireWorkPolicyV2`    | Hold independently current service/data/purpose/ceiling policy for the original operation.                                |
| `WorkAdmissionPortV2.readForMutation`            | Resolve and privately retain the complete original Work/ancestry/operation expectation.                                   |
| `stageAdmissionV2`                               | Stage the root association with held invocation, policy and readset.                                                      |
| `stageChildAdmissionV2`                          | Stage an attached child through current parent/lineage and service policy without replaying human invocation.             |
| `stageAttemptAssociationV2`                      | Stage the full existing journal attempt and original assignment association.                                              |
| `recoverAfterUnwind`                             | Recover the original admission candidate through a fresh authorized exact historical read after complete unwind.          |
| `recoverAttemptAssociationAfterUnwind`           | Recover the full original execution association using its distinct original recovery operand and a fresh authorized read. |
| `WorkGeneralLifecyclePortV2.stageSealAndCloseV2` | Stage a general Work closure against the original unit, readset and closure/join/effect-cut evidence.                     |
| `WorkGeneralLifecyclePortV2.stageWithdrawalV2`   | Stage general Work withdrawal with the original readset and current protected withdrawal comparison.                      |

`WorkPrivateBindingsV2` requires the original implementation's private operand
types. Every unbound slot defaults to `never`; the module exports no way to create
one. A consuming implementation still must recognize actual private ownership at
runtime. `TurnCommandOwnedUnitV1` is the existing Central token; it is not the
journal's outward `PlatformUnitOfWork`, a database connection or an initiation
claimant. The original owner must join these identities without conflating them.

Keep account/security acquisition, the existing six-table IAM barrier,
Installation journal advisory lock, channel/Namespace/Agent locks and reload,
then the original issuer/root/ancestor/Work locks. Accepted child operations,
including caught or unawaited failures, participate in original poison and drain.
The original terminal owner retains participant preparation/currentness through
the final fence, actual COMMIT acknowledgement and joined terminal cleanup.
Consumers cannot release a participant early. No public SQL capability, nested
transaction or external provider call is added.

Staging is provisional. `existing` and committed history grant no initiation.
`WorkCommitResultV2` is a successor outcome family; it does not modify
`JournalCommitResultV1`. Recovery retains the original actor, operation digest,
scope, full lineage, attempt association and expected result. Confirmed commit,
definitive noncommit and unconfirmed are distinct. Unavailability is not absence;
even definitive noncommit does not override original locator/submission rules.
No recovery branch returns a replacement grant, retry callback or journal claim.

Admission recovery remains fixed to `WorkAdmissionCandidateV2`. Attempt-association
recovery is a separate method fixed to `WorkExecutionAssociationV2`, including the
full existing `ExactAttemptV1` and original assignment/execution association. Its
`attemptAssociationRecovery` private slot is distinct from admission's
`originalRecovery` and defaults to `never`. Neither method accepts a caller-selected
result type. Issue activation and delivery submission keep their own original
recovery families on their respective ports; a shared property spelling does not
make their private operands interchangeable. The original supplier binds each
family to its genuine operation-specific type and recognizer.

## General Work closure and withdrawal

`WorkGeneralLifecyclePortV2` separates general Work operations from the existing
compound finite-delivery operations:

- `stageSealAndCloseV2(originalUnit, readSet, exactGeneralWorkClosure)` returns
  general `WorkGeneralClosureV2` provisional/existing data or a closed refusal.
- `stageWithdrawalV2(originalUnit, readSet, withdrawalComparison,
exactGeneralWorkWithdrawal)` returns general `WorkGeneralWithdrawalV2`
  provisional/existing data or a closed refusal.

Both records retain `WorkOriginalOperationV2`, its exact Agent/revision scope and
the exact versioned logical Work. Closure additionally retains the original closed
outcome/reference, required-join profile revision, effect-resolution cut and
protected closure-evidence reference. The original owner compares these operands
against the same privately held operation/lineage readset. A reference does not
prove that children joined, effects resolved or protected evidence exists. An
empty required set is meaningful only if the original accepted policy and held
readset establish it. Missing or incompatible evidence cannot produce a positive
stage result. No universal same-Agent or all-children-required policy is selected.

Failed, cancelled and completed non-delivery Work can express general closure
without a `deliveryRef`, `CompletionRecordV1`, attempt, output or result slot.
General closure is not an alias for the successful finite-delivery computation
seal. Its `work-closure` discriminator identifies a data record; it does not add a
service authorization operation or extend Central's private operation recognizer.

General withdrawal separately retains the original scope reference, expected
withdrawal revision, explicit protected cause and cause-evidence reference. The
Work revision and withdrawal revision are distinct domains. The original current
withdrawal comparison stays held through the original transaction fence. A later
withdrawal does not replace a historical completed closure. Its `work-withdrawal`
discriminator keeps the general request distinct from finite-delivery withdrawal.
The existing finite compound methods and their original records remain unchanged.

General staging returns the corresponding general record with the original private
staged receipt. It is provisional, and neither a data reference nor an `existing`
result supplies COMMIT acknowledgement, effect authority or a new claim. Actual
private lock-domain, operation recognition, token, readset, receipt and persistence
extensions remain the original Central/journal owners' implementation work.

## Issue reservation and receiver activation

`WorkIssuePortV2` expresses the original suppliers' agreed two-transaction protocol:

1. Under the original policy and complete held closure readset, transaction A
   stages the exact inert candidate, immutable bounds, potential exposure, audit
   and outbox. Reservation COMMIT does not activate authority.
2. The original transport delivers/installs that candidate for its authenticated
   receiver outside A. Installed-candidate custody comes from the original receiver;
   an echoed reference, digest or `installed` flag cannot supply it.
3. `activateIssueV2` enters transaction B under the same closure-conflicting locks.
   It checks fresh policy for the original issue/renew intent, original issuer and
   receiver incarnation, full target/profile revisions and remaining bounds.
   Admission cannot be relabelled as activation. Changed candidate constraints are
   not silently rewritten; unresolved revision mismatch suppresses activation.
4. Confirmed activation COMMIT atomically records immutable release identity,
   candidate digest, issued exposure, audit and outbox. Physical transmission and
   local acceptance are separate. Closure-first suppresses; activation-first
   retains withdrawal responsibility for even possibly-unreceived exposure.
5. Unknown activation preserves the original recovery identity. Complete unwind
   precedes fresh exact authorized history. Readback cannot remint, reactivate,
   resend under a reconstructed permit or reset the original deadline.

Each own and applicable ancestor constraint carries Work/version, original
horizon, target identity/revision, profile identity/revision, anchor contract,
target duration, clock allowance and enforcement allowance. An external-change
anchor additionally needs its genuine observation-delay contract. The complete
set also carries selected class maximum and original purpose/call/stop bounds.
Missing, incomplete, expired or unsatisfiable inputs deny. Targets remain distinct
from horizons. Fresh child renewal requires current logical ancestry, not a live
parent process or unexpired parent execution lease.

No numeric withdrawal target or zero uncertainty is selected. Tightening a profile
does not shorten historical exposure retroactively. Issuer/feed appointment,
private activation participant, cursor/genesis/epoch-restore representation,
authentic time/receiver providers and the final atomic restriction-versus-dispatch
gate remain original-owner implementation dependencies. No feed API or cursor
encoding is invented by this slice.

## Finite delivery and late observation

`WorkFiniteDeliveryPortV2` declares original admission, seal, history read and
withdrawal responsibilities. Admission retains a result slot, exact destination,
audience, cancellation scope and immutable absolute delivery horizon before or
atomically with closure. The relation between delivery and computation horizons is
an explicit service-policy input. Seal binds the complete original completion,
required-join revision, effect-resolution cut and immutable output digest once.
The current head cannot replace the original completion.

`WorkDeliveryStateV2` keeps four independent facts: result readiness, historical
closure, present posting eligibility and complete original submission history.
Completed/withdrawn/expired delivery can retain an unknown original submission.
Later observations append beside the initial outcome. A null receipt cannot stand
in for the complete unsubmitted/pending/attempt history.

Both the original admitted delivery horizon and V1's original 120-second sending
episode apply. Preserve three CREATE attempts and the narrow positively-known-ID
update rule. Completion, restart and retry cannot reset either clock. Only an
original recorded definitive-no-effect/transient outcome can contribute to a
retry decision, within every original bound and current authority; this module
provides no retry decision or sender. A real send-only sink and private one-use
delivery claimant signature remain unbound; no reserve-and-initiate callback is
invented. Computational initiation claims are never delivery claims.

`work.delivery.observe` has separate currently scoped service observation rights:
exact Agent read and explicit `service-delivery-observation-responsibility` for the
original Work/delivery/operation/attempt/provider and append/audit action. The
original evidence owner authenticates the provider evidence and immutable
destination. The original journal retains the current observation comparison
through append/audit COMMIT. Exact duplicates may be existing; contradictory or
foreign evidence conflicts. Inconclusive evidence leaves knowledge unknown.

Observation may append after closure, expiry or withdrawal with a fresh bounded
observation call. It does not require open Work, posting permission or an unexpired
original sending lease. Observation rights themselves remain revocable. Append
confers no provider query, credential use, posting, retry, renewal, audience
fallback, claimant transfer or reopened eligibility. V1 delivery remains unchanged.

## Source and acceptance limits

The direct conformance file uses the actual TypeScript compiler, actual declarations
and actual imported contracts for positive and negative structural cases. General
Work cases include closure without delivery operands, required original cuts and
protected references, independent withdrawal, and fixed attempt-recovery results.
Synthetic per-slot string markers test generic declaration mapping only; they are
not independently authored producer types or authenticated supplier acceptance.
The in-memory fixtures create no authority objects or product state. A separate import
case checks that the leaf exposes no runtime implementation. These checks do not
prove authenticated suppliers, locking, persistence, races, parser validation,
delivery behavior, native termination or provider integration.

The declaration brands do not validate wire data. Original accepting parsers must
retain the accepted bounded closed-JSON rules and exact existing ID grammars.
Absolute times need canonical four-digit-year UTC Timestamp validation and the
finite millisecond range 0 through 253402300799999, checked conversions and no
coercion, overflow or negative zero. Semantic cardinality profiles remain separate
from parser limits. No decoder or authentic clock is supplied here.

Original semantic/IDN producer and consumer examples are independently authored
private supplier inputs. They remain unexecuted and are not recast as this author's
positive fixtures. Original Central and journal suppliers accepted the earlier
emitted admission/readset placement, grouped issue operands and finite-delivery
signatures, and requested these separate general Work and attempt-recovery
extensions. The new exact records and declarations await their affected review;
that review does not install private producer types. Exact generic bindings, the
diagnostic package export, original sender claim/sink, audit origin and issuer/feed
implementations still require their owning extensions. This slice
changes none of those owners' source, package exports, database schema or runtime
wiring. It selects no PR-first policy, aggregate baseline authority, worker-wide
cancellation policy or additional product default.
