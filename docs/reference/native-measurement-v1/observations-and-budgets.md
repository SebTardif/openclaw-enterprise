# Native measurement observations and budgets

Select observation endpoints, complete sample slots and independently accepted budgets for the [native consumer measurement V1 profile](../native-measurement-v1.md). These measurement contracts perform no runtime operation and confer no authority or runtime qualification. The checked-in profile remains a synthetic fixture; the criteria below do not select actual artifacts or effective resource bindings.

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
