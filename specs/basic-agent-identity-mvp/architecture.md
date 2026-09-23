# Agent identity architecture

[Overview](../basic-agent-identity-mvp.md) · [Interfaces](interfaces.md) · [Delivery](delivery.md)

The proposed architecture connects an admitted execution to each protected
request. Preparing that execution is a deployment lifecycle. Authorizing an
ordinary invocation is a separate lifecycle, repeated for each human request.
Both meet at the receiver before a credential or upstream operation is created.

## Components and dependencies

OpenClaw Control Plane (OCC) admission selects trusted operator policy and saves
it with the Agent's immutable revision in original State. PostgreSQL owns resource,
Work and audit persistence. Production [API and worker Deployments](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/deploy/helm/openclaw-enterprise/templates/deployments.yaml)
run separate controller processes. The optional `RepoDriver` is an internal
adapter. When enabled, the credential service runs as a separate process and
container in the worker Pod, with a private Unix control socket and HTTPS service.
Compute owns Agent workloads, delivered material paths and runtime objects.
App signing keys and provider tokens remain with the credential service.

OCC and State retain the Agent and its immutable revision.
The existing Namespace-scoped Agent ServicePrincipal identifies the Agent across
revisions. Selected IAM resolves that identity and decides exact resource
permissions. This proposal extends actual admission and identity lookup rather
than adding another principal kind.

State and Compute own execution assignment and observation. An assignment names
the execution expected to serve one Agent component. An incarnation identifies
the actual workload instance Compute observed. Readiness reports whether a
prepared workload is ready. Current-serving selection is the separate
authoritative choice permitting ordinary protected use.

The initial issuer for the later protected profile is operator-managed SPIRE. A constrained, separately
authenticated registrar registers only the assigned identity. SPIRE delivers
rotating X.509-SVIDs through the selected Workload API profile. Those identities
authenticate workloads but do not grant repository or model permissions.

Compute prepares one egress-owned trusted Go service per execution assignment.
The [selected egress architecture](https://github.com/openclaw/openclaw-enterprise/blob/b1504a75d83bc8fa4b831630dc8080ae99df5758/specs/31-basic-egress-proxy/architecture.md#components-and-dependencies)
places that service in a trusted proxy Pod, separate from the untrusted Agent Pod
and its network identity. This keeps the proxy's upstream grants outside the
workload. In the complete protected profile, the proxy mediates the dedicated
Harness's protected traffic. The separate trusted Agent Gateway retains its own
enrolled identity and receives no repository session.

Egress owns private ingress, the accepting listener, and its authenticated bridge
to the existing verifier and operation owners. Identity owns verification and
currentness. The credential owner retains acquisition, exchange, injection,
renewal, and settlement. These responsibilities do not imply a new service for
every interface. The concrete C3 [receiving-peer selection and authenticated
Go/TypeScript bridge](https://github.com/openclaw/openclaw-enterprise/blob/b1504a75d83bc8fa4b831630dc8080ae99df5758/specs/31-basic-egress-proxy/interfaces.md#receiving-bridge)
remain decisions for the egress, identity, and receiving-operation owners.

The [main owner contracts](interfaces.md#execution-and-registration),
[verification supplier](interfaces.md#verified-workload-evidence), and
[repository supplier](interfaces.md#repository-session-binding) are separate
source inputs. Genuine registration, current-serving resolution, Agent admission,
and receiving producers still have to connect them. An unconditional unavailable
resolver is safe refusal, but cannot complete the selected consumer.

## Assignment and serving

State and Compute own the opaque execution reference, generation, exact
Agent/revision/principal/component, observed incarnation, original lifetime, and
current or retired state. At most one execution generation may serve each Agent
component. Preparation must follow this order:

1. Allocate a pending execution from the admitted immutable revision through the
   existing State lifecycle. Compute prepares and independently observes the actual
   Harness and relay while protected traffic is disabled. State binds that observed
   incarnation. Pod UID, container incarnation, restart discrimination, and runtime
   selectors remain Compute-adapter facts.
2. The registrar creates the exact assigned identity using the operator's trust
   domain and parent, with selectors derived from trusted observation. Preserve the
   original create identity and exact registration cleanup ownership. Resolve an
   uncertain create by readback before proceeding.
3. Persist an immutable execution-bound repository attempt before opening and
   recording its session. Recover or read back that same attempt when necessary.
   Deliver material through `RepositoryCredentialRuntimeBinding` to the actual
   Harness. Open, status, and recovery must retain identical execution expectations.
4. Verify that delivery left the observed incarnation and material unchanged.
   Exercise the actual managed Git/`gh` shim and PATH route. Material changes can
   restart workloads, so reversing worker calls alone cannot establish this order.
   An open session cannot be rebound, and temporary compatibility is forbidden.
5. Run the real protected authentication probe under a separately admitted
   bootstrap purpose. The purpose and material-before-serving mechanism remain
   [owner decisions](interfaces.md#observations-and-owner-decisions). Probe success
   and readiness do not select the serving execution.
6. State and Compute serialize authoritative current-serving selection with
   predecessor withdrawal before enabling ordinary protected use. Resolve from
   current State selection, the bound incarnation, fresh Compute and registration
   evidence, the admitted profile, the original deadline, and current IAM.

A relevant restart or replacement requires fresh execution evidence. Replacement
closes the previous attempt and admits a new one. Retirement is terminal for that
generation, even if its certificate has not expired. Dedicated delivery must join
actual Harness readiness, generation replacement, and retirement before the full
composition can qualify.

## Request lifecycle

![Proposed identity request and withdrawal lifecycle](request-lifecycle.svg)

This proposed repository-operation example excludes the separately required
[protected model and probe qualification](delivery.md#complete-contribution).
Time flows downward, solid arrows are requests, and dashed arrows are replies.
Mirrored actors mark the same boundaries at the bottom.
[Editable Mermaid source](request-lifecycle.mmd).

An authenticated personal request or authorized team mention supplies an admitted
connection and complete response audience through the [RBAC proposal](https://github.com/openclaw/openclaw-enterprise/pull/245).
Its `AgentAuthorityContext` and `AgentInvocation` retain the original grant,
connection, exact scope, audience, authority generation, and absolute deadline.
The actual Harness turn must remain authentically associated with that invocation.
Shared execution, session bearers, and caller-provided invocation IDs cannot
identify its requester.

The Harness uses the relay's independently enforced private ingress. The receiver
must consume [verified workload evidence](interfaces.md#verified-workload-evidence)
from that exact request and live connection. Before repository acquisition or
dispatch, it independently checks current identity and
[exact operation authority](interfaces.md#currentness-and-expiry).

The receiver must apply the [post-wait and final synchronous fences](interfaces.md#currentness-and-expiry)
before effects or authority-sensitive delivery.
Results may leave only for the currently authorized complete audience. Ambiguous
request association denies dispatch and delivery. Durable dispatch and reply
fences survive audit erasure, and an unknown start or send never authorizes replay.
Per-invocation cancellation, or the existing exact-revision containment fallback,
must preserve those boundaries.

## Availability and tradeoffs

The [landed repository integration](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/docs/reference/repository-credentials.md)
supports embedded OpenClaw with API-key Harness authentication, bearer sessions
and no Sandbox. Dedicated repository-bearing revisions remain unsupported.
That maintained path does not establish the proposed dedicated execution binding
or installed protected identity. See the [dated source distinction](delivery.md#current-source-and-proof-status).

| Selection                                                                     | Required behavior                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Omitted Installation configuration                                            | Retain compatibility, existing tool authentication, IAM, and repository-session checks. Claim no verified-execution assurance. |
| Operator-selected enforcement                                                 | Pin the selection in the admitted revision and operation/session. Require supported binding and genuine evidence producers.    |
| Missing or stale evidence, unsupported enforcement, or unavailable dependency | Deny protected use. Request inputs and outages cannot downgrade the selection.                                                 |

Profile changes require fresh revision admission. **Proposed transition policy,
owner decision pending:** separate prospective default changes from explicit,
audited withdrawal when a minimum strengthens. Installation/product and admission
owners must select finite supported combinations, affected revisions and sessions,
renewal eligibility, the effective event, and the unavailable result. No grace
period or automatic continuation is accepted. Stronger claims require fresh
admission.

Operator-managed SPIRE narrows initial packaging work while preserving the same
consumer contract for later OCE management. An optional embedded repository
checkpoint can establish a useful real consumer earlier. It cannot waive the
dedicated Codex, separate Gateway, qualified gVisor, or protected model outcome.

## Withdrawal and recovery

The initial policy milestone reads the saved revision requirement after restart.
Only historical omission becomes compatibility. Malformed present state refuses.
The worker preserves original reconcile Work, ownership, live-claim fencing,
IAM and Provider checks, then allows separately authorized stopped cleanup.
Unsupported running recovery permanently reports `IDENTITY_RUNTIME_UNSUPPORTED`
before repository, Secret, workspace or Compute preparation.

Admission and renewal participate in the original READ COMMITTED State
transaction. Acquire locks in this order: Installation, sorted account/session
guards, the complete IAM policy barrier and head, assignment/resource/withdrawal
rows, then audit. Preserve policy-writer and account-currentness ordering. Never
upgrade policy locks after resource locks. The [RBAC transaction owner](https://github.com/openclaw/openclaw-enterprise/pull/245)
defines the common protocol.

Register protected admission and durable withdrawal intent before COMMIT. Release
committed authority only after acknowledged COMMIT or exact authorized retained
receipt/readback. Its atomicity covers State mutation, audit and durable Work
intent. Kubernetes, SPIRE and provider effects remain outside that database
transaction. Extend the existing owners without a parallel IAM, account,
invocation, authority-lease, credential, or audit store.

Retain original create-effect and operation identities and exact version checks
across retries. Uncertain assignment COMMIT requires exact readback. Uncertain
registration create or delete also requires exact readback, never a duplicate
create or deletion of an unrelated registration. Recovery does not invent a new
deadline or revive retired authority.

Invalidate receiving authority synchronously before awaited cleanup. Idempotent
close joins owned I/O and provider settlement, including completion after a
bounded response has timed out. The owner retains unsettled custody and capacity
until actual settlement. Registrar, Gateway, and cleanup authenticate using their
own enrolled identities. Separately authorized preparation and exact cleanup need
no live SVID from the target Agent.

Requested stop, observed stop, registration retirement, connection closure,
session closure, provider cleanup, and uncertain upstream effects are different
outcomes. Delete acknowledgment, a missing Pod, timeout, or unreachable node cannot
prove physical termination. Report unavailable or termination-unverified until
the exact bound incarnation is observed stopped. Already accepted upstream work
may complete after local closure. [Security limits](security.md#accepted-limits-and-closure)
and [delivery evidence](delivery.md#acceptance-evidence) retain the resulting gaps.

The [current repository recovery contract](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/docs/reference/repository-credentials.md#repo-driver-contract)
has its own knowledge boundary. Worker restart can retain surviving service
sessions and Compute material. Service replacement can lose bearer knowledge and
provider-token cleanup inventory. State retains attempt identities and deadlines,
which cannot reconstruct that inventory. Missing exposed sessions fail with
`REPOSITORY_SESSION_RECOVERY_UNSAFE` and retain cleanup Work. Known closing
sessions block same-revision replacement with `REPOSITORY_CLEANUP_PENDING` until
`DISPOSED`. A new authorized revision settles neither old cleanup nor uncertain
Git/API effects. Uncertain writes are never automatically replayed.
