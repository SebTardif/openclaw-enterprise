# Authenticated runtime operation readback

The controller can expose the existing runtime authority `readOperation` method
through a dedicated TLS listener. An independent service authenticates with its
own X.509-SVID. The controller then reads the current protected service registry,
checks the service's exact Agent scope, and returns only an exact historical
operation accepted from that same service. No deploy, binding, evidence,
retirement, restore, runtime selection or workload execution is enabled by this
listener.

The implementation uses the existing [native service peer](native-service-peer.md)
and [runtime authority](runtime-authority.md) components. It adds an actual
process boundary: the controller owns a dedicated `oce-runtime-authority serve`
child, its original standard-input/output pipes, and its lifetime. The child
owns the Workload API source, exact mutual TLS connection, original request
bytes and response stream. Peer diagnostics received from another process or
through an HTTP header cannot enter this accepting path.

## Admission and startup

Provision the controller workload with a protected local SPIRE Workload API
socket and an exact X.509-SVID. A deployment-owned source manifest fixes the
own and recipient SPIFFE IDs, source path, trust domain, trust-root reference,
order-sensitive trust-bundle digest, verifier profile, executable digest and
transport limits. The existing authenticated Installation administrator path
admits that source and subsequently admits a service's exact peer SPIFFE ID and
Agent target. Admission uses the current selected IAM driver and persists the
registry change with its audit record. See [runtime authority](runtime-authority.md)
for the management API and registry lifecycle.

The selected first service profile grants `lifecycle-authority` for one exact
Agent and `read-operation-only-v1`. The service receives a server-generated
`runtime-service/<UUID>` reference. The technical source manifest cannot come
from the peer or be replaced by ordinary API caller-key authentication. Source
replacement or withdrawal invalidates every service still bound to the previous
source admission; an explicit service admission is required to use a replacement.

`OCC_RUNTIME_AUTHORITY_BINARY_PATH` selects the protected absolute validator and
listener binary. Its packaged default is `/usr/local/bin/oce-runtime-authority`.
This selection is independent of listener configuration, so an administrator
can admit the first service before its generated reference exists in a listener
configuration. Every profile validation compares the actual executable digest,
then invokes its pure `validate-profile` mode. That mode parses the selected
closed profile using the maintained SPIFFE parser; it opens no identity source,
listener or other network connection and grants no authority. Workload API socket
paths are limited to 103 bytes by the actual native Source implementation.

Set `OCC_RUNTIME_AUTHORITY_READBACK_CONFIG_PATH` to a protected absolute file to
start the listener. Omit it to run without this listener. The file contains one
compact, canonical JSON object with exactly these fields:

```json
{
  "schemaVersion": 1,
  "binaryPath": "/usr/local/bin/oce-runtime-authority",
  "listenAddress": "192.0.2.10:9443",
  "recipientRef": "occ/runtime-history",
  "serviceIdentityRef": "runtime-service/00000000-0000-4000-8000-000000000001"
}
```

Replace the illustrative address, recipient and service reference with the
actual admitted values. Generate the file with `JSON.stringify` without a
trailing newline; whitespace and alternate JSON encodings are rejected. The
binary path must equal the independently selected validator binary. The address
must be an explicit IP literal and positive TCP port. This configuration supplies
only the selected listener and existing service reference; it cannot supply a
profile, role, trust bundle or authority grant.

The binary and configuration must be regular files owned by root or the
controller user, without group or other write permission. Final symlinks are
rejected. Those stat and hash checks are sanity checks, not the production custody boundary.
In production the executable and its parent directories must be immutable to the
running controller: use a root-owned protected path or a read-only deployment
mount. Controller-owned generated binaries are appropriate only for local source
checks and fixtures. Protect the configuration and deployment mounts from
replacement as well; a file hash is not protection against a privileged writer
changing a path between verification and execution. This path supports local Linux process
and pipe custody; it is not a remote terminator protocol or a process-reattachment
mechanism. The controller starts the binary directly without a shell, inherited
credential environment, or client-selected arguments. Child stderr is discarded.

Use PostgreSQL persistence with at least two pool connections when source
admission or the listener is selected. The composed pool uses a 250 ms connection
checkout timeout. Startup reads the current source/service records anew and
checks the actual executable and native source before becoming ready. A selected
listener which cannot initialize fails startup. If its child later exits, the
controller's production readiness check becomes unavailable. Restoring a source
or record does not revive a retired process; restart the selected composition
against current records.

## Public TLS exchange

Open a fresh TLS 1.3 connection with mutual X.509-SVID authentication. The server
requires the profile's exact peer ID and the client must verify the exact admitted
server/recipient ID. No TLS session resumption is enabled. The independent service
does not borrow the target Agent's SVID.

Each connection carries one request and one bounded response. A frame has a
four-byte unsigned big-endian byte length followed by UTF-8 JSON; the public
payload limit is 65,536 bytes. Use compact canonical JSON with ordinary safe
integer spellings, no duplicate object keys, and depth at most 32. The request's
closed envelope is:

```text
{
  schemaVersion: 1,
  method: "readOperation",
  deadline: "<canonical UTC timestamp with milliseconds>",
  operation: <ExactAuthorityOperationV1>
}
```

`operation` is the existing closed exact-operation schema: Installation,
namespace and Agent IDs, operation UUID, operation kind, canonical payload digest
and request reference. Identity, role, cookies, authorization headers and peer
diagnostics are not fields of this envelope. The deadline can shorten the
server's original request deadline and cannot renew it. Extra plaintext, EOF,
cancellation or an invalid request closes the exchange. Clients must keep the
connection open while awaiting the response.

The response is the existing `AuthorityOperationStateV1`, framed on the same
original connection. Current service visibility and original-service attribution
apply to committed historical receipts even after later lifecycle changes.
Malformed, stale, unavailable, wrong-recipient or unauthenticated exchanges never
receive historical data. A connection failure is not permission to use a broader
scope or another service identity.

## Current checks and bounds

The controller never serializes a trusted context. Its factory creates opaque
process-local objects only from request events on the exact child it spawned.
Each authentication and asynchronous inspection performs a new challenge on
that child's original pipes, bound to its incarnation, configuration version,
profile digest, connection, exchange, request digest and original deadline.
Inspection checks the actual connection's current Source, both certificates,
trust bundle and recipient. The controller compares the full current registry
record before and after the native challenge. Historical reads perform their
existing before/after authority checks, followed by another fresh check before
returning the result. The child rechecks actual source/trust/connection/time
immediately before writing to the original TLS stream.

| Bound                                | Selected behavior                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap and ready delivery         | Three seconds, including incomplete bootstrap input and blocked ready output.                                                                          |
| TLS handshake                        | Three seconds.                                                                                                                                         |
| Original public request              | Three seconds from before the first frame byte; an independent monotonic timer remains armed through parsing, inspection and response.                 |
| Live source/certificate recheck      | One second, with additional checks before inspection and I/O.                                                                                          |
| Maximum authenticated connection age | Thirty seconds, additionally capped by certificate expiry and the one-request deadline.                                                                |
| Capacity                             | One active connection and one pending controller read; reconnect cannot replace work still cancelling.                                                 |
| Internal frame                       | 131,072 bytes, with a three-second timer from the first partial-frame byte.                                                                            |
| Blocked parent output                | Bounded write followed by channel shutdown; no unbounded message queue.                                                                                |
| Child shutdown                       | Invalidate contexts first, close owned streams, send TERM, escalate to KILL after 250 ms, and observe exit within three seconds or report unavailable. |

The actual PostgreSQL current/history reads accept cancellation and deadlines.
A checked-out client is destroyed on abort and query rejection is joined. A pool
checkout already in progress is joined through its configured timeout; Node's
PostgreSQL client has no public per-checkout cancellation API. The acceptor keeps
ownership of every started read until cleanup settles and rejects another ingress
while earlier work is still pending. `close()` joins this work and the actual
child exit. No detached worker or old positive result becomes an authority cache.

Source withdrawal, own-certificate rotation, a changed ordered trust-bundle
digest, certificate expiry, current source/service replacement or withdrawal,
process loss and connection closure invalidate the exchange. A removed trust
root is not retained as a fallback. Bundle rotation requires a new explicit
source/profile admission. CRL-bearing sources and federation are outside the
selected native profile; TLS session resumption remains disabled.

These are repeated local and durable-state checks, not atomic remote revocation
or a liveness guarantee. A registry or remote registration can change after its
latest observed check. Individual remote certificate revocation which does not
change available local evidence is not detected. Neither fixture success nor
the executable digest proves production SPIRE attestation, deployment mount
custody, clock quality or universal revocation latency. Bytes already transmitted
cannot be withdrawn. This readback path supplies no runtime effect guard or
positive active-runtime decision.

## Build and verification

The existing image build compiles both native commands from the same pinned Go
module and includes its dependency licenses. Source builds use:

```sh
go -C components/runtime-security build -mod=readonly -o ./bin/oce-runtime-authority ./cmd/oce-runtime-authority
chmod 0555 components/runtime-security/bin/oce-runtime-authority
go -C components/runtime-security test -race ./servicebridge ./cmd/oce-runtime-authority
go -C components/runtime-security vet ./servicebridge ./cmd/oce-runtime-authority
node --test tests/integration/runtime-authority-authenticated-readback.test.mjs
```

The native tests initialize actual Sources through a controlled local Workload
API and perform real mutual TLS and child-process I/O. The integration suite uses
the actual administrator session, current registry and PostgreSQL historical
operation reader. It also holds a real history-table lock to check cancellation,
non-disclosure and joined query cleanup. The test setup requires disposable local
sockets, the declared Go/Node toolchains and its isolated PostgreSQL fixture;
missing prerequisites are not replaced by simulated authorization. Production
image and deployment qualification remain separate from these local tests.
