# Constrained SPIRE registration client

The Go package `components/runtime-security/registration` performs actual SPIRE
Server Entry API creation, readback and deletion through the maintained generated
gRPC client. It constructs a fixed Kubernetes workload selector set and retains
the original provider operation when a mutation outcome is uncertain.

This is a native provider client. It does not implement OCE Agent enrollment,
registration admission or withdrawal state, runtime verification, or purpose
authorization. Its production application composition is not installed. The
caller must supply the actual OCE responsibility and current immutable runtime
binding described below before using it for registration.

## Supported native boundary

`New(Options)` accepts one exact workload SPIFFE ID, Kubernetes PSAT cluster ID,
Namespace and container name. Those deployment choices remain fixed for the
client lifetime. Construction validates configuration; it grants no registration
authority. The SPIFFE ID must have a workload path outside the reserved `/spire/`
prefix.

The client connects only to an explicitly selected absolute local SPIRE Server
administrative Unix socket. The socket must have no group or other permissions,
must belong to root or the current process user, and must have a canonical path
without symlinks. Its directory chain must prevent unrelated writers from
replacing its owned path; sticky shared ancestors such as `/tmp` are supported.
The directory and socket checks run at construction and each native dial.
The protected process must control this privileged socket. Do not expose this
client, the socket, or configuration selection to a workload request.

The package uses the generated `EntryClient` from
`github.com/spiffe/spire-api-sdk` at
`v1.2.5-0.20260428072036-00f73a61093a`, the version selected by
[SPIRE 1.15.3](https://github.com/spiffe/spire/blob/v1.15.3/go.mod).
It calls `BatchCreateEntry`, `GetEntry`, `ListEntries` and `BatchDeleteEntry`.
The [upstream Entry API](https://github.com/spiffe/spire-api-sdk/blob/00f73a61093a/proto/spire/api/server/entry/v1/entry.proto)
requires local access or an administrative X.509-SVID for these operations.
This package supports the local socket transport only.

## API and retained custody

| API                               | Behavior                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateExact(ctx, ExpectedEntry)` | Checks that the selected subject has no existing entry, generates an entry ID, dispatches one constrained create, checks batch status, and reads the actual entry and complete bounded subject inventory. |
| `ReadExact(ctx, *Registration)`   | Reads the original entry ID, validates its exact contents and retained provider revision, and checks subject uniqueness. It returns a provider observation.                                               |
| `DeleteExact(ctx, *Registration)` | Rechecks the original entry, dispatches deletion at most once, and checks actual absence. A repeated invocation performs readback without retrying an uncertain mutation.                                 |
| `Close()`                         | Cancels and drains the client's native calls and closes its gRPC connection. Cancellation does not imply that a remote mutation rolled back.                                                              |

`ExpectedEntry` supplies the actual attested parent Agent SPIFFE ID and Pod UID,
plus the original assignment reference and canonical immutable binding digest.
The parent must be in the client's trust domain under its exact configured
`/spire/agent/k8s_psat/<cluster>/<node>` path. The assignment reference and binding
digest are retained correspondence labels; their syntax is not proof of OCE
authority or node attestation.

The package constructs exactly these selectors:

```text
k8s:ns:<configured Namespace>
k8s:pod-uid:<original Pod UID>
k8s:container-name:<configured container>
```

X.509-SVID TTL is 300 seconds. JWT TTL is zero, selecting SPIRE's fallback to the
X.509 TTL. Administrative, downstream and SVID-export privileges are false;
federation, DNS names, hint, expiration and additional attributes remain unset.
Callers cannot supply arbitrary selectors or modify these entry privileges.
Readback accepts selector reordering but rejects missing, extra or duplicate
selectors and any changed entry metadata or unknown protobuf fields.

A returned `Registration` belongs to that exact client and invocation. Its
fields are private. Fabricated, copied and other-client handles fail. It cannot
be reconstructed from a serialized `Observation`. Provider observations include
the provider entry ID, provider revision and creation time, original assignment
correspondence and current read time. The upstream
[provider revision](https://github.com/spiffe/spire-api-sdk/blob/00f73a61093a/proto/spire/api/types/entry.proto)
is separate from OCE's registration admission version, and may be zero.

Keep any non-nil handle returned by `CreateExact`, including on error: dispatch
may have occurred. Recover by reading that handle. An absent read after an
uncertain create remains `CREATE_OUTCOME_UNKNOWN`, since the remote create may
still commit. Do not retry by creating another invocation. After an uncertain
delete, the handle remains restricted to readback; actual absence settles local
deletion, and continued presence remains `DELETE_OUTCOME_UNKNOWN`.

Observed metadata changes, invalid inventory, withdrawal by disappearance, and
reappearance after deletion prevent renewed positive observations on that
handle. Reverting provider data cannot reset an observed integrity failure.
Transient provider unavailability returns a fixed failure without replaying a
cached successful observation.

## Required OCE composition

The State and accepting-connection owners must provide all of the following:

- The actual independently accepted `identity-registration` preparation or
  maintenance responsibility before registration, and retained cleanup
  responsibility before deletion. Initial registration cannot require the
  target SVID it is creating.
- The canonical assignment from `RuntimeAuthorityReadRepository`, including
  its immutable bound instance, with actual current protected Compute/node
  correspondence for the parent Agent and Pod.
- The current Agent registration admission/head/withdrawal record, exact
  selected identity profile and bundle-set version, and their correspondence
  to this provider entry and provider revision. This package supplies none of
  those OCE versions or records.
- The original owned, freshly authenticated connection when implementing
  `TrustedRuntimeRegistrationReaderV1.resolve(connection, expected, call)`.
  A SPIFFE string, native `Peer` diagnostic or provider observation alone
  cannot establish that connection's identity or assignment.
- Exclusive registration-writer custody across exact read/delete/readback.
  The upstream deletion RPC takes an entry ID and has no conditional revision
  argument. A competing privileged writer could change an entry between its
  last read and deletion; this client cannot make that sequence atomic.
- Durable operation custody and recovery across process restart. This native
  package retains handles only for its original process lifetime and exposes
  no structural re-enrollment constructor.

**Pod UID plus container name does not attest a particular gVisor execution.**
A same-Pod container restart can preserve both selectors. Exact correspondence
to `runscSandboxId`, `runtimeInstanceRef` and `protectedRestartDiscriminator`
still requires the actual protected runtime observer and immutable assignment
owner. This client does not create that evidence.

The existing `RuntimeServiceTrustService` continues to own DS/broker service
admission and current service/source readback. Those service records are not
Agent registration state. See [runtime identity](runtime-identity.md),
[runtime authority](runtime-authority.md) and
[the local SPIFFE Source](workload-identity.md) for their separate boundaries.

## Bounds and verification

Each operation has a caller-cancelable deadline bounded by the configured
positive timeout, at most three seconds, across all its RPCs. The client permits
at most 16 native operations and one active operation per returned handle;
overflow returns `BUSY`. Responses and requests are bounded to 64 KiB. Subject
inventory is limited to eight pages, 16 entries per page and 1,024-byte page
tokens; repeated tokens, incomplete enumeration and extra entries deny use.
Diagnostics contain fixed codes without raw provider text or identity data.

Run the focused checks from `components/runtime-security`:

```sh
go test ./registration
go test -race ./registration
```

These tests exercise the actual generated gRPC client against a substituted
external SPIRE endpoint on a disposable protected Unix socket. They cover
constrained requests, changed metadata, ambiguous or incomplete inventory,
handle ownership, lost replies, a late create after cancellation, uncertain
delete recovery, rollback denial and post-deletion reappearance. They do not
substitute an OCE enrollment producer or prove live SPIRE attestation, OCE
authorization, gVisor execution identity, restart recovery or deployed service
composition. An environment that prohibits Unix socket creation must run these
checks with explicitly permitted local socket access.
