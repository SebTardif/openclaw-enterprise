# Build graph

The build entrypoint coordinates the existing TypeScript projects, the selected
Rust dataplane, and explicit container-image targets. It uses the checked-in
language manifests and their lockfiles. It does not install dependencies or
select a different source tree when an input is missing.

Inspect the dependencies without running tools or requiring build inputs:

```sh
node scripts/build-mvp.mjs --plan build
node scripts/build-mvp.mjs --plan images
node scripts/build-mvp.mjs --help
```

This is a local build graph. It has no remote execution or shared action cache,
and does not establish hermetic or byte-for-byte reproducible builds. Cargo and
TypeScript retain their own incremental compilation behavior. Image construction
also depends on the selected base images and the existing Dockerfile recipes.

## Source builds

Prepare the pinned package dependencies and Rust toolchain separately before
building. Preserve existing root and nested `node_modules` directories. The
ordinary build does not run pnpm installation, Cargo fetching, toolchain
installation, container builds, database operations, or live integrations.

```sh
pnpm build:mvp
pnpm build:dataplane
node scripts/build-mvp.mjs check-types
```

| Target         | Prerequisites and outputs                                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check-types`  | Node.js 24, the installed TypeScript version from root `package.json`, and the current pnpm dependency graph. Runs workspace isolation and the six TypeScript project references; verifies declaration outputs. |
| `check-native` | Checks the exact Rust version in `dataplane/rust-toolchain.toml`, Cargo metadata, and the selected workspace members and their local path dependencies.                                                         |
| `native-dns`   | `check-native`, then a release build of the `oce-dnsgate` OCE adapter in package `ds-dnsgate`. Copies the verified executable to `.build/mvp/native/oce-dnsgate`.                                               |
| `native-tls`   | `check-native`, then a release build of the `oce-egress` OCE adapter in package `ds-tlsproxy`. Copies the verified executable to `.build/mvp/native/oce-egress`.                                                |
| `native`       | Both native product binaries. Each shared prerequisite runs once per invocation.                                                                                                                                |
| `build`        | `check-types` and `native`. This is the `pnpm build:mvp` target.                                                                                                                                                |

The original `pnpm build` and `pnpm typecheck` commands continue to check the
TypeScript workspace. Its projects are `utils`, `contracts`, `occ`, `iam`,
`audit`, and `controller`. Their generated `dist` outputs are checked build
artifacts. The controller image continues to package and execute the existing
TypeScript source and `.mjs` entrypoints.

Native builds require a Linux amd64 or arm64 host and its native C compiler and
build tools for the selected native library dependencies, including `ring`.
They explicitly select the host GNU Rust target. Cross-compilation is outside
this command's supported boundary.
Cargo receives `--locked --offline`; `RUSTUP_AUTO_INSTALL=0` prevents a missing
toolchain from being downloaded. The command resolves Cargo and rustc from the
selected installed rustup toolchain, explicitly selects that compiler, and
disables compiler wrappers. Compiler artifacts remain
under `dataplane/target/<target>/release`. The command selects each product binary
by name, so benchmark and auxiliary binaries are not build outputs.
The stock DNS/TLS service entrypoints are not selected or used as a fallback
when an OCE adapter is missing.

The selected Cargo members are `ds-contracts`, `policy-core`,
`ds-policy-snapshot`, `ds-telemetry`, `ds-admission-shm`, `ds-nft`, `ds-dnsgate`,
and `ds-tlsproxy`. The final two live under `dataplane/services`; the others live
under `dataplane/crates`. Missing manifests, unavailable cached dependencies,
different workspace members, external entrypoints, and resolved local path
dependencies or Cargo patches outside this selection fail
the build. There is no fallback to an external checkout or prebuilt executable.

Cargo's offline setting governs Cargo dependency access; it is not an operating
system network sandbox for compiler processes or dependency build scripts.
The egress image base must support the resulting GNU Linux executable's system
library requirements; compilation alone does not verify that runtime ABI.

A successful native build writes `.build/mvp/native-manifest.json` with the Rust
toolchain, target, image platform, host glibc version, and SHA-256 of each product
binary built in that invocation. A new native build removes the previous
manifest before starting and writes its replacement only after success. The
host glibc field records build provenance; it is not a measurement of the
binary's minimum supported glibc. Execute the real product inside the selected
image to verify runtime library compatibility before deployment.

### Local upstream SDK declarations

The contracts package uses the normal dependency
`openclaw: link:../../.build/upstream-sdk/openclaw`. Its checked-in package
manifest and pnpm lockfile must contain that dependency, and the workspace
dependency graph must be prepared separately. The
[SDK layout helper](../../scripts/prepare-upstream-sdk.mjs) creates the ignored
link target for one worktree without editing package metadata or installing
dependencies.

Obtain the private layout manifest supplied with the accepted artifacts and its expected SHA-256.
From the canonical worktree root, create `.build` as a real directory, then
prepare a destination that does not yet exist:

```sh
mkdir -p .build
node scripts/prepare-upstream-sdk.mjs \
  --manifest /absolute/path/private-layout.json \
  --sha256 '<manifest-sha256>' \
  --output "$PWD/.build/upstream-sdk"
```

The manifest uses schema `oce.upstream-sdk-layout/v1`. Its `packages` array names
exactly three physical packages, placed automatically at these destinations:
`openclaw` at `openclaw`, `@openclaw/ai` at
`openclaw/node_modules/@openclaw/ai`, and `@types/ws` at `node_modules/@types/ws`.
Each entry has `name`, `version`, canonical absolute `source`, and `files` records
with relative `path`, `bytes`, `sha256`, and an integer `mode` matching the source.
The inventory must cover every payload file, excluding the package's top-level
`node_modules`; dependencies are handled separately. Root and AI versions must
agree, and the root must expose the real `plugin-sdk/channel-inbound` type entry.

Root and AI entries also require `archive: { path, sha256 }`. Their physical file
inventories must already be accepted against those archives: the helper checks
archive hashes but does not extract archives or establish that correspondence.
The `links` array records output-relative `path`, canonical absolute `target`,
`name`, `version`, and `manifestSha256` for each local third-party dependency.
Manifest and source paths must resolve without symlinks. Keep this machine-specific
manifest outside tracked source; tracked code and documentation contain no
selected private source paths.

The helper verifies these inputs, copies all three packages' complete inventoried
files unchanged, and writes `preparation.json` only after preparing the layout.
It does not import SDK code, execute lifecycle scripts, fetch packages or install
them. Third-party links retain their existing local targets; only those targets'
package-manifest identities are checked, not their complete contents. The layout
supports local declaration consumers, but preparation alone does not establish a
portable installation, complete declaration or runtime dependency closure, or
resolution of the separate `fs-safe` runtime-image dependency gap.

The output parent must already exist at its canonical path. An occupied output
is rejected and preserved. Use a new validation worktree when a fresh layout is
needed; the helper does not overwrite an existing layout. A failure after output
creation can leave a partial directory without `preparation.json`; preserve it
for diagnosis and select a fresh workspace for another attempt. Prepare the
ignored layout separately in each worktree before compiling its SDK consumers.

## Image builds

Image construction is explicitly selected and may use the network. The egress
package preparation step downloads the locked Debian dependency inputs outside
Docker; its image build uses `--network=none`. The existing controller Dockerfile
installs production dependencies during its separately selected image build.
It is not part of `pnpm build:mvp` or `pnpm build:dataplane`.

### Controller Go compiler cache

The controller image target supplies `GO_BUILD_CACHE_SCOPE` to the root Dockerfile.
Its value is a SHA-256 of the canonical worktree directory: aliases of the same
directory share a namespace, and separate worktrees use separate namespaces.
The host path itself is not included in the build argument. Moving a worktree
changes its namespace. This partition controls cache reuse; it is not an access
control boundary against other clients of the same Docker builder.

The two native Go build commands mount the same compiler cache, scoped by that
namespace, the selected `GO_BASE_IMAGE` reference and `TARGETPLATFORM`.
`sharing=locked` serializes writers to that cache. The existing module-download
layer, readonly module checks, compiler flags, executable outputs and license
collection remain in place. Go validates compiler cache entries against its own
source, dependency and build-option identities. BuildKit may evict entries;
cache availability changes compilation work, not the required outputs.

Direct Docker and Compose callers that omit `GO_BUILD_CACHE_SCOPE` retain their
ordinary Go cache behavior. To opt in for a direct Docker invocation, obtain the
current worktree's scope with:

```sh
node --input-type=module -e 'import { goBuildCacheScope } from "./scripts/build-mvp.mjs"; console.log(goBuildCacheScope())'
```

Pass that value as `--build-arg GO_BUILD_CACHE_SCOPE=<scope>` alongside the
existing pinned base arguments. Use a distinct scope for each worktree on a
shared builder. The cache mount stays in BuildKit storage and is not copied
into the controller runtime image. Source-level checks do not establish cache
hits or a speedup; compare actual builds on matched inputs and verify their
resulting executable artifacts.

### Prepared runtime image

The image graph takes a separately prepared OpenClaw/Codex runtime image. It
checks that its exact digest reference is present in the local Docker engine
and matches the Linux host architecture. It does not rebuild, pull, or substitute
that runtime. Follow the [runtime image recipe](../../deploy/runtime/README.md)
to prepare it from five local package artifacts: OpenClaw core, `@openclaw/ai`,
Slack, Microsoft Teams, and the Codex plugin, with native Codex CLI `0.153.0`.
The separate preparation command consumes immutable input records and frozen
dependency policy without rebuilding the upstream SDK. It produces a task-owned
Docker context containing `package.json`, `package-lock.json`, `artifacts/*.tgz`,
and `preparation.json`; verify it with
`node deploy/runtime/prepare-local-packages.mjs --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"`
before selecting it as the context for `deploy/runtime/Dockerfile`.

`OCC_RUNTIME_BUILD_CONTEXT` is an absolute prepared-directory path used by
`scripts/dev-up` only when its default quickstart runtime image is absent. It
does not replace `OCC_BUILD_RUNTIME_IMAGE`, which selects an already built
image for this graph. Local preparation and image smoke evidence do not establish
final source-artifact acceptance, channel delivery, or deployment qualification.
Provisional source artifacts retain that status until their acceptance gates pass.

Set all six inputs explicitly:

| Environment variable          | Input                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_BUILD_NODE_BASE_IMAGE`   | Approved Node.js 24 image reference ending in `@sha256:<64 lowercase hexadecimal digits>`.                                          |
| `OCC_BUILD_GO_BASE_IMAGE`     | Approved Go 1.26 build image with the same digest-reference form, required by the controller's native runtime-security build stage. |
| `OCC_BUILD_EGRESS_BASE_IMAGE` | Approved Linux egress base with the same digest-reference form; the selected nft backend requires its runtime networking tools.     |
| `OCC_BUILD_RUNTIME_IMAGE`     | Separately prepared, locally available OpenClaw/Codex runtime digest reference.                                                     |
| `OCC_BUILD_CONTROLLER_TAG`    | Explicit output tag for the controller image, other than `latest`.                                                                  |
| `OCC_BUILD_EGRESS_TAG`        | Explicit output tag for the egress image, other than `latest`.                                                                      |

Controller and egress output tags must be distinct. Image input validation runs
before compilation prerequisites so invalid selections fail without starting a
build.

```sh
pnpm build:images
```

| Target             | Prerequisites and image recipe                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-image`    | Verify the selected local runtime digest reference and platform.                                                                                                                   |
| `image-controller` | `check-types`, then the root `Dockerfile`'s `runtime` stage with `NODE_BASE_IMAGE` and `GO_BASE_IMAGE` set explicitly.                                                             |
| `egress-packages`  | Run the checked-in `deploy/egress/download-packages.mjs` with `runtime-packages.lock.json`; require the resulting `.build/mvp/egress-debs/SHA256SUMS`.                             |
| `image-egress`     | `native` and `egress-packages`, then `deploy/egress/Dockerfile` with `EGRESS_BASE_IMAGE` and `--network=none`, using the verified native executables and prepared Debian packages. |
| `images`           | `runtime-image`, `image-controller`, and `image-egress`.                                                                                                                           |

The controller target requires both its Node and Go bases and its output tag;
the egress target requires only its own base and output tag. Images
are built for the host Linux platform with `--pull=false`; a missing base may
still need to be obtained by Docker during the explicitly selected image build.
The graph does not push images, load them into Kubernetes, apply networking,
install capabilities on the host, or deploy resources.

Egress package preparation requires the checked-in downloader and lockfile.
Missing preparation code or a missing checksum manifest fails explicitly. The
Docker context includes only the two selected native executables, prepared
`.deb` files, and their `SHA256SUMS` from `.build/mvp`; other local build outputs
remain excluded.

After a build, `.build/mvp/controller.image-id` and
`.build/mvp/egress.image-id` contain Docker image IDs. The output tag and platform
are checked against each built ID. These are local image/configuration IDs,
**not registry manifest digests**. Obtain the actual image digest through the
selected [deployment procedure](../guides/deploy.md) before using an immutable
image reference in Kubernetes.

## Verification and troubleshooting

Run the dependency-independent orchestration checks with:

```sh
pnpm test:build
pnpm check:workspace
```

The orchestration tests use real Node subprocesses to verify literal arguments,
missing commands, exit status, interruption, and required output checks. They
do not establish a Rust build, container-image build, live DNS/TLS enforcement,
kernel nftables behavior, or a provider-backed model turn. The corresponding
real verification remains in the [testing guide](../testing.md).

A missing `node_modules/typescript/bin/tsc` means that dependencies have not been
prepared in this checkout. An installed compiler version mismatch means the
dependency graph must be reconciled as a separate, deliberate preparation step.
A missing Rust toolchain or offline Cargo dependency fails without fetching it;
prepare the selected toolchain and Cargo cache explicitly, then rerun the target.

A missing native manifest or egress Dockerfile means that the selected source
or image recipe is absent from this checkout. The graph fails rather than
building a fixture or another checkout. A missing output remains a build error
even when the subprocess exits successfully. A failed or interrupted prerequisite
stops dependent targets; cancellation is forwarded to the active process group.
