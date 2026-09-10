# Configurable execution limits and persistent Agent controls

Status: configurable-cap components implemented; complete native/authority
composition and runtime qualification remain pending. The broader persistent
Agent inventory and stop/start controls in this specification remain follow-up
work. This status does not qualify a deployed runtime.

The [platform design](../docs/design.md#persistent-agents-and-execution-limits)
owns the policy. Current supported component behavior is owned by the
[Agent duration setting](../docs/reference/agents.md#execution-duration-selection),
[turn journal](../docs/reference/turn-journal.md#selected-native-execution-retention),
[hosted native owner](../docs/reference/hosted-native-execution.md),
[credential storage](../docs/reference/credential-storage.md), and
[lifecycle status](../docs/reference/lifecycle-status-api.md) references.

## Delivered scope and remaining work

The completed cap portion adds one Agent `maximumExecutionMs` setting, explicit
immutable revision and execution selections, optional duration enforcement with
mandatory retained stop responsibility, and a nullable execution-horizon
projection for credentials. It removes the selected journal's fixed
fifteen-minute ceiling. It does not provide the broader user-visible Agent/task
stop API described later in this record.

| Area                      | Current delivery and boundary                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent configuration       | Authorized Agent create/PATCH/read supports `maximumExecutionMs: number \| null`. Create omission selects `null`; PATCH omission preserves the saved value; explicit `null` clears a cap. Finite values are positive safe integers with no fifteen-minute ceiling.                                                                |
| Revision admission        | The saved selection is compared with the identified deployment command and copied into each newly admitted immutable revision. Historical revisions lacking a policy cannot supply an executable selection; absence is not an uncapped default.                                                                                   |
| Selected journal          | Required finite-or-null `maximumExecutionMs` and limit provenance are retained with the original attempt. The only current clock/start/control shapes are `pre-commit-monotonic-v2`, `host-controlled-v2` and `host-stop-v2`. Missing or obsolete selected execution forms reject explicitly.                                     |
| Host enforcement          | Stop custody is retained before construction in both modes. A finite cap uses the original monotonic anchor and bounded timer waits; uncapped mode creates no duration timer. Unknown construction still requests retained cleanup and holds ownership/capacity.                                                                  |
| Credential projection     | `turnNotAfter` can explicitly be `null` for an uncapped execution. Concrete credential leases, operation deadlines and other independent bounds stay finite. The projection supplies neither an authority issuer nor automatic token rotation in existing processes.                                                              |
| Native integration        | The hosted owner requires a matching Node SDK connector and native construction gate implementing the same v2 control shapes. A local SDK build or source-only native changes do not qualify task/helper closure. A production revision-to-dispatch selector and complete original current-authority composition remain required. |
| Persistent Agent controls | Authorized inventory/current-work observations, complete Stop task/Stop Agent/Start Agent transitions, durable new-work blocking and qualified physical cleanup remain follow-up scope. Existing lifecycle records and component interruption methods do not supply this complete flow.                                           |

The requirements below retain the full selected direction. Claims of completed
runtime behavior require the qualification evidence at the end of this record,
including genuine native execution past the former ceiling, configured expiry
and observed cleanup during blocked model/tool activity.

## Policy

Agents may exist indefinitely. An Agent is the stable service identity and
configuration; its Pod, Harness instance, conversation, logical work and native
execution attempt have separate lifetimes.

The execution duration cap is configurable and **defaults to uncapped**.
Uncapped means that elapsed time alone does not stop an attempt. Completion,
explicit cancellation, service stop, authority withdrawal and independently
configured resource or spend limits still apply. The policy does not promise
that a process never fails or that failed work automatically resumes elsewhere.

A finite configured cap limits one original attempt's elapsed wall time. The
clock starts at the original dispatch anchor, before dispatch commit; startup,
tool execution and waiting consume that budget. Configuration changes affect
future admission, not an already admitted attempt. Extending an active budget
is a separate future feature, not implicit credential or authority renewal.

## Configuration and admission

The canonical Agent setting is `maximumExecutionMs: number | null`. Its
implemented configuration semantics and immutable revision snapshot are owned
by the [Agent reference](../docs/reference/agents.md#execution-duration-selection).
The original execution selection separately requires its exact effective policy
and provenance. Complete production authority composition must resolve applicable
Installation or Namespace Restrictions; an Agent draft alone cannot override
those Restrictions or act as the issuer.

- Omission on creation selects uncapped. An explicit uncapped value clears a
  draft cap; omission from a partial update preserves its saved value.
- A finite value must be a positive, exactly representable duration. Reject
  zero, negative, nonfinite, fractional or overflowing input. Do not use a large
  sentinel value or JavaScript Infinity for uncapped execution.
- Admission resolves configuration and Restrictions once into an explicit
  finite-or-uncapped selection. Missing authority is an error, not an uncapped
  fallback. An authorized Restriction may require or narrow a finite cap.
- Persist the selection on the immutable attempt. Later drafts, model rounds,
  useful activity, reconnects and credential rotation cannot change it.
  Persisted execution records require an explicit supported finite-or-uncapped
  selection. Missing or unsupported persisted policy fails explicitly;
  creation-time defaulting does not reinterpret old execution records.
- Return the effective selection in authorized status so operators can see
  whether work has a configured deadline.

The Enterprise wire selection and stop-control successor are implemented;
the selected external SDK/native producer and consumer must use the matching
v2 clock/control/start shapes. Older finite-only or mapped shapes are unsupported.
No generic environment variable or unrelated native timeout is an alias for this
policy.

## Authority stays finite

An uncapped execution is not an unbounded permission grant. Accepting services
must obtain current authority for their exact operations under the selected
authorization profile. Renewable enforcement leases remain finite and bind the
original work, exact execution, permitted actions and resources, and accepting
service. Every lease fits all applicable configured work, ancestor, stop and
withdrawal bounds.

Work identity, scope, purpose, audience and cancellation dependencies remain
fixed. A work horizon is optional when the selected policy is uncapped; a finite
configured horizon remains binding. Renewal cannot expand scope, extend a
configured cap, reopen terminal work or authorize replay of an uncertain effect.
Service-owned work requires actual service authorization; parsing an owner value
does not supply an issuer or change existing original-requester dependencies.

Identity evidence and provider credentials rotate independently. A new SVID or
GitHub token does not restart the Agent or extend the existing attempt. Existing
process environments do not acquire replacement tokens automatically. Each
supported client must demonstrate its actual rotation behavior.

Outage behavior and numerical lease/withdrawal profiles require separate
selection and qualification. This policy adds no offline write permission or
default disconnected-read exception. Loss of required authority blocks the
affected operation; it is not proof that a local process has stopped.

## Stop ownership and native execution

Separate the mandatory execution stop owner from optional elapsed-time expiry.
Both finite and uncapped modes must retain the exact native construction and
owned Session/helper scope before opening the native execution gate.

Finite mode arms the original monotonic deadline. Uncapped mode retains the
same independently authorized cancellation responsibility without inventing an
expiry timer. Already admitted protective cleanup must remain usable when
ordinary continuation authority or the database is unavailable. The authority
owner must interrupt ongoing model/tool activity when its selected policy
requires it; checking only before the next tool call is insufficient.

Preserve original known-committed, single-use dispatch and exact native binding.
Historical readback cannot construct another executable owner. A cancellation
acknowledgement, socket close or terminal model event does not prove that every
mutator stopped. Retain execution capacity and writer ownership while native
closure or a possible provider effect is uncertain.

Schedule long finite deadlines with bounded timer waits and monotonic rechecks;
do not pass unsupported large delays directly to a host timer. On host loss,
report uncertainty instead of reconstructing authority from a wall-clock label.

## User-visible controls

Provide an authorized Agent inventory and current-work view. Show intended
service state, observed execution state, observation time, work identity,
configured cap, pending controls and unresolved outcomes. Resource visibility
does not itself authorize disclosure of private task content.

- **Stop task** targets one exact task and its owned helpers or admitted
  descendants. Other work remains subject to admission and writer exclusion.
- **Stop Agent** durably blocks new work, including incoming messages and stale
  queued dispatch, and drives stopping of affected work. Preserve the Agent,
  configuration, retained files and unresolved cleanup obligations.
- **Start Agent** is a separately authorized transition. It cannot bypass an
  administrative disable, revive canceled work or replay uncertain operations.

Report durable stop acceptance, new-work blocking, requested/effective platform
authority withdrawal, stopping, observed stopped, failed operation and unknown
termination separately. Provider revocation and already accepted remote effects
remain separate outcomes. Queue completion or a deletion acknowledgement is
insufficient evidence for observed stopped.

Commit acceptance and attributable audit atomically. Remote audit export failure
cannot erase a protective stop. Use exact-resource current authorization,
generation checks and idempotent readback. Keep own-task, shared-task and Agent
lifecycle permissions distinct; implement the selected lifecycle-manager
contract rather than treating any administrator label as authorization.

The default Stop action and any graceful-drain or post-stop completed-delivery
option need explicit product semantics. A configured finite drain cannot extend
the original finite work cap. This execution policy does not select those
additional options implicitly.

## Serving and helpers

Prepare a replacement only in an isolated, nonserving environment. Before it
serves or writes shared state, establish predecessor termination and resolve
uncertain creates that could still produce writers. Readiness, route withdrawal
and elapsed time do not establish writer exclusion.

Native helpers may remain subordinate to one work/attempt only when original
authority, aggregate resource limits, cancellation and physical cleanup cover
them. Independently admitted children require their own scope, authority,
lineage, status and cleanup. Neither a child name nor a Git worktree creates an
isolation boundary. The initial supported child subset is a separate selection.

## Delivery sequence

1. Completed: update the platform policy and distinguish component behavior from
   required runtime qualification.
2. Completed in Enterprise: define the canonical Agent setting, immutable
   selection, and v2 clock/stop/start codecs. A compatible external SDK and native
   implementation remain required at the composition boundary.
3. Completed in Enterprise: implement configuration admission, journal
   persistence constraints, optional host deadline enforcement, retained cleanup
   and credential horizon projections. The owning current references are linked
   above; unrelated preparation and authority limits remain independent.
4. Pending: complete the production revision-to-dispatch selector and original
   authority/native composition, then qualify the finite and default-uncapped
   behavior against the selected real runtime.
5. Follow-up: implement the wider persistent Agent controls, durable control
   admission, worker effects and qualified status observations specified here.
   Existing V2 diagnostic values and component callbacks are not complete runtime
   suppliers for those controls.

Active-session migration/replay across containers, builds or source revisions
and durable replacement/child coordination are later work. Repeated short
attempts are not a transparent substitute for one long execution: partial files,
native context and uncertain external writes require explicit recovery policy.

## Qualification

Required evidence uses the selected real SDK/native runtime and current
authority, not a synthetic native endpoint alone:

- One useful coding task continues past the old fifteen-minute ceiling in the
  same native attempt, including model/tool activity.
- Omitted creation configuration selects uncapped; omitted partial-update
  configuration preserves the saved selection. Explicit finite limits, including
  durations above fifteen minutes, expire at the original deadline. Component
  tests verify safe scheduling beyond the host timer's maximum delay. Invalid or
  missing persisted selections reject, and draft edits do not change admitted
  attempts. Unsupported budget-extension requests reject explicitly.
- Stop during native construction, model streaming and blocked tools closes
  new dispatch and observes owned helper cleanup or reports termination unknown.
- Identity/provider rotation preserves original work and attempt identity,
  configured deadlines and unknown-effect receipts.
- Required authority withdrawal interrupts affected work under the selected
  profile, including while a model/tool call is blocked.
- Messages, stale queue work, concurrent lifecycle requests and controller
  restart cannot undo a stopped Agent. Explicit Start cannot bypass old writers.
- Unknown push/PR outcomes and lost native acknowledgements do not cause replay.
- Actual database checks cover constraints, atomic selection, cancellation
  races and exact recovery after lost commit acknowledgement.

Component tests remain useful evidence of their narrower boundaries. Missing
native, provider or cluster prerequisites must be reported explicitly; they
cannot be replaced by a fixture and described as runtime qualification.
