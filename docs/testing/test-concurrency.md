# Measure local test concurrency

The concurrency benchmark runs one fixed local test selection at file concurrency
1, 2 and 4, with one and two simultaneous invocations. It measures the tradeoff
between an individual invocation's latency and completed work across invocations.
It does not change the explicit test runner's default or allocate host resources
to other agents. Coordinate a bounded measurement window with the shared-host
owner before running it.

## Prepare and run

Prepare the worktree and installed dependencies explicitly as described in the
[development verification loop](../development-loop.md). Linux with readable
`/proc` and GNU `/usr/bin/time` is required. Run from a prepared worktree:

```sh
node scripts/benchmark-test-concurrency.mjs --output=/path/to/new/private-results --repeats=2
```

The output directory must be new, outside the product repository, and have an
existing parent directory. Preserve results from earlier attempts. The only
options are `--output=...`, `--repeats=1|2|3` and standalone `--help`. Two repeats
are the default. The second repeat reverses configuration order to expose some
order effects; this small sample does not establish statistical significance.

The maximum is two runner process groups, each with four Node test-file children.
The runner and measurement wrappers are additional processes. Existing internal
fixture process behavior is preserved. No test filters, database, cluster,
browser or native build suites are selected. Do not export unrelated live-test
configuration into the invocation.

Before each configuration, the benchmark requires at least 8 GiB of Linux
`MemAvailable`. Missing or insufficient memory information stops new launches
and retains partial evidence. This is a guard against starting another sample
under pressure, not a reservation or automatic scheduler. Stop the benchmark
if another owner reports capacity trouble.

## Fixed selection

The full contents of these eight files are selected on every invocation:

| File under `tests/conformance/` | Local behavior exercised                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| `configuration-occ.test.mjs`    | Configuration ownership, revisions and native admission                     |
| `contracts.test.mjs`            | Driver and immutable platform resource contracts                            |
| `iam.test.mjs`                  | In-memory native IAM grants, restrictions and identity scope                |
| `kubernetes-compute.test.mjs`   | Kubernetes Driver conformance with explicit local transport fixtures        |
| `occ-api-security.test.mjs`     | Real local HTTP application, authentication and authorization               |
| `occ-read.test.mjs`             | Controller reads and ownership authorization                                |
| `secret-occ.test.mjs`           | Secret metadata, bindings and operation authorization                       |
| `workspace-files.test.mjs`      | Workspace HTTP routes, bounded provider calls and local disconnect behavior |

Kubernetes conformance is not real-cluster evidence. This representative manifest
is not the whole conformance suite or repository-wide test discovery. Current
counts come from each execution; historical counts are not expectations for a
changed source tree. Existing workspace/module checks and full required
acceptance remain necessary at handoff and integration.

The benchmark uses [the explicit-file runner](../development-loop.md#validate-a-manually-selected-test-scope),
preserving literal file selection and Node process isolation. It records and
compares the complete TAP summary and reported case names/outcomes across runs.
Skips and TODOs remain explicit. A missing summary, failed or cancelled test,
changed discovery, or changed recorded source/dependency identity invalidates
the comparison and stops the matrix. A failed configuration is never ranked as
a successful throughput result.

## Interpret evidence

`report.json` records source HEAD, a content digest of tracked source and the
benchmark files, selected-file hashes, installed-lock and SDK-receipt identities,
Node version, execution order and results. Installed lock/SDK receipts do not hash
every dependency byte. Keep the prepared dependency tree unchanged during the
measurement. Per-configuration JSON and per-invocation TAP/resource files retain
failed and interrupted evidence. These are private files; they can contain local
paths and application diagnostics.

Each `*.tap` receipt log is a new snapshot created after owned process groups
have drained; its hash and parsed outcomes describe those snapshot bytes.
`*.live.tap` contains the original writable capture and is not an immutable
receipt. An escaped writer could still change a live capture after interruption;
it cannot change the newly created snapshot through its earlier descriptor.

| Measurement                                | Meaning and limits                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Invocation wall time                       | Monotonic launch-to-close time for its measured Node invocation                                                                                 |
| Configuration wall time                    | Both invocations' combined makespan, including sampling and owned-process drain                                                                 |
| Successful invocations / second            | Complete passing invocations divided by configuration wall time                                                                                 |
| Passed tests / second                      | Passing tests from successful invocations divided by configuration wall time; skips are excluded                                                |
| GNU time user/system CPU                   | CPU accumulated through the waited child hierarchy; no parent-only CPU substitution                                                             |
| GNU time maximum RSS                       | An OS process high-water mark, not simultaneous aggregate memory                                                                                |
| Sampled sum RSS peak                       | Maximum observed sum across owned process groups at roughly 100 ms intervals; short peaks can be missed and shared pages counted more than once |
| Host load, busy fraction, available memory | Whole-host pressure that includes unrelated activity; it is distinct from owned-process use                                                     |

Process samples include PID and start time to distinguish reused process IDs.
Unavailable resource output after interruption is `null`. CPU accounting and
cleanup do not cover processes that deliberately escape the owned process groups
and waited hierarchy. Tests retain responsibility for their external resources.
SIGINT/SIGTERM stop both owned groups, await their completion and preserve the
original signal outcome. A surviving owned process receives bounded cleanup;
such cleanup is recorded and invalidates successful acceptance rather than hiding
a leaked lifecycle. No unrelated process is terminated.

Compare the same source, selected cases and outcomes, consider both latency and
aggregate throughput, and inspect pressure for each sample. Preserve the current
default when the evidence is inconclusive. One host's short matrix cannot justify
a global cap, fairness policy or scheduler.

## Verify the benchmark

```sh
node --test tests/conformance/benchmark-test-concurrency.test.mjs
```

The tests execute actual isolated Node suites for a complete small matrix,
explicit skips, failed assertions, invalid selection/options, evidence retention
and SIGINT/SIGTERM cleanup. They verify measurement behavior, not application
coverage. The application matrix above supplies the latter's selected local
evidence.
