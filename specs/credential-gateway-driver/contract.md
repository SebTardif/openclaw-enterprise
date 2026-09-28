# Credential Gateway implementation contract

## Contract

This [companion](../credential-gateway-driver.md) preserves the protected design requirements. [#452](https://github.com/openclaw/openclaw-enterprise/pull/452) is the common source and revision-attachment interface. The former `oce-credential-gateway/v1` selection, types and operations below are historical examples, not a competing normative interface or accepted OpenShell API. Their protected authority, custody, routing, response, bounds and recovery properties remain future requirements; casts and structurally similar objects grant no authority and each original association requires verification. The first static-source MVP does not claim those protected guarantees.

## Selection and immutable binding

The following selection example and encoding are historical, superseded by #452. Preserve the immutable binding and original-owner cleanup properties as protected target requirements.

Unexecuted Installation: `{"drivers":{"credential_gateway":{"id":"openshell-credentials","configuration":{"sandboxDriverId":"openshell-sandbox"}}}}`. Composition derives `implementation: "openshell"`. Before effects, validate the exact non-null canonical Sandbox id, role, methods, version, configuration and frozen hooks. Reject unknown fields, duplicate configuration, external packages and invalid, mutated or conflicting selection without replacing prior selection. Null reserves future implementations only. No inheritance/capability-array migration. One hook-bearing view initializes and closes once in each API or worker process. No cross-process serialization or API-only Provider credentials in workers.

Freeze role, configuration and hook identity before dependents create effects. In the historical design, the revision transaction would persist `GatewayBinding`. Identical selection is a no-op. Leases retain exact credential, revision, profile, original session generation, deadline and cleanup routes through restart. Changed selection cannot retarget old use or cleanup. Original session aliases never become configuration-generation substitutes. The precise persisted encoding remains an owner decision.

## Selected types

These shapes are not the selected common Driver contract. Their authority and original-binding properties are protected target requirements.

The nineteen illustrative shapes include nine unique-symbol brands for owner-produced objects; `GatewayLease` and `BoundExchange` were opaque handles. They are not normative signatures.

```typescript
declare const trustedRevision: unique symbol;
declare const authenticatedOperation: unique symbol;
declare const gatewayLease: unique symbol;
declare const originalAttempt: unique symbol;
declare const boundExchange: unique symbol;
declare const preparedMediation: unique symbol;
declare const requesterAuthority: unique symbol;
declare const expectedExecution: unique symbol;
declare const receivingEvidence: unique symbol;
```

```typescript
type OriginalAttempt = Readonly<{ [originalAttempt]: true; operationId: string }>;
```

```typescript
type GatewayLease = Readonly<{ [gatewayLease]: true }>;
```

```typescript
type BoundExchange = Readonly<{ [boundExchange]: true }>;
```

```typescript
type Bounds = Readonly<{ deadlineMonoMs: number; signal: AbortSignal }>;
```

```typescript
type GatewayBinding = Readonly<{
  driverId: string;
  implementation: string;
  contractVersion: "oce-credential-gateway/v1";
  profileDigest: string;
  sandboxDriverId: string | null;
}>;
```

```typescript
type TrustedRevision = Readonly<{
  [trustedRevision]: true;
  namespaceId: string;
  agentId: string;
  revisionId: string;
  // Original owner aliases, never configurationGeneration substitutes.
  sessionGeneration: string;
  binding: GatewayBinding;
  trustProfile: "explicitCompatibility" | "protectedInvocation";
}>;
```

```typescript
type CredentialReference =
  | Readonly<{
      kind: "repository";
      repositoryRef: string;
      providerInstanceId: string;
      repositoryId: string;
      grantId: string;
    }>
  | Readonly<{
      kind: "model";
      secretRef: string;
      sourceVersion: string;
      providerRef: string;
      modelId: string;
    }>;
```

```typescript
type Operation =
  | Readonly<{ kind: "repository.exchange"; operationCode: string; effect: "read" | "write" }>
  | Readonly<{ kind: "model.exchange"; protocol: "openai-responses"; modelId: string }>;
```

```typescript
type Destination = Readonly<{
  scheme: "https";
  host: string;
  port: number;
  policyRef: string;
  policyVersion: string;
}>;
```

```typescript
type RequesterAuthority = Readonly<{ [requesterAuthority]: true }> &
  (
    | Readonly<{ kind: "interactive"; principalId: string; admissionRef: string }>
    | Readonly<{ kind: "admitted-work"; workId: string; originalAdmissionRef: string }>
  );
```

```typescript
type ExpectedExecution = Readonly<{
  [expectedExecution]: true;
  servicePrincipalId: string;
  assignmentRef: string;
  assignmentGeneration: string;
  incarnationRef: string;
  originalDeadlineWallMs: number;
}>;
```

```typescript
type ReceivingEvidence = Readonly<{
  [receivingEvidence]: true;
  connectionRef: string;
  assignmentRef: string;
  observedAtWallMs: number;
}>;
```

```typescript
type Assurance =
  | Readonly<{ kind: "explicitCompatibility"; assurance: "session-association-only" }>
  | Readonly<{
      kind: "protectedInvocation";
      requester: RequesterAuthority;
      expected: ExpectedExecution;
      receiving: ReceivingEvidence;
    }>;
```

```typescript
type PreparedMediationBinding = Readonly<{
  [preparedMediation]: true;
  owner: "repository" | "model";
  originalBindingRef: string;
  originalDeadlineWallMs: number;
}>;
```

```typescript
type GatewayPreparation = Readonly<{
  revision: TrustedRevision;
  material: PreparedMediationBinding;
  attempt: OriginalAttempt;
}>;
```

```typescript
type AuthenticatedOperation = Readonly<{
  [authenticatedOperation]: true;
  revision: TrustedRevision;
  assurance: Assurance;
  caller: Readonly<{ kind: "agent-service-principal"; principalId: string }>;
  credential: CredentialReference;
  operation: Operation;
  destination: Destination;
  attempt: OriginalAttempt;
}>;
```

```typescript
type SafeReason =
  | "denied"
  | "stale"
  | "unsupported"
  | "unavailable"
  | "deadline"
  | "destination"
  | "invalid-request";
```

```typescript
type Failure =
  | Readonly<{ kind: "not-dispatched"; reason: SafeReason }>
  | Readonly<{ kind: "uncertain"; attempt: OriginalAttempt }>;
```

```typescript
type GatewayStatus = Readonly<{
  admission: "preparing" | "ready" | "withdrawn";
  cleanup: "not-requested" | "pending" | "complete";
  deadlineWallMs: number;
}>;
```

## Operations and example

The method signatures and the following example are historical, not selected Driver operations. #452 does not require per-request mediation; equivalent protected behavior remains future work.

Workers create, repair and retire sessions once. Compute’s proposed `prepareGatewayMediation` consumes prepared `ComputeRevisionContext.repositoryCredentials`, never environment strings. `prepare` cannot acquire or renew credentials, mint authority, repeat `RepoDriver.open` or repair sessions. Its safe projection pins the exact revision, credential, original session and material generation, deadline and profile. Bytes and mount paths remain private.

Each operation takes final receiving-process `Bounds` and returns its declared Promise. Safe refusal reasons are closed. Admission progresses from `preparing` to `ready` to `withdrawn`. Cleanup progresses independently from `not-requested` to `pending` to `complete`.

```typescript
interface CredentialGatewayDriver extends Driver {
  readonly capability: "credential_gateway";
  readonly contractVersion: "oce-credential-gateway/v1";
  prepare(
    input: GatewayPreparation,
    bounds: Bounds,
  ): Promise<Readonly<{ kind: "prepared"; lease: GatewayLease; status: GatewayStatus }> | Failure>;
  mediate(
    input: AuthenticatedOperation,
    lease: GatewayLease,
    exchange: BoundExchange,
    bounds: Bounds,
  ): Promise<
    Readonly<{ kind: "completed"; attempt: OriginalAttempt; responseStatus: number }> | Failure
  >;
  status(
    lease: GatewayLease,
    bounds: Bounds,
  ): Promise<GatewayStatus | Readonly<{ kind: "unavailable" }>>;
  withdraw(
    lease: GatewayLease,
    bounds: Bounds,
  ): Promise<
    Readonly<{ kind: "withdrawn" }> | Readonly<{ kind: "pending"; attempt: OriginalAttempt }>
  >;
  dispose(
    lease: GatewayLease,
    bounds: Bounds,
  ): Promise<
    Readonly<{ kind: "disposed" }> | Readonly<{ kind: "cleanup-pending"; attempt: OriginalAttempt }>
  >;
}
```

**Illustrative, unexecuted protected request.** Compute receives the original worker-prepared repository context for one admitted revision and original attempt. It passes that `GatewayPreparation` and receiving-process `Bounds` to `prepare`. Success returns an opaque lease and safe `GatewayStatus`.

Trusted ingress later authenticates an allowed Git fetch. It supplies a fresh `AuthenticatedOperation`, the retained lease, the original-session/request/parsed-plan `BoundExchange`, and `Bounds` to `mediate`. Success returns `completed`, the original attempt and safe response status. Responses travel **only through the BoundExchange bound by trusted ingress to the original session, request and parsed plan**, never through an arbitrary send callback. Independent provider readback establishes the remote result separately from response status.

If a protected revision arrives with compatibility assurance, mediation returns `not-dispatched` with `denied`. If a push may have reached GitHub, it returns `uncertain` with the original attempt. Nobody automatically retries that write.

The consumer calls `status` to observe the original binding. It calls `withdraw` to request and observe the original owner's closure of new and active traffic. It calls `dispose` to release only exact owned attachments through original custody, without repeating closure or erasing obligations. Unknown completion remains pending.

Example provider names are historical. #452 proposes the common source and attachment interface; #461 implements static registration, removal, attachment and status. Historical mediation resource scope and status detail remain unselected. `AuthenticateProvider` connects or reconnects a provider, not Agent requests. Removal cannot delete shared sources or imply upstream key revocation.

## Authority, routing and compatibility

Git/gh follows OpenShell → existing OCE HTTPS service → private GitHub authentication. Protected adapters privately authenticate allowed Responses HTTPS/streaming. No arbitrary proxy, parallel issuer or direct GitHub bypass. Closed `git-read/git-write/git-full` parsing rejects mismatched effects/plans, unknown routes, redirects and destination rewrites. Read-only push refuses before dispatch. The current broker does not filter GraphQL fields or mutations: GitHub enforces repository/permission grants, public data may be returned, and every GraphQL POST counts as a possible write. Bound request time, headers and responses. Mandatory original-owner audit retains safe correlations/outcomes and refuses on unavailability. Public results, exceptions, audit and telemetry exclude credentials, payloads, raw URLs, headers and provider errors.

Source owners verify genuine requester authority, expected execution and actual receiving-connection association before protected acquisition. Mediators recheck those facts before dispatch. References, digests, bearers, headers and TLS peers alone prove none of them. Missing producers or evidence keep staged admission nonserving. Background Work retains its original admission and never fabricates a human session.

Every request needs a freshly authenticated operation and original-attempt binding without widening its existing lease. `Assurance.kind` must match the revision-selected trust profile or deny. Protected profiles meet their guarantees or refuse in every environment. Material copied from the Agent must not grant access outside the cluster, directly or through any reachable gateway. No silent compatibility fallback is allowed. Compatibility retains bearer replay and its existing withdrawal/restart limits without mandatory SPIRE.

The existing [scoped direct-model-key implementation exception](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/docs/design/safeguards.md#secret-access) permits authorized workload delivery. The proposed [`harnessAuth` binding](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/specs/30-harness-auth-binding.md) specifies an exact-Namespace OCC Secret binding for authorized dedicated Codex or combined embedded OpenClaw gateway/Harness. Each consumer needs separate authorization at admission and dispatch. Dedicated gateways receive no model key. Provider-account tokens serve only authorized dedicated Codex. Embedded access-token execution is unsupported. Direct delivery provides neither protected mediation nor copied-authority guarantees and cannot downgrade a protected revision.

CI may use fake credentials and mocked model responses without strong isolation. Prefer the strongest practical boundary elsewhere. Local Docker or Podman with real credentials needs a separate isolation assessment. A `.env` file, key-finding script or proxy alone establishes no isolation or credential guarantee.

## Bounds and source lifetime

Finite receiving-process monotonic deadlines reject remote monotonic timestamps. Restart conservatively converts persisted wall deadlines under the original owner's clock policy, without extending source validity or authority. Cancellation or deadline stops submission and bounds waiting. Accepted finalization survives disconnect.

Source owners retain validity, renewal, overlap policy and retirement. Static values bind an exact source version and acquire no invented expiry. Issued credentials retain the issuer's scope, expiry, minimum validity and replacement policy. Unsupported or uncertain revocation remains cleanup-pending.

Protected new and active Git and model traffic must close within **30 seconds from withdrawal or renewal-loss onset to the last active byte**, including observation, caching and scheduling. Selected active exchanges recheck closure within **five seconds** and stop on observation expiry or database loss. This bound is neither a universal cleanup deadline nor an upstream-finalization deadline. Where selected, the separate five-second finalization observer remains required under its original profile; neither the active-traffic recheck nor the 30-second target replaces it. Measure actual onset, observation, last admission, last byte and disposal separately.

## Failure, withdrawal and cleanup

Partial setup must compensate or retain its cleanup before throwing because outer rollback sees only returned adapters. Uncertain acquisition or dispatch retains the original attempt, capacity and late settlement, without replay or reissuance. Conclusive pre-dispatch refusal returns a safe reason. After possible dispatch, the original owner must establish a conclusive outcome or retain uncertainty.

Worker restart may preserve service sessions. Service replacement can lose ephemeral bearer and effect inventory. State correlations and unavailable status prove neither absence nor settlement, cannot reconstruct forgotten effects and never permit reacquisition. Original owners reconcile known attempts. Deny use when required inventory is lost. State transactions cover their records, not provider effects. Protected recovery still requires durable-inventory suppliers where its guarantees depend on them.

Ready means mediation only, separate from containment, original-session readiness and Harness activation. Withdrawn admission never reopens, even when cleanup fails. Static disposal cannot revoke an upstream key, erase copied bytes or delete another session's shared material. Original owners retain pending closure and exact attachment cleanup until observed complete.

The [historical protected lifecycle SVG](request-lifecycle.svg) and [editable Mermaid](request-lifecycle.mmd) illustrate original-owner admission, preparation, refusal, uncertainty, withdrawal and cleanup; their method names are not the selected interface. They do not establish installed behavior.

## Deployment and observable use

Prepare validated images, private sessions, workspaces and authorized sources. With a ready Configuration, Namespace and worker, save the Agent. Call the authorized bodyless [deploy API](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/docs/reference/agents/deployment.md), `POST /namespaces/:namespaceId/agents/:agentId/deploy`. Poll with revision-read permission. A 202 admits Work, not readiness; historical activation does not establish current readiness.

For [existing embedded Git](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/docs/guides/repository-credentials.md#ask-the-agent-to-work-in-the-repository), start a TUI model task inside the Ready active gateway Pod's gateway container. Observe the Agent's workspace Git/gh result through remote commit or pull-request state. The [separate model check](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/docs/guides/operate/model-verification.md) matches the active revision and Ready Pod before observing authenticated `/v1/chat/completions` through loopback forwarding. Neither proves protected Responses. OpenShell and Compute must connect the admitted revision and original session to authenticated invocation, current readiness and independent provider readback.

## Implementation and acceptance detail

[Pinned main](https://github.com/openclaw/openclaw-enterprise/tree/4373b6e39e9a9d1973abfeb08d751fbf53d501de) contains GitHub custody, bearer authorization and session/Sandbox foundations. [#461](https://github.com/openclaw/openclaw-enterprise/pull/461) merged initial static-source registration; immutable profile joins and protected models remain proposed. Protected bootstrap must prepare original sessions and refuse activation until the required bindings and receiving evidence are connected. This proposal supplies no implementation acceptance or installed qualification.

[Pinned OpenShell source](https://github.com/NVIDIA/OpenShell/blob/f8002d19ad2f948abf48bd2f5ca4f8ebd388e3c8/proto/openshell.proto) supplies Create/DeleteProvider, Attach/DetachSandboxProvider, credential refresh and supervisor readiness. Its GetProviderRefreshStatus and GetSandboxProviderStatus observe different lifecycle stages. OAuth refresh and runtime token grants can overlap; these are not exclusive credential types. The source commit is pinned; a corresponding release label has not been verified. [OCE's client](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/apps/controller/src/drivers/sandbox/openshell-gateway-client.ts) does not call them. [Provider readiness](https://github.com/NVIDIA/OpenShell/blob/f8002d19ad2f948abf48bd2f5ca4f8ebd388e3c8/docs/sandboxes/manage-providers.mdx#L188-L192) neither tests backend model access nor cancels requests already sent upstream. OpenAI/Codex provider profiles are import-only examples, not protected Responses or subscription acceptance. Desired configuration, observed attachment READY/REVOKED, session readiness, mediation admission, cleanup, active-traffic closure and upstream acceptance are distinct. Owners must map source version and expiry, receipts, original revision/session generation and observation freshness before claiming these joins.

Preserve guards until ordinary API/worker consumers prove replaceable selection, exact effect counts, invalid/mutated configuration refusal, independent model/Git readback, read-only-write and foreign-scope/destination/redirect refusal, confidentiality, bounded responses and safe audit. Verify rotation, partial and uncertain effects, original-attempt settlement, profile-bound restart and sibling-safe cleanup separately for sandbox-only, combined Codex and dedicated OpenClaw.

Inventory exposed model, gateway, session, channel and workload authority. Demonstrate copied-authority denial separately from authorized Agent use. Pin source, image, chart, kernel, container-network-interface, storage, native-tool and model versions. Preserve caller DNS pins and hostname/SNI/certificate validation. `tls: skip` disables OpenShell substitution on the OCE hop, not caller verification. Missing transport, mounts, protected bootstrap, immutable encoding and dedicated OpenClaw protocol remain supplier decisions, with real consumers and corresponding acceptance evidence required before guard removal.

## Supplier decisions and ownership

Under the proposed [#452](https://github.com/openclaw/openclaw-enterprise/pull/452) common contract, Installation Providers configure clients; upstream records hold shared configuration; per-Agent attachments bind admitted revisions. Registration grants no Agent authority. OCE selects `sandbox` and `credential_gateway` independently from one OpenShell implementation. Compute retains Sandbox lifecycle. Workers retain session creation, repair and retirement. Existing credential and Secret owners retain custody. Native Gateway and dedicated Harness run separately; GitHub authentication remains in the repository HTTPS worker-Pod sidecar.

The historical provider names remain labels, not a competing interface. The proposed #452 interface accommodates static, OAuth and dynamic sources; MVP need not support all three. Owners must identify API/version, provider connection owner, reauthentication, credential-type support, source version/expiry, and attachment receipts bound to original revision/session generation and observation freshness. Detaching one Agent differs from removing shared provider configuration; neither establishes upstream revocation.

OpenShell and Compute must identify authenticated original-session transport despite the inspected source's Authorization stripping, session readiness, and private/workspace mounts within its PVC/projected-token limits. Model and traffic owners must map supported Responses attachment, status and detachment to observable closure of new requests and active streams. A routed 401 or stopped app-server process establishes neither authenticated access nor traffic closure.

IAM, State, Work, Compute and credential owners must connect nonserving bootstrap to genuine receiving evidence before acquisition without duplicate preparation. Driver/OCC and State own the immutable revision encoding. Runtime and credential owners must reconcile RFC321's compatibility-first sequence with the protected-model-first combined target before dependent worker-Pod/proxy changes. RFC321 remains a separate unmerged proposal. The dedicated OpenClaw topology, adapter and protocol, and the isolation assessment for local Docker/Podman with real credentials, remain open. Existing implementation, installation, review, publication and merge gates still apply.

Sandbox-only remains independent. The first combined target is API-created dedicated Codex using a static model source and the existing GitHub service; the joined path and its proof remain open. Protected Responses and bounded active withdrawal remain future targets; cleanup must preserve sibling Agents. Dedicated OpenClaw requires separate qualification under the stronger target retained in [issue 118](https://github.com/openclaw/openclaw-enterprise/issues/118). Gateway-only OpenShell, external multirole factories and additional protocols remain deferred. Optional proxies, `.env` readers and key-finding scripts are undelivered examples, not isolation or credential guarantees.

## References

[Original foundations](https://github.com/openclaw/openclaw-enterprise/tree/6b5c9093b75044f181db74bc14dffaa3410e617a), [Driver ownership](https://github.com/openclaw/openclaw-enterprise/blob/6b5c9093b75044f181db74bc14dffaa3410e617a/specs/17-provider-driver-abstraction.md), [binding authority](https://github.com/openclaw/openclaw-enterprise/blob/6b5c9093b75044f181db74bc14dffaa3410e617a/specs/30-harness-auth-binding.md), [repository recovery](https://github.com/openclaw/openclaw-enterprise/blob/4373b6e39e9a9d1973abfeb08d751fbf53d501de/docs/reference/repository-credentials.md), [RFC321](https://github.com/openclaw/openclaw-enterprise/blob/388864ebec1474ee1d10ce0001c256bf5063b5de/specs/37-openshell-runtime.md). Pinned OpenShell source and RFC321 supply source context, not installed qualification.
