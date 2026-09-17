# Interfaces and credential lifecycle

**Status: Proposed.** This page defines internal composition ports for the
[RFC](README.md). Existing contracts are identified against the pinned
[source baseline](conformance.md#source-status). Proposed ports still require
implementation; supplier code is available outside that baseline.

## Owner reference

### Existing platform and RFC owners

The platform design already names a Namespace-scoped
[`SecretBroker`](https://github.com/openclaw/openclaw-enterprise/blob/58d8ca2c75a21867c067d6c6a595dfe980a75184/docs/design/resources.md#L93),
with implementation deferred. The [GitHub RFC's broker contract][broker-spec]
assigns it protected custody, inventory, delivery/use and cleanup. This RFC
refines those responsibilities into internal ports.

The GitHub RFC also proposes an Installation-selected
[`CredentialGatewayDriver`][gateway-driver] to host mediation, compose the broker
and issuers, and own startup, quiesce, recovery and disposal. The recipe ports
below belong within that proposed composition. `CredentialBroker` names its
internal broker interface; `SecretBroker` remains the designated Namespace resource.
The initial implementation uses internal OCC records and a minimal authorized
administrator workflow, preserving Namespace, IAM and audit boundaries. Public
`SecretBroker` management and its resource schema are on the [roadmap](conformance.md#roadmap).

Reuse these implemented baseline contracts:

- **`IAMDriver`:** preserve `lookupIdentity` and `authorize`. Extend the selected
  implementation with the admission companion below; asynchronous authorization
  alone does not provide the required fence.
- **`PlatformStateStore`, `PlatformUnitOfWork` and Audit:** reuse `read`,
  `transact` and `uow.audit.append`. Extend their repositories and PostgreSQL
  persistence for connection, grant, attempt, capacity and closure changes,
  atomically with admission. They remain the database and transaction owners.
- **`SecretDriver`:** preserve `create`, `update`, `delete` and `resolve`.
  `resolve` returns safe references, never plaintext.
- **`Provider<Client>`:** preserve configuration, authenticated `client` and member
  `drivers`. It supplies no broker admission method. Preserve Plugin/ServiceAccount
  ownership of the Agent catalog and account credential delivery.

### Broker and access ports

These proposed interfaces organize existing RFC responsibilities; they are not
implemented baseline contracts.

**`AccessOwner`** groups the GitHub RFC's existing
[`beginAccess`, `renewAccess` and `closeAccess` operations][broker-operations]:

- `beginAccess(context, operationId, delivery, bounds)`
- `renewAccess(context, accessId, operationId, bounds)`
- `closeAccess(closure, operationId, bounds)`

They admit, renew or close access from genuine Work/IAM context and return safe
receipts. The interface grouping and parameter shapes are proposed here.

**`CredentialBroker`** gives the existing broker responsibility a proposed
internal interface for the single lifecycle below:

- `prepareAuthentication(operation, bounds)`
- `admitDispatch(operation, slot, authentication, bounds)`
- `execute(permit, operation, bounds)`
- `finish(finalization, outcome)`

### Recipe admission and operation ports

These are proposed generic data and method shapes for the RFCs' recipe admission,
connection verification and trusted protocol-adapter responsibilities:

- **`BackendDefinition`:** OCC-admitted JSON identity, schemas, fixed capability
  selections and bounded operation parameters; no methods or executable validators.
- **`BackendRegistry`:** OCC's `register(installation, definition, mode)` validates
  and pins every implementation before activation. `resolve(installation, identity)`
  returns the exact admitted definition. Cleanup-only registration cannot acquire
  or use credentials.
- **`RegisteredBackendDefinition`:**
  `verifyConnection(connection, bounds)` verifies upstream identity through
  admitted protected transport. Success grants no resource access.
- **`ResourceAdapter`:** `resolveResource(connection, locator, bounds)` returns
  canonical identity for an explicit bounded locator.
  `listResources(connection, cursor, bounds)` is a future contract for bounded,
  separately authorized discovery. Its cursor/result schemas do not enable listing
  or create an MVP implementation gate; the [MVP refusal rules](README.md#closed-v1-capabilities)
  apply.
- **`ResourceOperationAdapter`:** `validateAndOwn(input, bounds)` retains immutable
  facts/bytes. `execute(operation, authentication, submission, bounds)` uses the
  registered transport and final gate.

### Admission, protected loading and issuer composition

The platform design and GitHub RFC series already assign authority and custody
responsibilities. These companion interfaces and method shapes are proposed:

- **`SelectedIamAdmissionOwner`:** `prepare(binding, deadline)` creates exact
  current evidence; `consumeIn(uow, evidence, binding)` spends it under the
  selected IAM implementation's [fence](protocols.md#authorization-and-submission).
- **`WorkAdmissionOwner`:** `checkIn(uow, binding)` checks genuine Work and its
  ancestors, Agent execution and ceilings in the existing State transaction.
  Controller reconciliation claims cannot supply this authority.
- **`ProtectedSourceLoader`:** the authorized Secret loader's `load(source, bounds)`
  returns scoped protected material and a release obligation. Preserve exact
  source ownership and currentness.
- **`IssuedMechanismFactory`:** `createIssuer(selection, source, bounds)` returns
  `TokenIssuerV1`; `createRevoker(selection, bounds)` returns `TokenRevokerV1`
  without requiring an App signing key.

**`TokenIssuerV1` and `TokenRevokerV1` are existing supplier interfaces**, absent
from baseline main. Reuse the pinned [`token-issuer-v1` contract][issuer-contract]:
issuer `mint` plus inherited `revoke`, with original-instance `settleAttempt` on
both interfaces. Preserve that lifecycle when implementing the factory bridge.

All callable ports above are internal OCE composition, never executable recipe
plugins. Stable definition, connection, service, resource, profile, grant and
lifetime [records](protocols.md#bound-records) are data, not additional services.
Schema codecs, immutable capture, authentication/operation binding and opaque-handle
registries MUST remain trusted internal implementation. Core MUST authenticate
handles and return safe observations, never secrets or reconstructed authority.

[broker-spec]: https://github.com/openclaw/openclaw-enterprise/blob/f3d7a613d66823bf4dd494e44ecf4428a9947c01/specs/github-access/0034/credential-broker-v1-spec.md#scope-and-ownership
[gateway-driver]: https://github.com/openclaw/openclaw-enterprise/blob/f3d7a613d66823bf4dd494e44ecf4428a9947c01/specs/github-access/0034/repository-configuration.md#proposed-credentialgatewaydriver
[broker-operations]: https://github.com/openclaw/openclaw-enterprise/blob/f3d7a613d66823bf4dd494e44ecf4428a9947c01/specs/github-access/0034/credential-broker-operations.md#broker-operations
[issuer-contract]: https://github.com/openclaw/openclaw-enterprise/blob/cb4cd731632d2968693fb55be22d274a2f634c20/packages/contracts/src/token-issuer-v1.ts#L38-L59

## Out-of-tree provider boundary

A third-party provider's recipes, implementation, tests and operational configuration
may live in a private repository. Public contracts MUST NOT require its source,
service name, endpoints, authentication configuration or deployment details to be
published. Credentials and concrete destinations remain administrator-admitted
configuration within the existing custody and authority boundaries.

The supported data boundary consists of versioned definition, connection, resource
and operation schemas with explicit capabilities. Core MUST carry opaque provider-instance
and canonical repository identities; it MUST NOT assume GitHub owner/repository slugs,
numeric IDs, case folding or a shared identity across separate upstream instances.
The provider mapping owns locator resolution, metadata, authentication and upstream
scope translation. Core retains Work/IAM admission, capture, custody and lifecycle.

Recipes that select existing supported tuples load without an OCE source edit.
A provider needing a new executable mapping requires a reviewed implementation and
an explicit versioned composition contract before admission. The proposed internal
ports above are not an implemented dynamic plugin ABI; private code MUST NOT gain
in-process execution merely by registering JSON. An independently deployed broker
uses the [remote contract and qualification gates](protocols.md#external-broker-requirements).
Unsupported versions, capabilities and authentication modes MUST fail closed.

Before shipping an out-of-tree implementation, publish the provider-neutral schema
and composition contract, compatibility checks and conformance harness that it uses.
The private repository supplies its adapter and deployment configuration against
that contract. Neither a private implementation nor a synthetic fixture establishes
an available public extension mechanism before this work is complete; Q-01 tracks
that implementation prerequisite.

## Lifecycle requirements

### L-01 — One broker lifecycle

Trusted owners MUST enforce this order:

1. `prepareAuthentication` binds protected material or an enabled workload transport
   to the exact service, resource, operation, profile and connection generation;
   credential effects need their own admission.
2. `admitDispatch` obtains fresh selected-IAM evidence and joins genuine Work,
   reservations, original PR claim, capacity and closure under the existing State
   transaction. Apply [A-01–A-07](protocols.md#authorization-and-submission).
3. `execute` consumes the known-commit permit at the exact receiver's final gate.
4. `finish` retains the original outcome and receipt through an independent
   finalizer, surviving cancellation. Passive attempt inspection MUST NOT repeat
   effects; supported reconciliation obtains original-effect evidence.

The internal labels `inspect`, `inspectAttempt` and `cancel` refer to trusted
owner inspection, passive State inventory lookup and `Bounds` cancellation.
They add no universal hook API or recipe callback. Cancellation is distinct from
independent `finish` and authority-closing `closeAccess`; it MUST NOT imply
nonexecution or revocation.

`GitHubGateway` MUST be a thin translation facade over this same lifecycle,
preserving authentication binding, admission, permit and finalization. It MUST NOT
introduce parallel authorization or execution.

Owners MUST separately close authority, stop continuation, request supported
revocation or release a borrowed source; none implies another outcome. Connection
verification and explicit enrollment use the owner methods above; enrollment MUST
work without listing. Future discovery creates no grant.

### L-02 — Authentication variants

This recipe MVP MUST implement issued,
individually revocable GitHub App credentials through `token-issuer-v1`. Additional
recipe modes below require distinct versioned bridges only when an actual future
backend needs them; unsupported tuples MUST deny before effects or capability
disclosure. Other platform consumers retain their own authentication contracts.
All enabled modes MUST preserve these rules:

- **Issued:** retain original acquisition, observed provider scope/expiry and
  durable custody; distinguish individually revocable from expiry-only.
- **Standing:** require authorized source borrowing, currentness and release;
  grant no credential creation or shared-source destruction rights.
- **Exchange:** retain original input authority, audience, result scope and durable
  transition; an unknown exchange MUST NOT become fresh acquisition.
- **Refresh:** require exclusive refresh-family/generation and replacement
  ownership; ambiguous refresh MUST NOT authorize retry with old material.
- **Workload:** require trusted key custody, authenticated principal/peer/audience,
  generation and currentness; an empty token or asserted principal is insufficient.

### L-03 — Validity

Bind actual principal, identity/connection generations,
receiver, service, audience, resource, operation and finite validity. Transport
pools MUST preserve these bindings and recheck currentness after preparation
and on reuse. Handshake success grants no resource permission. Track grant,
provider, source/workload and derived-capability lifetimes separately; unknown
expiry remains unknown. Local closure MUST NOT claim external revocation or
destroy shared keys.

### L-04 — Holds

Preserve the canonical key
`(upstreamInstanceId, resourceNamespace, resourceKind, canonicalResourceId, credentialAuthorityId)`.
OCE Namespace, connection/configuration IDs and recipe/schema versions MUST NOT
partition it. Tenant lookup MUST preserve privacy while joining shared upstream
obligations. Distinct instances/credential authorities remain distinct; aliases,
rotation, upgrades and backend changes MUST NOT evade holds or replay unknowns.
Unsupported identity remapping MUST deny acquisition. New grants/leases and cache
eviction MUST NOT clear retained inventory or canonical holds.

### L-05 — Retirement and restart

Retain original attempts, identity mappings,
pinned recipe/interpreter/primitive/executor versions, schemas/codecs, configuration and cleanup
authority until obligations close. Identical-version restart MUST preserve
obligations and original cleanup after retirement or Work closure. Retirement
permits authorized inspection/cleanup only, with scoped lifecycle authority and
its own bounded attempt; no issuance, resource work or shared-source destruction.
An offline upgrade MUST verify that requests, finalizers and cleanup obligations
have drained, observe the predecessor stopped and validate compatibility with
retained records before replacement activation. Preserve provenance, canonical
holds, PR deduplication, audit and stored outcomes. Unknown or outstanding obligations
block upgrade; deleting obligations, holds or required keys MUST NOT fabricate
a drain. Concurrent versions and migrations are outside the MVP.

### L-06 — Issuer specialization

Preserve opaque GitHub custody, typed App
signing/currentness and revocation constructible without the signing key.
Original-instance `settleAttempt` MUST authenticate original results and join
local finalizers; it MUST NOT reconcile the provider or resolve unknowns.
Source release MUST drain callbacks after settlement, including failed
construction and late finalizers. A successful no-op revoker is invalid.
