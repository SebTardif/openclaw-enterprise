# Native READ builds and staging

This page contains the detailed native artifact contract from the
[build graph's Source builds section](../build.md#source-builds). READ selection
is optional; the shared Cargo, staging, manifest, and provenance requirements
also govern the existing DNS/TLS native products. Commands below run from the
repository root.

## Select the READ product

Select `node scripts/build-mvp.mjs native-read` only when building the optional
mediated GitHub READ executable. Its required bin source is
`dataplane/services/oce-native-egress/src/bin/oce-github-read.rs`; an absent or
different bin declaration/source fails before compilation. This target has no
DNS/TLS build dependency. The existing `native`, `build`, and `images` targets
continue to select DNS/TLS without selecting READ. Primary native Git/gh does
not require this optional mediated build or its package installation.

## Retained compiler output

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

## Selected Cargo artifact

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

## Workspace and platform boundary

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

## Retained executable and staging

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

## Manifest and READ packaging contract

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

## Input continuity and acceptance limits

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
