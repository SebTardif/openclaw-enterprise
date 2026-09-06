# Protected containment control observations V1

The containment control contract describes one finite in-process read of effective
controls for an exact bound Kubernetes/gVisor Harness execution. Schema version 1
and projection version 1 are exported through
`@openclaw-enterprise/contracts/containment-controls-v1`; the strict value decoders
are in `@openclaw-enterprise/contracts/containment-controls-codec-v1`.

This release provides declarations, bounded structural decoding, exact request and
response correlation, and compiler examples. It provides no observation producer,
eligibility evaluator, authentication adapter, provider connection, activation or
stop implementation. All results carry `eligibility: "observation-only"`, including
records whose producer claims a control is effective. Structural validity does not
establish an admitted profile or a running control.

## Exact scope and original producers

`ContainmentControlInputV1` carries the original Runtime bound-instance input. Its
assignment target identifies the Installation, Namespace, Agent, revision,
lifecycle/runtime generations and create effect. Its original Runtime binding
includes provider object UIDs, exact images, admitted configuration/profile
digests, runsc execution identity and protected execution restart discriminator.
The additional containment profile and required control policies must come from
the original admitted profile owner at the accepting boundary. Caller-supplied
matching identifiers do not prove that relationship. This projection neither
allocates an assignment nor supplies prebinding observation; the original Runtime
observation port retains that separate capability.

| Responsibility                                                        | Original boundary                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Projection assembly                                                   | One containment-owned `ContainmentControlObserverV1` implementation            |
| Provider ownership, actual execution and runtime profile observations | Original Runtime observer and its accepted `RuntimeObservationResultV1`        |
| Actual process, mount, runtime and network control outcomes           | Original protected containment control producers                               |
| Identity, verified peer and proof provenance                          | Existing authenticated identity/transport verification boundaries              |
| Current assignment and purpose authority                              | Existing Runtime assignment authority                                          |
| Durable denial, fencing, retained cleanup and physical stop           | Existing Runtime fault/effect ports and their original control-plane executors |

The module imports the sole Runtime input/result, policy-stage, provenance and
read-call declarations. It defines no competing assignment, authority, identity
proof or fault type. Producers retain their own evidence and accepted port
references. A projection owner may only relay those original facts; an absent
producer returns unavailable or a control with an explicit unknown outcome.

## Policy stages and bounded outcomes

An input enumerates between one and eight distinct required control kinds and the
desired policy for each. The list must be the complete set required by the trusted
admitted containment profile for the selected operation. An arbitrary caller
cannot reduce the list to acquire permission. The finite kinds cover runtime
isolation, process and mount restrictions, outer networking, aggregate network
policy, protected resolution, authenticated mediation and credential separation.
This list is a projection vocabulary, not a new executable profile specification.

An observed response must contain exactly that requested set. Every record retains
its original desired policy and independently supplied delivered/effective stages.
Each stage includes profile reference, version and digest; delivered/effective
stages additionally preserve the original Runtime provenance schema. Missing
stages use `null`, and an effective claim requires both supplied stages to match
desired exactly. Ineffective and unknown outcomes require a closed reason code.
One control producer owns each record and its stage evidence, including the
producer epoch; multiple producers use separate control records or their original
protected aggregate producer. Unknown or unrecognized kinds never imply coverage.

The complete original Runtime observation stays intact, including its separate
desired/delivered/effective runtime profile, nullable identity evidence and
complete/incomplete/ambiguous/unknown branches. An incomplete Runtime observation
can accompany useful negative or historical control data, but prevents positive
eligibility. Runtime and control profile stages are different domains; the codec
does not silently coerce them into one digest.

The result union also supplies finite unknown, unavailable, cancelled and
deadline-exceeded branches. They repeat the exact input and include only a closed
original Runtime reason code. They contain no provider exception, response body,
credential, arbitrary diagnostic string or permission claim.

## Trust, freshness and ordering

All decoded values remain untrusted. Producer names, evidence references, epoch
numbers, source times and serialized identity proofs confer no authority. Existing
authenticated boundaries must verify the exact original producer, accepted port,
scope, profile and execution provenance before using any record. The original
`RuntimeReadCallV1` carries its nominal trusted context; this contract exports no
constructor for that context. Even a context accepted by its original factory is
not a verifier result for every nested evidence producer.

The consumer must check current purpose authority and all required original
evidence at the accepting boundary. Missing, unknown, stale, conflicting,
unverifiable or disconnected evidence denies eligibility. An old ineffective
record never becomes a positive record merely because a later projection arrived.

| Ceiling                  | Required behavior                                        |
| ------------------------ | -------------------------------------------------------- |
| Original observation age | At most 15,000 ms, or the stricter purpose maximum       |
| Source clock uncertainty | At most 2,000 ms, or the stricter purpose maximum        |
| Provider RPC             | At most 10,000 ms and within the remaining call deadline |
| Required authority read  | At most 3,000 ms and within the remaining call deadline  |

`maxAgeMs` and `maxUncertaintyMs` carry stricter read-purpose requirements; they
cannot exceed the original ceilings. For every required original provenance record
and trusted current time `t`, consumers require source time at most `t + uncertainty`,
`t - source + uncertainty <= maxAgeMs`, and `t + uncertainty <= validUntil`.
They must also enforce the requested uncertainty limit. Each stage's original
clock is checked independently. Checking only the newest projection clock loses
the age of the original control observation. Receipt, reconnect, retry and cache
access never replace or extend original source time or validity. The original
Runtime freshness helper can check time/version arithmetic; it does not verify
provenance, the stricter uncertainty requirement or current authority.

The projection cursor identifies its producer, protected restart epoch reference,
monotonic epoch version, evidence version and original source time. Within an
epoch, an advancing read requires a strictly greater evidence version and
nondecreasing original time. A different epoch requires a greater protected epoch
version and a different epoch reference; numbering may restart only then. Epoch
references are opaque, with no lexical ordering. Receipt time is not an ordering
key. Each control record independently carries its original producer epoch, which
applies to that producer's source and policy-stage records. The stage evidence
version cannot exceed the enclosing source evidence version.

Consumers retain projection and original-producer watermarks in protected state.
For an original producer they apply the same epoch/version rules, reject conflicting
content under the same epoch/version, and preserve older unchanged stage evidence
only with its original age and validity. A projection epoch advance cannot reset
another producer's watermark. The value codec checks a projection against its
supplied `after` cursor; it cannot establish that a caller supplied the real
protected watermark. An actual execution restart remains distinct from an observer
restart: the original Runtime assignment/binding and fresh identity requirements
still apply even if the Pod UID did not change.

## Finite reads, cancellation and readback

`readControls(input, call)` returns one finite response. The implementation checks
the original authenticated read authority and exact recipient/resource scope,
then bounds all producer waits by the call's absolute deadline and its trusted
monotonic clock. An already aborted call starts no provider read. Abort during a
read cancels the local wait and returns the explicit cancelled/unknown outcome;
deadline exhaustion returns deadline-exceeded. These outcomes prove neither
remote cancellation nor physical execution termination. The read port performs
no mutation and has no background retry or polling loop.

Exact historical readback retains the original input, source times and cursor.
`decodeContainmentControlExchangeV1` checks that full input, including original
Runtime binding, selected profile, controls, purpose limits and prior cursor.
For an advancing read, the caller supplies its protected prior cursor in `after`;
if no newer evidence is available, the producer returns unknown rather than
relabeling an old record as a new observation. A timeout can be followed by a
separately bounded read with the same exact scope. Neither a retry nor a returned
receipt resets freshness or currentness.

No stream or transport migration is selected. Any future cross-process boundary
must use the shared reviewed architecture and existing authentication semantics.
A separately selected stream would additionally need finite message and aggregate
payload limits, bounded buffers/backpressure, cancellation, and eligibility expiry
on gaps, overflow or disconnect. A stream reconnect could not refresh proof.

## Decode and verify locally

The decoders accept JSON values, not raw serialized JSON strings. They reject
unsupported versions, extra fields, malformed original records, mismatched
execution/policy/input bindings, duplicate or missing controls and nonadvancing
cursors. They snapshot only plain own-data objects and dense arrays, invoke no
getters, proxies or serialization hooks, and return detached deeply frozen values.
Input is limited to 262,144 UTF-8 bytes, depth 32, 16,384 nodes and 256 entries per
container. Any invalid input produces only `{ kind: "invalid", reasonCode:
"invalid-input" }`; supplied data is never reflected in diagnostics.

Run the focused conformance suite from a prepared workspace:

```sh
node --test tests/conformance/containment-controls-v1.test.mjs
```

The suite exercises the actual codec with synthetic values and separately compiles
the public module, an unavailable observer, an observation-only consumer and
negative type examples under strict TypeScript settings. The freshness case uses
the existing Runtime freshness implementation. It does not measure producer RPC
latency, authenticate a service, inspect a live control, verify a provider, persist
a fault, prove gVisor/SPIRE enforcement or qualify activation/stop. Those checks
belong to the original implementations and their integration acceptance.

For an invalid result, preserve denial and inspect the exact retained request and
bounded source record privately at its original owner. Do not put raw provider
errors or credentials into this response contract. For an unavailable original
producer, report its unavailable evidence and keep the affected purpose denied.

See [Runtime effects V1](runtime-effects.md) and
[Runtime authority V1](runtime-authority.md) for the underlying contracts.
