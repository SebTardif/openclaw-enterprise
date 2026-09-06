# Feature reference

These living specifications describe supported OpenClaw Enterprise behavior at
this repository version: ownership, lifecycle, permissions, interface guarantees,
failure behavior, and current limitations. They contain the complete current
contract for each feature, including changes delivered by multiple implementation
specifications. They are not proposals or promises of future capabilities.

The [platform design](../design.md) remains the architectural authority. Its
target scope can exceed the current implementation; the
[architecture overview](../ARCHITECTURE.md) identifies implemented components.
Use the [quickstart](../guides/quickstart.md) or [deployment guide](../guides/deploy.md)
for deployment procedures, the [observability guide](../guides/observability.md)
for logging and Collector setup, and [flow docs](../README.md#understand-the-code)
for source execution.
Use [`deploy/runtime`](../../deploy/runtime/README.md) when a local or test
procedure needs a public Docker-only OpenClaw/Codex runtime image.

## Features

| Reference                                               | Owns                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Platform console](console.md)                          | Login, Agent creation, draft channels, revision inspection, and Namespace selection.        |
| [Namespaces](namespaces.md)                             | Tenant identity, placement, readiness, and deletion.                                        |
| [Agents](agents.md)                                     | Agent identity, mutable selection, immutable revisions, and workspace file routes.          |
| [Gateway routing with Envoy](gateway-routing.md)        | Private Agent endpoints, service keys, TLS, and network enforcement.                        |
| [Configuration](configuration.md)                       | Native documents, generations, references, and snapshots.                                   |
| [Channels and delivery](channels.md)                    | Direct channel topology, storage/custody boundaries, and verification limits.               |
| [Manual channel bindings](channel-bindings.md)          | App/human/Agent administration and mapping-only resolution.                                 |
| [Shared-turn receipt identity](shared-turn-receipts.md) | Internal identity/classification, distinct from durable admission.                          |
| [Secrets](drivers/kubernetes-secret.md)                 | Namespace-owned Secret storage, metadata-only responses, env bindings, and redeploy.        |
| [Authentication](authentication.md)                     | Supported caller credentials, sessions, bootstrap, and account provisioning.                |
| [Authorization](authorization.md)                       | Principals, Groups, Roles, Bindings, Restrictions, and exact-resource decisions.            |
| [Workload identity](workload-identity.md)               | Local SPIFFE Workload API source, credential refresh, diagnostics, and verification limits. |
| [Providers](providers.md)                               | Provider configuration, related Drivers, client ownership, and Agent references.            |
| [Service accounts](service-accounts.md)                 | Account associations, credential references, issuance, and revocation boundaries.           |
| [Harness execution](harness-execution.md)               | Runtime selection, topology, and admitted execution constraints.                            |
| [Controller reconciliation](controller.md)              | Durable lifecycle work, authorization refresh, claims, retries, and recovery.               |
| [Security](security.md)                                 | Kubernetes workload and credential boundaries and enforcement limitations.                  |
| [Settings](settings.md)                                 | Supported environment variables and programmatic configuration.                             |
| [HTTP API](api.md)                                      | Generated routes, wire schemas, and declared permissions.                                   |

Generated schemas describe wire shape. The feature pages additionally own
behavioral rules such as cross-resource ownership, lifecycle ordering, and failure
effects. Do not hand-edit the generated API page; use `pnpm openapi:generate` and
`pnpm openapi:check` after route or schema changes.

## Development internals

- [Build graph](build.md): explicit language and image prerequisites, offline source
  compilation, artifact identity, and runtime verification limits.
- [Acceptance companions and producer receipts](acceptance-companion-v1.md): validate offline assertion and receipt bindings; records remain unauthenticated, and authentic execution and release acceptance remain separate.
- [Native consumer measurement](native-measurement-v1.md): validate supplied measurement profiles and evaluate recorded results; numeric selection, authenticated observations, and runtime qualification remain separate.
- [Operational diagnostic records](operational-diagnostics.md): submit bounded lifecycle and security projections to Pino; production invocation, durable audit delivery, and Collector verification remain separate.
- [Runtime identity ports](runtime-identity.md): verification and stream-guard definitions; native composition and live provider qualification remain separate.
- [Hosted gateway composition](hosted-gateway.md): programmatic local Slack/Teams
  lifecycle ownership; protected executable startup remains unavailable.
- [Retained runtime preparation](runtime-preparation.md): internal plans, immutable request bytes and exact recovery.
- [Lifecycle admission and durable work definitions](lifecycle-admission-ports.md): consume parsed requests and worker ports; authenticated admission, persistence, and installed worker integration remain separate.
- [Lifecycle handler and observation definitions](lifecycle-handler-ports.md): consume handler and observation definitions; installed handlers, authentic observation producers, and runtime/provider composition remain separate.
- [Lifecycle worker effect guard](lifecycle-worker-guard.md): inspect local effect guards and controlled verification; installed worker adoption, durable cleanup, and actual runtime/provider fences remain separate.
- [Lifecycle work codec and preflight](lifecycle-work-preflight.md): encode inert work data and inspect original work through read-only preflight; queue/handler installation and actual accepting-use guards remain separate.
- [Lifecycle status projections](lifecycle-status-projections.md): sanitize canonical read results without granting access; server-owned readers retain current owner and authorization checks, and authentic runtime observations remain separate.
- [Schema and auth persistence boundary](schema-auth-boundary-v1.md): consume canonical schema and auth binding types; these definitions create no database or table ownership.
- [Audience observation contracts](audience-observation.md): parse Slack and Teams observation contracts; live complete-reader and account authority producers remain separate.
- [Runtime resource accounting](runtime-resource-accounting-v1.md): validate supplied resource arithmetic and bounded deadlines; effective resource observation and measured capacity remain unavailable.
- [Final Pod comparison contract](containment-admission.md): consume Harness declarations and structural decoders; the original expectation adapter remains unimplemented, and current admission authority and physical enforcement remain separate.
- [Final Pod comparator](final-pod-comparison.md): compare complete supplied Pod and Deployment documents; a conforming result establishes no authenticated expectation, current authority, or runtime qualification.
- [Containment control observations](containment-controls-v1.md): consume bounded observation contracts and strict decoders; authenticated producers, eligibility evaluation, and physical enforcement remain separate.
- [Direct Compute interruption preparation](direct-compute-interruption.md): run controlled create, observe, and route interruption checks; these reports do not establish runtime qualification.
- [Retained store preflight](retained-store-preflight-v1.md): compare trusted store and mount descriptors; a match establishes no physical storage integrity, credential-home exclusion, or writer authority.
- [Same-build recovery preflight](same-build-recovery-preflight-v1.md): compare producer tuples and checkpoint references; the complete recovery preflight remains unavailable without the native candidate boundary.
- [Turn journal and completion interfaces](turn-journal.md): versioned types and
  strict codecs; durable journal storage and channel/runtime integration remain required.
- [Protected credential storage interfaces](credential-storage.md): versioned types,
  strict codecs, and adapter ports; protected backend and runtime integration remain required.
- [Delegated authority library](delegation.md): internal root grant and model request
  constraints, with required authentication, currentness, and persistence integrations.
- [External model egress packaging](egress.md): prepared images and isolated local
  service packaging; canonical authority and production integration remain required.

## Drivers

The term **contract** names obligations that callers and Driver implementations
must satisfy. It is part of the reference, not another document lifecycle.

- [Driver selection](drivers/selection.md): trusted configuration, package loading,
  capability selection, and compatibility boundaries.
- [ComputeDriver](drivers/compute.md), [SandboxDriver](drivers/sandbox.md),
  [ConfigurationDriver](drivers/configuration.md), [IAMDriver](drivers/iam.md),
  [SecretDriver](drivers/kubernetes-secret.md), and
  [ServiceAccountDriver](drivers/service-account.md): capability contracts.
- [Docker Compute](drivers/docker-compute.md),
  [Kubernetes Compute](drivers/kubernetes-compute.md), and
  [OpenShell Sandbox](drivers/openshell-sandbox.md): implementation settings,
  supported behavior, and limitations.

Change a reference in the same PR that changes its supported behavior. Keep
proposal rationale, implementation tasks, and historical alternatives in
[top-level implementation specs](../../specs/README.md); keep runtime traces in
`docs/flows/`. Reference pages use stable feature names rather than milestone numbers.
