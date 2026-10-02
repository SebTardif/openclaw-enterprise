---
status: Proposed
---

# Proposal: Generic Token Service and pluggable token leasing

- **ID:** RFC-0056
- **Owner:** OCE maintainers
- **Created:** 2026-10-02
- **Related:** [Repository credentials](../31-repository-credentials/index.md), [recovery](../39-repository-credential-recovery.md), [credential injection](../39-sandbox-credential-injection.md)

## Summary

Refactor the repository credential broker into an Installation-scoped **Token
Service** deployed independently of OCC workers, with standalone support. It owns
bounded leases, memory-only token custody, replacement, and cleanup.
Named **TokenDriver** instances implement upstream issuance and revocation;
`GitHubTokenDriver` is the first implementation. Keep repository discovery,
Git/`gh` routing, and repository permission checks in the existing RepoDriver and
repository gateway adapter. Agents receive opaque lease credentials; upstream
tokens remain inside the trusted service. Repository metadata lookups use short
Installation-owned leases, independent of Agents and drafts.

This proposed architecture extends the existing credential lifecycle. YAML is
not yet supported; an implementation plan follows interface review.

## Motivation and scope

The [current broker](../../../docs/reference/repository-credentials.md) separates
session and token lifetimes, replaces tokens without changing grants, and
distinguishes closure from disposal. Its private
[Backend interface](../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts)
combines token lifecycle with HTTP planning and authentication, coupling reuse
to repository-specific policy and recovery.

First delivery must carry the regular Agent repository workflow
through the generic service, including renewal, stop, deletion, and recovery.
It does not replace SecretDriver, ServiceAccountDriver, or
[CredentialGatewayDriver](../../../docs/reference/drivers/credential-gateway.md).
General model inference, new Sandbox support, arbitrary HTTP forwarding,
interactive OAuth login, raw-token delivery, and a general public token API are outside first
delivery. OAuth below demonstrates the extension seam; it is not a second
promised integration without a supported caller.

Remove OCE-managed Git hooks and `pushRefAllowlist` in this refactor. The
[current push-ref guardrail](../../../docs/reference/repository-credentials/push-ref-guardrail.md)
is bypassable; its accidental-push protection is intentionally dropped. Remove
its configuration, grant-fingerprint inputs, client metadata, hook dispatcher,
and generated `core.hooksPath` override. Reject the removed configuration field.
Ordinary Git hooks remain user-controlled. GitHub repository rules enforce
remote-ref restrictions; this refactor does not provision those rules. Reconsider
managed hooks only for a concrete future need.

Retain the repository clients and gateway adapter over the generic lease engine.
Except for managed hooks, preserve the supported
[Git/`gh` contract](../../../docs/reference/repository-credentials.md#client-routing-and-limits):
native Git configuration, exact destination checks, generation pinning, explicit
selection among duplicate bindings, original deadlines, and response filtering.
Stale clients must not adopt a newer generation's credentials. Uncertain remote
mutations must never be replayed automatically. No generic client framework is
introduced.

## Ownership

| Owner                         | Responsibility                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OCC and selected IAM Driver   | Authorize platform operations; bind owner, grant, and deadline; persist admission and cleanup.                          |
| Token Service                 | Validate admissions; own leases, custody, renewal, capacity, reservations, and terminal receipts.                       |
| TokenDriver                   | Normalize issuer-specific grants; acquire replacement tokens; report actual scope, expiry, revocation, and uncertainty. |
| Repository gateway adapter    | Validate Git/`gh` requests and destinations; use a lease internally; preserve existing response filtering.              |
| RepoDriver and GitHub Backend | Own discovery, metadata caching, profile resolution, and private lease coordination.                                    |
| Compute Driver                | Deliver only revision-owned client material; withdraw it during retirement.                                             |

Deploy one active Token Service per Installation, independently of workers.
Workers call its authenticated HTTPS control API; Agents use opaque bearers on
its separate HTTPS gateway. The service accesses nonsecret admission records
and writes receipts directly, replacing Unix control sockets and worker callbacks
in OCC mode. [Deployment and recovery](deployment.md) defines authentication,
state ownership, failure behavior, and the proposed topology. General
[Agent-to-OCC workload authentication remains planned](../../../docs/design.md#implementation-status).

## Installation YAML

Illustrative Installation fragment; required Configuration, IAM, Compute, and
Secret selections are omitted. Files are operator-provisioned mounts.

```yaml
tokenService:
  id: installation-tokens
  mode: occ
  control:
    origin: https://token-control.example.internal
    tlsCertFile: /run/token-service/control.crt
    tlsKeyFile: /run/token-service/control.key
    clientCaFile: /run/token-service/control-clients-ca.crt
    clients:
      - identity: spiffe://oce.example/worker
        admissionKinds: [agent-revision]
      - identity: spiffe://oce.example/api
        admissionKinds: [installation-operation]
  state:
    databaseUrlFile: /run/token-service/state-database-url
  gateway:
    publicOrigin: https://credentials.example.internal
    tlsCertFile: /run/token-service/tls.crt
    tlsKeyFile: /run/token-service/tls.key
  leasePolicy:
    maximumDurationSeconds: 86400
    credentialMarginSeconds: 60
  drivers:
    - id: github-production
      type: github-app
      configuration:
        appId: "123456"
        privateKeyFile: /run/token-service/github-app.pem
  grants:
    - id: platform-read
      driverId: github-production
      namespaces: ["11111111-1111-4111-8111-111111111111"]
      audience: repository-gateway
      parameters:
        installationId: "789012"
        repositoryId: "345678"
        repository: example/platform
        profile: git-read

backend:
  - id: github-primary
    type: github
    configuration:
      tokenServiceId: installation-tokens
      repositories:
        - repositoryRef: platform
          profiles:
            git-read: platform-read
    drivers:
      repo: repository-credentials
drivers:
  repo:
    id: repository-credentials
    configuration:
      sessionDurationSeconds: 86400
      publicCaPath: /etc/openclaw/token-service/ca.crt
      controlClient:
        certFile: /run/occ/token-control/client.crt
        keyFile: /run/occ/token-control/client.key
        caFile: /run/occ/token-control/server-ca.crt
```

`tokenService` is optional and singular. Its `drivers` collection is a private
service registry, not an array-valued replacement for the existing singleton
`drivers.<capability>` selectors. `backend[].drivers.repo` retains exact Backend
membership. The GitHub Backend references the service and maps repository
profiles to grants instead of owning a second grant registry. Mapping validation
requires the GitHub issuer, numeric repository identity, and profile to agree.

Each token Driver selects exactly one bundled `type` or installed `package`.
The main example uses the first-delivery GitHub implementation and its current
exact profile permission maps. The following separate registry entry illustrates
the installed-package seam; it is not a shipping integration:

```yaml
# Illustrative entry under tokenService.drivers; not part of the GitHub example.
- id: graph-production
  package: "@example/oce-oauth-token-driver"
  configuration:
    tokenEndpoint: https://login.microsoftonline.com/example-tenant/oauth2/v2.0/token
    clientId: example-client-id
    clientSecretFile: /run/token-service/graph-client-secret
```

An OAuth integration also needs a supported consumer adapter and reviewed grants;
unknown packages and unsupported audiences fail startup. OAuth `.default` uses
administrator-approved application permissions, not proof of narrower scope.
Its Driver must validate the configured application authority before admission.

In OCC mode, grant and Driver IDs are Installation-unique. `namespaces`
contains exact platform Namespace IDs, not Kubernetes namespace names. Unknown
fields, missing references, unsupported audiences, invalid duration bounds, and
incompatible profile mappings fail startup. No wildcard Namespace admission.
These allowlists constrain issuance; they do not substitute for IAM grants.

The API, worker, and service bind authority to the same `configurationDigest`.
Compute it from a deterministic, nonsecret projection of the authority
configuration: service identity and mode, pinned Driver implementation identity,
public issuer configuration, grant IDs and parameters, Namespace restrictions,
audiences, repository/profile mappings, duration policy, and authorization
generation. Canonical serialization fixes object-key order and normalizes
unordered collections without executing Driver packages. Private credential
contents are excluded; rotating an equivalent signing key does not change the
digest. Semantically equivalent configuration edits may change it and invalidate
leases. There is no generated semantic catalog or digest-advertisement handshake.

Admissions bind `configurationDigest` and `grantId`, along with the exact owner,
authority, authorization generation, and deadline. API and worker retain public
GitHub identity and profile policy resolution. Only the service loads TokenDriver
packages and private issuer files. Before becoming ready, it validates every
Driver configuration and grant against its schemas, normalizes all grants, and
checks Backend/profile mappings. At admission it independently compares the
committed authority with the selected grant and its active configuration; matching
a digest alone does not authorize access. Retiring Drivers remain available for
cleanup until their obligations settle.

Preserve existing protected-file, TLS, queue, byte, timeout, and capacity limits,
including override bounds and enforcement.

## Lease contract and lifecycle

A lease is permission for one consumer to use one immutable grant until an
absolute deadline. Its owner is one of three tagged forms:

- `agent-revision`: `(installationId, namespaceId, agentId, revisionId)`.
- `installation-operation`: `(installationId, backendId, operationId, purpose)`,
  with `purpose: repository-metadata` as the only supported internal operation.
- `operator-session`: `(serviceInstanceId, operatorSessionId)` in standalone mode.

It has `leaseId`, `admissionId`, `grantId`, `configurationDigest`,
`audience`, `deadline`, and nonsecret status. Token generations have separate
issuer expiry and cleanup obligations. A lease is not an upstream token.

The authenticated control client exposes three lease controls:

| Operation              | Result and authority                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `openLease(admission)` | Revision or standalone operator admission required; returns opaque client material once. |
| `leaseStatus(leaseId)` | Owner-scoped status and cleanup counters; never credential recovery.                     |
| `closeLease(leaseId)`  | Immediately deny new use and request cancellation/retirement; disposal is separate.      |

Repository descriptions use the separate bounded operation below, not these
controls. There is no caller-facing renewal operation or proactive refresh timer.

The gateway adapter's internal `withCredential(leaseId, minimumValidity, use)`
supplies credentials only to its trusted forwarding code. It is not a network
API. An Agent bearer authenticates only to its admitted audience; it cannot
select an issuer, supply scopes, open another lease, or call a token endpoint.

### Installation-owned repository metadata

The Installation's GitHub Backend owns description lookup and five-minute caching
by provider/repository identity. Descriptions are optional; failure never blocks
approved selection. No draft or revision is required.

OCC preserves the existing repository-options authorization: Agent `create` in
the requested Namespace, or `update` on the edited Agent. It checks repository
eligibility before fetching or returning cached data. Before external work, OCC
durably records the requesting principal, Namespace, Backend, exact approved
repositories and source grant IDs, `configurationDigest`, authorization
generation, and absolute operation deadline under an Installation-operation
admission ID. Shared caching never grants cross-Namespace visibility.

The trusted Backend calls `describeRepositories(admissionId, repositoryRefs)` on
authenticated HTTPS control with the bounded, approved repository set. Only a
caller admitted for `installation-operation` may use it; `openLease` rejects that
kind. The service compares the request with the committed record and its current
configuration, validates Backend membership and Namespace eligibility, and derives
Metadata-read authority from each source grant's GitHub issuer and exact
repository. These internal grants are not selectable Agent profiles or another
YAML registry. Only the trusted metadata adapter uses them, for
`GET /repos/OWNER/REPO` with numeric repository identity validation.

The service opens, uses, and closes Installation-owned metadata leases internally,
retaining each source `grantId` and the derived Metadata-read authority.
It returns sanitized descriptions or pending status, never lease handles, bearers,
or issuer response bodies. Retries with the same admission ID recover the same
operation's result or pending status; changing its repository set is rejected.
A retry does not dispatch a second acquisition while the original is in flight or
uncertain. Keep the existing batch bound and five-minute cache; timeout or failure
still leaves descriptions optional.

The operation and its leases last at most 30 seconds, capped by configured
duration policy. Leases close on completion, failure, cancellation, or expiry.
They share provider capacity and cleanup accounting with revision leases;
uncertain issuance retains cleanup obligations and blocks replacement. Pending
cleanup can outlive the operation deadline, without permitting more use.
Configuration or policy withdrawal invalidates them independently of Agent
lifecycle.

Installation ownership requires no new
[ServicePrincipal](../../../docs/reference/authorization.md#principals) or bootstrap
administrator credential. The Installation is not an IAM principal; the
TokenDriver authenticates to GitHub. Other internal purposes fail admission.

### Standalone admission

Standalone leases use [service-local operator admission](standalone.md), with
process-local custody and recovery limits. OCC-managed admissions remain durable;
standalone access cannot bypass them.

### Agent revision lifecycle

See the [deployment diagram](deployment.md#topology) for direct control and gateway paths.

1. **Admit.** Preserve existing Agent create/update/deploy authorization and
   worker rechecks. Resolve repository profiles to grants. Persist the exact
   attempt before external work; the service independently checks its current
   snapshot and atomically records its reservation before returning client material.
   Duplicate admission IDs recover status,
   not bearers. A lost response uses existing find-or-fence/close recovery.
2. **Use.** Acquire on demand when the gateway needs a token. Reuse a sufficiently
   valid generation; otherwise coalesce concurrent acquisition or replacement
   into one attempt per lease. Idle leases never mint or refresh tokens.
   Required validity covers the bounded exchange plus the configured margin;
   the first request needing a replacement pays the issuance latency.
   Requested duration is a ceiling, never a promise the issuer supports that TTL.
   Replacement preserves grant and lease handle. Extending access beyond the
   deadline requires a newly authorized admission, not token refresh.
3. **Fail.** Retry only definitely safe acquisition failures with bounded delay.
   Reauthorization-required marks the lease unavailable. Previously issued
   credentials remain usable only while both authorization and validity hold.
   Uncertain issuance fences further acquisition until reconciled; never replay
   an uncertain Git push or API mutation to obtain success.
4. **Close.** Stop, delete, revision retirement, or authority withdrawal closes
   the lease and cancels owned exchanges. `CLOSED` denies new use; `DISPOSED`
   requires settled actions, credential revocation or proven expiry, and auxiliary
   cleanup. Revocation-unsupported Drivers report expiry-only cleanup explicitly.

The service never shares token generations between leases in first delivery.
An issuer's token may outlive the lease; the gateway deadline still denies use,
and retirement remains pending until revocation or conservative expiry proof.
Admission and use audit records contain owner, grant, Driver, generation, and
outcome identifiers, never credentials or issuer response bodies. Platform
grant withdrawal must invalidate active leases, not only future admissions.
Every use checks the lease's `configurationDigest`, selected grant, and current
eligibility against the active configuration. Applying a changed authority
configuration closes mismatched leases; OCC reconciliation closes
revision leases when their revision loses eligibility. Preserve the existing elapsed-time
deadline checks; restart recovery cannot reset a lease's duration.

## TokenDriver extension contract

Extract the existing custody and lifecycle outcomes from the repository-private
interface; preserve their semantics rather than replacing them with
`Promise<string>`. The proposed public shape is:

```ts
interface TokenDriver<Grant> extends Driver {
  readonly capability: "token";
  readonly replacement: "overlap" | "drain-before";
  readonly cleanup: "revocable" | "expiry-only";
  normalizeGrant(parameters: unknown): Grant;
  acquire(
    attempt: TokenAttempt<Grant>,
    previous: CredentialRef | undefined,
    minimumValidityMs: number,
  ): Promise<AcquireOutcome>;
  retire(attempt: TokenAttempt<Grant>, token: CredentialRef): Promise<RetireOutcome>;
  finalize(attempt: TokenAttempt<Grant>): Promise<FinalizeOutcome>;
  settle(outcome: OriginalOutcome): Promise<void>;
}
```

`TokenAttempt` carries the service-owned lease identity, normalized grant,
absolute operation deadline, cancellation signal, and dispatch accounting.
`CredentialRef` is service custody, not serializable bearer material. The
[existing outcomes](../../../apps/controller/src/drivers/repo/credentials/backend-contracts.ts)
distinguish acquired, rejected, reauthorization-required, not-dispatched, and
uncertain. Authentication eligibility and cleanup expiry remain separate.
The service validates outcomes and retains late completions after cancellation.

`GitHubTokenDriver` extracts acquisition and retirement from the
[existing GitHub implementation](../../../apps/controller/src/drivers/repo/github/credentials/driver.ts).
It signs an App JWT, requests a token for the exact installation/repository and
profile permissions, validates returned authority/expiry, and revokes owned
tokens. Renewal mints a replacement; it does not extend a GitHub token.
HTTP route planning and Git/`gh` authentication stay in the repository adapter.

An `OAuthClientCredentialsTokenDriver` instead exchanges its configured client
credential for a grant's fixed audience/scopes. Drivers that require durable
rotating refresh-token storage need a separate design and are outside this RFC.
Issuer endpoints come only from reviewed operator configuration, with exact HTTPS origins and
redirect restrictions; callers cannot turn the service into a URL fetcher.

Installed implementations follow the existing
[package contract](../../../docs/reference/drivers/selection.md#package-identity-and-factory-exports):
closed `configurationSchema`, semantic `validateConfiguration`, and `createDriver`.
For capability `token`, the service supplies `id`, resolved `implementation`,
configuration, custody, and clock; it supplies no platform state or IAM bypass.
Each package also exports a closed `grantSchema`; `normalizeGrant` rejects
unsupported authority and produces canonical parameters for service-side scope
checks. These normalized parameters do not create a second cross-process
configuration identity.
Public types export through the contracts package's top-level index. Packages
are reviewed, exact-version production dependencies of the service artifact,
precompiled and image-pinned; no runtime installation or hot loading. They run
with service authority, so package review remains a trust boundary.

## Persistence and recovery

Issued tokens remain memory-only in both modes. OCC admissions, service
reservations, and terminal receipts remain durable and credential-free.
[Recovery rules](deployment.md#state-and-recovery) distinguish worker restart,
service loss, and unresolved cleanup; lost leases are never silently reminted.

## Delivery and verification

Create a separate plan after interface review. First delivery extracts the engine,
integrates `GitHubTokenDriver`, repository and operator callers, preserves current
recovery limits, and delivers the [independent service and control boundary](deployment.md).
Update references, flows, Installation parsing, and Kubernetes packaging together. Historical RFCs remain unchanged. Retire the old
configuration path when the canonical replacement ships; no compatibility shim
is proposed.

Required integration proof extends the
[regular Agent repository test](../../../tests/integration/repository-credentials-platform.test.mjs):
deploy, Git read/write and `gh` use, forced token expiry, unchanged scope and lease
deadline, stop/delete, and confirmed cleanup. Include real PostgreSQL competing
workers, lost admission responses, crash-after-dispatch uncertainty, expired
tokens, late completion, and authority withdrawal. Service restart must reject old
bearers without claiming lost tokens revoked or silently replacing old leases.
Verify no private issuer material reaches API/worker/Agent artifacts. Exercise the packaged Driver through
service composition, not a direct test-only call. Qualify actual GitHub issuance
and revocation separately with authorized disposable resources; fixtures do not
prove upstream behavior. Future Drivers need a supported consumer and equivalent
integration proof before being advertised.

Also verify metadata discovery before Agent creation, authorized cache reuse,
cross-Namespace denial, Metadata-read scope, timeout/uncertain cleanup, and no
credential delivery to API or Agent callers through the real repository-options
path.

Through the regular Agent workflow, verify duplicate-binding selection, stale
generations, revision replacement, rejected destinations, and uncertain mutations.
Verify Git operations without OCE hooks, ordinary user-hook execution, and rejection
of removed `pushRefAllowlist` configuration.

This RFC implements no runtime behavior; validation is documentation-only.

<!-- User-approved length exception for RFC-0056: keep the configuration,
lease interface, and lifecycle decisions together for review. Deployment and
standalone details already have companions; further splitting separates the
contract from its authority and cleanup requirements. -->

## Alternatives and review decisions

- Keeping the broker GitHub-specific avoids new configuration but duplicates
  lifecycle/security work for every issuer. Extracting only a minting helper
  fails to integrate ownership, recovery, and the real Agent caller.
- Delegating everything to OpenShell couples repository support to a Sandbox
  topology currently excluded by RepoDriver. Its stable-placeholder pattern is
  useful, but CredentialGatewayDriver remains a separate integration.
- Encrypted persistent custody enables token recovery after restart but adds
  storage and key management. It is excluded from this refactor.
- **Platform maintainers** should confirm the independent service, authenticated
  control and state ownership, named TokenDrivers, and private package factory. Review
  must preserve Namespace, scope, deadline, and cleanup guarantees.
