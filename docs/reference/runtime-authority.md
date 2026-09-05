# Runtime authority interfaces

`@openclaw-enterprise/contracts` exports the versioned local
`RuntimeAssignmentAuthorityV1` interface and strict structural parsers for its
requests and results. The interface separates immutable runtime identity,
versioned evidence, purpose-specific currentness, and retained operation receipts.

OCC now persists immutable runtime binding, separately versioned evidence,
retirement and exact operation receipts in its existing memory and PostgreSQL
state adapters. The local service boundary denies mutations and positive purpose
resolution until its trusted transport, observation and acceptance dependencies
are integrated. There is no installed transport-context producer or runtime
effect implementation behind this boundary. Current controller deployment
behavior is described in [Controller reconciliation](controller.md).

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
implementation: an absent dependency denies. Ordinary JSON, service-key admission
and claimed role fields cannot supply a trusted runtime context. It enforces the
interface's role ceiling and exact scope before a potential operation read, and
rechecks current context/registry state before returning an original-service
receipt. The entire read is bounded by the caller deadline and the three-second
lookup ceiling. These code paths do not establish deployment-qualified timing.

The service currently rejects all mutation submissions and returns no positive
purpose result. Required protected Compute/verifier observation, admitted profile,
preparation/selection, cleanup successor exclusion and completed-context policy
readers are not integrated. In particular it does not implement cleanup readback
for a different original service: that requires the separately accepted exact
cleanup responsibility reader. Retained internal storage remains readable after
retirement, while service disclosure stays denied until that narrow guard exists.
There is no provider allocation, route selection, registrar write, runtime start,
credential issuance, context restore or physical teardown in this component.

## Imported surface

```ts
import {
  parseRuntimeAuthorityV1,
  parseRuntimeAuthorityJsonV1,
  parseRuntimeMutationResultV1,
  canonicalRuntimeAuthorityMutationV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAuthorityContextFactoryV1,
} from "@openclaw-enterprise/contracts";
```

| Method           | Required meaning                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bind`           | Record one exact provider instance against an existing allocation under lifecycle and record version checks. The binding cannot be changed in place.               |
| `recordEvidence` | Append a separately versioned runtime or identity observation. New receipt time cannot make an old source observation fresh.                                       |
| `resolve`        | Evaluate one exact assignment and purpose using current authoritative state and independently verified service context.                                            |
| `retire`         | Withdraw the assignment's authority while retaining its exact cleanup responsibility. This does not assert physical termination or provider credential revocation. |
| `readOperation`  | Read the exact retained mutation outcome using its original operation identity, scope, kind, and canonical payload digest.                                         |

Existing `RuntimeAllocation`, `RuntimeIntent`, `RuntimeScope`, and related value
types retain their fields and OCC state-module imports. The allocation's
`bindingCondition: "unbound"` records its original inert allocation. A separate
binding projection supplies later instance identity; it does not rewrite that
allocation field or create another intent authority.

## Binding and evidence

The direct gVisor harness variant requires an actual Deployment UID, verified
Deployment-to-ReplicaSet-to-Pod ownership, cluster and Namespace identity, Pod UID,
runsc sandbox and execution identity, and a protected process restart discriminator.
It also records the admitted image, binary, distribution, flags, configuration
and policy identities, with `oce-gvisor-systrap`, systrap and STRICT selected.
An OpenShell sandbox field is rejected for this variant.

The direct Kubernetes gateway has a separate variant with an explicit scheduling
profile and protected execution/restart identity. A default-scheduling descriptor
does not prove that a provider observed that configuration.

Bindings use version `1`. A different Pod, execution instance, restart discriminator
or immutable profile tuple requires replacement. New observation references and
timestamps belong to separate evidence, so a valid observation refresh does not
rebind the assignment. Image entries have unique names in ascending ASCII order.
Registry references identify protected records; their syntax is not proof of
ownership, admission or observation capability.

Cleanup also has a closed `owned-provider-object` target for an exactly correlated
Deployment that must be removed before any Pod or execution binding exists. It
requires the retained assignment/effect, provider/cluster/Namespace/Deployment
identity, protected ownership evidence, successor exclusion and current cleanup
preconditions. Its only operation is `remove-provider-object`; it contains no
invented Pod, runsc identity or claim of termination. The existing fully bound
cleanup target remains separate.

The selected upper bounds are 15 seconds for original observation age, 2 seconds
for trusted clock uncertainty and 3 seconds for authority lookup. Active use
requires rechecks at most every 5 seconds and at each privileged accepting
boundary. More restrictive operation policies prevail. These are implementation
requirements, not measured service guarantees. A real authority must use its
trusted clock and dependencies, preserve original observation times, and deny
when required evidence or policy cannot be checked.

## Purpose-specific results

| Purpose                     | Eligible result      | Additional boundary                                                                                                                                                    |
| --------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity-registration`     | `candidate-eligible` | Independent constrained registrar and exact current preparation or maintenance responsibility; initial registration cannot require the target identity it is creating. |
| `readiness-probe`           | `candidate-eligible` | Exact admitted candidate pairing and permitted endpoint/probe. No serving prerequisite or model, tool, or conversation permission.                                     |
| `completed-context-restore` | `candidate-eligible` | Exact accepted `importCompletedContext` or `readImportedContext` responsibility, checkpoint, stores, configuration, pair, current policy and receiver guard.           |
| `runtime-peer`              | `current`            | Current running intent, exact active selection, verified peer/component, fresh required evidence and observed serving.                                                 |
| `model-call`                | `current`            | The serving predicates plus separately enforced current original-turn, account, context and model authorization.                                                       |
| `repository-issuance`       | `current`            | The serving predicates plus separately enforced exact repository and permission grants.                                                                                |
| `cleanup`                   | `cleanup-eligible`   | Independent cleanup service, retained exact predecessor responsibility, immutable ownership, successor exclusion and current cleanup effect conditions.                |

The other results are `pending`, `not-current`, `not-visible` and `unavailable`.
They deny the requested effect. `not-visible` has a constant non-disclosing shape
with no assignment, principal, tenant, operation or existence details.

A positive result is an observation at evaluation time. It is not a transferable
capability, a cached authorization decision or a replacement for current operation
policy. Candidate and cleanup results contain no invented serving selection version.
Restore permits only its quiet import/readback operation; an old receipt or historical
turn grant cannot authorize a later import, disclosure or activation. Retained cleanup
may survive stop, retirement, original-actor revocation and target identity expiry,
but cannot create, resume, purge or touch a successor.

## Trusted context and exact outcomes

The actual selected transport adapter must supply
`RuntimeAuthorityContextFactoryV1`. Operator-controlled service identity, trust
roots, verifier profile, role, scope and recipient are explicit configuration
references. The factory authenticates independently provisioned services and keeps
the real transport correspondence in process-local handles. Ordinary JSON and
`verified: true` cannot construct those handles. Type branding prevents accidental
misuse; it is not an authentication implementation.

Each authority call carries the trusted handle, cancellation signal, bounded
deadline, recipient and request correlation. The implementation must inspect the
handle and enforce its current exact role/scope on every call. This local interface
does not define an authenticated remote forwarding protocol.

`RUNTIME_AUTHORITY_ROLE_POLICY_V1` defines the closed maximum role permissions.
Every unlisted method, purpose or suboperation is denied. The configured verified
service identity, current exact scope/profile and purpose predicates are still
required; the table is not an authorization decision or a new role store.

| Verified role         | Mutation submissions   | Resolve purposes                              | Exact mutation readback                    |
| --------------------- | ---------------------- | --------------------------------------------- | ------------------------------------------ |
| `compute-observer`    | Bind; runtime evidence | None                                          | Original service only                      |
| `identity-verifier`   | Identity evidence      | None                                          | Original service only                      |
| `lifecycle-authority` | Bind; retire           | None                                          | Original service only                      |
| `registrar`           | None                   | Identity registration                         | None                                       |
| `readiness-prober`    | None                   | Readiness probe                               | None                                       |
| `runtime-transport`   | None                   | Readiness probe; serving runtime peer         | None                                       |
| `model-mediator`      | None                   | Model call                                    | None                                       |
| `repository-issuer`   | None                   | Repository issuance                           | None                                       |
| `cleanup`             | None                   | Exact cleanup                                 | Accepted exact cleanup responsibility only |
| `restore-preparer`    | None                   | Completed-context import or receiver readback | None                                       |
| `restore-receiver`    | None                   | None through this resolver port               | None                                       |

OCC remains the sole binding, evidence and retirement writer. A lifecycle caller
cannot fabricate Compute proof to bind an instance. Runtime evidence requires the
independent Compute producer; identity evidence requires the independent verifier.
Original-service readback also checks the exact scope, operation kind, payload and
original attribution. Cleanup readback is limited to necessary retained predecessor
records under its accepted responsibility.

The restore receiver's separate native claim/report boundary cannot grant it
canonical context read, import initiation or runtime selection. Its actual accepting
operation still needs a fresh current-purpose check and the real exact receiver
effect guard. Excluding it from this resolver's caller permissions does not waive
that guard or create an alternative authority. A gateway may act as a restore
preparer only when independently and explicitly assigned that exact role.

Mutation results distinguish `applied`, `exact-replay`, `rejected-before-effect`,
`conflict`, and `commit-unknown`. The canonicalization helper returns deterministic
UTF-8 payload text for SHA-256 operation identity. Request correlation is excluded;
the operation ID, CAS values and all effect data remain. Changed payload under the
same operation ID conflicts. Historical exact replay/readback can return the
retained receipt after later heads or worker completion, but grants no currentness
or new effects.

After an unknown acknowledgement, only exact readback is permitted. A `not-found`
or unavailable readback does not prove the earlier transaction/effect cannot still
complete and cannot authorize a new create. Method-specific result decoding also
rejects a well-formed receipt for a different mutation method.

## Verification and remaining implementation

The parsers reject unknown fields and versions, duplicate JSON keys, malformed
identifiers/digests, unsafe counters, incompatible purpose/result combinations,
intrinsically impossible timestamp ordering and unsupported binding variants.
JSON integer values use canonical unsigned decimal tokens: fractional, exponent
and negative-zero spellings are rejected before a rounded value can pass a schema.
They return frozen data and never fetch registry references or mint trusted context.

Run the focused contract checks and separate compilation fixtures from the
repository root after installing the workspace's declared dependencies:

```sh
node --test tests/conformance/runtime-authority-v1.contract.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.producer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.run-consumer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.credential-consumer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.type-negatives.json
```

The producer fixture remains unavailable; it cannot grant runtime authority. The
consumer fixtures exhaustively classify contract results without executing effects.
These checks establish exported type compatibility and structural validation only.
They do not qualify authentication, persistence/replay transactions, runtime
discovery, restart correlation, registration, model mediation, restoration or stop.

Actual implementations still need the trusted context factory, authoritative
registry/policy reads, transactional OCC writer, exact protected observations and
accepting-boundary effect guards. For direct gVisor, observed predecessor
termination and resolution of possible creates are required before any writable
successor, including initialization, restoration and repair. A generic fence,
lease, valid certificate or syntactically valid evidence reference cannot substitute
for that proof.

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
