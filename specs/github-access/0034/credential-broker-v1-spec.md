# Credential Broker v1 Specification

This shared contract supports [RFC 0034](../0034-github-app-credentials.md), the provider-specific [GitHub profile](github-app-v1-spec.md), and [recovery and qualification](lifecycle.md).

Status: draft; upstream OCE implementation is not claimed. **Must** identifies a conformance requirement.

## Scope and ownership

V1 manages credentials for admitted external access through an internal issuer behind the Namespace-scoped `SecretBroker`. It adds no public Token, Lease, Issuer, or permission resource. OCC identities, resource authorization, workload assignments, and the logical work records proposed by RFC 0036 remain authoritative.

| Owner                              | Responsibility                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC/IAM                            | Sole platform authorizer; configuration, resource lifecycle, canonical execution assignments, and current operation decisions.                                             |
| Proposed `CredentialGatewayDriver` | Installation-selected composition of mediation and broker/issuer lifecycle through admitted handles. See [configuration and Driver contract](repository-configuration.md). |
| SecretBroker                       | Consume authorization; coordinate protected custody, inventory, delivery/use, and cleanup.                                                                                 |
| Issuer                             | Perform authorized provider operations.                                                                                                                                    |
| `SecretDriver`                     | Manage backend storage. Protected custody and durable inventory also require the guarantees below.                                                                         |
| `ServiceAccountDriver`             | Provision accounts.                                                                                                                                                        |

Trusted platform services host the broker, issuer, and protected-material client outside Agent execution. The standalone TypeScript credential gateway is distinct from the Agent messaging gateway and cohosts mediation, broker, custody and local issuer. Ship one active process with durable PostgreSQL inventory and claims, using OCC/IAM and State transaction owners. Observe predecessor termination before replacement; downtime is accepted. HPA, failover and overlapping rollout are deferred; controller admin endpoints carry no Git traffic.

The issuer interface is local. Protected handles have no public constructor, serialization, or workload-facing byte accessor. Remote execution and its control harness are deferred. Brokers need no dedicated process per Agent or provider. Concurrent requests and restart require durable authority, capacity and outcomes; process-local maps cannot replace State.

Signing or forwarding with existing credentials may reuse these authority and custody boundaries but needs separate operation contracts. V1 does not migrate model or ServiceAccount credentials.

### Backend recipes

Administrators admit constrained JSON recipes with closed schemas, finite
operation tables, fixed mappings and bounded projections. Recipes select exact
implemented service/operation/profile/authentication/lifecycle combinations;
no scripts, callbacks, expressions, imports or arbitrary destinations. Core owns
validation, encoding, canonical identities, protected authentication, dispatch
and cleanup. Its opaque operation handles cannot be forged through brands,
caller digests or serialization.
New wire capabilities require reviewed primitives, not executable recipe code.

The Installation admits recipes and primitives. Namespace-scoped connections pin
upstream identity, endpoints/trust, generation and protected references; separate
OCE grants authorize use. Discovery and recipe registration grant no authority.
Canonical upstream resource/credential-authority holds survive connection aliases,
schema changes and key generations without permitting cross-Namespace access.

Pin one immutable version per bundle, including recipe, interpreter, primitives,
schemas and configuration provenance. Multiple bundles and connections are allowed.
Identical-version restart verifies retained provenance, records and custody keys;
missing semantics or material deny readiness and new use. Retirement stops new
admission while the original implementation retains inspection, revocation,
expiry accounting and cleanup through `cleanup-only` registration. Refuse
replacement/removal while obligations need it.
Offline upgrade requires verified request/finalizer and obligation drain, observed
predecessor stop and compatible retained records. Preserve holds, provenance,
deduplication, audit, safe results and unknown outcomes; never delete records or
keys to manufacture drain. Concurrent versions and migration tooling are deferred.

Load GitHub and an independently authored synthetic non-GitHub recipe through
actual startup and broker/State/IAM/Work without an OCE source edit. Require a
positive controlled operation using an implemented authentication mode; synthetic
credentials do not qualify any live provider. Provider-specific recipes and
implementations may be maintained in separate repositories. Their location does
not relax admission, current operation authority, protected custody or lifecycle
requirements; recipes still select only implemented trusted primitives. Unavailable
authentication, download and remote modes deny before effects. Additional
production providers and remote-broker runtime/control-harness qualification are
deferred.

### Contracts consumed from the RFC series

Use [RFC 0035's execution-assignment contract](../0035-workload-identity-and-runtime-authority.md), [RFC 0036's original-work grant](../0036-turn-bound-delegated-authority.md), and [RFC 0037's stop/replacement semantics](../0037-persistent-agent-runtime-lifecycle.md). These remain draft dependencies. The [series overview](../0027/runtime-access-overview.md) is informational. Credential mediation needs their required semantics, not the entire completed-context recovery feature or an automatic switch to SPIFFE for Agent-to-OCC authentication.

| Contract                           | Meaning for the broker                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical execution assignment     | OCC owns one assignment and generation. Broker bindings and runtime observations reference it; the broker cannot independently choose the current execution.                          |
| Logical work                       | RFC 0036 owns service-owned work, immutable scope and any configured horizon, requester provenance, and child lineage.                                                                |
| Enforcement lease                  | RFC 0035 owns bounded enforcement authority and its issuance/withdrawal protocol.                                                                                                     |
| Invocation and provider permission | Requester invocation authorization is separate from service/workload provider permission. Provider effects do not use an ambient intersection with the requester's human permissions. |
| Data and audience                  | Data eligibility and result audience require their own checks.                                                                                                                        |
| Preparation and cleanup            | Preparation uses a separately admitted control purpose; cleanup uses independently retained platform authority.                                                                       |

The MVP requires genuine root Work, immutable Agent/revision/assignment binding,
current per-operation authorization, cancellation/withdrawal, protected custody,
and durable operation outcomes. An interface declaration or record ID cannot
supply missing authority. The MVP may qualify root-only execution first;
subordinate helpers require the same qualified context, scope, and cancellation.
Separately admitted durable children and user-facing lifecycle controls follow
later. Deferring those features does not defer the minimum authority or
cleanup contract.

The broker's access lease references the original logical work and digest, exact admitted repository grant, and current execution assignment. It can only narrow that authority. Logical work may span turns; a broker access lease cannot change its work or assignment. Early replacement retires the old assignment and admits fresh Work after current authorization and predecessor termination evidence. Continuing the same Work across execution replacements requires a later qualified profile, fresh assignment authorization, and new access leases. Old assignment leases remain closed.

Business-operation receipts, credential-issuance records, and lifecycle operations have distinct identities and owners. Link their references so a token refresh, reconnect, or runtime replacement cannot create another attempt at an uncertain business effect. An issuance result is not the result of the business request that needed it.

## Configuration and admitted records

These internal, versioned records use existing OCC identifier codecs and add no API routes. Resolve references in trusted storage, never as caller-supplied URLs. Reject unknown versions, unknown authority-affecting fields, unsupported modes, and unbounded inputs before effects.

| Record              | Required contents and owner                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer binding      | OCC: Installation and Namespace, exact broker and Secret references, selected issuer implementation/profile versions, protected provider-account binding, configuration generation, and enabled state. No key or token bytes.                                                                                                                   |
| Admitted access     | OCC: immutable internal `admittedAccessRef`, Agent/revision, binding/profile versions, provider-typed resource and permission grant, allowed mode, purpose, explicit finite-or-uncapped access ceiling, and limits. Its digest commits these fields. Current policy may narrow or revoke it.                                                    |
| Admission selection | OCC: selected admitted-access references, supported narrower permissions, and horizon. Selected IAM authorizes invocation separately from service/workload access. Session references retain provenance and any explicit cancellation relationship.                                                                                             |
| Logical work        | Reference to RFC 0036's authoritative service-owned work and immutable digest: original selection, owner and requester, admitted-access references, scope/horizon, and child lineage. A model turn or connection does not define its lifetime.                                                                                                  |
| Enforcement lease   | OCC authority: bounded permission for exact work, assignment, receiver, operation profile, and original absolute deadline, with issuance ordering and withdrawal evidence. The broker cannot issue or extend it.                                                                                                                                |
| Execution binding   | Reference to OCC's canonical assignment and execution generation, exact Agent/revision and incarnation. Runtime work requires a protected link to its original work and child/request channel.                                                                                                                                                  |
| Access lease        | Broker: immutable original work or preparation identity, execution binding, exact admitted-access reference and digest, scope ceiling fixed at admission, current generation/version, finite deadline within every configured original work/purpose horizon, and `open` or `closed` state. It grants no use beyond valid enforcement authority. |
| Issuance record     | Inventory: stable operation and provider-attempt identities, intent digest, original lease/binding/generation, provider outcome, protected material references, actual expiry/scope evidence, delivery state, and cleanup state.                                                                                                                |

### Binding changes and enrollment

Binding changes cannot silently retarget active revisions. Planned key rotation must:

1. Stage protected material and verify the same provider account.
2. Atomically select the new generation and close affected leases.
3. Require newly admitted revisions and leases pinned to the verified generation before further use.

Failed verification leaves the binding unchanged and must be reported. Independently authorized emergency disable can close access immediately. Retain issued-token/revocation material and cleanup records until obligations finish. Retiring a source key is separate from token revocation.

Enrollment reports `unverified`, `ready`, `disabled`, or `degraded`, with bounded reason codes. `ready` requires verified provider binding, available protected custody and inventory, and a supported issuer profile. It neither grants access nor mints tokens; workload readiness and mode qualification remain separate.

## Current authority and workload origin

For each issuance, delivery, and mediated operation, the broker must authenticate the caller and enforce OCC/IAM and runtime authority for:

- the exact Installation, Namespace, Agent, revision, broker, Secret, and protected provider binding;
- the admitted execution incarnation and original logical work, or separately admitted preparation purpose;
- the permitted resource/operation intersection, binding/profile versions, lease generation, and deadline;
- every applicable restriction and required audit decision.

Agents use their explicitly granted service/workload authority. Human roles, sessions, provider credentials, and permissions do not transfer to Agents. Requester permission to invoke the service is checked at admission and other explicitly selected invocation boundaries, not used as ambient provider authority on each effect. Missing required evidence denies. Preparation requires separate admission and cannot fabricate logical work or use a runtime lease.

### Current decisions and bounded read continuity

Every GitHub dispatch requires current online OCC/IAM, Work, assignment and
lease authority, including reads, issuance and maintenance. Existing tokens and
unexpired leases do not permit offline dispatch. Missing authority, storage,
clock or withdrawal evidence denies. Already accepted effects and independently
authorized cleanup retain their original owners and outcomes. Offline read
continuity requires a separate future contract and qualification.

### Scope, narrowing, and recovery

Effective access intersects service/workload authority, admitted revision grants, the original work selection, and applicable restrictions, using current online decisions. Each work/assignment receives fresh access leases for its exact selected grants. Every `beginAccess`, including the first for a grant, requires current authority and checks the retained original selection. Policy recovery permits use only within unchanged scope and still-open authority; it cannot reopen a closed lease.

Enforcement expiry stops dispatch without itself completing logical work. Current authority may issue fresh enforcement evidence for still-open work and an eligible assignment; an independently unexpired, open broker access lease may then serve it. This does not reopen an expired enforcement lease, a closed access lease, or completed work.

The lease ceiling and GitHub token profile are immutable. Current policy may
narrow or deny operations without changing that profile; reads under a read-write
grant still use its write token. Preparation uses its own read-only grant.
Changing the admitted repository, profile or Work context requires fresh
admission/execution and a fresh Pod/gVisor sandbox. Closed or cleanup-only
credentials cannot return to use; old inventory and target holds remain charged.

Existing Work and renewals cannot exceed the original selection. Work closure
closes its leases; a session or turn ending does so only under an explicit
lifecycle relationship. Observed predecessor termination is required before
successor writes. Replacing a container alone cannot serve changed authority.

### Protected work attribution

The validated Agent bearer resolves its original server-owned Work and exact
execution binding. Possession does not prove physical origin, and copied live
tokens may exercise that original grant. Caller-supplied Work IDs or later
mutable context cannot retarget it. One immutable root Work per execution avoids
mixed-authority reuse; stronger origin authentication remains future scope.

### One effective grant, two enforcement points

Issuer permission selection and mediator request checks must derive from the same versioned grant and original selection. GitHub token selection remains fixed while current authorization may narrow operations. A trusted protocol adapter validates each request and supplies canonical resource identities, operation, policy-relevant arguments, and an immutable request digest. Current online OCC/IAM authorizes those facts; the broker consumes the exact effect permit at dispatch. Caller labels and parsed data confer no authority.

Each supported provider operation must declare required permissions, constraints, read/write behavior, and uncertain-outcome handling. This protocol catalog has no policy authority. Unsupported constraints deny admission or the affected operation. Permission failures cannot trigger broader credentials, another account, or a less restrictive mode. Wider grants require authorized admission and new work.

### Persistent processes and background work

A process may persist across turns under its original Work. Lease closure denies new credentialed effects and starts cleanup even if a process or connection survives. Neither survival nor later work renews closed authority. Workspace replacement requires Compute to observe previous writers stopped.

#### Reusable workers (later profile)

The MVP binds one immutable root Work to each execution; general multi-Work dispatch is deferred. A later reusable worker must bind each request to separately admitted Work. Permissions cannot carry forward, and private data or additional authority requires qualified isolation.

#### Long-lived work and attached children

Service-owned Work may outlive a turn within its original immutable scope and
configured horizon. Work/execution may be explicitly uncapped; leases, credentials
and operations remain finite. Helpers require qualified shared root context,
aggregate limits and cancellation ownership. Independently admitted durable
children and completed-result delivery remain future contracts.

RFC 0036 owns admission and cancellation; RFC 0037 owns construction and observed
stop. The broker cannot invent Work or detach helpers. Outcome finalization is
mandatory independent cleanup, not optional completed-result delivery.

#### Required dispatch boundary

Bind every request to the execution's immutable root Work and deny after closure.
Mutable turn pointers and caller-selected handles cannot retarget authority.
Qualify concurrent and queued requests, cancellation, reconnect and restart in
this context. General dispatch across Work contexts requires later isolation
qualification; request labels cannot supply it.

## Related specifications

- [Credential Broker Operations and Recovery](credential-broker-operations.md)
