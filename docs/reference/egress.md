# External model egress packaging

See the [adapter flow](../flows/external-model-egress.md) for the implemented
request sequence and the required canonical authority boundary.

This component packages the selected DS-derived DNS admission and TLS custody
adapters as `oce-dnsgate` and `oce-egress`. The adapters run outside the untrusted
Agent. The DNS process owns narrowly scoped namespace firewall enforcement; the
TLS process alone receives the provider credential file. A separate canonical OCE
authority must authenticate the actual workload bearer, resolve its current
assignment, authorize the original turn and exact model operation, and own the
operation receipt.

The packaging is an implementation candidate for the external custody milestone.
It does not install the canonical authority, issue grants, configure an Agent, or
establish a supported production deployment. An available socket path, successful
image build, and passing packaging tests do not establish a provider-backed model
turn or a qualified sandbox. Missing authority prevents readiness and authorized
provider dispatch. The [platform design](../design.md) remains authoritative;
[repository access modes](../../specs/20-repository-access-modes.md) describe the
separate native Git/`gh` direction.

## Supported adapter profile

The current profile has one recipient, `https://api.openai.com:443`, and one
operation, ordinary `POST /v1/responses` HTTP/SSE with an admitted turn carrier and
the actual workload bearer. Incoming connections use HTTPS. The provider key is
read only by the trusted TLS process after authorization and authenticated
upstream TLS. DNS admission selects the exact IPv4 address used for that socket;
there is no ordinary resolver fallback. IPv6 upstream transport is disabled in
this profile. CONNECT, WebSockets, compact, arbitrary origins, and a generic
credential substitution proxy are outside this profile.

This is the fixed OpenAI API provider-key profile. Separate experiments using an
existing Codex ChatGPT workload-identity credential do not configure this adapter
and are not a supported product path. Do not substitute a ChatGPT session or WIF
credential, change the recipient, or infer support from those probes.

### Request and admission bounds

The Rust TLS adapter accepts a declared request body of at most **16 MiB
(16,777,216 bytes)**. It rejects a larger `Content-Length` before reading the body
or contacting authority, DNS, or the provider. Capture reserves the declared
length fallibly once and checks accumulated bytes against both that length and
the ceiling. UTF-8, duplicate-aware JSON, local operation checks, and the digest
use the original bytes. Validation must finish within the original five-second
acquisition deadline before any reservation or authority request begins.

Authority admission embeds the original body as a JSON string in a fixed
ten-field envelope. Its payload cap is **32 MiB + 64 KiB (33,619,968 bytes)**;
the four-byte length prefix is outside that cap. Validated raw JSON may nearly
double when escaped into this string. The other currently bounded fields require
at most 17,028 additional bytes. Admission counts the actual typed envelope with
an empty body, then adds the exact escaped-content byte count of the original
UTF-8 body. Serde emits the original envelope into one bounded, fallibly allocated
frame before opening the Unix connection. Counting and emission consume the same
original one-second RPC deadline; checks before, between, and after them gate
connection but do not preempt synchronous CPU work. Overflow or expiration
refuses before connection.
Ordinary TLS-adapter RPC requests retain their 2 MiB cap and replies retain
64 KiB. The DNS service's
separate 64 KiB protocol is unchanged.

The separately supplied canonical admission receiver must enforce the overall
frame ceiling before allocation and the method's bound before effects. A length
prefix alone does not identify the method. This repository supplies controlled
admission receivers for tests, not that canonical service. The separate
TypeScript Codex context and model-request parsers also enforce the 16 MiB raw
body ceiling. Their separate 8 KiB metadata, 64-level depth, and 20,000-value
limits remain in force. They are not wired into this Rust transport; end-to-end
profile integration remains incomplete.

Capture, admission work, and forwarding transfer the original zeroizing body
owner. Forwarding uses owner-backed `Bytes`; it does not create another complete
body buffer. The explicit body plus maximum admission frame accounts for at most
50,397,188 logical bytes per exchange. This is copy accounting, not a hard memory
bound: the full parsed JSON tree, parser scratch, allocation capacity, Hyper/TLS
buffers, process overhead, and concurrent exchanges are additional. No new JSON
shape restriction is inferred from the byte ceiling. The selected 256 MiB service
budget and per-Agent/generation limits require separate enforcement and
qualification. Local packaging selects two active exchanges per TLS process;
the adapter accepts explicit configurations of up to eight. The process-local
limit does not enforce an Agent-wide limit across multiple service instances.

Three distinct process identities are required:

| Process                 | Linux UID | Authority and mounts                                                                                                                                      |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS admission           | `0`       | Sole `NET_ADMIN` owner in the dedicated egress network namespace; writes its own admission socket directory.                                              |
| TLS custody             | `10002`   | No added capabilities; reads the admission and authority socket directories through read-only mounts; alone receives provider and incoming TLS key files. |
| Canonical OCE authority | `10003`   | No added capabilities; owns its authority socket directory and the real OCE identity, policy, audit, and persistence integrations.                        |

Socket paths are not identity credentials. The adapters check the actual peer UID
with `SO_PEERCRED`. The producer owns each socket directory; consumers cannot
unlink or replace its socket. Agent workloads receive neither directory, firewall
capabilities, nor provider key. Sharing a Pod or Docker network namespace does not
share provider file mounts.

## Image build

The selected source and its attribution are in
[dataplane](../../dataplane/README.md). Prepare dependencies separately from
verification. On Linux `amd64`, install the pinned toolchain and fetch the locked
Cargo inputs through the configured registry:

```sh
rustup toolchain install 1.95.0 --profile minimal
cargo +1.95.0 fetch --manifest-path dataplane/Cargo.toml --locked --target x86_64-unknown-linux-gnu
node scripts/build-mvp.mjs native
```

The native build itself is offline and locked. It requires an installed C compiler
and assembler for Ring. It does not install or reconcile dependencies. TypeScript
workspace preparation remains covered by the [quickstart](../guides/quickstart.md).

The image recipe is [deploy/egress/Dockerfile](../../deploy/egress/Dockerfile). It
accepts only the base recorded by
[runtime-packages.lock.json](../../deploy/egress/runtime-packages.lock.json):

```text
node:24-trixie-slim@sha256:50c3b2f6988dfc307b86e5301d69611af31f4789bdf232863b07d3b02fe55ae0
```

This is the official image's registry manifest index digest. A local Docker image
ID is different and must not be placed after a registry reference's `@sha256:`.
The package closure currently covers Linux `amd64` only; other platforms fail
explicitly. This Trixie base is selected for compatibility with the current GNU
native build; the older Bookworm base cannot run binaries that require the host's
newer glibc symbols. Every image build executes both actual adapter `--version`
entrypoints so loader failures stop the build.

The native build must produce exactly
`.build/mvp/native/oce-dnsgate` and `.build/mvp/native/oce-egress`, using the selected
eight-member Rust workspace and the repository's pinned Rust toolchain. The image
does not include the stock DS executables, mint, host/tap tooling, or a fallback
binary. The recipe copies the source license, attribution, source manifest, and
Cargo/Rust library notices into `/usr/share/doc/oce-egress/`. OS package notices
remain separate. Verify those contents in an actual built image before
distribution; the recipe alone does not establish delivery.

Run the repository's `image-egress` build target with
`OCC_BUILD_EGRESS_BASE_IMAGE` set to the pinned reference above and
`OCC_BUILD_EGRESS_TAG` set to an explicit local output tag. Its package prerequisite
runs:

```sh
node deploy/egress/download-packages.mjs
node deploy/egress/download-packages.mjs --verify
```

Build the actual image with `node scripts/build-mvp.mjs image-egress` after the
native source and required operator configuration are present.

The downloader fetches only the checked-in exact Debian archive URLs and checks
their complete SHA-256 and size closure. It refuses unexpected files, symlinks,
redirects, changed bytes, and unsupported package locks. It does not install host
packages. The image build runs with `--network=none`, verifies the same closure
again inside the image, then installs the offline packages. The image alone does
not establish that the chosen container runtime supplies the declared capability
set; the actual UID, effective capabilities, and nft operation need runtime
verification.

## Local development

The local target launches the two real adapters in one dedicated Docker network
namespace. It requires an already running canonical authority on a protected
local Unix socket; it does not start an authority fixture. The authority process
must run as UID `10003`, own a non-writable-by-consumers directory, and listen at
`authority.sock`. TLS and DNS mount that directory read-only. Their protocol
checks, rather than file existence alone, establish live authority readiness.

Use Linux `amd64`, an explicitly selected local Docker Unix-socket context, and a
locally available immutable image. No automatic pull, host networking, shared host
PID namespace, Docker socket mount, or host firewall command is used by the
launcher. Docker still manages its own project bridge and published port. The
only published listener is `127.0.0.1:8443`.

Prepare an operator-owned directory with mode `0700` containing references to an
existing authorized provider key and an incoming TLS certificate/key valid for
`localhost`. The launcher never reads or copies provider key bytes. Docker bind
mounts preserve inode ownership: the files must actually be readable by UID
`10002`. For files owned by the developer, mode `0444` under the private `0700`
parent permits the TLS bind mount to read them while other host users cannot
traverse the parent. Do not change an existing credential store's permissions;
use a separately provisioned private development credential file. Supply the
existing authority's selected provider binding reference and its complete
immutable credential descriptor. The operator must provision the exact service
account, credential profile, provider profile, audience, and transport profile
references. The launcher supplies no defaults, discovers no identity from the key,
and does not establish that a reference exists in canonical OCE state.

Create a local configuration file outside tracked source, replacing each
illustrative value with the actual provisioned value:

```json
{
  "schemaVersion": 1,
  "project": "oce-egress-local",
  "image": "sha256:<actual-local-Docker-image-ID>",
  "authoritySocketDirectory": "/absolute/operator/authority",
  "providerKeyPath": "/absolute/private/provider-key",
  "providerBindingRef": "existing-openai-binding",
  "credentialBinding": {
    "provider_binding_ref": "existing-openai-binding",
    "service_account_id": "<exact-provisioned-service-account-id>",
    "credential_profile_ref": "<exact-provisioned-credential-profile-ref>",
    "provider_profile_ref": "<exact-provisioned-provider-profile-ref>",
    "audience_ref": "<exact-provisioned-audience-ref>",
    "transport_profile_ref": "<exact-provisioned-transport-profile-ref>"
  },
  "certificatePath": "/absolute/private/localhost.pem",
  "certificateKeyPath": "/absolute/private/localhost-key.pem",
  "dnsUpstream": "<actual-IPv4-resolver>:53"
}
```

`credentialBinding` must contain exactly those six snake-case fields, each a
nonempty reference of at most 128 nonspace ASCII characters. Its
`provider_binding_ref` must equal `providerBindingRef`. The generated TLS
configuration preserves this complete descriptor as `credential_binding`; TLS
compares every field to the independently authenticated authority decision
before credential dispatch. Unknown, missing, malformed, or mismatched fields
stop local configuration generation. The placeholders above are not provisioned
identities and must be replaced with operator-owned values.

The image field also accepts an existing registry manifest digest reference. The
local image ID form is used only to select content already in the local Docker
daemon. Select a reachable unicast IPv4 resolver outside container loopback;
only DNS UID `0` is allowed to contact its port 53. Docker's embedded
`127.0.0.11` resolver is excluded because its destination-port translation does
not match the current exact port-53 firewall profile. The firewall must not
grant all processes unrestricted loopback access.

```sh
node deploy/egress/local.mjs check /absolute/private/egress-local.json
node deploy/egress/local.mjs up /absolute/private/egress-local.json
```

`check` verifies configuration and file ownership/readability prerequisites. `up`
starts the actual image and waits for the TLS executable's `--ready` probe, which
checks both current authority and actual DNS enforcement. This is dependency
readiness, not a synthetic model turn. Only a real admitted workload bearer and
canonical turn can authorize a provider request. Startup failure stops this
Compose project and retains its generated state for inspection.

This local profile explicitly sets `max_concurrent: 2` and a 128-process limit
for each adapter container. Those are configured bounds, not a verified capacity
guarantee; container resource exhaustion and authority unavailability must still
fail closed.

The generated Compose configuration and adapter files are under
`.build/mvp/egress-local/<project>/`. Provider and TLS private keys remain at their
original referenced paths and are mounted only into TLS. No Agent container or
guest egress policy is created by this target. To stop the pair and remove only
its generated state and socket volume:

```sh
node deploy/egress/local.mjs down oce-egress-local
```

DNS shutdown keeps the namespace's deny floor; an existing table is not treated
as reconstructed current authority on restart. The candidate also retains at most
4096 operation fences for its process lifetime and refuses new operations when
that capacity is exhausted. Replacing the namespace requires a fresh canonical
authority incarnation until durable recovery is implemented. The helper cannot
restart or authenticate that separately supplied authority on the operator's
behalf. Once that prerequisite is satisfied, recreate the whole local project
with `down` followed by `up`; independently restarting DNS while TLS still uses
its old namespace is unsupported. The local TLS service uses Docker's
unprivileged init process to forward SIGTERM to the native process, which closes
its sockets;
it has no graceful stream-drain protocol. An interrupted provider operation
remains uncertain until the real authority reconciles it. The ten-second Docker
stop budget is a process termination limit, not proof of a completion receipt.

## Kubernetes boundary and verification

This package does not install a Helm release. A production chart requires the
real canonical authority entrypoint/configuration, exact allowed database and
identity destinations, and a verified capability/startup/restart lifecycle. Do
not supply a permissive authority fixture or declare this local pair production
ready to fill that gap.

The deployment must use an external trusted egress Pod with default-deny
NetworkPolicies and explicit destination facts. Pod policy cannot distinguish
the three process UIDs; the DNS-owned namespace firewall supplies that boundary.
Only DNS may resolve through the selected IPv4 resolver, TLS may connect to
currently admitted IPv4 addresses on TCP 443, and authority may reach its exact
declared dependency addresses and ports. No blanket loopback, host network,
hostPath, privileged container, or additional firewall writer is required.

TLS and authority require explicit nonroot UIDs. DNS uses the canonical UID `0`
profile with only `NET_ADMIN`; this is an explicit deployment contract, with no
UID fallback or privilege-raising launcher. All containers retain a read-only root
filesystem, dropped capabilities, no privilege escalation, and runtime-default
seccomp. DNS receives no `NET_RAW`, `DAC_OVERRIDE`, `SETUID`, `SETGID`, or `SYS_PTRACE`,
and no provider-secret mount. Disable automatic service-account token mounting.

DNS can change the entire shared trusted service network namespace, and UID `0`
can change root-owned writable files. The boundary depends on its separate mount
and PID namespaces, read-only authority socket mount, absence of secret mounts,
and narrow capabilities. Do not place the authority socket under a writable
root-owned directory shared with DNS. DNS's `NET_ADMIN` requires an explicit
operator admission exception to Baseline/Restricted Pod Security; UID `0` also
requires the corresponding Restricted nonroot exception. Do not weaken an
existing namespace policy automatically. Use a dedicated producer-owned volume
for each socket directory. Mounting over an image directory does not preserve its
image-layer ownership in Kubernetes.

The Agent's no-bypass network policy belongs to its selected `SandboxDriver`.
An egress service's policy does not prevent a separately configured Agent from
reaching alternate DNS, direct IP, DoH/DoT, QUIC, or other destinations. Only the
selected Driver integration and actual allowed/denied connection tests can
establish that property for an admitted Agent. No multi-replica or durable live
admission recovery guarantee is made by this package.

Run the dependency-independent packaging checks with:

```sh
node --test deploy/egress/packaging.test.mjs
pnpm check:workspace
```

These tests verify generated configuration and real package-file integrity, not a
running container, canonical authority, Kubernetes policy, or provider response.
When `.build/mvp/native/oce-egress` exists, the suite also runs that actual
executable against generated configuration with ephemeral test TLS material and
an intentionally absent authority socket. It requires successful Rust
configuration/TLS loading followed by the exact authority-dependency refusal;
missing credential descriptor fields and provider mismatches must instead fail
configuration loading. No fake authority or provider key is supplied. Select a
different current built executable with the absolute path
`OCC_TEST_EGRESS_CONFIG_BINARY`; an explicitly selected missing executable fails
the test. If no executable is available at the default path, this native check
is explicitly skipped, leaving Rust configuration acceptance unverified. The
native check requires the existing `openssl` command and installs nothing.
Runtime acceptance must inspect actual UIDs/effective capabilities, exercise nft
and read-only socket mounts, reject unexpected peer UIDs, check dependency
outage/expiry, and observe both allowed provider traffic and denied bypass
traffic. Follow the repository's [testing instructions](../testing.md) for the
explicitly selected disposable Kubernetes environment and real model tests.

When readiness fails, inspect the exact project's DNS/TLS container exits and the
canonical authority's attributable audit evidence. Check effective capability
delivery, the selected resolver, socket ownership, authority freshness, and
whether a prior deny table requires namespace recreation. Do not inspect or print
provider credential bytes to diagnose a refusal.
