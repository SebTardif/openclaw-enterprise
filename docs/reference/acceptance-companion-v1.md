# Acceptance companion and producer receipts

The contracts package provides a closed, versioned offline interface for frozen
assertion specifications and producer receipt declarations. It preserves the
existing release registry and supplies the complete accepted child domain: 324
assertion leaves, 66 demonstration applicability rows and 49 contract vectors.
The existing registry, observation collector and evidence envelope remain their
own formats. A companion is not an additional assertion inside those envelopes.

Import the two supported package subpaths:

```ts
import {
  ACCEPTANCE_LEAVES_V1,
  AssertionCompanionSchemaV1,
  ProducerReceiptSchemaV1,
  type AssertionCompanionV1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  ACCEPTANCE_SCHEMA_DIGESTS_V1,
  decodeAssertionCompanionV1,
  decodeProducerReceiptV1,
  bindProducerReceiptV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
```

This module performs no capture, process execution, file traversal, network
operation, retention enforcement or release decision. A decoded record and a
successful receipt join always carry `authentication: "unverified"`. Claimed
executor names, capture references, hashes, receipt timestamps and an asserted
independent review do not establish authentic execution. There is deliberately no
function that turns these records into authenticated evidence or a release pass.

## Frozen companion

`AssertionCompanionSchemaV1` describes one frozen leaf under
`assertion-companion/v1`. Its allocation and registry identities are pinned to the
accepted original metadata. `ACCEPTANCE_LEAVES_V1` preserves each original leaf ID,
case ID, requirement, primary producer, channel, requiredness, registry parent
case/assertion pair and demonstration references. No child is renamed into a
registry assertion. `ACCEPTANCE_DEMOS_V1` and `ACCEPTANCE_VECTORS_V1` retain the
original crosswalks; their identifiers are closed TypeScript and schema enums.

The callable decoder checks exact parent, producer, channel, requiredness and
crosswalk joins. Every companion retains all 66 applicability rows. `TEAMS-15`
remains the sole explicit `not_applicable` demonstration, with a mandatory review
digest and no invented leaf. The original `TEAMS-14` row remains required.
Per-leaf demonstration plans must include every allocated case, preserve ordered
substeps numbered consecutively from 1, and reject duplicate substep IDs.

The accepted metadata contains demonstration case IDs, not an inventory of
historical substep IDs. Producers therefore supply bounded substep identifiers,
order and expectation digests under the exact reviewed procedure. The decoder
can check the supplied order and identities; original demonstration fidelity
requires independent review of the protected source and procedure. The synthetic
examples' `synthetic-step` is an example identifier, never a historical step or
proof of original demonstration coverage.

Every allocated vector must retain its original contract and `requiredByGates`
set. This includes restore-authority vectors under R4 that also gate R10. A vector
plan supplies unique producer subcheck IDs with exact expectation digests and
retains all three original field identities: `stimulus`, `requiredResult` and
`sourceProofLane`. Multiple subchecks may occupy a slot. Actual vector text and
complete detailed subchecks remain bound through allocation/procedure inputs;
a matching slot alone proves no observed behavior.

The companion binds separate input-manifest, four ordered demonstration-input,
limits, tuple, procedure and handoff digests. The four demonstration positions
follow the accepted input manifest's order, which must be preserved by producer
and reader. The input manifest retains exact source, artifact, configuration,
policy, deployment and selected-limit identities; a mutable path or tag cannot
substitute for retained bytes. All E1–E9 handoff bindings are required:

| Handoff | Retained obligation                                           |
| ------- | ------------------------------------------------------------- |
| E1      | Exact frozen allocation, demonstration, limits and procedures |
| E2      | Complete required children and original parent mapping        |
| E3      | Finite pending intake with zero executable queue              |
| E4      | Authentic producer and capture provenance                     |
| E5      | Separate token dispositions and clocks                        |
| E6      | Selected tuple and explicit profile applicability             |
| E7      | Original demonstration and ordered substeps                   |
| E8      | Custody, retention and independent review                     |
| E9      | Vector subchecks and dependent gates                          |

Missing reviewed procedure inputs prevent forming a frozen companion. The
expected leaf still exists in the catalog and must remain missing/unrun in a run
report. Never invent a placeholder procedure digest to form a frozen record.

## Producer receipt

`ProducerReceiptSchemaV1` describes a declaration under `producer-receipt/v1`.
A receipt identifies its exact companion bytes, run, leaf, input manifest and
procedure. Primary receipts must name the accepted primary assembler; supporting
receipts keep the separate P-AUD or P-UPS producer identity. Supporting work does
not replace the primary leaf or inflate execution counts.

The receipt preserves separate dimensions:

| Field                       | Meaning                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection`                | `missing`, `received` or `rejected`; collection status is independent of a declared assertion outcome                                                               |
| `outcome`                   | Explicit `pass`, `fail`, `blocked`, `skipped`, `unrun`, `unknown` or `not_applicable`; null only for a missing collection                                           |
| `procedure`                 | Explicitly missing, or frozen with its own procedure-domain digest                                                                                                  |
| `result`                    | Explicitly missing, or present with a result-domain digest                                                                                                          |
| `execution`                 | Explicitly unrun, or observed with the actual declared execution class, executor/tool bindings and clocks                                                           |
| `execution.capture`         | Missing, or claimed with protected executor and source/attempt binding references; never authenticated by this decoder                                              |
| `review`                    | Missing, or recorded with a separate review digest, exact input/result digests, independent reviewer, optional personal human reviewer, coordinator and disposition |
| `custody`                   | Protected holder, access/retention policy digests, retention deadline and complete/partial/rejected/unknown redaction disposition                                   |
| `invalidation`              | Current or invalidated with replacement input and review rationale                                                                                                  |
| `previousReceipt` / `reuse` | Immutable history and explicit reuse with the original observation time and review rationale                                                                        |

All fields are required. Explicit missing records, null outcome, `unrun`,
`unknown`, `blocked` and rejected collection are distinct. Omitted or unknown
fields never receive defaults. A missing collection has no outcome, execution,
result, checks, observations or review. A producer can report unrun/blocked work
with a missing procedure. A declared pass or fail requires an observed execution
and a present result. An observed execution requires frozen procedure identity.
An allocated required leaf cannot be declared not applicable.

The actual class stays `source`, `unit`, `static`, `render`, `smoke`, `probe` or
`live`. Every required leaf's target class remains live. Preliminary source/unit
claims remain separate receipts; relabeling a field establishes no provenance.
`checks` retain individual leaf, demo-substep and vector-subcheck outcomes.
Successful or failed checks need evidence references. A positive primary receipt
join requires every supplied companion check and cannot hide a failed or unknown
subcheck. Complete run bijection, missing-leaf denominators, repeated execution
counts and aggregate gate decisions belong to the run reader.

Observations keep transport acknowledgment, admission, dispatch, effects,
completion pointers, native termination, provider delivery, cancellation,
physical termination, retained/purged stores and token disposition separate.
A passing unknown-handling assertion may coexist with physical termination or
token state `unknown`. It cannot establish confirmed termination, no-writer state
or positive token revocation. Wall-clock observations keep their original clock
and uncertainty. Monotonic duration has a distinct clock reference; different
clock domains are never ordered merely by comparing their timestamps.

A recorded review must bind the receipt's exact input and result. Declared
reviewer and executor must differ. Accepted dispositions cannot carry unresolved
finding IDs. These are consistency checks only: the consumer must authenticate
reviewers and verify their scope independently. Human personal review remains
separate from coordinator administration.

Rejected collection, redaction failure and invalidation remain inspectable even
when a producer's original outcome says pass. Such a joined declaration supplies
no usable acceptance evidence. Retention policy and deadline are declarations;
the custodian must enforce protected access, immutable storage and authorized
erasure separately. Reports retain only opaque references and reviewed digests,
never raw credentials, signatures, prompts, transcripts, oracle values, private
paths or operational host identifiers. The identifier grammar is not a secret
scanner or permission grant; screen any publication independently.

## Bytes, digests and compatibility

Decoders accept nonempty `Uint8Array` input, including Buffer. They reject shared
memory, arbitrary objects and strings. Input is copied before parsing; the result
contains a deeply frozen value and `originalBytes()` returns a fresh copy of the
retained bytes. Mutating input or a returned byte copy cannot rewrite identity.

Use strict UTF-8 JSON without BOM. Duplicate decoded object keys, including
escaped spellings, malformed JSON, nonfinite numbers and limit overruns are
rejected before schema traversal. Do not reserialize, reorder keys, normalize
Unicode, normalize line endings or migrate records and retain their old identity.
Whitespace is significant to SHA-256 even when parsed JSON values are equal.

Digest references contain mandatory `domain`, lowercase SHA-256 and original
byte length. The digest is **SHA-256 of the original bytes**, with no text
normalization or hidden prefix. Domain separation is explicit in the schema and
comparison: input, procedure, result, review, evidence, companion and receipt
references are not interchangeable. Identical bytes can have the same SHA-256 in
different domains; the complete typed reference includes its domain. This scheme
provides integrity labeling, not a cryptographic signature or authentication.
`digestAcceptanceBytesV1` computes such a reference from explicitly selected
bytes. It neither reads referenced files nor verifies other supplied digests.

`ACCEPTANCE_SCHEMA_DIGESTS_V1` exports each schema identity. It hashes UTF-8
`JSON.stringify({ schema, catalog })` in the source-defined property order. The
catalog has `leaves`, `demonstrations`, `vectors`, `handoffs` in that order. The
schema's `schemaDigest` field specifies a digest shape; it does not embed its own
computed value. The registry digest retains its separately defined original
registry canonicalization. Consumers must use the exported schema identities,
not substitute a differently serialized schema. Source/dependency changes that
change these bytes change the schema identity and require a reviewed interface
successor; there is no automatic migration or fallback.

Only the exact version and schema digest are supported. Unknown fields and enums
fail closed, including inside nested objects. A newer writer needs a reviewed
successor definition and original-producer/consumer acceptance; an older reader
must refuse it. Existing evidence remains bound to its original bytes and
identities. Changed input, procedure, artifact, configuration, authority, tuple,
storage or limits require invalidation and rerun of affected claims. Preserving
only explicitly unaffected observations requires the original accountable
producer and independent reviewer to bind before/after hashes and a rationale.

## Bounds and callable results

| Limit                            |          V1 maximum |
| -------------------------------- | ------------------: |
| JSON bytes per record            |             262,144 |
| JSON depth, root at 1            |                  16 |
| Parsed value nodes               |              16,384 |
| Entries per JSON object or array |               1,024 |
| Receipt checks                   |                 256 |
| Receipt observations             |                 128 |
| Substeps per demonstration       |                  64 |
| Subchecks per vector             |                  64 |
| Referenced artifact byte length  |       1,073,741,824 |
| Opaque identifier length         | 96 ASCII characters |
| Unresolved review findings       |                  64 |

Every limit applies; passing one ceiling does not bypass another. Referenced
artifact size is a bound on its declared identity, not permission to import that
artifact into the record. Artifact access/capture needs its own owner-controlled
bounds.

`decodeAssertionCompanionV1` and `decodeProducerReceiptV1` return either
`{ ok: true, value, identity, authentication: "unverified", originalBytes }` or
`{ ok: false, code }`. Error codes are closed and contain no input excerpts:
`invalid-input`, `too-large`, `invalid-utf8`, `invalid-json`, `duplicate-key`,
`limit-exceeded`, `unsupported-version`, `schema-mismatch`, `invalid-shape`,
`metadata-mismatch`, `inconsistent-receipt` and `binding-mismatch`.
The digest helper requires a supported domain and valid bounded bytes and throws
on invalid arguments. It does not use the decoder result union.

`bindProducerReceiptV1(companionBytes, receiptBytes)` re-decodes both byte strings
and checks their exact run/leaf/input/procedure/companion identity and referenced
subchecks. A receipt's missing procedure remains missing; successful binding does
not fill it from the companion. The function returns the two decoded records and
`authentication: "unverified"`, or the same closed failure form. It does not
interpret returned records as gate acceptance.

The exported TypeBox schemas are suitable for schema inspection and producer
types. TypeBox `Check` alone does not enforce catalog joins, semantic consistency,
byte bounds or schema-digest equality. Use the callable decoders at input boundaries.

## Verification and supported scope

The independent producer and consumer examples import the actual public package
subpaths, compile under separate strict projects and use only fictional metadata
and digest-bound synthetic values. The focused conformance suite validates all
324 catalog entries and exercises malformed input, byte/depth/count limits,
versions, original bytes, outcomes, review/custody consistency and receipt joins.

```sh
node node_modules/typescript/bin/tsc -p tests/fixtures/acceptance-companion-v1/tsconfig.producer.json
node node_modules/typescript/bin/tsc -p tests/fixtures/acceptance-companion-v1/tsconfig.consumer.json
node --test tests/conformance/acceptance-companion-v1.test.mjs
```

These are local interface checks. They establish no authentic fixture execution,
full-run aggregate acceptance, installer sampling, native runtime behavior,
provider evidence, protected retention enforcement or live release qualification.
Actual producers supply reviewed procedures and authentic source/actor/attempt
observations. A separately accepted run reader and independent evidence review
must verify those joins before any supported live claim.
