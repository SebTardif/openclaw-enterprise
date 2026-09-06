# Native consumer measurement V1

The `@openclaw-enterprise/contracts/native-measurement-v1` and
`@openclaw-enterprise/contracts/native-measurement-codec-v1` exports define a
finite measurement profile, raw result exchange, and numerical evaluator. They
perform no native, provider, process, database, or network operation. An evaluated
pass is confined to the declared evidence class. Every evaluation retains
`evidenceAuthenticated: false` and `runtimeQualified: false`: callers still own
independent observation provenance, acceptance of the exact profile, and actual
runtime qualification.

The checked-in profile is a **synthetic fixture**, with deliberately fictional
artifact digests and toy thresholds. It is not an accepted production performance
profile. A real run needs independently accepted numeric values, workload bytes,
resource settings, and the complete actual artifact tuple before passing its
measurements. Unknown pins, unselected budgets, an unselected decision, or
unselected resource expectations, unknown observed/admitted binding or unresolved required storage resources keep otherwise complete observations blocked.

## Profiles and artifact identity

`native-measurement-profile-v1` contains a positive revision, exact selection
`decisionDigest`, evidence class, subject, clock, workload, and all 14 cases.
Decoders accept explicit `unselected` decision/budget/resource settings and
`unknown` artifact pins; they do not fill in defaults. The selection digest is a
reference to separately accepted decision evidence, not an authorization token or
proof of agreement.

The `subject.producer` object preserves the existing closed `ProducerTupleV1`
shape: Enterprise/upstream/Codex commits, Codex `0.153.0`, gateway protocol `4`,
native state/Agent schemas `15`/`19`, adapter `1`, context format
`completed-context-text-v1`, native import contract `1`, native import adapter
digest, and artifact ledger reference. The measurement leaf validates that exact
value shape without loading a native implementation. It neither changes the
existing tuple nor qualifies the official native binary as a changed importer.

Separate sibling `artifacts` pins identify declarations, exports, package,
dependency closure, native executable, gateway image, effective configuration,
capabilities, toolchain, and producer receipt. Every pin must be known for a
numerical pass. Source identity alone does not supply matching emitted
declarations or an installed package. Generated-client identities appear only in
the `selected` arm: schema/compiler/plugin/descriptor/configuration and each
selected Go/TypeScript client's package, exports and runtime digests. Their
presence does not select or authorize a transport migration.

The four evidence classes are `fixture`, `source`, `installed`, and
`actual-provider`. They are separate applicability claims, not automatically
interchangeable ranks. The evaluator requires the result's class and complete
subject to match its independently supplied profile exactly. A fixture result
cannot satisfy an actual-provider profile. Actual-provider mode requires the
actual-provider model workload; an installed/source run can use a declared
fixture or no model. Observations must retain the real components and any
substitutes in the referenced evidence packet.

## Clock, workload, and endpoints

Use one external observer's monotonic clock, integer microseconds, a named
`originRef`, and an explicit positive resolution. Every observed sample must use
that origin. Observe process and protocol endpoints in this clock; never subtract
unsynchronized host/native/provider timestamps. If that observation is
unavailable, report an unknown clock sample. Wall time is evidence metadata and
cannot replace the duration clock. Resolution cannot exceed a selected p95
budget. End must be at or after start; all timestamps and counters must be safe
nonnegative integers, excluding negative zero. Serialized numbers use unsigned
integer tokens only: fractional and exponent syntax is rejected before conversion
to avoid accepting underflow or rounded fractions. Object entrypoints cannot
recover precision already lost by an earlier parser.

`resourceProfile` separates three states. `candidate` preserves numeric proposal
values with both selection and request/limit meaning explicitly unselected. It
never supplies operative values. `expectation` selects an independently accepted
profile digest and request/limit pairs for gateway, Harness and private-state init
CPU, memory and ephemeral storage. `observed` carries the actual matching role
values, effective-configuration digest, binding digest and native-to-Harness
mapping digest. Each request is no greater than its limit. Complete observed and
expected values must agree exactly, and effective configuration must match the
subject's artifact pin. An unresolved init storage pair keeps a numerical pass
blocked. An observed declaration is still data requiring independent provenance.
The synthetic fixture's init storage pair is fictional, not a reference default.

A profile selects Slack or Teams for one run. Run both profiles where both
channels are required. Workload identity binds the exact input/result bytes,
selected model and relevant fixture or provider setup. The finite workload keeps
one Agent, two participants, two threads, one executable turn, zero queued
turns, no attachments and no channel token streaming. CPU is in millicores;
memory, input, output and capture sizes are in bytes. These subject settings must
match the actual admitted configuration; describing them allocates no resources.

The case identifier fixes its endpoints in `NATIVE_MEASUREMENT_ENDPOINTS_V1`:

| Case                  | Start                                                      | End                                                         |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `startup-ready`       | Observer requests gateway process launch                   | Owner-qualified readiness for that same process observed    |
| `transport-ack`       | Observer submits the particular provider transport request | Positive provider transport receipt ACK observed            |
| `admitted-turn-ack`   | Observer submits gateway turn request                      | Canonical admitted original-attempt acknowledgment observed |
| `completed-result`    | Native completed result received                           | Checkpoint-gated provider create confirmed                  |
| `status`              | Observer submits protected status request                  | Authorized status response confirmed                        |
| `busy`                | Observer submits overlapping request                       | Busy response confirmed                                     |
| `shutdown`            | Observer requests exact gateway shutdown                   | Exit of that same gateway process observed                  |
| `reconnect-ready`     | Observer witnesses Harness disconnect                      | Original-attempt reconciliation complete                    |
| `cancel-ack`          | Observer submits protected cancellation request            | Native interrupt acknowledgment observed                    |
| `cancel-settlement`   | Observer submits protected cancellation request            | Trusted original-attempt settlement observed                |
| `writer-termination`  | Observer requests exact writer stop                        | Physical writer termination observed                        |
| `reconnect-retention` | Settled pre-reconnect resource baseline                    | Settled post-reconnect resource observation                 |
| `cancel-retention`    | Settled pre-cancel resource baseline                       | Settled post-cancel resource observation                    |
| `model-service`       | Observer submits exact model request                       | Complete model response observed                            |

Request/launch endpoints are the external observer's submission instants. Include
intervening transport, authorization and dependency time; never move the start
after authentication or request receipt to satisfy a budget. Correlate readiness,
ACKs and exit with the same exact request/process/instance in retained evidence.

Transport acknowledgment is not admitted-turn acknowledgment. Admission is not
native completion. Native completion alone cannot authorize delivery: the
completed-result interval includes required persistence/checkpoint and delivery
work after receiving completion, and ends only on confirmed create. Ambiguous
create remains unknown. Busy never starts or enqueues another turn. Reconnection
requires fresh authorization and a completed reconciliation response for the
original attempt; socket readiness alone is insufficient, and uncertain work is
not resubmitted. A positively observed truthful unknown reconciliation response
can satisfy that response-latency case with `domainOutcome: "unknown"`; it does
not establish settled execution or pass retention. Evaluation retains
`domainUnknownSamples` explicitly. Only this latency case permits that domain
outcome; missing response endpoints stay unknown samples.

Cancellation acknowledgment, trusted settlement, gateway exit, physical writer
termination, and resource reclamation remain independent observations. EOF,
close, interruption acknowledgment or fencing is not physical termination. A
missing/unknown endpoint cannot be converted to zero duration or discarded;
original authority and ownership obligations continue.

Model service is measured independently of gateway handling. The gateway
admission interval ends at admission, before model execution. The completed
result interval starts after native completion and includes persistence/delivery.
Do not subtract an unknown model interval from a total duration or claim these
intervals partition an entire end-to-end turn. For multiple model calls, use the
workload's explicitly selected call samples and keep the complete call inventory
in its evidence. This V1 profile does not measure native token streaming or
introduce a synthetic gateway stream-lag claim.

## Samples, budgets, and resource tolerance

Each case defines cycles, measured samples per cycle, and warmups per cycle.
Slots are `(cycle, phase, index)`, zero based and unique. Each observed slot has
its own evidence reference binding the exact endpoint/sample/attempt or process
correspondence. References are unique within a case; different case observations
may correspond to the same real attempt without asserting additional actions.
Each observed slot also records actual workload input/result/capture byte counts
and overflow. Payload mismatch or overflow fails even a warmup slot; truncation
cannot hide an over-limit workload. A profile permits up to
100 cycles, 100 samples and 100 warmups per cycle, with at most 4,096 combined
slots per case and a stricter aggregate cap of 1,024 slots across the full
profile. The aggregate bound retains the initial 960-slot profile while keeping a
complete packet within decoder node/byte limits, including maximum bounded
resource vectors and references. All expected warmup and measured slots must settle and be
recorded. Missing warmups also prevent a pass. Observed warmups are excluded from
latency distributions and resource thresholds; this does not exclude unknown
warmup settlement from completeness checks.

Latency budgets select integer `p95Us` and `maxUs` with p95 no greater than max.
The evaluator computes nearest-rank p50/p95/p99 and maximum from all observed
measured samples, retaining distributions even when the case is incomplete.
These partial distributions are diagnostic; they cannot produce a pass while any
slot is missing or unknown. Any measured threshold exceedance fails the case,
even if other slots remain missing/unknown. Their separate sample counters remain
visible. No interpolation or averaging hides the maximum.

The two retention cases select `maximumGrowth` for RSS bytes, file descriptors,
sockets, listeners, timers, and child processes. Observe the complete selected
gateway/native process tree with consistently defined collectors. Unsupported or
incomplete resource coverage is `unknown`, not an observed zero. Each measured
cycle compares with the same independently observed post-warmup baseline; changing
that baseline within the case is invalid, so a per-cycle reset cannot conceal
accumulating growth. Resource decreases count as zero growth, without unsigned
underflow. Each dimension independently satisfies its tolerance.

`settledAtUs` is an actual trusted settlement observation between start and end.
`settleWindowUs` bounds the delay from that observation to the resource sample,
not a claim that waiting establishes quietness or a writer barrier. Required
physical termination must also have been observed before reclaiming writer
resources. Missing termination/settlement stays unknown. Handle disappearance or
memory reduction supplies neither termination proof nor authority to release
uncertain ownership.

## Initial benchmark criteria

The initial measurement criteria below are selectable values for a future exact
profile. They do not populate an actual artifact tuple or effective resource
binding. The fixture profile remains a separate small format test. Record
selection of these criteria in the real profile's independently accepted
decision digest; leaving that decision unselected prevents a pass.

| Case                              | p95 / maximum ms                         | Cycles × (warmup + measured) |
| --------------------------------- | ---------------------------------------- | ---------------------------- |
| Startup readiness                 | 3,000 / 5,000                            | 10 × (2 + 1)                 |
| Transport ACK                     | 100 / 500                                | 10 × (2 + 10)                |
| Admitted-turn ACK                 | 250 / 1,000                              | 10 × (2 + 10)                |
| Completed result                  | 500 / 2,000                              | 10 × (2 + 10)                |
| Status                            | 100 / 500                                | 10 × (2 + 10)                |
| Busy                              | 100 / 500                                | 10 × (2 + 10)                |
| Gateway shutdown                  | 2,000 / 5,000                            | 10 × (2 + 1)                 |
| Reconnect reconciliation response | 2,000 / 5,000                            | 10 × (2 + 1)                 |
| Cancel ACK                        | 500 / 3,000                              | 10 × (2 + 1)                 |
| Cancel settlement                 | 5,000 / 30,000                           | 10 × (2 + 1)                 |
| Physical writer termination       | 5,000 / 30,000                           | 10 × (2 + 1)                 |
| Model service                     | 60,000 / 120,000                         | 10 × (2 + 10)                |
| Reconnect resource vector         | RSS growth 16 MiB; other dimensions zero | 10 × (2 + 1)                 |
| Cancel resource vector            | RSS growth 16 MiB; other dimensions zero | 10 × (2 + 1)                 |

Each channel has 680 measured and 280 warmup observation slots. A resource vector
is one observation, not six executions. With ten measured samples, nearest-rank
p95 and p99 both equal the maximum; these counts do not justify a stronger
distribution estimate. Select 1,024-byte input, 2,048-byte completed reply and a
4,096-byte output-capture ceiling. Observer resolution is at most 1,000
microseconds. Resource after-observations occur within 1,000 ms of actual
settlement, against one complete baseline recorded after that case's first two
warmups and retained across later cycles.

The reference resource expectation retains separate request/limit pairs:

| Role               | CPU request/limit millicores | Memory request/limit MiB | Ephemeral storage request/limit MiB |
| ------------------ | ---------------------------- | ------------------------ | ----------------------------------- |
| Gateway            | 250 / 1,000                  | 512 / 1,024              | 256 / 1,024                         |
| Harness            | 500 / 2,000                  | 1,024 / 4,096            | 1,024 / 4,096                       |
| Private-state init | 100 / 500                    | 64 / 256                 | Explicitly unselected               |

Candidate values of gateway 500 millicores/512 MiB and native 2,000
millicores/2 GiB retain unselected request-versus-limit meaning. They neither
replace these expectations nor authorize an allocation. Actual native-to-Harness
mapping and the exact observed/admitted resource binding are required for an
installed or provider measurement pass. No codec or definition test needs a live
run to represent these unresolved states.

## Complete result accounting

`native-measurement-results-v1` contains the exact profile digest and subject,
evidence class, discovered and selected case IDs, and selected case records.
There are no trusted producer-supplied pass counters. Discovery and selection are
unique finite subsets; selection must be contained in discovery. Records cannot
refer to unselected cases, duplicate cases or duplicate sample slots.

The evaluator produces exactly one row for each expected case and derives:

- `expected`: all 14 V1 cases; `discovered`: enumerated cases actually found;
  `selected`: explicitly chosen discovered cases.
- `pass`, `fail`, `skip`, `unselected`, `blocked`, `missing`, `unknown`: mutually
  exclusive per-case outcomes. `expected = selected + unselected`, and selected
  equals the sum of all the other outcome counts.
- `expectedSamples` and `observedSamples`: measured slots; `warmupSamples`:
  observed warmup slots; `domainUnknownSamples`: positively observed truthful unknown reconnect responses;
  `missingSamples` and `unknownSamples`: unresolved slots
  across both phases. For a sampled record, expected measured plus expected
  warmup slots equals observed measured plus observed warmup plus missing plus
  unknown slots. Absent records mark all slots missing; an explicit unavailable
  case is counted by its blocked/skip/unknown disposition without inventing raw
  observations.

Missing record or sample is `missing`; unknown settlement/clock/resources is
`unknown`; a declared unavailable dependency or otherwise complete run with
unselected policy/budget/resources/unknown artifacts is `blocked`; deliberate
nonexecution is `skip`; outside selection is `unselected`. A required skipped
case stays incomplete. Only `model-service` when the model is explicitly `none`
can be `not-applicable`, with an explicit matching skip record. Every other case
remains required, including management and authority-related behavior that other
conformance suites own.

The verdict is `fail` if any case fails, otherwise `incomplete` for an unresolved
required case or unselected case, otherwise `pass`. A pass covers only these
numerical cases and declared evidence class. It does not replace broader native,
channel, browser, authority, isolation, persistence or installed conformance.

## Preserved limits and compatibility

`NATIVE_MEASUREMENT_PRESERVED_V1` records the existing selected ceilings. Harness
connect/send/reconnect are 5,000 ms, cancel 3,000 ms, subscriptions 30,000 ms;
reconnect attempts 3, frame 262,144 bytes, input 65,536 bytes, events 128 and
1,048,576 event bytes, attempts 64 and subscriptions 16. Native text input is
65,536 UTF-8 bytes; capture is 262,144 bytes, completed text/body 3,200/8,192 bytes
and notice text/body 512/2,048 bytes. There is one executable turn and no queue or
attachment/streaming feature. The native pending deadline remains 30,000 ms and
turn deadline 900,000 ms; expiry does not silently release uncertain ownership.

Authority effect permits remain 5,000 ms, lookup 3,000 ms, evidence age 15,000 ms,
clock uncertainty 2,000 ms and active recheck 5,000 ms; earlier original or
stricter profile deadlines prevail. Resource tolerance and measurement budgets
are not replacements for these constants or for the actual admitted profile.
An observation latency target grants no authorization grace, retries, extra
buffer capacity or time to retain a forbidden stream. A model-service budget
does not enlarge individual provider/authority request deadlines.

The profile digest is lowercase SHA-256 over the decoded, closed profile's
canonical JSON: UTF-8, lexicographically sorted object keys, preserved array
order and safe integer JSON representations. This is the measurement profile's
own digest domain; it does not change snapshot-byte, native or authority digest
formats. Pass the independently retained profile to
`evaluateNativeMeasurementsV1(expectedProfile, results)`. Do not trust a profile
supplied only by the same unverified result packet.

Changing any profile field—including revision, workload, budgets, clocks,
resources, decision, generated-client selection or artifact/declaration tuple—
changes its identity and requires a new result packet. V1 results from an old
profile are rejected against the new expectation. This conservative full-rerun
rule avoids silently reusing old passes; independently reviewed selective reuse
would require a separately specified compatibility amendment. Unknown versions,
keys, enums, tuple extensions and duplicate JSON keys are rejected without a
fallback downgrade.

The decoder limits each input to 2 MiB, depth 16, 100,000 nodes and 8,192 entries
per container before schema validation. It rejects malformed Unicode, unsafe
numbers, negative zero, cycles, accessors, proxies, symbols, sparse/custom
arrays, and class instances. JSON entrypoints detect duplicate keys, including
escaped aliases. Object entrypoints cannot reconstruct duplicates already
lost by another parser; use the JSON entrypoint at the serialized boundary.
Decoded input and evaluation values are detached and deeply frozen.

## Focused checks

The producer and consumer compile as separate strict TypeScript projects with
`skipLibCheck: false`; the consumer imports neither the producer nor its fixture
outcome. Run from a prepared checkout using the repository's pinned Node and
TypeScript dependencies:

```sh
node node_modules/typescript/bin/tsc -p tests/fixtures/native-measurement-v1/producer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/native-measurement-v1/consumer.tsconfig.json
node --test tests/conformance/native-measurement-v1.test.mjs
```

The focused cases cover profile/report compatibility, typed producer/consumer
exchange, threshold overflow, missing samples/warmups/cases, unknown settlement,
selection accounting, skip applicability, resource growth and baseline changes,
clock identity, finite bounds and hostile object/JSON inputs. They establish
executable fixture-format behavior; they run no native binary or live service.
