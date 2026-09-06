# Shared native interaction scenarios

The shared native scenario corpus checks a fixed set of labeled Slack/Teams interactions before actual upstream integration. Its executable checker detects contradictory ordering, missing observations, suppressed-payload use and changed correlation or output bindings. The records are synthetic. A consistent trace is a preparation result; it does not establish admission authority, a durable journal commit, actual provider delivery or runtime qualification.

The implementation lives in `tests/fixtures/shared-native-scenarios-v1`. It adds no native API, receipt classifier, session store, execution runner or production adapter. Existing native codec tests and the existing OCE shared-turn receipt classifier retain those responsibilities.

## Selected cases

Each channel has eight required cases: same-thread follow-up, different-thread follow-up, same-thread overlap, different-thread overlap, sticky busy retry, duplicate replay, changed-payload conflict and immutable output binding. Two directional cross-platform overlap cases and both Slack `message`/`app_mention` twin orders bring the fixed denominator to 20.

The corpus uses one synthetic Agent and workspace, two human actors and separate channel/thread conversations. Every input is explicitly labeled `inputPath:"mentioned-text"`; this is a supplied fixture assumption, not native mention verification. Missing or unsupported path labels are rejected. Follow-up cases retain the prior observed context only within the same platform and thread. Overlap cases show the second human receiving an injected busy label while the first writer interval is active. The cross-platform cases then show a fresh accepted message from the same second human in that second platform/thread after the first interval ends. Its event, logical message and payload references differ from both earlier inputs. A sticky busy replay remains attached to its original busy owner and event kind after the workspace is idle. Separate accepted turns cannot alias receipt, canonical turn or attempt references. Both Slack event orders preserve one original logical-message owner.

The immutable-output cases supply an unknown first delivery and a later separate turn. Unknown delivery has no confirmed provider message reference; another output attempt cannot be justified by this trace. The checker is intentionally a one-output scenario checker, not the original delivery slot/update/retry protocol.

## Observation contract

`checkScenarioPacket(manifestText, casesText, tracesText)` returns a machine-readable report. All three inputs are JSON strings. No path, argv, environment variable, API callback or supplied code is followed or executed. An example from the repository root is:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { checkScenarioPacket } from "./tests/fixtures/shared-native-scenarios-v1/checker.ts";
const base = "tests/fixtures/shared-native-scenarios-v1/";
const report = checkScenarioPacket(...["manifest", "cases", "traces"].map(name => readFileSync(base + name + ".json", "utf8")));
console.log(JSON.stringify(report));
process.exitCode = report.findings.length === 0 ? 0 : 1;
'
```

The manifest selects a fixed catalog and original SDK/profile identities. Cases supply admission labels and full expected attempt bindings. Trace observations carry strictly increasing synthetic sequence numbers, a turn reference, the exact binding or null for suppressed turns, and a closed kind-specific detail object. Sequence numbers express local fixture ordering; they are not source timestamps or latency measurements.

| Observation         | Checked relationship                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admission`         | Exact injected disposition and original owner are observed before any turn effect. The checker does not independently decide admission.                                                                                  |
| `dispatch`          | The accepted turn begins its sole shared-workspace writer interval. No second writer may overlap it.                                                                                                                     |
| `context`           | The transcript matches the accepted conversation. Context contains its own payload exactly once and the prior observed same-thread/platform context in order; busy, duplicate, future and foreign payloads are excluded. |
| `model`, `tool`     | Work follows dispatch/context, uses the accepted payload reference, and preserves the full receipt/turn/attempt/principal/Agent/revision/assignment/generation/binding/policy tuple.                                     |
| `output`            | Work precedes output, and platform, native thread and reply binding/version stay attached to the original turn. Unknown remains unknown.                                                                                 |
| `native-completion` | The native completion observation retains `checkpoint:"unverified"`. It does not create an OCC checkpoint.                                                                                                               |
| `occ-checkpoint`    | A separate explicitly labeled OCC observation supplies its own checkpoint reference and the expected completion sequence. The label remains unauthenticated.                                                             |
| `writer-end`        | Ends the synthetic interval. This marker is not proof of real process termination, lease expiry, cancellation or descendant quiescence.                                                                                  |

The case checker verifies exact event/actor/logical-message relationships for replay, changed-payload conflict and Slack twins. It does not derive native uniqueness digests or replace the accepted native/OCE codec and classification tests. Native bare SHA-256 values and OCE prefixed receipt digests remain distinct formats; no implicit conversion occurs.

The report exposes `expected`, `discovered`, `supplied`, `consistent`, `inconsistent`, `incomplete` and `unrun`, plus bounded findings. `discovered` counts rows in a structurally accepted trace catalog, including duplicate/foreign entries. `supplied` counts unique required case IDs with structurally accepted trace rows. Missing required traces stay `unrun`; missing required observations make a supplied case incomplete unless it also contradicts the contract. A packet-wide manifest/catalog/foreign-input defect prevents all supplied cases from being reported consistent. Duplicate case IDs never inflate coverage. Counts partition the fixed required-case denominator, not successful test assertions or real native execution.

## Public declaration consumer and provenance

The selected current producer is `ae2265c60527ad07174250131ebbf65dec9401a6`, tree `a56670c31976631023940663e3cb6200c2cca644`. The manifest retains separate archive, package manifest/export, archive-member inventory, dependency lock, declaration-preparation manifest and original COL-01 profile hashes. These are selected identity references, not evidence that this checker examined their bytes. Actual consumer receipts must retain the original source/preparation records and the files actually consumed by the compiler.

The isolated compile-only consumer uses these actual public subpaths:

- `openclaw/plugin-sdk/channel-inbound`: original envelope/attempt/native-event/output types and envelope/attempt/output schema result signatures.
- `openclaw/plugin-sdk/slack-hosted`: original `SlackHostedInputV1` data signature.
- `openclaw/plugin-sdk/msteams-hosted`: original `MSTeamsHostedInputV1` data signature.
- `openclaw/plugin-sdk/codex-hosted-harness`: original observation, purpose and wire types.

All imports are type-only. The consumer accepts already-decoded public values and preserves their opaque external identity, source timestamps, attribution, reply destination and native/Harness observations in a separate non-authoritative projection. It does not read opaque listener or Teams SDK context, make network/API calls, load codec implementations or claim those values have trusted provenance. The original host must still join its authorized identity and audience evidence. Projection does not combine the independent output/native/Harness observations into an authoritative outcome. Its OCC checkpoint stays null and physical writer termination stays unmeasured.

The compile-time assertions retain Harness purpose `candidate-probe | serving` and checkpoint `unverified`. Expected-negative assertions reject an invented `completed-context-restore` purpose and a verified native checkpoint. No quiet import/restore receiver is introduced.

Compile with `strict:true`, `noEmit:true`, `skipLibCheck:false`, `exactOptionalPropertyTypes:true`, `noUncheckedIndexedAccess:true`, NodeNext and the exact selected current declaration graph. A private prepared consumer may use the explicitly approved 22 individual current package/type links with `preserveSymlinks:true`, Node24/ws8 and the original matching undici-types. Hash its fixture copy and the real sibling checker, retain the private configuration, exact compiler and actual consumed logical/physical files, and keep the actual caller result. A successful historical SDK compile or another consumer's pass cannot satisfy this consumer. A linked declaration pass does not establish portable installation, lifecycle scripts, native/provider capability or runtime behavior.

## Bounds and original ownership

Combined input size is at most 1 MiB, each catalog at most 32 cases, each trace at most 64 observations, and the aggregate at most 2,048 observations. Nesting is at most 16; opaque references are nonempty well-formed Unicode without control characters and at most 256 UTF-8 bytes. There are at most 256 reported findings, with an explicit truncation flag. JSON duplicate keys, fractional/exponent numeric tokens, unsafe integers, malformed Unicode and unsupported fields are rejected. The checker accepts data strings only; its byte bound starts after callers have obtained those strings and is not a file/network resource policy.

Existing original equivalent coverage includes native `hosted-admission.test.ts`, `hosted-admission.codecs.test.ts`, Slack `message-handler.hosted-admission.test.ts`, and OCE `tests/conformance/shared-turn-receipt.test.mjs`. Their original results and historical source identities remain attributed separately. This corpus reuses their accepted meanings without reimplementing the native adapters or original receipt classifier.

Actual UPS-06/native integration owners retain live Slack/Teams adaptation, trusted producer interception, active steer/collect/direct-session paths, real native tools, reconnect/replacement and both-platform positive execution. COL shared-turn owners retain receipt/journal/guard/dispatch and conversation/audience semantics. The independent route-continuation corpus and cancellation families remain separate. Admitted-but-undispatched journal projections, newer unexported initiation, quiet import and external restore are unrun here and are explicitly listed in the manifest.

The handoff consists of the exact nine-file source, the machine-readable labeled corpus/report, finite test/compiler receipts and the original-owner acknowledgments. Acceptance of this bounded preparation does not transfer original source, package, journal, provider or release authority.
