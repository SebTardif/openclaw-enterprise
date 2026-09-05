# Runtime security components

This Go module implements the OpenShell gateway client and the SPIFFE Workload
API identity source. The existing OCE controller invokes the compiled executable
through a small TypeScript process adapter. Gateway protocol interpretation,
TLS credentials, launch-record checks and workload identity handling run in Go.

## Build and verify

Use the Go version declared in `go.mod` or a compatible newer toolchain:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
go -C components/runtime-security test -race ./...
go -C components/runtime-security vet ./...
```

Configure the OpenShell Driver's `gateway.binaryPath` with the absolute path to
that binary when running from a source checkout. The packaged default is
`/usr/local/bin/oce-runtime-security`. A missing or failed binary prevents the
operation; the controller has no JavaScript provider fallback.

Production and development images build this module in a separate Go stage.
Supply an approved digest-pinned `GO_BASE_IMAGE` alongside `NODE_BASE_IMAGE`.
See the [deployment guide](../../docs/guides/deploy.md).

## Identity diagnostic

Provision a trusted local SPIRE Agent and register the actual diagnostic
process, then run:

```sh
./components/runtime-security/bin/oce-runtime-security identity check \
  --socket-path /run/spire/agent.sock \
  --spiffe-id spiffe://example.org/controller \
  --audience oce-local-diagnostic
```

The optional audience checks real JWT issuance and provider validation. Output
contains identity and expiry metadata only. SVID keys, raw certificates, JWTs
and provider errors are never diagnostic output. This verifies the local
Workload API, not guest attestation, remote-peer authentication or current
runtime authorization.

## Controller protocol

`oce-runtime-security openshell` reads one versioned JSON request from standard
input and writes one versioned JSON response to standard output. Requests and
responses are bounded to 4 MiB. The supported operations are `health`, `create`,
`get` and `delete`; executable commands are not accepted through JSON. Trusted
gateway configuration and launch requirements travel over standard input,
never shell commands or credential-bearing arguments.

The OpenShell package uses the pinned upstream protocol and performs exact
persisted launch-record comparison. The identity package uses the maintained
`github.com/spiffe/go-spiffe/v2` client and parsers. See the living references for
configuration, lifecycle, error behavior and the separate production gates:

- [OpenShell SandboxDriver](../../docs/reference/drivers/openshell-sandbox.md)
- [Workload identity](../../docs/reference/workload-identity.md)

The Go wire suites, real SPIRE tests and compiled-binary controller tests are the
verification for this implementation. Earlier TypeScript test receipts do not
qualify the Go components.
