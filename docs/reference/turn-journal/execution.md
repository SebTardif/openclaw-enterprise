# Journal dispatch and selected execution

Part of the [Turn journal contract](../turn-journal.md) reference.

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

Selected execution uses `TurnJournalStore.dispatchAndConsumeAndInitiate` to record
new dispatch and consumption in the same original outer transaction. Both current
authority inspections, reservation checks and capacity rules still apply. If either
operation cannot newly succeed, the transaction rolls back. A prior dispatch or
consumption cannot renew its execution clock.

The original PostgreSQL writer samples `process.hrtime.bigint()` immediately before
the new dispatch update under its existing serialized mutation and Agent lock. The
`pre-commit-monotonic-v2` clock records `clockSourceRef`, `clockEpochRef` and
`anchorAtMs`, without a duration or deadline. This anchor is a conservative lower
bound preceding COMMIT, not a measurement of physical COMMIT time. The original
consumption authority supplies an `executionSelection` with the exact target,
limit reference/version and required `maximumExecutionMs`: explicit `null` for
uncapped or a positive safe integer for a finite cap. Finite selection also
requires `anchorAtMs + maximumExecutionMs` to be a safe integer. The same
transaction guard combines the selection and clock and transfers the private
clock owner only with its newly committed, single-use claim. Rollback or an
unknown COMMIT exports no sample owner.

`sampleDispatchClock` accepts only the actual original initiation guard and checks
its current authority before sampling. It echoes the exchange challenge, full
execution locator and unchanged dispatch clock with `sampledAtMs`. Ceiling-rounded
samples conservatively reduce remaining duration when a cap is configured. The
local sampling owner closes with the original initiation callback; serialized
values, a copied guard or a restarted process cannot recreate it. A native
connection must bind a requested sample to its actual authenticated exchange.
The selected host-controlled profile retains stop responsibility in the host
process and enforces the original deadline only for finite selection. It requires
no guest clock correspondence. The current codec has no mapped-clock profile;
a sampling observation does not supply one.

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

## Selected native execution retention

The PostgreSQL journal retains `execution-intent`, `deadline-control`,
`execution-start` and `execution-interruption` in the original `turn_journal_operations` table. These
records extend the existing full dispatch and consumption; they do not change the
common admission record or create another journal. Each original attempt has at
most one of each selected record. The installation-wide execution lookup and the
native incarnation/execution association are unique.

The actual consumption evidence owner may supply a closed execution intent. It
binds the full original attempt, dispatch operation and consumption claimant to
an independently allocated execution reference, exact native recipient and
immutable limit selection. The intent is inserted while that original attempt
is still unconsumed; a deferred database guard requires the exact consumption in
the same outer commit. Rollback removes both. A historical consumed attempt cannot
acquire an intent later. Only the original transaction's newly committed, single-use
claim carries this intent to `JournalInitiationGuardV1.executionIntent`. Readback,
a duplicate consumption and an uncertain consumption commit cannot initiate.

The selected `host-controlled-v2` start records the entire immutable intent,
actual native incarnation/execution/reservation/session/turn association,
ready-commit evidence and its exact `host-stop-v2` conditional control. The
original host process owns stop responsibility in its original
`process.hrtime.bigint()` epoch. `deadlineAtMs` is required on the control: it is
`null` exactly when the intent's `maximumExecutionMs` is `null`, otherwise it is
the safe integer `anchorAtMs + maximumExecutionMs`. Finite caps have no
fifteen-minute ceiling. Startup, tools and waits consume the same original
interval; native readiness, activity and transport delays never restart it.
Uncapped selection supplies no duration timer. No native clock mapping is
required or fabricated. Optional `nativeReadyObservation` is genuine
native-process timing evidence only, with no cross-clock arithmetic or authority.

The [Agent execution duration setting](../agents.md#execution-duration-selection)
defaults new Agents to `null` and is frozen into each newly admitted revision.
The actual consumption authority must provide the explicit immutable selection
for the exact execution; the journal neither reads a mutable Agent draft nor
defaults missing evidence to uncapped. Configuration-to-dispatch authority and
production native composition remain required. Neither a later configuration
edit nor renewal of an authority call or provider token changes an admitted cap.

The original known-committed, single-taken claim admits its own mandatory cleanup
for the one actual pending native construction and its owned Session/children.
During the original bounded callback, the controller transfers that responsibility
once into a retained stop owner in both finite and uncapped modes. The original
owner issues the opaque control evidence; `retainDeadlineControl` rechecks its
private membership, original call/currentness and any configured deadline under
accepting locks. `findDeadlineControl` reads the one exact retained conditional
duty without creating a live timer or stop owner. A copied clock, target label,
record or evidence object cannot create an original claim. The authenticated
native bridge must supply its actual pending construction, with no effectful
constructor polled yet. The existing `deadline-control` operation and method
names carry this mandatory stop duty even when its deadline is `null`.

The host retains the stop owner and arms any configured deadline before waiting
on control retention. Native construction remains gated until the exact
conditional control is known committed and original initiation/stop checks still
pass. Unknown retention cannot create or replay construction. If acceptance
fails after stop-owner transfer but before a ready owner is retained, the
controller requests cleanup through that same retained duty, including in
uncapped mode. A retained ready owner stays gated for exact start readback. This
control records admitted self-cleanup, not a claim that a timer fired or an
invented human cancellation. Its scope grants no Agent, Pod or host kill.

Closing the five-second initiation guard does not destroy the transferred stop
responsibility or extend the initiating permission. For a finite cap, the host
schedules waits no longer than 2,147,483,647 milliseconds, rechecking the original
monotonic deadline after every wake. At expiry, the retained owner latches
cancellation and invokes its already admitted exact native stop lane directly.
It does not queue behind continuing work, request a fresh human grant or wait
for a new PostgreSQL write. Every sensitive host continuation also checks the
retained stop state and any configured cap. Uncapped selection removes only
elapsed-duration expiry; initiation and ongoing authority calls retain their
finite operation deadlines and independently checked authority.

Timer scheduling or process loss does not establish on-time delivery, physical
termination or a replacement clock owner. Observed loss closes
admission/continuation through the actual transport owners; unresolved stop and
writer exclusion remain held. This profile does not promise daemon survival or
physical termination at a configured deadline.

Current selected execution codecs accept only `pre-commit-monotonic-v2`,
`host-stop-v2` and `host-controlled-v2` with explicit finite-or-null selection
and deadline fields. Untagged `committedAtMs` clocks, older finite-control tags,
mapped starts and missing selections are unsupported; they are not alternate
read formats or an uncapped default. Historical readback never establishes a
new clock or executable owner.

`retainExecutionStart` requires the selected native evidence inspector before and
after accepting locks and again before insertion. Missing inspection refuses the
write. One immutable exact start is retained; a changed native identity, original
intent or stop control conflicts. A selected running outcome must match that retained
native session and turn. `findExecution` returns intent-only or the exact retained
start, with no permission to create another native execution. Lost retention
acknowledgment therefore preserves the original reference, ready observation and
finite-or-uncapped selection.

`SelectedExecutionController` connects the original store callback to a mandatory
native owner. That owner must retain the authenticated connection, complete ready
Session/task/drain and a separate ongoing control owner
before returning. Effects remain gated until definite retention of the exact start.
The controller keeps its original local owner on uncertain acknowledgments and
serializes ordinary control operations. The pre-admitted protective stop bypasses
that queue. Exact readback can resolve only that retained owner;
a copied record or a restarted controller cannot create it. An uncertain native
gate or interrupt submission is not automatically submitted again. The selected
capacity bounds retained local owners; uncertain owners are never evicted to admit
more work.

An ordinary interruption retains its full original start and immutable stop-responsibility
reference/version before native submission. Its current stop authority is checked
separately from continuing execution, so deadline expiry or revoked execution
authority cannot by itself prevent an independently authorized stop. Interruption,
cancellation, native acknowledgment and `TurnAborted` are distinct from proof that
all possible mutators have stopped. The existing no-mutator verification and exact
reservation release remain required. Unknown outcomes continue holding ownership.

The process-local memory journal explicitly refuses selected execution operations
and selected consumption. Existing unselected behavior remains available. Actual
PostgreSQL storage tests exercise original claim transfer, rollback/orphan refusal,
immutable finite and uncapped selections, exact stop/start correspondence, clock
bounds, revocation across a real Agent lock, lost COMMIT acknowledgments, and
interruption or unknown construction without reservation release. Controlled
external evidence in those tests does not establish a production human grant,
native connection, model request or shell execution. Those producers must be
installed by the actual authenticated transport composition.

The controller's `acceptInitiation(attempt, guard, call)` joins an already claimed
original callback without consuming again. It requires the actual store guard's
private clock membership and spends admission once across controller instances.
`dispatchAndConsume` delegates its original callback into this same path. The
current canonical writer and local monotonic producer are connected; a production
channel dispatcher, authenticated native socket owner, and current original human
and whole-execution grants still require their concrete composition. This local
storage path alone does not establish a provider-backed model or native shell turn.
