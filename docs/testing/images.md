# Image and Helm tests

Check packaged controller and runtime images and render the production Helm
chart. These checks use local images and do not require model credentials.

## Images and Helm

Prepare the five-package context using the [runtime image recipe](../../deploy/runtime/README.md)
and set `OCC_RUNTIME_BUILD_CONTEXT` to its absolute task-owned directory. It uses
already built core, AI, Slack, Microsoft Teams, and Codex plugin artifacts plus
frozen dependency policy; it does not rebuild the SDK. Verify that context,
build the image, then run its startup smoke against the resulting local image ID:

```sh
node deploy/runtime/prepare-local-packages.mjs --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:test "$OCC_RUNTIME_BUILD_CONTEXT"
OCC_TEST_RUNTIME_IMAGE="$(docker image inspect --format '{{.Id}}' openclaw-enterprise-runtime:test)" \
  node --test tests/integration/runtime-image-startup.test.mjs
```

This checks gateway readiness and bundled Codex, Slack, and Microsoft Teams plugin loading from a
fresh runtime home, then initializes the image's real Codex app-server through
the installed plugin's version guard. The smoke runs offline without provider
or channel credentials. Native Codex CLI is pinned to `0.153.0`. This does not
make a model call, establish authenticated WebSocket operation, or prove live
Slack/Teams delivery, Kubernetes behavior, or gVisor qualification; run the
[live Slack test](slack.md#slack) for Slack delivery proof. Source-artifact acceptance
remains a separate gate: successful local packaging and offline smoke do not
qualify provisional artifacts for shared integration or deployment.

The local Docker image ID binds this smoke to the built image without a registry
push. It is not a registry manifest digest and must not be substituted into a
Kubernetes `repository@sha256:...` reference.

Build the controller image using the [production prerequisites](../guides/deploy.md#production-prerequisites),
then set `OCC_TEST_PRODUCTION_IMAGE` to the local tag you built:

```sh
OCC_TEST_PRODUCTION_IMAGE=openclaw-enterprise:reviewed \
  node --test tests/integration/production-image-startup.test.mjs
```

The controller smoke intentionally uses an unreachable database with networking
disabled. It verifies module loading and packaged OpenShell protocol assets;
the expected database error is the boundary being tested.

With Helm and a `yq` executable supporting `eval-all -o=json` installed:

```sh
node --test tests/integration/production-kubernetes-packaging.test.mjs
```

This renders the chart and verifies private Services, dedicated workload
identities, tenant-scoped RoleBindings, mounted Secrets, restrictive networking,
bootstrap ordering, and rejection of unsafe image or policy inputs. It does not
install the chart or exercise live admission and NetworkPolicy enforcement.
Missing Helm or `yq` skips this suite; unset image selectors skip the image smokes.

## Production image startup test environment

[`production-image-startup.test.mjs`](../../tests/integration/production-image-startup.test.mjs)
verifies a locally built production controller image before Helm installation.
The image build requires an approved digest-pinned Go 1.26+ `GO_BASE_IMAGE`;
see [native build inputs](runtime-security.md#native-build-inputs).
It runs the image with no network, deliberately points it at an unreachable
database, checks that startup reaches that expected database boundary without
missing bundled production modules, and verifies that the OpenShell gRPC proto
asset, native executable, and third-party license/version records are present.

| Variable                    | Requirement or default                                      |
| --------------------------- | ----------------------------------------------------------- |
| `OCC_TEST_PRODUCTION_IMAGE` | Locally built production controller image tag; unset skips. |
| `OCC_DOCKER_BIN`            | Optional Docker executable path; defaults to `docker`.      |

This check does not prove PostgreSQL connectivity, Helm rendering, Kubernetes
reconciliation, runtime image execution, or a model turn.

## Runtime image startup test environment

[`runtime-image-startup.test.mjs`](../../tests/integration/runtime-image-startup.test.mjs)
verifies a locally built OpenClaw runtime image before Docker Compose or
Kubernetes execution. It starts task-owned containers with the Docker Compute
Driver gateway entrypoint, UID `1000:1000`, a read-only root filesystem, and
tmpfs-backed `/home/node` and `/tmp`. Host Node.js 24+ is required to run the
test.

| Variable                 | Requirement or default                                 |
| ------------------------ | ------------------------------------------------------ |
| `OCC_TEST_RUNTIME_IMAGE` | Locally built runtime image ID or tag; unset skips.    |
| `OCC_DOCKER_BIN`         | Optional Docker executable path; defaults to `docker`. |

This check proves an embedded OpenClaw gateway reaches `/readyz` from a fresh
runtime home and the bundled Codex, Slack, and Microsoft Teams plugins load without missing
package dependencies; the actual Codex app-server must initialize through its
installed plugin version guard. It does not prove Docker Compose orchestration,
Kubernetes reconciliation, model credentials, or a model turn.

## Helm packaging test environment

The checked-in production packaging integration renders the real Helm chart
and inspects it with an existing `yq` executable. `OCC_HELM_BIN` optionally
selects an existing Helm executable; otherwise the test resolves `helm` from
`PATH`. Missing Helm or `yq` skips this packaging check. Rendering does not
install the chart, reconcile a cluster, or establish a real model turn.

To select a Helm executable outside `PATH`:

```bash
OCC_HELM_BIN=/absolute/path/to/helm \
  node --test tests/integration/production-kubernetes-packaging.test.mjs
```

## Related

- [Choose another test suite](README.md).
- [Results, cleanup, and troubleshooting](README.md#results-cleanup-and-troubleshooting).
