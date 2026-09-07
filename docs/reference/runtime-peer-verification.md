# Runtime peer verification

`packages/occ/src/runtime-identity/peer-verifier-v1.ts` implements the accepted
`RuntimeWorkloadVerifierV1` port. It produces local workload proofs from an
original owned connection and an authenticated canonical runtime registration
reader. A proof identifies an exact registered assignment and bound instance;
operation permission still requires the separate purpose guard and the original
human, turn, model, repository and resource checks.

The [runtime identity contract](runtime-identity.md) owns the unchanged public
port. The [native service peer](native-service-peer.md) owns TLS, source/trust
rechecks and connection closure. The adapter borrows both participants and does
not close their connections or sources.

## Trusted construction

Install `createRuntimeWorkloadVerifierV1({ native, registration })` once at the
accepting service. `native` implements the exported
`RuntimeNativeConnectionInspectorV1<OwnedConnection>`; `registration` implements
the existing `TrustedRuntimeRegistrationReaderV1<OwnedConnection>`. The factory
captures their methods and receivers at construction. Replacing a public object
property later cannot replace a captured participant.

The native participant must inspect the actual owned connection on every call,
using maintained TLS/source/trust checks and the admitted current bundle ledger.
It returns that exact original object, a stable owner-private incarnation token,
peer and recipient correspondence, identity profile and bundle version, original
authentication/expiry times, fresh inspection time and bounded evidence labels.
The token changes only with a new connection owned by the native participant.
It must reject arbitrary objects, copied handles and another owner's connections.
A `Peer` diagnostic or forwarded header cannot supply this callable capability.
The adapter compares observations; it does not implement certificate verification
or invent native bundle anti-rollback state.

The registration participant receives the original connection and the copied,
server-selected expectation. It must perform authenticated current registration
and immutable bound-instance resolution, refusing ambiguity, withdrawal, rollback
and stale evidence. Its canonical registration output remains an observation,
never an independently transferable proof. Parsing a structural registration
record is insufficient to implement this participant in production.

There are no default participants. The accepting service must supply and qualify
the real protected-hop/native integration and its provider-specific configuration.
This module adds no production native message, generated service protocol,
Gateway profile, TLS supervisor, registration store or SDK declaration.

## Verification and proof ownership

Every verification brackets authenticated registration resolution with fresh
native inspection. It validates the exact target's Installation, namespace,
Agent, revision, assignment, component, lifecycle/runtime generation and create
effect against the canonical bound record. It also checks exact peer, recipient,
identity profile, admitted registration/bundle version, observation freshness,
certificate time and connection incarnation correspondence.

Successful verification freezes the diagnostic projection and records the
original connection, immutable allocation/binding, original proof expiry and
monotonic expiry privately. The proof's `verifiedAt` is the native connection's
original authentication time. Its `expiresAt` is the minimum of native expiry,
registration validity, the admitted SVID lifetime and connection maximum age.
Delivering or inspecting a proof does not renew these times.

The private proof map rejects copied, deserialized, prototype-derived and
foreign-verifier objects. All proofs for the same connection share one opaque
`transportBinding`; simultaneous connections have distinct bindings. A reused
connection object with a different native incarnation is denied. The original
bound instance and allocation cannot be changed through a later reader reply.
Assignment record versions cannot roll back after a higher observed version.
Retirement alone does not turn an authenticated workload into a different
identity: current-purpose resolution decides what the retired peer may do.

`inspect` repeats both native checks and authenticated resolution, returning the
same original proof only while its original validity remains intact. A failure
makes that proof terminal, including cancellation and unavailable dependencies.
Callers may request a new proof through the original verifier as appropriate;
a terminal proof itself never becomes usable again. Registration or bundle
version changes deny the old proof. A current validity bound that has shortened
below the original proof expiry also denies it.

`getRuntimeWorkloadVerifierRegistrationV1(verifier, proof)` exposes the original
immutable registration metadata only for this verifier's owned proof. An owning
guard can compare the full target and bound instance after fresh inspection.
The metadata supplies no fresh observation or currentness result, and copied or
foreign proofs return `undefined`.

## Deadlines, cancellation and retained work

Every call retains the original request reference, recipient, signal and finite
deadline. The lookup budget is the minimum of that deadline, the admitted
assignment deadline and an existing proof's monotonic expiry. Wall-clock and
monotonic checks run after every await. Cancellation or a real timer returns
fixed denial promptly; a late dependency result cannot mint or restore proof.

Timed-out work continues to occupy the admitted pending-check capacity until the
actual native or registration promise settles. An owning guard can call
`getRuntimeWorkloadVerifierSettlementV1(verifier, originalSignal)` after starting
`inspect` or `verify` to join that raw work. The returned promise waits for the
actual outstanding work associated with the exact original signal. `undefined`
means the verifier is not owned by this implementation and supplies no settlement
evidence. This local participant does not alter the accepted verifier port or
claim physical native cancellation.

Errors use only the accepted fixed verification or transport codes and the
bounded request reference. Raw provider text, certificates, keys, registration
bodies and exception stacks are excluded. These remain internal diagnostics;
unauthenticated callers require the accepting service's generic error mapping.

## Verification

With the worktree's existing prepared dependencies, run:

```sh
node --max-old-space-size=1536 --test tests/conformance/runtime-peer-verifier-v1.test.mjs
node --max-old-space-size=1536 node_modules/typescript/bin/tsc -p tests/fixtures/runtime-identity-peer/tsconfig.json
```

The conformance suite calls the real verifier with controlled canonical reader
and native timing inputs. It exercises target/peer/recipient/profile/bundle and
immutable binding failures, native changes across the resolver await, copied and
foreign proofs, registration changes, record rollback, retirement, original
expiry, delayed replies, cancellation, actual timer denial and unsettled-work
capacity. These deterministic participants are fixtures, not production issuers.
The strict consumer imports the accepted contract and actual implementation
without an invented SDK declaration.

`tests/fixtures/runtime-identity-peer/main.go` supplies a separate real local
fixture. Generated in-memory signed X.509-SVIDs enter unchanged `identity.Source`
through a local Workload API. Unchanged `servicepeer` owns exact-peer TLS
connections on loopback. Its Node parent retains the original child and pipes,
private connection objects, response sequence and per-request challenge. Native
inspection is callable against that original connection. Diagnostic copies do
not become handles. The test-only command channel has no production export.

The fixture parent handles failed spawn, pre-ready failure, startup abort and
command abandonment through the same retained child ownership. It joins the
actual `close` event, which covers child stdio settlement; an `exit` event alone
is insufficient. Startup waits at most five seconds, commands at most three,
and cleanup has a two-second join budget with a kill escalation after 250 ms.
A cleanup timeout reports `native fixture cleanup unsettled`, retains the child
until actual close and exposes that future settlement promise. It never claims
that requesting a signal proves process or pipe settlement. The Go helper uses
the maintained CLI's duplicated nonblocking owned stdin/stdout pattern, allowing
cancellation to interrupt partial input and blocked output.

Native startup-failure, abort and partial-input cases are authored in the
integration suite. These paths require the later allocated native execution
window; pure conformance and Node syntax checks do not qualify their behavior.

The Node fixture's registration is explicitly controlled canonical input,
separate from native TLS authentication. Its fixed fixture profile and bundle
version are not evidence of admitted production policy or an anti-rollback
ledger. The fixture establishes no sandbox caller/key custody, production SPIRE
enrollment, selected provider acceptance or actual hosted-Harness final hop.

Native execution requires a separately allocated offline Go/local-socket/Node
child window. Build the fixture from `components/runtime-security` using the
existing pinned module dependencies and an explicitly owned output/cache:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOMAXPROCS=1 \
  go build -mod=readonly -p=1 -o "$ownedScratch/runtime-identity-peer" \
  ../../tests/fixtures/runtime-identity-peer/main.go
```

Then, from the repository root, select that absolute binary path:

```sh
OCE_RUNTIME_PEER_FIXTURE_BINARY="$ownedScratch/runtime-identity-peer" \
  node --test tests/integration/runtime-peer-verifier-native.test.mjs
```

Without the explicit binary, the integration suite skips with a stated reason.
The source covers exact peer/recipient, simultaneous connections, reconnect,
certificate expiry, cancellation, stale/delayed resolver replies, foreign and
copied handles and wrong assignment. Writing these fixture sources does not
establish executed native qualification. Production acceptance still requires
the real protected final-hop integration, live lifecycle disable/restart behavior
and measured total denial-budget qualification.
