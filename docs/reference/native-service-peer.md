# Native service peer transport

The Go package `components/runtime-security/servicepeer` authenticates an exact
X.509-SVID peer on an actual in-process TLS connection. It borrows an initialized
[SPIFFE Workload API source](workload-identity.md), uses the pinned Go SPIFFE
library for certificate verification, and owns the connections it authenticates.
It implements neither service roles nor runtime authorization. There is no
controller route, command, cross-process identity forwarding, enrollment service,
or configuration default installed by this package.

## Configuration and use

Construct `servicepeer.New(source, config)` with a caller-owned, already-started
`*identity.Source`. Every configuration field is explicit:

| Field               | Meaning                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Side`              | `servicepeer.Client` or `servicepeer.Server`.                                                                                               |
| `OwnSPIFFEID`       | Exact identity expected from the borrowed local source.                                                                                     |
| `PeerSPIFFEID`      | Exact remote identity required by the TLS verifier.                                                                                         |
| `RecipientSPIFFEID` | Server identity: equal to the peer ID on the client and own ID on the server. It does not grant an application operation or select a route. |
| `HandshakeTimeout`  | Positive timeout, at most three seconds. A shorter caller deadline prevails.                                                                |
| `RecheckInterval`   | Positive interval, at most five seconds, for background source and certificate checks.                                                      |
| `MaxConnectionAge`  | Positive finite connection lifetime selected by the caller's admitted policy. There is no default.                                          |
| `MaxConnections`    | Maximum concurrent owned connections, including incomplete handshakes, from one through 64.                                                 |

Only exact identities in one selected trust domain are supported. Federation is
not selected from extra source bundles. Sources carrying certificate revocation
lists are rejected because this component does not implement CRL validation.
The caller must admit the identity, trust source, recipient, endpoint and numeric
policy; syntactically valid configuration is not evidence of that admission.

The transport uses TLS 1.3 with mutual X.509-SVID authentication. Session tickets
and client session caching are disabled; a resumed handshake is rejected. Every
accepted connection therefore performs a fresh certificate handshake. Peer
certificate collections are additionally limited to 64 entries and four MiB.
The standard TLS implementation also applies its own handshake bounds.

Alongside the maintained trust and identity verifier, the component checks the
local and remote leaf certificate's key usages against the
[X.509-SVID profile](https://spiffe.io/docs/latest/spiffe-specs/x509-svid/):
the key-usage extension must be critical and include digital signature usage.
If an extended-key-usage extension is present, it must include both client and
server authentication. An absent extended-key-usage extension is permitted.

```go
transport, err := servicepeer.New(source, servicepeer.Config{
    Side:              servicepeer.Client,
    OwnSPIFFEID:       ownID,
    PeerSPIFFEID:      serverID,
    RecipientSPIFFEID: serverID,
    HandshakeTimeout:  handshakeTimeout,
    RecheckInterval:   recheckInterval,
    MaxConnectionAge:  connectionLifetime,
    MaxConnections:    connectionLimit,
})
if err != nil {
    return err
}
defer transport.Close()

raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", operatorSelectedAddress)
if err != nil {
    return err
}
connection, err := transport.Handshake(ctx, raw)
if err != nil {
    return err // Handshake already closed the owned raw connection.
}
defer connection.Close()
```

The example's source, IDs, address and durations must be supplied by the trusted
caller. The package performs no environment discovery or endpoint lookup. A
server passes an accepted `net.Conn` to its server-side transport. `Handshake`
takes ownership of that raw connection on both success and failure. The caller's
context governs the returned connection's entire lifetime, so do not cancel it
after the handshake unless the connection should close.

`Connection` implements `net.Conn`. Its TLS transport and ownership fields remain
private; copying the exported struct does not produce another usable handle.
`Inspect()` checks the locally owned connection state and returns diagnostic peer IDs,
authentication/expiry times and a certificate fingerprint. That diagnostic value
cannot be used as a connection, service identity proof or permission. The TLS
connection remains in the same process; nothing serializes or forwards it.

## Current source checks and closure

Before each read, write and inspection, and on the configured background
interval, the component obtains a fresh source snapshot, checks the exact own
identity, verifies its certificate against current trust, compares the own
handshake certificate, and verifies the remote handshake certificates again
against current trust and time. Source failure, unsupported material, removed
trust, expired certificates or a changed own certificate denies further use and
closes the owned raw connection. Own certificate rotation deliberately requires
a new connection; it does not silently refresh the identity of an old one.

The connection lifetime is bounded by the configured maximum and presented own
and peer certificate expiry. Caller cancellation, explicit closure and lifetime
expiry also close it. Closing the raw connection interrupts blocked TLS I/O
without waiting for the peer to exchange a close notification. `Connection.Close`
joins its monitor, and `Transport.Close` closes and joins all of its owned
connections and in-flight handshakes. Neither closes the borrowed identity source.

The source has no exported withdrawal subscription. Background detection is
therefore bounded polling, subject to scheduling and local processing; this is
not a measured revocation-latency guarantee. Source updates and connection use
are not a single atomic operation. A fresh read cannot prevent a later external
policy change or undo bytes already transmitted.

An unchanged peer certificate remains usable only while the current trust and
time checks accept it. This package cannot detect remote registration removal,
remote source failure, service-role withdrawal or individual certificate
revocation that has not changed its locally available evidence. It supplies no
monotonic trust-bundle ledger, authenticated profile registry, application grant
evaluation or active runtime selection. Those remain separate current-authority
and effect-guard responsibilities. See the
[runtime authority interface](runtime-authority.md).

An unobserved remote socket close is detected through connection I/O; inspection
is not a remote liveness probe. The package runs no competing background reader
that could consume application bytes.

## Verification and troubleshooting

With the repository's declared Go toolchain and matching modules already
available, run:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go -C components/runtime-security test ./servicepeer -count=1
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go -C components/runtime-security test -race ./servicepeer -count=1
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go -C components/runtime-security vet ./servicepeer
```

Component tests initialize the real identity source through a controlled local
Workload API endpoint and execute actual TLS handshakes with generated test
certificates. They exercise certificate verification and connection lifetime;
they do not prove production SPIRE attestation, service enrollment, trusted
socket custody, a protected controller handoff, runtime grants or live deployment
revocation. A missing production profile is not replaced by a successful test.

Configuration, source and handshake failures expose fixed error codes without
certificate material, private keys or provider exception text. Correct the exact
configuration or restore the owning source; do not switch identities, trust
domains or authentication modes as a fallback. A retired source must be replaced
by its owner according to the source lifecycle. A closed connection cannot be
reopened; obtain a new connection and perform a new handshake.

## Controller historical-read consumer

The separate [authenticated runtime operation readback](runtime-service-transport.md)
consumer now owns a dedicated native child, original parent pipes and one-request
TLS exchanges. It uses this package's actual connection inspections together
with the controller's current protected service registry. That consumer does not
turn the `Peer` diagnostic struct into a transferable proof, and it leaves this
package's borrowed-source API and runtime-authorization limits unchanged.
