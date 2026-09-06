# Runtime identity verification ports

`@openclaw-enterprise/contracts/runtime-identity-v1` defines the local boundary
between an owned authenticated connection, trusted runtime registration, and
per-operation currentness. It exports TypeScript ports and actual bounded
diagnostic/configuration decoders. It provides no verifier, issuer, registry,
currentness evaluator, stream guard implementation, or proof constructor.

Use these ports with the existing [runtime authority](runtime-authority.md),
[native service peer](native-service-peer.md), and
[protected service transport](runtime-service-transport.md). An authenticated
independent service and an assigned gateway or Harness are different subjects.
Neither supplies an original human's, conversation's, or turn's authorization.

## Values and custody

| Export                              | Meaning                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeWorkloadDiagnosticV1`       | Closed serializable observation with subject/component, assignment, immutable binding version, registration/profile/bundle versions, original verification/expiry times, protected evidence reference, and recipient/connection correlation labels. Parsing establishes shape only.     |
| `VerifiedWorkloadV1`                | Nominal verifier-owned proof bound to the actual accepting connection and recipient. No public constructor, exported brand symbol, or decoder can create it. It authenticates an exact registered workload, including a candidate or retired peer; it is not a serving/operation grant. |
| `RuntimeWorkloadTransportBindingV1` | Opaque process-local connection/acceptor binding. A connection label, socket name, `Peer` diagnostic, forwarded header or serialized proof cannot supply it.                                                                                                                            |
| `RuntimeRegistrationObservationV1`  | Current registration observation from the installed reader, containing the canonical immutable assignment record. It creates no alternative registry and is not transferable authority.                                                                                                 |
| `RuntimeIdentityCheckResultV1`      | Either one unchanged seven-purpose authority result or a separate fixed verification/transport failure. Every positive authority result remains an observation requiring the consuming operation's checks.                                                                              |
| `RuntimeIdentityStreamV1`           | Provider-owned stream/attempt binding with fresh checks, synchronous terminal invalidation, and bounded joined closure. No decoder produces this handle.                                                                                                                                |

The actual provider must enforce private ownership at runtime. Type brands help
prevent accidental misuse; they do not protect against malicious code inside the
trusted process. Copying an object, changing its prototype or reconstructing
fields from JSON does not reproduce the original connection custody.

`RuntimeWorkloadExpectationV1` comes from server-selected target/configuration,
including exact expected peer, recipient, identity profile and admitted limits.
Client destination fields cannot select another registration, peer, profile or
assignment. The proof's subject string is checked by the maintained X.509-SVID
implementation and compared to the exact trusted registration. The diagnostic
decoder does not perform that cryptographic or SPIFFE validation.

## Producing and consuming the ports

`TrustedRuntimeRegistrationReaderV1<OwnedConnection>.resolve` receives the actual
owned, freshly authenticated connection and server-selected expectation. Its
implementation must resolve the exact current registration and immutable bound
assignment, refusing ambiguity, withdrawal, rollback and stale source evidence.
The connection cannot be replaced with a subject string or diagnostic record.

`RuntimeWorkloadVerifierV1<OwnedConnection>.verify` must combine real maintained
X.509-SVID verification with that trusted registration and assignment evidence
before constructing a local proof. `inspect` asynchronously rechecks source,
trust, certificates, recipient/connection incarnation, registration/profile and
bundle state. It returns the same owned proof only while the original expiry
remains valid. Delivering an old observation never refreshes its verification
time or validity.

`RuntimeIdentityPurposeGuardV1.check` composes fresh verification with the actual
`RuntimeAssignmentAuthorityV1.resolve` port. It retains the entire original
request, context, recipient and transport correspondence. A context used for
another request cannot borrow the first request's authority. The guard does not
implement the current human, common-audience, model, repository or immutable
turn/attempt checks; each accepting consumer must compose those before its
specific effect and enforce its actual fence.

| Existing purpose            | Required interpretation                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity-registration`     | Independently authenticated registrar and exact preaccepted registration/maintenance responsibility. Initial issuance does not require the target's SVID.                                        |
| `readiness-probe`           | Exact candidate pairing and admitted probe only; no serving, model, tool or context-write authority.                                                                                             |
| `runtime-peer`              | Current serving peer observation for a separately authorized operation.                                                                                                                          |
| `model-call`                | Exact permitted workload and serving predicates, plus separate original turn/model grants.                                                                                                       |
| `repository-issuance`       | Exact permitted workload and serving predicates, plus separate current common resource authorization.                                                                                            |
| `cleanup`                   | Independent cleanup service and exact preaccepted predecessor effect, without requiring target liveness/SVID or the original actor's continued grant. No successor teardown or purge is implied. |
| `completed-context-restore` | Only the existing exact candidate purpose/suboperation and responsibility, context/store/peer checks. No replay of historical grants or execution.                                               |

The request and result types come directly from the existing runtime authority
leaf. Independent registrar, cleanup and permitted preparation services continue
to use their own actual service contexts at that authority port; the workload
guard is not inserted as a target-SVID requirement into those paths.

The current controller's admitted historical-readback and initial-bind profiles
do not permit purpose resolution. Its authority implementation preserves
`not-visible` or `lookup-unavailable` while real preparation, selection,
registration, Compute/verifier, cleanup and context policy producers are absent.
These new definitions cannot enable that path.

## Request and stream lifetime

Opening a stream binds original connection/recipient/request/purpose/attempt
custody. It does not authorize dispatch or delivery. Each privileged request and
authority-sensitive stream boundary needs fresh verifier/current-purpose and
operation authorization, including on warm connections and simultaneous streams.

The provider retains the original monotonic deadline and uses the minimum of
that bound, stricter operation/profile limits, identity expiry and current
source validity. An awaited lookup, delayed response or retry cannot renew the
budget. Currentness results are never a positive allow cache.

`invalidate` synchronously makes the binding terminal and aborts its signal
before any asynchronous cleanup. Stale/lost/gapped watches, identity changes,
deadline/cancellation and exhausted buffers deny subsequent work. Invalidation
must progress independently of a full or paused data queue; buffered data cannot
be emitted after authority is lost. A late positive response must be rejected
against the original request and incarnation after each await. Refresh cannot
reopen an invalidated connection/attempt; reconnect requires new custody.

`close` itself synchronously denies and aborts before its first await; callers do
not need to invoke `invalidate` first. It is idempotent and joins the guard's owned
checks/subscriptions and stream bindings within the admitted closure bound. Its
closed result means those owned resources settled. `cleanup-unsettled` preserves
incomplete cleanup and remains terminal. Ownership and capacity for unfinished
work stay retained until actual settlement; timeout does not release a slot. Borrowed
Source and connection lifetimes remain with their actual owner. Closing a stream
does not roll back an external effect, prove physical stop, revoke a copied
native token, or turn an unknown provider outcome into success.

## Required limits and error mapping

`RuntimeIdentityLimitsV1` requires explicit resolved profile references and finite
SVID/renewal, evidence/health, lookup/clock, connection/stream, bundle,
invalidation/fence and request/buffering limits. The decoder rejects missing,
unknown, unsafe, nonfinite or inconsistent values and unsafe aggregate buffer
arithmetic. Zero is allowed only for the clock allowance. Configured limits must
also satisfy the actual accepting provider's stricter capabilities and selected
invalidation/fence protocol before use.

Existing runtime authority ceilings remain 15 seconds for relevant observations,
2 seconds for clock uncertainty, 3 seconds for lookup and 5 seconds for active
recheck. They are selected ceilings, not measured guarantees. The existing native
readback profile keeps its tighter 3-second handshake/request, 1-second recheck,
30-second connection and one-connection bounds. No new live values or defaults
are selected by synthetic examples or successful decoding.

| Event or result                                                                                | Local mapping and consequence                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`, `candidate-eligible`, `cleanup-eligible`                                            | Preserve the exact existing purpose/result and original times; perform only separately authorized effects under the actual fence.           |
| `pending`, `not-current`, `not-visible`, `unavailable`                                         | Preserve domain outcome. No effect; hidden state remains hidden; unavailable never falls back to an old observation.                        |
| Invalid/untrusted/expired peer; registration, binding, profile or bundle failure               | Fixed `verification-failure` code internally. No raw certificates, subjects, provider text or registry detail in unauthenticated responses. |
| Cancellation, deadline, EOF/closed connection, framing/protocol error or unavailable transport | Separate fixed `transport-failure`. Do not map it into currentness, acknowledged native cancellation, stopped or a known effect result.     |
| Full buffer or unjoined cleanup                                                                | Terminal denial with `buffer-exhausted` or `cleanup-unsettled`; retain actual effect uncertainty.                                           |

Externally unauthenticated failures are generic. Scoped diagnostics are for an
already authorized observer and include no private keys, provider response body,
credential material or exception stack. Any observation retry must be read-only,
bounded by the original deadline and unable to repeat an executable effect.
Unknown effects retain their original operation and use its existing exact
reconciliation semantics.

## Existing native and process boundaries

The native `servicepeer.Connection` continues to own maintained mTLS,
certificate/source/trust rechecks and transport expiry/closure. Its `Peer` output
is diagnostic and has no runtime registration or anti-rollback ledger. A future
runtime verifier consumes this implementation rather than adding a second TLS
supervisor.

The existing servicebridge keeps the owned Go child and spawning TypeScript
parent pipe, child incarnation, sequence, exact connection/exchange/request
digest and fresh challenge. Only the parent that owns those pipes consumes its
events. The controller's private maps, fresh native inspection and current
registry reads establish local service contexts. These definitions do not widen
its methods or let forwarded events construct a workload proof.

A separately selected independent-service client → existing Go authority acceptor
may use a generated service protocol. Such a migration needs its own exact
method/status/schema/version and owner acceptance. It must preserve the protected
child/parent pipe unless that separate boundary is explicitly replaced. No
protobuf/gRPC migration or serialization of proof, transport binding or authority
call is introduced here.

## Verification and remaining implementations

Run the bounded pure checks with the workspace's prepared dependencies:

```sh
node --test tests/conformance/runtime-identity-v1.contract.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/runtime-identity-v1/verifier-producer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/runtime-identity-v1/stream-guard-consumer.tsconfig.json
```

Both examples are independently authored role views and compile with strict
checks and library checking. They inject dependencies; neither fabricates a
verified connection or evaluates a synthetic provider as actual authority. The
conformance suite executes the real exported diagnostic/limit decoders and exact
existing purpose codecs, with canonical-time, shape, byte, numeric, closed-error
and authority-construction negatives.

The exact authorized `openclaw/plugin-sdk/codex-hosted-harness` declaration is
still required for the native type composition check. Its missing input is not
replaced by a local method/event shape. Native methods and cancellation/reconnect/
attempt semantics remain with their original producer.

Actual registration resolution, runtime proof, stream guarding, gVisor caller
custody and positive authority lookup remain separate implementations. Their
qualification must exercise real TLS/recipient/reconnect separation, warm
requests and streams, late responses, watch loss, full queues, buffered delivery,
bounded cleanup and current effect fencing. Pure decoding and compilation supply
none of those runtime results or a measured disable guarantee.
