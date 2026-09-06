# Operation sampling and installer journals

The modules in `scripts/release-evidence/operation-sampling-v1/` prepare and inspect
bounded sampling and independent-installer evidence. They run no installation,
command, native story, provider request, capture service or retry. Imported command
and manual-step instructions are inert records. All successful decoding, reporting
and receipt binding remains `authentication: "unverified"`.

The adapters consume the existing [assertion companion](acceptance-companion-v1.md)
catalog and the current `producer-receipt/v1` decoder directly. They add no catalog,
operation controller, registry format or new field to the closed companion and
receipt records. Source tests do not establish real measurements, independent
installation, a supported runtime tuple, or release acceptance.

## Supported local records

| Version                            | Schema and decoder                                                | Meaning                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `operation-sampling-plan/v1`       | `OperationSamplingPlanSchemaV1`, `decodeSamplingPlanV1`           | Selected original input identities, procedure review, requirements, seeds and explicit expected sample/attempt slots                       |
| `operation-sample-journal/v1`      | `OperationSampleJournalSchemaV1`, `decodeSampleJournalV1`         | Actual declared attempts, capture references, clocks, observations, outcomes and omissions                                                 |
| `independent-installer-journal/v1` | `IndependentInstallerJournalSchemaV1`, `decodeInstallerJournalV1` | Installer declaration and independence evidence, prerequisites, ordered instructions, attempt history, interventions and cleanup inventory |

`SAMPLING_SCHEMA_DIGESTS_V1` exports each schema's SHA-256 over its exact compact
JSON serialization. Every input carries its version and matching digest; a schema
change changes that digest. The original supplied UTF-8 bytes determine journal
result and evidence identities, including whitespace. Successful byte decoders
snapshot those bytes and freeze their parsed values. Duplicate JSON names, lossy
numeric tokens, unknown properties, invalid dates and oversized inputs fail with
a bounded diagnostic code.

These formats accept integer milliseconds only. A missing observation is explicit
`{ "state": "missing" }`, never zero. A partially observed journal may be
structurally valid while its report remains incomplete. Missing mandatory plan
identity cannot be repaired with an invented tuple or procedure. A plan declared
`live` requires a supplied procedure review, but that declaration and its digest
do not authenticate the review. Synthetic examples use fictional seeds and
evidence with the `synthetic` source label and cannot claim live execution class.

## Selected sampling denominators

The plan binds allocation digest
`df384f890282b4b19f9ba54f1c109ec82e405b359bed7bb9ee867680d836b9db`
and selected P6 disposition
`93abd3f8d226c7e4da1f123d152437d592aa94018c45d193e14d9381e8f3d0a3`.
Its explicit requirements come from the reviewed procedure and input manifest.
The implementation does not invent a required operation or outage/restart list.
An omitted real procedure requirement therefore remains a producer/reviewer
inventory obligation; hashes and the supplied list alone cannot prove fidelity.

| Requirement kind    | Selected minimum                             | Counted observations                                                                                               |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `runtime-operation` | Three per required operation/purpose/variant | Fresh accepted samples with usable own execution identity, captured start/end/interval and seed/freshness evidence |
| `native-story`      | Ten per native channel                       | Fresh qualifying A/B stories; distinct actors and ordered, captured successful A then B turns                      |
| `timed-condition`   | Ten per condition/variant                    | Distinct fresh attempted slots, including failures and unavailable ends                                            |
| `negative`          | Every required negative at least once        | Distinct fresh attempted slots, retaining failures and defined outage/restart variants                             |

Each plan includes runtime, both Slack and Teams story, timed-condition and
negative requirements. Its explicit expected inventory may exceed the selected
minimum. Seeds, initial attempt IDs and story IDs are unique; every requirement
retains its own operation, condition, variant, purpose, channel and leaf. A sample
binds the existing leaf's original parent case/assertion pair. Only existing
primary `P-OPS` leaves are supported by these adapters.

`evaluateSamplingV1(planBytes, journalBytes)` returns the complete supplied plan,
journal and requirement rows. Each row separately reports expected, attempted,
fresh attempted, observed, accepted, qualified fresh, qualified stories, missed,
failed, unknown, blocked, skipped and unrun counts. Missing expected sample IDs
remain visible. Twenty qualifying native stories imply at least forty A/B turns.
Failed stories may require additional fresh planned stories; a retry or probe
cannot fill that denominator. Historical failures remain after a later attempt.
Repeated receipt adaptation does not create a journal attempt.

Retries and probes reference a prior original fresh attempt and preserve its
sample, seed, story and requirement identity. The journal keeps their own attempt
IDs and ordered predecessor links. Duplicate or contradictory identities and
reused turn IDs fail. Shared evidence references are declarations, not proof of
another execution. The adapter does not authenticate seed freshness, a native
actor or observation capture.

## Clocks, bounds and descriptive statistics

Every sample preserves request receipt, authenticated acceptance, durable commit,
each declared boundary's last allow and first deny, original clock identity and
uncertainty, and any available monotonic reading. Local denial starts at
authenticated request acceptance and retains a 60,000 ms target. The report also
shows request-to-denial, commit-to-denial and commit latency. A failed or ambiguous
commit cannot supply an eligible successful disable duration. Its captured raw
timings and every certain bound violation remain separately from statistical
eligibility. A denied state needs its own capture and a matching first-deny
observation clock. Missing expected
boundaries remain unavailable, even when other samples have complete clocks.

`measureDurationV1` uses matching monotonic domains when available, otherwise
matching wall-clock domains. It does not subtract unrelated wall clocks. Endpoint
uncertainties yield a lower/upper duration interval. A bound is violated when the
entire interval exceeds it; a straddling interval is indeterminate. A certain
violation fails the bound regardless of any percentile. The report preserves every
violation and every omitted or indeterminate duration with its attempt identity.

Plan-defined `measurements` retain additional operation, stop or exhaustion
endpoints and their exact procedure-supplied maximum. `hard-bound` entries are
evaluated; `observation-limit` entries describe observation only. They establish no
target completion when elapsed. The fixed provider-revocation observation episode
is 120,000 ms; physical-observation duration is separately declared. Each token's
issue, revocation and expiry observations remain independent of local denial,
stream outcome, cancellation acknowledgment, native terminal and physical
termination. An unknown token stays unknown after an observation episode expires.

`describeDurationsV1` retains raw rows, denominators and eligible counts, and
groups by requirement, operation, condition, variant, purpose, native channel,
boundary/subject, metric, clock domain, method and bound. It never pools these
groups into a favorable average. Statistics use milliseconds; median averages
the two middle values for even counts, and descriptive p95 uses nearest rank
`ceil(0.95 * n)`. A group with no eligible values has `statistics: null`. An empty
input has no summaries. Ten samples establish no tail reliability or SLA.

## Installer evidence

`evaluateInstallerV1(journalBytes)` preserves the independent actor's declaration
and its separate evidence of independence, including author identities. A name
different from an author's name is insufficient. All reports retain
`independenceAuthenticated: false` and `installationEstablished: false`.

The journal distinguishes cold installation from replacement and records package,
procedure and input identities, exact prerequisite outcomes and ordered command
or manual instructions. Command records preserve executable, argument array and
working directory as inert text. Attempt results preserve actual step actor,
exit code or explicit absence, capture, unknown/skipped/unrun states and prior
failed attempts. A fully captured earlier failure remains a known outcome; it
does not by itself block a later complete successful attempt. The selected
successful attempt needs its own completed steps and usable execution bound to
the declared installer. Missing steps remain visible. Manual steps cannot have invented
process exit codes.

Interventions identify the actor, affected attempt/step, visibility, description
and available evidence. Private or unobserved interventions remain incomplete;
another actor's intervention cannot silently become an independent installer
step. Retained, cleaned and unknown resources keep their evidence and cleanup
responsibility. Missing prerequisites, package references, review, independence,
capture, resource inventory and omissions remain report issues.

## Receipt adapters and current unavailable-end mapping

`adaptSampleJournalV1` takes original plan/journal/companion bytes, a selected
attempt ID and a `JournalReceiptDeclarationV1`. `adaptInstallerJournalV1` takes
the installer journal, companion, selected attempt and the same declaration.
Callers supply receipt identity/history, collection/outcome, checks/observations,
review, custody, redaction, invalidation and reuse from the actual producer.
The adapter supplies only the exact journal and companion identities and the
selected journal execution. It does not synthesize passing procedure subchecks.

The plan/journal join compares procedure-review presence and exact identity.
The local companion join verifies run, input manifest, procedure, limits, tuple and four
ordered demonstration-input identities. The journal's original bytes are hashed
in both existing `result` and `evidence` domains. The receipt uses its `result`
reference; the returned `journalEvidence` can be used in producer-supplied checks.
Both references identify the same original bytes under different domain tags.
A recorded review must bind the exact result bytes under the existing decoder.

Only an explicit `not-launched` declaration with evidence maps to receipt
`execution.state: "unrun"`. A missing launch record stays `launch-unknown` and
cannot produce a representable execution. A known launched attempt with missing
start, executor or tool remains a local partial journal and fails receipt
adaptation. Nothing substitutes receipt time, zero or guessed identity.

A launched attempt with an available start and unavailable end maps to the current
`end-unavailable` receipt branch, with no end or duration fields. A local interval retained with an unavailable end
describes original elapsed observation only; it never supplies a target end or
receipt duration. Only overall
`unknown` or `blocked` is permitted. Missing capture stays explicitly missing.
Known failed subchecks can remain in such a receipt without converting its
overall native execution into `fail`, which requires an observed end. An actually
ended wrapper or observer can describe its own end; its independent target
terminal/physical observations still cannot acquire a fabricated end or settlement.

Adapters invoke `decodeProducerReceiptV1` and `bindProducerReceiptV1` on the
serialized current record. `P-OPS` always has the primary role; supporting roles
belong to the existing designated producers. A collected journal cannot be
relabeled as missing collection, and the selected sampling attempt collection
must match its receipt declaration. Rejected collection, missing review, redaction,
invalidation, original receipt linkage and reuse remain explicit. A declared
sampling pass requires its complete supplied inventory and sample minima and no
failed/indeterminate bound or omitted duration. These checks still establish no authentic acceptance.

## Finite limits and verification

The decoder accepts at most 4 MiB per local record, depth 24, 131,072 parsed
nodes and 2,048 entries in one container. The schema caps plans at 128
requirements/512 expected samples, sample journals at 1,024 attempts, installer
journals at 128 attempts/256 ordered steps, and individual observation lists.
The statistics inventory caps at 16,384 rows; the sampling report caps at 16 MiB.
Overflow fails without dropping evidence to make a smaller successful report.
Observation intervals cap at seven days; timestamps and monotonic readings remain
explicit finite values. These storage/processing ceilings grant no runtime authority.

With the repository's pinned Node, TypeScript, TypeBox and formatter prepared,
run the pure synthetic integration suite and separate strict consumer:

```sh
node --test tests/integration/operation-sampling-v1.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/operation-sampling-v1/tsconfig.json --pretty false
```

The strict consumer uses `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noEmit` and
`skipLibCheck: false`. Checks exercise actual local modules and exported companion
decoders. They install no dependencies. A full application build, live capture,
reviewed real procedure, native/channel execution, actual runtime measurements
and independent installation require their own genuine inputs and verification.
