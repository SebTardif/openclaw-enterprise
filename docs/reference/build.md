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
| `check-native` | Checks the exact Rust version in `dataplane/rust-toolchain.toml`, Cargo metadata, and the eight selected workspace members and their local path dependencies.                                                   |
| `native-dns`   | `check-native`, then a release build of the `oce-dnsgate` OCE adapter in package `ds-dnsgate`. Copies the verified executable to `.build/mvp/native/oce-dnsgate`.                                               |
| `native-tls`   | `check-native`, then a release build of the `oce-egress` OCE adapter in package `ds-tlsproxy`. Copies the verified executable to `.build/mvp/native/oce-egress`.                                                |
| `native`       | Both native product binaries. Each shared prerequisite runs once per invocation.                                                                                                                                |
| `build`        | `check-types` and `native`. This is the `pnpm build:mvp` target.                                                                                                                                                |

The original `pnpm build` and `pnpm typecheck` commands continue to check the
TypeScript workspace. Its projects are `utils`, `contracts`, `occ`, `iam`,
`audit`, and `controller`. Their generated `dist` outputs are checked build
artifacts. The controller image continues to package and execute the existing
TypeScript source and `.mjs` entrypoints.

Native builds require a Linux amd64 or arm64 host, its native C compiler and
build tools, and CMake for the selected native library dependencies. They
explicitly select the host GNU Rust target. Cross-compilation is outside this
command's supported boundary. `ZSTD_SYS_USE_PKG_CONFIG` must be unset: that
override selects an ambient system zstd instead of the locked bundled source,
and the build rejects it even when its value is `0`.
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

## Image builds

Image construction is explicitly selected and may use the network. In
particular, the existing controller Dockerfile installs production dependencies.
It is not part of `pnpm build:mvp` or `pnpm build:dataplane`.

The image graph takes a separately prepared OpenClaw/Codex runtime image. It
checks that its exact digest reference is present in the local Docker engine
and matches the Linux host architecture. It does not rebuild, pull, or substitute
that runtime. Follow the [runtime image recipe](../../deploy/runtime/README.md)
to prepare it.

Set all five inputs explicitly:

| Environment variable          | Input                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_BUILD_NODE_BASE_IMAGE`   | Approved Node.js 24 image reference ending in `@sha256:<64 lowercase hexadecimal digits>`.                                      |
| `OCC_BUILD_EGRESS_BASE_IMAGE` | Approved Linux egress base with the same digest-reference form; the selected nft backend requires its runtime networking tools. |
| `OCC_BUILD_RUNTIME_IMAGE`     | Separately prepared, locally available OpenClaw/Codex runtime digest reference.                                                 |
| `OCC_BUILD_CONTROLLER_TAG`    | Explicit output tag for the controller image, other than `latest`.                                                              |
| `OCC_BUILD_EGRESS_TAG`        | Explicit output tag for the egress image, other than `latest`.                                                                  |

Controller and egress output tags must be distinct. Image input validation runs
before compilation prerequisites so invalid selections fail without starting a
build.

```sh
pnpm build:images
```

| Target             | Prerequisites and image recipe                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime-image`    | Verify the selected local runtime digest reference and platform.                                                                                       |
| `image-controller` | `check-types`, then the root `Dockerfile`'s `runtime` stage with `NODE_BASE_IMAGE` set explicitly.                                                     |
| `image-egress`     | `native`, then `deploy/egress/Dockerfile` with `EGRESS_BASE_IMAGE` set explicitly and both verified native executables available in the build context. |
| `images`           | `runtime-image`, `image-controller`, and `image-egress`.                                                                                               |

The individual image targets require only their own base and output tag. Images
are built for the host Linux platform with `--pull=false`; a missing base may
still need to be obtained by Docker during the explicitly selected image build.
The graph does not push images, load them into Kubernetes, apply networking,
install capabilities on the host, or deploy resources.

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
