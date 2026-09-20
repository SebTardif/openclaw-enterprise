# Agent identity delivery and dependencies

This is the delivery plan for the proposed [Agent identity RFC](../basic-agent-identity-mvp.md).
Its [seven release requirements](../basic-agent-identity-mvp.md#minimum-release-requirements)
remain the completion criteria. Each cut has its own source, tests and review;
component acceptance and the first usable checkpoint retain their explicit limits.

## Depend on interfaces, not entire lanes

| Existing owner                       | Exact input identity consumes                                                                                                                                                                                                                    | What this does not require                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State / selected IAM                 | Original guarded transaction, authenticated service and current intent/policy admission, assignment repository attachment, acknowledged commit/readback, and durable withdrawal. Serialize schema and shipping history with this owner.          | All RBAC administration screens, every Role/resource policy, or a second identity-owned transaction/policy system.                                        |
| Compute / Harness                    | Independently observed assignment/incarnation/create-effect facts; protected preparation, private ingress, delivery/readiness and exact stop/replace observations. The selected dedicated consumer must retain the repository material contract. | Retained workspaces, advanced recovery, every runtime, or exact-container caller proof. Qualified gVisor remains part of the complete selected profile.   |
| Repository credentials               | Existing session/grant/profile authority with immutable expected execution, verified receiving admission before acquisition/dispatch, and existing renewal/recovery/cleanup.                                                                     | A replacement credential service or another provider. Personal GitHub delegation is a distinct service capability described below.                        |
| Egress                               | One protected Go transport per assignment, authenticated receiving bridge, mandatory routing and protected model mediation, independently progressing expiry/cancellation.                                                                       | A second proxy, every protocol/service adapter, or general enterprise network-policy tooling.                                                             |
| RBAC / invocation and account owners | Original requester, selected personal/team authority, exact operation/audience, authentic runtime-turn association, and current account/session/grant facts.                                                                                     | Every OIDC provider, new login UI, or identity owning connector implementations. Use one supported real ingress for the first checkpoint.                 |
| Audit / observability                | Existing safe operation/lifecycle event contract; actual verifier/currentness observations identify executor assurance separately from requester.                                                                                                | History UI, retention administration or the complete observability product. Required durable authority/dispatch fences remain with their existing owners. |

An interface declaration is not a producer. A consumer needs the owner's real
implementation and a test through its supported entry. Shared files retain their
owner; use genuine source joins or a specifically allocated narrow change.

## Deliverable cuts

| Cut                                        | Useful result and acceptance                                                                                                                                                                            | Prerequisite                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A. Compatibility and immutable requirement | Existing tools keep working; startup/deploy/recovery reject unsupported enforcement before protected preparation. Preserve current IAM, claim fencing and authorized cleanup.                           | Existing platform and repository supplier; independent of positive SPIRE runtime support.                      |
| B. Durable execution assignment            | Allocate, bind, select and retire through original State. Real limited-role PostgreSQL tests cover ownership, concurrent changes, rollback and uncertain-commit readback.                               | State/IAM's guarded admission and assigned repository/constraint window.                                       |
| C. Observed, registered workload           | The ordinary worker binds actual Compute observation, performs constrained SPIRE registration, reads it back and obtains rotating identity with protected custody.                                      | B; authentic Compute observations and selected transport/ingress; operator SPIRE fixture.                      |
| D. First protected Git read                | A real team Agent with explicit `git-read` uses its current execution; another or retired execution cannot reuse the session. Currentness is enforced at the real receiver.                             | C; repository session extension, receiving bridge, current-serving resolver and original invocation authority. |
| E. Complete protected contribution         | Dedicated Agent performs the Git/PR workflow using protected model access; personal and team authority are correctly bound and replies reach only the authorized audience.                              | D; dedicated Harness delivery, protected model route, selected runtime and required provider authorization.    |
| F. Failure qualification and review stack  | Installed rotation, replacement, outage, replay-denial and measured-withdrawal cases pass. Fix independent security findings, polish, and extract a buildable RFC-first stack with final-tree equality. | E and accepted shipping composition; actual disposable runtime/provider fixtures.                              |

A is a useful source checkpoint. D is the first usable identity checkpoint. E and
F satisfy the selected complete release. Each cut can contain smaller owner-scoped
PRs; a SQL adapter or TLS library alone must retain its component-only label.
Apply withdrawal/cleanup behavior while building each consumer, then measure the
composed guarantee in F; it is not a security layer added after enabling traffic.

B and trusted Compute/transport work can progress in parallel once their narrow
contracts and source allocations exist. Before those producers are ready, identity
can preserve and review A and the native transport, specify exact integration
cases, and prepare operator configuration. Do not invent an allow callback,
workload observation or unused abstraction to make a blocked join appear complete.
Once C is available, the current-serving resolver and receiving bridge can proceed
in parallel before D. Shipping upgrades are a release prerequisite, not a reason
to block every component check.

## Personal authority and connector scope

Workload identity answers which execution is calling. It does not answer whether
a human granted GitHub access. The current repository supplier uses team GitHub
App installation authority; a direct message does not change that authority.
The selected personal GitHub direction requires the credential owner to bind
explicit user consent to the OCE account/requester and retain, renew and revoke
GitHub App user credentials in the trusted service. OIDC login alone supplies none
of those repository permissions.

D can use team authority without waiting for personal GitHub delegation. Complete
release acceptance must separately exercise both authority contexts through real
admitted integrations. The first human connection and its invocation producer
still need to be named; until then, personal-authority acceptance remains open.
If that journey uses personal GitHub access, it also needs the credential owner’s
user-consent and token capability. This does not allocate a new provider, consent
flow, token store or PAT import to identity. A private conversation using team App
authority cannot qualify the personal context.

Use an existing supported connector for the first real requester/Agent proof.
Slack and Teams implementations retain their connector owner's acceptance; this
RFC does not allocate two new connector implementations to identity. A fixture
submitter, deployer identity or copied invocation ID cannot replace the original
requester and actual runtime turn.

## Installed acceptance matrix

| Increment                       | Required evidence and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First connected consumer        | One local-account requester distinct from deployer, supported connector, team Agent and approved repository; actual Harness managed Git with explicit `git-read`. Real State/Compute/registration/current-serving/receiving producers and immutable delivery; embedded is optional. Pin compatible SPIRE release, attestors, bundle, Workload API delivery, images and runtime/CNI tuple in a reproducible fixture.                                                                                                                                                                                                                                                                                                            |
| Complete contribution           | Real OCC API, State, worker, SPIRE, dedicated Codex/Gateway and repository service perform clone/fetch → edit → test → commit → push → same-repository PR. Explicit [git-full](https://github.com/openclaw/openclaw-enterprise/blob/eb52cc4cfe68f08017e7ece6585fe7e937e0747a/docs/reference/repository-credentials.md#L102-L125) admits its actual broader Git/selected REST/GraphQL/PR/issue/comment ceiling, not a single-PR capability. GraphQL uses the installation-token grant without per-field authorization. Qualify installed gVisor and protected model/probe routes, separate authentic personal-request and team-mention cases with their admitted authority, provider readback and authorized audience delivery. |
| Exact composition qualification | Deny wrong Agent/Namespace/revision/component, copied session material, off-Pod replay and retired-but-unexpired certificates. Exercise rotation, restart, replacement, withdrawal, dependency outage, delayed positives, uncertain COMMIT/registration, delivery failure, recovery/cleanup and two requests sharing an execution while one loses authority. Measure both closure endpoints. Complete independent security review/fixes before support.                                                                                                                                                                                                                                                                        |

The authority cases are independent:

| Context  | Required association                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Team     | The actual requester may invoke the Agent, the configured team integration authorizes the operation, and the result audience remains permitted. Git author metadata provides attribution only.                                 |
| Personal | The actual requester is the human whose admitted connection authorizes the operation. Exercise a real allowed operation and deny connection substitution or loss of authority; a team credential used in a DM is insufficient. |

A registration, receiver or policy outage must not silently choose compatibility.
Retain exact source and runtime/profile identities with each result. Preserve the
existing distinction among requested stop, observed process stop, connection
closure, session closure, provider cleanup and unknown upstream effects.
