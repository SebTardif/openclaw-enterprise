# Native GitHub read transport

The native read transport carries GitHub repository reads through an authenticated
broker connection. It is an implementation component of Agent repository checkout;
the regular Agent deployment and checkout owner are not connected in this version.
Installing either executable alone does not enable repository access.

## Responsibilities

The Git listener accepts Git protocol v2 discovery and upload-pack for one fixed
GitHub.com repository. It validates the request body and returned pack, bounds
response retention, and rejects writes and requests for another repository. The
broker supplies each installation token outside Agent execution; the native
listener substitutes that token only for the admitted upstream request. Owned
credential buffers are cleared during disposal.

`oce-github-mediation` owns the other end of that broker connection. It reads its
X.509 SVID from the selected Workload API and authenticates the configured peer
through mutual TLS. Its parent must supply original Work authorization, current
execution correspondence, protected credential custody and committed dispatch.
Wire identifiers select existing exchanges; they cannot create those permissions.

The parent owns both processes and their private input/output pipes. Each native
session and request has fresh correlation, a fixed monotonic deadline and bounded
retirement bookkeeping. An interrupted write has an uncertain outcome; a native
write acknowledgement establishes socket submission only. Shutdown joins owned
connections and removes only the original Unix socket inode. A stale cleanup
cannot close a successor connection.

## Configuration boundary

The broker executable supports `serve` and `validate-profile` through inherited
pipes. A profile pins the Workload API socket, own and peer SPIFFE IDs, trust-bundle
digest, protected Unix listener, peer UID and finite handshake/request limits.
Profile validation opens no identity source or listener and grants no authority.

The selected Git profile uses protocol version 3 and ALPN
`oce-github-git-read-v3`. Metadata reads use the separate protocol version 2
profile. A caller cannot select a different profile through request metadata.
Wrong SPIFFE identities, bundle changes, source withdrawal, expired exchanges,
replayed control messages and writable or symbolic-link socket ancestors fail
closed.

The Git child receives an already-bound listener and protected launch inputs.
Those descriptor checks establish correspondence, not repository permission.
Production deployment must retain the original identity, State, Work and native
owners through the complete read and cleanup operation. No GitHub App signing key
or installation token belongs in the Agent environment or workspace.

## Remaining checkout integration

The regular deployment path still needs to carry the admitted repository and
immutable commit into its original Work owner, construct the protected issuer,
perform the read into the Agent's staging workspace, verify the checkout and start
the Harness only after admission succeeds. Cancellation and revocation must join
credential and native cleanup before releasing those owners.

This component must land with that working caller. Its transport checks do not
establish SPIRE installation, Kubernetes attestation, IAM admission, GitHub App
compatibility, successful Agent checkout or Harness startup. See the
[native read test guide](../testing/native-github-read.md) for the exact executable
and external-service boundaries exercised by tests.
