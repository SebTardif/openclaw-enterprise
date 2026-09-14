# Native identity and service peers

Use `components/runtime-security/identity` to acquire credentials from a protected
local Workload API, then `servicepeer` to authenticate an exact remote service on
an owned TLS connection. The repository-read mediation owner must supply its admitted profile and own
the source and transport lifetimes. These packages do not change the default
Agent authentication profile.

## Credential source

Construct a `Source` with an absolute, clean Unix socket path, an exact canonical
SPIFFE workload ID with a nonempty path, and a timeout from one to sixty seconds
(default ten). The socket must already exist and cannot be a symlink. The caller
must protect the socket and its containing directory from workload replacement;
the library does not establish socket ownership or attestation policy.

`Start(ctx)` waits for a complete matching X.509-SVID generation. The first
startup context controls the source's lifetime after readiness. The source
validates raw identities, keys, certificates and bundles with maintained SPIFFE
parsers, rejects duplicate identities and conflicting envelopes, and selects the
configured identity independently of provider hints. Response size and collection
limits apply before SDK selection can hide malformed entries.

`Metadata`, `TrustView` and `Snapshot` require a currently live source.
`TrustView` exposes a key-free, coherent generation summary and an ordered
own-domain bundle digest. `Snapshot` returns independent DER copies, including
the private key, own-domain trust bundle and CRLs. Clear key copies after use and keep
all credential buffers out of logs; JSON exclusion alone cannot protect other
logging formats. Returned metadata is historical immediately after return and
cannot prove continuing authentication or authority.

Watch loss, invalid replacement, startup timeout, lifetime cancellation and
certificate expiry permanently invalidate the source. There is no retained
credential fallback or automatic reconnect. Recovery creates a new source at
the protected socket. `Close` cancels outstanding operations and joins the watch
goroutine; the source cannot be restarted.

## Exact service transport

Construct a `Transport` from a ready source and explicit own, peer and recipient
SPIFFE IDs. Both identities must belong to the same selected trust domain. On
the client, the recipient is the peer; on the server, it is the own identity.
Choose a positive handshake timeout of at most three seconds, a source recheck
interval of at most five seconds, a positive maximum connection age, and a
connection limit from one to sixty-four including pending handshakes.

`Handshake(ctx, raw)` takes ownership of `raw` on both success and failure. It
uses TLS 1.3, requires mutual certificates, checks exact SPIFFE identity and chain
trust, and enforces the leaf key-usage profile. If `ApplicationProtocol` is set,
it must contain one to 255 visible ASCII bytes and match the negotiated ALPN
exactly. Session resumption is disabled so each connection authenticates afresh.

`Inspect`, `Read` and `Write` check the live source and current trust before use.
An owned watcher also closes idle or blocked connections on cancellation,
expiry, source loss, certificate replacement or changed peer trust. Withdrawal
between checks is bounded by the selected recheck interval; an inspection does
not reserve authority for a later application operation. Own-certificate renewal
closes existing connections; new handshakes use the replacement generation.

`Connection.Close` closes the underlying transport and joins its watcher.
`Transport.Close` joins its handshakes and watchers while leaving the borrowed
source open. Close transports before closing their source. Only the original
transport and connection pointers are usable; copied handles cannot acquire or
release ownership.

## Security and integration limits

The transport uses the own-domain bundle and rejects CRL-bearing sources.
Federated trust is not used for peer authentication. There is no application
revocation registry or monotonic trust-policy ledger. The source parser's
acceptance alone does not authenticate a remote peer; the TLS transport also
verifies the acquired own chain and the remote peer's proof of key possession.

An SVID, trust digest or diagnostic `Peer` value grants no service role,
represented-Agent identity, enrollment, current execution authority, repository
access or resource permission. Those require separately admitted context and
online OCC authorization. These libraries do not prove gVisor containment,
SPIRE attestation, provider-token isolation, or physical workload termination.

## Verification and troubleshooting

Follow the [native identity tests](../testing/native-identity.md) for local setup,
coverage and failure interpretation. Errors expose fixed diagnostic codes and
exclude provider errors, endpoints, certificates and key material. Transport I/O
errors retain network timeout/temporary classifications and only detail-free
deadline or closed-connection sentinels. Reads preserve `io.EOF` and
`io.ErrUnexpectedEOF` directly. Inspect code and protected configuration without
logging credentials.

Repository-read startup must retain its separately admitted execution, stable
Agent ServicePrincipal, and exact IAM operation. See the
[workload identity setup](../guides/agent-workload-identity.md) for the selected
Kubernetes/gVisor/SPIRE topology and its activation requirements.
