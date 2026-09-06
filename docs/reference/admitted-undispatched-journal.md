# Admitted attempts before dispatch

An accepted turn owns its canonical attempt and whole-Agent reservation before
dispatch authority necessarily exists. The journal must represent that ownership
in `findAttempt`, outcome and cancellation-related reads. It cannot return absent
because dispatch metadata has not arrived or fabricate a future authority decision.

## Common binding and closed record phase

`JournalCommonAttemptBindingV1` contains exactly four immutable admission facts:
`attempt`, `identity`, `reservation` and `expectedHead`. The closed
`AdmittedUndispatchedAttemptRecordV1` carries this binding, its record version,
`phase: "admitted-undispatched"`, null consumption and one of:

- `accepted-undispatched`;
- `failed`, `interrupted`, `outcome-unknown` or `cancelled`, each explicitly at
  `stage: "before-dispatch"` with the actual owner's retained evidence reference.

No dispatch operation, dispatch authority or expiry belongs to that common
binding. Admission decision IDs, RPC request IDs, call deadlines and admission
timeouts are not substitutes. This phase cannot contain dispatch intent,
consumption, running, completion or a later-stage outcome.

`AttemptRecordV1` is the single canonical union of this phase and the retained
`DispatchBoundAttemptRecordV1`. The latter preserves the existing closed wire
shape with complete `JournalAttemptBindingV1`: common fields plus genuine
`dispatchOperationRef`, `authorityDecisionRef` and `expiresAt`. These dispatch
fields are mandatory together. An actual early authorization may precede intent;
it is never a prerequisite for constructing the admitted common phase.

The existing codec registry owns `commonAttemptBinding`, `attemptBinding` and
`attempt`; the existing result codecs use the same union. `dispatchIntent` results
specifically require the full dispatch-bound record: `recorded` carries the new
intent, while `existing` carries retained intent or later dispatch/consumed
progress. Accepted or before-dispatch outcomes cannot prove existing intent even
with genuine early authority. No parallel phase registry,
optional-everywhere authority fields or serializable provenance constructor exists.

## Versioned transitions and retained ownership

`journalDispatchIntentMatchesV1` compares an exact one-version common-to-intent
transition, preserving the original tuple, attribution, reservation and expected
head. Intent must match the binding's actual dispatch operation. An already
full-bound record must preserve its full binding. The accepting owner still
authenticates current dispatch provenance and serializes intent with cancellation;
the pure comparison is not dispatch permission.

`journalOutcomeTransitionAllowedV1` permits before-dispatch outcomes on the common
phase and preserves its uncertainty. A before-dispatch unknown may be resolved by
new exact trusted before-dispatch evidence; it cannot become a dispatch-stage
outcome or borrow execution evidence even with genuine early authorization.
Execution/checkpoint failure, interruption, uncertainty and cancellation records
retain their immutable consumption evidence. Completed and known terminal
outcomes do not regress.

`journalCancellationBeforeDispatchMatchesV1` compares original attempt, principal,
version and no-intent/no-consumption state. The actual owner must additionally
verify current cancellation authority and locked canonical facts. The stored
cancellation result and follow-up attempt read retain the original reservation.
They do not prove physical termination, close unknown creates/restores, discharge
the writer inventory or release the reservation.

`journalReleaseMatchesV1` works with either canonical record branch. It still
requires exact original attempt/version, reservation and workspace plus the full
closed no-mutator observation. Its true result checks correlation only. Release
requires actual trusted no-mutator evidence, complete unresolved-owner coverage
and the accepting journal's current checks. A successful reply, cancellation,
deadline or expired lease does not substitute for those facts.

## Commit uncertainty and the independent consumer

The status/cancel fixture compiles against the actual exported declarations. It
constructs a common value from the four admission facts, decodes found ownership,
invokes cancellation with the original transaction and real owner-supplied opaque
input, and reports results after the outer transaction settles. Unknown commit
uses only fresh exact cancellation/attempt reads. The consumer never retries the
mutation, creates an initiation permit, reports termination or calls release.

Absent, denied or unavailable readback remains unresolved for previously known
ownership. A cancelled-before-dispatch reply exposes only the common binding and
explicitly leaves termination and release unverified. A different transaction,
attempt, principal, version or reservation cannot be borrowed for that reply.

The original `consumeAndInitiate` boundary remains the sole initiation path.
Unknown commit and already-consumed readback cannot obtain a new callback or
fresh initiation permission. Persisted original dispatch/deadline, restart,
interruption and genuine termination integration remain accepting-implementation
obligations.

The conformance vectors are definition/codec and synthetic consumer evidence.
They do not establish database concurrency, real authority, native execution,
physical stop or deployment-level reservation release.
