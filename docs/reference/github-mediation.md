# GitHub read mediation

This reference describes the existing native component profile. Its contracts and
verification limits remain unchanged. The [current gateway MVP](../../specs/github-credential-gateway-mvp.md)
uses a separate service profile; these native joins are optional reuse, not its
release prerequisites.

The GitHub mediation service provides a bounded OCC accepting path for one
repository metadata read or one explicitly selected Git read exchange. It connects the trusted native transport to the
original Work authority, credential inventory and token custody owners. It does
not implement a second authorizer, token issuer or upstream HTTP proxy.

The current service and wire decoder are source components. They are not enabled
by an HTTP route or default production listener. Missing original operation
owners return unavailable. A complete deployment also needs an authenticated
native accepting adapter, current runtime and Work association, exact repository
policy, protected token-use custody, and selected network enforcement.

Related components are the [native GitHub transport](native-github-egress.md),
[GitHub App provider](github-app-provider.md),
[credential inventory](credential-inventory-v1.md), and
[runtime identity/currentness](runtime-identity-currentness.md).

## Metadata operation

The first operation is an empty-body `GET /repos/OWNER/NAME` on
`https://api.github.com:443`. The native consumer constructs the fixed request
from the retained validated repository route. It rejects arbitrary query strings,
bodies, caller credentials, redirects and unsupported methods. GraphQL, Git
upload-pack, publication and general `gh api` requests are not admitted by this
metadata decoder.

The request digest binds a fixed semantic representation of the method, origin,
port, path, selected headers and empty-body digest. It does not depend on HTTP
header ordering. Both the native consumer and OCC independently compute the same
digest; a digest supplied in a request is not authorization.

Repository identity and its allowed read profile come from the original current
operation owner. Caller-supplied owner/name values do not establish a repository
ID or scope. The native response contract uses a bounded projection of supported
metadata fields and fixed errors. This checkpoint does not claim full Git or gh
compatibility.

## Git read successor

The same broker service also implements a separate version-3 wire grammar for
Git protocol 2 discovery and upload-pack. This source component requires its own
admitted native profile and original Git read operation owner. Enabling metadata
does not enable Git. The selected operation policy is `github-git-read-rpc-v3`,
its native transport profile is `owned-child-stdio-github-git-read-v3`, and its
required ALPN is `oce-github-git-read-v3`.

The successor describes exactly two upstream requests on `https://github.com:443`:

| Git operation | Method | Exact target                                        | Request Content-Type                    | Accept                                        |
| ------------- | ------ | --------------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `discovery`   | `GET`  | `/OWNER/NAME.git/info/refs?service=git-upload-pack` | absent                                  | `application/x-git-upload-pack-advertisement` |
| `upload-pack` | `POST` | `/OWNER/NAME.git/git-upload-pack`                   | `application/x-git-upload-pack-request` | `application/x-git-upload-pack-result`        |

Both use fixed `Git-Protocol: version=2`, `Accept-Encoding: identity`,
`User-Agent: oce-github-git-read` and `Connection: close`. The original operation
must authorize the exact repository with `contents:read` and `metadata:read`.
Discovery and each upload-pack round retain the same finite original Work;
they have distinct repository-use effects and credential releases. Token
issuance is a separate operation.

Version-3 `open-read` adds exactly `git_operation`, `git_protocol`, `body_bytes`
and `body_sha256` to the metadata open fields. The protocol field is always
`version=2`. Discovery requires zero body bytes and the empty-body SHA-256.
Upload-pack requires 1 through 4,194,304 retained bytes. The native consumer owns
Git packet validation and the correspondence between that declaration and its
actual retained outgoing body. A body hash in JSON does not establish either
Git validity or authority.

The native contract permits absent request Content-Encoding or a single bounded
gzip member, as used by ordinary Git. Compressed and decoded bytes each have a
4 MiB maximum; integrity, EOF and packet validation must finish before broker
open. The digest describes the decoded body, which is retained and sent
uncompressed. It never names a mutable file, URL or body callback.

The `githubGitReadDigest` helper uses the domain `oce.github.git-read.v3` and
binds the operation, method, fixed origin, exact target, fixed headers, body
length and body hash. Its LF-terminated lines are:

```text
oce.github.git-read.v3
GIT_OPERATION
METHOD
https
github.com
443
REQUEST_TARGET
accept:ACCEPT
accept-encoding:identity
content-type:CONTENT_TYPE_OR_EMPTY
git-protocol:version=2
user-agent:oce-github-git-read
connection:close
body-bytes:DECIMAL_LENGTH
body-sha256:LOWERCASE_HEX_SHA256
```

Following frames retain the same closed fields and state transitions as metadata,
with version 3. The native Git response contract requires a finite configured
buffer limit no greater than 64 MiB, exact Git content types, selected protocol
framing and credential-echo suppression before downstream output. Metadata keeps
its separate response projection and bounds. These limits support a bounded
clone/fetch profile; they do not promise every repository size or Git feature.
Receive-pack, writes, LFS, submodule requests, alternate hosts, redirects and
unsupported protocol commands remain outside this successor. Repository history
may become visible to the authorized execution; it is not history isolation.

## Native protocol

For metadata, the protocol identifier and required TLS ALPN are `oce-github-mediation-v2`.
The native adapter owns one authenticated TLS session over a protected Unix
socket for one retained request. Exact service identity verification and protected
socket ownership are separate checks. A configured DNS server name or Unix UID
alone does not authenticate a SPIFFE workload or its represented Work.

The frame contains:

```text
metadata length: u32 big endian
secret length:   u32 big endian
metadata:        exact UTF-8 JSON bytes
secret:          raw token bytes, when permitted
```

Metadata is limited to 16 KiB. The separate token section is limited to 16 KiB and
is present only in a successful `dispatch-once` response. Its bytes match the
provider's visible-ASCII token validation. Tokens never enter JSON or base64
metadata. The native adapter owns frame bounds, token-buffer lifetime, actual
socket writes and peer authentication.

The OCC metadata decoder rejects duplicate decoded keys, invalid UTF-8, extra or
missing fields, nested structures, invalid number syntax and unsupported values.
The reply encoder accepts only closed primitive data properties. It never invokes
caller accessors, proxy traps or `toJSON` methods.

| Request                         | Allowed predecessor                                                   | Result                                                                                     |
| ------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `open-read`, sequence 1         | New authenticated connection                                          | Original bounded preparation, fixed request, Work correspondence and protected DNS binding |
| `dispatch-read`, sequence 2     | Original opened request and retained verified upstream TLS connection | One committed release and confidential token response, or refusal/unknown                  |
| `check-read`, sequence 3 onward | Original dispatched request                                           | Fresh online currentness within the original operation horizon                             |
| `complete-read`                 | Original opened or dispatched request                                 | Retained original outcome receipt and terminal connection closure                          |

Every message retains the request, session, effect, Work digest and request digest.
Replies echo their exact request sequence. A connection cannot switch to a new
Work, attachment, repository, request or receiver. No reconnect, multiplexing,
automatic retry or release replay is supported. Malformed, gapped, duplicate or
foreign messages close the original session.

## Callable integration

The concrete implementation is `GitHubMediationService` in
`packages/occ/src/github-mediation-v2/service.ts`. Its constructor takes:

- The original `GitHubMediationTransportOwner`.
- Finite `GitHubMediationLimits`.
- The original `GitHubMediationOperationOwner`, when available.
- A literal `protocolVersion: 3` for the separately admitted Git successor;
  omitting this selects the existing metadata version 2.

The service exposes `handle(metadata, call)`, `close(call)`, `join()` and `stop()`.
`handle` writes through its fixed accepting transport and returns no token-bearing
object. `join` observes actual owned work; it does not imply provider completion.
The native owner creates and recognizes the existing opaque `AuthorityCallV1`
context. Each inspection must bind the exact raw metadata digest to the current
native exchange, in addition to fresh service/trust validation. The service pins
that context and transport identity for the complete session.

The operation owner implements preparation, dispatch, currentness, confidential
release writing and retained settlement. Its private preparation and release type
parameters default to `never`; callers cannot construct positive handles from
wire records. The implementation must recognize those original operands at
runtime. The dependency has no default allowing implementation.

The third type parameter of `GitHubMediationService` and
`GitHubMediationOperationOwner` selects the literal wire version and defaults to 2. `OpenRead<3>` includes the Git fields; a metadata owner cannot satisfy that
Git owner type. For example, the native owner composes a selected Git supplier
as `new GitHubMediationService({ transport, limits, protocolVersion: 3,
operations: gitOwner })`. Construction supplies no admission by itself.
The native accepting owner must independently recognize the matching admitted
profile and original protected call.

`decodeGitHubMediationRequest(bytes)` keeps its exact version-2 behavior.
`decodeGitHubMediationRequest(bytes, 3)` selects the closed Git successor. Each
service instance retains its selected version and rejects the other version
before transport inspection or Work lookup. Later frames cannot change it.

Work correspondence reuses `WorkOriginalOperationV2`, `VersionedWorkRefV2` and
`WorkExecutionAssociationV2`. It retains the original full attempt, assignment,
incarnation, receiver and scope. An old human-turn credential record cannot be
filled with invented values to represent service-owned Work.

The original operation owner must:

1. Resolve the actual protected attachment, original Work, current assignment,
   repository scope and protected DNS preparation.
2. Recheck current original authority after asynchronous preparation and minting.
3. Use the existing inventory and provider to retain token eligibility and scope.
4. Commit separate dispatch and credential-release responsibility, ordered with
   closure, before a confidential socket write.
5. Write a recorded token only to its original authenticated native exchange.
   The use-specific custody method receives no arbitrary sink or token callback.
6. Retain and settle original responsibility after cancellation or connection
   loss, including unknown outcomes. Cleanup does not grant another dispatch.

Provider and network operations occur outside the original database transaction.
An unknown commit permits exact original readback; it cannot mint, release or
submit another operation. Exact-token revocation remains a distinct custody use.

## Time, cancellation and outcomes

Configuration explicitly bounds sessions, calls, operation duration, currentness
leases and clock allowance. Pending inspections consume capacity before owner
lookup. Invalid, infinite or inconsistent limits reject construction.

The service brackets each integer-millisecond wall-clock observation with
monotonic readings. It compares those sampling intervals with the configured
clock allowance, refusing either forward or backward divergence. The original
operation and peer-expiry monotonic deadlines are fixed at initial preparation;
renewal and delayed replies cannot move them. Every returned lease is
bounded by the original call start, original operation horizon and original peer
expiry. Delayed replies cannot restart a lease at receipt. Currentness renewal
cannot revive a closed session or extend the original operation horizon.

The original current lease bounds a subsequent check. Closure and cancellation
reach in-flight owner calls, and independent expiry closes the native transport.
Accepted asynchronous work remains tracked until it settles. The service captures
late preparation or release responsibility before checking cancellation, so it
cannot lose that responsibility by returning early.

The service marks a possibly effectful dispatch unknown before invoking its owner.
`completed`, `not-dispatched` and `unknown` are distinct business outcomes.
Credential exposure is retained separately: a no-submission receipt does not
remove responsibility for a token already released. A lost acknowledgment cannot
justify another dispatch or an invented successful receipt.

Online authority does not imply instantaneous distributed withdrawal. An already
committed finite release remains an original enforcement responsibility until
applied native closure or its original expiry is established. Accepted upstream
bytes may complete after local withdrawal.

## Verification and current limits

Run the focused checks with the prepared workspace:

```sh
node --test tests/conformance/github-mediation-v2.test.mjs
pnpm exec tsc --build packages/occ/tsconfig.json --pretty false
```

The focused suite verifies the actual wire decoder/encoder and negative service
paths: absent or unrecognized owners, metadata correspondence, finite pending
capacity, opening races, cancellation propagation and constant-safe cleanup.
It also verifies the separate Git digest vectors, closed operation/body grammar,
cross-version refusal and cancellation of a rejecting Git preparation.
Controlled service observations in refusal tests create no admitted Work,
preparation, release or token. They do not prove native authentication, a committed
operation, credential storage or successful GitHub access.

Production composition requires the genuine internal owners and their actual
transaction, native transport and custody implementations. An external
GitHub response may be substituted only at its actual external boundary and must
be identified as such. Live App scope/revocation, selected gVisor routing and
no-bypass behavior require separate deployed evidence.

For unavailable requests, check the native service identity and exact metadata
binding first, then original Work/repository/DNS eligibility and installed owner
composition. Do not repair an unavailable dependency with a permissive callback,
static permit, file token or native credential-delivery fallback. Logs and errors
must remain free of provider response bodies and credential material.
