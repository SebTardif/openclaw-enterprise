# Native GitHub HTTPS transport

Status: **library with controlled transport verification**. The
`oce-native-egress` Rust crate implements a finite HTTP/1 transport for native
repository access and broker-backed metadata and Git read mediation profiles. The native
admission path remains unavailable. The mediated path requires an actual
authenticated broker, original-work admission and committed credential release;
configuration cannot supply an allow. This crate provides no listener, image or
controller registration and does not by itself enable a deployment setting.

See [native client mechanics](native-git-client-mechanics.md) for the pinned Git
and gh command plans and [repository modes](../../specs/20-repository-access-modes.md)
for credential placement. The [platform design](../design.md) remains authoritative.

## Transport boundary

The intended selected deployment uses two TLS connections: client to a trusted
external native firewall, then firewall to the exact GitHub authority. The firewall
therefore transiently processes the native token and repository content in
plaintext. This needs an explicit deployment trust profile; it is not end-to-end
client-to-GitHub TLS. It does not withhold tokens from the native runtime or turn
native access into the optional mediated repository mode.

The library recognizes only `github.com` and `api.github.com`, requires exact
incoming SNI/HTTP Host correspondence, and uses maintained Hyper HTTP/1 parsing.
An admitted upstream socket must use its actual supplied IPv4 endpoint and rustls
server-name verification. Authorization is forwarded unchanged only after that
TLS connection verifies. The native path supplies no credential minting, injection, renewal, token cache,
body/header logging or automatic retry is supplied. Transient HTTP library
allocations are not a guarantee that every credential copy is explicitly erased.

Each connection supports one exchange. Connection reuse, CONNECT, Upgrade,
proxy authorization, unsupported transfer encodings and trailers are refused.
Redirect responses are neither followed nor forwarded. A response error is not
proof that an upstream mutation did not happen; exact remote readback remains
required. Byte limits bound streaming traffic without buffering an entire Git
pack. Exceeding a streaming limit can occur after an allowed receiver has received
request headers or partial body; it is not a zero-effect guarantee.

The caller must supply explicit header, request, response and exchange-time
budgets. They are not universal Git or GitHub limits. A current admission/DNS
deadline further bounds the exchange. Deadline and ordinary peer completion close
the owned upstream driver and join its cancellation. Dropping an unfinished
serve future aborts retained drivers; a caller that needs observed settlement
must let the bounded serve operation return.

## Implemented route subset

Repository and commit configuration is syntactically checked retained input; it
does not grant authority.

| Authority        | Methods and paths                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.com`     | GET exact `/{owner}/{repo}.git/info/refs` with `service=git-upload-pack` or `service=git-receive-pack`; POST exact `git-upload-pack` or `git-receive-pack` path with no query.    |
| `api.github.com` | GET exact `/repos/{owner}/{repo}`, its `/commits/{selected-commit}`, or `/issues` and `/pulls` with exact `state=open&per_page=20` query; POST `/graphql` without a query string. |

The current native command plan is a compatibility matrix: G04/G05 are local Git
operations and G07–G11 use GraphQL. A GraphQL request must have a bounded,
duplicate-free JSON object with a nonempty `query` string, optional object/null
`variables`, and optional string/null `operationName`; batches, extra envelope
keys and compressed requests are refused before an origin connection. The
JSON decoder checks a 20,000-value and depth-64 ceiling before deserializing each
value. Containers count as values, keys do not, and the root has depth zero.
The byte budget also bounds individual strings. These limits prevent small
wire bodies from creating an unbounded JSON tree; they do not define permitted
GraphQL operations. The original validated bytes are forwarded once. GraphQL field, variable and branch
selection are not a per-command authorization policy. The current delivered
token and common provider permissions remain the scope boundary.

Repository scope, branch restrictions, broader/personal-token substitution
denial, token expiry and upstream revocation retain their original credential and
repository-policy owners. This library does not establish them from a hostname,
token string, fingerprint or caller-supplied descriptor. It makes no per-command
human-attribution or general content-exfiltration guarantee.

## Missing production suppliers

The normal build cannot construct positive native admission. Current original
assignment and recorded native-delivery/presented-token authority must join the
qualified DNS and attachment observations before that changes. The existing
credential inventory's unavailable delivery path remains unchanged.

The separate `dns` module resolves only the two fixed, fully qualified origins
through explicitly supplied IPv4 UDP/TCP resolver endpoints. It preserves and
validates the returned CNAME chain and full A set, checks exact configured aliases
and deployment-denied ranges, and applies the shortest record/configured
lifetime. It uses Hickory’s resolver transport directly so the protected recursive
resolver’s complete answer is validated before any convenience lookup can filter
or merge it. Incomplete CNAME-only responses are refused. Empty, cyclic,
unrelated, malformed, nonpublic or mixed-address answers are refused before any origin connection. Alias validation follows protected
resolution; it is not a pre-query recursive-alias authorization gate. Resolution
data alone cannot construct an admission permit.

Actual protected resolver provenance, split DNS serving, independently installed
node/Pod fences, native TLS trust delivery and authenticated service correspondence
remain separate deployment work. A DNS answer projection or desired
NetworkPolicy is not effective enforcement. The external model adapter retains
its separate fixed provider and credential semantics.

## Broker-backed metadata mediation

`mediated::Mediator::new` selects the metadata construction and request path. It accepts only
an empty-body `GET /repos/{owner}/{repo}` for its exact configured repository at
`api.github.com`. It rejects caller Authorization, Proxy-Authorization and Cookie,
queries, absolute URIs, bodies, trailers, upgrades and ambiguous framing. It
constructs a new request with fixed Host, Accept, Accept-Encoding, User-Agent and
Connection headers; arbitrary client headers are never forwarded. Before Hyper
normalizes framing, a bounded original header block is checked with `httparse`.
Duplicate header names and combined Transfer-Encoding/Content-Length refuse;
the same retained bytes then enter Hyper on the original TLS connection.

The trusted listener calls `Mediator::serve(socket, attachment_ref)`. The locator
comes from the protected listener's original attachment, never an HTTP header.
The broker must independently associate its authenticated injector connection and
that attachment with immutable original Work and current repository authority.
Neither the locator, peer UID, configured trust nor a successful TLS connection
is a repository grant.

Construction requires the repository, incoming TLS configuration, GitHub TLS
trust, `BrokerConfig`, explicit `Limits`, and a concurrency limit of 1–1024.
Metadata response buffering is limited to at most 16 MiB per exchange. The broker
configuration requires:

- An absolute protected Unix socket path and expected service UID. Its socket
  and immediate directory must be owned by that UID with no group/world access.
  All ancestors must be non-symlink directories without group/world write and
  owned by the service or one of at most eight explicitly trusted ancestor UIDs.
  This supports explicit namespace UID mapping; it does not infer trusted owners.
- Actual mutual-TLS client identity and an exact broker peer verifier supplied
  by the selected identity owner. A DNS `ServerName` alone does not verify a
  SPIFFE URI identity. The client identity resolver must contain credentials;
  early data is disabled and ALPN must be `oce-github-mediation-v2`.
- Finite call timeout and check interval, each at most 30 seconds, plus an
  explicit clock allowance of at most 30 seconds. These are configuration caps,
  not measured revocation or availability guarantees.

The request owns one persistent confidential broker connection. It never
reconnects, resumes, multiplexes or retries a release. Length-prefixed frames
contain at most 16 KiB of closed, duplicate-free JSON and at most 16 KiB of raw
credential bytes. Only a successful one-use dispatch reply may carry a token;
the token never enters JSON or a diagnostic value.

The broker first admits the exact canonical request and supplies an original
work correspondence hash, effect reference, DNS binding and public IPv4 address.
The mediator connects only to port 443 and verifies the actual `api.github.com`
TLS peer before requesting dispatch. It binds the reply to the original session,
request digest, work hash, DNS address and SHA-256 of the verified peer leaf
certificate. The original operation horizon cannot change. Positive intervals
are anchored at RPC start, reduced by the configured clock allowance and bounded
by the preceding lease while the call is pending. Wall-clock/monotonic-clock
divergence beyond the allowance refuses further use.

The actual DS `substitute_authorization` implementation constructs the protected
Bearer header immediately before the sole upstream submission. Its legacy
registry, `NoSwap` path, grant cache and file-key issuer are not used. A watchdog
checks the same original broker session independently of response polling and
downstream backpressure. EOF, malformed/replayed replies, changed bindings,
authority loss and deadlines cancel the exchange. Normal exits abort and join
the watchdog and upstream HTTP driver before requesting a terminal receipt.
After a possible release or submission, interruption is reported as `unknown`;
there is no automatic replay. Dropping the serve future aborts retained drivers;
observed settlement requires letting its bounded execution return.

Only a complete HTTP 200 JSON response can produce a successful downstream body.
The mediator returns a validated projection of `id`, `name`, `full_name`, `private`
and `default_branch`; names must match the configured repository. It drops all
upstream headers, rejects unsupported encodings, and checks decoded strings for
credential echoes, including JSON escaping and chunk boundaries. All other
responses use a fixed local error body. This is a metadata checkpoint, not full
`gh api` response compatibility or a claim to detect every transformation of a
maliciously encoded secret. Git fetch, GraphQL and write operations are not
admitted by this path.

Raw secret frames and DS substitution buffers are zeroized on drop. The
Authorization header uses a sensitive `HeaderValue` backed by the DS-owned
zeroizing allocation. The response buffer reserves its configured cap before
reading and never reallocates after receiving bytes. Decoded strings and keys
owned by the JSON visitor are erased on successful-response release and parse
errors, including partially built containers. Maintained HTTP/TLS codecs and
parser-internal unescape scratch can create additional allocations; their active
ownership is bounded, but residual allocator bytes and complete process-memory
erasure are not controlled by this interface. Provider tokens never become a
returned value or runtime credential in this interface.

An absent broker or missing genuine identity, protected attachment, current
authority, inventory/custody or committed-release supplier remains a denial.
Production use additionally requires the selected accepting-service composition,
current identity source, DNS owner, protected deployment routing and enforced
gVisor network isolation. Transport mechanics do not establish these suppliers.

## Broker-backed Git clone and fetch

`mediated::Mediator::new_git_read` explicitly selects Git read mediation through
the same TLS, broker-session, DS substitution, once-send and watchdog engine.
It requires the original `github-git-read-rpc-v3` operation policy,
`owned-child-stdio-github-git-read-v3` transport profile, wire version 3 and
`oce-github-git-read-v3` broker ALPN. Metadata version 2 and its ALPN cannot be
used for a Git session. Each HTTP request retains its own original effect and
one-use release; discovery and later upload-pack rounds do not extend the
original Work horizon. The authentic owner must admit the exact repository with
`contents:read` and `metadata:read` permissions.

Only these requests at verified `github.com:443` are accepted:

| Operation   | Method | Exact target                                            | Outgoing Content-Type                   |
| ----------- | ------ | ------------------------------------------------------- | --------------------------------------- |
| Discovery   | GET    | `/{owner}/{repo}.git/info/refs?service=git-upload-pack` | absent                                  |
| Upload-pack | POST   | `/{owner}/{repo}.git/git-upload-pack`                   | `application/x-git-upload-pack-request` |

The incoming Git-Protocol must be exactly `version=2`. The mediator rebuilds
Host, the operation-specific Accept, `Accept-Encoding: identity`,
`Git-Protocol: version=2`, `User-Agent: oce-github-git-read`, and
`Connection: close`. Caller credentials, cookies, absolute URIs, other
repositories, queries beyond the exact discovery query, alternate encodings,
trailers and unsupported framing refuse before broker admission.

Discovery has no body. Upload-pack is completely acquired before admission,
with a maximum of 4 MiB and a smaller deployment limit if configured. Ordinary
Git may compress larger upload-pack requests: absent Content-Encoding or exact
`gzip` is supported. Compressed input and decoded output are separately bounded.
Gzip must contain one complete integrity-checked member without a second member
or trailing bytes. After complete packet validation, the mediator removes only
the `thin-pack` fetch argument, preserving every other packet byte and its order.
This requests a self-contained pack. It hashes and retains that final normalized
body, then submits those exact bytes uncompressed with the matching Content-Length
and no Content-Encoding. No normalization or mutable caller body source remains
after broker open.

The closed packet parser accepts protocol-v2 `ls-refs` and ordinary full SHA-1
`fetch`, including negotiation rounds, `want-ref`, and sideband framing. It
refuses receive-pack, shallow/deepen requests, partial-clone filters, server
options, alternate pack/bundle locations and unsupported commands. LFS,
submodule repositories and other hosts have no route in this profile. Local
repository config and client arguments cannot broaden the original admitted
repository or these request paths.

The committed token becomes only `Authorization: Basic` with the Base64 encoding
of `x-access-token:` followed by that token. The raw token, encoding input,
encoded credential and DS substituted header have zeroizing owners. No provider
credential enters client arguments, environment, Git configuration or URLs.
Maintained HTTP/TLS internal copies retain the memory limitations described for
metadata mediation above.

Git responses are fully buffered before downstream output, at most 64 MiB per
HTTP exchange and less when configured. Only HTTP 200, the exact discovery or
upload-pack response content type, and valid selected Git framing pass. The
mediator drops upstream headers and refuses informational responses, redirects,
errors, trailers, unsupported encodings and alternate-location sections. Linear
credential matching checks both raw bytes and reassembled packet payloads,
including independently interleaved pack and progress channels, against the raw
and Basic credential. Before releasing a pack, the mediator verifies its checksum and zlib
stream completion, reconstructs full objects and internal offset/reference
deltas, and scans every reconstructed object for both credential spellings.
Missing, external or cyclic delta bases and duplicate object IDs refuse. Successful
packet bytes are preserved without rewriting pack contents.

Pack validation has these additional hard limits:

| Resource                               | Maximum |
| -------------------------------------- | ------- |
| Objects in one pack                    | 100,000 |
| Inflated entry or reconstructed object | 16 MiB  |
| Sum of inflated entries                | 64 MiB  |
| Sum of reconstructed objects           | 64 MiB  |
| Delta chain depth                      | 64      |
| Dependency resolution passes           | 65      |

Sizes and aggregate budgets are checked before their corresponding allocation;
delta copies must remain within the actual base and result. A separate worker
performs bounded decoding and inspection so broker supervision continues to
poll. Cancellation signals that worker and joins it before terminal settlement;
ordinary task abort alone cannot stop a running blocking worker. Owned input,
instruction, reconstructed-object and credential-copy buffers are zeroized.
Maintained compression and cryptographic internals retain the memory limitations
stated above. Git still validates repository semantics, detailed negotiation and
correspondence to its requested refs and objects. This profile exposes authorized
repository content and history; it does not isolate history or detect every
arbitrary transformation of a maliciously encoded secret.

Missing authentic broker, original authority, selected identity, custody or
current deployment suppliers still refuse. This library profile alone does not
register or qualify those producers. Trusted publication and GraphQL require
separate operation implementations.

## Verification

After explicit dependency preparation, use the pinned Rust toolchain and existing
locked cache:

```sh
cargo +1.95.0 test --manifest-path dataplane/Cargo.toml --locked --offline -p oce-native-egress
cargo +1.95.0 check --manifest-path dataplane/Cargo.toml --locked --offline -p oce-native-egress --all-targets
```

Unit fixtures exercise actual loopback TLS/HTTP connections, healthy receiver
controls, unchanged synthetic Authorization, wrong upstream certificate, denied
authority/route/proxy behavior, redirect refusal, bounded GraphQL envelopes,
pre-allocation JSON value/depth rejection, partial-request expiry and a shorter
request permit during response streaming.
DNS fixtures use controlled UDP/TCP sockets and synthetic response data; they
do not dial the returned public-looking addresses.
Positive fixture admission exists only in `cfg(test)` code, with loopback-only
endpoints. No public feature enables it in a normal build.

Mediation fixtures call the actual `Mediator::serve` path with a substituted broker
and provider. They use a protected Unix socket, mandatory client-certificate TLS,
and real incoming/upstream HTTPS connections. They check the canonical digest,
single credential replacement, exact session/work/DNS/certificate correspondence,
credential and route refusal, frame bounds, partial/lost replies, expiration,
safe response projection and owned socket shutdown during broker loss. Escaped
and chunk-split credential canaries never reach the downstream response. The
secret-buffer observer checks erasure before allocation release. These are
transport mechanics tests; their substituted broker cannot establish genuine
OCC authorization, inventory, custody, release persistence or deployed identity.
On hosts whose default temporary directory is writable by other users, fixtures
create a private child beneath `HOME`; `OCE_MEDIATION_TEST_SCRATCH` can select a
different existing protected parent. Test setup does not relax production path
ownership checks.

The explicitly selected native test requires the prepared artifact manifest
described in [native client mechanics](native-git-client-mechanics.md). It
rechecks hashes and versions of Git 2.55.0, gh 2.93.0 and the Git HTTP helpers:

```sh
OCE_NATIVE_FIREWALL_TOOLS=/absolute/prepared-tools.json \
OCE_NATIVE_FIREWALL_SCRATCH=/absolute/private-scratch \
cargo +1.95.0 test --manifest-path dataplane/Cargo.toml --locked --offline \
  -p oce-native-egress -- --include-ignored --test-threads=1
```

The test uses generated private fixture trust, a real local Git object graph,
Git's actual HTTP backend, the new firewall, and pinned Git/gh subprocesses. A
test-only loopback CONNECT router preserves ordinary GitHub client URLs while
always dialing the fixed local firewall. It is not a shipped proxy or proof of
the selected split-DNS/node-fence deployment. Scratch retains only the newly owned
synthetic graph and public fixture CA as local evidence. Tests do not contact
GitHub, issue real tokens or establish production current authority, permissions,
revocation, Kubernetes/gVisor containment or deployment readiness.

The separately selected mediated Git fixture uses the same pinned Git and helper
manifest. It clones the first commit through real TLS, updates the trusted local
backend, fetches the second commit, checks out its full hash and verifies the
file. An actual push and malformed/write/credential requests must fail without
broker or provider submission. Its broker and GitHub peers are explicitly
substituted; this proves transport and native-client mechanics, not original
OCC authority or external GitHub qualification. Git packet and request-preparation
tests separately exercise closed framing, digest vectors, gzip integrity and
bounds, and credentials split across packet or sideband boundaries.
A controlled TLS/UDS fixture pauses the blocking validator after a real delta
copy, expires its broker lease, and checks that cancellation drains the worker
before terminal settlement, with no response bytes reaching the caller. Its
synchronization exists only in test builds.
