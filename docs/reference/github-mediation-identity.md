# Native GitHub mediation identity

This reference describes the existing native component profile. Its contracts and
verification limits remain unchanged. The [current gateway MVP](../../specs/github-credential-gateway-mvp.md)
uses a separate service profile; these native joins are optional reuse, not its
release prerequisites.

The native GitHub broker listener authenticates a trusted injector and preserves
one original connection while the controller evaluates repository requests. It
uses the maintained SPIFFE Workload API source and service-peer TLS transport.
GitHub authorization, original work, provider credentials and dispatch records
remain with their existing accepting owners.

## Selected transport

Build the dedicated child executable from the runtime-security module:

```sh
go -C components/runtime-security build -o ./bin/oce-github-mediation ./cmd/oce-github-mediation
```

The controller's `startGitHubMediationNative` entrypoint launches this executable
with an empty environment and owns its input/output pipes. Protected startup
selects exactly one pair from the existing current service registry:

| Startup selection                       | Operation policy         | Transport profile                      | TLS application protocol  |
| --------------------------------------- | ------------------------ | -------------------------------------- | ------------------------- |
| Omitted or literal `protocolVersion: 2` | `github-metadata-rpc-v2` | `owned-child-stdio-github-metadata-v2` | `oce-github-mediation-v2` |
| Literal `protocolVersion: 3`            | `github-git-read-rpc-v3` | `owned-child-stdio-github-git-read-v3` | `oce-github-git-read-v3`  |

The selected version must match the actual admitted profile before child startup.
The typed constructor accepts an operation owner and borrowed native Session
source for that same literal version. A V3 record cannot select V3 implicitly,
and a V2 owner cannot be reused as a V3 owner. The admitted service role is
`repository-issuer`. An old
lifecycle or historical-read profile cannot enter this path. Admission uses
`validateNativeGitHubMediationProfile` with the same protected listener/UID
configuration as startup. That callable checks the admitted executable digest
and invokes the actual native parser; it creates no listener or service identity.

The child creates the exact configured filesystem Unix socket and performs
mutual TLS 1.3. Both sides verify the exact expected SPIFFE URI identity, and
the negotiated application protocol must match the selected row above. A DNS
server name alone does not verify a SPIFFE identity. Session resumption is
disabled. The service-peer `ApplicationProtocol` option is optional for existing
profiles; when set, it requires one exact protocol without a fallback.

The protected native profile and pipe envelope keep schema version 1. The
profile omits `protocol_version` for V2 and includes literal `protocol_version: 3`
for V3. Explicit native values 2, null, zero or another version reject, as do
alternate selector names and caller-supplied ALPN. Request metadata cannot select
or change the configured protocol. Every request and reply keeps the selected
wire version for the original session.

The actual broker process owns the immediate socket directory with mode `0700`
and the socket with mode `0600`. Every ancestor must be a non-symlink directory,
have no group or world write permission, and belong to one of the explicitly
trusted deployment UIDs. The native listener verifies the injector's actual
Unix peer UID. Deployment must provide a process/UID arrangement in which the
injector can reach that protected socket while Agent execution cannot. Endpoint
cleanup removes only the original created socket, and retains a replaced path.

## Original connection and request ownership

The controller creates opaque service contexts only when receiving requests from
its original spawned child. The native process retains the actual TLS connection.
Its connection identifier and the controller's private transport binding remain
fixed for the session. Each request has a fresh exchange identifier, exact raw
metadata digest and a fixed deadline.

Before accepting a request, the controller performs a fresh native inspection
and checks the current durable service/source registration before and after it.
The native inspection checks the actual original connection, certificates and
current Workload API source. A separate registry watcher and native identity
watcher close the connection on registration withdrawal, source failure, expiry
or replacement. Neither a copied context, a diagnostic peer record nor a
reconnected socket can inherit the original context.

The native pipe protocol binds child incarnation, ordered sequence, connection,
exchange, request digest and fresh inspection challenge. Input and output have
separate increasing sequence numbers. Malformed or unexpected frames terminate
the owned session. The controller returns no method that constructs an
authenticated context from application data.

V3 open metadata declares discovery or upload-pack, exact Git `version=2`, and
the retained outgoing body's size and SHA-256. Discovery requires an empty body;
upload-pack declares 1 through 4,194,304 bytes. The native bridge and broker
validate the closed metadata and canonical request digest against the fixed
GitHub origin, method, target and headers. The trusted injector owns actual body
validation, bounded gzip decoding, removal of the validated thin-pack argument,
retention and submission. Body bytes do not enter the mediation frames. Native
acceptance of this declaration supplies no original Git work or repository-use
permission.

A metadata write completes only after the native child acknowledges the actual
TLS frame write. This acknowledgement is transport evidence and does not prove
GitHub received or completed an operation. A next request coalesced with that
acknowledgement waits for the preceding broker operation to settle while keeping
its original native deadline. Closing one session retains the listener for a
fresh connection. Bounded retirement records drain only exactly correlated late
inspection, write and close events; they never restore retired authority.

## Framing and credential boundary

The injector protocol uses an eight-byte length prefix: unsigned big-endian
32-bit metadata length, followed by unsigned big-endian 32-bit secret length.
Metadata is closed UTF-8 JSON, at most 16,384 bytes. The confidential suffix is
at most 16,384 bytes. It is permitted only on the single successful
`dispatch-once` reply, contains visible ASCII token bytes, and never enters JSON
or base64 metadata.

The private controller pipe uses the same two-length framing, with a 32,768-byte
metadata cap to carry the exact injector metadata and its ownership envelope.
Child-to-controller frames never carry a secret suffix. Secret suffixes entering
the native child are owned and erased after forwarding or rejection. This
buffer ownership does not claim erasure of every copy in the TLS implementation.

The current controller transport exposes only metadata reply, fresh inspection
and closure to the concrete broker service. A confidential release requires the
original custody owner's privately recognized, known committed release and its
fixed native receiver. There is no general token accessor or arbitrary output
callback. An absent original release owner cannot produce a positive dispatch.

The constructor-held native Session source provides a fixed receiver for the
paired custody owner. `prepareCommittedToken` first authenticates the native
exchange and returns a privately recognized prepared write. Custody then acquires
and retains the original State current-use lease, prepares the material, and
performs its synchronous final State fence. `writePreparedCommittedToken`
immediately submits that prepared frame without another asynchronous wait before
submission; it refuses an occupied native output queue. Custody must hold the
actual State lease until the native write promise settles. Cancellation stops new
use immediately but preserves the pending write until its exact native TLS
acknowledgement or confirmed original connection/process retirement. A bounded
shutdown timeout does not prove that bytes stopped; the write remains pending
until actual retirement, preserving the caller's current-use responsibility.

The receiver independently requires its exact privately held Session, the current
`dispatch-read` exchange and matching closed `dispatch-once` metadata. It prepares
and attempts credential delivery at most once per Session, retains the original
lease horizon, and clears its own token and pipe-frame copies. It borrows the
custody input buffer, whose lifecycle remains custody-owned. The public broker
transport cannot send a secret suffix. No method creates a receiver from a
caller-supplied output callback or address. This transport preparation supplies
no State current-use authority or historical-commit-to-current-use conversion.

## Scope and verification

This transport authenticates the injector service. Agent enrollment, the
protected execution-attachment-to-original-work association, current repository
policy and ordered dispatch/withdrawal are separate required producers. The
current service registry is a service authentication resource; it does not
replace the Agent registration or runtime assignment records. A valid SVID or
socket alone never authorizes a repository operation.

The focused native tests use actual filesystem Unix sockets, actual
`identity.Source`, maintained mutual TLS and the native bridge. They substitute
the external Workload API using disposable signed certificates. Controlled
parent replies exercise framing and credential transport, and do not establish
an OCE repository authorization result. The controller's fixed-receiver
cancellation tests similarly use disposable protocol phase data at the broker
operation port, with real registry admission, native Session custody, pipe
submission and TLS. They verify actual confidential delivery and its native
acknowledgement without returning raw bytes to the test parent. They pause only
the actual connected peer through a retained
`SO_PEERPIDFD` descriptor, then verify narrower-call cancellation, borrowed
Session release and concurrent shutdown retain the write until native retirement.
This test fixture requires Linux `SO_PEERPIDFD` support and has no production
pause mode. These cases are transport-lifetime evidence; they do not establish
positive Work/State/custody authorization. The tests cover wrong identity/UID,
source loss, protocol replay, malformed/partial frames, secret rejection and
erasure, blocked output, cancellation and original-endpoint cleanup.

```sh
go -C components/runtime-security test -race ./servicepeer ./githubbridge ./cmd/oce-github-mediation
```

The controller integration test builds the same native executable and a
`githubbridge` test binary. The latter substitutes the external Workload API and
acts as the TLS client; it is absent from production builds. Protect each selected
executable against group or world writes. Select the V2 executable using
`OCE_GITHUB_MEDIATION_TEST_BINARY`, the V3 executable using
`OCC_GITHUB_GIT_READ_TEST_BINARY`, and the external fixture using
`OCE_GITHUB_MEDIATION_FIXTURE_BINARY`. Run
`node --test --test-concurrency=1 tests/integration/github-mediation-native.test.mjs tests/integration/github-mediation-git-native.test.mjs`.
The actual fixture helper is reusable from
`tests/fixtures/github-mediation-native.mjs`; importing it starts no test or
fixture. These tests
use the actual IAM and service-admission implementation with its in-memory
State backend, native validator, controller and broker. It does not verify
PostgreSQL durability. Without an original repository-use owner it expects an
authenticated broker refusal with no credential; it cannot establish positive
repository authorization or dispatch.

The V3 cases cover explicit registry/profile selection, refusal on crossed wire
versions and request digests, original Session inspection, registry withdrawal,
and the same four fixed-receiver delivery/cancellation cases as V2. The focused
TypeScript conformance test rejects missing or widened V3 selection and crossed
operation-owner or native-source types. Original Work, State and custody
acceptance remains separate from these transport and service-admission results.

Production startup additionally needs the real current service profile, controller
broker, original work/assignment producer and custody/dispatch owner.
Installed qualification must prove that the selected gVisor execution cannot
reach the broker socket or provider credentials directly, that protected
attachment identity changes on execution replacement, and that permission
changes create a fresh Pod/sandbox. Tests using an external Workload API fixture
do not establish those installed properties.
