# Agent identity interfaces

[Overview](../basic-agent-identity-mvp.md) · [Architecture](architecture.md) · [Security](security.md)

These internal contracts distinguish pinned main, separate suppliers, and proposed
extensions. Their definitions establish neither connected producers nor installed
enforcement. They introduce no HTTP endpoints.

## Operator policy and revision admission

This selected extension has unmerged implementation source. The following
Installation example is illustrative and was not executed for this RFC.
The operator supplies the existing startup YAML through an absolute
`OCC_CONFIG_PATH`, after arranging the migrated database, selected Drivers,
ready Namespace, saved Agent and Configuration, supported Harness-auth source,
and exact IAM permissions.

```yaml
occ:
  agent_identity:
    mode: spiffe
    profileRef: enterprise/workload-v1
    profileVersion: 1
    profileDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

The closed `AgentIdentityRequirementV1` union is
`{mode: "compatibility"}` or
`{mode: "spiffe", profileRef, profileVersion, profileDigest}`.
Only omission defaults to compatibility. A profile reference is 1–200 characters
matching `[A-Za-z0-9._:/-]+`, its version is a positive safe integer, and its
digest is `sha256:` plus 64 lowercase hexadecimal digits. Null, extra members
and malformed present settings fail startup before Driver resolution or
construction. The loader gives OCC a detached, frozen selection. Valid SPIFFE
configuration can load even though this cut cannot execute it.

The caller sends the existing bodyless
[`POST /namespaces/:namespaceId/agents/:agentId/deploy`](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/contracts/src/api/routes.ts#L762-L774).
After exact-Agent `deploy` authorization, compatibility continues ordinary
admission and returns the existing `202` revision response with explicit
`identityRequirement`. The existing revision GET/list and
[deployment-status GET](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/contracts/src/api/routes.ts#L850-L878)
expose the saved result and durable progress. Unsupported SPIFFE returns
`503 DEPENDENCY_UNAVAILABLE` before Configuration or Secret preparation, revision
creation, or durable reconcile Work. Agent create, PATCH and deploy inputs cannot
select or weaken trusted policy.

Original State persists `admitted_spec.identity_requirement` with the immutable
revision. Only historical omission decodes as compatibility, without rewriting
history. Malformed present values refuse. Recovery uses the saved requirement,
not mutable startup policy. The actual worker preserves ownership, original
reconcile Work, live-claim fencing, current IAM and Provider checks, and separately
authorized stopped cleanup. Unsupported running recovery permanently reports
`IDENTITY_RUNTIME_UNSUPPORTED` before repository, Secret, workspace or Compute
preparation. The operation/session owner must also retain the admitted enforcement
selection. Request input, stale evidence and dependency outages cannot downgrade it.

Compatibility preserves existing tool authentication, IAM and repository-session
checks without verified-execution assurance. Later identity
[limits](#verified-workload-evidence) remain mandatory without defaults. Repository
omission still means `git-write`. The first protected read selects `git-read`,
and contribution selects `git-full`. No replacement defaults are selected.

## Execution and registration

**Pinned-main source:** [Agent, AgentRevision, ServicePrincipal, IAM and Compute](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/contracts/src/index.ts)
retain their existing owners. The immutable Namespace-scoped Agent
ServicePrincipal survives revisions. `IAMDriver.lookupIdentity(input: IdentityLookup)`
returns `Promise<Identity | undefined>`. Its mutually exclusive identity forms
are scoped issuer/subject or `servicePrincipalId`, the latter requiring prior
credential verification or authorized credential management.
`authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>`
checks `principalId`, `action` and exact `ResourceRef`. The complete linked
decision retains `allowed`, `reason`, `driverId` and identity/group/binding/role/
restriction evidence. Lookup is not permission. Actual OCC admission and identity
resolution must consume verified execution. The [current API admission](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/apps/controller/src/index.ts#L1830-L1898)
accepts human sessions and non-Agent API keys.

`ComputeDriver.prepareRevision(revision, context?)` returns
`Promise<ComputeReadiness>`. Optional `activateRevision(revision, context?)`
and `deactivateRevision(revision)`, plus `stopRevision(revision)` and
`retireRevision(revision)`, return `Promise<void>`. Readiness retains scope,
Namespace, Agent, revision, `ready`, optional plugin warnings, runtime failure
evidence and missing repository-material references. `ComputeRevisionContext`
carries resolved Harness authentication, Secret projections, optional workspace
setup and repository runtime bindings. [Plugin warnings](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/docs/reference/drivers/compute.md)
name only admitted `pluginId` and `PLUGIN_INSTALL_FAILED | PLUGIN_AUTH_REQUIRED`.
A ready result requires failed optional selections to be safely disabled and all
remaining checks to pass. Required protection cannot become an optional warning.
Readiness and void stop results prove neither serving authority nor termination.

**Separate supplier:** [RuntimeAssignmentRecordV1 and target](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts)
retain exact scope, assignment/create-effect references, lifecycle/runtime
generations, revision, component, profiles, binding and record version.
States are `allocated | bound | identity-ready | active | retiring | retired | abandoned`.
The component union is `gateway | harness`. These labels do not select the
relay's peer mapping or replace authoritative serving selection. Resource IDs
keep their [prefixed UUID schemas](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/contracts/src/api/common.ts).
State/Compute must independently bind the observed incarnation and retain the
[execution lifecycle](architecture.md#assignment-and-serving).

Registrar create/readback/delete is required, but its OCE wire schema is unselected.
The separately authenticated registrar may create only the assigned identity under
the operator's trust domain and SPIRE parent. Trusted observation supplies selectors.
Refuse broad or caller-authored registrations. Retain original operation identity
and exact registration cleanup ownership. Uncertain create/delete requires exact
readback, without duplicate create or unrelated deletion.

Observation distinguishes the exact bound incarnation, observed termination of that
incarnation, and unavailable or termination-unverified evidence. A missing Pod or
delete acknowledgment is insufficient. No new serialized result tags are selected.
[State owns commit and concurrency](architecture.md#withdrawal-and-recovery).

## Verified workload evidence

**Separate supplier source:** the following signatures are from
[runtime-identity-v1.ts at `f6f47f9`](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts).
The brand symbols are private to that module. No exported constructor or JSON codec
creates proof, transport, or stream handles.

```ts
export interface VerifiedWorkloadV1 extends RuntimeWorkloadDiagnosticV1 {
  readonly [verifiedWorkload]: true;
  readonly transportBinding: RuntimeWorkloadTransportBindingV1;
}
export interface RuntimeWorkloadTransportBindingV1 {
  readonly [workloadTransport]: true;
}
export interface TrustedRuntimeRegistrationReaderV1<OwnedConnection> {
  resolve(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeRegistrationResultV1>;
}
export interface RuntimeWorkloadVerifierV1<OwnedConnection> {
  verify(
    connection: OwnedConnection,
    expected: RuntimeWorkloadExpectationV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
  inspect(
    proof: VerifiedWorkloadV1,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<RuntimeWorkloadVerificationResultV1>;
}
```

`RuntimeWorkloadExpectationV1` requires `target`, `expectedPeerSPIFFEId`,
`recipientRef`, `identityProfileRef`, and `limits`. The accepting service obtains
these from trusted configuration, never request destination data. Call bounds
require `requestRef`, `recipientRef`, absolute canonical UTC `deadline`, and
`signal: AbortSignal`. The provider also applies its trusted monotonic clock.
Resolution must complete within the smaller of remaining validity and the
supplier's three-second lookup ceiling. `AuthorityCallV1` additionally requires
the process-local `RuntimeAuthorityTrustedContextV1`.

`RuntimeRegistrationResultV1` is `{kind: "observed", observation}` or
`RuntimeIdentityFailureV1`. The observation contains `assignment`, `spiffeId`,
`registrationId`, `registrationVersion`, `identityProfileRef`, `bundleSetVersion`,
`sourceEvidenceRef`, `observedAt`, and `validUntil`.
`RuntimeWorkloadVerificationResultV1` is `{kind: "verified", proof}` or the same
failure union. `verify` requires actual X.509-SVID verification and exact trusted
registration/bound-instance checks. `inspect` freshly checks the same owned proof's
recipient, connection incarnation, certificate, source/trust, registration,
profile, bundle, and original expiry. Inspection never renews proof by delivery.

The linked `RuntimeWorkloadDiagnosticV1` preserves schema/binding version `1`,
workload and assignment identity, profile/registration/bundle versions, original
verification/expiry times, and peer/recipient/connection references. Versions are
positive safe integers and timestamps are canonical millisecond UTC. The decoder
allows 4,096 bytes, depth 8, 256 nodes and 2,048 bytes per string. Decoding proves
shape only.

Failures carry `schemaVersion: 1`, `requestRef`, a `kind` of
`verification-failure` or `transport-failure`, and a closed `reasonCode` from the
source. Verification codes cover invalid, untrusted, expired, or mismatched peers,
binding/component rejection, stale or invalid observation, denied/invalid/unresolved
profiles, unsupported version, missing capability, invalid/rolled-back bundle,
and unavailable lookup. Transport codes are `cancelled`, `deadline-exceeded`,
`connection-closed`, `transport-unavailable`, `protocol-invalid`,
`buffer-exhausted`, and `cleanup-unsettled`. Unauthenticated recipients receive
generic failure, not scoped internal diagnostics.

Every [RuntimeIdentityLimitsV1](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts#L66-L124)
field is required, without defaults. `schemaVersion` is `1`. References are
1–200 characters matching `[A-Za-z0-9._:/-]+`. Numeric values are positive safe
integers except the explicitly zero-permitting skew:

| Required fields                                                                                                                                                            | Bounds and relationships                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `limitsProfileRef`, `bundleRollbackPolicyRef`, `invalidationProtocolRef`, `effectFenceProfileRef`, `requestBoundsRef`, `connectionBoundsRef`, `registrationChurnBoundsRef` | References.                                                                                                     |
| `svidLifetimeMs`, `renewBeforeExpiryMs`, `renewalRetryBudgetMs`                                                                                                            | Retry budget ≤ renewal lead < lifetime.                                                                         |
| `runtimeEvidenceMaxAgeMs`, `policyEvidenceMaxAgeMs`, `identityEvidenceMaxAgeMs`                                                                                            | Each ≤15,000ms.                                                                                                 |
| `identityHealthMaxAgeMs`, `identityHealthPollMs`                                                                                                                           | Poll interval ≤ maximum age.                                                                                    |
| `assignmentDeadlineMs`, `policyDeadlineMs`                                                                                                                                 | Each ≤3,000ms.                                                                                                  |
| `clockSkewAllowanceMs`                                                                                                                                                     | 0–2,000ms.                                                                                                      |
| `connectionMaxAgeMs`, `streamRecheckMs`, `streamCloseDeadlineMs`                                                                                                           | Recheck ≤5,000ms and ≤ connection age.                                                                          |
| `bundleUpdateMaxAgeMs`, `bundleOverlapMs`, `disableBudgetMs`                                                                                                               | Positive safe integers.                                                                                         |
| `maxFrameBytes`, `maxBufferedBytes`, `maxBufferedMessages`, `maxConnections`, `maxStreamsPerConnection`, `maxPendingChecks`                                                | Frame ≤ buffered bytes. Connections × streams and buffered bytes × connections × streams must be safe integers. |

[Cross-field validation](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-identity-v1.ts#L407-L421)
and [selected ceilings](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L7-L20)
constrain configuration. Parsing neither admits a profile nor measures its guarantee.

Actual producers must bind the exact request/stream to its original live
connection, recipient, and incarnation across the protected Go/TypeScript bridge.
Cover every receiving route, including `checkContinue`, and reject unsupported
alternate/upgrade/CONNECT routes. Strings, headers, serialized proofs, routing
hints, copied diagnostics, and repository bearers cannot create evidence. Resolve
verified evidence through selected IAM to the existing Agent ServicePrincipal.
Identity-purpose currentness remains separate from operation authorization.

## Repository session binding

**Pinned-main source:** [repo.ts](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/packages/contracts/src/repo.ts)
owns the complete `RepoDriver extends Driver` contract. Its capability is `repo`,
and the bundled implementation is `GitHubRepoDriver`. Its operations are:

```text
resolve(input: {
  readonly namespaceId: string;
  readonly bindings: readonly RepositoryBindingRequest[];
}): RepositoryCredentialResolution;
open(input: OpenRepositorySessionInput, signal: AbortSignal): Promise<OpenRepositorySessionResult>;
status(sessionId: string, signal: AbortSignal): Promise<RepositoryCredentialSessionStatus | undefined>;
close(sessionId: string, signal: AbortSignal): Promise<RepositoryCredentialSessionStatus | undefined>;
```

The Driver also exposes `maintenanceIntervalMs`. Each binding request has
`repositoryRef` and optional `profile`. Resolution returns admitted `bindings`
and `sessionDurationSeconds`. Each admitted binding has `repositoryRef`,
`profile`, `providerId` and `grant`. Grant members `providerInstanceId`,
`repositoryId` and `grantId` are nonempty opaque strings, at most 512 UTF-8 bytes
without ASCII controls. Immutable `RepositoryRevisionState` retains Driver
`id`/`implementation`, `deadlineWallMs` and admitted bindings.

`OpenRepositorySessionInput` requires `namespaceId`, `admissionId`, `binding`,
`durationSeconds` and `deadlineWallMs`. Its optional `recoverOnly: true`
cannot create authority. Results are `created` with `session` and `files`,
`recovered` with `status` only, or `missing`. Public status contains only
`sessionId`, `state: "OPEN" | "CLOSED" | "DISPOSED"`, `deadlineWallMs` and
grant `binding`. Undefined status does not prove provider revocation.

The unchanged `RepositoryCredentialSessionFiles` has `bearer`, `client.json`,
`gitconfig`, `gh/hosts.yml`, `gh/config.yml` and optional `ca.pem`.
Its client configuration names `gatewayOrigin`, `gitRemote`, `gitUsername`,
`canonicalApiHost`, `apiHost` and `repository`.
`RepositoryCredentialRuntimeBinding` combines `repositoryRef`, `sessionId`
and `deadlineWallMs` with `{kind: "new", files}` or `{kind: "retained"}`.
Compute owns paths, modes and runtime objects.

[Current configuration and profiles](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/docs/reference/repository-credentials.md#configuration)
remain authoritative. Admission permits up to 16 distinct 1–128-character
repository selectors and defaults omission to `git-write`. Registry drift denies
admission. The first read explicitly selects `git-read`, and contribution selects
`git-full`, preserving its full token-bounded GraphQL meaning. Original revision
deadlines survive renewal and recovery.

**Proposed extension:** persist the immutable expected execution before opening
the session. Open, status, recovery and material delivery must retain that identical
expectation. Unsupported binding capability denies enforcement. A successor needs
fresh admission and closure of the previous attempt. An open session cannot be
rebound. Before an ordinary Agent uses an enforced session, the real receiver
checks current verified execution and operation authority, before credential
acquisition or dispatch. No new extension field or wire format is selected.

In the [existing worker](https://github.com/openclaw/openclaw-enterprise/blob/311bc23012d0fd269483168b865adf79df630542/apps/controller/src/worker/repository-credentials.ts),
`created` delivers files to the actual Harness. `recovered` cannot rediscover a
lost bearer, and that admission closes when material cannot be retained.
A `recoverOnly` missing result creates no session. Retained status cannot authorize
replacement. Preserve grants, profiles, Git semantics, original deadlines, renewal,
recovery, durable cleanup and uncertain outcomes.

## Currentness and expiry

Consume the original stable Principal/account/method/session facts and RBAC's
`AgentAuthorityContext`/`AgentInvocation`. Retain the original connection, grant,
scope, complete audience, authority generation, and absolute deadline. Before
acquisition or dispatch, require current assignment and exact Agent
`use_repository`, profile, resource, and operation permission. A legacy
`operate`/`read` mapping cannot broaden access.

Retired execution or withdrawn authority denies admission, renewal, acquisition
and dispatch. Missing, stale or unavailable evidence refuses. Rotation, reconnect,
retry and delayed positive results cannot extend the original source, authority
generation or deadline.

After authority/acquisition waits, inspect the same proof within its original
budget. A current original waiter must still authorize shared acquisition.
Immediately before effects and authority-sensitive delivery, synchronously check
currentness and the session fence without an intervening await. Preserve
no-positive-cache guards and [account withdrawal semantics](security.md#currentness-controls).

The separate supplier `RuntimeIdentityPurposeGuardV1.check(proof, request, call)` returns
`Promise<RuntimeIdentityCheckResultV1>`. Its
`openStream(proof, request, call, limits)` returns
`Promise<RuntimeIdentityOpenStreamResultV1>`. Inputs are respectively
`VerifiedWorkloadV1`, `ResolveAssignmentRequestV1`, `AuthorityCallV1`, and
`RuntimeIdentityLimitsV1`. Opening returns `{kind: "opened", stream}`,
`{kind: "not-opened", observation}`, or `RuntimeIdentityFailureV1`. The observation
is a `ResolveAssignmentResultV1`. Opening is not permission for even the first
dispatch or delivery, which needs its own fresh check and operation authorization.

`ResolveAssignmentRequestV1` requires `schemaVersion: 1`, `installationId`,
`namespaceId`, `agentId`, `assignmentRef: {schemaVersion: 1, id}`, `requestRef`,
and `purpose`. Assignment IDs and operation references are lowercase UUIDv4.
Scope IDs retain their prefixed schemas, references the bounds above, counters
positive safe integers, and times canonical millisecond UTC.

| Purpose                                             | Additional required request members                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-peer`, `model-call`, `repository-issuance` | None.                                                                                                                                                            |
| `identity-registration`, `readiness-probe`          | `operationRef`, `expectedResponsibilityVersion`.                                                                                                                 |
| `cleanup`                                           | Those operation members plus `requestedOperation`: `cancel-execution`, `remove-route`, `terminate-instance`, `retire-registration`, or `remove-provider-object`. |
| `completed-context-restore`                         | Those operation members plus `purposeContract: "completed-context-restore-v1"` and `requestedSuboperation`: `importCompletedContext` or `readImportedContext`.   |

The [purpose/result contract](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L410-L625)
requires every positive observation to carry `schemaVersion: 1`, `evaluatedAt`,
`validUntil`, `requestRef`, `result`, `purpose`, and `reasonCode`:

- Serving purposes return `current` / `conditions-satisfied`, with `snapshot`,
  `runtimeEvidence`, `policyEvidence`, `lifecycleGeneration`, `selectionVersion`,
  `identityEvidence`, `servingEvidence`, and `mutationEligibilityEvidence`.
- Registration returns `candidate-eligible` / `registration-allowed`, with
  `snapshot`, `runtimeEvidence`, `policyEvidence`, `operationRef`,
  `responsibilityVersion`, `allowedOperation: "register" | "maintain-registration"`,
  `registrationTemplateRef`, `parentBindingRef`, and `selectorEvidenceRef`.
- Readiness returns `candidate-eligible` / `probe-allowed`, with `snapshot`,
  `runtimeEvidence`, `policyEvidence`, `operationRef`, `responsibilityVersion`,
  `allowedOperation: "readiness-probe"`, `peerPairingRef`, `peerPairingVersion`,
  `permittedEndpointRef`, `peer`, `identityEvidence`, and `peerIdentityEvidence`.
- Cleanup returns `cleanup-eligible` / `cleanup-allowed`, with `operationRef`,
  `responsibilityVersion`, `snapshot`, `allowedOperation`,
  `successorExclusionEvidence`, `effectPreconditionEvidence`, and
  `cleanupPolicyEvidence`. The unbound-object variant replaces `snapshot` with
  `targetKind: "owned-provider-object"`, `target`, `assignmentRecordVersion`,
  the three profile references, `profileDigests`, `providerObject`, and
  `ownershipEvidence`. Its operation is only `remove-provider-object`.
  `providerObject` pairs `occ/kubernetes-gvisor`/`harness` or
  `occ/kubernetes-gateway`/`gateway` with `clusterRef`, `kubernetesNamespaceUid`,
  and `deploymentUid`. It proves retained create-effect ownership without a Pod.
- Restore returns `candidate-eligible` / `restore-operation-eligible`,
  `purposeContract: "completed-context-restore-v1"`, `allowedSuboperation`,
  `binding`, `currentPolicyEvidence`, and `pairingEvidence`. The complete unchanged
  [restore binding](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L468-L493)
  retains the exact scope, producer, checkpoint, pairing, store, policy and
  effect-fence tuple. It does not gate disposable delivery.

`snapshot` and `peer` contain `target`, [binding: RuntimeBindingV1](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L174-L221),
`assignmentRecordVersion`, `providerProfileRef`, `runtimeProfileRef`,
`identityProfileRef`, and `profileDigests: {provider, runtime, identity}`.
The target requires `installationId`, `namespaceId`, `agentId`, `assignmentRef`,
`revisionId`, `component`, `lifecycleGeneration`, `runtimeGeneration`, and
`createEffectRef`. Binding versions equal `1`.
Digests use `sha256:` plus 64 lowercase hex digits. Source evidence contains
`reference`, `version`, `sourceObservedAt`, `receivedAt`, `validUntil`, and
`uncertaintyMs` (0–2,000). Identity evidence contains `registrationId`,
`registrationVersion`, `bundleSetVersion`, `identityProfileRef`, and `evidence`.

Refusals carry `schemaVersion: 1`, `evaluatedAt`, and `requestRef`.
`pending` adds `purpose` and `reasonCode: "evidence-incomplete"`.
`not-current` adds `purpose` and a [closed negative reason](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/contracts/src/runtime-authority-v1.ts#L264-L289).
`not-visible` uses `scope-hidden`, and `unavailable` uses `lookup-unavailable`,
without a purpose field. None permits serving. Candidate and cleanup positives
are consumable only for their stated purpose, never ordinary operations.

The supplier `RuntimeIdentityStreamV1` exposes `signal`,
`check(call: AuthorityCallV1): Promise<RuntimeIdentityCheckResultV1>`,
`invalidate(reason: RuntimeIdentityInvalidationV1): void`, and
`close(): Promise<RuntimeIdentityCloseResultV1>`. Check returns `{kind: "resolved",
observation: ResolveAssignmentResultV1}` or identity failure.
The [supplier resolver](https://github.com/openclaw/openclaw-enterprise/blob/f6f47f967a3c480dd7c7770072cd8a806978596d/packages/occ/src/runtime-authority/service.ts#L309-L352)
does not yet produce current-serving results.
The completed resolver must combine authoritative serving selection, bound
incarnation, fresh Compute/registration/profile evidence, original deadline and
current IAM.

Invalidation reasons are authority/identity change, watch loss/gap, stale evidence,
deadline, cancellation, exhausted buffer, and closed connection. Invalidation and
close synchronously deny before cleanup. Close is idempotent and returns
`{kind: "closed"}` or a transport failure, including `cleanup-unsettled`.
Terminal streams cannot reopen. Late work retains custody/capacity until actual
settlement, and borrowed connections remain their owner's responsibility.

The installed profile must measure **≤30 seconds** from the defined authority-owner
event to both refusal of new work and last protected bytes/closure of active
exchanges, including renewal-connectivity loss. Specify evidence age, receiving
expiry, clocks/skew, monotonic budget, renewal cadence, stream cancellation, and
closure reserve. No stage restarts the bound. Expiry must progress independently
of the Harness, blocked readers, and listener saturation.

Retain applicable **five-second** dependency-call, operation-start, model-recheck,
and model-closure ceilings. They do not establish global five-second revocation.
Maintenance intervals and constants are not installed timing evidence.

In this unexecuted example, the receiver checks a trusted `repository-issuance`
request and its actual connection proof. Even `current` needs exact operation
authorization and final fencing. `transport-failure` with `connection-closed`
denies dispatch and buffered output. Reconnection requires fresh evidence within
the original horizon.

## Observations and owner decisions

Audit separately retains initiator, Agent/revision, selected authority, exact
operation, result, and truthful assurance. Actual verifier/guard facts retain
original assignment, generation, component, profile, and verification/expiry
times. Follow the [repository observation contract](https://github.com/openclaw/openclaw-enterprise/pull/250)
without credentials, custody/proof handles, or raw request/result material.
Protected references require authorized owner lookup. Serialized observations
never authorize effects.

The following mechanisms remain undecided while their required guarantees remain
mandatory:

- Identity, Compute, and credential owners must select protected bootstrap purpose,
  immutable material delivery, and a genuine current-serving producer.
- Egress and identity must select actual receiving peers and the authenticated
  Go/TypeScript bridge while preserving same-request/connection custody.
- RBAC, connector, and Harness owners must associate concurrent operations with
  their authentic requester and complete audience, retaining durable fences.
- Installation/admission owners must resolve the proposed stronger-minimum
  transition. Runtime/identity/egress owners must select timing mechanics and
  measure both withdrawal endpoints.

Close these decisions through real producer/consumer integration and the
[delivery qualification](delivery.md#acceptance-evidence), not invented routes,
defaults, response codes, or proof-shaped JSON.
