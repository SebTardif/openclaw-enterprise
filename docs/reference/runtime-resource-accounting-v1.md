# Runtime resource accounting V1

`@openclaw-enterprise/contracts/runtime-resource-accounting-v1` exports an immutable
resource-accounting envelope and a synchronous, pure validation port. Its version is
`runtime-resource-accounting-v1`; envelope `schemaVersion` is `1`. This is an
implemented in-process contract for development and verification consumers. It does
not configure Kubernetes, authorize a profile or Job, enforce limits, or certify
measured production capacity.

The callable `runtimeResourceAccountingV1` object implements
`RuntimeResourceAccountingV1`:

```ts
import { runtimeResourceAccountingV1 } from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

const envelope = runtimeResourceAccountingV1.parse(ownerSuppliedInput);
const result = runtimeResourceAccountingV1.validate(envelope);
const requestBudgetMs = runtimeResourceAccountingV1.deadlineBudget(
  "providerRequestMaxMs",
  remainingMs,
  purposeMaxMs,
);
```

`parse` accepts bounded plain data, checks its closed schema, reuses the existing
runtime-effect parser for supplied observations, and returns a detached, deeply
frozen snapshot. Invalid data throws one non-disclosing error. `validate` accepts
unknown input and returns a deeply immutable result; malformed input produces
`invalid-input` without echoing the value. Neither function resolves references,
contacts a provider, reads a clock or supplies missing values.

## Owned inputs and units

The envelope requires separate `gateway`, `harness` and `repositoryPreparation`
inputs, an explicit `workloadConcurrency` declaration, external reservations,
retained stores and node budgets. Each required input uses one of four states:

| State         | Meaning                                                                        |
| ------------- | ------------------------------------------------------------------------------ |
| `required`    | The original owner has a required input to supply.                             |
| `supplied`    | `ownerRef` and a value were supplied for arithmetic validation.                |
| `unavailable` | The original owner's value or producer port is currently unavailable.          |
| `unsupported` | The selected producer reports unsupported accounting or profile applicability. |

Every state names an `ownerRef`, which is provenance data rather than authenticated
ownership. The selected source owners and accepting consumers must verify the actual
provenance, completeness and correspondence of those inputs. Omitting a required
field is malformed. Required, unavailable and unsupported inputs remain distinct
incomplete-accounting diagnostics; they do not mean zero.

Quantities are safe, nonnegative integer base units: CPU in millicpu, memory and
storage in bytes, host tasks and guest processes in counts, and explicit time fields
in milliseconds or seconds as named. Resource vectors contain `request` and `limit`
for all three dimensions. Request must not exceed limit. Strings such as `500m` or
`1Gi`, fractional numbers, nonfinite values, unsafe integers and negative zero are
rejected. A resource normalizer must independently translate its accepted quantity
syntax into these units. No quantity syntax or infrastructure default is inferred
by this module. Positive process limits, finite log limits and positive execution
limits are required whenever their input is supplied. Explicit zero resource costs
remain finite supplied values; consumers decide whether they are applicable.

The contract contains no production resource defaults. Existing selected gateway,
Harness and private-state init CPU/memory requirements remain the responsibility of
their producer. Missing init ephemeral storage, concurrency, overhead and external
reservations must still be supplied. The known 1 GiB runtime-home and 64 MiB temporary
mount bounds do not determine how much capacity an owner reserves for them. Retained
40 GiB workspace and 10 GiB private-store targets do not establish actual allocation,
store binding or durability.

## Concurrent execution and overhead

Each supplied workload lists its application, ordinary init, restartable init and
helper contributions, with separate owned inputs for each resource dimension. There
must be exactly one application contribution. Its original producer declares all
possible concurrent contribution sets in `phases`:

- Sum requests and limits inside each phase, then take the componentwise maximum
  across alternative phases. Two concurrent init contributions therefore add; two
  mutually exclusive init phases contribute their maximum.
- Exactly one steady phase includes the application, all ordinary helpers and all
  restartable init contributions. Ordinary init is excluded from that steady phase.
  Every listed contribution must occur in at least one phase.
- Phase membership must reference listed contributions exactly once. The validator
  checks declared membership; it does not discover Kubernetes execution order or
  prove that the owner enumerated every possible overlap. The original producer
  must account for persistent sidecars, startup, retries and cleanup as applicable.

Runsc and host-helper overhead have separately identified contributions and an
explicit `chargedTo` location. `pod` overhead adds once to the workload phase peak;
`node` overhead adds once outside the declared Pod envelope. Harness and repository
preparation accounting require exactly one runsc overhead entry when their overhead
input is supplied. A gateway can explicitly supply an empty overhead set. Missing
overhead remains missing, never zero. An already-included cost must not be supplied
again under another name: the original owner supplies stable accounting IDs for
physical costs. Duplicate IDs across contributions, overhead, external reservations
and storage buckets are rejected. Repeating a contribution across alternative phases
is expected and is not duplicate charging.

The phase peak must fit `podBudget` in both requests and limits. Node arithmetic
reserves that full declared Pod envelope, plus node-charged overhead, multiplied by
`execution.maxConcurrentInstances`. It never reclaims the difference between a
smaller phase peak and a larger declared envelope. `maxAttempts` and the total
preparation budget are finite operation-wide limits; sequential attempts are not
multiplied as simultaneous Pods. Preparation cannot exceed the existing 900-second
ceiling, and a stricter purpose deadline still wins.

`workloadConcurrency` names the possible concurrently reserved workload types,
including preparation. All three types must be covered and gateway/Harness overlap
must be present. Sum each group, take its componentwise maximum, then add every
external reservation. The separate preparation Job can have different concurrency,
resources, attempts, processes, logs and storage from the Harness. An unavailable
Job input prevents a complete node aggregate. The contract supplies no Job effect,
identity or observer applicability and has no Harness-inheritance branch.

## Processes, logs, stores and precedence

Each workload supplies distinct guest-process and Pod host-task limits and budgets.
The host budget explicitly covers all workload, runsc and helper host tasks; it is
not computed by equating guest processes with host tasks. Its demand must fit its
limit. Node host-task arithmetic accounts for concurrent workload instances and
external service tasks, then compares `nodeHostTaskLimit`. A host task cap such as
256 never becomes a guest-process cap or an exhaustion-test result.

Each ephemeral store is an identified capacity bucket with an explicit
`reservedBytes` value and a separate capacity ceiling. Its reservation must fit that
ceiling. Disk-backed reservations must fit the Pod ephemeral limit; memory-backed
reservations must fit the Pod memory limit. These are sub-budgets already included
in the Pod envelope, not additions to it. Shared mounts appear once regardless of
how many processes use them. Those comparisons do not guarantee every mount can
reach its ceiling simultaneously or reserve extra memory for applications.

A log budget has finite total bytes, per-file bytes, file count, byte rate and
retention time. The file-size/count product must fit the total, and the total must
fit an explicitly referenced storage reservation in the same workload. Logging is
charged to that bucket once. Rotation, rate enforcement, persistent growth across
attempts and effective runtime settings remain implementing consumers' work.

Retained workspace and gateway-private stores are supplied separately, exactly once
each, and cannot be substituted for ephemeral budgets. Their reserved bytes are
summed once with external `retainedStorageBytes`. External node/system, SPIRE,
credential mediator, database, ingress and network-service reservations each carry
owned resource vectors, host tasks, ephemeral log bytes and retained storage bytes.
External logs must fit the external ephemeral limit. Missing external inputs prevent
complete node/retained totals. These reservations are desired accounting data;
actual node capacity and store availability need their original producers' evidence.

`alternatives` records explicit overrides, LimitRange defaults and RuntimeClass
defaults using the selected contribution's accounting ID, or the reserved ID `pod`
for its envelope. Every supplied alternative must equal the already supplied
selected resource vector. A mismatch, unknown target or alternative for a missing
selected value reports `default-conflict`. No alternative fills in or replaces the
selected envelope. An explicit empty alternatives list means its producer has no
such alternatives to compare, not that the validator inspected a cluster.

## Results and existing observation semantics

The result status is `accounted`, `incomplete` or `invalid`. All branches retain
`evidence: "supplied-accounting-only"` and `effectiveResources: "unavailable"`.
`accounted` means the complete supplied accounting inputs pass the declared
arithmetic and consistency checks. It never means admitted, ready, current,
enforced or measured.

The result exposes per-Pod phase/overhead peaks and node resource, host-task and
retained-byte totals. Unavailable arithmetic dimensions are `null`; invalid
accounting clears every total. An incomplete result can retain other fully supplied
arithmetic subtotals, which cannot be used as a complete envelope. Diagnostics use
closed codes and generated field/index paths without input contents.

The envelope's gateway and Harness observation slots reuse exactly
`RuntimeObservationResultSchemaV1` and `RuntimeObservationResultV1` from the
[existing runtime-effects contract](runtime-effects.md). Their complete observation
still separates desired, delivered and effective profile references, versions,
digests and producer provenance. Incomplete, ambiguous and unknown observations
remain those original variants. The existing parser retains its clock and
correspondence validation; this module also checks the expected component. It does
not synthesize profile agreement or renew source times.

Those observations do not expose a resource-metering producer. Consequently
`effectiveResources` currently permits only the explicit unavailable producer-port
reservation. Observation availability does not turn desired resource arithmetic
into effective resource evidence. The existing admitted-runtime
`resourceEnvelopeDigest` stays owned by its producer; this module does not create
an admission, digest-to-workload binding, second observer or transport codec.

## Timing and verification

The module reexports the original `RUNTIME_AUTHORITY_LIMITS_V1` and
`RUNTIME_EFFECT_LIMITS_V1` objects. `deadlineBudget` returns the minimum of the
existing named ceiling, caller-supplied remaining budget and stricter purpose limit.
Zero remaining budget returns zero. It uses no wall clock and authorizes no call.

The original limits remain preparation 900 seconds, provider request 10 seconds,
authority lookup 3 seconds, observation age 15 seconds, uncertainty 2 seconds,
active recheck 5 seconds, graceful stop 30 seconds and termination observation
120 seconds. Original bounded backoff is unchanged. Rechecks still require actual
accepting-boundary checks; a stop attempt ends in observed termination or explicit
unknown. The 60-second denial target remains unmeasured and is not a deadline kind
or evidence of physical stop or external credential revocation.

On a worktree with the matching Node, TypeBox, TypeScript and Node type packages:

```sh
node --test tests/conformance/runtime-resource-accounting-v1.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/runtime-resource-accounting-v1/producer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/runtime-resource-accounting-v1/consumer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/runtime-resource-accounting-v1/negatives.tsconfig.json
```

The conformance suite runs the actual exported port and independently compiles
producer, consumer and expected-negative fixtures through the exact package leaf.
It covers concurrent/sequential init, restartable init/helpers, Pod/node overhead,
missing Job and owner budgets, unsafe quantities and overflow, duplicate costs,
conflicting defaults, bounded processes/logs/storage, immutable snapshots and
stricter deadlines. Synthetic arithmetic values are test data, never selected
production reservations. Passing these checks establishes the pure contract only;
actual resource normalization, final-Pod admission, protected resource observation,
capacity measurement and enforcement require their owning implementations.
