# Upstream headless consumption probe

The opt-in integration test exercises the real upstream OpenClaw kernel in a
separate process, without attaching HTTP or WebSocket listeners. It is a
verification-only probe of internal source APIs. It does not add a supported
Enterprise runtime, channel, harness, or public headless package.

## Pinned boundary

| Component                 | Selected value                             | Meaning                                                                                        |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Upstream source           | `daf5cfeeee98dbc6cdaa89361fba73a50efdb68c` | Exact committed source archived for every run                                                  |
| Upstream package version  | `2026.8.1`                                 | Manifest assertion, not a package installation test                                            |
| Gateway protocol          | `4`                                        | Runtime assertion from the upstream protocol module                                            |
| State / Agent schema      | `15` / `19`                                | Manifest assertions; restore and migration compatibility are untested                          |
| Enterprise gateway client | `@openclaw/gateway-client@2026.8.1-beta.3` | Existing independent transport dependency; this probe does not exercise its wire compatibility |
| Node                      | `24.20.0` used for verification            | Node 24 is required by the Enterprise workspace                                                |

The upstream root package exposes its CLI/library entry and plugin SDK subpaths.
The gateway-client package exposes a WebSocket client and related helpers. Neither
package supplies a supported public `createGatewayKernel` or
`dispatchGatewayRequestInProcess` export at this pin. Source access and upstream
workspace dependency resolution remain prerequisites.

The test-only imports are:

- `src/gateway/server-kernel.ts`: `createGatewayKernel` constructs the actual
  socket-free gateway, request context, readiness state, and close machinery.
- `src/gateway/server-in-process-dispatch.ts`:
  `dispatchGatewayRequestInProcess` invokes the ordinary upstream request router.
- `src/gateway/server-plugin-runtime-client.ts`:
  `createSyntheticPluginRuntimeClient` constructs trusted internal caller metadata.
  This is not authentication of an Enterprise person.
- `packages/gateway-protocol/src/version.ts`: `PROTOCOL_VERSION` identifies the
  source protocol constant. No connection handshake takes place.

These imports are explicitly pinned test debt. The removal condition is an
upstream-supported headless adapter with complete distributable dependencies and
reviewed lifecycle, readiness, request, and close semantics. Upgrading the source
requires updating the inventory and rerunning the probe; version labels alone do
not establish compatibility.

## Run the probe

Provide a local checkout at the exact pin with its dependencies already prepared.
The test never installs or downloads dependencies. A separate prepared dependency
checkout can be selected when the original checkout is in use:

```sh
export OCC_TEST_UPSTREAM_HEADLESS=1
export OCC_TEST_UPSTREAM_SOURCE_DIR="$HOME/code/openclaw"
# Optional: root containing node_modules plus packages/*/node_modules and
# extensions/*/node_modules for the same upstream dependency graph.
export OCC_TEST_UPSTREAM_DEPENDENCIES_DIR="$HOME/upstream-probe-dependencies"
node --test tests/integration/upstream-headless-consumption.test.mjs
```

Omit `OCC_TEST_UPSTREAM_DEPENDENCIES_DIR` to reuse prepared dependencies from the
source checkout. `git`, `tar`, and the upstream `tsx` loader must be available.
Missing dependencies or the wrong source pin fail an explicitly enabled run.
Without opt-in, the integration reports an explicit skip.

Every run archives committed source to a fresh directory under the current home
and links prepared dependencies there. This excludes unrelated uncommitted source
edits without altering the source checkout. Upstream TypeScript path mappings
resolve workspace source from that archive. This is not a clean packaged-consumer
build, and linked external dependencies must already match the selected source.

The child receives a small environment allowlist and task-specific
`OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and
`OPENCLAW_OAUTH_DIR` paths. It does not replace `HOME` or `CODEX_HOME` or inherit
provider/channel credentials. The configuration disables plugins, channels,
browser control, cron, discovery, Tailscale, config reload, and update checks. The
probe supplies only a synthetic token and local message. It uses the full kernel,
not upstream's minimal-test-gateway mode. No model or external channel request is
part of the scenario.

The child has a 90-second deadline and bounded captured output. A timeout fails
the test, including when assertions complete but shutdown leaves the process
alive. The parent removes its own temporary source/state directory after the
child finishes. A forced termination of the parent can leave that directory for
manual inspection and cleanup.

## Observable coverage and limits

The probe asserts six observations from the real component:

1. Deferred sidecar startup reports not ready.
2. A synthetic `chat.send` request is denied by the real startup gate with
   retryable `UNAVAILABLE`; no successful turn is fabricated.
3. The socket-free host publishes readiness through the kernel's lifecycle
   methods. This simulates host publication, not channel or harness readiness.
4. The real `health` request handler returns a successful empty-channel result.
5. A synthetic internal client without scopes cannot read `logs.tail`.
6. The actual close handler publishes draining state, retires dispatch context,
   and prevents retained host lifecycle authority from scheduling further work.
   The child must then exit naturally.

The host callback is a harmless local stand-in for scheduling a lifecycle action.
Only the kernel's binding and invalidation of that capability are under test; the
probe does not prove a real service manager stops or restarts anything. Likewise,
internal caller scope enforcement is not an Enterprise authorization bridge.

Still missing are supported packaged exports, required-capability negotiation,
channel receive/reply/abort adapters, authenticated dedicated-harness transport,
real turn output/cancellation, per-person session authorization, durable receipts,
completed-context checkpoint/restore, replacement recovery, and cross-session
workspace admission. No channel, session, identity, persistence, or deployment
acceptance follows from this probe.

The smallest next adapter should expose immutable startup configuration and state
paths, a generation-bound lifecycle handle, explicit readiness ownership,
ordinary request/error semantics, and bounded shutdown. Subsequent adapters must
carry verified caller authority, stable conversation/turn correlation, and
checkpoint ownership through actual dispatch and harness calls. Their acceptance
requires separate tests against those real components.
