# OpenShell tests

## Current verification boundary

The current stacked draft implements the shared runtime authentication contract
and its Kubernetes/OpenShell consumer. The credential gateway declarations do
not implement genuine Work admission or a runtime broker owner, and production
composition does not supply one. External-model activation is unavailable until
that owner is wired and the real attachment, session lifetime, and exact receiver
withdrawal are qualified. See the [owning contract](../reference/drivers/openshell-sandbox.md#broker-owned-runtime-authentication).

An explicitly selected test fails with `OpenShell external-model prerequisite
unavailable` before model credential reads, external tools, database setup, or
cluster operations. Verify that boundary without a credential file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

A nonzero result identifying the missing trusted owner is expected. With no
selection variables, the ordinary suite skips this live case. Neither result
proves a model turn or OpenShell enforcement. Existing provider-option runs do
not qualify the new path. The fixture no longer creates a provider profile or
loads a model key to manufacture authentication; do not replace the prerequisite
with a fixture owner or a revision-derived grant.

The runtime-authentication adapter and Kubernetes Compute suites use injected
owner and provider ports to verify consumer behavior: delayed admission submits
nothing early; cancellation still awaits recording; original provider errors
survive finalization failures; and retained attempts reconstruct readiness without
another create. Malformed or missing acknowledgments cannot activate routing.
These checks establish the consumer contract, not durable authority, genuine
broker admission, or authenticated provider evidence. The worker PostgreSQL cases
exercise real worker/State retry ordering with injected external provider ports.

## OpenShell Sandbox

Use this infrastructure after owner integration.
Preparing it or supplying credentials cannot satisfy the missing owner.
The suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, OpenShell CLI/Helm/chart files, imported immutable OpenShell
gateway and supervisor images, real gateway/Codex images, the Kubernetes test
database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

After owner integration, CI setup and execution use:

```sh
node scripts/ci/prepare.mjs \
  --lane openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --results "$RUNNER_TEMP/results/openshell.json"
```

For manual runtime qualification, use the [test settings](#openshell-test-environment),
[admission requirements](../reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
and [private credential-file procedure](README.md#requirements-and-credentials).

The local launchers remain available, but `run` and `demo` cannot pass the current
owner prerequisite. They may prepare infrastructure before invoking the test;
use the credential-free command under [Current verification boundary](#current-verification-boundary)
to check the blocker without that setup.

On a macOS or Linux workstation with Podman, `podman-compose`, k3d, and Helm,
the repository helper discovers the Podman API socket, prepares the disposable
k3d and PostgreSQL environment, builds and imports the runtime image, and runs
the same real test. On Linux, start the rootless Podman API socket first; a
normal Podman installation does not keep it active by default:

```sh
systemctl --user start podman.socket
```

Use the same Podman user for this command and the launcher. The socket grants
that user full Podman control, so keep it local and do not expose it over TCP.

```sh
# After owner integration, use an authorized private credential environment.
pnpm openshell:podman
```

Docker Engine with Docker Compose uses the same lifecycle without Podman socket
discovery or `DOCKER_HOST` changes:

```sh
# After owner integration, use an authorized private credential environment.
pnpm openshell:docker
```

The Docker commands preserve the caller's active Docker context and
`DOCKER_HOST`. Earlier credentialed Podman runs predate the broker-owned path
and do not establish its current runtime qualification.

The prepared base environment remains available so subsequent invocations can
reuse local images, the cluster, and PostgreSQL. After runtime qualification,
the demo lifecycle uses:

```sh
pnpm openshell:podman:demo # or openshell:docker:demo
pnpm openshell:podman:ui   # or openshell:docker:ui
```

A successful `demo` run must pass the real model, filesystem, network, identity,
and credential-isolation checks before retaining its Agent, gateway, and
OpenShell sandbox before the ordinary test's destructive revision-cutover
case. The `ui` command copies the token-bearing Control UI URL to the macOS
clipboard when `pbcopy` is available, then forwards the gateway only on
`127.0.0.1:18888`; it refuses to start if the retained OpenShell sandbox is no
longer Ready. Keep it running while using the UI. Demo credentials remain in
the helper's private state directory. This retained deployment is for local
inspection, not production operation.

Show the retained namespace's Kubernetes resources and query its OpenShell
gateway for workspace-scoped providers and sandboxes:

```sh
pnpm openshell:podman:inspect # or openshell:docker:inspect
```

`inspect` uses the prepared CLI and a temporary random-port forward that it
closes automatically. It reports provider metadata without printing stored
credential values. Run `pnpm openshell:podman:help` or
`pnpm openshell:docker:help` for the complete command lifecycle.

Remove the retained demo while preserving the prepared k3d cluster, imported
images, and PostgreSQL service for a faster subsequent test:

```sh
pnpm openshell:podman:reset # or openshell:docker:reset
pnpm openshell:podman:demo  # or openshell:docker:demo
```

Run `reset` before another `demo`; retained records cannot be overwritten.
It removes only the exact demo namespace and retains the record if cleanup
fails, allowing retry.

Remove only the helper's owned resources when finished:

```sh
pnpm openshell:podman:down # or openshell:docker:down
```

The helpers keep independent private runner state under
`${XDG_STATE_HOME:-$HOME/.local/state}/openclaw-enterprise/openshell-<engine>`.
Override it with `OCC_OPENSHELL_LOCAL_STATE_DIR`, or use the engine-specific
`OCC_OPENSHELL_PODMAN_STATE_DIR` and `OCC_OPENSHELL_DOCKER_STATE_DIR`. On macOS,
the Podman location must be visible inside Podman Machine; `/tmp` is not a valid
location for its k3d host-file mounts. This remains verification-only
infrastructure rather than a persistent OpenClaw deployment.

The retained runtime assertions cover model execution, workload identity,
mounts, privileges, credential isolation, egress, revision replacement/cleanup,
and embedded-mode rejection. They are currently unreachable behind the owner
prerequisite. The adaptations below also prevent a passing run from establishing
stock OpenShell production compatibility.

### Test-only OpenShell adaptations

The fixture's operator-owned Helm wrapper installs the OpenShell gateway;
the bundled driver does not. This is test orchestration.

The fixture retains the following `v0.0.116` compatibility bridges. They do not
supply credential authority or satisfy the missing runtime owner, and none is
production support. “Primary owner” identifies the first project to change;
an alternative design may move a boundary only through an explicit architecture
decision.

| Primary owner    | Gap                                  | Current test behavior                                                                                                                                                                                                                                                          | Completion condition                                                                                                                                       |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenShell        | Per-Sandbox Kubernetes identity      | With `serviceAccount.mode: gatewayConfigured`, the fixture serially replaces the Namespace gateway, setting `sandboxServiceAccount.name` to the exact Agent ServiceAccount. Concurrent Agents cannot share this test gateway safely.                                           | OpenShell validates and applies the requested per-Sandbox ServiceAccount. Remove gateway replacement and serialized provisioning.                          |
| OpenShell        | Projected volume support             | The client verifies and removes OpenShell's unsupported projected token volume and mount. An operator suspends the Sandbox, patches its Pod template with the exact audience, expiry, path, and read-only mount, then resumes it.                                              | OpenShell preserves the projected volume and mount through its gateway API. Remove the operator Pod-template patch.                                        |
| OpenShell        | Kubernetes Secret-backed environment | An operator Job reads only `APP_SERVER_TOKEN` through its `secretKeyRef`, writes it mode `0400` to a revision-specific PVC subpath, and exits. The Sandbox mounts it read-only; its startup wrapper exports the value before Codex starts, and a cleanup Job deletes the file. | OpenShell accepts the exact `secretKeyRef` environment entry without centralizing its bytes. Remove the Job, PVC token file, startup wrapper, and cleanup. |
| OpenClaw and OCE | Remote workspace transport           | The gateway and remote Codex Harness still share a workspace PVC. The single-node test therefore requires RWX semantics.                                                                                                                                                       | OpenClaw's remote Harness no longer requires a shared filesystem, and OCE adopts that transport. Remove the cross-Pod RWX requirement.                     |

Only projected-token patching and transport-credential delivery require the test's
operator Kubernetes client. For local proof, the single-node k3d fixture uses
`local-path` with `hostPath` at `/var/lib/rancher/k3s/storage`; retain this setup
while the test needs RWX workspace storage.

Sidecar topology and `processBinaryAwareNetworkPolicy=false` preserve the
Harness connection without `SYS_PTRACE` or `DAC_READ_SEARCH`. The intentional
`/sandbox/enterprise` mount uses the OCE workspace and suppresses OpenShell's
separate default PVC. Local launcher mechanics are not upstream gaps.

Production packaging has separate OCE work even after the compatibility bridges
are removed. The fixture currently installs a Namespace gateway with TLS and
gateway authentication disabled, reachable only through scoped cluster policy
and local port-forwarding. Production must install and lifecycle-manage the
gateway with authenticated TLS, configure the SandboxDriver as its trusted
caller, and enforce admission guardrails for the exact approved OpenShell
workload shape. These are deployment requirements, not reasons to weaken the
Sandbox contract.

See the
[production contract](../reference/drivers/openshell-sandbox.md#current-upstream-preconditions)
for the corresponding fail-closed requirements.

Local `sandbox-driver-startup`, `controller-lifecycle`, and
`postgres-platform-state` integration tests cover driver selection, revision
lifecycle, and persistence. They do not exercise these real OpenShell tools.

## OpenShell test environment

[`sandbox-driver-openshell-k3d-real.test.mjs`](../../tests/integration/sandbox-driver-openshell-k3d-real.test.mjs)
is selected by `OCC_TEST_OPENSHELL_K3D_REAL=1` or by setting any Kubernetes,
image, database, or OpenShell-specific prerequisite. If any of those variables
is present while the flag is not `1`, prerequisite validation still fails; use a
scoped environment file for this suite.

| Variable                              | Requirement or default                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_TEST_OPENSHELL_K3D_REAL`         | Set to `1` to explicitly opt into the real OpenShell integration.                                                                                   |
| `OPENAI_API_KEY`                      | Reserved live-test credential input; the current owner prerequisite fails before it is read.                                                        |
| `OCC_TEST_OPENAI_MODEL`               | Authorized provider model; defaults to `gpt-5.6-sol`.                                                                                               |
| `OCC_TEST_KUBERNETES_KUBECONFIG`      | Absolute kubeconfig path for the dedicated disposable k3d cluster.                                                                                  |
| `OCC_TEST_KUBERNETES_CONTEXT`         | Explicit `k3d-*` context with a verified loopback HTTPS API.                                                                                        |
| `OCC_TEST_KUBERNETES_GATEWAY_IMAGE`   | Imported immutable real OpenClaw gateway image; `OCC_TEST_KUBERNETES_RUNTIME_IMAGE` is accepted as a fallback.                                      |
| `OCC_TEST_KUBERNETES_AGENT_IMAGE`     | Imported immutable real Codex image; `OCC_TEST_KUBERNETES_CODEX_IMAGE` and runtime image fallbacks are accepted.                                    |
| `OCC_TEST_DATABASE_URL`               | Migrated disposable loopback PostgreSQL database named `openclaw_k8s_*`.                                                                            |
| `OCC_TEST_OPENSHELL_CLI`              | Official OpenShell CLI binary.                                                                                                                      |
| `OCC_TEST_OPENSHELL_HELM`             | Helm binary used to install the namespace-scoped OpenShell gateway.                                                                                 |
| `OCC_TEST_OPENSHELL_HELM_CHART`       | OpenShell Helm chart path or chart archive.                                                                                                         |
| `OCC_TEST_OPENSHELL_GATEWAY_IMAGE`    | Imported immutable OpenShell gateway image pinned by SHA-256 digest.                                                                                |
| `OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE` | Imported immutable OpenShell supervisor image pinned by SHA-256 digest.                                                                             |
| `OCC_TEST_OPENSHELL_CHART_VERSION`    | Optional OpenShell chart version; defaults to `0.0.116`.                                                                                            |
| `OCC_TEST_OPENSHELL_RUNTIME_CLASS`    | Existing RuntimeClass used by Agent Sandbox Pods; CI creates the selected RuntimeClass, defaulting to `openshell-sandbox`, with the `runc` handler. |

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
