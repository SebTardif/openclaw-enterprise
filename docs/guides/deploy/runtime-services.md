# Inspect native workload identity and runtime history

These optional operator procedures require protected native executables, an
existing trusted Workload API provider and explicit selected authority. They do
not complete the Agent deployment admission path.

## Check a local workload identity provider

The SPIFFE Workload API component can verify that the current process receives
its exact configured identity from an operator-trusted local SPIRE Agent.
Prepare the provider and register this process through the provider's approved
registration mechanism. For a source checkout, build the diagnostic first;
the controller image already includes `/usr/local/bin/oce-runtime-security`:

```sh
go -C components/runtime-security build -o ./bin/oce-runtime-security ./cmd/oce-runtime-security
./components/runtime-security/bin/oce-runtime-security identity check \
  --socket-path /run/spire/agent.sock \
  --spiffe-id spiffe://example.org/oce/diagnostic \
  --audience oce-diagnostic
```

The optional audience adds JWT issuance and provider-side validation. The command
prints identity and expiry metadata only; it never prints SVID keys or tokens.
It exits nonzero for an unavailable endpoint, wrong identity or failed
validation. It does not alter registrations, select this provider for controller
transport, or establish guest attestation or runtime readiness. See
[workload identity](../../reference/workload-identity.md) for the source API, limits
and troubleshooting, and [gVisor](../../reference/drivers/gvisor.md) for the selected
Crawl runtime's launch requirements. [OpenShell](../../reference/drivers/openshell-sandbox.md)
has separate profile prerequisites and qualification.

## Optional authenticated runtime history readback

Configure this path only for an independent service that needs its own exact
retained runtime operation outcomes. It does not enable runtime mutation, model
access, workload enrollment or positive lifecycle eligibility. The regular
controller deployment route retains its current behavior.

1. Install the protected native `oce-runtime-authority` executable and configure
   its immutable digest, existing Workload API socket, own/recipient SPIFFE ID,
   exact trust bundle and fixed transport limits in a `runtimeAuthoritySources`
   entry. Protect those files and their parent directories using the deployment's
   existing operator custody. Set `OCC_RUNTIME_AUTHORITY_BINARY_PATH` when using a
   path other than the packaged executable. Keep at least two controller database
   pool connections available for the operator path.
2. Use a current human Installation-administrator session to POST a `source-admit`
   operation to `/v1/runtime-service-trust/operations`. Supply a retained UUID
   operation reference, the configured source reference and `expectedVersion:
null` for the first admission. Startup configuration alone admits nothing.
3. Through the same session-protected route, submit `service-admit` with a new
   retained operation UUID, `expectedVersion: null`, `serviceIdentityRef: null`,
   that source reference, the existing exact Namespace/Agent IDs and the intended
   independent peer SPIFFE ID. Retain the returned service identity and version.
   The actual native syntax validator runs before this record commits; the
   registry does not issue the peer's certificate.
4. Select that admitted service in the protected readback JSON and set
   `OCC_RUNTIME_AUTHORITY_READBACK_CONFIG_PATH`. A fresh controller incarnation
   loads current database state before starting the owned native child/listener.
   The binary path and recipient must match the admitted technical source.
5. Withdraw a source or service through the same operator route using its exact
   current version. Source replacement also invalidates previous linked service
   admissions. Re-admission is explicit and advances the retained version.

Every request uses current registry and native transport checks. A lost COMMIT
acknowledgement supplies an exact recovery locator; recover it through
`GET /v1/runtime-service-trust/operations/:operationRef` with the original human
administrator identity before deciding what to do next. A historical replay does
not reactivate a withdrawn admission. Service keys cannot perform these operator
operations.

The [runtime authority reference](../../reference/runtime-authority.md) specifies
closed request/result fields, and the [transport reference](../../reference/runtime-service-transport.md)
describes native TLS, cancellation, restart and cleanup. Local fixture tests
exercise real cryptography and PostgreSQL but do not qualify production enrollment,
network policy, guest identity or timing for a deployed installation.
