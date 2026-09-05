# OpenShell gateway client

This Go package implements the OpenShell gateway lifecycle used by the Enterprise
Sandbox Driver. It calls the real gRPC service using generated bindings for the
official `v0.0.113` / `v0.0.116` schema. The JavaScript controller can delegate to
the native runtime-security command; this package owns transport, credential
loading, cancellation, response validation, and launch reconciliation.

## API

`New(Config)` validates configuration without connecting or reading credentials.
The returned client provides `Health`, `Create`, `Get`, `Delete`, and `Close`.
Every operation takes a `context.Context`. `Close` cancels active operations and
prevents new ones.

`CreateRequest` contains `Name`, `Workspace`, string maps `Labels` and
`Annotations`, and `Spec` as `json.RawMessage`. `Spec` uses standard protobuf
JSON, including natural JSON objects for `google.protobuf.Struct`:

```json
{
  "template": {
    "image": "registry.example/runtime@sha256:<digest>",
    "driver_config": {
      "kubernetes": {
        "pod": { "runtime_class_name": "openshell-sandbox" }
      }
    }
  },
  "command": ["/app/agent"]
}
```

This fragment illustrates encoding; the caller must supply the approved complete
launch policy, mounts, identity, and environment. Unknown request fields fail
parsing. A `Sandbox` response contains the provider ID, name, workspace, metadata
maps, launch `Spec` in protobuf JSON, deletion timestamp, and phase.

## Transport and credentials

`Config.Endpoint` accepts HTTPS, HTTP, or a bare host/port pair. HTTPS validates
the server certificate and hostname. `RootCertificatePath` optionally supplies
an explicit CA bundle; otherwise the operating system trust store is used.
`ClientCertificatePath` and `ClientPrivateKeyPath` must be configured together
when the gateway requires mutual TLS.

`AuthMode` is `unauthenticated` or `bearerTokenFile`; an omitted mode selects
`unauthenticated`. Bearer mode requires `BearerTokenPath`. All credential paths
must be absolute. Credential-bearing cleartext configurations fail validation.
Certificates are loaded for each operation; the bearer token is read for each
RPC. No caller-provided outgoing gRPC metadata is forwarded.

The opened credential descriptor must be a regular file, allowing Kubernetes
projected-volume symlinks while rejecting FIFOs and devices. Reads are capped at
1 MiB for certificates/keys and 64 KiB for bearer files. Nonblocking file opens
and operation contexts keep delayed credential setup from causing a late RPC.
`RequestTimeout` defaults to 10 seconds and must be between one and 60 seconds.
One deadline covers setup and the entire operation, including create readback;
an earlier caller deadline takes precedence. The native helper targets Linux.

For an OpenShell Kubernetes gateway, mutual TLS authenticates transport. User
and workspace authorization still requires the operator's bearer or trusted
access-proxy configuration. The caller needs `sandbox:write` for create/delete
and `sandbox:read` for readback. `Health` does not prove these permissions.

Exported `Error` values expose fixed `Code` and optional `GRPCCode`
classifications. They do not retain remote details, credentials, local path
errors, metadata, or raw causes. Context cancellation and deadline errors support
`errors.Is` with the corresponding standard context error.

## Lifecycle checks and limits

Create validates the returned Sandbox and its authoritative `GetSandbox`
readback. Names, workspace, all requested ownership metadata, and the complete
launch specification must match. Gateway-added metadata is allowed. Unknown
launch fields in responses fail before JSON projection, including nested fields.
Comparison uses `proto.Equal`, preserving optional-field presence while
normalizing protobuf defaults. The provider ID must remain the same
between a successful create and its readback. A Sandbox being deleted fails
reconciliation.

`ALREADY_EXISTS`, `UNAVAILABLE`, `DEADLINE_EXCEEDED`, and `UNKNOWN` can trigger
one readback while the operation context remains active. Only a matching record
permits success. Missing records, malformed responses, denied reads, and
cancellation remain failures. Delete requires an affirmative `deleted` response
or `NOT_FOUND`.

These checks establish correspondence with persisted gateway launch intent.
They do not establish live Pod identity, readiness, effective supervisor policy,
or physical workload absence. The public API does not expose an authoritative
Pod UID or accept an immutable identity precondition on deletion. A missing
gateway record does not establish that an uncertain create had no provider
effect. Cancellation cannot roll back an already accepted request.

The existing upstream gaps for exact per-Agent ServiceAccounts, projected token
volumes, and `secretKeyRef` environment entries remain. This package does not add
unsupported launch fields or bypass the controller's launch restrictions.

## Verification and provenance

From the `components/runtime-security` module directory:

```sh
go test -mod=readonly -race -count=1 ./openshell/...
go vet -mod=readonly ./openshell/...
CGO_ENABLED=0 go build -mod=readonly ./openshell/...
```

The tests use actual local gRPC servers, native Go-generated TLS certificates,
independent protobuf wire vectors, and real filesystem operations. They cover
readback correspondence, unknown fields, optional presence, duplicate outcomes,
deadlines, cancellation, credential handling, and mTLS. They do not run an
upstream gateway or a Kubernetes provider. Linux FIFO coverage uses the native
system call and does not require an external `mkfifo` or OpenSSL binary.

The adapted protocol and generated bindings retain upstream licensing and source
pins in [pb/NOTICE.md](pb/NOTICE.md). That file also records the generator versions
and regeneration command.
