# Runtime ownership, admission and writer exclusion

Part of the proposed [persistent Agent and runtime lifecycle specification](lifecycle-spec.md).
Read the [stage-specific qualification and later recovery profiles](recovery-and-qualification.md)
with these runtime contracts.

## Delivery sequence and implementation boundary

1. **Gateway MVP.** Require exact runtime assignment and immutable authority,
   containment, cancellation and helper-stop ownership before construction,
   and observed writer termination before successor writes. Reads, direct push
   and minimal same-repository PR creation use root Work with qualified
   subordinate helpers. Where helper authority, aggregate limits, containment,
   cancellation, and physical
   cleanup are unproven, qualify a root-only profile and reject unsupported
   helper requests. These obligations apply without the later public lifecycle
   API.
2. **Broader persistent Work and controls.** Independently admitted durable
   children, public Stop task/Stop Agent/Start Agent, and selected recovery,
   drain, and completed-delivery profiles follow later. Approved-candidate
   publication is a separate future profile owned by RFC 0034.

[RFC 0034](../0034-github-app-credentials.md) owns the gateway's read/read-write
profiles, direct push and PR contracts, credential inventory, and the known MVP
destination ownership/visibility gap. Restoring those destination checks is not
a gateway qualification gate. Direct writes require current operation
authority, without a retained candidate or human approval. Required
[operation finalization](#operation-retention-and-finalization) survives worker
loss independently of the optional later
[completed-result delivery profile](recovery-and-qualification.md#completed-result-delivery).

Configurable execution caps and authorized lifecycle status GETs are proposed
capabilities, absent from this RFC's public base. The cap contract requires
configuration, immutable selections, optional deadline enforcement, and retained
stop responsibility. Proposed status reads expose recorded observations; they do
not produce runtime evidence or supply complete mutation handlers. Production
dispatch, authority, native-runtime composition and full runtime qualification
remain pending. This RFC does not present Stop/Start controls as existing
capabilities.

The whole lifecycle API, default Stop choice, graceful drain, and recovery do not
gate the gateway MVP. Exact assignment, immutable authority, containment,
cancellation/retirement, and observed writer termination remain mandatory.

## Ownership and records

OCC owns Agent state and lifecycle. Compute and Sandbox drivers realize admitted
intent and report observations; neither chooses policy nor rewrites revisions.
The later lifecycle profile uses the following internal records without adding
an execution resource between `AgentRevision` and its workload. Earlier stages
still retain the assignment, immutable authority, and cleanup ownership needed
by their runtime baseline.

| Record              | Required contents                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle intent    | Agent; desired running, stopped, or disabled condition; monotonic generation; attributable accepted request.                                                |
| Runtime observation | Canonical execution assignment and generation; exact revision, provider instance, and incarnation; readiness; writer ownership; termination or uncertainty. |
| Recovery head       | Completed conversation boundary; workspace durability reference; exact compatibility fingerprint; interrupted or unresolved work.                           |
| Lifecycle operation | Stable idempotency key; expected generation; source and target references; admitted obligation; dispatch progress; observed outcomes.                       |

Use [RFC 0035's execution assignment](../0035-workload-identity-and-runtime-authority.md)
across registration, observations, and accepting services. OCC selects the
assignment; Compute supplies evidence. Lifecycle and execution generations are
distinct. Readiness grants no serving permission, and expired controller claims
prove neither death nor exclusive ownership. The gateway authenticates an opaque
Agent access token and resolves its original server-owned grant, root Work,
Agent and execution. Bearer possession does not prove caller-container origin;
a copied live token can use its original still-authorized grant from a reachable
location. [RFC 0035](../0035-workload-identity-and-runtime-authority.md#identity-and-authority)
owns authentication and the future protected-origin profile.

[RFC 0036](../0036-turn-bound-delegated-authority.md) owns logical work, its service
owner and requester attribution, immutable scope and any configured original
horizon, and attached-child lineage. This RFC owns runtime transitions and finite
completed-result delivery. Logical work, runtime execution, bounded drain, and
delivery have separate lifetimes. Work and delivery records retain their
identity across runtime replacement.

A message acknowledgement, completed model turn, or lost connection does not
close logical work; retained context does not authorize it. Gateway operations
use one service-owned root Work with subordinate native helpers only
when its authority, aggregate limits, containment, cancellation, and physical
cleanup demonstrably cover them. Otherwise qualify a root-only profile and
reject unsupported helper requests.

Independently admitted durable children are later scope. Their renewal and
required joins follow RFC 0036, including ancestor cancellation when no parent
process runs. Each requires its own scope, authority, lineage, status, and
cleanup. A child name or Git worktree supplies no isolation boundary.

## Execution limits and authority

An Agent may exist indefinitely as a stable identity and configuration. Revision,
Pod, Harness, conversation, logical work, and execution-attempt lifetimes remain
separate. Persistence promises neither a failure-free process nor automatic
continuation on replacement.

Execution duration defaults to uncapped. An optional finite cap limits one
original attempt from its dispatch anchor, including startup, tool execution,
and waiting. Admission records the effective finite-or-uncapped selection and
its policy provenance immutably. Configuration changes affect future admission;
activity, model rounds, reconnects, and credential rotation cannot extend an
admitted cap. Applicable Restrictions may require or narrow a finite cap.
Missing authority or missing persisted policy is an error, not an uncapped
fallback. Extending an active budget is outside the initial scope.

Uncapped means elapsed time alone does not stop the attempt. Completion, explicit
stop, required-authority withdrawal, and independently configured resource or
spend limits still apply. Work horizons may be absent under an uncapped policy;
a configured finite work or ancestor horizon remains binding. Enforcement
leases, credentials, operation deadlines, drain deadlines, and completed-delivery
horizons remain finite. Lease and credential renewal requires current
exact-operation authority and cannot broaden scope, reopen terminal work, or
reset an existing cap or deadline.

Both modes retain an independently authorized stop owner for exact native
construction and owned helpers before construction begins. Finite mode enforces
the original monotonic deadline with bounded timer waits; uncapped mode creates
no duration-expiry timer. Protective cleanup must remain usable when ordinary
continuation authority is unavailable. A cancellation acknowledgement, terminal
model event, or socket close does not prove physical closure of every mutator.
Retain capacity and writer ownership while closure or provider effects remain
uncertain. Identity and provider credential rotation require qualified client
behavior; a new token neither refreshes an existing process environment nor
extends its attempt.

Changes to admitted permission scope require fresh admission and execution, plus a fresh Pod in
the Kubernetes/gVisor profile. Withdraw old dispatch authority before changed
scope can execute. Token rotation cannot change the grant's admitted profile;
[RFC 0034](../0034-github-app-credentials.md) owns token profiles and retained
inventory obligations.

Current operation checks may deny or narrow allowed operations within the unchanged
admitted ceiling without admitting a new scope. They cannot change the fixed token
profile or reopen closed authority.

## Operation retention and finalization

PR creation retains immutable canonical request contents under
`(accessId, clientOperationId)`, with a UUIDv4 client ID. Current authorization is
required to retrieve retained same-key state; changed contents conflict.
[RFC 0034's publication contract](../0034/github-publication.md#trusted-publication)
owns atomic claim consumption with dispatch admission, capacity and closure
checks. Only a known commit grants the original receiver one-use submission
authority; restart recovery cannot reconstruct it.

Register independently bounded finalization before dispatch and return success
only after a known receipt commit. Push and PR operation identities, claims,
receipts and unknown outcomes survive disconnect, cancellation and restart.
Never automatically resubmit a possibly submitted push or PR; the MVP selects no
PR reconciliation endpoint. Lease expiry does not terminally close Work, and
closure cannot erase receipts or reopen authority. This finalization is mandatory
even when no completed-result delivery profile is selected.

## Inventory and user controls

This section proposes the later public control surface. Status observations and
internal interruption methods alone do not implement the complete contract.
Internal cancellation, retirement, and observed writer termination are already
mandatory for the first supported runtime.

Provide authorized Agent inventory and current-work observations showing intended
service state, observed execution state, observation time, exact work identity,
effective cap, pending controls, and unresolved outcomes. A recent response does
not refresh old runtime evidence. Agent visibility alone does not permit reading
private task content.

| Control     | Required outcome                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop task   | Stop one exact task and its owned helpers or admitted descendants. Other work remains subject to normal admission and writer exclusion.                                                                                    |
| Stop Agent  | Persist stopped intent, block new work including incoming messages and stale queued dispatch, and drive affected work to stop. Preserve Agent identity, configuration, retained files, and unresolved cleanup obligations. |
| Start Agent | Admit a separately authorized running transition. Do not bypass administrative disable, revive canceled work, replay uncertain operations, or bypass predecessor writer exclusion.                                         |

Own-task, shared-task, and Agent lifecycle permissions are separate exact-resource
decisions. An administrator label is not itself authorization. Persist attributable
acceptance and its audit atomically. Keep acceptance, new-work blocking,
requested/effective authority withdrawal, stopping, observed stopped, failed
operation, termination unknown, and credential cleanup separately visible. Queue
completion and provider deletion acknowledgements do not prove observed stopped.

The default Stop action must be selected before introducing these later public
controls. [Graceful drain](recovery-and-qualification.md#graceful-stop-and-withdrawal) and
[delivery after stop](recovery-and-qualification.md#completed-result-delivery) are
optional profiles, not an implicit consequence of uncapped execution. These later product
decisions do not block the gateway MVP. Cancellation and
security revocation override drain. Start opens eligible new admission; it does
not undo a prior task cancellation.

## Durable admission

For the later public control profile, `stopAgent` and `startAgent` conceptually
take an Agent reference, expected
lifecycle generation, and idempotency key; an exact-task stop also binds the
original task identity and applicable concurrency check. OCC authenticates and
authorizes the exact actions and references, then atomically records intent,
operation, attribution, and reconciliation work with a compare-and-set against
the expected generation. Repeated keys identify the same operation; conflicting inputs or
stale generations are rejected.

The acceptance receipt reports durable admission, not completed startup or
teardown. Reconcile an unknown commit before asserting acceptance or duplicating
effects. Workers recheck current intent and ownership before dispatch, and
restart resumes the retained obligation. Audit export failure cannot reopen
denied authority or erase durable protective operations. These records separate
acceptance, dispatch, and observation so each outcome remains truthful.

## Activation and writer exclusion

In the merged ordinary Kubernetes path, [activation](https://github.com/openclaw/openclaw-enterprise/blob/3eeacb85d9e8e087bc3e74d792778e4ef3123412/apps/controller/src/drivers/compute/kubernetes/index.ts#L1647) precedes the [retirement request](https://github.com/openclaw/openclaw-enterprise/blob/3eeacb85d9e8e087bc3e74d792778e4ef3123412/apps/controller/src/drivers/compute/kubernetes/index.ts#L1817); retirement requests Deployment deletion without observing that all predecessor writers have stopped. Activation checks and the Recreate gateway rollout do not establish this specification's complete writer-exclusion barrier.

Preserve RFC 0027's activation order:

1. Prepare an isolated, nonserving candidate with Harness execution disabled.
2. Verify containment and prepare the candidate's nonserving route.
3. Retire the predecessor and verify its Harness has stopped.
4. Select the candidate as the sole active revision and permit execution.
5. Enable routing only after readiness.

OCC must construct separately admitted read-only preparation authority and hand
it to access delivery; pending assignment and readiness grant no access.
Preparation uses its own grant and never borrows execution credentials. Retain
exact construction cancellation and helper-stop ownership before construction,
then observe preparation writers terminated before workspace handoff.

A candidate readiness probe is not runtime authority. Before predecessor
retirement, failures preserve prior serving. Retirement deliberately creates an
availability gap while termination and successor activation are verified. This
contract offers no zero-downtime guarantee. After retirement, service requires
verified activation or rollback.

Before any successor writes shared retained storage, including initialization,
repair, or restore, Compute must establish predecessor termination and resolve
earlier creates that could still produce writers. Names, lease expiry, route
withdrawal, credential revocation, and elapsed time are insufficient evidence.
Earlier candidate preparation remains isolated from shared writable state. If evidence that no
writer remains is missing, block replacement and retain the data.
