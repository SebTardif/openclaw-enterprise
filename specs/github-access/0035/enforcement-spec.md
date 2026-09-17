# Workload identity enforcement specification

This supporting specification carries the detailed contracts for
[RFC 0035: Workload identity and runtime authority](../0035-workload-identity-and-runtime-authority.md).
[OCE platform design](../../../docs/design/access.md#iam-and-authority) continues to own
authorization, stable Agent identity, Namespace authorization and the single
active revision. The GitHub gateway MVP uses an opaque Agent access token bound
to its original server-owned grant, with current authority checked per operation.
Other OCC and Kubernetes authentication boundaries retain their contracts.
For the optional SVID profile, SPIFFE supplies identity documents and SPIRE supplies
registration and attestation. Neither grants OpenClaw permissions.

The MVP still requires the shared runtime-authentication supplier and its real
Compute/Harness handoff through genuine Work, selected IAM, retained State and
credential custody. Declarations or invented handles do not satisfy that handoff.
The consuming provider adapter and its live qualification remain separate evidence.

## Read the specification

- [Identity, registration and request verification](identity-registration.md)
- [Authority leases and runtime qualification](authority-leases.md)
