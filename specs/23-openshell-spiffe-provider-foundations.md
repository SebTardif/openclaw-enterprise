# OpenShell and SPIFFE provider foundations

Status: Go implementation in verification for the provider protocol and local identity source scope.
Full OpenShell/Kata launch and guest identity remain unqualified. Current behavior belongs to the
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

Production SPIFFE consumption additionally needs constrained registration from
authoritative instance assignments, exact remote-peer verification, current
authorization at each effect boundary, bounded renewal and revocation behavior,
and a verified mechanism for the actual guest workload to reach its identity
provider. Mounting a host socket into a VM is insufficient evidence of guest
attestation. Keep these integration requirements separate from local API proof.

Qualification must identify the actual OpenShell, Kubernetes, runtime, guest
kernel, networking and SPIRE tuple, and test both allowed operations and denied
cross-workload operations. Missing infrastructure remains an unrun qualification
requirement. No direct runtime or credential fallback is introduced by this
increment.

## Completion evidence

Acceptance requires Go race tests and vet, actual local gRPC/TLS and Unix socket
wire tests, a fresh real SPIRE 1.15.3 run against the Go source and diagnostic,
and controller integration that invokes the compiled Go executable. TypeScript
build and formatting checks cover the remaining controller process adapter.

The prior TypeScript implementation and its live SPIRE receipts are historical
checkpoint evidence. They do not qualify the Go implementation. Final native
results belong in the accompanying verification record after those checks run.
The remaining integration requirements above stay open.
