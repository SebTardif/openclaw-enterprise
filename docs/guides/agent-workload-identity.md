# Prepare Agent workload identity

The selected repository-read topology is Kubernetes with gVisor `runsc`, the
systrap platform, STRICT isolation, and an operator-managed SPIRE deployment.
The native [identity and TLS packages](../reference/native-identity.md) are the
credential and connection boundary for that route. They do not install SPIRE,
register workloads, or bind an SVID to an Agent by themselves.

## Operator preparation

Provision the SPIRE Server and node Agents through the installation's normal
management procedure. Retain administrative registration credentials outside
Agent workloads. Protect the Workload API socket and every parent directory from
replacement by workload processes; mount only the socket required by the
selected native owner. Sharing a socket or Unix UID does not establish isolation.

Select one trust domain and explicit workload identities for the receiving
mediation service and its admitted peer. Configure the expected peer and
recipient independently of request input, and retain the admitted own-domain
bundle digest. The receiving owner must select its protocol-specific ALPN and
bounded handshake, connection-age and source-recheck limits. Both sides must
present valid X.509-SVIDs from that domain.

Register only the exact admitted execution using protected node and Compute
correspondence. Its record must retain Installation, Namespace, Agent, immutable
revision, current execution and the Agent's existing `servicePrincipalId`.
Pod labels and caller-supplied IDs cannot select that principal. A replacement
execution requires new attestation and a fresh runtime-instance discriminator;
Pod UID and container name alone cannot distinguish a same-Pod restart.

Keep the SPIRE management path and credential-bearing service outside the
untrusted Agent execution. An unrelated Pod, unadmitted container or separately
owned gateway must not receive the Agent's identity, private key or GitHub token.
The Kubernetes runtime and NetworkPolicy configuration must enforce the selected
native route before enabling repository reads.

## Activation boundary

The accepting service must authenticate its original TLS connection, resolve
that connection to the admitted current execution, and authorize the exact
operation through the existing Agent ServicePrincipal's IAM grants and
Restrictions. Successful TLS proves peer identity; it does not prove current
execution eligibility or authorize a repository operation.

The connected repository-read startup change owns that receiving implementation
and its execution-to-principal mapping. Until those owners are configured and
the regular Agent workflow passes its acceptance checks, keep the feature
inactive. Static registration data, a protocol fixture, or a successful source
probe cannot substitute for the current execution reader.

## Acceptance before enabling a deployment

Run the regular Agent repository-read workflow with real identity delivery and
these consequential cases:

- The admitted current Agent reads its authorized repository before Harness
  startup, using its existing principal and exact permissions.
- A different repository, write operation, incorrect Namespace or revision, and
  stale execution all fail before a credential-bearing effect.
- Unrelated Pods, unadmitted containers and a separately owned gateway cannot
  acquire the identity or inherit a token.
- A replacement execution attests freshly; its predecessor cannot resume using
  a retained connection or SVID.
- Trust withdrawal, source loss, expiry and cancellation stop the read and join
  connection cleanup; credential revocation remains with the credential owner.

The [native protocol suite](../testing/native-identity.md) checks source and TLS
behavior with actual sockets and disposable certificates. It does not provide
these installed Kubernetes/SPIRE or regular-Agent acceptance results. Record
those results against the exact deployed source and images before activation.
