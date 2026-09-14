# OpenShell tests

Verify provider-owned Codex execution and OpenShell filesystem and network
enforcement. Prepare [credentials](README.md#requirements-and-credentials)
and use the suite-specific infrastructure below.

## OpenShell Sandbox

This suite needs the owned OpenShell CI recipe: a disposable K3s v1.36.4 k3d
cluster, matched kubectl, the selected RuntimeClass bound to the cluster's
`runc` handler, a successful RuntimeClass smoke Pod, Agent Sandbox
CRDs/controller, OpenShell CLI/Helm/chart files, imported immutable OpenShell
gateway and supervisor images, real gateway/Codex images, the Kubernetes test
database, `openssl`, and `OPENAI_API_KEY`. The standard k3d recipe alone is
insufficient because it does not install the CI-owned admission config,
RuntimeClass, Agent Sandbox, or OpenShell assets.

For CI-shaped setup, let `prepare.mjs` create the pinned K3s cluster, install
OpenShell prerequisites, and export the lane environment before
`run-tests.mjs` invokes the case:

```sh
node scripts/ci/prepare.mjs \
  --lane openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --github-env "$GITHUB_ENV"
node scripts/ci/run-tests.mjs run openshell \
  --state "$RUNNER_TEMP/state/openshell.json" \
  --results "$RUNNER_TEMP/results/openshell.json"
```

For manual setup, prepare these inputs using the
[OpenShell test settings](#openshell-test-environment) and
[OpenShell requirements](../reference/drivers/openshell-sandbox.md#kubernetes-and-admission-requirements),
then run the exact file:

```sh
OCC_TEST_OPENSHELL_K3D_REAL=1 \
  node --env-file="$TEST_ENV_FILE" --test tests/integration/sandbox-driver-openshell-k3d-real.test.mjs
```

On a macOS or Linux workstation with Podman, `podman-compose`, k3d, and Helm,
the repository helper discovers the Podman API socket, prepares the disposable
k3d and PostgreSQL environment, builds and imports the runtime image, and runs
the same real test:

```sh
export OPENAI_API_KEY='<existing authorized credential>'
export OCC_TEST_OPENAI_MODEL=gpt-5.1
pnpm openshell:podman
```

Docker Engine with Docker Compose uses the same lifecycle without Podman socket
discovery or `DOCKER_HOST` changes:

```sh
export OPENAI_API_KEY='<existing authorized credential>'
export OCC_TEST_OPENAI_MODEL=gpt-5.1
pnpm openshell:docker
```

The Docker commands preserve the caller's active Docker context and
`DOCKER_HOST`. Their orchestration path is covered locally; the credentialed
end-to-end proof documented here was run with Podman.

Both launchers print phase markers before slow preparation, image, cluster, and
integration-test work. First-time preparation can take several minutes; later
runs report when they are reusing the prepared environment.

The prepared base environment remains available so subsequent invocations can
reuse the local images, cluster, and PostgreSQL service. Remove only its owned
resources when finished:

```sh
pnpm openshell:podman:demo # or openshell:docker:demo
pnpm openshell:podman:ui   # or openshell:docker:ui
```

The `demo` command runs the real model, filesystem, network, identity, and
credential-isolation checks, then retains its successful Agent, gateway, and
OpenShell sandbox before the ordinary test's destructive revision-cutover
case. The `ui` command copies the token-bearing Control UI URL to the macOS
clipboard when `pbcopy` is available, then forwards the gateway only on
`127.0.0.1:18888`; it refuses to start if the retained OpenShell sandbox is no
longer Ready. Keep it running while using the UI. Demo credentials remain in
the helper's private state directory. This retained deployment is for local
inspection, not production operation.

Run `reset` before starting another `demo`. The helper refuses to replace an
existing retained demo record, preserving access to its running resources.

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

`reset` is idempotent. It removes only the exact retained demo namespace; it
does not delete the cluster or its containerd image store. If namespace cleanup
fails, the helper keeps the demo record so you can retry `reset`.

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

The test checks a real gateway model turn, provider-owned dedicated Codex
execution, exact projected workload identity, approved mounts and privileges,
denied secret exposure, allowed and denied tool egress, duplicate
reconciliation, replacement/cleanup with an absent Pod, and rejection of
embedded placement. It uses the test-only adaptations below, so a passing run
does not establish stock OpenShell production compatibility. Missing
prerequisites after selection fail rather than skip.

### Test-only OpenShell adaptations

The integration uses an operator-owned Helm wrapper to install the OpenShell
gateway before delegating to the driver. The bundled driver does not install
that gateway. Installation by the fixture is test orchestration, not an
OpenShell security compatibility bridge.

The following bridges make the current `v0.0.116` integration verifiable. None
is production support. “Primary owner” identifies the first project to change;
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

Sidecar topology and `processBinaryAwareNetworkPolicy=false` are intentional:
they retain the dedicated Harness connection while avoiding `SYS_PTRACE` and
`DAC_READ_SEARCH` in the restricted workload. The `/sandbox/enterprise` mount
maps the approved OCE workspace claim into OpenShell's workspace namespace and
suppresses its separate default workspace PVC; it is intentional storage
integration. Podman socket selection, direct k3d image import, command chunking,
and the helper's `reset` and `inspect` commands are local development mechanics
rather than upstream gaps.

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
| `OPENAI_API_KEY`                      | Existing authorized provider credential for the required real model turn.                                                                           |
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

The selected cluster must already expose the Agent Sandbox CRD and a ready Agent
Sandbox controller. See the
[OpenShell SandboxDriver testing guide](#openshell-sandbox) for
the required cluster, image, database, RuntimeClass, and chart setup.

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
