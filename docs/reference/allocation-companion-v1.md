# Allocation companion reader

The allocation reader imports a finite run inventory, checks its original bytes
against the [assertion companion contracts](acceptance-companion-v1.md), and
produces a diagnostic completeness report. It preserves the existing
[release evidence harness](release-evidence.md) and its closed formats.

Every report retains 324 expected leaves: 321 required and three optional. It
derives the 63 original parent case/assertion pairs, 20 registry cases, 16 gates,
66 demonstration applicability rows, 49 contract vectors and nine handoffs from
the exported catalog. Slack and Teams retain independent required denominators
of 66 and 65; 190 required leaves are shared. TEAMS-15 is the sole demonstration
applicability exception and requires its review reference. TEAMS-14 remains
required. Optional leaves cannot replace required coverage.

This is an offline declaration reader. It starts no commands, installations,
capture, native calls, provider operations or reruns. A successful report always
has `authentication: "unverified"` and `authenticAcceptance: "not-established"`.
Source checks do not qualify a live gate, independent installer or release.

## Selected run and original inputs

`scripts/release-evidence/allocation-companion-v1/reader.ts` exports
`SelectedAllocationRunSchemaV1`, `AllocationAttemptSchemaV1`, their runtime
SHA-256 identities in `ALLOCATION_READER_SCHEMA_DIGESTS_V1`, and
`readAllocationRunV1`. `report.ts` exports `buildAllocationReportV1` and the
bounded `encodeAllocationReportV1` serializer.

The selection is an original UTF-8 JSON record with these exact fields:

| Field                 | Meaning                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`       | `selected-allocation-run/v1`                                                                                             |
| `runId`               | Opaque selected run identifier                                                                                           |
| `source`              | `synthetic`, `source`, or `live-declared`; a declaration, never authentication                                           |
| `inputManifest`       | Existing typed `input` digest of the original frozen manifest                                                            |
| `demonstrationInputs` | Four ordered existing typed `demonstration` identities                                                                   |
| `limits`, `tuple`     | Existing typed identities of the exact selected inputs                                                                   |
| `handoffs`            | All E1–E9 typed handoff identities                                                                                       |
| `plans`               | Per-leaf `leafId`, typed `companion`, `procedure`, and `procedureReview` selections; the last three accept explicit null |

The selection is provided independently of imported claims. Each non-null
companion digest selects the complete original companion, including all ordered
substeps and all vector stimulus, required-result and proof-lane subchecks. The
reader calls `decodeAssertionCompanionV1`, `decodeProducerReceiptV1`, and
`bindProducerReceiptV1` from the actual exported contracts. TypeBox shape checks
alone do not implement this validation. Unknown versions, old receipt schema
identities, duplicate JSON keys, conflicting identifiers and changed selected
inputs are rejected. There is no silent receipt migration.

An absent plan, companion, reviewed procedure selection, primary receipt or
required check remains visible in the full inventory. Missing reviewed procedures
leave the companion missing. Without a declared live launch the leaf is unrun;
a known live launch retains unknown or blocked diagnostic state. The reader does not invent
substeps, commands, procedure hashes or a real deployment tuple. The catalog has
original demonstration case IDs but no authentic historical substep inventory.
Matching producer-defined substeps and selected digests cannot authenticate
original procedure fidelity; that field always remains `unverified`.

All digest domains retain the accepted contract meaning. The reader checks exact
artifact integrity only when callers supply `{ identity, bytes }` with original
bytes. Protected originals not supplied remain `unavailable`. Artifact text is
never interpreted or emitted as a command. Receipt and companion JSON use their
existing maximum size, nesting and semantic checks. The two local JSON schemas
use a bounded duplicate-key-aware scanner before shape validation.

## Attempts, history and independent outcomes

An `allocation-attempt/v1` record contains `attemptId`, nullable
`originalAttemptId`, `runId`, `inputManifest`, an existing receipt `execution`
record, and `receiptIds`. An attempt must declare a launch (`observed` or
`end-unavailable`); an unrun receipt does not establish an invocation. The same
attempt may support multiple receipts with matching original execution identity.
The reader rejects duplicate attempt IDs, conflicting executor/start/tool/capture
identity, duplicate receipt-to-attempt assignments and reuse mapped to another
attempt. Known captured invocation bindings cannot be counted under two attempt
IDs. Standalone attempts validate canonical timestamps and same-clock ordering,
while different clock domains retain their original uncertainty. Missing references remain explicit; missing capture proves no absence of
outside activity.

Receipt `previousReceipt` and `reuse` identities remain separately visible.
History must remain within the exact selected run and inputs, with matching
primary/supporting role and producer for a previous receipt. Cycles, future
predecessors and incompatible reuse are rejected. Reused observations retain
their original time. A second receipt, check, vector reference or observation
reference does not add an execution. All distinct supplied attempt declarations,
including failed attempts preceding success, remain in the attempt inventory.
The report counts supplied files, decoded receipts, declared attempts, unique
evidence references and repeated references separately.

Reports retain all seven outcomes (`pass`, `fail`, `blocked`, `skipped`, `unrun`,
`unknown`, `not_applicable`), explicit missing collection and null outcome. Source
classes have their own outcome counters. A preliminary unit or source pass
leaves the live leaf unrun. Required and optional denominators remain separate.
Supporting P-AUD/P-UPS receipts preserve their original roles and cannot replace
a primary assembler receipt.

Each receipt retains its collection, result, execution, independent observation
axes, checks, custody/redaction, review, invalidation and reuse declarations.
Missing mandatory collection, review, capture, original bytes or rejected
redaction makes a claimed pass unusable. A known launch with unavailable end
retains the current receipt contract's `end-unavailable` branch and only an
unknown or blocked outcome; no duration or target end is invented. Transport,
cancellation, native delivery, physical stop, token disposition and store state
remain independent observations.

The physical-stop positive leaf requires a declared confirmed physical
observation. The confirmed-revocation positive leaf requires token confirmation
and denial declarations for each supplied token subject. These are necessary
diagnostic conditions and do not authenticate token inventory or upstream
semantics. Passing truthful-unknown handling cannot fill either positive leaf,
prove safe successor writes, or supply no-writer authority. R16 retains zero
executable queue and its pending-intake race and unknown-ownership requirements.

Gate diagnostics retain failure precedence, then blocked/unknown, skipped,
unrun and pass. Required live substep and vector subcheck failures participate
in that reduction even when the receipt's overall declaration is unknown or
blocked; receipt outcome counters retain the original declaration. Blocked and unknown share the gate display state
`blocked-or-unknown` but keep separate counters and every reason. Every vector's
`requiredByGates` joins into gate membership, including R4 restore-authority
leaves required by R10. Earlier supplied failures remain in this conservative
diagnostic reduction after later success; a separate authentic acceptance and
explicit supersession disposition are required to qualify a corrected run.

## Explicit CLI

Run with Node 24 and prepared repository dependencies:

```sh
node scripts/release-evidence/allocation-companion-v1/cli.mjs \
  --root /absolute/controlled-run \
  --files files.json \
  --output /absolute/reports/new-report.json
```

The `allocation-run-files/v1` file has `selection` (a relative JSON path),
`companions`, `receipts`, and `attempts` (arrays of relative JSON paths), and
`artifacts` (an array of `{ "path": "relative.json", "identity": ... }`). Every
field is required; arrays may be empty. Each artifact identity uses the existing
typed digest shape `{ domain, sha256, byteLength }`. The CLI accepts only regular
controlled JSON files through the existing `safeDirectory`, `relativeSource`,
and `readBounded` helpers. It rejects symlink traversal, hardlinked files,
unsupported paths and existing output files. This assumes a controlled immutable
input directory; it does not defend against a malicious same-user directory
replacement race.

The output directory must already exist. Reports are created exclusively with
mode `0600`. Exit 0 means structural validity and complete supplied inventory;
exit 2 writes an invalid or incomplete diagnostic report; exit 1 means input,
filesystem or output processing failed. None is release acceptance. Imported
artifacts, procedure text and manual-step text remain inert.

| Bound                                          |                            Maximum |
| ---------------------------------------------- | ---------------------------------: |
| Selection or CLI file-list JSON                |                       512 KiB each |
| One companion, receipt or attempt JSON         |                            256 KiB |
| Companions                                     |                                324 |
| Receipts / attempts                            |                         2,048 each |
| Supplied artifacts                             |                              4,096 |
| One supplied artifact                          |                              1 MiB |
| Aggregate supplied bytes                       | 32 MiB; CLI includes its file list |
| Serialized report                              |                             64 MiB |
| Local JSON nesting / nodes / container entries |                16 / 65,536 / 8,192 |

Bounds are checked before record accumulation. Loaded file bytes are copied to
exact-sized owned buffers so tiny records do not retain their per-file read
allocation. Output overflow fails explicitly;
required detail is never truncated to make a report fit. These finite bounds can
make a large otherwise valid source inventory unprocessable and require a
separately reviewed format change, rather than silent splitting of a run.

## Verification

```sh
node --test --test-concurrency=1 tests/integration/allocation-companion-v1.test.mjs
node node_modules/typescript/bin/tsc \
  --project tests/fixtures/allocation-companion-v1/tsconfig.json --pretty false
```

The test suite exercises the real decoders, reader, report and controlled-file
CLI with synthetic inputs. The separate exported-interface consumer uses strict
TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`skipLibCheck: false`, and `noEmit: true`; declaration generation is disabled for
this consumer check. No database, provider, channel, installer or runtime proof
is exercised. Authentic capture, reviewed original procedures, protected custody,
complete real rehearsal and the accountable human release decision remain
separate obligations.
