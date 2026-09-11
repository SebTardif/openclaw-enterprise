# Deploy OpenClaw Enterprise

Choose a local or production OpenClaw Control Plane (OCC) deployment, verify
authenticated access, then inspect the admission prerequisites before deploying Agents.
Run commands from the repository root. Startup needs no model credential.

## Development

Use the [quickstart](quickstart.md) for Docker Compose startup, console sign-in,
service-key handling, and the first authenticated `/installation` check. The
[Docker development flow](../flows/docker-compose-development.md) owns startup
internals.

Prepare the [runtime package context and controller SDK inputs](deploy/build-inputs.md)
before image builds. Both controller targets require an approved digest-pinned
Go 1.26+ builder; a missing default runtime image also requires a verified
`OCC_RUNTIME_BUILD_CONTEXT`.

### Verify development

Follow [Read the Installation with the bootstrap service key](quickstart.md#read-the-installation-with-the-bootstrap-service-key).
That check proves controller access, not an Agent deployment or model turn.
For local TUI proof, cleanup, and local Kubernetes images, use
[local operations](deploy/local-operations.md). For log export, use
[platform observability](observability.md#docker-compose).

### Open the platform console

Use [Open the platform console](quickstart.md#open-the-platform-console) for
local sign-in. Production uses the same `/console/` path on the approved
internal HTTPS origin matching `OCC_AUTH_BASE_URL`; browser login uses the
human administrator session path, not service keys. The
[console reference](../reference/console.md) owns console behavior and limits.

### Kubernetes isolation

The explicit [gVisor Alpha profile](../reference/drivers/gvisor.md) selects
systrap/STRICT for dedicated Kubernetes Harnesses in development or production.
Its [fixture procedure](../testing/gvisor.md) owns actual runtime setup and evidence;
OpenShell/Kata has separate VM-host and guest-qualification requirements.

## Production

### Production prerequisites

- Explicit Kubernetes context, enforcing NetworkPolicies, Helm, `kubectl`,
  Python 3, and `yq` v4.
- Controller and runtime image digests (build them in the first step).
- External PostgreSQL with separate migrator and application roles.
- Operator-managed HTTPS access for approved clients; the chart does not create
  TLS or Ingress.
- Operator-created startup, database, authentication, optional Provider Secrets,
  fresh bootstrap PVC, gateway storage, and exact egress destinations.

### Production installation sequence

Follow these pages in order in the same operator shell:

1. [Build images and install the control plane](deploy/production-installation.md).
   Configure protected Installation YAML and Helm values, create system
   Secrets, prepare the fresh bootstrap PVC, install the chart, and authenticate
   to the production API.
2. [Prepare Namespaces and deploy Agents](deploy/production-agents.md).
   Grant tenant RoleBindings, choose embedded OpenClaw or dedicated Codex,
   provision exact-Agent credentials, and review the required ServiceAccount,
   workload profile and missing admission suppliers before submitting V2 commands.
3. [Verify the production workload](deploy/production-agents.md#verify-production-workloads).
   Confirm the active revision, gateway access, and TUI model-turn proof for
   token-authenticated gateways.

For private workspace-file administration, configure
[Agent workspace routing](deploy/workspace-routing.md). For operational logs,
use [platform observability](observability.md).

For a disposable local Kubernetes trial, first
[build and import local images](deploy/local-operations.md#build-images-for-local-kubernetes),
then resume the production installation sequence with the generated YAML copies.

### Stop or remove a production deployment

Inventory tenant workloads before uninstalling the control plane:

```bash
helm uninstall oce --namespace openclaw-system \
  --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT"
```

Helm does not own external PostgreSQL, operator-created Secrets, bootstrap PVCs,
or tenant workloads created by Compute. Retain database, bootstrap storage, and
tenant resources until recovery and retention requirements are satisfied.

For startup diagnosis, see the [production startup flow](../flows/production-startup.md).
For runtime proof, see the [production TUI flow](../flows/production-tui.md).

## Customization

Use `.env` and extra Compose files for development. Use Helm values, Kubernetes
manifests, Installation startup YAML, and Collector Secrets for production. Use
[`deploy/runtime`](../../deploy/runtime/README.md) for runtime image recipe and
immutable package-input requirements. The [settings reference](../reference/settings.md)
and Driver references own field defaults, precedence, and limits.

Trusted Installation YAML can also select the
[SSH Compute Driver](../reference/drivers/ssh-compute.md); that reference owns
host configuration, credentials, and operational limits.

The [external model egress candidate](../reference/egress.md) does not install
current authority or select mediation for an Agent. Existing low-level credential
paths are not approval for the separately admitted native runtime profile.

For native administration, use [workload identity and runtime history readback](deploy/runtime-services.md).

## Related

- [Service API keys, rotation, and bootstrap recovery](deploy/service-keys.md)
- [Local Kubernetes, development TUI, and cleanup](deploy/local-operations.md)
- [Configuration and settings](../reference/settings.md)
