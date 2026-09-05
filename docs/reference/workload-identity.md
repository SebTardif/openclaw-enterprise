# SPIFFE Workload API source

The controller package contains a standalone SPIFFE Workload API credential
source for verification against an operator-provisioned local SPIRE Agent.
It obtains the local caller's X.509-SVID and JWT-SVID and delegates JWT
signature and audience validation to that same Agent. It is not wired into
controller startup, request authentication, IAM authorization, Sandbox Drivers,
or workload activation.

This source proves identity only for the process attested by the selected
SPIRE Agent. A host-side probe does not establish the identity of an OpenShell
sandbox guest. An SVID does not by itself prove the current Installation,
Namespace, Agent, immutable revision, runtime assignment, or authorized
operation. Those bindings remain separate platform responsibilities under the
[platform design](../design.md).

## Trusted local endpoint

The caller must provide both an absolute filesystem Unix socket path and one
exact expected workload SPIFFE ID. The source has no automatic endpoint
discovery or environment fallback. It rejects network URLs, Unix URI strings,
relative or noncanonical paths, control characters, and paths exceeding 103
bytes. The endpoint must already exist as a Unix socket; a socket symlink is
rejected. Its parent directories and mount must be protected from replacement
by untrusted processes. The filesystem check does not authenticate the server
or eliminate races; provisioning and protecting the local SPIRE endpoint is
the operator's responsibility.

SPIFFE IDs must use the lowercase `spiffe` scheme and a lowercase trust domain,
with a non-root path composed of ASCII letters, digits, `.`, `_`, `-`, or `~`.
Empty, dot, and dot-dot path segments, ports, user information, percent escapes,
queries, and fragments are rejected. The source accepts a maximum of 2048
characters and compares accepted IDs exactly, without normalization or prefix
matching.

All RPCs send the required `workload.spiffe.io: true` metadata. Transport uses
local gRPC over the configured Unix socket. Workload and node attestation,
registration policy, SVID issuance, and trust distribution are owned by SPIRE.
There is no SPIRE administrative API client or automated server/Agent deployment
in this component.

## X.509 source lifecycle

`start()` opens `FetchX509SVID` and waits for the first acceptable response.
The configured ID must appear exactly once. Other identities are never a
fallback. Every message is a complete replacement: its selected SVID,
certificate chain, private key, local bundle, global CRLs, and federated bundles
replace the previous snapshot together.

The supported leaf profile has exactly one URI SAN and no other SAN entries:
Node's certificate representation must equal `URI:<expected SPIFFE ID>`.
This restricted profile matches the SPIRE default used by this integration.
The SPIFFE specification permits additional SAN types; this component rejects
them. This exact consistency check avoids interpreting ambiguous rendered SAN
strings. Node/OpenSSL parses the DER certificates and unencrypted PKCS#8 key,
checks that the leaf and key match, and checks certificate-chain validity
times. The earliest chain expiry bounds source validity.

These checks establish local credential consistency. They are **not** an
RFC 5280 path validator, X.509 peer authenticator, revocation checker, TLS
transport, or proof that a certificate issuer may represent a particular
platform resource. CRLs and federated bundles are carried as source material;
this component does not apply them to peer authentication.

The source discards its snapshot on a missing or duplicate expected ID,
malformed replacement, expired certificate, stream error/end/close, lifetime
signal cancellation, or explicit `close()`. It never serves the previous
snapshot after a failed replacement. There is no automatic reconnect: callers
must create and start a new source after terminal failure. The first startup
signal controls the whole source lifetime; repeated `start()` calls share the
original startup operation and its signal.

`getX509IdentityMetadata()` returns only the SPIFFE ID, expiry, and certificate
counts. `getX509Identity()` returns independent copies of credential buffers.
The source overwrites its retained private-key buffer when replacing or
discarding a snapshot, but cannot revoke or erase copies already handed to a
caller or internal cryptographic-library allocations. Consumers must protect
private keys, honor expiry, and stop using cached credentials when the source
fails. Prefer the metadata getter for diagnostics.

## JWT operations

`fetchJwtSvid({ audience })` requests only the configured SPIFFE ID and a single
explicit audience, requires one exact identity match, then calls
`ValidateJWTSVID` for the returned token. Fetching and validating share one
operation deadline. It returns `{ spiffeId, expiresAt, token }` only after the
local Agent accepts the token and its validated claims agree with the expected
identity and audience.

`validateJwtSvid({ token, audience, expectedSpiffeId })` asks SPIRE to validate
the token for that exact audience. It then requires the response identity and
`sub` claim to equal the independently configured expected peer ID, requires
the audience array to contain the exact requested value, and requires an
unexpired integer `exp`. It returns only `{ spiffeId, expiresAt }`. No
unverified token payload is decoded or treated as identity. Multiple audience
values in a validated token are supported; matching is exact membership, not
wildcard or prefix matching.

JWT operations require a live, unexpired X.509 source and accept per-operation
abort signals. The component does not cache JWTs or validated claims, and it
does not log tokens, keys, or raw RPC errors. Successfully validated JWTs still
need resource authorization and a current workload binding before any future
runtime consumer may accept them.

## Running the diagnostic

With Node 24 and an already provisioned SPIRE Agent, run from the repository
root:

```sh
node scripts/check-workload-identity.mjs \
  --socket-path /run/spire/agent.sock \
  --spiffe-id spiffe://example.org/controller \
  --audience oce-local-diagnostic \
  --timeout-ms 10000
```

The diagnostic prints a safe JSON summary; `--audience` additionally exercises
JWT issuance and validation. It does not print credentials or change
controller configuration. The socket and registered selectors must attest the
actual diagnostic process; the ID in this example is not automatically
registered.

The programmatic entrypoint is
`apps/controller/src/identity/index.ts`:

```ts
const source = createSpiffeWorkloadIdentitySource({
  socketPath: "/run/spire/agent.sock",
  expectedSpiffeId: "spiffe://example.org/controller",
  timeoutMs: 10_000,
});
try {
  await source.start({ signal });
  const metadata = source.getX509IdentityMetadata();
} finally {
  source.close();
}
```

The initial response and each complete JWT operation are bounded by a timeout
of 1000–60000 ms, defaulting to 10000 ms. The persistent stream itself lasts
until close, failure, cancellation, or credential expiry. gRPC receive messages
are limited to 4 MiB. Each SVID list, certificate collection, CRL list, and
federated bundle map has a maximum of 64 entries. JWTs are limited to 64 KiB,
audiences to 2048 characters, and concurrent unary RPCs to 16. Exceeding these
bounds fails the operation; oversized or invalid stream responses terminate
the source.

## Verification and troubleshooting

Run the configuration and protocol tests with:

```sh
node --test tests/conformance/spiffe-workload-configuration.test.mjs
node --test tests/integration/spiffe-workload-api.test.mjs
```

The protocol suite exercises the actual component through gRPC over a local
Unix socket, using the pinned public protocol and temporary, test-generated
certificates. Its controlled server proves serialization, selection,
replacement, bounded waits, cancellation, and failure behavior. It does not
prove SPIRE attestation, cryptographic JWT validation by SPIRE, deployment
isolation, or sandbox guest identity.

A separate test requires a real, explicitly provisioned SPIRE Agent and
registration for the Node test process:

```sh
OCC_TEST_SPIFFE_SOCKET_PATH=/run/spire/agent.sock \
OCC_TEST_SPIFFE_ID=spiffe://example.org/controller \
OCC_TEST_SPIFFE_AUDIENCE=oce-local-test \
node --test tests/integration/spiffe-workload-real.test.mjs
```

With none of these settings, the real test explicitly skips. Providing any
setting selects the test and requires all three. This test exercises genuine
local identity issuance and JWT validation, including denial of a wrong
audience and rejection of a mismatched expected peer. It does not provision
SPIRE or establish guest identity or platform authorization.

Errors use fixed, safe `SpiffeWorkloadIdentityError.code` values:

| Code                    | Meaning and next action                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `INVALID_CONFIGURATION` | Check explicit path, ID, audience, and timeout bounds.                                                                                                                               |
| `UNAVAILABLE`           | Check the protected socket, Agent health, workload registration, and Agent-side validation diagnostics. Raw Agent details are deliberately omitted.                                  |
| `IDENTITY_MISMATCH`     | The configured identity, supported sole-URI leaf, or validated audience/subject does not match. Correct registration or configuration; do not select another identity as a fallback. |
| `INVALID_RESPONSE`      | Required credential or claim structure is invalid or exceeds a bound. Inspect the trusted Agent and supported profile.                                                               |
| `EXPIRED`               | The source credential or JWT expired. Restore renewal and create a new source if its stream terminated.                                                                              |
| `TIMEOUT`               | The first response or JWT operation exceeded the configured deadline.                                                                                                                |
| `ABORTED`               | The operation or source lifetime signal was canceled.                                                                                                                                |
| `CLOSED`                | This source was explicitly closed; create a new instance.                                                                                                                            |
| `BUSY`                  | Sixteen unary RPCs are already in flight; bound caller concurrency.                                                                                                                  |

## Protocol sources

The unmodified public Workload API proto and its Apache-2.0 license are pinned
under `apps/controller/src/identity/proto/`; its revision and SHA-256 are
recorded in `NOTICE.md`. Only `FetchX509SVID`, `FetchJWTSVID`, and
`ValidateJWTSVID` are used. The other methods retained in the complete upstream
proto are not implemented by this source.

Protocol behavior follows the public
[SPIFFE Workload API](https://github.com/spiffe/spiffe/blob/99470b9abc825f14aa364dfa2c3b53b02ba5db5b/standards/SPIFFE_Workload_API.md),
[X.509-SVID profile](https://github.com/spiffe/spiffe/blob/99470b9abc825f14aa364dfa2c3b53b02ba5db5b/standards/X509-SVID.md),
and [JWT-SVID profile](https://github.com/spiffe/spiffe/blob/99470b9abc825f14aa364dfa2c3b53b02ba5db5b/standards/JWT-SVID.md).
