# Agent identity delivery and dependencies

[Overview](../basic-agent-identity-mvp.md) · [Architecture](architecture.md) · [Security](security.md) · [Interfaces](interfaces.md)

The initial policy milestone and the complete protected-identity profile have
different acceptance criteria. The [seven profile requirements](../basic-agent-identity-mvp.md#minimum-release-requirements)
still govern protected contributions in personal and team contexts. Each cut
retains its source, tests and review. A first Git read does not finish the profile.

## Current source and proof status

As of 2026-09-22, [public main `311bc230`](https://github.com/openclaw/openclaw-enterprise/tree/311bc23012d0fd269483168b865adf79df630542)
contains credential core [#221](https://github.com/openclaw/openclaw-enterprise/pull/221)
and platform integration [#235](https://github.com/openclaw/openclaw-enterprise/pull/235).
The earlier RFC baseline described that supplier as unmerged. Its current
contract is [RepoDriver](interfaces.md#repository-session-binding), capability
`repo`, with bundled `GitHubRepoDriver`. The maintained path supports embedded
OpenClaw, API-key Harness authentication and no Sandbox. Dedicated
repository-bearing revisions still refuse. Existing source or provider evidence
does not qualify the new execution-bound, dedicated identity composition.

The selected policy cut has unmerged source connecting Installation configuration,
immutable State, actual API admission and saved-revision worker refusal. It is
policy groundwork, not positive workload authentication, a demonstrated
current-main configuration bypass fix, or customer-write readiness. Original State
must reconcile its migration with current shipping history, where workspace
migration `0028` is already allocated. Final composed database/worker qualification
remains required. The separate [runtime-authority supplier](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/occ/src/runtime-authority/service.ts#L309-L352)
still lacks a positive current-serving producer.

This RFC revision supplies no new installed SPIRE/CNI/runtime, live-provider,
timing, customer-write or release proof. Missing proof does not imply absent code.

## Depend on interfaces, not entire lanes

| Existing owner                       | Exact input identity consumes                                                                                                                                                                                                                    | What this does not require                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State / selected IAM                 | Original guarded transaction, authenticated service and current intent/policy admission, assignment repository attachment, acknowledged commit/readback, and durable withdrawal. Serialize schema and shipping history with this owner.          | All RBAC administration screens, every Role/resource policy, or a second identity-owned transaction/policy system.                                        |
| Compute / Harness                    | Independently observed assignment/incarnation/create-effect facts. Protected preparation, private ingress, delivery/readiness and exact stop/replace observations. The selected dedicated consumer must retain the repository material contract. | Retained workspaces, advanced recovery, every runtime, or exact-container caller proof. Qualified gVisor remains part of the complete selected profile.   |
| Repository credentials               | Existing session/grant/profile authority with immutable expected execution, verified receiving admission before acquisition/dispatch, and existing renewal/recovery/cleanup.                                                                     | A replacement credential service or another provider. Personal GitHub delegation is a distinct service capability described below.                        |
| Egress                               | One protected Go transport per assignment, authenticated receiving bridge, mandatory routing and protected model mediation, independently progressing expiry/cancellation.                                                                       | A second proxy, every protocol/service adapter, or general enterprise network-policy tooling.                                                             |
| RBAC / invocation and account owners | Original requester, selected personal/team authority, exact operation/audience, authentic runtime-turn association, and current account/session/grant facts.                                                                                     | Every OIDC provider, new login UI, or identity owning connector implementations. Use one supported real ingress for the first checkpoint.                 |
| Audit / observability                | Existing safe operation/lifecycle event contract. Actual verifier/currentness observations identify executor assurance separately from requester.                                                                                                | History UI, retention administration or the complete observability product. Required durable authority/dispatch fences remain with their existing owners. |

An interface declaration is not a producer. A consumer needs the owner's real
implementation and a test through its supported entry. Shared files retain their
owner. Use genuine source joins or a specifically allocated narrow change.

## Deliverable cuts

1. **A. Compatibility and immutable requirement.** Trusted policy persists in
   revisions. Compatibility works, malformed settings fail startup, and unsupported
   deployment or recovery refuses before protected preparation. Preserve IAM,
   claim fencing and authorized cleanup. This uses the existing platform and
   repository contract without requiring positive SPIRE runtime support.
2. **B. Durable execution assignment.** Allocate, bind, select and retire through
   original State. Real limited-role PostgreSQL proves ownership, concurrent
   changes, rollback and uncertain-commit readback. This requires State/IAM's
   guarded admission and the assigned repository/constraint window.
3. **C. Observed, registered workload.** The ordinary worker binds authentic
   Compute observation, registers through constrained SPIRE, reads the result back,
   and obtains rotating identity with protected custody. This requires B, selected
   transport and ingress, and an operator SPIRE fixture.
4. **D. First protected Git read.** A real team Agent with explicit `git-read`
   uses its current execution. Another or retired execution cannot reuse the
   session. The real receiver enforces currentness. This requires C, execution-bound
   sessions, receiving bridge, current-serving resolver and original invocation authority.
5. **E. Complete protected contribution.** A dedicated Agent performs Git/PR work
   with protected model access, correctly bound personal/team authority, and an
   authorized reply. This requires D, dedicated Harness delivery, selected runtime,
   protected model route and provider authorization.
6. **F. Failure qualification and review stack.** Installed rotation, replacement,
   outage, replay denial and measured withdrawal pass. Resolve independent security
   findings, polish, and extract a buildable RFC-first stack with final-tree
   equality. This requires E, accepted shipping composition and actual disposable
   runtime/provider fixtures.

A is the first independently useful policy milestone. D is the first positive
identity checkpoint. E and F complete the selected profile. Each may contain
smaller owner-scoped PRs. SQL adapters and TLS libraries retain component-only
evidence. Build withdrawal and cleanup with each consumer, then measure their
composed guarantee in F.

B and trusted Compute/transport work can proceed in parallel once their contracts
and allocations exist. Before the genuine producers are ready, review A and
native transport, prepare operator configuration, and specify integration cases.
Do not invent allow callbacks, workload observations or unused abstractions.
After C, the serving resolver and receiving bridge can proceed in parallel
before D. Shipping upgrades remain a release prerequisite, not a prerequisite for
every component check.

## Policy milestone acceptance

Use the actual authenticated API, original State and worker. The
[policy interface](interfaces.md#operator-policy-and-revision-admission) owns the
selected input and result shapes. Required evidence is:

1. Omitted and explicit compatibility permit ordinary deployment, return `202`,
   and expose the immutable requirement through existing revision reads.
2. Malformed present startup policy and tenant overrides refuse. Exact-Agent
   authorization precedes unsupported SPIFFE refusal. No Configuration/Secret
   preparation, revision or durable reconcile Work is created by that refusal.
3. Real limited-role PostgreSQL preserves the detached requirement across restart,
   immutable round-trip and recovery. Legacy omission means compatibility.
   Malformed saved state fails closed.
4. The real worker preserves the original reconcile Work prerequisite, current
   authorization, Provider checks, live-claim settlement and authorized stopped
   cleanup. Unsupported running recovery reports `IDENTITY_RUNTIME_UNSUPPORTED`
   before repository, Secret, workspace or Compute preparation. Since ordinary
   enforced deployment refuses, identify the valid State-level admitted-state
   preparation used for this negative recovery case.
5. Original State reconciles the identity migration with occupied workspace
   migration `0028`, preserving current admission predicates, immutable snapshots,
   privileged-function safeguards and canonical history. Qualify the final history
   on fresh and populated databases, with the limited application role and repeat
   execution. Earlier component checks do not establish this shipping composition.

## Before customer-repository writes

The complete identity profile does not universally block initial 0.x. Customer
writes require a separate connected proof: replacement withdraws predecessor
access even when it retains credential material, and every effective write belongs
to an authentically associated, currently authorized request.

Apply that requirement to every mutating Git/HTTP or API dispatch, including
additional requests native Git initiates and GraphQL POSTs. Authorization at the
start of a shell command is insufficient. Sessions, profile checks and bearer
lookup fences are foundations, not proof of either guarantee.

Product, repository credentials, invocation/RBAC, State/Compute and identity must
select the mechanism and qualify real Agent-to-provider replacement, concurrent
requests, stale authority and per-dispatch behavior. No narrower mechanism is
selected here. If product defers writes, an explicitly admitted `git-read` rollout
is an open choice. The bundled default remains `git-write` until an authorized
product decision changes it.

## Personal authority and connector scope

Workload identity answers which execution is calling. It does not answer whether
a human granted GitHub access. Explicit admission selects one connected human's
personal integration or the team's service integration for authorized channel
members. A personal Agent may use that connection's existing full permissions,
never more. Missing personal authority denies access instead of choosing team
credentials. The current repository supplier uses team GitHub
App installation authority. A direct message does not change that authority.
The selected personal GitHub direction requires the credential owner to bind
explicit user consent to the OCE account/requester and retain, renew and revoke
GitHub App user credentials in the trusted service. OIDC login alone supplies none
of those repository permissions.

D can use team authority without waiting for personal GitHub delegation. Complete
release acceptance must separately exercise both authority contexts through real
admitted integrations. The first human connection and its invocation producer
still need to be named. Until then, personal-authority acceptance remains open.
If that journey uses personal GitHub access, it also needs the credential owner’s
user-consent and token capability. This does not allocate a new provider, consent
flow, token store or PAT import to identity. A private conversation using team App
authority cannot qualify the personal context.

Use an existing supported connector for the first real requester/Agent proof.
Slack and Teams implementations retain their connector owner's acceptance. This
RFC does not allocate two new connector implementations to identity. A fixture
submitter, deployer identity or copied invocation ID cannot replace the original
requester and actual runtime turn.

## Increments and qualification

### First connected consumer

One local-account requester, distinct from the deployer, uses a supported
connector to ask a team Agent for a genuine approved repository read. The actual
Harness invokes managed Git with explicit `git-read`. State, Compute,
registration, current-serving, and receiving evidence come from real producers.
The session and delivered material retain the immutable execution expectation.

An embedded OpenClaw checkpoint is optional. It can exercise the existing
repository consumer earlier, but cannot replace the dedicated outcome. The
identity lane needs its RBAC invocation, exact permission, currentness, and safe
audit capabilities. Broader RBAC coverage, retained storage, and History UI remain
their owners' independent gates.

### Complete contribution

Qualify separate authentic personal-request and team-mention cases, each using
its explicitly admitted connection and attributed provider operation. The personal
variant may use one connected human's existing full integration permissions, never
more. Authorized channel members use the team's admitted service integration.
The requester is distinct from the deployer, and Git author metadata conveys
attribution only.

Through real OCC API, State, worker, SPIRE, dedicated Codex, separate trusted Agent
Gateway, and repository service, prove clone/fetch → edit → test → commit → push →
same-repository PR. Explicit `git-full` retains its
[broader selected permission ceiling](security.md#accepted-limits-and-closure).
Qualify gVisor, the protected model and authentication-probe routes, and actual
managed Git/`gh` delivery. Provider readback must establish the resulting
contribution. Deliver the reply only to the currently authorized complete
audience.

### Exact composition qualification

The complete profile includes all preceding capability and its consequential
failure behavior. Qualify the actual installed runtime, networking, identity,
receiving, and credential composition. Complete independent security review and
fixes before declaring that profile supported. The test fixture and installed
deployment are distinct evidence targets.

## Authority acceptance cases

The authority cases are independent:

| Context  | Required association                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Team     | The actual requester may invoke the Agent, the configured team integration authorizes the operation, and the result audience remains permitted. Git author metadata provides attribution only.                                 |
| Personal | The actual requester is the human whose admitted connection authorizes the operation. Exercise a real allowed operation and deny connection substitution or loss of authority. A team credential used in a DM is insufficient. |

A registration, receiver or policy outage must not silently choose compatibility.
Loss of requester eligibility, connection authority or audience access withdraws
further use. Results reach only the currently authorized complete audience.
Retain exact source and runtime/profile identities with each result. Preserve the
existing distinction among requested stop, observed process stop, connection
closure, session closure, provider cleanup and unknown upstream effects.

## Acceptance evidence

Before implementation acceptance, pin a compatible SPIRE release, attestors,
trust bundle, Workload API delivery profile, runtime images, and runtime/CNI tuple
in a reproducible fixture. Capture exact source revisions and deployment artifact
identities so later results cannot silently substitute a different composition.
Existing IAM maintenance intervals and constants do not prove outage withdrawal.
Independent security review and fixes are required before declaring support.

Exercise ordinary request paths through the actual Harness, not only direct
receiver calls. Verify material delivery, shim/PATH invocation, readiness,
generation replacement, retirement, and the actual protected model/probe route.
The receiver must conjunctively consume real execution identity and the original
request's authority before credential acquisition, dispatch, and authorized output.

Required negative and recovery evidence includes:

- Denial for the wrong Agent, Namespace, revision, or component.
- Denial for copied session files, external or sibling off-Pod replay, and a retired
  execution presenting an unexpired certificate.
- Rotation, restart, replacement, withdrawal, dependency outage, and delayed
  positive observations without extending original validity.
- Uncertain State COMMIT and registration create/delete, material delivery failure,
  recovery, and exact owned cleanup without duplicate or unrelated effects.
- Two requests sharing one execution while one loses requester, connection, or
  audience authority. The withdrawn request must lose further use without
  borrowing or cancelling the other's authority.
- Measured new-work refusal and last protected bytes/active closure, including
  renewal loss, blocked readers, and listener saturation. Retain the whole
  30-second limit and applicable scoped five-second limits.

Distinguish local session/connection closure, observed physical stop,
provider-observed cleanup, and uncertain upstream outcomes. A bounded response
does not settle late work. A provider restart that loses token inventory cannot
be reported as revocation.

Retain useful reviewed checkpoints with exact source, validation, substitutions,
and remaining assurance limits. Evidence must say which layer it establishes:

| Evidence          | What it can establish                                                     |
| ----------------- | ------------------------------------------------------------------------- |
| Source            | Contract definitions and implementation at the cited revision.            |
| Composed          | Connected real components in the exercised setup.                         |
| Installed/runtime | Behavior of the recorded deployment and runtime/CNI tuple.                |
| Live provider     | Actual GitHub/model acceptance and resulting provider state.              |
| Release           | Separate acceptance of the complete selected outcome and remaining gates. |

Fixtures cannot qualify the deployment. Existing supplier provider evidence cannot
qualify this new composition. When supported, reconcile the
[recorded access design](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/docs/design/access.md#L63-L109)
with SVID evidence attached to the existing principal, without implicit token
fallback. Update the owning authentication, authorization, deployment, and
runtime-security references.

## Decisions and follow-ups

The [interface decision list](interfaces.md#observations-and-owner-decisions)
keeps protected bootstrap, immutable delivery/current-serving production, receiving
peer/bridge selection, concurrent operation association, and timing mechanics
open. These are missing implementation choices for the selected outcome.
Installation/product and admission owners also retain the proposed distinction
between prospective defaults and audited stronger-minimum withdrawal. The
[architecture transition contract](architecture.md#availability-and-tradeoffs)
requires finite combinations and explicit affected admissions without a grace
period or downgrade.

The following were already separate follow-ups. They do not become prerequisites
for the first disposable protected consumer:

- **OCE-managed SPIRE:** identity/operator packaging retains the consumer contract.
  Close with installed custody, rotation, upgrade, and restore evidence.
- **Exact-container or stronger-host assurance:** Compute/identity provide a
  runtime-aware broker with verified caller/incarnation/request correspondence,
  including gVisor, and separately qualify the host threat boundary.
- **Independent outage-time physical expiry:** Compute/runtime select a trusted
  supervisor with independent enforced expiry and measured exact-incarnation stop.
- **Retained or recovered consumers:** storage, Compute, and native-context owners
  prove whole-Agent predecessor stop/fencing before successor writes, authentic
  artifacts, and a real fresh-authority turn. Restored files or completed context
  never restore retired authority. The [gVisor proposal](https://github.com/openclaw/openclaw-enterprise/pull/248)
  owns that consumer's selected storage and recovery journey.
- **Narrower or mixed delegation, additional services, or runtimes:** RBAC,
  operation, and runtime owners select a real consumer and prove exact scope,
  denial, renewal, and withdrawal. Preserve the enforceable narrowing seam at the
  operation owner. Mixed-context delegation remains deferred. Add fixed operator
  authentication only for a real consumer requiring that narrow adapter.
- **Durable provider cleanup after restart:** the credential owner recovers
  protected custody and establishes provider-observed settlement or revocation.

These successors cannot reuse old files, context, certificates, or observations to
revive retired authority. Each retains its existing owner and explicit closure
evidence.
