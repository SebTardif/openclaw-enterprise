# Release evidence records and collection

Use these record, collection and retention contracts with the [release evidence harness commands](../release-evidence.md#commands). The harness remains a scaffold with synthetic adapter tests and pending producer adapters; structurally valid evidence does not establish release acceptance. The [registry and selected runtime requirements](../release-evidence.md#registry-and-coverage) define what producers must eventually qualify.

## Versioned records

The JavaScript validators are the executable schema. All envelope fields are
closed: unknown keys, unsupported versions, duplicate identities, missing values,
invalid/future collection timestamps and inconsistent counts are rejected.

`inputs.json` has these fields:

| Field                               | Value                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `source`                            | Immutable 40- or 64-character lowercase hexadecimal Git object ID                                                         |
| `images`                            | Nonempty array of `{ name, digest }`, sorted by unique name; digest is `sha256:` plus 64 lowercase hexadecimal characters |
| `configuration`, `tuple`, `harness` | SHA-256 digests of the exact frozen configuration, deployment tuple and harness contents                                  |
| `registry`                          | `REGISTRY_DIGEST` exported by `scripts/release-evidence/registry.mjs`                                                     |

Choose and record how the configuration/tuple/harness bytes are canonicalized in
the reviewed producer handoff. This scaffold does not select a release tuple or
claim compatibility with a pending release-lock format. Test input identities in
`tests/fixtures/release-evidence/fixture.mjs` are synthetic values.

Each `release-evidence/v1` metadata object records:

- `version`, opaque `runId`, `supersedes` (previous run ID or `null`), `caseId`,
  `requirement`, exact registry `channel` and `profile`;
- `fixture: { id, version }`, opaque `executor`, `executionClass`;
- nonempty `steps: [{ kind: "command" | "manual", value }]`, and UTC millisecond
  `startedAt`/`endedAt` timestamps;
- exact `inputs`, and one record for every expected assertion:
  `{ id, outcome, observed, reasonCode, artifacts }`;
- `securityEvents: { adapterVersion: "pending", status, required, observed }`.

Execution classes are `source`, `unit`, `static`, `render`, `smoke`, `probe` and
`live`. Evidence from one class stays in that class. Assertions use `pass`, `fail`,
`blocked`, `skipped`, `unrun` or `unknown`. Unknown assertions retain their count
and produce a blocked case. A reported pass requires an observed assertion and at
least one artifact containing a matching assertion/outcome within the recorded
execution interval. A checksum checks integrity; the observation remains a
producer declaration, not authenticated proof. Contradictory observations for one
assertion are rejected; a changed outcome requires a separate rerun.

Security-event counts are declarations pending an accepted producer adapter.
`missing` events cannot accompany a passing case. `reported` requires equal
required/observed counts, but does not authenticate events or accept producer
semantics. A pending event adapter always prevents release acceptance. The harness
adds no competing audit event policy and accepts no raw audit log stream.

The output `manifest.json` contains metadata, generated artifact paths/checksums/
byte lengths, collection policy/status/omissions/retention/collection time,
per-assertion counts, derived case outcome and `provenance: "unverified-import"`.
Manifest data cannot select a trust level. Derived outcome precedence is fail,
blocked (including uncertainty or incomplete collection), skipped, unrun, pass.
Original failures and unknown results survive collection omissions.

## Allowlisted collector

The only accepted source kind is `release-observations/v1`. A source declaration
is `{ id, path, kind }`; it must be explicitly named in the request. The source is
JSON with a `version` and an `observations` array. Each observation projects only:

```json
{
  "assertionId": "durable-stop",
  "outcome": "unknown",
  "observedAt": "2026-01-01T00:00:01.000Z",
  "correlation": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "reasonCode": "termination-unconfirmed"
}
```

Assertion IDs come from the selected registry case; outcomes are fixed values;
correlations are 32–64 hexadecimal characters; reason codes are restricted opaque
tokens. Unknown fields are omitted before persistence and make collection partial,
which blocks a passing result. Invalid projected fields reject that source. The
collector never persists source paths, raw exceptions or raw rejected content.

There is no arbitrary text/log collector. Credentials, private keys, cookies,
authorization headers, credential-bearing URLs, raw provider exceptions, prompts,
transcripts and workspace bodies do not have an allowed observation field.
Metadata steps are exact operator-supplied command/step descriptions with bounded
text. They must contain no credential values or sensitive arguments; record a safe
reference to controlled input instead. Known sensitive forms, control/bidirectional
characters and configured canary strings are rejected before metadata storage.
The optional canary list is never stored. This detection does not identify all
possible secrets: free-text steps require review, and real producer/redaction
compatibility remains pending.

| Bound                        | Maximum                           |
| ---------------------------- | --------------------------------- |
| Source or projected artifact | 256 KiB each                      |
| Source artifacts per attempt | 16 (at most 4 MiB artifact bytes) |
| Manifest/request JSON        | 1 MiB                             |
| Observations per artifact    | 128                               |
| Recorded steps               | 32, each 2,048 characters         |
| Attempts per report          | 256                               |
| Synthetic canaries           | 32, each 8–256 characters         |
| Local retention interval     | Seven days, explicitly selected   |

Reads reject absolute/escaping source names, symlink files or ancestor directories,
hardlinked sources and nonregular files. Reads are bounded even if a file grows.
Output filenames are generated, writes are exclusive and output paths cannot be
symlinks. These checks do not defend against a hostile process with the same user
identity racing ancestor-directory replacement. Run collection in an operator-owned
directory whose writers are controlled.

A failed source produces a safe omission record and blocks any unsupported pass;
existing fail/unknown assertions retain their meaning. Interrupted or unavailable
output produces a fixed failure return and, when storage permits,
`collection-failure.json`. A directory without a complete valid `manifest.json`
is not a completed bundle. A process killed before recording failure may leave
only partial files; it must never be treated as successful evidence. The API also
accepts an `AbortSignal` for bounded cooperative interruption.

## Reruns, age and counts

Each collection creates a new directory. Keep prior bundles within the approved
retention policy. Report arguments must order each case's attempts chronologically;
each rerun names the immediately previous run in `supersedes` and begins after
that run ends. An exact duplicate import is counted once. A reused run ID with
changed contents, a branch in the rerun chain or an omitted predecessor is rejected.

The report retains every supplied attempt and its failure history. Current-case
coverage uses the latest attempt, with changed source/image/configuration/tuple/
harness inputs or expired retention reported as blocked. Earlier outcomes are
preserved in history. Unsupported registry versions are rejected and require an
explicit future migration or rerun, not relabelling old results.

`counts` and `requiredCounts` count current cases. `byClass` keeps their execution
classes separate. `requiredLiveCounts` and `gateCounts` keep required live coverage
separate from source/unit claims; pending producers prevent a live pass.
`gateResults` groups required cases for each of R1–R16. Each attempt's assertion
counts include unknown observations, and `historicalFailures` retains earlier
failed attempts even after a passing rerun. Optional provider status remains in
`cases`, outside the required-case denominator.

A report sees only explicitly supplied bundles. This is not an append-only evidence
service: an operator could omit a whole unrelated attempt or fabricate a new run
identity. Preserve the controlled original inventory for independent review.
Checksums, rerun links and a well-formed pass cannot establish that inventory's
completeness or provenance.

## Retention and local candidate export

Collection requires `retention: { access: "owner-only", expiresAt }` with a future
UTC timestamp no more than seven days away. It records collection time and enforces
the interval format. It does not schedule deletion; the operator must remove or
move expired bundles under an explicitly approved retention policy. Reports mark
expired evidence blocked and retain its reported historical results. No production
retention/access policy is inferred from this local scaffold.

Raw private evidence stays in its controlled source location. A **separate local
screened candidate** can be derived only from a complete non-live bundle:

```sh
node scripts/release-evidence/cli.mjs candidate /absolute/path/to/bundle /absolute/path/to/new-candidate inputs.json review.json
```

The review receipt is a closed `release-candidate-review/v1` object with the exact
`manifestDigest`, `policy: "synthetic-projection/v1"`, `scope: "synthetic-only"`,
`decision: "approved"`, opaque `reviewer`, `reviewedAt` and `expiresAt` timestamps.
The review must be current, last no more than seven days and expire no later than
the underlying collection. An absent, stale, mismatched or expired review is
rejected. Artifact bytes are revalidated before export. `candidate.json` lists the
exact exported files, lengths and checksums with the review declaration.

This local receipt is caller-supplied; the harness does not authenticate the
reviewer, grant publication approval or upload anything. It produces no trusted
release-acceptance flag. Real live evidence export remains disabled until accepted
producer, redaction, access/retention and review policies are integrated. The
synthetic candidate path is useful for testing that boundary, not bypassing it.

## Producer handoffs and verification limits

The following interfaces remain explicit consumer prerequisites:

- **Release inputs:** accepted lock format, canonical digest rules and the actual
  pinned candidate tuple.
- **Component fixtures:** accepted assertion-level allocation, owning fixture
  implementations, exact safe execution steps and required prerequisites.
- **Security events:** the accepted event schema/projection version, mandatory
  per-fixture event assertions and exercised adapter checks.
- **Live acceptance:** real accounts, operator environment, actual executor and
  independently reviewed assertion/provenance evidence.
- **Public evidence:** approved real access, retention, redaction and review
  disposition; local declarations cannot supply this authority.

The focused tests exercise the real registry, projection, filesystem collector,
validator, rerun aggregation and CLI. They include adversarial synthetic records,
unknown termination, missing events, partial channels/provider coverage, canaries,
path/symlink/hardlink denial, unreadable/oversized/missing inputs, interrupted
collection, unavailable output storage and real Linux `/dev/full` stdout failure. They do not execute a live component
fixture or claim gVisor, SPIRE, Slack, Teams, model, native GitHub, PostgreSQL or
release qualification. Artifact-filesystem ENOSPC behavior and hard process termination
are not simulated as successful collection evidence.
