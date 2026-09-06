# Isolated upstream consumer preparation

The isolated consumer validates a selected artifact manifest, prepares an inert check plan, and reconciles retained execution records. It uses the existing runtime package verifier and native measurement codec. It does not launch the commands in the plan, load supplied SDK implementations, install dependencies, extract packages, start a receiver, or retry work.

Use Node 24 with the repository dependencies already prepared. Select the exact manifest SHA-256 independently of the delivered manifest. A producer cannot select its own expected digest simply by changing a version label.

```sh
node scripts/isolated-upstream-consumer-v1/cli.mjs plan \
  --root /absolute/selected-inputs \
  --manifest manifest.json \
  --expected <independently-selected-sha256>

node scripts/isolated-upstream-consumer-v1/cli.mjs verify \
  --root /absolute/selected-inputs \
  --manifest manifest.json \
  --expected <independently-selected-sha256>

node scripts/isolated-upstream-consumer-v1/cli.mjs collect \
  --root /absolute/selected-inputs \
  --manifest manifest.json \
  --expected <independently-selected-sha256> \
  --observations observations.json
```

`--root` is an absolute physical directory. Input names are bounded relative paths within that root. Symbolic links and nonregular artifact files are rejected; the consumer checks file identity and contents around each read. These observations do not establish an atomic snapshot or protect against an unobserved concurrent writer.

Output is JSON on stdout. Optional `--output /absolute/new-file.json` creates a new private file exclusively, with mode 0600. The caller owns its parent directory and output retention. The CLI returns 1 for rejected input, 2 for failed/blocked verification or an incomplete required result set, and 0 for a successfully prepared inert plan or a complete reported result set. A zero exit is never runtime qualification. The module `main(args)` returns serialized output; it does not set process status or launch a child.

## Input formats and limits

`oce.isolated-upstream-consumer/v1` is a closed preparation envelope. Its checked-in fictional example is `tests/fixtures/isolated-upstream-consumer-v1/manifest.json`. The validated value is an owned, recursively frozen data snapshot.

| Field                       | Meaning                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `producer`                  | The original closed ProducerTupleV1. Enterprise/upstream/native commits, native version, gateway/state/Agent/adapter schemas, context format, import contract, import-adapter digest and artifact-ledger reference remain intact. |
| `nativeDistribution`        | Explicit `official` or `changed` classification attached to the independently selected tuple. A label is not proof that a binary implements a capability.                                                                         |
| `artifacts`                 | Explicit supplied or missing file records with role, bounded relative path, byte count and bare lowercase SHA-256. The same label with changed bytes fails the selected expectation.                                              |
| `declarations`              | Exactly the five supported host/channel/Harness public imports, their declaration artifact, package-export artifact and selected dependency-artifact references. Missing declarations cannot become a successful compilation.     |
| `completedStateDeclaration` | The public `openclaw/plugin-sdk/completed-state` data/schema/codec declaration, its package-export artifact and nonempty selected dependency closure. It grants no protected store or runtime access.                             |
| `canonicalContext`          | Selected canonical context file, exact digest and item count.                                                                                                                                                                     |
| `quiet`                     | Explicit unavailable public quiet receiver boundary, with capability/receipt artifact references and requested `completed-context-restore` purpose. `expectedReceipt` stays null.                                                 |
| `preparedContext`           | Directory and preparation receipt for the existing `oce.runtime-packages/v1` package verifier.                                                                                                                                    |
| `environment`               | Explicit caller-declared environment name/digest bindings; the verifier compares a separately supplied list, using optional `--environment bindings.json`. It never dumps or authenticates the process environment.               |
| `profiles`                  | Independent Slack and Teams profiles decoded with the original native measurement codec. Each binds the same selected producer and its own workload/channel. Known subject artifact digests must have corresponding ledger roles. |
| `cases`                     | Complete required case selection, exact artifact inputs, inert original-owner command or explicit missing-command reason, substitutes, and measurement endpoints where applicable.                                                |
| `browser`                   | `managementOnly:true`, `browserChatExposed:false`.                                                                                                                                                                                |

The original producer constants remain Codex 0.153.0, gateway protocol 4, native state schema 15, native Agent schema 19, adapter schema 1, context format `completed-context-text-v1`, and native import contract 1. Package, image, configuration, generated-client and declaration identities remain sibling ledger/profile fields; they are not extra ProducerTuple keys.

The format caps JSON inputs and results at 1 MiB, selected artifacts at 128, each artifact at 1 GiB, aggregate selected artifact bytes at 2 GiB, cases at 256 and nesting at 32. File hashing uses a bounded buffer; the byte ceilings do not allocate storage or authorize reading an unselected artifact. Small data artifacts may be captured up to the JSON limit. A larger or unsupported input fails explicitly and needs a separately reviewed format/selection change. The supplied package-context tree has an additional 512-entry bound before the existing verifier is invoked.

The parser rejects duplicate keys, invalid UTF-8/Unicode, excess depth and unsafe numeric tokens before conversion. Manifest/case counters use integer tokens. Original command records retain fractional timing values, while exit/test/byte counters still require integer tokens. Parsed counts never acquire default zero values because a record is absent.

## Artifact and declaration checks

The consumer imports `verifyContext` from `deploy/runtime/prepare-local-packages.mjs`. It verifies the independently selected context receipt and every listed context file before calling that existing read-only API, then rechecks selected bytes afterward. The original verifier checks the five local package archives, their integrity values, required files and installed-lock graph. The consumer does not call the mutating `preparePackages` path, invoke npm or create a dependency lock.

Fixture archives contain only fictional package manifests. Their byte corruption exercises the real consumer and existing context verifier. `archiveMembersVerified:false` remains explicit: `verifyContext` does not parse tar members. Extraction/inventory normalization and their actual-tar tests stay with the existing packager. `installedClosureVerified:false` also remains explicit; neither archive integrity nor a local SDK layout proves a fresh isolated installation, lifecycle completion or portable dependency closure.

Supported declarations are:

- `openclaw/plugin-sdk/gateway-host`
- `openclaw/plugin-sdk/channel-inbound`
- `openclaw/plugin-sdk/slack-hosted`
- `openclaw/plugin-sdk/msteams-hosted`
- `openclaw/plugin-sdk/codex-hosted-harness`

The compile-only fixture uses these actual exports plus the public `completed-state` data/schema/codec types. It requires `strict:true`, `skipLibCheck:false` and `noEmit:true`. It asserts the actual Harness purposes `candidate-probe | serving` and the literal `completedContextRestore:"unavailable"`. It never imports implementation values at runtime or opens a store. Select an existing reviewed declaration graph through its original owner, including actual package-export targets and all required declaration dependencies. Source aliases, missing types, workspace/private dependency substitutions or a historical checkpoint cannot silently stand in for the selected current graph.

Artifact verification reports declaration input presence and `compiled:false`. Successful compilation is separate retained command evidence. The collector checks independently selected input digests against the runner's before/after source and selected-input inventories before accepting a reported case outcome. A reported compile result still does not establish portable installation or runtime compatibility.

Preparation cases derive mandatory inputs from these typed sections. Declaration compilation requires all five public entries, the completed-state declaration, their exports and nonempty dependency selections. The package case requires its preparation receipt, archives, lock and selected context configuration. Context and quiet cases require their explicit context/capability/receipt references. Required references cannot be omitted from case or command selection; unavailable files remain representable as `missing`. The plan and collector preserve the unavailable quiet receiver as blocked even when opaque capability/receipt files and a passing assertion are supplied.

## Canonical context and unavailable quiet import

The consumer preserves the original canonical UTF-8 RFC 8785 bytes and bare lowercase SHA-256. It validates the public completed-state snapshot/item field shape, safe counters, empty attachment list, exact item count and canonical sorted-key serialization. Reformatting JSON, adding a newline, altering text or hashing another snapshot format cannot produce a matching result. `domainSchemaQualified:false` remains explicit because the original provider's semantic validation and checkpoint/authority joins are independent evidence.

The current public Harness declaration supplies no quiet restore receiver or public native-import receipt schema. Ordinary prepare/resume with `candidate-probe` or `serving` is not completed-context restoration. This version accepts `quiet.state:"unavailable"` and `expectedReceipt:null`; it rejects an invented positive descriptor, unsupported purpose or purported receipt expectation. Supplied opaque capability/receipt bytes may be hash-bound as artifacts, but cannot satisfy schema verification, quietness, settlement or receiver availability. Verification and the required quiet case remain blocked with `public-quiet-receiver-schema-unavailable`.

The original receiver owner must provide any future reviewed public capability/receipt/export boundary. A schema adapter for that new boundary requires an explicit source change and tests. No positive receiver fake, journal copy, store call or native import is hidden in this preparation.

## Required browser and measurement cases

The manifest contains 113 required case identities and three explicitly optional disabled cases. There are four preparation cases, 81 browser-boundary cases and 28 channel measurement cases. These are case identities, not executed test totals or native action counts.

| Group | Required coverage                                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1    | Effective disabled configuration, missing optional UI assets, conflicting override rejection.                                                                                                                                                          |
| B2    | Installed/reachable inventory; unauthenticated, management, expired/revoked, foreign and forged-forwarding classes; allowed control positive. Chat/bootstrap/history/attachment operations remain excluded.                                            |
| B3    | Reachable transport inventory, same/untrusted origin, saved state and service allowlist. The original operator binds actual send/history/discovery/attachment/subscription/cancel/reconnect/admin coverage. Asset failure is not transport denial.     |
| B4    | Management assets, network/storage and safe logs; synthetic canaries for credential/bootstrap exclusion.                                                                                                                                               |
| B5    | Restart, new-host and image/route/configuration replacement, plus 54 individually required B1–B4 repeats across those three scenarios. Each selected command retains actual old/new tuple and effective-configuration evidence in its input artifacts. |
| B6    | Local login, scoped browsing, draft/channel edits, foreign/stale denial and separate native Slack/Teams positive controls.                                                                                                                             |

The original operator supplies each concrete installed path inventory, exact command/argv, expected denial/result meaning, actual input artifacts and raw evidence. An absent command or unknown installed route remains blocked; the consumer neither invents a successful observation nor sends a request to discover the route. Required positive controls cannot be replaced by denial-only fixtures. Optional browser chat, attachments and native token streaming remain unselected under this scope and do not satisfy any required case.

Measurement profiles and results use the original [native measurement contract](native-measurement-v1.md). Each channel retains all 14 cases and its own exact profile digest, producer, workload, evidence class and observation slots. The selected initial profile has 680 measured and 280 warmup slots per channel within the original 1,024-slot cap. Slot counts, test reporter counts and actual native attempts are distinct quantities.

Startup, transport ACK, admitted-attempt ACK, completed-result delivery, status, busy, gateway shutdown, reconnect response, cancel ACK, trusted settlement, physical writer termination, model service and retention remain separate. The code compares the exact original observer endpoints. Unknown reconnect response can establish only a correctly labeled response-latency result; it cannot establish settlement or retention. Numeric budgets never replace authority deadlines or resource policy. Unknown resource binding, missing metrics and unselected expectations stay explicit.

## Retained execution records

The plan contains inert command descriptors. The existing execution owner runs selected commands through the maintained command/resource runner; this consumer supplies no second subprocess supervisor. The owner keeps allocation, environment, foreground process custody, deadline, settlement and output-retention responsibility.

Supplied commands bind exact argv, normalized absolute `cwdRef` and `artifactRootRef`, executable digest, complete case input IDs, environment names and expected exit. `artifactRootRef` names the independently selected artifact location for that execution; joining it with an artifact's relative path determines the exact required source/dependency/configuration inventory location. An external artifact root may differ from command cwd. Equal bytes at another inventory path do not establish presence at the selected location.

`oce.isolated-upstream-observations/v1` binds the independently selected manifest digest, evidence class, discovered/selected case IDs, attempts and optional per-channel measurement reports. Each attempt carries exact original serialized records with their original path labels. The collector never follows those path labels or executes embedded argv. It hashes the supplied bytes and checks the original record references:

- source-before inventory and `development-loop.launch-intent/v1`;
- `development-loop.launched/v1` and `development-loop.terminal/v1`;
- `development-loop.command/v1` and the immutable captured output;
- `development-loop.wrapper-result/v1` and the caller's actual return observation.

These original schemas remain unchanged. Case/selection bindings live in the separate observation envelope. A matching raw command result, complete durable wrapper and unchanged selected provenance are all required for a normal reported case. Missing records, incomplete enrichment, differing argv/input/executable identity, reused/unknown execution labels and unobserved caller completion prevent a pass. A raw nonzero negative check can match its independent expected exit while retaining its original `failed` outcome and exit code.

Raw `passed` requires an observed launched leader with exit zero; raw `failed` requires an observed nonzero exit. Launch status, PID/group, leader observation and settlement must agree. Contradictory records are rejected before expected-exit reconciliation. Before/after executable entries must be stable regular files with the selected digest and matching resolved/physical identities. The collector compares the actual inventory and executable identity content, excluding variable version-probe timing, and the source/input observations; unchanged flags alone are insufficient. Original records remain observations without authentication or an atomic snapshot guarantee.

The raw output must contain exactly one `OCE_ISOLATED_CASES_V1=` line followed by a closed `oce.isolated-upstream-cases/v1` object with `caseIds` and corresponding `results`. Each result contains `id`, `outcome`, `settlement`, nonempty `evidenceRefs` and `measurement`. The last field is null for a nonmeasurement assertion or `{channel, reportDigest}` for a report association. This is explicit producer case reporting bound to the original log digest; it is not authenticated evidence. The expected case set and selected inputs come from the independent manifest. Reporter aggregates alone cannot establish that those cases executed, and multiple attempts cannot silently become a retry-selection policy.

Each nonnull per-channel measurement input is `{content, sha256}`: exact serialized original `native-measurement-results-v1` bytes and their digest. The original decoder/evaluator validates its selected profile, subject, workload and sample accounting. A measured case can pass only if its own retained attempt's raw case-log assertion names that same channel and report digest. A same-profile report from another attempt without this association yields unknown; missing reports remain missing. Results retain the report digest alongside its original evaluation. This envelope adds no fields to the original measurement format and supplies no evidence authentication.

Command outcome, wrapper outcome, raw test counts, case assertion and domain settlement remain separate. Setup failure, timeout, cancellation, incomplete output, missing observation, unknown settlement, skip and unselected cases retain their own counts. Required missing or unselected cases cannot be dropped from the denominator. No command success, interrupt ACK, signal delivery or leader exit is proof of all physical descendants terminating. The existing runner itself does not certify that fact.

Results retain `evidenceAuthenticated:false`, `runtimeQualified:false` and `automaticRetry:false`, including a complete set of reported passes. `allRequiredReportedPass` describes reconciled input reports; it does not approve a release, native capability, installation, resource allocation or provider. Keep the original observation bundle and command records; the result is a digest-bound index and reconciliation, not their replacement.
