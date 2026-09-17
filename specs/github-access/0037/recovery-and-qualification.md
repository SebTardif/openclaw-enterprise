# Recovery, stop and lifecycle qualification

Part of the proposed [persistent Agent and runtime lifecycle specification](lifecycle-spec.md).
The [runtime contract](runtime-contract.md) defines initial delivery and later
controls; this page preserves that distinction for recovery, stop and qualification.

## Recovery contract

Recovery is a separately selected later capability, not a prerequisite for
the gateway MVP. Its first profile requires same-build,
same-cluster retained volumes and exact compatible Harness, configuration,
adapter protocol, and recovery schema. Preserve
completed text, supported inert tool observations, and verified workspace
durability. Exclude RAM, interrupted shells, provider-private reasoning, and
unsupported native-session details. Compatibility profiles bound recovery
promises. Active-session migration/replay across containers, builds, or source
revisions, plus durable coordination for continuing active work and independent
children, require further profiles. Changed builds require separately qualified
compatibility or migration; neither is a gate for a selected same-build
completed-state retained-volume profile.

A recovery head is not a historical filesystem snapshot. Expose files changed
after the completed turn and require explicit disposition. Older context plus
residual files is not clean rollback, and a fresh container does not make
retained executable content safe.

After the no-writer barrier, a trusted offline adapter may import and read back
completed context without Harness execution. If import requires execution, OCC
must first select the candidate as the sole active revision. Ordinary-work
admission and routing stay closed until restore and readiness succeed. Restore
cannot execute model calls, historical tools, or restored startup instructions.
Verify compatibility and ownership or remain nonserving. Use a fresh incarnation
and current workload authorization; never restore credentials or historical
grants as authority.

Continuing still-open logical work also requires a fresh authoritative
assignment to the qualified successor and fresh enforcement authority within
the work's immutable scope and any original configured horizon. Preserve original
operation fingerprints, allowance reservations, submission receipts, and unknown
outcomes. Replacement cannot reopen terminal work, reset a configured horizon, or
convert an unresolved effect into a new attempt. The work model neither expands
recovery compatibility nor removes existing attempt limits. This is a constraint on any
later continuation profile, not a promise of initial active-session migration
or transparent retry as a new attempt.

Stopped intent survives restart and incoming messages. Resume requires fresh
explicit authorization and current build eligibility; failed recovery cannot
use revoked builds. Storage loss beyond the retained-storage guarantee requires
a separate recovery capability.

Cross-cluster recovery, arbitrary migration, process-memory restore, workflow
scheduling, automatic source merging, and historical tool replay are out of
scope. So are application-consistent snapshots, host wake, and remote bridge
protocols. [Gateway recovery](https://github.com/openclaw/rfcs/pull/46) proposes
application-consistent recovery and scale-to-zero;
[remote AgentHarness](https://github.com/openclaw/rfcs/pull/31) proposes bridge and
event protocols. Both remain proposals, and this RFC selects neither.

## Graceful stop and withdrawal

This optional later profile does not select the default public Stop behavior.
It cannot postpone the first runtime's cancellation and retirement obligations.

### Drain admission and bounds

Graceful stop durably records stopped intent, closes new ordinary-work
admission, and records a finite drain deadline for the exact execution. Eligible
existing work may finish only within its unchanged scope, any original configured
horizon, and that deadline. Current authoritative renewal may maintain access within those
bounds; stop cannot extend them or admit new work. Without a qualified drain
profile, OCC admits no draining execution authority.

Application writes, including message posting, require current authority.
The GitHub gateway requires current online authority for reads and writes;
unavailable authority denies dispatch. In other later profiles, only explicitly
qualified reads may continue under an existing unexpired enforcement lease and
all required local checks from
[RFC 0035](../0035-workload-identity-and-runtime-authority.md). The outage permits no
admission, renewal, expansion, or new execution assignment.

Each issued lease stays finite and must fit applicable configured work and
ancestor horizons, drain deadlines, and profile withdrawal bounds, including
clock and enforcement allowances. A newly imposed stop or tighter withdrawal target must account for
outstanding disconnected leases before claiming the new bound. Minutes for
ordinary work and seconds for sensitive work are tolerance scales to qualify,
not guaranteed values. Reconnect and restart cannot move an existing deadline.
A holder with untrustworthy clock or revocation state synchronizes before
serving.

### Withdrawal and retirement

At drain completion or deadline, withdraw remaining authority for that execution
before reporting drain complete. Runtime retirement withdraws the predecessor's
authority; it need not terminally close logical work eligible for fresh
assignment. Cancellation and security revocation close or withdraw affected
work, descendants, and delivery.

Record withdrawal durably and fence further issuance. Report withdrawal
effective only with evidence from accepting services or expiry under the
qualified profile. Requested withdrawal, effective withdrawal, and physical
termination remain distinct. Accepted provider effects may finish despite local
revocation.

Retain the verified completed boundary and newer uncertainty. Compute stops the
exact workload and observes termination before reporting stopped.
[Credential cleanup](../0034-github-app-credentials.md) retains independent
authority. Report each of these facts separately from accepted stop:

- Admission closure.
- Drain deadline.
- Work state.
- Execution-authority withdrawal.
- Delivery state.
- Physical termination.
- Credential cleanup.

Unknown termination blocks writable replacement. A possible provider submission
remains outcome-unknown under its exact operation identity. The gateway MVP
selects no PR reconciliation endpoint and never automatically resubmits a
possibly submitted push or PR. Retain the outcome for explicit disposition.
Local revocation cannot retract accepted remote effects.

## Completed-result delivery

This optional later profile requires its own admission and qualification.
It is separate from the gateway's mandatory independent
[operation finalization](runtime-contract.md#operation-retention-and-finalization),
which retains outcomes even when delivery is canceled or no delivery is admitted.
Graceful stop preserves pending delivery of an already completed result when a
separate finite delivery responsibility was admitted before logical-work
closure, possibly at original admission. For a profile supporting independent
children, completion follows its required child joins under RFC 0036. All
profiles preserve unresolved effects.

The delivery responsibility records its owner, originating work, cancellation
relationships, and operation receipt. It fixes the permitted output, exact
audience and destination, and original absolute horizon. Binding the completed
content must satisfy that admission.

A trusted delivery service can act independently of the stopped worker. At
posting time, it checks current authority, content access, audience eligibility,
exact Channel permission, and provider authorization. Missing required
membership evidence blocks delivery. It cannot complete unfinished computation,
use a fallback audience, or reopen work. A later delivery responsibility needs
fresh admission, and stopped intent alone permits none.

A delivery callback cannot resume the old execution, reopen canceled Work, or
bypass current effect, audience, and publication checks. For a later
approved-candidate publication profile, the same applies to human approval;
approval is not evidence that an earlier effect did not occur. An unknown
publication outcome retains its exact identity and receipt and cannot authorize
a fresh attempt.

Cancellation or security revocation, including Agent disable, withdraws affected
delivery even if the Agent is already stopped. That path preserves outstanding
physical-termination and cleanup obligations and distinguishes requested from
effective withdrawal.

Retry reservations cannot reset the delivery horizon. A definitive no-effect
result may permit a policy-approved retry within the remaining horizon. An
unknown outcome retains its original receipt and cannot authorize reposting.

## Qualification

Qualification requires a real supported Harness. Source contracts and mocks do
not establish runtime guarantees. Evidence is specific to the selected stage;
the full later lifecycle surface is not an early GitHub-access gate.

Use one pinned Kubernetes/gVisor/client profile and RFC 0034's
[controlled, installed and live evidence boundaries](../0034/lifecycle-acceptance.md#acceptance-matrix).
Gateway replacement is non-overlapping and permits downtime; multi-replica and
broader live campaigns are deferred. This does not relax physical writer-stop
evidence or durable uncertainty and restart guarantees.

### Initial runtime and coding work

- For gateway reads and writes, verify exact assignment and immutable authority,
  current IAM, containment, cancellation, and revision retirement. Retain exact
  construction cancellation and helper-stop ownership before construction.
  Exercise cancellation during construction, model streaming, and blocked tools. Observe all owned
  writer termination or report termination unknown and block writable
  replacement. Required-authority withdrawal must interrupt affected work under
  the selected enforcement profile even during blocked activity.
- Verify OCC constructs separately admitted read-only preparation authority and
  hands it to access delivery. Pending assignment and readiness grant no access.
  Observe preparation writers terminated before workspace handoff and predecessor
  termination before successor writes, including initialization and restore.
  Readiness, timeouts and credential revocation cannot substitute for these
  observations.
- Verify bearer authentication resolves the original grant, Work and execution;
  it does not establish caller-container origin. Changes to admitted permission scope require fresh
  execution and a fresh Pod in the Kubernetes/gVisor profile.
- For initial reads and coding work, demonstrate root Work and each supported
  subordinate helper under the same authority, aggregate limits, containment,
  cancellation, and observed cleanup. If helper closure is unqualified, qualify
  a root-only profile and reject unsupported helper requests.
- Qualify the selected execution profile's default uncapped behavior with useful
  native execution beyond the former fifteen-minute ceiling, and configured
  finite expiry from the original anchor. Configuration edits and credential
  rotation preserve the original selection; missing persisted policy rejects
  rather than implying uncapped execution. Cap-component tests alone do not
  qualify this behavior.
- Exercise regular Agent reads, direct push and minimal PR creation under
  [RFC 0034's operation and credential contracts](../0034-github-app-credentials.md),
  including read-only denial. No human approval or retained candidate is required.
- Preserve PR request identity and contents across concurrent requests, disconnect,
  cancellation and restart. Prove independent finalization was registered before
  dispatch, success follows a known receipt commit, and possibly submitted push
  or PR outcomes cannot cause automatic replay or execution resurrection.

### Later public controls and selected recovery

- For Stop task/Stop Agent/Start Agent, verify distinct own-task, shared-task,
  and Agent permissions. Prevent inventory reads from disclosing unauthorized
  task content. Incoming messages, stale queue work, concurrent controls, and
  restart cannot undo stopped intent. Start cannot bypass disabled intent or
  unresolved writers.
- For selected completed-state recovery, recover non-self-contained conversation
  and files on same-build, same-cluster retained storage; prove predecessor
  exclusion; survive controller restart; preserve stopped intent; expose
  incompatible restore, residual files, and ambiguous effects.

Qualify optional drain, outage-read, delivery, and continuation profiles only
when selected; they are not evidence for unselected capabilities:

- With a live connection, deny new work, allow only eligible original work
  before deadline, deny new dispatch after effective withdrawal, and let
  cancellation or disable override drain.
- During authority outage, exercise qualified reads while denying writes,
  renewal, and reassignment. Measure withdrawal from the selected profile's
  start point through accepting-service enforcement.
- Retain the same deadline and operation across restart. Unknown
  execution-authority closure or termination must block writable replacement.
- Assign still-open work freshly without widening its scope or any configured
  horizon or losing effect receipts.
- Deliver completed results after graceful stop; exercise expiry without
  horizon reset, unknown posting outcomes, and cancellation or disable after
  the Agent is already stopped.

Full independent-child coordination and active-session or changed-build migration
need separate scope and evidence. Neither they nor completed-state recovery and
the public Stop/Start controls block the gateway MVP. Approved-candidate and
protected-origin tests qualify their future profiles. Keep source,
composed-component, installed-runtime and live-provider evidence distinct.
Each selected profile still requires its applicable runtime safety evidence.

## Open decisions

- Which Harness, build, and configuration combinations are qualified at each
  stage, and which subordinate helpers demonstrate the required aggregate
  limits and observable cleanup? Without that evidence, qualify a root-only
  profile and reject unsupported helper requests.
- For the later public controls, what is the default Stop action, and which
  optional profiles offer graceful drain and post-stop delivery?
- Which later profile admits independent durable children, with what lineage,
  cancellation, joins, and cleanup?
- What drain bounds and escalation apply when writers cannot be observed?
- Which withdrawal profiles, clock assumptions, and observation evidence bound
  qualified reads and prove effective closure?
- Which output paths enforce exact completed-result identity, audience, and
  cancellation while the Agent is stopped?
- Which workspace and context metadata must be retained, exported, or deleted
  together?
- How should operators resolve interrupted files and unknown provider outcomes?
- What evidence permits changed-build recovery or storage-independent restore?
