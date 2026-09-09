# Authenticated runtime authority requests

The controller exposes selected runtime authority methods through a dedicated
TLS listener. An independent service authenticates with its own X.509-SVID. The
controller reads the current protected service registry and checks its exact
Agent scope and admitted operation policy. The readback profile permits only
`readOperation`. A separately admitted initial-bind profile also permits the
existing `bind` request for an initial dedicated gVisor Harness binding. A third
profile permits exact `discover` and preallocated-candidate `observe` reads for
the admitted Agent’s gVisor Harness through the selected Kubernetes Compute.

The bind service currently returns `rejected-before-effect` with
`lookup-unavailable` when authoritative preparation, approved workload-profile
and protected Compute inputs are unavailable. Authenticating a bind caller does
not satisfy these predicates or write a runtime binding. None of these profiles permits
deploy, evidence submission, retirement, restore, runtime selection or workload
execution.

The implementation uses the existing [native service peer](native-service-peer.md)
and [runtime authority](runtime-authority.md) components. It adds an actual
process boundary: the controller owns a dedicated `oce-runtime-authority serve`
child, its original standard-input/output pipes, and its lifetime. The child
owns the Workload API source, exact mutual TLS connection, original request
bytes and response stream. Peer diagnostics received from another process or
through an HTTP header cannot enter this accepting path.

## Observation reads

The observation listener borrows the observer belonging to the actual bundled
gVisor Compute selected by the installation factory. It cannot attach to an
external Driver, a separately constructed lookalike, or an observer already owned
by another listener. Closing the listener aborts its captured admission lifetime
before releasing the slot; a later listener cannot use an earlier context.

The closed observation envelope contains `schemaVersion: 1`, `method`, `deadline`,
`requestRef`, and `operation`. `method` is `discover` or `observe`; `operation` is
the corresponding complete IFC runtime-effects input. The separate `requestRef`
is a bounded reference, since these input types do not themselves carry one.
The native bridge retains every original byte and the controller checks the exact
parsed request, Agent, recipient, deadline and current admitted service around
fresh challenges of the same TLS connection. The other operation profiles retain
their existing four-field envelope.

Authenticated reads still require independently protected create correlation,
execution, profile and retained observation records. Those production producers
remain uncomposed, so the selected observer returns `incomplete` with
`authority-unavailable` before Kubernetes access when they are missing. A local
collector result or a matching manifest cannot supply these records. These reads
create neither a binding nor target workload identity, serving eligibility or
physical termination evidence. See [runtime effects](runtime-effects.md).

Run `node --test tests/integration/runtime-authority-authenticated-observation.test.mjs`
for the generated-SVID, real TLS/stdio accepting-path tests. Setting
`OCC_RUNTIME_OBSERVATION_DATABASE_URL` to a disposable migrated database with the
limited application role additionally exercises protected registry admission and
withdrawal through PostgreSQL. These tests prove transport/registry/consumer
composition and missing-producer denial; they do not qualify live Kubernetes,
SPIRE enrollment, runsc execution or positive runtime observations.

## Admission and startup

Provision the controller workload with a protected local SPIRE Workload API
socket and an exact X.509-SVID. A deployment-owned source manifest fixes the
own and recipient SPIFFE IDs, source path, trust domain, trust-root reference,
order-sensitive trust-bundle digest, verifier profile, executable digest and
transport limits. The existing authenticated Installation administrator path
admits that source and subsequently admits a service's exact peer SPIFFE ID and
Agent target. Admission uses the current selected IAM driver and persists the
registry change with its audit record. See [runtime authority](runtime-authority.md)
for the management API and registry lifecycle.

All three profiles use `lifecycle-authority` for one exact Agent. The operation policy
constrains this role independently; the role name alone grants no method.

| Operation policy              | Protected source transport profile          | Methods                                                                                                                                                      |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read-operation-only-v1`      | `owned-child-stdio-readback-v1`             | Exact original-service `readOperation`.                                                                                                                      |
| `initial-harness-bind-v1`     | `owned-child-stdio-initial-harness-bind-v1` | Initial Harness `bind` for `occ/kubernetes-gvisor` with `expectedBindingVersion: null`, and independently authorized exact original-service `readOperation`. |
| `runtime-observation-read-v1` | `owned-child-stdio-runtime-observation-v1`  | Harness `discover` and preallocated-candidate `observe` only. No historical readback or binding.                                                             |

The administrator must explicitly select `operationPolicy: "initial-harness-bind-v1"`
when admitting a service against the corresponding protected source. Omitting
the field selects the readback profile and cannot admit an initial-bind or
observation source. Observation admission explicitly selects
`operationPolicy: "runtime-observation-read-v1"` with its corresponding source.
The native parser rejects mixed policy/transport pairs. Ordinary listener
configuration cannot upgrade an admitted service's operation privilege.

The service receives a server-generated
`runtime-service/<UUID>` reference. The technical source manifest cannot come
from the peer or be replaced by ordinary API caller-key authentication. Source
replacement or withdrawal invalidates every service still bound to the previous
source admission; an explicit service admission is required to use a replacement.

`OCC_RUNTIME_AUTHORITY_BINARY_PATH` selects the protected absolute validator and
listener binary. Its packaged default is `/usr/local/bin/oce-runtime-authority`.
This selection is independent of listener configuration, so an administrator
can admit the first service before its generated reference exists in a listener
configuration. Every profile validation compares the actual executable digest,
then invokes its pure `validate-profile` mode. That mode parses the selected
closed profile using the maintained SPIFFE parser; it opens no identity source,
listener or other network connection and grants no authority. Workload API socket
paths are limited to 103 bytes by the actual native Source implementation.

Set `OCC_RUNTIME_AUTHORITY_READBACK_CONFIG_PATH` to a protected absolute file to
start the listener. Omit it to run without this listener. The file contains one
compact, canonical JSON object with exactly these fields:

```json
{
  "schemaVersion": 1,
  "binaryPath": "/usr/local/bin/oce-runtime-authority",
  "listenAddress": "192.0.2.10:9443",
  "recipientRef": "occ/runtime-history",
  "serviceIdentityRef": "runtime-service/00000000-0000-4000-8000-000000000001"
}
```

Replace the illustrative address, recipient and service reference with the
actual admitted values. Generate the file with `JSON.stringify` without a
trailing newline; whitespace and alternate JSON encodings are rejected. The
binary path must equal the independently selected validator binary. The address
must be an explicit IP literal and positive TCP port. This configuration supplies
only the selected listener and existing service reference; it cannot supply a
profile, role, trust bundle or authority grant.
The same startup path selects either already-admitted service profile; its
environment-variable name and closed configuration fields remain unchanged.

The binary and configuration must be regular files owned by root or the
controller user, without group or other write permission. Final symlinks are
rejected. Those stat and hash checks are sanity checks, not the production custody boundary.
In production the executable and its parent directories must be immutable to the
running controller: use a root-owned protected path or a read-only deployment
mount. Controller-owned generated binaries are appropriate only for local source
checks and fixtures. Protect the configuration and deployment mounts from
replacement as well; a file hash is not protection against a privileged writer
changing a path between verification and execution. This path supports local Linux process
and pipe custody; it is not a remote terminator protocol or a process-reattachment
mechanism. The controller starts the binary directly without a shell, inherited
credential environment, or client-selected arguments. Child stderr is discarded.

Use PostgreSQL persistence with at least two pool connections when source
admission or the listener is selected. The composed pool uses a 250 ms connection
checkout timeout. Startup reads the current source/service records anew and
checks the actual executable and native source before becoming ready. A selected
listener which cannot initialize fails startup. If its child later exits, the
controller's production readiness check becomes unavailable. Restoring a source
or record does not revive a retired process; restart the selected composition
against current records.

## Public TLS exchange

Open a fresh TLS 1.3 connection with mutual X.509-SVID authentication. The server
requires the profile's exact peer ID and the client must verify the exact admitted
server/recipient ID. No TLS session resumption is enabled. The independent service
does not borrow the target Agent's SVID.

Each connection carries one request and one bounded response. A frame has a
four-byte unsigned big-endian byte length followed by UTF-8 JSON; the public
payload limit is 65,536 bytes. Use compact canonical JSON with ordinary safe
integer spellings, no duplicate object keys, and depth at most 32. The request's
closed readback envelope is:

```text
{
  schemaVersion: 1,
  method: "readOperation",
  deadline: "<canonical UTC timestamp with milliseconds>",
  operation: <ExactAuthorityOperationV1>
}
```

`operation` is the existing closed exact-operation schema: Installation,
namespace and Agent IDs, operation UUID, operation kind, canonical payload digest
and request reference. Identity, role, cookies, authorization headers and peer
diagnostics are not fields of this envelope. The deadline can shorten the
server's original request deadline and cannot renew it. Extra plaintext, EOF,
cancellation or an invalid request closes the exchange. Clients must keep the
connection open while awaiting the response.

The response is the existing `AuthorityOperationStateV1`, framed on the same
original connection. Current service visibility and original-service attribution
apply to committed historical receipts even after later lifecycle changes.
Malformed, stale, unavailable, wrong-recipient or unauthenticated exchanges never
receive historical data. A connection failure is not permission to use a broader
scope or another service identity.

For the separately admitted initial-bind profile, the same envelope can instead
contain `method: "bind"` and `operation: <BindRuntimeV1>`. The full existing closed
bind schema is parsed before any context is created. Its target and binding must
both name `harness`, the provider must be `occ/kubernetes-gvisor`, and
`expectedBindingVersion` must be `null`. The response is the existing
method-specific `BindingResultV1`. There is no new bind DTO, role field or
caller-supplied context. The native dispatch and the actual service each enforce
the admitted operation ceiling, including when the service is invoked internally.

An accepted transport request reaches the real bind method once with its original
parsed input and request reference. The current rejection creates no operation
receipt. If a future guarded acceptor reports an uncertain commit, recovery must
use an independently authorized exact original-service `readOperation`; neither
an operation reference nor a lost response authorizes a broader retry.

## Current checks and bounds

The controller never serializes a trusted context. Its factory creates opaque
process-local objects only from request events on the exact child it spawned.
Each authentication and asynchronous inspection performs a new challenge on
that child's original pipes, bound to its incarnation, configuration version,
profile digest, connection, exchange, request digest and original deadline.
Inspection checks the actual connection's current Source, both certificates,
trust bundle and recipient. The controller compares the full current registry
record before and after the native challenge. Historical reads perform their
existing before/after authority checks, followed by another fresh check before
returning the result. The child rechecks actual source/trust/connection/time
immediately before writing to the original TLS stream.

The bridge reads `Source.TrustView()` for each trust check. That key-free value
contains metadata, the SHA-256 digest of the ordered own-domain bundle DER and
the CRL count from one current Source generation under its existing lock. The
bridge compares the exact own SPIFFE ID and admitted bundle digest and rejects
CRL-bearing views. It does not copy a private key, certificate, bundle or CRL
buffer for this check. Returned views are historical data; retaining one cannot
replace a fresh Source or connection check. A descriptive federation count does
not introduce an additional bridge admission predicate.

Certificate renewal under an unchanged ordered bundle preserves the admitted
bundle digest, while the old authenticated connection still ends. A new TLS
connection must authenticate the renewed certificate independently. The peer
transport intentionally retains its full credential snapshot for TLS setup,
including the existing key-wiping and Source-lifetime ownership rules.

The service also requires a private request-correspondence check against the
factory-owned context and the original method, full parsed input, request
reference, recipient and deadline. A captured context cannot be reused with
changed bind bytes or a different method. This comparison supplies only another
reason to deny; it neither authenticates the caller nor replaces fresh native and
registry checks. A missing correspondence provider denies.

| Bound                                | Selected behavior                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap and ready delivery         | Three seconds, including incomplete bootstrap input and blocked ready output.                                                                          |
| TLS handshake                        | Three seconds.                                                                                                                                         |
| Original public request              | Three seconds from before the first frame byte; an independent monotonic timer remains armed through parsing, inspection and response.                 |
| Live source/certificate recheck      | One second, with additional checks before inspection and I/O.                                                                                          |
| Maximum authenticated connection age | Thirty seconds, additionally capped by certificate expiry and the one-request deadline.                                                                |
| Capacity                             | One active connection and one pending controller request; reconnect cannot replace work still cancelling.                                              |
| Internal frame                       | 131,072 bytes, with a three-second timer from the first partial-frame byte.                                                                            |
| Blocked parent output                | Bounded write followed by channel shutdown; no unbounded message queue.                                                                                |
| Child shutdown                       | Invalidate contexts first, close owned streams, send TERM, escalate to KILL after 250 ms, and observe exit within three seconds or report unavailable. |

The actual PostgreSQL current/history reads accept cancellation and deadlines.
A checked-out client is destroyed on abort and query rejection is joined. A pool
checkout already in progress is joined through its configured timeout; Node's
PostgreSQL client has no public per-checkout cancellation API. The acceptor keeps
ownership of every started read until cleanup settles and rejects another ingress
while earlier work is still pending. `close()` joins this work and the actual
child exit. No detached worker or old positive result becomes an authority cache.

Source withdrawal, own-certificate rotation, a changed ordered trust-bundle
digest, certificate expiry, current source/service replacement or withdrawal,
process loss and connection closure invalidate the exchange. A removed trust
root is not retained as a fallback. Bundle rotation requires a new explicit
source/profile admission. CRL-bearing sources and federation are outside the
selected native profile; TLS session resumption remains disabled.

These are repeated local and durable-state checks, not atomic remote revocation
or a liveness guarantee. A registry or remote registration can change after its
latest observed check. Individual remote certificate revocation which does not
change available local evidence is not detected. Neither fixture success nor
the executable digest proves production SPIRE attestation, deployment mount
custody, clock quality or universal revocation latency. Bytes already transmitted
cannot be withdrawn. This path supplies no runtime effect guard or positive
active-runtime decision. A future successful bind must compare current
source/service/profile and preparation in the owning transaction, under lock
ordering shared with withdrawal. The current outside-transaction checks do not
establish that future commit serialization.

## Build and verification

The existing image build compiles both native commands from the same pinned Go
module and includes its dependency licenses. Source builds use:

```sh
go -C components/runtime-security build -mod=readonly -o ./bin/oce-runtime-authority ./cmd/oce-runtime-authority
chmod 0555 components/runtime-security/bin/oce-runtime-authority
go -C components/runtime-security test -race ./identity ./servicepeer ./servicebridge ./cmd/oce-runtime-authority
go -C components/runtime-security vet ./identity ./servicepeer ./servicebridge ./cmd/oce-runtime-authority
node --test tests/integration/runtime-authority-authenticated-readback.test.mjs
node --test tests/integration/runtime-authority-authenticated-bind.test.mjs
```

The native tests initialize actual Sources through a controlled local Workload
API and perform real mutual TLS and child-process I/O. The integration suite uses
the actual administrator session, current registry and PostgreSQL historical
operation reader. It also holds a real history-table lock to check cancellation,
non-disclosure and joined query cleanup. The test setup requires disposable local
sockets, the declared Go/Node toolchains and its isolated PostgreSQL fixture;
missing prerequisites are not replaced by simulated authorization. Production
image and deployment qualification remain separate from these local tests.
