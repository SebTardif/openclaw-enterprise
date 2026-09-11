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

The separate [broker-backed mediation profiles](native-github-egress/mediation.md)
define metadata reads and Git clone/fetch, including authenticated broker setup,
one-use credential release, response inspection and interruption handling.

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
