# Conformance and source status

**Status: Proposed.** This page defines the evidence needed to accept the recipe
implementation. It records requirements, not completed tests.

## Acceptance

### T-01 — Verify the recipe implementation

Run the actual startup and interpreter with the broker, selected IAM, genuine Work
and PostgreSQL State. Controlled tests may use explicitly identified external
services and synthetic credentials; adapters MUST NOT invent the composition under
test. Race tests must provide deterministic evidence of the order in which
competing actions took effect.

Use one active gateway, one pinned immutable version per bundle and one pinned
installed profile. Replica and horizontal-availability qualification remain deferred.

#### Load recipes and enforce their boundaries

Load GitHub and an independently authored synthetic non-GitHub recipe without changing OCE
code, across multiple Namespace connections. Before any effect, reject unknown
schemas or primitives, duplicate identities, invalid versions or configuration,
cross-Namespace sources, unsupported capability combinations and destinations.
Verify that audit records are produced and secrets stay within their authorized
boundary.

Dependencies:

- _[O-01–O-05: ownership](README.md#ownership-requirements)_
- _[R-01–R-06: recipe admission and execution](README.md#recipe-requirements)_
- _[D-01: retained records](protocols.md#bound-records)_

#### Keep repository listing unavailable

For GitHub and the synthetic non-GitHub recipe, verify that admitted definitions
omit listing selections, advertise `listResources: false`, and expose no listing
through the Git facade. Reject listing selections at startup and listing requests
before credential acquisition, upstream dispatch or other listing effects.
Positively exercise bounded explicit-locator enrollment, connection verification,
and normal Namespace and Work/IAM/grant checks. Preserve metadata for an enrolled
repository and Git `info/refs` discovery.

Dependencies:

- _[Closed V1 capabilities and listing refusal](README.md#closed-v1-capabilities)_
- _[ResourceAdapter future listing contract](interfaces.md#recipe-admission-and-operation-ports)_

#### Authorize the exact operation

Demonstrate a permitted operation and reject the wrong owner, resource, service,
audience, profile or generation, or a missing admission companion. Change policy,
membership and selection while preparation and commit are in progress. Verify the
ordering of native IAM changes with admission and rejection of stale instances. Reject external timeouts,
stale or missing evidence, and inadequate bounds on how current the evidence is.

Dependencies:

- _[D-02: authority binding](protocols.md#bound-records)_
- _[A-01–A-06: authorization and transaction ordering](protocols.md#authorization-and-submission)_

#### Enforce capacity and closure under concurrent requests

Make concurrent requests compete for durable mint capacity, retained inventory,
the original PR claim and aggregate limits. Race closure, reassignment, revocation
and connection changes against admission; race expiry and withdrawal against the
final submission gate. Unknown credential outcomes must retain their capacity
slots. An uncertain State transaction commit must never allow a submission permit to be
reconstructed.

Dependencies:

- _[A-03–A-07: admission and submission](protocols.md#authorization-and-submission)_
- _[B-02: GitHub capacity](README.md#backend-requirements)_

#### Preserve obligations through failure and replacement

Verify that cancellation, lost replies, crashes, identical-version restart,
aliases, rotation and retirement preserve original attempts and holds, independent
finalizers and original cleanup. Before an offline upgrade, verify that requests,
finalizers and cleanup obligations have drained, the predecessor has stopped and
retained records are compatible with the replacement.

Exercise credential issuance and check its outcome. Reject unavailable standing,
exchange, refresh,
workload and expiry-only recipe combinations before effects. Do not replay
an issuance, refresh, push or PR creation whose outcome is ambiguous.

Dependencies:

- _[L-01–L-06: credential lifecycle](interfaces.md#lifecycle-requirements)_
- _[A-07: the final gate and uncertain outcomes](protocols.md#authorization-and-submission)_

#### Execute the synthetic non-GitHub read

Execute an authorized bounded JSON read against an independently authored synthetic
service through the implemented issued-authentication contract. Its fixture data,
protocol and configuration MUST be invented for public conformance, without copying
any private provider's API, identity system, deployment or operational details.
Verify opaque IDs, nested case-sensitive names, explicit enrollment without listing,
identical IDs in distinct instances, and independent Git and collaboration-service
authority. Deny cross-service reuse of credentials, audiences and profiles.

Load its recipe through the same admitted data boundary from a separate fixture
package without editing OCE source. Exercise supported capability/version admission
and refusal of unsupported tuples. This proves the implemented generic recipe seam;
an out-of-tree executable adapter additionally requires the versioned composition
contract and qualification in Q-01 and Q-03.

Dependencies:

- _[B-03: second-backend conformance](README.md#backend-requirements)_
- _[D-01–D-02: records and authority bindings](protocols.md#bound-records)_

#### Keep signed capabilities out of ordinary data

Reject signed capabilities in ordinary schemas and Agent delivery. When a required
download bridge is absent, no child request or capability disclosure may occur.
An enabled bridge must satisfy both protected-child requirements before use.

Dependencies:

- _[C-01–C-02: protected custody and child admission](protocols.md#protected-children)_

#### Qualify GitHub through the ordinary Agent workflow

Against an admitted live GitHub repository, exercise metadata, clone/fetch, edit and
commit, authorized direct push, and helper-created same-repository PRs through the
ordinary Agent workflow. Verify that read-only access denies push and PR creation.
Verify scoped credential issuance, confirmed revocation and denial of later use.

Run this bounded workflow with the pinned installed profile, qualifying DNS, TLS,
network policy, isolation, credential confinement, closure and identical-version
restart. Retain installed artifact identity, repository, PR URL, head/base commits,
workflow effects and cleanup evidence. A controlled service cannot satisfy these
live GitHub criteria.

Dependencies:

- _[B-01: GitHub delivery](README.md#backend-requirements)_

Initial activation MUST also reject remote execution, streaming and delegation
before effects or capability disclosure. Remote acceptance belongs to T-03.

### T-02 — Keep each level of evidence separate

Record exact source, recipe and primitive digests, commands, substitutions and
outcomes separately for **source**, **controlled component**, **installed** and
**live provider** evidence.

Schema compilation, construction examples, hard-coded substitute adapters, mocked
State and documents MUST NOT establish real composition, durable ordering or higher
qualification levels. Synthetic services and credentials MUST NOT establish
compatibility with any real third-party provider. Remote harness results MUST NOT
establish installed isolation, credential confinement or streaming.

Live GitHub evidence MUST identify the installed artifact, admitted repository,
PR URL, head and base, workflow effects and cleanup.

## Before remote enablement

### T-03 — Qualify the remote implementation before use

Complete X-01–X-07 with a controlled execute/inspect/cancel harness. Exercise forged
references; incorrect peers, owners, audiences, generations and destinations;
malformed, oversized or secret-bearing results; concurrent duplicates and digest
conflicts. Cover cancellation before delivery, closure after admission, timeout
after submission, crashes and partitions at every durable transition, and tombstone
retention. Verify passive inspection and refusal of unavailable production and
streaming modes.

Installed remote DNS, TLS, network policy, isolation and credential confinement
MUST be qualified separately from the controlled harness before remote enablement.
Selected remote streams or delegation MUST add specialized acceptance before use.

Dependencies:

- _[X-01–X-07: external broker requirements](protocols.md#external-broker-requirements)_

## Before enabling other recipe modes

Local and remote modes have independent enablement gates. An enabled
protected-download bridge MUST exercise admission for ranges, retries and redirects,
currentness checks, destinations and aggregate bounds. An additional authentication
mode MUST verify every applicable lifecycle and admission transition, including
denial of ambiguous exchanges and refreshes. These checks do not require a remote
implementation.

Dependencies:

- _[C-01–C-02: protected downloads](protocols.md#protected-children)_
- _[L-02–L-06: authentication and credential lifecycle](interfaces.md#lifecycle-requirements)_
- _[A-01–A-07: authorization and submission](protocols.md#authorization-and-submission)_

## Source status

### S-01 — Public baseline and supplier code

The public baseline is `58d8ca2c75a21867c067d6c6a595dfe980a75184`.

#### Reuse the existing Driver contracts

Provider, Plugin and Secret boundaries already exist. `IAMDriver.authorize`
returns an asynchronous decision containing allow, reason, driver and evidence;
it supplies no policy version, deadline, epoch or transaction fence. A-01–A-06
require admission companions and a protocol that orders native IAM writers.

Dependencies:

- _[Driver contracts at the baseline](https://github.com/openclaw/openclaw-enterprise/blob/58d8ca2c75a21867c067d6c6a595dfe980a75184/packages/contracts/src/index.ts)_

#### Extend the existing State transaction owner

The UnitOfWork and audit transaction owner exist. Broker connection, grant and
attempt repositories and admission ports do not. Extend the existing repositories
and PostgreSQL persistence. Controller queue claims serve reconciliation; they
cannot supply genuine root Work or credential grants.

Dependencies:

- _[OCC State at the baseline](https://github.com/openclaw/openclaw-enterprise/blob/58d8ca2c75a21867c067d6c6a595dfe980a75184/packages/occ/src/state/platform-state.ts)_
- _[Controller queue at the baseline](https://github.com/openclaw/openclaw-enterprise/blob/58d8ca2c75a21867c067d6c6a595dfe980a75184/packages/occ/src/state/postgres-work-queue.ts)_

#### Reuse the supplier's issuer and custody contracts

The supplier provides `TokenIssuerV1`, `TokenRevokerV1`, `EphemeralTokenHandleV1`,
`GitHubAppTokenCustodyV1`, `GitHubAppMaterialV1.withJwt` and original-instance
settlement. They are absent from baseline main. Combined write-profile support and
reviewed composition remain required.

Dependencies:

- _[GitHub proposal #136](https://github.com/openclaw/openclaw-enterprise/pull/136)_
- _[Issuer contract at revision `cb4cd731`](https://github.com/openclaw/openclaw-enterprise/blob/cb4cd731632d2968693fb55be22d274a2f634c20/packages/contracts/src/token-issuer-v1.ts)_

#### Preserve the already assigned broker responsibilities

The platform design already names Namespace `SecretBroker` with implementation
deferred. The GitHub RFC assigns its responsibilities and proposes
`CredentialGatewayDriver` composition. The owner reference distinguishes these
prior responsibilities from the proposed internal interface shapes.

Dependencies:

- _[SecretBroker in the baseline platform design](https://github.com/openclaw/openclaw-enterprise/blob/58d8ca2c75a21867c067d6c6a595dfe980a75184/docs/design/resources.md#L93)_
- _[GitHub RFC at `f3d7a613`](https://github.com/openclaw/openclaw-enterprise/blob/f3d7a613d66823bf4dd494e44ecf4428a9947c01/specs/github-access/0034/credential-broker-v1-spec.md#scope-and-ownership)_
- _[Interface ownership](interfaces.md#owner-reference)_

The interpreter, shared broker implementation, admission companions and remote
bridges remain proposed. Source availability MUST NOT establish installed or
provider qualification.

## Open decisions and excluded scope

### Q-01 — Settle the remaining contracts before implementation

Use internal OCC records and a minimal authorized administrator workflow for the
initial implementation. Preserve Namespace ownership, IAM authorization and audit.
Public `SecretBroker` management is a later roadmap item.

Before implementation, define the internal record schemas, administrator operations
and admission details, and concrete schemas and parameters for the closed V1
inventory. Fix immutable registration, persistence, activation and retained-record
compatibility checks; the closed management and external-operation IAM vocabulary
and Restrictions; and retention, deletion and reference rules. Define the versioned
provider-neutral composition and schema contracts, compatibility checks and
conformance harness needed for out-of-tree provider implementations.

Before enabling an additional authentication mode, fix its persistence rules,
including refresh-family rules where applicable.

Dependencies:

- _[Closed V1 capabilities](README.md#closed-v1-capabilities)_

### Q-02 — Settle the remote implementation's bounds

Remote execution and its control harness remain deferred. If a selected backend
requires them, specify exact operations and the upstream privilege ceiling; finite
resource, clock, durable-store and recovery bounds; and qualify any selected
streaming, protected-download or credential-delegation bridges before enablement.

### Q-03 — Qualify each third-party provider separately

Each real third-party provider implementation requires its own qualification. Its
implementation, configuration, provider-specific design and evidence may remain in
a private repository. Public OCE defines the generic contract and acceptance levels;
it does not identify private deployments or publish their operational details.

Before enablement, establish supported clients and endpoints, identity and audience,
permissions, provider lifetime and revocation, destination constraints and audit
contracts in the implementation's own documentation. Preserve OCE Work/IAM admission,
exact operation authority and independent Git/collaboration authentication. Qualify
any additional authentication or transport mechanism before enabling it.

The GitHub delivery retains the synthetic non-GitHub read and does not depend on a
real third-party service or its credentials. Separate provider qualification MUST
exercise each advertised capability through the actual admitted adapter, shared
lifecycle and installed enforcement. Unsupported capabilities remain unavailable.
Marketplace, configuration UI and Agent mTLS remain outside this MVP.

## Roadmap

- _Repository/resource listing and pagination:_ implement discovery adapters,
  bounded cursor schemas and lifecycle, discovery UI and positive qualification
  separately. Retained future interfaces do not enable listing in MVP; preserve
  the [unavailable-capability checks](#keep-repository-listing-unavailable).
- _Public `SecretBroker` management:_ add the public resource schema and management
  API after the minimal administrator workflow, preserving the
  [existing ownership boundaries](interfaces.md#owner-reference).
- _Remote execution:_ implement the runtime and control harness only when required
  by a selected backend, with the [remote acceptance requirements](#before-remote-enablement)
  met before enablement.
