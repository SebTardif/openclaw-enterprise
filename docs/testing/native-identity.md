# Test native identity

Run the independent Go module's tests on a host that permits local Unix sockets:

```sh
cd components/runtime-security
go mod verify
go vet -mod=readonly ./...
go test -mod=readonly -race -count=1 -timeout=90s ./...
```

Go 1.26 or newer and a C compiler for race detection are required. Dependencies
are pinned in `go.mod` and `go.sum`; the root pnpm build does not compile this
module. The `Native Identity and Service Peer` CI job runs these checks for PRs,
main pushes, merge groups and manual CI dispatch, and contributes to `CI Required`.

## What the tests exercise

The tests run the real source over gRPC and Unix sockets against a disposable
Workload API fixture. That fixture substitutes for the external SPIRE Agent and
issues test-only X.509 certificates. The actual SPIFFE SDK parses
the responses; transport tests perform real mutual TLS with disposable keys.
No live SPIRE installation, provider credential or Agent runtime is required.

| Boundary                      | Cases                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source readiness and lifetime | Startup timeout, cancellation, unavailable sockets, stream failure, expiry and single-use recovery.                                                        |
| Coherent X.509 generations    | Exact identity selection, duplicate/conflicting entries, malformed replacements, collection limits, rotation, defensive copies and concurrent trust views. |
| TLS admission                 | Wrong identity and trust, invalid leaf profiles, mutual authentication, TLS version, exact ALPN and disabled resumption.                                   |
| Connection ownership          | Pending-handshake limits, source/trust rotation, idle expiry, cancellation, blocked I/O, copied handles and borrowed-source lifetime.                      |

These tests establish component behavior at the external API boundary. They do
not qualify live SPIRE issuance, renewal or revocation, gVisor isolation,
represented-Agent enrollment, OCC authorization or a deployed end-to-end runtime.

## Troubleshooting

- `socket: operation not permitted`: run in an environment that permits the
  tests' temporary local sockets. Do not replace them with in-memory parser mocks.
- `SOURCE_UNAVAILABLE` or `IDENTITY_MISMATCH`: check exact configured identity,
  source lifetime and the protected socket. Avoid dumping credential responses.
- `SOURCE_UNSUPPORTED`: the transport rejects CRL-bearing source generations;
  it cannot silently ignore their revocation information.
- `SOURCE_CHANGED` after renewal: reconnect using the live source; existing
  connections deliberately retain their original authenticated certificate.
- Race-detector compiler errors: install a compatible C compiler and enable CGO.

See the [API reference](../reference/native-identity.md) for supported limits and
[component README](../../components/runtime-security/README.md) for notice collection.
