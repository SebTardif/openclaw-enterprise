# Native GitHub mediation bridge

This package implements the native accepting half of `github-metadata-rpc-v2`
and explicitly selected `github-git-read-rpc-v3`.
It owns an actual filesystem Unix listener, an `identity.Source` reading the
selected Workload API, and maintained `servicepeer.Transport` connections. The
parent remains responsible for exact service registration, original protected
attachment/Work correspondence, current purpose and repository authorization,
recorded credential custody, and committed release. The bridge never creates
those authorizations from wire fields.

`Run(context, input, output)` receives its configuration exclusively through the
spawning parent's owned pipes. `oce-github-mediation serve` adopts only inherited
pipe/socket descriptors for stdin/stdout; stderr carries no operational payload.
`validate-profile` consumes one private frame containing the exact profile and
zero secret, followed by EOF. It returns one private frame containing
`{"version":1,"result":"valid"}` or `{"version":1,"result":"invalid"}`. Validation
opens no source or listener; exit zero means only a valid profile representation.

## Framing and ownership

All frames use `metadata_length:u32be | secret_length:u32be | metadata | secret`.
External DS metadata is bounded at 16384 bytes. Private pipe metadata has a 32768
byte cap to carry base64 of the original external metadata without truncation.
Both secret suffixes are bounded at 16384 bytes. Metadata rejects duplicate keys,
invalid UTF-8, excessive depth, noncanonical integers and unsupported closed
shapes. Only a successful `dispatch-once` reply may carry a visible-ASCII token
suffix. Secrets are neither JSON nor base64 nor Go string values. Owned suffix
buffers are cleared after write, rejection, partial input and abandoned queued
reply. This does not assert erasure of every Go TLS/kernel/library copy.

The exact closed private `Control` shape is exported in `protocol.go`. Every
field is present. Parent and native sequences each independently begin at one:
`bootstrap` command one and `ready` event one. Bootstrap has empty correspondence
fields, `deadline_ms:0`, and `metadata_base64` containing the `Profile` JSON.
Ready has empty payload and correspondence. All subsequent commands increment
that incarnation's original sequence, including cleanup commands.

Each actual TLS session receives one random `connection_id`; each request gets a
new random `exchange_id`, exact metadata `request_sha256`, and bounded native
`deadline_ms`. The outer digest covers the original DS metadata bytes, distinct
from the DS request's embedded upstream-request digest. `request` events carry
those exact bytes as base64. `inspect` commands echo all correspondence and a
fresh challenge; `inspection` returns the same challenge and base64 of the closed
`Inspection` observation. Inspection never carries a secret. Only the original
parent, holding the actual child/pipes and private context, may use this result.

`reply` commands echo the same correspondence, empty challenge, and base64 DS
reply metadata, plus the optional raw secret suffix. After the actual TLS frame
write completes, `written` echoes the same correspondence with empty challenge
and payload. It acknowledges socket submission only. It proves neither DS
consumption, upstream dispatch, effect completion nor safe retry. A failure or
partial write emits no `written`; ambiguity remains with the original owner.

`closed` identifies the retired connection; exchange/digest/challenge/payload are
empty and deadline is zero. It does not stop the process's listener. The cleanup
command `close-session` uses the exact connection ID, all other correspondence
and payload empty, deadline zero and no secret. It may cancel that original
session after a request expires; up to 64 retired IDs permit harmless delayed
cleanup. A separate bounded set of 64 exact retired exchange tuples retains the
original connection/exchange/digest/deadline. An already-issued inspection for
such a tuple returns only `valid:false`; an already-issued reply is ignored and
its raw suffix cleared, without a `written` event. Unknown or mismatched tuples
still reject. A stale cleanup cannot close a successor connection. `shutdown` has all
correspondence empty and closes the whole native owner and listener.

## Selected transport and deadlines

The profile pins the Workload API path, exact own and peer SPIFFE identities,
broker recipient, bundle digest, socket path, DS UID, up to eight trusted ancestor
UIDs, and explicit handshake/recheck/connection/request limits. Native requires
TLS 1.3; session resumption is disabled. The protected profile's optional
`protocol_version` selects exactly one closed protocol before listener creation:
omission preserves wire version 2 and ALPN `oce-github-mediation-v2`; literal 3
selects wire version 3 and ALPN `oce-github-git-read-v3`. Explicit 2, null, zero,
other values, alternate selector names and caller-supplied ALPN reject. Profile
and control envelope `version` remain 1. The parent must bind the v3 selection to
its actual admitted `github-git-read-rpc-v3` policy and
`owned-child-stdio-github-git-read-v3` source; profile syntax validation creates no
admission. DS metadata cannot select or change the configured protocol.

V3 open metadata contains the closed Git operation, exact `version=2` Git
protocol, retained outgoing body byte count and SHA-256, plus the canonical
Git request digest. Discovery requires an empty body/hash; upload-pack requires
1..4,194,304 bytes. The bridge verifies metadata/digest correspondence against the
fixed GitHub origin, method, target and header representation. Actual body
validation, gzip decoding, thin-pack normalization, retention and submission
remain in DS; body bytes do not enter these frames. All later requests and
replies keep the configured wire version and existing correspondence and
secret rules.
Every accepted socket also requires exact `SO_PEERCRED` UID. All filesystem
ancestors must be non-symlink directories owned by an explicitly trusted UID and
not group/world writable. The immediate parent is owned by the native effective
UID with mode 0700; the created socket is mode 0600. No preexisting endpoint is
removed. Cleanup removes only the originally created inode. Ready is emitted
only after Source readiness, pinned trust, transport creation and protected bind.

One exchange is active at a time. The exact original request/session/binding
sequence is retained, with dispatch at most once and terminal completion/refusal.
Native source/trust checks, original certificate/session expiry, per-request
monotonic timers, partial-input bounds and blocked-output cancellation operate
independently of a paused parent. Each positive reply's short lease is anchored
at the original native first-byte exchange start, bounded by the original call deadline, unchanged operation
horizon and connection expiry. Receiving a late reply cannot start a fresh lease.
Idle expiry closes the connection. Parent cleanup does not imply no effect
occurred. Connection closure joins actual reader/watcher work; global shutdown
also joins listener/health work and closes the owned Source and pipes.

## Verification

With the existing pinned Go toolchain/cache and permission to create local Unix
sockets:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -race ./githubbridge ./cmd/oce-github-mediation
```

The tests use signed disposable X.509-SVIDs delivered by an external Workload API
fixture, actual Source/maintained TLS and actual filesystem Unix sockets. They
exercise healthy sequential transport, same-session/fresh-exchange inspection,
raw secret delivery, written acknowledgement, original lease expiry, source
withdrawal, wrong peer/UID, replay, malformed/partial frames, blocked output,
buffer clearing and protected path cleanup. Test parent replies are explicit
transport fixtures; they establish no positive Work authorization, live GitHub
credential, current registration, deployment admission or production attestation.

The test-only cross-language fixture accepts
`OCE_GITHUB_BRIDGE_FIXTURE_PROTOCOL_VERSION=3` to select the external DS client
ALPN and ready profile. Omission keeps V2; any other value fails. It is compiled
only into the test binary and supplies no original Work or repository authority.
The Git tests include frozen representation vectors, crossed ALPN/wire refusal,
actual Source/TLS refusal delivery, fresh sessions and source withdrawal.
