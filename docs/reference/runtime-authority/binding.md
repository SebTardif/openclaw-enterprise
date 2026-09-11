# Runtime binding persistence and acceptance

Part of the [Runtime authority interfaces](../runtime-authority.md) reference.

## Current persistence and service boundary

Every `PlatformUnitOfWork` exposes `runtimeAuthority`. Its `appendMutation` method
is an internal OCC persistence operation. It requires an existing exact allocation
and validates the accepted request schema, immutable ownership, current lifecycle
generation and expected assignment version. It does not authenticate the caller,
validate external observation provenance or grant preparation/cleanup permission.
Only the future trusted acceptor may connect it to service requests after those
checks are bound to the authoritative transaction.

The adapters retain one append-only operation history. Each row contains the full
canonical mutation and its immutable receipt together; binding, runtime evidence,
identity evidence and retirement remain distinct record kinds. Allocation is
version `1`; each accepted new mutation advances the assignment record exactly
once. Runtime and identity evidence have independent consecutive versions. An
immutable binding can be observed again with the same instance tuple, but changed
Pod, runsc instance, restart, image or profile fields conflict. Evidence history
has no pointer that turns a newer receipt time into freshness. Neither verified
identity data nor a satisfied runtime observation selects an active runtime.

Retirement records authority withdrawal and preserves the exact responsibility
reference/version supplied by the trusted internal caller. The persistence layer
does not create that responsibility. It records termination and provider credential
revocation as `not-asserted`. An unbound allocation can retire without fabricated
Pod or runsc fields. The current slice cannot remove an active selection and
therefore rejects retirement requests with a non-null expected selection. There
is no transition back from retirement to a bound or active assignment.

The PostgreSQL adapter uses the same Agent lock as runtime intent/allocation
writers, plus serialization of the exact operation ID across different Agents.
Database constraints and a bounded closed-shape validator reject incomplete,
foreign, conflicting or undecodable operation records even through direct inserts
by the limited application role. That role can read and insert history; it cannot
update or delete it. Failed authority mutation validation marks the whole existing
unit for rollback, including when the caller catches the failure or starts two
mutations concurrently inside that unit. The memory adapter enforces the same
state semantics but has no restart or multi-process durability.

`commitRuntimeAuthorityMutation` is internal persistence orchestration. It retains
the pretransaction operation ID and full canonical payload digest and converts a
lost PostgreSQL COMMIT acknowledgement into `commit-unknown` with
`exact-readback-only`. It never retries the mutation or invents a new operation.
Exact original-service replay is compared before current lifecycle/version checks,
so later head changes and retirement do not erase a committed historical result.
Internal scoped readback exposes the retained record without asserting currentness.

`RuntimeAuthorityService` implements the local interface and requires explicit
server Installation, recipient and trusted clock configuration. Its optional
context-factory and current service-registry dependencies have no default trusted
grant: an absent dependency denies. The configured native composition
supplies the actual protected child context and current PostgreSQL registry. Ordinary JSON, service-key admission
and claimed role fields cannot supply a trusted runtime context. It enforces the
interface's role ceiling, current admitted operation policy and exact scope before a potential operation read, and
rechecks current context/registry state before returning an original-service
receipt. The entire read is bounded by the caller deadline and the three-second
lookup ceiling. A private request-correspondence dependency compares the method
and complete parsed input with the native owner's original protected exchange;
missing or changed correspondence denies. It supplies no authentication or
operation grant. These code paths do not establish deployment-qualified timing.

Without an original initial-binding owner, the service rejects all mutation
submissions and returns no positive purpose result. Required protected
Compute/verifier observation, admitted profile,
preparation/selection, cleanup successor exclusion and completed-context policy
readers are not integrated. In particular it does not implement cleanup readback
for a different original service: that requires the separately accepted exact
cleanup responsibility reader. Retained internal storage remains readable after
retirement, while service disclosure stays denied until that narrow guard exists.
There is no provider allocation, route selection, registrar write, runtime start,
credential issuance, context restore or physical teardown in this component.

### Initial binding transaction consumer

`RuntimeAuthorityService` accepts an optional `initialBinding` owner captured at
construction. Its `acceptInitialRuntimeBindingV1` consumer preserves the original
native context and opaque transport identity, and asks that owner to perform the
exact operation on one transaction. Historical replay is checked before acquiring
fresh preparation or profile observations. A new append requires the original
private preparation locator, one exact retained proposal and current independent
proofs; matching request fields cannot supply those proofs.

The consumer checks callback and terminal-result correspondence and joins entered
work. An exact owner `commit-unknown` result survives an earlier callback failure
and retains the original operation for readback only. Cancellation does not
authorize a retry or discard the owner's pending transaction and cleanup.
The consumer creates no transaction, registry grant or default accepting owner.
Production still needs the genuine preparation, profile and protected observation
participants with the owner's final synchronous COMMIT fence.

`PostgresPlatformState.runtimeInitialBindingOwnerV1(source)` supplies the
transaction owner when an original independent proof source is explicitly
provided. It acquires that source on the original PostgreSQL transaction, holds
the binding-operation and preparation association before the Agent lock, and
checks the exact stored result against the callback outcome. Caught, nested or
outlived operations poison the same transaction. Entered operations and source
queries drain before the final synchronous COMMIT fence, and source cleanup
joins after client settlement. Missing proof sources refuse before pool checkout;
stored preparation and matching fields do not establish current authority.

Run `node --test tests/conformance/runtime-initial-binding-owner.test.mjs` for
the owner, locator, replay and cleanup checks. Its transaction transport and
proof participants are controlled, while preparation and authority repository
cases use the actual in-memory implementations. These checks do not establish
PostgreSQL concurrency, durable COMMIT or genuine native observation authority.

Run `node --test tests/conformance/runtime-initial-binding.test.mjs` for the
consumer's correspondence, replay, uncertainty and cleanup cases. The suite uses
the real memory preparation and authority repositories with controlled native,
locator and proof ports. It establishes component behavior, not authenticated
production admission or PostgreSQL durability.

## Preparing an observed binding candidate

The OCC `runtime-authority/binding-candidate.ts` consumer uses the accepted
`RuntimeEffectAdmissionV1` and `RuntimeEffectsV1` ports. It does not start a
runtime or implement those producers. `prepareRuntimeBindingCandidate` accepts
an initial unbound Harness assignment, its retained materialization child and
exact expected gate. It checks the current gate and retained child, discovers
the exact Deployment, observes that same candidate, and checks the gate again.
Incomplete, ambiguous, changed, stale or unavailable inputs produce a sanitized
`RuntimeBindingCandidateError` without submitting a binding.

The proposal preserves the complete immutable binding and original observation
clock. Create-effect correlation comes from discovery's dedicated evidence;
ownership and protected execution correspondence retain their separate
observation references. Different opaque resourceVersions between successive
reads are allowed only for the same exact object UID. The consumer checks the
declared runtime-profile/configuration correspondence and agreement between
desired, delivered and effective policy observations. It does not invent a
derivation for composite profile or image-set digests, authenticate evidence,
or turn a `complete` response into current permission.

The preparation owner must durably retain the returned canonical `BindRuntimeV1`
before calling `submitRuntimeBindingCandidate`. Submission invokes only the
existing authority port, validates returned operation and binding identity, and
retains `commit-unknown` with the original exact readback locator when a possibly
submitted response cannot be established. It never retries, allocates a new
assignment, or recollects evidence under the original operation ID. The caller
must recover using that original retained proposal, even after later intent or
runtime changes.

Production reconciliation does not yet invoke this consumer. The current
preparation gate, protected Compute observation and profile/evidence acceptor
must be integrated before binding can succeed. The authority service continues
to deny mutation submissions, and the native readback-only profile is unchanged.
Gate snapshots are necessary checks, not substitutes for the authoritative
acceptance transaction. Writable preparation still needs its actual prior-writer
barrier; neither this consumer nor binding grants serving, identity readiness,
restore, model or repository access.

Verify the consumer with `node --test
tests/conformance/runtime-binding-candidate.test.mjs`. Its synthetic port vectors
test correlation and failure handling. The actual in-memory service case verifies
denial with unchanged stored assignment when accepting producers are absent.
These checks do not establish Kubernetes, runsc, authentication or termination
evidence. Each port implementation owns bounded cancellation and resource cleanup;
the consumer supplies the original remaining deadline and cancellation signal.

## Verify the implemented storage slice

Run the memory persistence and actual service-denial checks with installed Node:

```sh
node --test tests/conformance/runtime-authority-memory.test.mjs tests/integration/runtime-authority-service.test.mjs
```

Against an explicitly selected, isolated and migrated PostgreSQL 18.6 database,
set `OCC_TEST_DATABASE_URL` to the limited application role and run:

```sh
node --test --test-concurrency=1 tests/integration/postgres-runtime-authority.test.mjs
```

The PostgreSQL suite checks the actual server version and limited role, runs the
same state contract, races independent database clients, exercises direct SQL
constraints and withholds a real COMMIT acknowledgement through the reviewed wire
proxy. An unset database URL explicitly skips this real database suite. The
optional `OCC_RUNTIME_AUTHORITY_RESTART_RECEIPT` path writes exact private test
readback data; after restarting only that owned test database, a fresh process can
verify it with `node tests/fixtures/runtime-authority-state/restart-readback.mjs`.

Persistence fixture values are synthetic ownership/observation inputs to the real
store. They are not trusted context producers, real runsc observations, verifier
proofs, active-selection evidence or runtime qualification. Service-denial tests
exercise actual missing-dependency behavior; authenticated positive service and
purpose eligibility remain unverified until the corresponding producers exist.
