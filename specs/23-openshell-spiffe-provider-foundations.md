# OpenShell and SPIFFE provider foundations

Status: implemented in Go for the provider protocol and local identity source scope.
Full OpenShell/Kata launch and runtime-bound identity remain unqualified. Current behavior belongs to the
[OpenShell reference](../docs/reference/drivers/openshell-sandbox.md) and
[workload identity reference](../docs/reference/workload-identity.md).

## Problem and scope

OCE delegates dedicated Codex execution to OpenShell, but its original client
accepted an existing sandbox name without checking the persisted launch request.
The client also awaited connection and credential setup before installing its
cancellation listener. An aborted preparation could therefore submit a create.
Both behaviors need correction independently of the remaining Kubernetes launch
compatibility work.

SPIFFE identity support needs an actual Workload API consumer before runtime
transport or lifecycle consumers can use it. This increment adds that provider
component and an operator diagnostic. It does not assign workload identities,
register production workloads, authenticate remote peers, or grant runtime
authority.

## Upstream contracts

- OpenShell's supported lifecycle messages are taken from the pinned public
  [v0.0.113 protocol](https://github.com/NVIDIA/OpenShell/tree/455883905a7ace88e6e69834dc0685bfc799ad44/proto).
  A newer gateway version alone is not evidence that required launch fields are
  supported. Verify the Kubernetes driver schema and actual resulting workload.
- The [SPIFFE Workload API](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_API.md)
  supplies identity material through an operator-trusted local endpoint. X.509
  stream responses replace the previous set; JWT issuance and validation are
  separate operations with explicit audiences.
- [SPIRE v1.15.3](https://github.com/spiffe/spire/releases/tag/v1.15.3) is the
  standalone local verification candidate. Local Unix workload attestation does
  not demonstrate identity delivery or caller binding inside a virtual machine.

## Native implementation boundary

The actual provider implementations are in the Go module
`components/runtime-security`. Its `openshell` package uses generated bindings
from the pinned upstream protobuf schema. Its `identity` package uses the
maintained [go-spiffe/v2 SDK](https://github.com/spiffe/go-spiffe/releases/tag/v2.8.1)
for Workload API and identity parsing. Its `cmd/oce-runtime-security` executable
supplies both the operator identity diagnostic and a bounded, versioned
OpenShell request/response protocol.

The TypeScript controller keeps a thin process adapter for executable selection,
framing, safe errors and cancellation. Protocol, identity, cryptography and
credential handling execute in Go. The controller image builds and includes the
native executable from an explicitly selected Go builder image.

## Implementation and acceptance

| Component              | Required behavior                                                                                                                                                                  | Evidence                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| OpenShell lifecycle    | Read the authoritative sandbox after duplicate or uncertain creation; compare exact ownership and the admitted launch request. Reject conflicting, malformed or ambiguous objects. | Real gRPC serialization and server responses, including nonmatching metadata/spec and transport failures.                        |
| OpenShell transport    | Cancel before submission when preparation is aborted; use configured trust and client credentials for TLS; sanitize failures.                                                      | Actual TLS/gRPC tests, failed trust/authentication and pre-submission cancellation.                                              |
| SPIFFE identity source | Use an explicit local Unix endpoint and exact identity; bound requests/material; replace streaming credentials atomically; deny expired or unavailable identity.                   | Real Workload API wire tests, missing/wrong identity, stream loss, malformed/expired material, cancellation and resource bounds. |
| JWT operations         | Fetch and validate for the explicit audience and exact expected subject using the Workload API.                                                                                    | Positive and negative provider validation, wrong audience/subject and unavailable endpoint.                                      |
| Operator check         | Print only identity/expiry/status; never private keys, JWTs, provider exception text or raw socket paths.                                                                          | Real CLI invocations, malformed arguments, unavailable endpoint and standalone SPIRE success.                                    |

## Remaining integration

The production OpenShell launch still needs supported exact ServiceAccount,
audience-bound projected identity, approved PVC subpaths and Secret reference
transport. Keep unsupported fields as explicit failures. A test-only gateway
bridge does not establish upstream support.

SPIFFE consumption in a selected runtime, including gVisor or a separately
selected OpenShell/Kata profile, additionally needs constrained registration from
authoritative instance assignments, exact remote-peer verification, current
authorization at each effect boundary, bounded renewal and revocation behavior,
and a verified mechanism for the actual execution workload to reach its identity
provider. Mounting a host socket into a VM is insufficient evidence of guest
attestation. Keep these integration requirements separate from local API proof.

Qualification must identify the selected Kubernetes, runtime, networking and
SPIRE tuple, including OpenShell and guest-kernel versions when selected, and test both allowed operations and denied
cross-workload operations. Missing infrastructure remains an unrun qualification
requirement. No direct runtime or credential fallback is introduced by this
increment.

## Completion evidence

The complete Go module passed `go test -mod=readonly -race -count=1 ./...`,
`go vet -mod=readonly ./...`, module checksum verification, and a static native
build. The protocol suites execute actual local gRPC/TLS and Unix sockets,
including raw response bounds, concurrent rotation, cancellation and command
pipe backpressure. The opt-in real SPIRE test is skipped in an unconfigured
local suite and was separately executed against the real provider below.

The controller boundary passed seven tests against the compiled Go executable;
two additional Sandbox startup tests passed. TypeScript, formatting and
workspace boundary checks passed. These results verify provider and process
behavior; they do not run the upstream OpenShell Kubernetes provider.

The final Go source and diagnostic passed a fresh native SPIRE 1.15.3 run:
12 source checks, the checked-in real test with race detection and no skips,
two diagnostic success/failure invocations, and five registration/removal,
recovery and outage checks. The fixture verified actual certificate rotation
and used join-token node enrollment with Unix UID workload attestation.
Provider and fixture processes terminated cleanly. Source and executable hashes
were checked before and after the run. This does not establish separation
between same-UID callers or any runtime-specific attestation path.

Production image execution and full OpenShell/Kubernetes/runtime qualification
remain unrun. The image includes the native executable and linked dependency
notices; the notice collector was exercised locally. The prior TypeScript
implementation and its live receipts are retained only as historical checkpoint
evidence. The remaining integration requirements above stay open.
