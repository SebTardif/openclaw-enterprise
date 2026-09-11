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
| `native-read`  | `check-native`, then a separately selected release build of `oce-github-read` in package `oce-native-egress`. Captures the compiler-reported executable and stages it at `.build/mvp/native/oce-github-read`.   |
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

Select `node scripts/build-mvp.mjs native-read` only when building the optional
mediated GitHub READ executable. Its required bin source is
`dataplane/services/oce-native-egress/src/bin/oce-github-read.rs`; an absent or
different bin declaration/source fails before compilation. This target has no
DNS/TLS build dependency. The existing `native`, `build`, and `images` targets
continue to select DNS/TLS without selecting READ. Primary native Git/gh does
not require this optional mediated build or its package installation.

For a separately selected READ build, `OCC_BUILD_READ_COMPILER_OUTPUT` optionally
names an existing absolute, canonical Linux output directory owned by the
current user, without special or group/world write bits. The runner exclusively
creates `stdout`, `stderr`, and `receipt.json` there; existing files and linked
paths fail before Cargo starts. Select a fresh directory outside the source
inputs. This option applies only to `native-read` and only to its one Cargo
`build` invocation. Tool discovery, version output and builder progress remain
outside these compiler streams.

The two channels retain their original bytes, with a combined 8 MiB limit and
bounded writes that apply backpressure. The existing 4 MiB parser limit remains.
The runner reads back each retained output descriptor, flushes and closes it,
and leaves completed files owned by the caller with mode `0400`. The receipt
records the literal command, working directory, PID, exit status and signal,
cancellation, and each channel's observed/stored byte counts, SHA-256 hashes,
EOF, flush, close and final file identity. `complete` describes stream custody;
Cargo can fail with complete streams. Natural Cargo failure preserves both
channels and its original failure status. A receipt publication failure rejects
success and removes only its own matching partial receipt. Replaced files are
never removed. Overflow, write/readback loss, changed paths and incomplete
capture refuse staging. Captured parser stdout must have the same digest as the
raw stdout bytes; lossy UTF-8 decoding is rejected. Protected parent directories
and trusted same-owner/privileged writers remain required throughout capture.
This log receipt adds no compiler success, source, install or image claim to the
native manifest.

Each native Cargo build selects JSON messages with `--message-format=json`.
The runner requires exactly one selected executable artifact and exactly one
successful terminal `build-finished`, as well as successful subprocess exit.
It matches the inspected Cargo package ID and manifest, binary name, exact
`kind` and `crate_types` of `["bin"]`, entrypoint source, and executable under
the selected GNU target's release directory. `profile.test` must be `false`;
`target.test` instead describes Cargo's test-target capability and is not that
selector. An executable pathname alone is insufficient. Duplicate, failed,
incomplete, malformed, mismatched and excess messages refuse staging. Capture
is limited to 4 MiB of JSON and 8,192 records. A reported fresh artifact is
permitted and recorded as cached, rather than claimed to be freshly compiled.

The selected Cargo members are `ds-contracts`, `policy-core`,
`ds-policy-snapshot`, `ds-telemetry`, `ds-admission-shm`, `ds-nft`, `ds-dnsgate`,
`ds-tlsproxy`, `oce-native-egress`, and `oce-network-fence`. The final four live
under `dataplane/services`; the others live under `dataplane/crates`. The native
GitHub library and closed node fence are workspace members; the default native
product build still emits only `oce-dnsgate` and `oce-egress`.
Missing manifests, unavailable cached dependencies,
different workspace members, external entrypoints, and resolved local path
dependencies or Cargo patches outside this selection fail
the build. There is no fallback to an external checkout or prebuilt executable.

Cargo's offline setting governs Cargo dependency access; it is not an operating
system network sandbox for compiler processes or dependency build scripts.
The egress image base must support the resulting GNU Linux executable's system
library requirements; compilation alone does not verify that runtime ABI.

Native artifact staging requires a canonical absolute source path without
symlink traversal, a nonempty regular file owned by root or the current build
user, executable access, and no group/world write or special mode bits. The
source may have owner write permission, as ordinary Cargo outputs do. Each
artifact is limited to 128 MiB. The runner opens it without following symlinks,
checks execution access through that descriptor, and captures its bounded
hash. The same descriptor remains open through subsequent source validation
and staging; replacement or mutation between those steps refuses. It streams
bounded chunks into an exclusively created output and requires their hash to
match the capture, sets the staged file to `0555`, and reads back the staged descriptor to
check its hash. File identity, size, owner, mode and change timestamps must
remain consistent through capture; changed or replaced paths fail. Failed
staging removes the partial output it created. Ordinary declaration and build
prerequisite files continue to use their separate non-executable checks.

A successful native build atomically writes `.build/mvp/native-manifest.json`
with `schemaVersion: 2`. It records:

- `rustToolchain`, `rustTarget`, `imagePlatform`, and `hostGlibcVersion` for the
  selected build; `tools` binds the observed Cargo and rustc executable bytes,
  sizes and version output. Absolute host tool paths are omitted.
- `sourceInputs.files`: sorted relative paths, byte sizes and SHA-256 digests
  for the runner, workspace Cargo manifest/lock/toolchain pin, every file in
  the ten selected local package directories, and present repository/dataplane
  `.cargo/config` or `.cargo/config.toml` files. This includes headers, test
  data, dirty files, untracked files and empty source files. `sourceInputs.sha256`
  is the SHA-256 of the UTF-8 compact JSON encoding of that ordered files array.
  Symlinks and special files are refused. The inventory permits at most 8 MiB
  per file, 64 MiB total, 8,192 entries and 32 nested levels.
- Each product's package, binary and staged relative `path`; its `staged`
  object records the observed SHA-256, size, UID, GID and mode. These describe
  the file in the build workspace.
- Each product's `compilerArtifact` records `buildTarget`, inspected
  `packageVersion`, relative `manifestPath` and `sourcePath` with their SHA-256
  digests, `rustTarget`, `kind`, `crateTypes`, `test: false`, `fresh`,
  `buildFinished: true`, and `messagesSha256` for the complete captured Cargo
  stdout bytes. `executablePath` is relative to the source root. Its `artifact`
  object records SHA-256, size, UID, GID and mode from the retained compiler
  output descriptor. The captured and staged hash/size must agree; source
  output modes may include owner write while the staged mode is `0555`.
- Each product's `dependencies` lists the other package identities actually
  reported by compiler-artifact messages in that invocation, matched to the
  inspected Cargo graph: `package`, `version`, and Cargo `source`. Local
  dependencies also have relative `manifestPath` and `manifestSha256` bound to
  the captured source inventory. This is reported build provenance, not a
  complete measurement of dependency cache bytes or build-script inputs.
- Each product's `installationRequirements` declares its
  `/usr/local/bin/<binary>` path, UID/GID `0:0` and mode `0555`. The selected
  package installation must enforce these requirements. They are declarations;
  they are not observations from an installed image.

For `native-read`, schema 2 contains exactly the READ product built in that
invocation: package `oce-native-egress`, binary `oce-github-read`, staged path
`.build/mvp/native/oce-github-read`, `compilerArtifact.buildTarget: native-read`,
and declared install path `/usr/local/bin/oce-github-read`, UID/GID `0:0`, mode
`0555`. The manifest is replaced, not merged with a previous DNS/TLS manifest.
The separately selected package consumer must verify the actual staged bytes
against this selected manifest and its original build receipt. Copied
provenance or a local Docker image ID does not establish an immutable final
image, installed ownership/mode, or permission to launch the READ process.
READ manifests use compact JSON and must fit the installed consumer's existing
65,536-byte UTF-8/canonical limit, 32 container levels, 1,024 entries per
container, and 8,192 value nodes. Unsupported numbers or Unicode also refuse.
An oversized inventory or result fails publication with the full inventory
preserved in memory; the builder never truncates it to obtain a successful
manifest. Complete fit is checked against the actual generated manifest after
the selected build; source-only inspection does not establish that outcome.

The runner captures selected local inputs before checking/building, then
compares bytes and file identities around compilation and before manifest
publication. It also rechecks every staged product before publication. A
selected-input change, including adding a file or rewriting a file with its
original bytes, refuses success. A new native invocation removes the previous
manifest before prerequisites, and any failure leaves no replacement success
manifest. Publication uses a temporary file and rename so partial JSON does
not appear at the final path.

Run with quiescent inputs and build-output directories protected from unrelated
writers. Descriptor and timestamp checks detect observed changes; they do not
exclude privileged writers or provide an immutable filesystem snapshot. This
manifest binds the selected local inputs and observed outputs, not a hermetic
build closure: Cargo caches, ambient configuration/environment outside the
selected paths, C/linker tools, system libraries, and files read or generated by
dependency build scripts are not completely inventoried. A successful build
or manifest does not establish image/runtime acceptance or qualify a READ
startup profile, current authority, or provider lifetime.

The host glibc field records build provenance; it is not a measurement of the
binary's minimum supported glibc. Execute the real product inside the selected
image to verify runtime library compatibility, installed ownership/mode and
entrypoint behavior before deployment.

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
real verification remains in the [testing guide](../testing/README.md).

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
