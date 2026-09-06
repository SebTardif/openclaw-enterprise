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
- [Native consumer measurement](reference/native-measurement-v1.md): validate supplied measurement profiles and evaluate recorded results; numeric selection, authenticated observations, and runtime qualification remain separate.
- [Shared native interaction scenarios](reference/shared-native-scenarios-v1.md): inspect labeled Slack/Teams traces and ordering/correlation findings; fixtures and declaration checks do not establish native execution or authority.
- [Isolated upstream consumer preparation](reference/isolated-upstream-consumer-v1.md): validate selected artifacts and reconcile recorded cases; installed conformance and runtime qualification remain separate.
- [Security events](reference/security-events.md): versioned projection, audit access, and retention contracts; production emitters and durable sinks remain unimplemented.
- [Operational diagnostic records](reference/operational-diagnostics.md): submit bounded lifecycle and security projections to Pino; production invocation, durable audit delivery, and Collector verification remain separate.
- [Startup diagnostics](reference/startup-diagnostics.md): interpret bounded startup failures and verify configuration privately.
- [Build graph](reference/build.md): inspect explicit TypeScript, Rust, and image dependencies; prepare inputs separately from offline source builds.

- [Workload identity](reference/workload-identity.md): configure the local SPIFFE identity source and run its metadata-only diagnostic.
- [Native service peer transport](reference/native-service-peer.md): authenticate and own in-process mutual TLS connections; service roles and runtime authority remain separate.
- [Runtime service transport](reference/runtime-service-transport.md): configure admitted services and the native mutual TLS listener for exact historical operation readback.

## Architecture

- [Platform design](design.md): platform architecture and resource model.
- [Current architecture](ARCHITECTURE.md): API, worker, storage, and Agent execution.

## Reference

- [Platform console](reference/console.md): sign in, select Namespaces, browse
  accessible resources, create Agents with editable Configuration JSON, and edit
  supported channel draft settings at `/console/`.

- [Reference index](reference/README.md): browse all features and Drivers.
- [Namespaces](reference/namespaces.md), [Agents](reference/agents.md), and
  [Configuration](reference/configuration.md): create, organize, and configure Agents.
- [Agent workspace files](reference/agents.md#workspace-files): read and replace four native Agent workspace files.
- [Gateway routing with Envoy](reference/gateway-routing.md): private routes, service-key bootstrap, TLS, and network enforcement.
- [Kubernetes Secret Driver](reference/drivers/kubernetes-secret.md): store Secrets
  and bind them to selected Agent gateways.
- [Authentication](reference/authentication.md),
  [Authorization](reference/authorization.md), and
  [Service accounts](reference/service-accounts.md): sign-in, permissions, and credentials.
- [Authentication storage failures](reference/authentication-failures.md): unconfirmed
  logout outcomes, dependency diagnostics, and focused verification.
- [Providers](reference/providers.md): authenticated clients, related Drivers,
  optional Agent association, and safe configuration changes.
- [Harness execution](reference/harness-execution.md) and
  [Controller reconciliation](reference/controller.md): runtime topology, deployment,
  and revision activation.
- [Runtime authority interfaces](reference/runtime-authority.md): immutable bindings,
  purpose-specific results, trusted-context requirements, and contract verification.
- [Channels and delivery](reference/channels.md): current direct-channel topology,
  binding versus admission, state ownership, and Slack/Teams verification limits.
- [Security controls](reference/security.md), [settings](reference/settings.md),
  and [HTTP API](reference/api.md): access controls, deployment configuration, operational logging, and request schemas.
- [Drivers](reference/README.md#drivers): select and configure compute, configuration,
  identity, and Secret implementations.

## Understand the code

- [Manual channel bindings](reference/channel-bindings.md): administer app, human, and exact Agent mappings.
- [Account authority interface](reference/account-authority.md): consume current account and exact-operation contracts; live authority adapters and effect guards remain separate implementations.
- [Credential backend profile](reference/credential-backend.md): validate local capability and configuration declarations; protected custody, current authority, and backend/runtime qualification remain separate.
- [Repository preparation interfaces](reference/repository-preparation.md): validate preparation and credential-custody records; current authority, durable storage, native delivery, and provider effects remain with their accepting implementations.
- [Lifecycle admission and durable work definitions](reference/lifecycle-admission-ports.md): consume parsed requests and worker ports; authenticated admission, persistence, and installed worker integration remain separate.
- [Lifecycle handler and observation definitions](reference/lifecycle-handler-ports.md): consume handler and observation definitions; installed handlers, authentic observation producers, and runtime/provider composition remain separate.
- [Lifecycle worker effect guard](reference/lifecycle-worker-guard.md): inspect local effect guards and controlled verification; installed worker adoption, durable cleanup, and actual runtime/provider fences remain separate.
- [Lifecycle work codec and preflight](reference/lifecycle-work-preflight.md): encode inert work data and inspect original work through read-only preflight; queue/handler installation and actual accepting-use guards remain separate.
- [Lifecycle status projections](reference/lifecycle-status-projections.md): sanitize canonical read results without granting access; server-owned readers retain current owner and authorization checks, and authentic runtime observations remain separate.
- [Schema and auth persistence boundary](reference/schema-auth-boundary-v1.md): consume canonical schema and auth binding types; these definitions create no database or table ownership.
- [Audience observation contracts](reference/audience-observation.md): parse Slack and Teams observation contracts; live complete-reader and account authority producers remain separate.
- [Runtime resource accounting](reference/runtime-resource-accounting-v1.md): validate supplied resource arithmetic and bounded deadlines; effective resource observation and measured capacity remain unavailable.
- [Final Pod comparison contract](reference/containment-admission.md): consume Harness declarations and structural decoders; the original expectation adapter remains unimplemented, and current admission authority and physical enforcement remain separate.
- [Final Pod comparator](reference/final-pod-comparison.md): compare complete supplied Pod and Deployment documents; a conforming result establishes no authenticated expectation, current authority, or runtime qualification.
- [Containment control observations](reference/containment-controls-v1.md): consume bounded observation contracts and strict decoders; authenticated producers, eligibility evaluation, and physical enforcement remain separate.
- [Containment evidence and fault requests](reference/containment-evidence-v1.md): compare supplied control evidence and retain exact fault-request readback; current authority, durable fault persistence, and physical stop remain separate.
- [Direct Compute interruption preparation](reference/direct-compute-interruption.md): run controlled create, observe, and route interruption checks; these reports do not establish runtime qualification.
- [Retained store preflight](reference/retained-store-preflight-v1.md): compare trusted store and mount descriptors; a match establishes no physical storage integrity, credential-home exclusion, or writer authority.
- [Same-build recovery preflight](reference/same-build-recovery-preflight-v1.md): compare producer tuples and checkpoint references; the complete recovery preflight remains unavailable without the native candidate boundary.
- [Shared receipt identity](reference/shared-turn-receipts.md): internal event identity
  and replay classification, before authorization or durable admission.
- [Delegated authority library](reference/delegation.md): root grant constraints,
  request binding, and required owner interfaces; executable authority is not yet wired.
- [External model egress packaging](reference/egress.md): isolated DNS and
  credential-service packaging, local preflight, and outstanding runtime requirements.
- [External model egress flow](flows/external-model-egress.md): exact request,
  connection, dispatch, and cancellation ownership in the adapter components.
- [Upstream headless consumption probe](reference/upstream-consumption.md): verify
  the pinned source kernel and understand the remaining package and adapter gaps.
- [Runtime identity ports](reference/runtime-identity.md): verification and stream-guard definitions; native composition and live provider qualification remain separate.
- [Hosted gateway composition](reference/hosted-gateway.md): programmatic local
  Slack/Teams lifecycle ownership; protected executable startup and production
  process-owner composition remain unavailable.
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
