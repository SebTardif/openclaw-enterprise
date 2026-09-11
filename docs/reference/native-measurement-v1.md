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

## Reference chapters

- [Native measurement observations and budgets](native-measurement-v1/observations-and-budgets.md): clocks, workload endpoints, sample accounting and initial benchmark criteria.

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

`NATIVE_MEASUREMENT_PRESERVED_V1` records the existing protocol and authority
ceilings. Harness connect/send/reconnect are 5,000 ms, cancel 3,000 ms,
subscriptions 30,000 ms;
reconnect attempts 3, frame 262,144 bytes, input 65,536 bytes, events 128 and
1,048,576 event bytes, attempts 64 and subscriptions 16. Native text input is
65,536 UTF-8 bytes; capture is 262,144 bytes, completed text/body 3,200/8,192 bytes
and notice text/body 512/2,048 bytes. There is one executable turn and no queue or
attachment/streaming feature. The native pending deadline remains 30,000 ms.
Execution duration comes from the original attempt's explicit admitted
[finite-or-uncapped policy](turn-journal/execution.md#selected-native-execution-retention),
not this measurement inventory. A configured cap retains its original anchor;
expiry does not silently release uncertain ownership. Uncapped execution does
not enlarge pending, transport, authority or measurement bounds.

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
