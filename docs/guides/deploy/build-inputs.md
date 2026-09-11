# Prepare image build inputs

Prepare immutable local package and SDK contexts before building controller or
runtime images. Run commands from the repository root and keep preparation
evidence outside tracked source.

## Prepare the runtime build context

The runtime recipe consumes five local package archives: OpenClaw core,
`@openclaw/ai`, and the Slack, Microsoft Teams, and Codex plugins. Prepare them
with the frozen dependency policy and immutable input description specified in
the [runtime packaging contract](../../../deploy/runtime/README.md). Preparation
uses already built source artifacts; it does not rebuild the upstream SDK.
The native Codex CLI remains pinned to `0.153.0`.

Choose an absolute, task-owned output path that does not already exist:

```bash
export OCC_RUNTIME_BUILD_CONTEXT='/absolute/task-owned/runtime-context'
node deploy/runtime/prepare-local-packages.mjs \
  --inputs /absolute/task-owned/immutable-inputs.json \
  --output "$OCC_RUNTIME_BUILD_CONTEXT"
node deploy/runtime/prepare-local-packages.mjs \
  --verify-context "$OCC_RUNTIME_BUILD_CONTEXT"
```

The prepared directory supplies `package.json`, `package-lock.json`,
`artifacts/*.tgz`, and `preparation.json` as the Docker build context. Keep the
original archives and input record with the preparation evidence. Preparation
and offline smoke success do not promote provisional source artifacts to
accepted release inputs or qualify an image for deployment.

`scripts/dev-up` reuses an existing default runtime image. Only when that image
is missing does it require `OCC_RUNTIME_BUILD_CONTEXT`, run the context verifier
above, and build it with:

```bash
docker build -f deploy/runtime/Dockerfile \
  --tag openclaw-enterprise-runtime:quickstart "$OCC_RUNTIME_BUILD_CONTEXT"
```

Custom runtime image selection retains its existing behavior and does not
trigger this default-image preparation path. The helper does not create a
context, rebuild the SDK, or substitute registry packages when inputs are
missing. See [development settings](../../reference/settings/development.md#required-development-controller-environment)
for image selection and the context variable.

## Controller SDK build inputs

Root Dockerfile targets `development` and `runtime` consume a frozen upstream
SDK input context in addition to the full runtime package context. Obtain the
reviewed SDK context and expected manifest hash from its preparation owner:

```bash
export OCC_BUILD_UPSTREAM_SDK_CONTEXT='/absolute/path/frozen-upstream-inputs'
export OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256='<64-lowercase-hexadecimal-digits>'
export NODE_BASE_IMAGE='registry.example.com/approved/node-24@sha256:<approved-digest>'
```

Select Node.js 24.15.0 or newer within Node.js 24. Both the controller SDK stage
and full runtime recipe reject earlier minors or different major versions.
Use Docker BuildKit with named context support. The SDK context contains
`layout.json` and its reviewed package, archive and dependency inputs. Docker
copies that context to `/opt/oce-upstream-inputs`; the manifest's absolute source
and dependency paths must address that container layout. A host-only manifest
or a worktree `.build/upstream-sdk` directory cannot replace these inputs.
See the [SDK layout contract](../../reference/build.md#local-upstream-sdk-declarations)
for inventory requirements and verification limits.

Compose maps the two SDK environment variables into its named build context
and manifest-hash argument. Direct Docker builds must supply both explicitly,
as in the recipes below. The `image-controller` build-graph target also requires
a canonical absolute context directory without symlink traversal and a
lowercase 64-digit SHA-256. Keep private manifests outside tracked source.
