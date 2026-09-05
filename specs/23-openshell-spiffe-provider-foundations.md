# OpenShell and SPIFFE provider foundations

Status: implemented for the provider protocol and local identity source scope.
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

The OpenShell protocol suite passed 40 tests over actual local gRPC/TLS; its
startup integration passed two additional cases. The SPIFFE configuration
suite passed 19 cases and its Unix gRPC wire suite passed 37. The operator
diagnostic's three tests passed after integrating the real source.

Native SPIRE 1.15.3 passed the checked-in real integration test without skips.
A separate bounded fixture exercised 17 additional issue, renewal, denial,
registration-removal, recovery and outage checks; actual diagnostic invocations
also passed success and wrong-identity failure cases. The fixture used
join-token node enrollment and Unix UID workload attestation. Those results do
not prove separation between same-UID processes or the production guest path.

TypeScript, formatting and workspace boundary checks passed for the worker
implementations. Source and protocol files in the integrated tree match the
tested worker revisions byte-for-byte. The listed suites ran separately. The
remaining integration requirements above stay open.
