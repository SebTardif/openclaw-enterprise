# SPIFFE Workload API source

The Go package `components/runtime-security/identity` obtains the local caller's
X.509-SVID and JWT-SVID from an operator-provisioned SPIRE Agent. It uses the
maintained `github.com/spiffe/go-spiffe/v2` Workload API client and identity
parsers. JWT signature and audience validation is delegated to SPIRE.

The source is available to explicit Go consumers and the native operator
command. Controller authentication, IAM authorization, sandbox activation and
remote workload transport do not automatically use it. An SVID alone does not
establish a current Installation, Namespace, Agent, revision, runtime assignment
or operation grant. See the [platform design](../design.md).

## Trust and configuration

Supply an absolute, protected local Unix socket path and one exact expected
SPIFFE identity. There is no environment discovery or fallback identity.
The operator must protect the socket and its parent directories from replacement
by untrusted processes. A pathname check does not authenticate an endpoint or
prove that it belongs to a particular execution sandbox.

The upstream Go parser handles SPIFFE identity syntax and X.509-SVID structure;
OCE compares the selected identity to the configured expectation. The Go source
uses the upstream certificate profile, including its rules for permitted SANs. This does not turn material acquisition into remote-peer
certificate-path verification or current application authorization.

SPIRE owns node/workload attestation, registration, issuance and trust-bundle
delivery. This package exposes no administrative registration API and installs
no SPIRE Server or Agent. A local host check cannot establish the identity of
a gVisor sandbox, an OpenShell/Kata guest, or separation between processes
sharing a Unix UID. Each selected runtime needs its own attestation, delivery
and current-assignment integration.

## Source lifecycle

`identity.NewSource(identity.Options{...})` creates a source. `Start(ctx)` waits
for its first acceptable X.509 update; the context controls the complete source
lifetime. The exact configured identity must be present without ambiguity.
Updates replace the selected certificate, key and bundle material together.
Missing identity, invalid material, expiry, stream failure, cancellation or
`Close()` withdraws availability. The previous snapshot cannot remain healthy
after a failed update.

Before the SDK selects entries by hint, the source validates every raw SVID,
checks raw collection and certificate counts, and rejects duplicate SPIFFE IDs.
Global response identity uniqueness is a stricter OCE source policy. It then
ignores hints to select the exact configured identity. SDK-allowed extra DNS
SANs remain supported. The JWT audience is bounded to 2,048 bytes.

The source is single-use after terminal failure. A consumer must construct a new
source under its own bounded recovery policy. The wrapper cancels upstream
watch/retry behavior when the source fails; reconnecting the provider cannot
silently revive a retired source.

The initial readiness and each JWT operation have a configured timeout of one
to 60 seconds (10 seconds by default). gRPC messages are capped at 4 MiB; JWTs at
64 KiB; response collections and certificate/bundle lists at 64 entries; and
concurrent JWT operations at 16. Socket paths are explicit normalized absolute
paths up to 103 bytes. These limits are local source policy.

`Metadata()` returns identity, expiry and certificate counts. `Snapshot()`
returns independent credential copies. Consumers must protect those copies,
respect expiry and stop using retained credentials when the source fails.
Closing a source cannot revoke already issued tokens or erase copies held by
another component. Prefer metadata for diagnostics.

```go
source, err := identity.NewSource(identity.Options{
    SocketPath: "/run/spire/agent.sock",
    ExpectedSPIFFEID: "spiffe://example.org/controller",
    Timeout: 10 * time.Second,
})
if err != nil {
    return err
}
defer source.Close()
if err := source.Start(ctx); err != nil {
    return err
}
metadata, err := source.Metadata()
```

## JWT operations

`FetchJWTSVID(ctx, audience)` requests the configured source identity for an
explicit audience and returns a token only after the trusted local provider
accepts it. `ValidateJWTSVID(ctx, token, audience, expectedPeerID)` requires
provider validation, the exact expected subject and audience, and unexpired
claims. The expected peer is independently configured by the trusted consumer;
it must not come from unverified token contents.

Successful validation supplies identity information. It does not authorize a
resource operation or establish that a workload assignment remains current.
The source does not log tokens, keys, raw certificates or provider exceptions.
Operations require a live source and honor context cancellation and bounded
request deadlines.

## Build and run

Build the native component using the module's declared Go toolchain:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
./components/runtime-security/bin/oce-runtime-security identity check \
  --socket-path /run/spire/agent.sock \
  --spiffe-id spiffe://example.org/controller \
  --audience oce-local-diagnostic \
  --timeout-ms 10000
```

The diagnostic is implemented in Go and prints a versioned JSON metadata
summary. The optional audience adds JWT issuance and validation. It exits
nonzero for unavailable, mismatched or invalid identity. It changes neither
controller configuration nor registration policy. The example ID must already
be registered for the actual process.

The [module README](../../components/runtime-security/README.md) describes
build, packaging and the controller process boundary. The production image
contains `/usr/local/bin/oce-runtime-security`.

## Verification

```sh
go -C components/runtime-security test -race ./...
go -C components/runtime-security vet ./...
```

The native protocol tests exercise actual local gRPC sockets, upstream generated
messages and temporary test certificates. Controlled endpoints prove component
behavior and error handling; they do not prove SPIRE attestation or production
runtime isolation.

Select a real SPIRE test only after provisioning an Agent and registration for
the actual Go test process:

```sh
OCC_TEST_SPIFFE_SOCKET_PATH=/run/spire/agent.sock \
OCC_TEST_SPIFFE_ID=spiffe://example.org/controller \
OCC_TEST_SPIFFE_AUDIENCE=oce-local-test \
go -C components/runtime-security test ./identity -run TestRealSPIRE -count=1
```

With no real-provider settings, the test skips explicitly. Providing any selects
the test and requires all three. Local issuance, rotation, denial and outage
results must name the actual Go implementation and provider version. Earlier
TypeScript checkpoint receipts are not Go implementation evidence.

## Troubleshooting

- Verify that the configured socket exists and is protected, and that SPIRE's
  registration attests the actual executable process.
- Correct an identity mismatch through trusted registration or configuration;
  do not select another returned identity as a fallback.
- After expiry or lost provider availability, restore issuance and construct a
  new source. A closed source remains closed.
- Use the fixed source error code and bounded provider-side diagnostics.
  Do not print SVID material or arbitrary provider exception text.
- Keep unavailable runtime attestation, remote mTLS and current assignment
  authorization as explicit integration requirements.

## Upstream sources

The module pins `github.com/spiffe/go-spiffe/v2` in `go.mod` and records dependency
checksums in `go.sum`. It consumes that project's generated Workload API protocol
and parsers. See the official [Go SPIFFE library](https://github.com/spiffe/go-spiffe),
[Workload API specification](https://github.com/spiffe/spiffe/blob/99470b9abc825f14aa364dfa2c3b53b02ba5db5b/standards/SPIFFE_Workload_API.md),
and [SPIRE 1.15.3](https://github.com/spiffe/spire/releases/tag/v1.15.3).
