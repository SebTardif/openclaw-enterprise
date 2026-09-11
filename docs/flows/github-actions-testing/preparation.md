# CI resource preparation

Prepare the resources for the already-selected source revision and test lane. See the [parent flow](../github-actions-testing.md) for its context and overall sequence.

## Execution trace

### 2. Prepare resources under the job owner

`scripts/ci/prepare.mjs:prepareFile`

The preparation CLI records run-owned resources in a private state file before creating them. GitHub Actions passes that file under `RUNNER_TEMP`; it is available to later steps in the same job and is not uploaded as an artifact. Database tests receive a fresh migrated database per file and use the limited application role. Failure and Kubernetes database names satisfy the existing test admission guards. A cluster lane selects an explicit loopback k3d context. External images are pulled by their approved registry digest and exported for the selected platform; built and external images receive a run-owned reference at the imported platform manifest digest. Preparation records the original source image and checks Kubernetes CRI resolution before passing the immutable runtime reference to tests. Preparation failures still enter job cleanup.

For a runtime-build lane, preparation first validates the absolute
`OCC_RUNTIME_BUILD_CONTEXT` with the local package-context verifier. A missing or
invalid receipt fails before lane resources or image builds. The [CI input contract](../../testing/ci.md#runtime-image-preparation-input)
identifies always-build lanes and the applicable immutable external-image alternative.

For `images-packaging` and `production-tui`, `controllerBuildInputs()` also
validates the digest-pinned Go builder, canonical frozen SDK directory and reviewed
hash against the actual regular `layout.json` before lane resources are created.
The controller Docker build receives `GO_BASE_IMAGE`, a stable `GO_BUILD_CACHE_SCOPE`
derived from the canonical checkout path, the named `oce-upstream-inputs` context,
and `OCE_UPSTREAM_SDK_MANIFEST_SHA256`. The image's SDK preparation stage verifies
the complete selected inventory; host preflight creates no replacement inputs.
See [controller image preparation inputs](../../testing/ci.md#controller-image-preparation-inputs).

The runtime image recipe consumes five prepared local package archives and pins native Codex to `0.153.0`; the reviewed context preserves exact source and dependency inputs. Image startup smoke verifies fresh-home plugin loading, actual app-server initialization, and nested Codex home ownership for generated images and credential files before credentialed tests. Routing additionally requires the Gateway identity-scope contract; embedded continuity requires outgoing media to remain visible through history and artifact APIs across Pod replacement. A successful image build alone establishes none of those live outcomes.

Dedicated Codex preparation cannot substitute a mutable node syscall-profile
selection for immutable workload-profile admission. The `runtime.codexSeccompProfile`
override is unsupported. The live fixture requires the original qualified profile,
complete admission suppliers and exact saved Agent inputs before model execution;
see [current Kubernetes runtime prerequisites](../../testing/kubernetes.md#kubernetes-model-turns-and-secrets).
Node compatibility probes, image startup and restricted fixture Pods establish only
their observed setup facts. OpenShell retains its own provider-created Harness and
qualification boundary.

The suite map owns fixed selection flags, required input names, and the resources each lane needs. Preparation consumes those descriptors instead of maintaining parallel lane lists. External model, ChatGPT and Slack credentials come only from the selected protected environment. Missing selected inputs fail rather than turning the lane into a skipped success.

Current setup contract: routing preparation installs pinned Gateway API, cert-manager v1.18.4, and Envoy Gateway v1.6.7 controllers and creates a private test CA. Routing uses separate image identities for separate owners: Kubernetes Pods receive the prepared k3d-imported runtime digest reference, while the host TCP publisher receives `OCC_TEST_KUBERNETES_GATEWAY_DOCKER_IMAGE`, the Docker-local immutable image ID for the prepared gateway source image. OpenShell preparation uses the digest-pinned K3s v1.36.4 image with its `runc` handler, installs a matched kubectl, verifies the selected RuntimeClass with a smoke Pod, installs Agent Sandbox resources, acquires the OpenShell CLI/chart, and imports gateway and supervisor images. The RuntimeClass smoke proves runtime availability; the full OpenShell lane must prove the supervisor enforces approved filesystem access, process privileges, and endpoint/L7 network policy. The existing sidecar configuration keeps binary-aware policy disabled and grants neither `SYS_PTRACE` nor `DAC_READ_SEARCH`. Before creating the OpenShell cluster, preparation writes a private admission config under the owned cluster directory and mounts that exact file read-only into its server. Only the selected RuntimeClass is exempt; namespace and username exemptions remain empty. The API server must reject a violating ordinary Pod in a restricted namespace and admit the same Pod with the selected class before the RuntimeClass availability smoke runs. Logging preparation starts an owned OpenTelemetry Collector backend and passes JSONL evidence to selected tests. The Collector and Docker-model jobs use the shared [setup-test-docker action](../../../.github/actions/setup-test-docker/action.yml) to pin Docker 29.4.0, which supports the production `fluentd-write-timeout` logging option. The action stops the preinstalled daemon on the ephemeral runner, installs Docker 29.4.0 through the SHA-pinned official Docker setup action, and points `/var/run/docker.sock` at the action socket so the CLI, production Compose, and Driver use one daemon. Other jobs keep the runner Docker daemon. Full-suite acceptance remains incomplete until main-only protected hosted execution records every selected lane. The [delivery status](../../../specs/19-github-actions-test-coverage/delivery-status.md#delivery-status) owns current proof boundaries and live gaps.

The OpenShell test owns its management port-forwards for the full test lifetime. Teardown stops the worker before draining those forwards, then attempts the remaining app, database, namespace, and directory cleanup even if an earlier step fails. Forward shutdown waits for child exit and uses a bounded kill fallback; cleanup errors fail the test.

## Related

- [Return to the parent flow](../github-actions-testing.md).
