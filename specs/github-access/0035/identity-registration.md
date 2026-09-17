# Identity, registration and request verification

Part of the proposed [workload identity enforcement specification](enforcement-spec.md).
Pair these contracts with [authority leases and runtime qualification](authority-leases.md).

## Identity model

The target IAM subjects remain those of RFC 0027:

| Identity or account           | Meaning and authority                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Human `Principal`             | Existing OCC identity resolved from verified external identity; may approve publication when configured.                                |
| Automation `ServicePrincipal` | Explicit Installation- or Namespace-scoped automation subject with its own bindings.                                                    |
| Agent `WorkloadIdentity`      | One stable OCC-created IAM subject per Agent, shared across revisions; bindings are confined to its Namespace or exact resources there. |
| Execution assignment          | One admitted incarnation of that Agent; grants and leases retain its exact binding.                                                     |
| Optional X.509-SVID           | A certificate authenticating its registered execution subject; it grants no permission.                                                 |
| Kubernetes `ServiceAccount`   | Infrastructure identity backing the workload; its pod-bound token is the baseline runtime authentication credential.                    |
| Native OCE `ServiceAccount`   | Provider-agnostic account resource with an opaque credential reference; it is neither an IAM subject nor a Kubernetes ServiceAccount.   |

Current implementation persists the Agent's identity as an Agent-owned,
Namespace-scoped `ServicePrincipal`. `Agent.servicePrincipalId`, allocated as
`service-agent-<Agent ID>` and copied into revisions, references that record.
This supplies the design's stable `WorkloadIdentity` without a new identity type
or binding migration. General automation `ServicePrincipal`s remain distinct.

OCC must unambiguously resolve the Agent, stable subject, applicable bindings and
current assignment within one Namespace. Where selected, an execution SVID
resolves through the assignment to that stable role-bearing subject.

An assignment is internal, without a user-facing execution resource. Gateways,
registrars and cleanup services use their own narrowly authorized identities;
they cannot assume Agent identity. Agents cannot inherit human sessions, roles
or provider credentials.

## Authentication profiles

The GitHub gateway MVP selects an opaque Agent access token, invalid at GitHub,
under the [request verification contract](#request-verification). Independent
protected-origin authentication, including SPIFFE/SPIRE, is future scope for this
path.

Other OCC and Kubernetes authentication boundaries retain their contracts.
Installation configuration selects authentication; workloads cannot choose trust
roots. RFC 0027's pod-bound ServiceAccount-token profile remains the baseline at
its runtime boundaries. An optional X.509-SVID profile uses a certificate carrying
a SPIFFE identity. Kubernetes retains infrastructure authorization; IAM bindings
remain attached to stable OCC subjects.

Verification failure cannot switch profiles or admit another credential type.
Migration requires an explicit rollout, current assignment bindings and withdrawal
of the old acceptance path. Selecting SPIFFE for trusted services alone does not
select it for Agent-to-OCC authentication.

This proposal does not replace human login, OAG admission, IAMAdapter policy or
Kubernetes authorization. Cross-Installation federation and cross-Namespace
references remain outside its scope. Identity does not establish containment,
prevent all credential theft or prove physical termination from authorization.

## Stage requirements

RFC 0034's MVP supports mediated reads, direct push and minimal same-repository
PR creation. Each operation requires:

- A genuine root-work record identifying the verified requester, service owner
  and represented Agent, immutable admitted scope and finite-or-uncapped horizon,
  cancellation state and exact current execution assignment.
- A valid Agent access token resolving its original grant and online OCC
  authorization, with operation/effect attribution and provider credentials
  outside workloads.
- Subordinate helpers sharing the root work's execution context, authority,
  aggregate resource limits, cancellation and expiry, without independent
  admission or renewal. The runtime must demonstrate physical stop for every
  helper; otherwise only root execution is supported.

No broad Work API or child hierarchy is required. Unsupported independent
children are denied; root-only work needs no child lineage. Cancellation blocks
new dispatch; uncertain provider outcomes are recorded without blind replay.

Direct push and PR creation do not require a retained candidate or human approval.
[RFC 0034](../0034-github-app-credentials.md) owns their operation constraints and
the accepted destination-security gap. Approved-candidate publication is future
scope.

Full durable Work and independent children follow under RFC 0036, with the
[ancestry rules](authority-leases.md#lease-bounds-and-ancestry); user-facing Stop/Start follows under RFC 0037.
Active-session migration and effect replay are outside initial delivery.

## Execution registration

| Owner                           | Responsibility                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| OCC                             | Record admitted revision, stable identity, runtime assignment and lifecycle selection.          |
| ComputeDriver                   | Provision and observe the exact workload; supply protected execution evidence.                  |
| Constrained registrar and SPIRE | In the SVID profile, bind attested selectors to the server-selected subject and issue its SVID. |
| Transport verifier              | Validate selected authentication evidence; bind verification to its scope and lifetime.         |
| Accepting service               | Resolve current purpose and authorize the exact operation where it is accepted.                 |

Assignments record Installation, Namespace, participant kind, stable identity,
applicable revision, opaque assignment ID, execution generation, qualified
compartment and any selected registration reference. Restart or replacement
creates a fresh execution binding even with unchanged Agent, ServiceAccount or
Pod UID.
Compartment selection must enforce the admitted scope's shared-state or
isolation requirements. [RFC 0036](../0036-turn-bound-delegated-authority.md)
extends these to independent children; identity labels cannot prove isolation.

In the Kubernetes/gVisor profile, increases or decreases to admitted permission scope require a
fresh Pod/gVisor sandbox and assignment, plus a fresh SVID where selected;
another container in the old Pod is insufficient. Withdraw old dispatch authority
before admitting the changed scope. Retained processes, memory, credentials and
state cannot gain changed permissions in place. Workspace/context handoff requires scope and isolation
checks and excludes old authority and disallowed higher-authority data.

Multiple messages and turns may share one unchanged authorized context.
Cross-assignment reuse remains a future optimization requiring unchanged
effective authority and data scope, currentness, attribution and retained-state
isolation; comparing permission labels is insufficient.

### SVID registration

For this optional profile, registered SPIFFE IDs never rebind to successors.
Attested selectors must distinguish actual executions, including restarts; new
names with insufficient selectors cannot do so. Renewal preserves the binding. Old certificates resolve
only to their old assignments, even when still valid after replacement.

[RFC 0037](../0037-persistent-agent-runtime-lifecycle.md) observes OCC's canonical
assignment. Lifecycle intent has a separate generation: stop need not change
execution generation; replacement does.

Record registration intent before dispatch. The registrar uses its own authority
and protected Compute evidence, never the target's credential. Workloads cannot
choose subjects, parents or selectors. A timed-out create requires exact
reconciliation, not an unrelated registration.

Pre-activation registration grants no Harness, Channel or SecretBroker access.
Independently authorized readiness preserves RFC 0027's activation order.
Where work continuation is later supported, replacement still requires current
authority and fresh execution evidence; recovered work or an old lease cannot
authorize it.

## Request verification

### GitHub gateway bearer profile

Validate the Agent access token and resolve its original server-owned grant,
Agent, root Work and execution assignment. Reject caller-supplied identity fields
as substitutes. Check current IAM, Work, assignment and enforcement-lease authority
for every operation; unavailable authority denies dispatch. Connector and gateway
service identities cannot replace the represented Agent's authority.

The bearer authenticates its original grant, not the caller's container. A copied
live token can exercise that still-authorized grant from a reachable location;
it cannot rebind the grant to another Agent, Work or execution. RFC 0034 owns
[mediated operations and credential custody](../0034/github-app-v1-spec.md).

### Optional SVID profile

For each request at a boundary selecting this profile:

1. Validate configured trust, certificate validity and the expected X.509-SVID peer.
2. Resolve trusted registration and protected execution evidence to the exact
   assignment. Caller headers or serialized identity objects are insufficient.
3. Check permitted purpose: serving, bounded drain of admitted work, permitted
   control, or retained cleanup. Drain uses the original work ceiling and a
   finite deadline; it admits no new work. RFC 0037 defines the later Stop/Start
   flow. Purpose checks use current authority or a qualified enforcement lease.
4. Apply existing IAM, Restrictions, logical-work and effect constraints. The
   service owner, verified requester and executing workload remain distinct under
   RFC 0036. Authentication grants no permission.

The transport produces a process-local verification handle bound to its connection
and evidence lifetime. Copying its serialized fields does not recreate that
handle. This is an API integrity boundary, not proof that a certificate's private
key is uncopyable: ordinary TLS establishes key possession.

Where an operation requires proof of the originating execution, the selected
protected transport must establish that origin; a copied workload key alone is
insufficient. A profile that cannot provide the required proof remains unavailable
for that operation.

Selecting this future profile for GitHub mediation additionally requires protected
evidence of the represented Agent assignment, alongside the connector service
assignment and original Work with its [enforcement lease](authority-leases.md#lease-issuance-and-ordering).
