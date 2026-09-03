# OpenShell SandboxDriver

The bundled OpenShell SandboxDriver implements the
[SandboxDriver contract](sandbox.md) using a Namespace-local
OpenShell gateway and a provider-owned dedicated Codex Harness. It works with
the bundled [Kubernetes ComputeDriver](kubernetes-compute.md); it is not a
standalone ComputeDriver and does not replace OCC ownership of Agents,
revisions, Namespaces, routing, credentials, or authorization.

OpenShell support is limited to dedicated Codex Harness revisions. Embedded
OpenClaw Agents fail closed when OpenShell is selected because embedded mode
would require OpenShell to own the Agent gateway workload too.

For the complete call sequence, see the
[Kubernetes and OpenShell Agent workload lifecycle](../../flows/kubernetes-openshell-agent-lifecycle.md).

## Ownership model

The Kubernetes Compute Driver remains the orchestration owner:

- It creates or adopts the OpenClaw Namespace and applies baseline isolation.
- It creates the per-Agent gateway, ServiceAccount, shared workspace PVC,
  Services, NetworkPolicies, revision records, and activation state.
- It calls `SandboxDriver.ensureNamespace`, when implemented, after namespace
  isolation exists.
- It delegates dedicated Harness creation to `SandboxDriver.provisionHarness`,
  when implemented; otherwise, it creates the ordinary Harness Deployment.
- It routes only to the active revision and removes routing during
  deactivation when the Service still points at that revision.

The OpenShell SandboxDriver owns only the provider sandboxing delegation:

- `configureAgent` contributes provider-specific gateway configuration before
  OCC validates and freezes the immutable Agent revision.
- `ensureNamespace` applies configured NetworkPolicy resources,
  waits for the namespace-local OpenShell gateway when readiness is configured,
  and checks gateway health. These operations are idempotent so multiple
  workers converge on one gateway.
- `provisionHarness` asks the OpenShell gateway to create one OpenShell Sandbox
  for the dedicated Codex Harness and returns the stable Sandbox reference
  directly.
- OpenShell's controller creates and owns the provider Harness Pod behind that
  Sandbox.
- `cleanup` receives the immutable Agent revision and derives the stable
  provider Sandbox identity, so retirement works even when its Pod is gone.
  Namespace cleanup also removes the configured NetworkPolicy resources.

The returned provider-owned Pod is not re-verified as an OCC-owned workload.
Compute trusts OpenShell to enforce the Sandbox it provisions, while OCC still
requires ordinary workload readiness and exact active-revision routing before
traffic is served. Each immutable Agent revision retains only
`sandboxDriverId`, so workers resolve the same selected driver for provisioning
and cleanup without persisting duplicate provider descriptors or facets.

## OpenShell containment facets

OpenShell implements all three available
[SandboxDriver containment facets](sandbox.md#containment-facets):

| Facet        | Current OpenShell behavior                                                                  |
| ------------ | ------------------------------------------------------------------------------------------- |
| `networking` | OpenShell network policies for Harness tool traffic, plus Kubernetes baseline policies.     |
| `filesystem` | Approved PVC subpath mounts and OpenShell filesystem policy for read-only/read-write paths. |
| `process`    | OpenShell process policy, including the configured run-as user and group.                   |

There is no `exec` facet. Command-level authorization and per-tool dynamic
sandbox creation are deferred; `exec` remains a tool invocation that runs inside
the selected Harness sandbox.

## Configuration

Select `drivers.sandbox` in the trusted Installation startup YAML. The bundled
OpenShell SandboxDriver can only be composed with the bundled Kubernetes Compute
Driver; selecting any installed Compute Driver with `drivers.sandbox` fails
startup.

```yaml
drivers:
  compute:
    id: compute-kubernetes
    configuration:
      # See kubernetes-compute.md for the required Kubernetes Compute config.

  sandbox:
    id: openshell-sandbox
    configuration:
      gateway:
        serviceName: openshell-gateway
        port: 50051
        workspace: default
        readiness:
          serviceName: openshell-gateway
          podSelector:
            app.kubernetes.io/name: openshell
        networkPolicyResources: []
      kubernetes:
        runtimeClassName: openshell-sandbox
        serviceAccount:
          mode: driverConfig
        sandboxDataMount:
          subPath: workspace
          mountPath: /sandbox/enterprise
          readOnly: false
      policy:
        process:
          runAsUser: "1000"
          runAsGroup: "1000"
        networkPolicies:
          - name: model-egress
            endpoints:
              - host: api.openai.com
                ports: [443]
                protocol: tcp
```

### Configuration options

These tables describe the bundled Enterprise adapter's configuration, including
options omitted from the example. Paths are relative to
`drivers.sandbox.configuration` unless stated otherwise. Required means required
when this driver is selected; nested fields are required only when their optional
parent is supplied. **None** means the adapter supplies no default. Example names,
paths, UID/GID values, and policy destinations are not defaults.

The [driver schema and validation](../../../apps/controller/src/drivers/sandbox/openshell.ts),
[gateway client](../../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts),
and [Installation selection](../../../apps/controller/src/composition/installation-config.ts)
define these requirements and defaults. Values forwarded without a default still
depend on the deployed OpenShell implementation; this table does not establish
upstream compatibility or enforcement beyond the preconditions below.

| Option                            | What it does                                                                                                       | Required               | Default when omitted       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------------------------- |
| `drivers.sandbox`                 | Selects a SandboxDriver for this Installation.                                                                     | No                     | No SandboxDriver selected. |
| `drivers.sandbox.id`              | Names the selected driver instance; revisions retain this ID for provisioning and cleanup.                         | Yes                    | None.                      |
| `drivers.sandbox.configuration`   | Supplies the bundled OpenShell adapter's settings.                                                                 | Yes                    | None.                      |
| `gateway`, `kubernetes`, `policy` | Group gateway connection, Harness Pod construction, and sandbox policy settings.                                   | Yes, all three objects | None.                      |
| `sandboxNamePrefix`               | Prefixes the stable Sandbox name derived from the revision ID; at most two characters.                             | No                     | `sb`                       |
| `logLevel`                        | Sets the OpenShell Sandbox log level.                                                                              | No                     | `info`                     |
| `providers`                       | Supplies OpenShell provider names in the Sandbox specification; separate from OCC Installation Provider selection. | No                     | `[]`                       |

#### OpenShell gateway

This gateway is OpenShell's control service, separate from the per-Agent OpenClaw
gateway. Install it before `ensureNamespace` runs; the adapter does not install
it. The real integration test uses an operator-owned Helm wrapper for setup.

| Option                           | What it does                                                                                                                               | Required                                                          | Default when omitted                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `gateway.endpoint`               | Explicit gRPC endpoint URL; overrides Service-name, port, and scheme derivation.                                                           | No, if a Service name is available below                          | Derived as `<scheme>://<service>.<backing-namespace>.svc:<port>`; a Service name containing `.` is used as the host directly. |
| `gateway.serviceName`            | Kubernetes Service name used to derive the OpenShell endpoint.                                                                             | Yes if neither `endpoint` nor `readiness.serviceName` is supplied | `gateway.readiness.serviceName`, when supplied.                                                                               |
| `gateway.port`                   | Port for the derived endpoint; an integer from 1 through 65535.                                                                            | No                                                                | `50051`                                                                                                                       |
| `gateway.scheme`                 | Selects `http` or `https` for the derived gRPC endpoint.                                                                                   | No                                                                | `https` when `rootCertificatePath` is supplied; otherwise `http`.                                                             |
| `gateway.workspace`              | OpenShell workspace identifier used for Sandbox creation and deletion; separate from the Agent's filesystem workspace.                     | No                                                                | `default`                                                                                                                     |
| `gateway.auth.mode`              | Chooses `unauthenticated` or `bearerTokenFile` authentication for gateway RPCs.                                                            | Yes if `gateway.auth` is supplied                                 | With no `auth` object, no authorization metadata is sent.                                                                     |
| `gateway.auth.path`              | Absolute path to a file containing the bearer token, read for each RPC.                                                                    | Yes for `bearerTokenFile`                                         | None.                                                                                                                         |
| `gateway.rootCertificatePath`    | Absolute path to the CA certificate file used for TLS connections.                                                                         | No                                                                | gRPC's default trust roots when the endpoint uses HTTPS.                                                                      |
| `gateway.requestTimeoutMs`       | Per-RPC deadline in milliseconds; must be an integer of at least 1000.                                                                     | No                                                                | `10000`                                                                                                                       |
| `gateway.readiness`              | Enables Kubernetes Service and Pod checks during Namespace setup. OpenShell's health RPC is still checked when this object is omitted.     | No                                                                | No Kubernetes readiness check.                                                                                                |
| `gateway.readiness.serviceName`  | Service whose existence is checked in the backing namespace.                                                                               | Yes if `readiness` is supplied                                    | None.                                                                                                                         |
| `gateway.readiness.podSelector`  | Label map selecting gateway Pods; at least one matching Pod must report `Ready=True`.                                                      | Yes if `readiness` is supplied                                    | None; the example's `app.kubernetes.io/name: openshell` must match the installation.                                          |
| `gateway.networkPolicyResources` | Namespace-scoped Kubernetes networking manifests applied during Namespace setup and removed during cleanup. Secret manifests are rejected. | No                                                                | No additional resources. Compute's baseline NetworkPolicies still apply.                                                      |

#### Kubernetes Harness settings

| Option                                  | What it does                                                                                                                                                                                                  | Required | Default when omitted                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `kubernetes.runtimeClassName`           | Names the operator-installed RuntimeClass requested for the Sandbox Pod; does not create it.                                                                                                                  | Yes      | None.                                                                                  |
| `kubernetes.serviceAccount.mode`        | `driverConfig` passes Compute's approved per-Agent Kubernetes ServiceAccount name to OpenShell. `gatewayConfigured` omits that override and requires OpenShell's configuration to select the correct account. | Yes      | None.                                                                                  |
| `kubernetes.sandboxDataMount.claimName` | Selects the existing approved workspace PVC for the data mount.                                                                                                                                               | No       | Derived from approved Harness mounts matching `subPath`; exactly one claim must match. |
| `kubernetes.sandboxDataMount.subPath`   | Selects an approved subdirectory of that PVC; rejects the PVC root, absolute paths, and `..`.                                                                                                                 | Yes      | None.                                                                                  |
| `kubernetes.sandboxDataMount.mountPath` | Container path exposing the approved PVC subdirectory; must be under `/sandbox/`.                                                                                                                             | Yes      | None.                                                                                  |
| `kubernetes.sandboxDataMount.readOnly`  | Sets the mount's read-only flag and corresponding filesystem policy; cannot make an approved read-only mount writable.                                                                                        | Yes      | None; `false` must be explicit.                                                        |
| `kubernetes.agentResources`             | Forwards resource settings for OpenShell's agent container through Kubernetes driver configuration.                                                                                                           | No       | `{}`; the adapter supplies no resource settings.                                       |
| `kubernetes.userNamespaces`             | Forwards the OpenShell Sandbox template's user-namespace setting.                                                                                                                                             | No       | Omitted; OpenShell determines behavior.                                                |

`sandboxDataMount` and `serviceAccount` are required objects. The data mount
reuses an approved Agent workspace PVC; it does not allocate a separate volume.
Approved Harness workspace mounts and the read-only projected identity-token
mount are also included in the Sandbox specification.

#### Sandbox policy

These network rules are sent to OpenShell, whereas
`gateway.networkPolicyResources` contains Kubernetes manifests. The adapter
converts each policy entry to a map keyed by its `name`.

| Option                                             | What it does                                                                                                           | Required                | Default when omitted                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `policy.process.runAsUser`                         | Sets the sandboxed process's Unix user/UID as a string; separate from its Kubernetes ServiceAccount and OCC Principal. | Yes                     | None.                                                                |
| `policy.process.runAsGroup`                        | Sets the sandboxed process's Unix group/GID as a string.                                                               | Yes                     | None.                                                                |
| `policy.filesystem.includeWorkdir`                 | Requests inclusion of the working directory in OpenShell's filesystem policy.                                          | No                      | `true`                                                               |
| `policy.filesystem.readOnly`                       | Adds read-only filesystem paths; each must be an absolute, non-root path.                                              | No                      | `[]` additional paths; approved read-only mounts are still included. |
| `policy.filesystem.readWrite`                      | Adds writable filesystem paths; cannot grant write access to an approved read-only mount.                              | No                      | `[]` additional paths; approved writable mounts are still included.  |
| `policy.landlockCompatibility`                     | Forwards OpenShell's Landlock compatibility mode.                                                                      | No                      | `best_effort`                                                        |
| `policy.networkPolicies`                           | Lists sandbox network policy entries.                                                                                  | Yes; at least one entry | None.                                                                |
| `policy.networkPolicies[].name`                    | Names the policy entry, such as `model-egress`; does not select a model or supply credentials.                         | Yes                     | None.                                                                |
| `policy.networkPolicies[].endpoints`               | Lists destination entries for the policy.                                                                              | Yes                     | None.                                                                |
| `policy.networkPolicies[].endpoints[].host`        | Destination hostname sent to OpenShell, such as `api.openai.com`.                                                      | Yes                     | None.                                                                |
| `policy.networkPolicies[].endpoints[].ports`       | Destination port list; each port must be an integer from 1 through 65535.                                              | Yes                     | None.                                                                |
| `policy.networkPolicies[].endpoints[].protocol`    | Forwards the endpoint protocol, such as `tcp`, for OpenShell to interpret.                                             | No                      | Omitted; no adapter default.                                         |
| `policy.networkPolicies[].endpoints[].tls`         | Forwards the endpoint's TLS handling setting.                                                                          | No                      | Omitted; no adapter default.                                         |
| `policy.networkPolicies[].endpoints[].enforcement` | Forwards the endpoint's enforcement setting.                                                                           | No                      | Omitted; no adapter default.                                         |
| `policy.networkPolicies[].endpoints[].access`      | Forwards the endpoint's access setting.                                                                                | No                      | Omitted; no adapter default.                                         |

`policy.process` is required; `policy.filesystem` is optional. The adapter derives
filesystem permissions from the approved workspace and identity mounts in
addition to the configured path lists.

### Effective Codex configuration

OpenShell's `configureAgent` hook contributes the effective Codex configuration
before OCC validates and freezes the revision, disabling the inner Codex
app-server sandbox:

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "enabled": true,
        "config": {
          "appServer": {
            "sandbox": "danger-full-access"
          }
        }
      }
    }
  }
}
```

This avoids stacking the Codex sandbox inside OpenShell. OpenShell becomes the
outer containment boundary for the dedicated Harness.

## Kubernetes and admission requirements

OpenShell requires an operator-installed RuntimeClass or equivalent admission
exemption for its trusted privileged components. Because Pod Security Admission
exempts the whole Pod, the cluster must also install a fail-closed admission
policy that restricts the exemption to the approved OpenShell workload shape:
trusted OpenShell images by digest, expected ServiceAccounts, approved
Namespaces, expected labels, and the exact elevated capabilities needed by
OpenShell init or sidecar containers.

Do not grant wildcard tenant permissions to the SandboxDriver. In production,
the driver uses the same authenticated Kubernetes client as the Kubernetes
Compute Driver; there is no provider-specific Kubernetes access adapter. The
controller and worker should receive only the Kubernetes access already
required by Compute plus the OpenShell-specific ability to apply configured
namespace-scoped NetworkPolicy resources and read gateway
readiness. OpenShell creates and deletes its Sandboxes through its own gateway;
the Enterprise worker needs no Sandbox custom-resource permissions.
Namespace-local RBAC must enforce the tenant boundary on the shared client.

Kubernetes NetworkPolicies are additive. The Kubernetes Compute Driver still
installs default-deny and Agent routing policies; OpenShell bootstrap policies
must allow only gateway, control-plane, callback, and approved provider
connectivity needed for OpenShell to function. Broad namespace egress or ingress
allows can bypass the intended boundary.

## Current upstream preconditions

The current code models the target integration, but production OpenShell support
depends on upstream/provider behavior matching this contract:

- OpenShell must create Sandboxes with the per-Agent ServiceAccount that Compute
  creates for the Harness.
- OpenShell must preserve the Harness's exact audience-bound, short-lived
  projected ServiceAccount token and read-only mount. Its gateway bootstrap
  token is not a substitute. Stock OpenShell `v0.0.113` does not support
  projected volumes in gateway driver configuration; the real k3d integration
  uses a test-only, operator-owned Sandbox Pod-template patch until upstream
  projected-volume support exists.
- OpenShell must preserve all approved Agent workspace PVC subpath mounts
  without falling back to its default workspace claim or mounting the PVC root.
- OpenShell must support exact environment entries backed by Kubernetes
  `secretKeyRef`, including the startup app-server token Secret. Stock
  OpenShell `v0.0.113` cannot receive those entries through the current gateway
  API; the real k3d integration uses a test-only credential bridge until
  upstream secret support exists.
- OpenShell gateway authentication must be bound to the trusted caller and the
  requested Sandbox or Pod identity.

If any of these conditions are unavailable, OpenShell-selected deployments must
fail closed instead of launching an unsandboxed or incorrectly credentialed
Harness.

## Verification evidence

[Sandbox startup integration](../../../tests/integration/sandbox-driver-startup.test.mjs),
[controller lifecycle integration](../../../tests/integration/controller-lifecycle.test.mjs),
and [PostgreSQL integration](../../../tests/integration/postgres-platform-state.test.mjs)
cover selection, revision lifecycle, and persistence.

[Real OpenShell integration](../../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is opt-in through `OCC_TEST_OPENSHELL_K3D_REAL=1` and is skipped without the
explicit prerequisites.

That test requires a disposable k3d setup, PostgreSQL, OpenShell CLI or Helm
inputs, real OpenClaw and Codex images, an approved OpenShell RuntimeClass or
equivalent admission setup, and a real provider credential. It verifies a real
gateway model turn, provider-owned Harness creation, exact projected workload
identity, approved mounts and privileges, denied secret exposure, allowed and
denied tool egress, duplicate reconciliation convergence, cleanup, and
embedded-mode fail-closed behavior.

Common fail-closed errors include:

- `drivers.sandbox requires the bundled Kubernetes Compute Driver.`
- `OpenShell gateway Service is unavailable.`
- `OpenShell gateway Pod is not ready.`
- `OpenShell SandboxDriver only supports dedicated Codex Harness revisions.`
- `OpenShell v0.0.113 cannot receive secretKeyRef environment ...`

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [SandboxDriver contract](sandbox.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)

## Changelog

- Documented OpenShell configuration option behavior, required fields, conditional requirements, and adapter defaults.
- Removed the unused `gateway.bootstrapResources` manifest option. Gateway installation remains external to the bundled driver. (NOT_IN_SPEC)
