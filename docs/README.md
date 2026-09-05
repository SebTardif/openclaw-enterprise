# OpenClaw Enterprise

OpenClaw Enterprise is the open platform for managing agents.

## Start and deploy

- [Concepts](guides/concepts.md): understand tenancy, Agents, execution, configuration, and access.
- [Quickstart](guides/quickstart.md): start locally, sign in, and make an authenticated request.
- [Deploy](guides/deploy.md): configure Docker Compose or Kubernetes, verify your deployment, run the development end-to-end TUI proof, and troubleshoot startup.
- [Observability](guides/observability.md): configure operational log export, Collector metrics, and delivery checks.
- [Testing](testing.md): choose test suites, prepare credentials and infrastructure, and interpret results.
- [Release evidence harness](reference/release-evidence.md): inspect required gates and collect bounded observations; component fixtures and live release acceptance remain pending.
- [Security events](reference/security-events.md): versioned projection, audit access, and retention contracts; production emitters and durable sinks remain unimplemented.
- [Startup diagnostics](reference/startup-diagnostics.md): interpret bounded startup failures and verify configuration privately.

- [Workload identity](reference/workload-identity.md): configure the local SPIFFE identity source and run its metadata-only diagnostic.

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
- [Shared receipt identity](reference/shared-turn-receipts.md): internal event identity
  and replay classification, before authorization or durable admission.
- [Upstream headless consumption probe](reference/upstream-consumption.md): verify
  the pinned source kernel and understand the remaining package and adapter gaps.
- [Docker Compose development](flows/docker-compose-development.md),
  [production startup](flows/production-startup.md),
  [production TUI attachment](flows/production-tui.md), and
  [shared platform startup](flows/platform-startup.md).
- [Platform console requests](flows/platform-console.md).
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
