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

The default controller composition does not supply complete
[workload-profile admission](../workload-profiles.md). Selecting this Driver
does not supply the missing admission contributors or qualify a live runtime.

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
  for the dedicated Codex Harness. It checks the returned identity and launch
  specification against the request, then uses `GetSandbox` to verify the
  gateway's persisted record before returning the stable Sandbox reference.
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

The OpenShell gateway must be installed separately before this driver's
`ensureNamespace` runs. The bundled driver does not install the gateway.

`gateway.networkPolicyResources` accepts namespace-scoped Kubernetes resource
objects for provider networking. They are applied into the OpenClaw Namespace
during `ensureNamespace`. Do not include Secrets in this array; the driver
rejects Secret resources because OpenShell credentials must not be embedded in
startup YAML.

### Configuration ownership

Each constructed OpenShell driver retains a validated, immutable copy of its
plain configuration, including nested policies, resource settings, gateway
options, and configured NetworkPolicy resources. Changes to the caller's
configuration object after construction do not change later provisioning or
cleanup. Construction accepts frozen configuration and does not freeze or
modify the caller's object.

The native gateway adapter separately snapshots its plain gateway options,
including authentication file paths. File contents remain operation-scoped:
credential and certificate rotation at the accepted paths continues to work as
described below. A gateway client supplied through the driver's constructor
selection remains the same capability object and has the close ownership
specified below.

### Gateway client lifetime

Each native gateway call owns a separate adapter. The driver retains adapters
only for unresolved health, create, and revision-delete calls. Settlement
requests adapter close once and removes the call from the active set; completed
calls leave no endpoint or Namespace history. Repeated Namespace creation does
not depend on Namespace cleanup to retire adapters. Two Namespaces using the
same endpoint have independent native calls, so one call's settlement or
cancellation does not close the other's adapter.

The concrete driver's synchronous `close(): void` is terminal: it rejects newly
admitted `ensureNamespace`, `provisionHarness`, and `cleanup` operations, and
prevents gateway admission after asynchronous preparation. It requests close
once for every active native adapter and for the original injected capability,
attempts every notification even if another throws, and reports notification
failures together as an `AggregateError`. Repeated or reentrant close does not
repeat those requests. An injected capability remains shared by identity and is
never closed per operation.

Close requests cancellation; it does not wait for a joined drain or prove
subprocess reaping or provider termination. Active native calls remain owned
until their underlying promises settle, including calls whose signal aborted,
whose deadline elapsed, or whose close request threw. A call that never settles
remains owned. Retention therefore follows unresolved work, without a fixed
numeric concurrency or memory limit. A retirement failure after settlement is
reported to that operation; if the operation also failed, both errors are
reported together. Settled failures leave no retained error history, and a
failed close request is not proof of resource release.

Kubernetes work already admitted before close keeps its original context signal
and can continue applying resources or checking readiness. The driver checks
terminal state again before calling the gateway. Namespace-only cleanup does
not close other calls or issue a gateway operation. `configureAgent` is a pure
configuration projection and remains usable after close.

This is the concrete OpenShell driver's ownership boundary. The common Driver
contract and worker shutdown do not currently wire this close method; these
semantics do not establish automatic platform shutdown or Namespace cleanup
integration.

### Gateway transport and authentication

The native [`openshell` Go package](../../../components/runtime-security/openshell/)
implements the protocol, credentials, TLS, cancellation, and readback checks.
The controller invokes `oce-runtime-security` through a bounded JSON subprocess
adapter. Images include `/usr/local/bin/oce-runtime-security`; host development
can set `gateway.binaryPath` to the absolute path of a locally compiled binary.
This path is trusted operator configuration. See the
[native build instructions](../../../components/runtime-security/README.md).

Use an HTTPS endpoint with the gateway's trusted CA and the user authentication
configured by its operator. Bearer credentials and TLS certificates are read
from absolute file paths; they must not be embedded in startup YAML:

```yaml
gateway:
  endpoint: https://openshell-gateway.example.internal:50051
  workspace: default
  rootCertificatePath: /run/openshell/ca.crt
  clientCertificatePath: /run/openshell/client.crt
  clientPrivateKeyPath: /run/openshell/client.key
  auth:
    mode: bearerTokenFile
    path: /run/openshell/access-token
  requestTimeoutMs: 10000
```

The client certificate and private key are optional as a pair; configure them
when the gateway requires mutual TLS. Server certificate validation remains
enabled. TLS files are loaded for each operation, so replacement credentials
are picked up by the next operation. The bearer token file is read
for each RPC, so an operator can replace an expiring token between requests.
An omitted root certificate uses the platform trust store.

For OpenShell's Kubernetes driver, mutual TLS authenticates the transport;
the gateway also requires user authentication through OIDC bearer credentials
or an operator-configured trusted access proxy. A client certificate alone
does not establish workspace authorization. The caller needs the relevant
workspace role and `sandbox:write` for create/delete plus `sandbox:read` for
lookup. Gateway health is an unauthenticated upstream RPC and does not prove
these permissions. See the upstream
[gateway authentication architecture](https://github.com/NVIDIA/OpenShell/blob/d1155aa70042d3e2ee49dbfa15346b108b7c1d92/architecture/gateway.md)
and [RPC authorization declarations](https://github.com/NVIDIA/OpenShell/blob/d1155aa70042d3e2ee49dbfa15346b108b7c1d92/proto/openshell.proto).

Explicit `http://` and bare host/port endpoints remain available for
unauthenticated local verification. The driver rejects bearer credentials or
TLS files on these endpoints. When using `serviceName`, configuring a bearer
token or TLS trust/client certificate selects HTTPS unless `scheme` is
explicit; an explicit HTTP scheme with credentials fails before any gateway RPC.

### Lifecycle correspondence checks

The client checks both a successful create response and an authoritative
`GetSandbox` response for the exact requested name, workspace, ownership labels,
ownership annotations, and complete launch specification. It normalizes
protobuf defaults before comparing the specification, retaining optional-field
presence and nested driver configuration. Gateway-added metadata is allowed;
requested metadata must match. A successful create followed by a different
provider ID or a Sandbox being deleted fails reconciliation.

`ALREADY_EXISTS`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, and `UNKNOWN` create
statuses trigger one lookup. Only a matching persisted record permits success.
Missing records, mismatching requests, malformed success responses, and denied
reads remain failures. Cancellation prevents recovery and is rechecked after
asynchronous client and credential initialization, before sending an RPC.
It cannot roll back a request already accepted by the gateway. Gateway error
details, credential contents, and local credential paths are excluded from
surfaced RPC and credential-loading errors.

These checks establish correspondence with the gateway's stored launch intent.
They do not establish Pod readiness, physical Pod identity, or the policy
currently enforced by the supervisor. OpenShell can layer or update runtime
policy independently. The public API does not return an authoritative Pod UID
or accept an immutable identity precondition on `DeleteSandbox`; name reuse
between a lookup and deletion remains an upstream lifecycle limitation. A
missing gateway record does not establish physical workload absence. Delete
requires `deleted: true` or `NOT_FOUND`; it does not independently verify that
the provider has removed every workload.

The local wire schema includes all reachable launch fields from OpenShell
`v0.0.113` and `v0.0.116`, including network credential and inspection policy
fields. This allows drift in those fields to fail the comparison even when
the bundled driver's configuration does not expose them. Its `NetworkBinary`
field 2 matches upstream's deprecated boolean `harness` field. It provides no
binary SHA-256 field. Source schemas are pinned to the official
[OpenShell lifecycle proto](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/openshell.proto),
[metadata proto](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/datamodel.proto),
and [sandbox policy proto](https://github.com/NVIDIA/OpenShell/blob/455883905a7ace88e6e69834dc0685bfc799ad44/proto/sandbox.proto).

`kubernetes.sandboxDataMount` must match exactly one approved dedicated Harness
workspace mount. It may not mount the PVC root, may not use `..`, and must mount
under `/sandbox/`.

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
  token is not a substitute. Stock OpenShell `v0.0.113` and `v0.0.116` do not support
  projected volumes in gateway driver configuration. Local verification bridges
  do not establish production support; see [OpenShell testing](../../testing/openshell.md).
- OpenShell must preserve all approved Agent workspace PVC subpath mounts
  without falling back to its default workspace claim or mounting the PVC root.
- OpenShell must support exact environment entries backed by Kubernetes
  `secretKeyRef`, including the startup app-server token Secret. Stock
  OpenShell `v0.0.113` and `v0.0.116` cannot receive those entries through the current gateway
  API. Local credential bridges do not establish production support.
- OpenShell gateway authentication must be bound to the trusted caller and the
  requested Sandbox or Pod identity.

If any of these conditions are unavailable, OpenShell-selected deployments must
fail closed instead of launching an unsandboxed or incorrectly credentialed
Harness.

## Troubleshooting

Common fail-closed errors include:

- `drivers.sandbox requires the bundled Kubernetes Compute Driver.`
- `OpenShell gateway Service is unavailable.`
- `OpenShell gateway Pod is not ready.`
- `OpenShell SandboxDriver only supports dedicated Codex Harness revisions.`
- `OpenShell v0.0.113 cannot receive secretKeyRef environment ...`

## Related documentation

- [Development and production deployment](../../guides/deploy.md)

- [OpenShell testing](../../testing/openshell.md)
- [SandboxDriver contract](sandbox.md)
- [ComputeDriver contract](compute.md)
- [Kubernetes ComputeDriver](kubernetes-compute.md)
- [Configuration reference](../settings.md)

## Changelog

- Removed the unused `gateway.bootstrapResources` manifest option. Gateway installation remains external to the bundled driver. (NOT_IN_SPEC)
