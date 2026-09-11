# Native runtime services

Configure the native executable and protected service sources used by controller
composition. These settings do not approve a workload profile or make the missing
[deployment admission suppliers](../workload-profiles.md) available.

## Native runtime-security build and execution

The controller image includes `/usr/local/bin/oce-runtime-security`, built from
[`components/runtime-security`](../../../components/runtime-security/README.md).
Both production and development image targets require `GO_BASE_IMAGE` to name
an approved digest-pinned Go 1.26 or newer builder. Compose passes this build
argument through; a blank value fails image building. Native local development
uses `pnpm build:native` with an installed Go toolchain.

An OpenShell `gateway.binaryPath` override must be an absolute path to a trusted
Go executable. The default is `/usr/local/bin/oce-runtime-security`. The
controller invokes it directly, without a shell or inherited environment, and
passes credentials by configured file paths in bounded stdin JSON. The Go
component opens those files and handles TLS and gRPC.

See [runtime security testing](../../testing/runtime-security.md) for native
process, SPIFFE provider and PostgreSQL service-trust verification.

## Runtime service trust and authenticated readback

The optional `runtimeAuthoritySources` array in the Installation startup YAML
contains at most 32 uniquely named protected technical sources. It creates no
service admission. Each source is a closed object with `schemaVersion: 1`,
`sourceRef`, `workloadApiSocketPath`, `ownSPIFFEId`, `recipientRef`,
`recipientSPIFFEId`, `trustDomain`, `trustRootsRef`, `trustBundleSha256`,
`verifierProfileRef`, `nativeExecutableSha256`, `transportProfileRef`, and `limits`.
The socket is an absolute ASCII path of at most 103 bytes. The exact recipient
SPIFFE ID equals the native server's own SPIFFE ID in the selected trust domain.
Digest values use `sha256:` followed by 64 lowercase hexadecimal characters.

`transportProfileRef` is `owned-child-stdio-readback-v1`. The closed `limits`
object selects `handshakeTimeoutMs: 3000`, `recheckIntervalMs: 1000`,
`maxConnectionAgeMs: 30000`, `maxConnections: 1`, and `requestTimeoutMs: 3000`.
The intended peer identity and exact Agent scope enter through the human
operator admission route, not the startup file. Only the existing
`lifecycle-authority` role and exact Agent scope are currently admitted.

| Variable                                     | Meaning                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_RUNTIME_AUTHORITY_BINARY_PATH`          | Independent absolute path to the protected native validator/server executable. Source-enabled composition defaults to `/usr/local/bin/oce-runtime-authority`; the first service can be admitted before a listener is configured. |
| `OCC_RUNTIME_AUTHORITY_READBACK_CONFIG_PATH` | Optional protected JSON selecting one admitted service and listener. Absence starts no readback listener.                                                                                                                        |

The readback JSON has exactly `schemaVersion: 1`, `binaryPath`, `listenAddress`,
`recipientRef`, and `serviceIdentityRef`. Its binary path must equal the separately
selected validator path; all other technical/profile fields come from the current
admitted database record. Protect the configuration, executable and parent
directories from replacement by runtime peers or untrusted workloads. Executable
hash checks do not prevent privileged concurrent replacement.

`trustBundleSha256` hashes the concatenated current own-domain Workload API bundle
DER bytes in their supplied order. Bundle changes deny the old profile until
explicit source replacement and service re-admission. Certificate renewal under
the same admitted bundle can establish a new connection; it does not preserve an
old connection's authority. Missing or unavailable selected inputs fail startup
or deny the affected request; no cached grant or service API key substitutes.

See [Runtime authority](../runtime-authority/service-trust.md#operator-admitted-service-trust) for
operator requests, exact recovery, currentness and permission boundaries, and
[Runtime service transport](../runtime-service-transport.md) for native process and
connection custody.
