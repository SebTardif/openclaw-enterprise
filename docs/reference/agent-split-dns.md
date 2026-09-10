# Agent split DNS

Dream Serpent's `oce-dnsgate` executable includes a bounded IPv4 DNS listener for
Agent traffic. It uses the existing Dream Serpent DNS parser, response encoder,
and TCP serving machinery. The same selected handler serves UDP and TCP.

## Current support

The listener and response mechanics are implemented. **Positive production
routing is unavailable:** the original authenticated attachment, current work
context, and assigned Dream Serpent endpoint producer has not been connected.
Selected requests therefore receive `SERVFAIL`. No configuration option,
source-IP map, Pod name, DNS extension, or JSON receipt can enable a positive
answer. Tests that inject private response-mechanism inputs do not establish
this missing authority or qualify a gVisor deployment.

The existing model admission RPC remains available with its existing options.
The split-DNS listener is a separate selected mode of the same executable:

```sh
oce-dnsgate --split-dns-listen 127.0.0.1:1053
```

This mode binds the exact IPv4 address on both UDP and TCP. Wildcard, multicast,
and broadcast binds are refused. Port zero is useful for local library tests;
an installed listener needs an exact selected port. SIGINT or SIGTERM stops both
transports and closes active clients through the bounded shutdown path. A timeout
reports incomplete cleanup; it does not certify that every socket has already
been released when the error returns.

The command does not install a network fence, alter the cluster, register an
attachment, acquire provider credentials, or enable upstream Internet access.

## DNS behavior

| Input                                                             | Behavior                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `github.com`, `api.github.com`, `api.openai.com`                  | Exact, case-insensitive name selection; no wildcard or search-suffix match                                 |
| Selected A query with a current original route                    | One assigned Dream Serpent IPv4 address, TTL zero                                                          |
| Selected AAAA, HTTPS, or SVCB query with a current original route | `NOERROR` with no records; no IPv6, ECH, or QUIC steering                                                  |
| Missing, expired, withdrawn, or mismatched route source           | `SERVFAIL`, no records                                                                                     |
| Other name, record type, or query class                           | `REFUSED`, no records                                                                                      |
| Unsupported opcode                                                | `NOTIMP`, no records                                                                                       |
| Unsupported EDNS version                                          | `BADVERS`, no records                                                                                      |
| Packet already marked as a DNS response                           | UDP drop or TCP close; no reflected error response                                                         |
| Malformed query shape or trailing data                            | `FORMERR` when a request can be decoded; undecodable packets are dropped or their TCP connection is closed |

The grammar requires one IN question, query message type, no unsolicited answer
or authority records, and no additional records except a supported empty EDNS0
OPT. The parser validates compression and complete input consumption. The
listener does not forward unknown names. It authors fresh EDNS responses without
copying caller options. Raw OPT option headers and lengths are checked before
accepting empty EDNS: malformed option framing returns `FORMERR`, while
well-formed unsupported options return `REFUSED`.

The selected transport admits at most 32 active UDP requests and 32 TCP clients.
Messages and responses are bounded to 4096 bytes, complete TCP frame reads and
request/response exchanges have one-second deadlines, and the route-source
observation has a 200-millisecond deadline. Shutdown cancels remaining selected
requests. The listener holds no kernel mutations or operation reservations.

## Required original producer

Connecting a positive source requires the original protected listener or node
owner to retain the incoming attachment. It must join the actual CNI network
namespace and reciprocal veth custody to the original CRI sandbox/attempt, Pod
UID, node identity/boot, create effect, and canonical assignment. The same
retained owner must provide the current work context and assigned authenticated
Dream Serpent endpoint/service incarnation, with withdrawal and expiry checks
on every query. The listener must be uniquely scoped to that retained incoming
attachment; a listener address alone does not establish the association.

A copied serialized fence observation, root Unix peer credentials, or a source
IP can locate evidence but cannot supply the complete association. Service mTLS
authenticates its service peer; it does not authenticate a guest DNS packet.
This implementation deliberately has no public positive-route constructor
while those actual producer joins remain unavailable.

The split answer identifies the **trusted proxy endpoint** outside the Agent.
It is distinct from the public GitHub address returned by the proxy's independent
upstream resolver. The existing `LiveReResolver` continues using explicitly
configured upstream DNS servers; it does not read the split listener or its
answers. Installations must keep those resolver addresses separate.

DNS steering grants no GitHub operation authority. The proxy must still use
current online OCC authorization for the exact operation, keep provider tokens
outside Agent execution, and deny a stale work context. Context or permission
changes require a fresh Pod/sandbox. TTL zero and per-query revalidation prevent
the DNS server from reusing a stale answer; the attachment fence and proxy
currentness checks must also deny traffic using previously received addresses
and existing connections.

## Verification and limits

The local tests exercise real UDP/TCP sockets, the real DNS parser and encoder,
selected-name response mechanics, record suppression, TTL zero, binding mismatch,
withdrawal, expiry, source timeout, malformed input, transport limits, and finite
shutdown. An explicit external recursive-DNS double verifies that the actual
Dream Serpent upstream resolver obtains its public answer independently of the
split answer.

```sh
cd dataplane
cargo test --locked -p ds-dnsgate --lib split_dns
cargo test --locked -p ds-dnsgate --lib selected_transport
cargo test --locked -p ds-dnsgate --test oce_adapter
cargo test --locked -p ds-dnsgate --test framework_validation
```

These tests establish neither a positive authenticated attachment nor current
OCC authority, CNI packet traversal, gVisor caller identity, before-start ordering,
or provider credentials. Those require the actual composed producers and the
selected runtime qualification. A working loopback DNS response is not a passing
GitHub proxy integration.
