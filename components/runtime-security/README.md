# Runtime security components

This Go module implements the OpenShell gateway client and the SPIFFE Workload
API identity source, native service-peer transport, and authenticated runtime
operation readback bridge. The existing OCE controller invokes the compiled executables
through a small TypeScript process adapter. Gateway protocol interpretation,
TLS credentials, launch-record checks and workload identity handling run in Go.

## Build and verify

Use the Go version declared in `go.mod` or a compatible newer toolchain:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
go -C components/runtime-security build -o ./bin/oce-runtime-authority ./cmd/oce-runtime-authority
chmod 0555 components/runtime-security/bin/oce-runtime-authority
go -C components/runtime-security test -race ./...
go -C components/runtime-security vet ./...
```

Configure the OpenShell Driver's `gateway.binaryPath` with the absolute path to
that binary when running from a source checkout. The packaged default is
`/usr/local/bin/oce-runtime-security`. A missing or failed binary prevents the
operation; the controller has no JavaScript provider fallback.

Production and development images build this module in a separate Go stage.
Supply an approved digest-pinned `GO_BASE_IMAGE` alongside `NODE_BASE_IMAGE`.
Images include the linked third-party licenses and module versions under
`/usr/share/licenses/oce-runtime-security`.
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
Workload API. Runtime attestation, remote-peer authentication and current
runtime authorization require separate integration and verification.

## Test-only full-set observation

`testfixtures/spire-first-observation` is a separate bounded Go observer for
real SPIRE delivery inside explicitly prepared gVisor workloads. It observes
every delivered X.509 entry before SDK selection and requires a denied request,
protected registration/mapping gate, delivery on the same connection, and
confirmed close. Its metadata output does not establish native application
consumption or current runtime authority. The ordinary `identity check`
diagnostic reports its selected identity and cannot establish full-set
exclusivity. See the [fixture README](../../tests/fixtures/spire-first-observation-v1/README.md)
for build checks, the explicit profile artifact/hash selectors, live opt-in and
separate ownership of the prepared environment. The selected runtime requires
systrap/STRICT, `--host-uds=open` and `--network=none`; effective runtime and
guest-network isolation checks remain part of the unrun live integration.
Both workload Pods coexist; only their identity-observer phases run serially.

## Controller protocol

`oce-runtime-security openshell` reads one versioned JSON request from standard
input and writes one versioned JSON response to standard output. The command
bounds incomplete input and blocked output to five seconds and honors process
cancellation. Requests and
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

## Runtime operation readback

`oce-runtime-authority` is a separate dedicated command for the controller-owned
historical readback listener. Its pure `validate-profile` mode is used during
protected service admission; `serve` owns the actual Source, mutual TLS listener,
one-request connections and bounded parent pipes. It grants no runtime mutation.
The existing OpenShell command and identity diagnostic are separate consumers.

See [authenticated runtime operation readback](../../docs/reference/runtime-service-transport.md)
for the exact admitted source/profile, independent validator binary selection,
listener startup file, framing, repeated current checks and real tests.
