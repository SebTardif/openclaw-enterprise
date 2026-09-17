# Work admission and durable records

Part of the proposed [Work authority specification](work-authority-spec.md).
Continue with [operation enforcement and Work lifecycle](enforcement-and-lifecycle.md),
including qualification and unresolved questions.

## Selected Repository Profile

The selected GitHub profile admits one immutable service-owned root Work per execution. [Later child requirements](enforcement-and-lifecycle.md#later-capability-attached-children) do not expand this profile.

| Grant        | Admission and operations                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `read`       | Metadata and clone/fetch for one administrator-admitted private repository; default for existing read-only selections. |
| `read-write` | The same reads, direct push and independent same-repository PR creation; no human approval or retained-candidate gate. |

RFC 0034 owns [push and PR semantics](../0034/github-publication.md), including the accepted destination ownership/visibility gap. The grant fixes the operation and credential-profile ceiling; current policy may narrow it. A profile or Work-context change requires fresh admission/execution and preserves existing inventory, receipts and unresolved target holds. General Work UI/API, independent durable children, continuation after coordinator loss across fresh attempts and public Stop/Start controls remain later capabilities.

The initial administrative model is a direct service grant for selected repositories and operations. Native-channel user and channel allowlists govern invocation separately. They cannot confer service repository access, and a service grant cannot admit an otherwise unauthorized invocation. Richer IAM administration is not required to express this initial policy.

### Minimum root Work remains required

Root Work admission must durably bind the original authenticated invocation, service owner, Installation/Namespace, Agent/revision, exact assignment, immutable repository/action scope, purpose, eligible data, audience and provider selections. It records the effective duration policy, any original configured horizons, aggregate resource limits and cancellation or withdrawal dependencies. Each operation retains its original identity, immutable request, submission state and outcome. Provider credential custody remains with trusted mediation.

The root has no parent or independent child authority. Existing Agent/request records may host these facts; admission, current service authorization, enforcement and recovery remain required.

Inventory's original-operation binding must receive genuine root Work through an explicit projection or versioned schema. Invented turn/message IDs and caller-created handles cannot supply this authority. Qualification must integrate authentic invocation, State, execution and credential custody; component checks do not establish a deployed repository flow.

### Admit preparation separately

OCC authorizes and constructs read-only preparation context, binding the original invocation, Agent/revision, selected repository, immutable profile, policy and generations. OCC hands that admitted context to access delivery before preparation credentials are issued. A pending assignment, readiness record or caller-created context is insufficient.

Preparation owns a separate read-only grant and Agent access token; it never borrows execution material, including a read-write token. Retain preparation cancellation and writer-stop ownership before construction, and observe its writers stopped before handing the workspace to the execution. The implementation must specify the authoritative constructor and delivery handoff; naming an admitted-context type alone does not establish either.

### Initial helper boundary

A subordinate helper remains in the root's original Work and execution context, with the same authority, aggregate resource budget, cancellation and physical stop ownership. It has no independent renewal or admission. Creation cannot reset a duration or resource limit. The supported runtime must demonstrate physical stop for every helper; mechanisms that lack this custody remain unsupported. Request labels and logical subagent names do not prove isolation.

## Principals and Admission

### Keep three identities distinct

| Identity  | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| Requester | The attributable actor who invoked the service.                                                |
| Owner     | The principal whose service authority supports the work and whose lifecycle policy governs it. |
| Workload  | The Agent execution performing operations, with its own applicable permissions.                |

The work record models user and service ownership, but initial execution admission supports only service owners. Unsupported user-owned work is rejected; it is not silently converted. Naming a service owner cannot bypass independent workload authorization or transfer a human's permissions. This is a proposed admission contract: an owner field alone neither supplies service authorization nor replaces an implementation's original-requester dependencies. The actual service-authority issuer and accepting path must be composed and qualified before claiming that behavior.

The access gateway verifies ingress identity and requested scope. OCC resolves existing principals and obtains invocation authorization from the selected IAM authority. OCC separately authorizes the service's work, referenced resources, data eligibility and purpose. Gateways and adapters neither own work admission nor choose another policy authority.

For example, Alice may be allowed to ask a review service to inspect an approved repository without holding the service's provider permissions. Admission must authorize both her invocation and that exact service access. Her identity supplies attribution, not an inherited provider session. Authorization covers the exact invocation, target and intended audience; a replay with a different actor, target or audience cannot reuse the original admission. Her private attachment and the report's intended recipients require separate data and audience checks.

### Preserve admitted dependencies

Admission records which requester, membership and session relationships remain conditions of the work, including cancellation ownership and dependencies. Requester withdrawal behavior is explicit admission policy, not a connector choice.

Session closure withdraws work explicitly bound to that session. Service-owned work may otherwise outlive the initiating session. A session reference cannot be omitted or relabeled to escape an admitted cancellation dependency, and changing the owner cannot preserve withdrawn user authority.

### Admit an explicit duration policy

An Agent may retain its identity indefinitely; that does not authorize an arbitrary process to run forever. A process, execution attempt and logical Work have separate lifetimes. Execution duration defaults to uncapped, meaning elapsed time alone does not end an attempt. Completion, cancellation, service stop, required-authority withdrawal and independently configured resource or spend limits still apply.

Admission resolves configuration and applicable Restrictions into an explicit immutable finite-or-uncapped selection. Restrictions may require or narrow a cap. A finite attempt cap runs from its original dispatch anchor, including startup and waiting; a configured absolute work horizon remains binding across attempts. Missing authority, or missing or unsupported persisted policy, denies execution. A creation-time default does not reinterpret existing records.

Uncapped work need not have an absolute work horizon. Every enforcement lease still has a finite expiry and fits every applicable work, ancestor, purpose, stop and withdrawal bound. Later draft edits, useful activity, reconnects and credential rotation cannot extend an admitted cap or horizon. Active-budget extension is outside this proposal.

### Keep the scope bounded

The proposal does not admit user-owned execution, human impersonation or cross-Namespace access. General scheduling, arbitrary detached delegation and a new IAM system are outside its scope. Logical subagents in one process are not isolated security principals. Offline application writes, historical-effect replay and guaranteed exactly-once provider effects are also excluded.

## Shared and Isolated Work

This broader profile is future scope. The MVP fixes one root Work per execution;
it does not dispatch different Work contexts through one reusable process.
Its admitted data/audience boundaries and qualified helper isolation still apply.

### Distinguish resource ceilings from data eligibility

OCC admits three resource/action ceilings. None grants permission on its own.

| Ceiling | Meaning and constraint                                                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `M`     | The Agent maximum. Every work ceiling must fit within it.                                                                                                                                                      |
| `B`     | The explicitly shared baseline, with `B` within `M`.                                                                                                                                                           |
| `W`     | One work's immutable ceiling. Shared baseline execution requires `W` within `B`; additional authority requires `W` within `M`, current admission authorization and a qualified isolated execution compartment. |

Private data requires protected isolation even when the requested operations fit within the shared baseline. Resource/action ceilings and provider scope do not settle whether state is eligible for sharing.

Admission records eligible data/state classes and the applicable membership epoch. Repository read access alone does not admit private prompts, attachments, memory or intermediate results into shared state. Membership changes must affect subsequent access under the selected freshness contract.

The [memory ACL proposal](https://github.com/openclaw/rfcs/pull/30) remains a separate resource policy. This proposal supplies no blanket permission to share memory.

### Qualify the compartment

A qualified compartment must prevent retained code or state from acquiring another work's handles, private data or authority. Request labels, different logical subagents and narrowed opaque handles do not prove isolation. Unsupported isolation denies the affected work.

A persistent shared Agent must distinguish work requested by different people. An old process cannot acquire a later request's permissions, and shared repository access cannot expose another person's private attachment. Changes to admitted permission scope follow RFC 0027's fresh-Pod path; narrowing a handle in an existing Pod does not replace that requirement. Work identity, runtime identity and permission to share data answer different questions.

## Durable Records

### Separate work, execution, leases and effects

OCC owns internal durable records attached to existing Agent and request identities. They do not introduce a user-facing execution resource between an AgentRevision and its workload. The selected profile needs root admission, the exact assignment, finite leases and durable operation receipts. Its lineage is root-only. General Work UI/API, independent child/attempt lifecycle and completed-result delivery remain later capabilities.

| Record                    | Required contents                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logical work              | Stable work ID; owner kind/principal; verified requester and provenance; Installation/Namespace; Agent/revision; selected authority; immutable resource/action ceiling and explicit duration policy with any original absolute work horizon; data class; purpose; audience; cancellation owner/dependencies; parent/ancestor references. |
| Execution assignment      | Exact current workload incarnation, generation and qualified compartment under RFC 0035's assignment contract.                                                                                                                                                                                                                           |
| Enforcement lease         | Work, assignment, accepting service and policy profile; authoritative issuance ordering; scope ceiling; absolute expiry and withdrawal bounds under RFC 0035.                                                                                                                                                                            |
| Operation receipt         | Original work, idempotency key, canonical request fingerprint, authorization observations, reserved allowance, submission state and external outcome reference.                                                                                                                                                                          |
| Completed-result delivery | Completed content identity, exact audience/destination, original finite horizon, cancellation relationships and original submission receipt under RFC 0037.                                                                                                                                                                              |

The work record also retains admitted provider selections and scopes. RFC 0034's broker access leases are distinct from enforcement leases and may only narrow those selections and scopes. Credential issuance and cleanup use separate operation identities correlated with business-operation receipts.

### Admit durably and close terminally

Durably record work admission before acknowledging it. Duplicate keys resolve to the same admission; conflicting inputs deny. An admission receipt proves neither tool dispatch nor completion and creates no implicit execution queue. General Work wire formats remain open.

The later Work lifecycle profile permits logical Work to span execution attempts under its admitted duration policy. The selected profile retains durable admission and effect history but does not offer coordinator-loss continuation across fresh attempts. A message acknowledgement, model response, certificate renewal, provider-token replacement or lost connection neither completes Work nor renews its authority. Completion, cancellation or Work's own configured expiry closes it terminally. Lease expiry ends only that lease's authority; an open Work still requires current authorization for renewal. Recovery cannot reopen closed Work, erase receipts or discard independent finalization and cleanup obligations.

OCC admits and closes work and authorizes bounded lease renewal. RFC 0035 owns enforcement-lease issuance and withdrawal; RFC 0037 owns execution, recovery and delivery lifecycle.

### Protect original-work origin

The GitHub gateway resolves a validated Agent access token to the original server-owned grant, Work, Agent and execution. Each request separately checks current IAM, assignment and lease authority. Caller-supplied Work IDs cannot retarget the grant. A copied live bearer can exercise that original still-authorized grant from a reachable location; it does not prove the presenter's container. Protected-origin authentication is a future profile, not a prerequisite for this bearer path. Other OCC and Kubernetes authentication boundaries remain unchanged.
