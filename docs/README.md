# OpenClaw Enterprise

OpenClaw Enterprise is the open platform for managing agents.

## Start and deploy

- [Concepts](guides/concepts.md): understand tenancy, Agents, execution, configuration, and access.
- [Quickstart](guides/quickstart.md): start locally, sign in, and make an authenticated request.
- [Deploy](guides/deploy.md): configure Docker Compose or Kubernetes, verify your deployment, run the development end-to-end TUI proof, and troubleshoot startup.
- [Observability](guides/observability.md): configure operational log export, Collector metrics, and delivery checks.
- [Testing](testing.md): choose test suites, prepare credentials and infrastructure, and interpret results.
- [Release evidence harness](reference/release-evidence.md): inspect required gates and collect bounded observations; component fixtures and live release acceptance remain pending.
- [Acceptance companions and producer receipts](reference/acceptance-companion-v1.md): validate offline assertion and receipt bindings; records remain unauthenticated, and authentic execution and release acceptance remain separate.
- [Allocation companion reader](reference/allocation-companion-v1.md): inspect complete expected inventory, declared attempts and receipt history with bounded offline diagnostics; authentic acceptance remains separate.
- [Native consumer measurement](reference/native-measurement-v1.md): validate supplied measurement profiles and evaluate recorded results; numeric selection, authenticated observations, and runtime qualification remain separate.
- [Shared native interaction scenarios](reference/shared-native-scenarios-v1.md): inspect labeled Slack/Teams traces and ordering/correlation findings; fixtures and declaration checks do not establish native execution or authority.
- [Isolated upstream consumer preparation](reference/isolated-upstream-consumer-v1.md): validate selected artifacts and reconcile recorded cases; installed conformance and runtime qualification remain separate.
- [Security events](reference/security-events.md): versioned projection, audit access, and retention contracts; production emitters and durable sinks remain unimplemented.
- [Operational diagnostic records](reference/operational-diagnostics.md): submit bounded lifecycle and security projections to Pino; production invocation, durable audit delivery, and Collector verification remain separate.
- [Startup diagnostics](reference/startup-diagnostics.md): interpret bounded startup failures and verify configuration privately.
- [Fresh Installation bootstrap](reference/fresh-installation-bootstrap.md): understand account and Installation ordering, partial failure, and uncertain-outcome recovery.
- [Build graph](reference/build.md): inspect explicit TypeScript, Rust, and image dependencies; prepare inputs separately from offline source builds.

- [Workload identity](reference/workload-identity.md): configure the local SPIFFE identity source and run its metadata-only diagnostic.
- [Native service peer transport](reference/native-service-peer.md): authenticate and own in-process mutual TLS connections; service roles and runtime authority remain separate.
- [Runtime service transport](reference/runtime-service-transport.md): configure admitted services and the native mutual TLS listener for exact historical operation readback.

## Architecture

- [`integration/dev` overview](integration-dev-overview.md): branch scope, system diagrams, and team review priorities.
- [Platform design](design.md): platform architecture and resource model.
- [Current architecture](ARCHITECTURE.md): API, worker, storage, and Agent execution.
- [Configurable execution limits and persistent Agent controls](../specs/24-configurable-execution-limits.md):
  selected uncapped default, finite authority, status/stop requirements and the
  remaining coordinated implementation and runtime qualification.

## Draft RFCs

Start with the [illustrated RFC series overview](https://github.com/openclaw/rfcs/blob/docs/github-app-credentials/rfcs/0027/runtime-access-overview.md)
and [accepted RFC 0027](https://github.com/openclaw/rfcs/blob/main/rfcs/0027-openclaw-enterprise.md).
The following proposals extend that baseline; they remain drafts, not descriptions
of implemented or qualified behavior on this branch.

- [RFC 0034: Credentials and GitHub access](https://github.com/openclaw/rfcs/blob/docs/github-app-credentials/rfcs/0034-github-app-credentials.md)
  ([PR 68](https://github.com/openclaw/rfcs/pull/68)): broker-managed credentials,
  trusted mediation, bounded renewal, and recoverable cleanup.
- [RFC 0035: Identity and enforcement](https://github.com/openclaw/rfcs/blob/docs/workload-identity-rfc/rfcs/0035-workload-identity-and-runtime-authority.md)
  ([PR 69](https://github.com/openclaw/rfcs/pull/69)): execution identity, protected
  origin, bounded enforcement leases, and qualified outage reads.
- [RFC 0036: Service-owned work](https://github.com/openclaw/rfcs/blob/docs/turn-bound-delegation-rfc/rfcs/0036-turn-bound-delegated-authority.md)
  ([PR 70](https://github.com/openclaw/rfcs/pull/70)): logical work across turns and
  runtime replacements, attached children, isolation, and cancellation.
- [RFC 0037: Runtime lifecycle](https://github.com/openclaw/rfcs/blob/docs/agent-runtime-lifecycle-rfc/rfcs/0037-persistent-agent-runtime-lifecycle.md)
  ([PR 71](https://github.com/openclaw/rfcs/pull/71)): safe stop, completed-state
  recovery, writer exclusion, and finite completed-result delivery.

Each main RFC links to its detailed specifications and diagrams. Read its PR branch,
not only the RFC repository's `main`. For implementation questions, compare the
proposal with this branch's source, [current references](reference/README.md), and
[verification requirements](testing.md). Cite the inspected branch or commit;
proposal acceptance, implemented behavior, and runtime qualification are separate.

## Reference

- [Platform console](reference/console.md): sign in, select Namespaces, browse
  accessible resources, create Agents with editable Configuration JSON, and edit
  supported channel draft settings at `/console/`.

- [Reference index](reference/README.md): browse all features and Drivers.
- [Namespaces](reference/namespaces.md), [Agents](reference/agents.md), and
  [Configuration](reference/configuration.md): create, organize, and configure Agents.
- [Agent workspace files](reference/agents.md#workspace-files): read and replace four native Agent workspace files.
- [Workspace snapshot utility](reference/workspace-snapshots.md): host Btrfs capture,
  incremental export, and portable filesystem restoration.
- [Gateway routing with Envoy](reference/gateway-routing.md): private routes, service-key bootstrap, TLS, and network enforcement.
- [AgentRevision repositories](reference/revision-repositories.md): admitted snapshots,
  transaction ownership, and storage verification.
- [Kubernetes Secret Driver](reference/drivers/kubernetes-secret.md): store Secrets
  and bind them to selected Agent gateways.
- [Authentication](reference/authentication.md),
  [Authorization](reference/authorization.md), and
  [Service accounts](reference/service-accounts.md): sign-in, permissions, and credentials.
- [Authentication storage failures](reference/authentication-failures.md): unconfirmed
  logout outcomes, dependency diagnostics, and focused verification.
- [Workload profile request authentication](reference/workload-profile-request-authentication.md):
  original request binding, session currentness, and transaction-owned cleanup.
- [Providers](reference/providers.md): authenticated clients, related Drivers,
  optional Agent association, and safe configuration changes.
- [Harness execution](reference/harness-execution.md) and
  [Controller reconciliation](reference/controller.md): runtime topology, deployment,
  and revision activation.
- [Identified deployment commands](reference/lifecycle-deploy-v2.md): explicit V2 command identity, saved-draft expectations, and required admission participants.
- [Lifecycle status API](reference/lifecycle-status-api.md): authorized intent and operation reads; the default composition returns dependency-unavailable without its production source and authenticated currentness bridge.
- [Runtime authority interfaces](reference/runtime-authority.md): immutable bindings,
  purpose-specific results, trusted-context requirements, and contract verification.
- [Runtime activation](reference/runtime-activation-v1.md): bounded conditional routing,
  exact predecessor cleanup and original-operation recovery.
- [Channels and delivery](reference/channels.md): current direct-channel topology,
  binding versus admission, state ownership, and Slack/Teams verification limits.
- [Security controls](reference/security.md), [settings](reference/settings.md),
  and [HTTP API](reference/api.md): access controls, deployment configuration, operational logging, and request schemas.
- [Drivers](reference/README.md#drivers): select and configure compute, configuration,
  identity, and Secret implementations.

## Understand the code

- [Admitted-undispatched journal interfaces](reference/admitted-undispatched-journal.md): consume admission-phase status and cancellation definitions; durable producer amendments, current authority, and physical-stop or release proof remain separate.
- [Manual channel bindings](reference/channel-bindings.md): administer app, human, and exact Agent mappings.
- [Account authority interface](reference/account-authority.md): consume current account and exact-operation contracts; live authority adapters and effect guards remain separate implementations.
- [Credential backend profile](reference/credential-backend.md): validate local capability and configuration declarations; protected custody, current authority, and backend/runtime qualification remain separate.
- [Linux custody clock](reference/custody-clock.md): read conservative kernel clock bounds through a protected native executable; unsynchronized hosts refuse and deployment selection remains explicit.
- [SPIRE registration client](reference/spire-registration-client.md): create, inspect and retire constrained native provider entries; OCE enrollment, immutable runtime correspondence and durable recovery remain with their original owners.
- [Repository preparation interfaces](reference/repository-preparation.md): validate preparation and credential-custody records; current authority, durable storage, native delivery, and provider effects remain with their accepting implementations.
- [Work authority ports V2](reference/work-authority-ports-v2.md): inspect inactive
  interface declarations and their original-owner requirements; declarations
  do not activate Work authority.
- [Repository Work owner](reference/repository-work-v2.md),
  [business-use policy](reference/repository-work-policy-v2.md),
  [State adapter](reference/repository-work-state-v2.md), and
  [Runtime origin](reference/repository-work-origin-v2.md): follow repository-use
  component construction and its required original native, State, policy and
  custody inputs.
- [Repository credential inventory](reference/repository-credential-inventory-v2.md)
  and [protected GitHub custody](reference/protected-github-custody.md): understand
  recorded credential responsibility, protected material storage and recovery;
  accepting authority and delivery remain with their original owners.
- [Trusted repository publication](reference/repository-publication-v1.md): inspect
  immutable Git candidates and the approval/publication component; original Work,
  State/IAM, dispatcher and persistent-storage composition remain required.
- [GitHub read mediation](reference/github-mediation.md) and
  [native mediation identity](reference/github-mediation-identity.md): inspect the
  broker protocol and native connection boundary; production installation and
  complete accepting authority remain separate.
- [Repository read execution binding](reference/repository-work-selected-execution-v2.md):
  connect original native Sessions, retained execution and State admission for
  metadata and Git read services.
- [GitHub read MVP verification](reference/read-mvp-verification.md): inspect the
  supported component checks, recorded results, and remaining accepting-flow requirements.
- [Preparation Job interfaces](reference/preparation-job.md): versioned preparation identity, Job and Pod lineage, conditional effect observations, and retained staging handoff; definitions do not establish live provider authority.
- [Lifecycle admission and durable work definitions](reference/lifecycle-admission-ports.md): consume parsed requests and worker ports; authenticated admission, persistence, and installed worker integration remain separate.
- [Lifecycle handler and observation definitions](reference/lifecycle-handler-ports.md): consume handler and observation definitions; installed handlers, authentic observation producers, and runtime/provider composition remain separate.
- [Lifecycle worker effect guard](reference/lifecycle-worker-guard.md): inspect local effect guards and controlled verification; installed worker adoption, durable cleanup, and actual runtime/provider fences remain separate.
- [Worker lease cancellation](reference/worker-lease-cancellation.md): installed claim renewal and cooperative effect cancellation; claim loss does not establish provider termination or safe replay.
- [Lifecycle work codec and preflight](reference/lifecycle-work-preflight.md): encode inert work data and inspect original work through read-only preflight; queue/handler installation and actual accepting-use guards remain separate.
- [Lifecycle status projections](reference/lifecycle-status-projections.md): sanitize canonical read results without granting access; server-owned readers retain current owner and authorization checks, and authentic runtime observations remain separate.
- [Schema and auth persistence boundary](reference/schema-auth-boundary-v1.md): consume canonical schema and auth binding types; these definitions create no database or table ownership.
- [Audience observation contracts](reference/audience-observation.md): parse Slack and Teams observation contracts; live complete-reader and account authority producers remain separate.
- [Runtime resource accounting](reference/runtime-resource-accounting-v1.md): validate supplied resource arithmetic and bounded deadlines; effective resource observation and measured capacity remain unavailable.
- [Kubernetes resource normalization](reference/kubernetes-resource-normalization.md): normalize supplied accounting and render selected resource plans; protected admission association, current workload correspondence, and effective allocation remain unavailable.
- [Final Pod comparison contract](reference/containment-admission.md): consume Harness declarations and structural decoders; the original expectation adapter remains unimplemented, and current admission authority and physical enforcement remain separate.
- [Final Pod comparator](reference/final-pod-comparison.md): compare complete supplied Pod and Deployment documents; a conforming result establishes no authenticated expectation, current authority, or runtime qualification.
- [Containment control observations](reference/containment-controls-v1.md): consume bounded observation contracts and strict decoders; authenticated producers, eligibility evaluation, and physical enforcement remain separate.
- [Containment evidence and fault requests](reference/containment-evidence-v1.md): compare supplied control evidence and retain exact fault-request readback; current authority, durable fault persistence, and physical stop remain separate.
- [Node execution observer](reference/node-execution-observer.md): inspect
  node-local capture and the controller client; protected installation, current
  enrollment and live CRI/runsc qualification remain required.
- [Closed node network attachment](reference/node-network-fence.md): inspect
  closed CNI attachments and retained observations; production CNI installation,
  runtime start ordering and live gVisor qualification remain separate.
- [Direct Compute interruption preparation](reference/direct-compute-interruption.md): run controlled create, observe, and route interruption checks; these reports do not establish runtime qualification.
- [Retained store preflight](reference/retained-store-preflight-v1.md): compare trusted store and mount descriptors; a match establishes no physical storage integrity, credential-home exclusion, or writer authority.
- [Same-build recovery preflight](reference/same-build-recovery-preflight-v1.md): compare producer tuples and checkpoint references; the complete recovery preflight remains unavailable without the native candidate boundary.
- [Retirement purge manifest definitions](reference/retirement-purge-manifest.md): validate immutable manifests and store progress; complete inventory, current authority, physical settlement, and deletion remain separate.
- [Retirement purge journal definitions](reference/retirement-purge-journal.md): consume publication, observation, and exact-history contracts; atomic persistence, trusted provenance, and runtime enforcement remain separate.
- [Shared receipt identity](reference/shared-turn-receipts.md): internal event identity
  and replay classification, before authorization or durable admission.
- [Turn journal and completion](reference/turn-journal.md): PostgreSQL and explicitly configured process-local memory implementations; actual channel/runtime/canonical-store integration remains required. Memory provides no crash recovery.
- [Hosted native execution owner](reference/hosted-native-execution.md): concrete native socket custody, one original journal consumption, and independent ongoing control; composed runtime acceptance remains required.
- [Authorized turn status and cancellation](reference/turn-management-v1.md): application-port definitions and codecs; accepting authentication and current scope guards remain required.
- [Delegated authority library](reference/delegation.md): root grant constraints,
  request binding, and required owner interfaces; executable authority is not yet wired.
- [External model egress packaging](reference/egress.md): isolated DNS and
  credential-service packaging, local preflight, and outstanding runtime requirements.
- [External model egress flow](flows/external-model-egress.md): exact request,
  connection, dispatch, and cancellation ownership in the adapter components.
- [Agent split DNS](reference/agent-split-dns.md): inspect the bounded UDP/TCP
  listener; positive production routing remains unavailable without the original
  authenticated attachment, current Work and assigned endpoint producer.
- [Native GitHub HTTPS transport](reference/native-github-egress.md): finite
  transport and DNS validation, broker-backed metadata/Git read, and controlled
  client tests; original admission and production qualification remain required.
- [Upstream headless consumption probe](reference/upstream-consumption.md): verify
  the pinned source kernel and understand the remaining package and adapter gaps.
- [Runtime identity ports](reference/runtime-identity.md): verification and stream-guard definitions; native composition and live provider qualification remain separate.
- [Hosted gateway composition](reference/hosted-gateway.md): programmatic local
  Slack/Teams lifecycle ownership; protected executable startup and production
  process-owner composition remain unavailable.
- [Protected Installation Gateway startup](reference/gateway-startup-v1.md): original
  command ownership, provider submission and local lifetime; mandatory production
  authority, material and physical-settlement inputs remain separate.
- [Agent Gateway process participant](reference/compute-gateway-process.md): admitted launch correspondence, original invocation drains, conditional retirement, and physical-settlement limits.
- [Protected channel material delivery](reference/gateway-material-delivery.md): separate
  bounded disclosure using the original consumed startup claim and current selected material.
- [Docker Compose development](flows/docker-compose-development.md),
  [production startup](flows/production-startup.md),
  [production TUI attachment](flows/production-tui.md), and
  [shared platform startup](flows/platform-startup.md).
- [Platform console requests](flows/platform-console.md).
- [Lifecycle status fixture preview](flows/lifecycle-status-preview.md): inspect lifecycle observations and uncertain outcomes in a local preview; authenticated console hookup and installed operator verification remain separate.
- [Channel configuration, mapping, and delivery](flows/channel-delivery.md):
  follow the current source without treating proposed intake/brokerage as implemented.
- [Controller worker](flows/controller-worker.md),
  [Harness execution and shared storage](flows/harness-execution-topology.md), and
  [common operational logging](flows/common-logging.md).
- [Configuration and Agent revision](flows/configuration-driver.md),
  [Secret storage and gateway delivery](flows/secret-storage-and-delivery.md),
  [Driver loading](flows/driver-plugin-loading.md), and
  [Compute lifecycle hooks](flows/compute-driver-lifecycle-hooks.md).
- [Local password authentication](flows/local-password-authentication.md),
  [service API keys](flows/service-api-keys.md),
  [native credential delivery](flows/native-service-account-credential-delivery.md),
  and [Driver-issued credentials](flows/service-account-driver-credential-delivery.md).
- [Existing Kubernetes namespace placement](flows/kubernetes-existing-namespace-placement.md).
- [Agent workspace files](flows/workspace-files.md).

## Implementation history

[Spec archive](../specs/README.md): proposals, delivery records, and recorded statuses.

[Channel-hosting roadmap](../specs/22-channel-hosting-roadmap.md): proposed stages
from direct gateways to durable intake, shared-app brokerage, and optional
stronger availability; not current feature or release acceptance.
