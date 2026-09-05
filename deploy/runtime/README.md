# Runtime image recipe

Build a local runtime image from an explicitly selected set of OpenClaw package
artifacts. The image contains both supported runtime entrypoints:

- OpenClaw gateway: `node /app/openclaw.mjs`.
- Dedicated Codex app-server: `codex app-server`.

The preparation step requires all five local packages: `openclaw`,
`@openclaw/ai`, `@openclaw/codex`, `@openclaw/slack`, and `@openclaw/msteams`.
Their archive hashes and recorded source identity determine the SDK payload.
Package versions alone do not identify those bytes. Preparation preserves the
original archives and records the metadata and file-mode changes needed for
installation; it does not rebuild the SDK.

The image retains the pinned Node base
`node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`,
requires Node 24.15 or later, and installs native Codex **0.153.0**. The Codex
plugin and native CLI are separate packages with separate identities.

## Prepare and build locally

Supply an immutable input manifest containing the five archive paths, exact
package identities and SHA-256 hashes, their source/artifact provenance, and the
frozen dependency policy and packaging-tool inputs. Keep the selected pnpm lock,
workspace policy and helper/toolchain identities with that input set. The
preparation receipt binds the resulting local artifacts and
complete production dependency lock to these inputs. No local SDK package may
resolve to a registry substitute or a source-worktree dependency link.

The input JSON has this contract:

| Field                                 | Required value                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                              | `oce.runtime-package-inputs/v1`                                                                                                                                        |
| `platform`                            | `linux/amd64`                                                                                                                                                          |
| `nativeCodexVersion`                  | `0.153.0`                                                                                                                                                              |
| `tooling`                             | `{ "path": "<absolute bundle path>", "sha256": "<64 lowercase hex digits>" }` identifying the frozen packaging-tool bundle.                                            |
| `policy.lockfile`, `policy.workspace` | The same path/hash records for the frozen `pnpm-lock.yaml` and `pnpm-workspace.yaml`.                                                                                  |
| `packages`                            | Exactly five entries, one for each local package listed above, with `name`, `version`, absolute archive `path`, archive `sha256`, and an `inventory` path/hash record. |
| `provenance`                          | An object recording the selected source and artifact identities and their acceptance status.                                                                           |

Each inventory is a JSON array of package-relative `path`, byte count `bytes`,
and content `sha256` records for the original archive. The tooling bundle
contains the frozen upstream packaging-policy helpers and their required tar/YAML
tooling. Select that bundle and all five archive/inventory pairs from the same
recorded input handoff. The preparer rejects an applicable frozen dependency
patch until that patch has an explicitly supported preparation path.

Configure the host's existing npm registry and proxy/CA settings through your
normal host setup before preparation. Preparation honors that registry and
transport configuration and may fetch locked registry dependencies into its
task-owned cache. It does not select a different registry or copy host npm
configuration files or provider/channel credentials into the build context.
The configured registry must use HTTPS without credentials embedded in its URL.

Use host Node.js 24+ from the repository root. Select a new absolute output
directory that you own; existing prepared inputs remain available for comparison:

```bash
export OCC_RUNTIME_BUILD_CONTEXT="$PWD/.artifacts/runtime/candidate-01"

node deploy/runtime/prepare-local-packages.mjs \
  --inputs /absolute/path/runtime-inputs.json \
  --output "$OCC_RUNTIME_BUILD_CONTEXT"

node deploy/runtime/prepare-local-packages.mjs \
  --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"

docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart \
  "$OCC_RUNTIME_BUILD_CONTEXT"
```

The prepared directory contains `package.json`, `package-lock.json`, the local
`artifacts/*.tgz` files, and `preparation.json` with their exact hashes. The
receipt also records the selected HTTPS registry base in `registry`; the
verifier permits registry dependency resolutions only under that recorded base,
alongside the five bound local artifacts. It rejects missing or changed input
files before a build. Keep this directory and its receipt together; editing a
prepared file requires a new preparation rather than changing its recorded hash.

Preparation populates a task-owned npm cache with installation scripts disabled
and writes the discovered lifecycle scripts and frozen build-policy decisions to
`lifecycle.json`. Required approved lifecycle actions are selected separately in
the image recipe; the preparation receipt records no lifecycle execution.
The Docker image stage uses generated empty user/global npm configuration files
and installs from the prepared cache with `npm ci --offline --ignore-scripts`.
That offline image configuration is separate from the host registry
configuration used during networked preparation. Gateway startup loads the
packaged dependencies from the image. Keep provider and channel credentials out
of the input manifest, build context and image.

Set `OCC_DOCKER_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart` when
selecting the built image explicitly for Compose. The Docker Compute Driver uses
the same image for embedded OpenClaw gateways and dedicated Codex app-server
containers.

## Quickstart image selection and rebuilding

When Compose leaves the runtime images unselected, `scripts/dev-up` reuses the
local `openclaw-enterprise-runtime:quickstart` tag. If that tag is missing, the
helper requires `OCC_RUNTIME_BUILD_CONTEXT`, verifies it using the checked-in
preparer, and builds from that directory before starting the stack:

```bash
OCC_RUNTIME_BUILD_CONTEXT="$OCC_RUNTIME_BUILD_CONTEXT" ./scripts/dev-up
```

A missing, relative or invalid context stops the automatic build and startup
with an actionable error. The variable is only needed for this missing-default
image path; reusing an existing default image or selecting custom images does
not read or require a build context. This host-side variable is not a runtime
credential or a controller/worker setting.

After changing the recipe or artifact inputs, prepare a new context and run the
explicit build command above, verify that image, then run `./scripts/dev-up`.
For a custom `OCC_DOCKER_RUNTIME_IMAGE`, or separate gateway/Agent image
overrides, build or pull the selected images yourself. The helper preserves that
selection and reports an unavailable custom image instead of building it.

## Installed layout

The image preserves the installed `openclaw` package under
`/app/node_modules/openclaw` and exposes `/app/openclaw.mjs` and `/app/dist` as
symlinks into that package. `/app/skills` is a real directory so the Kubernetes
gateway entrypoint can publish it into the shared runtime-assets volume for
dedicated Codex Pods. Do not flatten `/app/dist`; OpenClaw resolves package-local
runtime dependencies from its installed package root.

Codex, Slack and Teams are available under `/app/dist/extensions/` with their
runtime dependency resolution preserved. Their package entry files are
`index.js`, `index.js`, and Teams `index.cjs`, respectively, at each plugin's
package root. They must load from a fresh runtime home without downloading or
installing packages at gateway startup. Slack's packaged skills are retained for
runtime asset publication.

## Verify the local image

```bash
docker run --rm openclaw-enterprise-runtime:quickstart \
  node /app/openclaw.mjs --version

docker run --rm openclaw-enterprise-runtime:quickstart \
  codex --version

OCC_TEST_RUNTIME_IMAGE=openclaw-enterprise-runtime:quickstart \
  node --test tests/integration/runtime-image-startup.test.mjs
```

The smoke starts task-owned containers with the Docker Compute Driver gateway
entrypoint and the Kubernetes Compute Driver gateway entrypoint, UID
`1000:1000`, a read-only root filesystem, and tmpfs-backed runtime directories.
It checks gateway readiness from a fresh home, installed SDK/plugin imports,
Codex/Slack/Teams discovery and loading, the installed Codex client's real
app-server initialization and version guard, runtime logging, and skill
publication into `/home/node/openclaw-runtime-assets`. These checks run without
external network access or provider credentials, with channel connections
disabled.

Retain the prepared-context receipt, actual installed package and native
executable identities, platform, image ID and test results together. A successful
local build and offline startup do not establish model turns, live Slack/Teams
delivery, production identity or gVisor qualification. Inputs marked provisional
remain provisional until their source/artifact acceptance is recorded.

Local image verification does not require a registry push. A Docker image ID is
different from a registry manifest digest. Production installations separately
publish an approved image to an operator-controlled registry and use its actual
immutable `@sha256:` reference; see
[Build and publish production images](../../docs/guides/deploy.md#build-and-publish-production-images).
Separate gateway and Codex images require verification of that exact pair through
the [Kubernetes runtime tests](../../docs/testing.md#kubernetes-model-turns-and-secrets).

Before enabling Slack in an Installation, run the
[live Slack test](../../docs/testing.md#slack) with the verified image, projected
credentials, and required proxy configuration. It must prove a real mention,
Codex turn, and gateway-authored reply; gateway readiness alone is insufficient.
