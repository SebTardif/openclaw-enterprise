# Runtime authority values and currentness

Part of the [Runtime authority interfaces](../runtime-authority.md) reference.

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
deadline, recipient and request correlation. The implementation awaits a fresh
`inspect` result and enforces its current exact role/scope on every call. Inspection
is asynchronous so a selected native adapter can check the live connection within
the same deadline and cancellation bounds; a cached verification snapshot cannot
replace that check. This local interface does not define an authenticated remote
forwarding protocol.

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
