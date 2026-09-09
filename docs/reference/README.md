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

The [workspace snapshot utility](workspace-snapshots.md) supplies standalone host
storage operations and portable filesystem restoration. It is not yet invoked
automatically by Agent execution.

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

- [Fresh Installation bootstrap](fresh-installation-bootstrap.md): account and Installation ordering, partial failure, and uncertain-outcome recovery.
- [Admitted-undispatched journal interfaces](admitted-undispatched-journal.md): consume admission-phase status and cancellation definitions; durable producer amendments, current authority, and physical-stop or release proof remain separate.
- [Build graph](build.md): explicit language and image prerequisites, offline source
  compilation, artifact identity, and runtime verification limits.
- [Acceptance companions and producer receipts](acceptance-companion-v1.md): validate offline assertion and receipt bindings; records remain unauthenticated, and authentic execution and release acceptance remain separate.
- [Allocation companion reader](allocation-companion-v1.md): inspect complete expected inventory, declared attempts and receipt history with bounded offline diagnostics; authentic acceptance remains separate.
- [Native consumer measurement](native-measurement-v1.md): validate supplied measurement profiles and evaluate recorded results; numeric selection, authenticated observations, and runtime qualification remain separate.
- [Shared native interaction scenarios](shared-native-scenarios-v1.md): inspect labeled Slack/Teams traces and ordering/correlation findings; fixtures and declaration checks do not establish native execution or authority.
- [Isolated upstream consumer preparation](isolated-upstream-consumer-v1.md): validate selected artifacts and reconcile recorded cases; installed conformance and runtime qualification remain separate.
- [Operational diagnostic records](operational-diagnostics.md): submit bounded lifecycle and security projections to Pino; production invocation, durable audit delivery, and Collector verification remain separate.
- [Runtime identity ports](runtime-identity.md): verification and stream-guard definitions; native composition and live provider qualification remain separate.
- [Hosted gateway composition](hosted-gateway.md): programmatic local Slack/Teams
  lifecycle ownership; protected executable startup remains unavailable.
- [Retained runtime preparation](runtime-preparation.md): internal plans, immutable request bytes and exact recovery.
- [Repository preparation interfaces](repository-preparation.md): validate preparation and credential-custody records; current authority, durable storage, native delivery, and provider effects remain with their accepting implementations.
- [Preparation Job interfaces](preparation-job.md): versioned preparation identity, Job and Pod lineage, conditional effect observations, and retained staging handoff; definitions do not establish live provider authority.
- [Lifecycle admission and durable work definitions](lifecycle-admission-ports.md): consume parsed requests and worker ports; authenticated admission, persistence, and installed worker integration remain separate.
- [Identified deployment commands](lifecycle-deploy-v2.md): explicit V2 command identity, saved-draft expectations, and required admission participants.
- [Lifecycle status API](lifecycle-status-api.md): authorized intent and operation reads; the default composition returns dependency-unavailable without its production source and authenticated currentness bridge.
- [Lifecycle handler and observation definitions](lifecycle-handler-ports.md): consume handler and observation definitions; installed handlers, authentic observation producers, and runtime/provider composition remain separate.
- [Lifecycle worker effect guard](lifecycle-worker-guard.md): inspect local effect guards and controlled verification; installed worker adoption, durable cleanup, and actual runtime/provider fences remain separate.
- [Worker lease cancellation](worker-lease-cancellation.md): installed claim renewal and cooperative effect cancellation; claim loss does not establish provider termination or safe replay.
- [Lifecycle work codec and preflight](lifecycle-work-preflight.md): encode inert work data and inspect original work through read-only preflight; queue/handler installation and actual accepting-use guards remain separate.
- [Lifecycle status projections](lifecycle-status-projections.md): sanitize canonical read results without granting access; server-owned readers retain current owner and authorization checks, and authentic runtime observations remain separate.
- [Schema and auth persistence boundary](schema-auth-boundary-v1.md): consume canonical schema and auth binding types; these definitions create no database or table ownership.
- [Audience observation contracts](audience-observation.md): parse Slack and Teams observation contracts; live complete-reader and account authority producers remain separate.
- [Runtime resource accounting](runtime-resource-accounting-v1.md): validate supplied resource arithmetic and bounded deadlines; effective resource observation and measured capacity remain unavailable.
- [Kubernetes resource normalization](kubernetes-resource-normalization.md): normalize supplied accounting and render selected resource plans; protected admission association, current workload correspondence, and effective allocation remain unavailable.
- [Final Pod comparison contract](containment-admission.md): consume Harness declarations and structural decoders; the original expectation adapter remains unimplemented, and current admission authority and physical enforcement remain separate.
- [Final Pod comparator](final-pod-comparison.md): compare complete supplied Pod and Deployment documents; a conforming result establishes no authenticated expectation, current authority, or runtime qualification.
- [Containment control observations](containment-controls-v1.md): consume bounded observation contracts and strict decoders; authenticated producers, eligibility evaluation, and physical enforcement remain separate.
- [Containment evidence and fault requests](containment-evidence-v1.md): compare supplied control evidence and retain exact fault-request readback; current authority, durable fault persistence, and physical stop remain separate.
- [Direct Compute interruption preparation](direct-compute-interruption.md): run controlled create, observe, and route interruption checks; these reports do not establish runtime qualification.
- [Retained store preflight](retained-store-preflight-v1.md): compare trusted store and mount descriptors; a match establishes no physical storage integrity, credential-home exclusion, or writer authority.
- [Same-build recovery preflight](same-build-recovery-preflight-v1.md): compare producer tuples and checkpoint references; the complete recovery preflight remains unavailable without the native candidate boundary.
- [Retirement purge manifest definitions](retirement-purge-manifest.md): validate immutable manifests and store progress; complete inventory, current authority, physical settlement, and deletion remain separate.
- [Retirement purge journal definitions](retirement-purge-journal.md): consume publication, observation, and exact-history contracts; atomic persistence, trusted provenance, and runtime enforcement remain separate.
- [Turn journal and completion](turn-journal.md): PostgreSQL and explicitly configured process-local memory implementations; actual channel/runtime/canonical-store integration remains required. Memory provides no crash recovery.
- [Authorized turn status and cancellation](turn-management-v1.md): application-port definitions and codecs; accepting authentication and current scope guards remain required.
- [Protected credential storage interfaces](credential-storage.md): versioned types,
  strict codecs, and adapter ports; protected backend and runtime integration remain required.
- [Credential backend profile](credential-backend.md): validate local capability and configuration declarations; protected custody, current authority, and backend/runtime qualification remain separate.
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
