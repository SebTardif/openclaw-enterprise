# Native gVisor identity environment fixture

This experimental fixture supplies an actual Codex 0.153.0 app-server for the
native environment handoff. It has no provider credentials and performs one
authenticated `initialize` request plus its `initialized` notification. It
retains the native process until the reviewed absolute expiry or an observed
failure. It does not establish protected workload identity, perform enrollment,
or qualify production runtime packaging. Protected identity and access-channel
selection require separate qualification.

The `agent` Docker target contains the accepted amd64 Codex executable with
SHA-256 `fce635028842bfe9257140e8b7d53162732945e2f356fc35225be0702b4974be`.
The `gateway` target contains a separate HTTP helper required by Compute's
gateway-before-Agent preparation. Gateway readiness proves only the helper's
HTTP process. It never substitutes for the native Agent proof.

The selected [Kubernetes Compute Driver](../../../apps/controller/src/drivers/compute/kubernetes/index.ts)
must prepare each dedicated Codex Harness directly, with
`isolationProfile: "gvisor-systrap"`, omitted `runtime`, and explicit
`servicePrincipalCredentials: { mode: "disabled" }`. Omitted runtime preserves
the image command. Pod and ServiceAccount token automount must remain disabled.
No model, channel, access-token, lifecycle-hook or Secret API binding belongs in
this fixture. See the current [Compute reference](../../../docs/reference/drivers/kubernetes-compute.md)
and [gVisor reference](../../../docs/reference/drivers/gvisor.md) for supported
product boundaries.

## Reviewed build inputs

Execution requires an independent review of the exact source, build inputs,
image configuration, process, mount, network, resource and operator-custody
packet. A source draft or successful syntax check is not an execution approval.

Stage only `Dockerfile`, `launcher.mjs`, `gateway.mjs`, `node-wrapper.sh`, and
the accepted binary named `codex-x86_64-unknown-linux-musl` in a private build context. Select either
`--target agent` or `--target gateway`. The Dockerfile performs only local
`COPY` operations; it has no `RUN`, remote `ADD`, package installation, or
external Dockerfile frontend. The operator supplies both build arguments:

| Argument             | Required value                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_IMAGE`         | Exact independently reviewed, already cached official Node 24 amd64 digest; the proposed input is `node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`. |
| `FIXTURE_EXPIRES_AT` | Exact reviewed UTC deadline in `YYYY-MM-DDTHH:mm:ssZ` form, baked into `OCE_RUN11_EXPIRES_AT`. Startup rejects a missing, expired, or more-than-six-hours-future deadline.        |

Record the actual base and final image digests, original Node executable
(copied unchanged to `/usr/local/bin/node-real`), wrapper and loader
identities, native executable identity, source hashes, argv, environment keys
and deadline in the private immutable execution packet. The Dockerfile does
not verify the operator-supplied base digest. Never substitute a tag or rebuild
with a later expiry without reviewing the changed executable configuration.

## Exact processes and state

Compute's `prepare-private-state` init container uses the selected image and
executes its current `node -e` directory-initialization script. Preserve that
real source and record its rendered argv separately. This is why the image
includes Node even though the required native app-server is a Rust executable.
The image's root-owned mode-0555 `/usr/local/bin/node` is the exact
`node-wrapper.sh` source. Its `/bin/sh` runs only `set -eu`, `ulimit -n 256`,
`ulimit -c 0`, and `exec /usr/local/bin/node-real "$@"`. The unchanged original
base Node executable is copied to `/usr/local/bin/node-real`. Thus actual
Compute `node -e` initialization, each main and operator Node diagnostics
inherit descriptor/core limits without changing the Driver. Init cgroup
resources and runtime limits still need independent enforcement and observation.

Each main container starts `/usr/local/bin/node --max-old-space-size=64` with
`/fixture/launcher.mjs` or `/fixture/gateway.mjs`; the wrapper immediately becomes
`node-real` with the same arguments and no surviving shell. The image clears `NODE_OPTIONS` and `NODE_PATH`, and
sets `UV_THREADPOOL_SIZE=2`; the reviewed Pod must not override these or inject
Node startup options. The native launcher spawns exactly one direct child,
without a shell, in its own process group:

```text
/usr/local/bin/codex app-server --strict-config
  --listen ws://127.0.0.1:18790
  --ws-auth capability-token --ws-token-sha256 <ephemeral-token-sha256>
```

The launcher hashes the executable before spawning it. It generates a fresh
32-byte random transport token in memory and supplies only the digest in
native argv. The token is used only by the launcher's own loopback proof;
it is never persisted, logged, returned by HTTP, or given to the supporting
gateway. This is experimental transport authentication, with no production
service authority. The current image provides no external authenticated
app-server access procedure; later channel selection requires separate review.

The initialize exchange accepts exactly one response for request ID 1. Pinned
Codex 0.153.0 subsequently sends `remoteControl/status/changed`, and may send a
`configWarning`. The launcher accepts at most one of each: remote control must
report `disabled`, a null environment ID and the pinned hostname/installation-ID
shape; the only permitted warning is the exact pinned missing-system-bubblewrap
advisory with null details and no path/range. Each notification must have exactly
the pinned `ServerNotificationEnvelope` fields `method`, `params` and
`emittedAtMs`; the timestamp must be a nonnegative safe integer. The launcher
records only fixed observation codes and the actual notification timestamps.
No notification parameters or native installation identifier are exposed.
An unknown notification, server request, error response, duplicate response,
duplicate notification or different warning fails readiness. The client sends
`initialized` after the real response and closes only after observing disabled
remote control, within the existing exchange deadline. Success additionally
requires that the client requested Close, the parser buffer is empty at socket
closure, no transport error was observed, and the native process remains live.
The observed closure is recorded as `peer-close` for a complete valid WebSocket
Close frame, or `transport-eof` for TCP EOF without that frame. The pinned
native transport can cancel its outbound writer without flushing a Close reply;
EOF establishes neither a graceful WebSocket handshake nor native termination.
If the peer sends Close, only an empty payload or normal status 1000 with a
valid UTF-8 reason is accepted. One-byte payloads, abnormal/reserved statuses,
control payloads exceeding 125 bytes, truncated frames and bytes after Close fail.

The recognized bubblewrap advisory documents an absent optional system binary.
It does not establish native tool sandbox availability or safety, trigger an
installation, or authorize any tool execution. Failed images and observations belong in the preserved private evidence
packet; source corrections do not convert failed attempts into passes.

The main processes require UID 1000, zero permitted/effective/bounding
capabilities, `NoNewPrivs=1`, and actual soft/hard descriptor limits of 256 and
core limits of zero. The Pod must additionally use nonroot UID/GID 1000,
`allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, read-only root,
and the reviewed `oce-gvisor-systrap` handler under runsc systrap with STRICT.
The launcher checks process status and limits from guest `/proc`; independent
operator observations must establish the actual Pod, node and runsc boundary.

The current dedicated Compute mounts are:

| Mount                                                                                                      | Current source behavior and fixture use                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/node`                                                                                               | Pod-local `runtime-state` emptyDir, 1 GiB size limit. The Agent creates a fresh mode-0700 `run11-*` directory on every launch. No earlier incarnation is loaded.                  |
| `/tmp`                                                                                                     | Pod-local `runtime-temporary` emptyDir, 64 MiB size limit.                                                                                                                        |
| `/home/node/workspace`                                                                                     | Agent-specific shared workspace PVC category, writable. The fixture does not consume it; native cwd is a new private directory.                                                   |
| `/home/node/.openclaw/agents/main/sessions`                                                                | Shared PVC category, read-only for the Agent and writable for its supporting gateway. The fixture does not consume it.                                                            |
| `/home/node/.codex/generated_images`                                                                       | Shared PVC category, writable for the Agent and read-only for its supporting gateway at `/home/node/.openclaw/codex-artifacts/generated_images`. The fixture does not consume it. |
| `/home/node/openclaw-runtime-assets/bundled-skills` and `/home/node/openclaw-runtime-assets/plugin-skills` | Shared PVC categories, read-only for the Agent and writable for its supporting gateway. Skill discovery is disabled and these are not application HOME/CODEX_HOME.                |

Two Agent IDs must have distinct PVCs and Pod-local homes. No host directory,
operator record, kubeconfig, CA, SPIRE join/admin/bootstrap material, or
unselected Workload API socket may be mounted. Record any other actual rendered
mount in the execution packet; this README is not proof of the rendered Pod.

Inside each fresh `run11-*` directory, the launcher creates mode-0700 `home`,
`codex`, `workspace`, `config`, `cache`, `data`, `runtime` and `tmp` directories.
Its mode-0400, exclusively created `codex/config.toml` is the exact configuration
array in `launcher.mjs`. The launcher rejects ambient system or ancestor
configuration. Compute's legitimate generated-images mount is allowed without
using its parent as CODEX_HOME.

All inherited environment entries are removed. The native child receives
only the fixed `PATH`, isolated `HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, `LANG`,
`OPENAI_BASE_URL`, `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED`,
`TOKIO_WORKER_THREADS`, `RAYON_NUM_THREADS`, and `RUST_LOG` values in the source.
Neither model credentials nor proxy settings are inherited. The unused model
and ChatGPT URLs point to loopback port 9, which must have no listener. No
provider request is authorized or part of readiness.

Strict native configuration disables analytics, feedback, OpenTelemetry
exporters, plugins and recommendations, hooks, apps/MCP apps, remote control,
remote plugins, runtime metrics, memories, shell tools/snapshots, bundled and
host skill discovery, update checking, web search, and login shells. It uses
file credential storage in the fresh empty CODEX_HOME. It runs no `codex login`
and sends no account, thread, turn, tool, restore, model-list or background-job
request. The real app-server still has its intrinsic Rust/Tokio bookkeeping,
SQLite state and idle watchers. Source feature/auth gates suppress optional
plugin work and provider-backed catalog refresh; this fixture does not claim
to remove every internal background task from the unmodified native binary.

## Finite controls and network

| Control                          | Fixture bound                                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Init/main descriptors/core dumps | Node wrapper sets inherited soft/hard `RLIMIT_NOFILE=256` and soft/hard core-file size zero; verified in launcher and native `/proc`. Independently observe the actual short-lived init.                                                                          |
| Node memory/threads              | V8 old-space 64 MiB; image `UV_THREADPOOL_SIZE=2`. This is not a total process or Pod memory limit.                                                                                                                                                               |
| Native threads                   | `TOKIO_WORKER_THREADS=2`, `RAYON_NUM_THREADS=2`; actual thread count is observable and must fit the separately enforced PID/task cap.                                                                                                                             |
| CPU/memory/storage/PIDs          | The execution packet must supply actual main/init cgroup limits, Pod ephemeral-storage limits, volume bounds and the selected kubelet PID/task cap. The retained cluster's proposed cap is 256 host tasks per Pod; this source cannot establish that enforcement. |
| Startup                          | 30 seconds total, including streamed executable hashing. Up to 100 sequential missing-token attempts, retrying only `ECONNREFUSED` with 100 ms delay.                                                                                                             |
| Native proof connections         | One connection at a time, at most 100 startup attempts plus one wrong-token and one authenticated exchange; five seconds per exchange within the total startup deadline.                                                                                          |
| Native proof bytes               | At most 64 KiB received per exchange; 4 KiB HTTP headers; at most two distinct, exactly validated initialize notifications. Unsupported frame formats fail explicitly.                                                                                            |
| Native output                    | At most 64 KiB combined stdout/stderr over the entire incarnation; drained and counted, never printed or persisted. Excess terminates the child.                                                                                                                  |
| HTTP service                     | Eight concurrent connections, 4 KiB headers, two-second request/header/idle timers, one request per socket, no accepted bodies or upgrades.                                                                                                                       |
| Native liveness                  | Checked for each readiness request and every second against the original PID/start-time pair, process state and bounds.                                                                                                                                           |
| Lifetime                         | Stops at baked absolute expiry; restarts never extend that deadline.                                                                                                                                                                                              |
| Termination                      | Mark unready, close HTTP and tracked sockets, SIGTERM the owned native process group, SIGKILL after three seconds, and fail after five seconds without observed child closure.                                                                                    |

The Agent exposes HTTP `0.0.0.0:8080` for Compute/kubelet readiness and binds
native WebSocket only to `127.0.0.1:18790`. The supporting gateway exposes only
HTTP `0.0.0.0:8080`. Both accept only GET without bodies. All other routes return
404; WebSocket upgrades to these helpers are destroyed. No helper proxies or
forwards traffic and no shell network command is executed.

The independently reviewed NetworkPolicies must deny other ingress/egress and
pin kubelet readiness, any baseline DNS and the exact controlled receiver
needed by the external connectivity probe. The fixture itself makes only
loopback app-server proof connections. Do not add provider, production channel,
administrative Kubernetes, GitHub, SPIRE or Internet routes to obtain readiness.
Record real allowed receiver connectivity and forbidden-route denial outside
the fixture; HTTP/native initialization alone does not establish networking.

## Observations and handoff

`GET /readyz` returns only `{ "ready": true }` with HTTP 200 after real
missing-token HTTP 401, wrong-token HTTP 401, one successful authenticated
initialize with native version/home checks, and continuing child liveness.
Otherwise it returns HTTP 503 or no listener. The gateway's `/readyz` identifies
its supporting helper role and has no native claim.

`GET /evidence` is available only when the request's peer address is exactly
`127.0.0.1`; all other callers receive 404. A separately authorized operator
may issue a bounded in-Pod loopback GET without acquiring the transport token.
The JSON observation schema includes:

| Field                                                                | Expected observation                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`, `protectedIdentityProved`                                   | Experimental initialize-only scope and `false`.                                                                                                                                                                                                |
| `executionId`, `startedAt`, `expiresAt`                              | Fresh diagnostic UUID, actual launcher start timestamp, immutable deadline.                                                                                                                                                                    |
| `binary.path`, `binary.sha256`, `binary.version`                     | `/usr/local/bin/codex`, the accepted hash above, `0.153.0`; readiness requires actual hash verification.                                                                                                                                       |
| `initializeCount`, `responseVersion`                                 | Exactly `1`; the native `run11/0.153.0 ...` user-agent string.                                                                                                                                                                                 |
| `initializeNotifications`                                            | Fixed code `remote-control-disabled` and, only when the exact advisory was observed, `codex-system-bwrap-missing`; each appears at most once.                                                                                                  |
| `initializeNotificationMetadata`                                     | At most two `{ code, emittedAtMs }` observations in wire order, with the same fixed codes and validated native Unix millisecond timestamps; no notification parameters.                                                                        |
| `initializeClosureKind`                                              | `peer-close` or `transport-eof`, both after validated initialization, disabled remote control, a requested client Close, an empty buffer, no transport error and native liveness. EOF is not a graceful-handshake or native-termination claim. |
| `unauthenticatedStatus`, `wrongTokenStatus`                          | Both exactly `401`; transport errors are never counted as denials.                                                                                                                                                                             |
| `nativeLive`                                                         | Current real child liveness.                                                                                                                                                                                                                   |
| `launcher`, `native`                                                 | Guest PID, `/proc/PID/stat` start-time ticks, selected status fields, current descriptor count and raw process limits.                                                                                                                         |
| `kernel`, `stateRoot`, `childOutputBytes`                            | Guest kernel string, fresh private directory path and bounded native output count.                                                                                                                                                             |
| `modelCredentials`, `threadRequests`, `turnRequests`, `toolRequests` | `false`, `0`, `0`, `0`; launcher configuration/request accounting, not independent whole-sandbox network observation.                                                                                                                          |

Correlate these diagnostics with independently observed Compute operations,
Namespace/Deployment/ReplicaSet/Pod ownership, immutable image and node/runtime
instances and original observation times. A reported PID, UUID or restart
count does not prove a protected workload discriminator. Observe
predecessor native termination and resolve outstanding create effects before
admitting any writable replacement.

The retained environment needs an exact operator, exclusive consumer,
revalidation deadline, scoped access procedure and cleanup owner in its private
handoff. This fixture does not allocate those authorities. Cleanup must target
only independently recorded owned resources and observe process termination
and endpoint closure; a deletion request alone is insufficient.

For source-only verification, use `node --check launcher.mjs`,
`node --check gateway.mjs`, and `/bin/sh -n node-wrapper.sh`. Live acceptance requires the real selected gVisor
Compute environment and native executable. No mocked runtime, syntax check,
or supporting HTTP helper can replace that evidence. A startup failure logs
only its fixed stage/event, diagnostic execution UUID and an explicitly
allowlisted local `failureCode` (or `unclassified_failure`); native stderr is
intentionally not echoed. Notification failures distinguish ordering, envelope
keys, parameters and timestamp validation through fixed local codes.
Investigate the exact immutable config, deadline,
guest `/proc` observations and operator-owned runtime events without enabling
credentials or relaxing the selected boundary.

## Explicit execution settings

The real-environment test accepts only a fresh run. It refuses an existing
evidence directory and any continuation settings. Preserve failed-run evidence
and resource ownership; a fresh run ID does not authorize reusing or adopting
resources from another attempt.

Select the following values in the independently reviewed private execution
packet before enabling `OCC_TEST_RUN11_REAL=1`:

| Setting                                            | Required value                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_RUN11_EVIDENCE`                               | New canonical absolute directory beneath an existing canonical, operator-owned mode-0700 directory. The test creates the new directory as mode 0700 and its journal files as mode 0600. |
| `OCC_RUN11_KUBECONFIG`                             | Canonical absolute path to the operator-owned mode-0600 kubeconfig for the explicitly selected disposable cluster.                                                                      |
| `OCC_RUN11_CONTEXT`                                | Exact disposable `k3d-*` context.                                                                                                                                                       |
| `OCC_RUN11_NODE`                                   | Exact Docker container and Kubernetes name of the cluster's sole `k3d-*-server-0` node. The operator observer requires the same selection.                                              |
| `OCC_RUN11_RUNTIME_CLASS`                          | `oce-gvisor-systrap`, the Compute Driver's required class and handler. No runtime fallback is supported.                                                                                |
| `OCC_RUN11_API_SERVER`                             | Exact HTTPS loopback endpoint with an explicit port, matching the selected kubeconfig.                                                                                                  |
| `OCC_RUN11_SOURCE`                                 | Reviewed source commit, which must match the execution checkout's HEAD.                                                                                                                 |
| `OCC_RUN11_AGENT_IMAGE`, `OCC_RUN11_GATEWAY_IMAGE` | Reviewed immutable `docker.io/library/oce-run11-agent@sha256:<digest>` and `docker.io/library/oce-run11-gateway@sha256:<digest>` images.                                                |
| `OCC_RUN11_RUN_ID`                                 | Fresh 12-character lowercase hexadecimal run identifier.                                                                                                                                |
| `OCC_RUN11_OPERATOR`, `OCC_RUN11_CONSUMER`         | Explicit responsible operator and exclusive intended handoff consumer, recorded only in the private journal. Handoff still requires independent acceptance.                             |

This configuration supplies no execution approval or runtime result. Exact
process, resource, network and custody review remains required. The public
fixture provides no continuation facility or workload identity authority.
