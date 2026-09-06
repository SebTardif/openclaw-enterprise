# Retained journal cost measurement

The retained journal cost runner plans and executes a bounded synthetic PostgreSQL
journal workload through the existing OCC journal repository. It separates retained completed turns
from attempts whose execution outcome remains uncertain, and describes read,
duplicate-admission and append traffic across a finite set of clients and Agents.

Planning is independent of database dependencies. Execution uses the original
`journalHarness`, `PostgresPlatformState` and `TurnJournalStore` with their existing
storage fixture provenance. Those synthetic inputs measure repository behavior;
they do not establish transport authentication, native execution or canonical and
workspace durability. A successful plan or passing pure conformance test supplies
no database measurement.

## Create a plan

Save an explicit configuration such as this to a local JSON file:

```json
{
  "schemaVersion": 1,
  "seed": 12345,
  "agents": 4,
  "retainedTurnsPerAgent": 8,
  "uncertainAgents": 1,
  "replyBytes": 1024,
  "clients": 2,
  "operationsPerClient": 32,
  "hotKeyPercent": 50,
  "readPercent": 60,
  "duplicatePercent": 20,
  "uncertainReadPercent": 25,
  "maxRunMs": 30000
}
```

Run the planner with the repository's selected Node version:

```sh
node tools/benchmarks/retained-journal-cost-v1.mjs --plan /path/to/workload.json
node --test tests/conformance/retained-journal-cost-v1.test.mjs
```

The output includes `evidence: "planned-only"`, a SHA-256 of the normalized
configuration, initial cohort counts and each client's planned operation locators.
It contains no measured samples or database information. `--help` prints usage.
Neither command loads the PostgreSQL driver or storage fixture implementation.
The separate `--run` mode requires the explicit selection described below.

## Configuration and scheduling

All fields are required. Unknown fields, nonintegers, unsafe values, negative zero
and out-of-range values are rejected. The JSON file is limited to 16,384 bytes.
These are limits on this measurement planner, not product storage budgets or
performance targets.

| Field                   | Meaning and bounds                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`         | Exactly `1`.                                                                                                                                                                                                  |
| `seed`                  | Deterministic scheduling seed, from 1 through 4,294,967,295. It is not an identity or cryptographic value.                                                                                                    |
| `agents`                | 1–32 independent Agent cohorts.                                                                                                                                                                               |
| `retainedTurnsPerAgent` | 1–1,024 initial completed turns in each cohort.                                                                                                                                                               |
| `uncertainAgents`       | 0 through `agents`; the first such cohorts each retain one additional uncertain attempt.                                                                                                                      |
| `replyBytes`            | Requested synthetic reply size in UTF-8 bytes, 0–65,536. The existing repository fixture has no reply-payload field; execution reports this dimension as unmeasured instead of expanding unrelated metadata.  |
| `clients`               | 1–16 clients, no more than the number of Agent cohorts.                                                                                                                                                       |
| `operationsPerClient`   | 1–4,096 planned operations per client. Total planned operations must not exceed 32,768.                                                                                                                       |
| `hotKeyPercent`         | 0–100 percentage weight for selecting the first eligible retained key or Agent rather than another seeded selection.                                                                                          |
| `readPercent`           | 0–100 read-operation weight.                                                                                                                                                                                  |
| `duplicatePercent`      | 0–100 exact duplicate-admission weight. Together with `readPercent`, it must not exceed 100. The remainder selects append operations.                                                                         |
| `uncertainReadPercent`  | 0–100 percentage of reads directed to the uncertain cohort; a positive value requires at least one uncertain Agent.                                                                                           |
| `maxRunMs`              | Finite intended execution bound, 1–600,000 milliseconds. Execution stops scheduling when its setup/measurement budget expires, then drains accepted work; this is not a hard database cancellation guarantee. |

The initial attempt count is `agents * retainedTurnsPerAgent + uncertainAgents`
and may not exceed 16,384. This count describes requested setup; an executed
measurement must independently report the actual committed dataset. If all Agents
retain uncertain work, append traffic must be zero. Required uncertain ownership
is not cleared to make room for the workload.

The four operation kinds are:

- `completion-read`: an initial retained completion locator.
- `uncertain-attempt-read`: the additional uncertain attempt locator for an
  uncertain Agent, after a real dispatch/consumption binding is present.
- `duplicate-admission`: an initial retained completed-turn locator, preserving its
  original admission identity.
- `append-completed-turn`: a new synthetic locator on an Agent outside the uncertain
  cohort. The planner assigns distinct increasing turn indexes per eligible Agent.

The execution profile permits at most 4,096 planned operations and 2,048 initial
plus potential append attempts. Larger valid plans are rejected before execution.

Numeric cohort locators are workload descriptions. They are not canonical journal
keys, verified identity handles, authority receipts or evidence that a state exists.
Execution creates legal fixture transitions through the original journal and
compares exact observable outcomes. It assigns a distinct conversation to each
turn, so retained completions remain separately addressable. Original fixture
UUIDs are random; the report saves their exact locators and operation references.
The seed reproduces scheduling and cohort shape, not those UUIDs or timestamps. An admitted attempt lacking
dispatch fields cannot be substituted for the represented uncertain-attempt case.

Generation is ordered by client ID and then operation index. Read and duplicate
traffic use seeded key selection; append traffic maps each client to a nonuncertain
Agent. Multiple clients can therefore target the same eligible Agent. The plan does
not promise a concurrent completion order or turn a planned append into a committed
turn. Percentage weights describe selection probabilities, not exact realized
counts. Equal normalized configuration and generator source produce equal plans;
changing the seed changes the generated sequence.

## Execute an explicitly selected database workload

Use a separately owned, already migrated, empty disposable database and its limited
application role. The runner creates no database, schema, role or migration and
performs no pruning, truncation, statistics reset, forced checkpoint or cleanup.
It refuses a populated Installation or journal and leaves all created state for
its database custodian. Reusing the populated target is not a benchmark reset.

Supply these process environment values through your local credential handling:

| Variable                             | Required binding                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCC_RETAINED_JOURNAL_DATABASE_URL`  | PostgreSQL URL with explicit loopback IP, port and selected role/database; query-string overrides are rejected. Keep credentials out of command arguments and reports. |
| `OCC_RETAINED_JOURNAL_DATABASE_NAME` | Exact preallocated database name.                                                                                                                                      |
| `OCC_RETAINED_JOURNAL_DATABASE_OID`  | Exact observed database OID.                                                                                                                                           |
| `OCC_RETAINED_JOURNAL_DATABASE_ROLE` | Exact limited application role, also matching the URL user.                                                                                                            |
| `OCC_RETAINED_JOURNAL_RUN_REF`       | A new bounded local report correlation reference.                                                                                                                      |

```sh
node --env-file=/path/to/private-selection.env tools/benchmarks/retained-journal-cost-v1.mjs --run /path/to/workload.json --output /path/to/new-report.json
```

The report file must not already exist and is created with mode `0600`. It records
an initial nonexecuted state before loading database dependencies, then retains
setup and final observations. Output is bounded to 16 MiB. Database name/OID/role,
absence of other target clients, empty state and restricted role capabilities are
checked before seeding. These checks do not allocate the selected resource or
establish cluster-wide isolation.

The ordinary PostgreSQL pool preserves the repository's bounded-read contract:
250 ms maximum connection checkout, no custom client or verification hook, finite
statement and lock timeouts, and at most the configured client count. Setup and
measurement share `maxRunMs`. Expiry or a process termination signal stops new
work and drains already admitted operations. Existing transaction behavior may
finish after that scheduling deadline; elapsed time and incomplete operations
remain visible. No operation is automatically retried, including commit-unknown.

The fixture performs admission, dispatch intent, consumption, checkpoint allocation,
completion publication and reservation release as separate original outer
transactions. Every acknowledged stage is checked against its actual result. An
opaque consumption claim is discarded and no native initiation callback is called.
The uncertain cohort records an execution-unknown outcome and never requests
reservation release. Actual checkpoint/native/workspace evidence remains synthetic
and is labeled accordingly.

After execution, the runner reads every retained original owner/link, attempt,
completion and head, and checks pending delivery. The current public journal does
not independently expose exact uncertain reservation membership; that verification
limit remains explicit. No raw database row is substituted for a public attempt
projection. Relation-count/size queries are measurement instrumentation only.

A `measured` report requires all planned operations to finish with their expected
read/replay/completed/busy classifications, retained-state checks to succeed, and
WAL/plan metrics to be available. Conflicts, denials, unexpected failures, unknown
commits, skipped scheduling or missing required metrics leave `incomplete` and a
nonzero exit. Neither status establishes an integrated production capacity or
storage qualification. Preserve an incomplete report and its exact operation
locators before any separately owned recovery decision.

## Measurement boundaries

The report identifies the repository commit/tree, changed paths, selected source
hashes, Node and direct-source execution, actual PostgreSQL settings, requested
and committed dataset sizes, client schedule and exact operation outcomes.
Committed successes, exact replays, busy/conflicting/capacity refusals, errors and
timeouts require separate counts. Failed or unavailable operations cannot disappear
from the denominator. Existing uncertain owners and referenced heads must remain
retained, and the benchmark must not prune records or change the schema.

Elapsed operation latency uses a monotonic clock and milliseconds. The exported
aggregation helper uses nearest-rank p50/p95/p99 across individual samples, with
count, minimum, maximum and arithmetic mean. An empty sample set returns count zero
and null metrics; it cannot become a zero-latency result. Aggregate client samples
before computing percentiles rather than averaging client percentiles. Small
samples offer limited information about tail latency.

The fixture records total `store.transact` duration by stage and outcome, including
the actual outer commit acknowledgment. It cannot isolate SQL COMMIT duration
without changing the original bounded pool; isolated COMMIT and fsync latency
therefore remain unmeasured. End-to-end append samples also include all transitions
and verification reads.

Database commit acknowledgment, PostgreSQL WAL growth, allocated relation bytes,
canonical SQLite flush and workspace synchronization are different measurements.
A PostgreSQL result cannot establish canonical-store or workspace durability, device
fsync latency, physical writer exclusion or cross-store completion reservation.
Unavailable metrics must remain unmeasured. WAL and relation growth require actual
before/after observations and attribution limits, including background activity and
page allocation. Plans are actual post-measurement `EXPLAIN (FORMAT JSON)` results for the original
lookup shapes and retained fixture parameters, tied to the source and parameter
hashes. They do not execute the query and are not intercepted SQL or timed samples.
A source SQL string alone is not an observed query plan. WAL deltas are explicitly
cluster-wide and unisolated, with no per-operation attribution inferred.

Reads of uncertain attempts use the represented dispatched and consumed attempt
record. Completion reads use the exact completion operation. The original incoming
admission retry preserves its owner and link; its actual `duplicate` field remains
false for that original link even though the workload labels the operation an exact
replay. Append contention can record sticky busy admissions; these are counted
separately from completed turns. Pending delivery is retained without sending or
reserving any external delivery attempt.

A known committed status lookup measures that lookup's cost. It does not reproduce
a lost COMMIT acknowledgment, establish rollback, or authorize another execution.
Any actual fault exercise must retain the original operation identity and use the
accepted independently authorized recovery surface after the original transaction
unwinds. This runner does not inject such a fault. Its pure conformance suite executes no
database, provider or native runtime operation.
