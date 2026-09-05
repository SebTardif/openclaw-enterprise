# Isolated PostgreSQL pilot

This opt-in runner gives each of two complete suites its own newly created,
migrated database:

- `tests/integration/postgres-runtime-assignment-state.test.mjs`
- `tests/integration/postgres-channel-bindings.test.mjs`

The suite files and their shared contracts are unchanged. Runtime CAS, immutable
grants, rollback and actual lost-COMMIT-acknowledgement checks remain enabled, as
do channel uniqueness, serialization, audit rollback and authenticated restart
checks. The ordinary `test:postgres` command remains serial. Other PostgreSQL,
production-bootstrap, cluster and real-runtime tests are outside this pilot.

## Explicit preparation

An operator must allocate an **exclusive disposable PostgreSQL 18 instance** with
the existing `occ_app` and `occ_migrator` roles. Both roles must retain
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`. Provision distinct random role
and administrator passwords. Do not point this tool at a shared development or
production instance. A database-name prefix alone does not authorize cleanup.

The initial tested capacity is two suite processes on an instance capped at two
CPUs, 2 GiB memory and 100 server connections. Each suite uses multiple database
connections internally. Run only one pilot invocation at a time in its allocated
instance. Do not increase parallelism from this bounded proof.

Record an owner-only JSON configuration, owned by the executing user and readable
only by that user. Obtain `systemIdentifier` from the allocated instance's
`pg_control_system()` result before using the runner. The fields are:

```json
{
  "host": "127.0.0.1",
  "port": 54321,
  "adminUser": "postgres",
  "adminPassword": "<distinct-random-admin-password>",
  "migratorPassword": "<distinct-random-migrator-password>",
  "applicationPassword": "<distinct-random-application-password>",
  "systemIdentifier": "<allocated-instance-numeric-identifier>",
  "namePrefix": "oce_test",
  "expiresAt": "<finite-allocation-expiry-as-ISO-8601>"
}
```

The prefix must start with `oce_` followed by 1–16 lowercase letters or digits.
The selected port must be reachable on IPv4 loopback from the actual execution
environment. Native PostgreSQL fault tests also need local TCP listeners. The
tool does not install packages, start Docker, change permissions or escalate
execution. Prepare dependencies and the instance separately, using the
[development loop](../development-loop.md).

## Run complete suites

Use a new output directory for every invocation; its parent must already exist.
Paths below are examples of operator-owned local files.

```sh
node scripts/test-postgres-isolated.mjs \
  --config /path/to/protected-allocation.json \
  --output /path/to/new-runtime-run --suite runtime

node scripts/test-postgres-isolated.mjs \
  --config /path/to/protected-allocation.json \
  --output /path/to/new-channel-run --suite channels

node scripts/test-postgres-isolated.mjs \
  --config /path/to/protected-allocation.json \
  --output /path/to/new-parallel-run --mode parallel
```

The default is both suites serially, each on its own database. There is no test
name filter or broad discovery option. Each child runs one complete file with
Node's normal process isolation. Application children receive only their own
`OCC_TEST_DATABASE_URL`; migration children receive only their own
`OCC_MIGRATION_DATABASE_URL`. Inherited PostgreSQL credentials, alternative
infrastructure selectors and `NODE_OPTIONS` are excluded. This is environment
hygiene, not isolation from hostile same-user code that can inspect local files.

The runner persists an immutable exact-name manifest before issuing SQL. It
checks server identity, refuses existing names, records successful creation and
the database OID/owner, and marks custody with a run-specific comment. Migration
uses the existing installed Drizzle CLI and source migrations with the migrator
role. Privileged setup connections close before application children start.

Per-database marker readback and distinct persisted Installation identities
verify state separation. Both databases use the same role names and role
credentials within this exclusive instance; this is test-state isolation, not
credential-level isolation between databases.

## Results, cancellation and cleanup

`manifest.json` records the exact database allocation; `events.jsonl` records
creation identities, child start/exit times and verified database absence.
`summary.json` records setup, migration, execution and cleanup timings, selected
suite hashes, actual counts and failures. Full TAP and migration logs are retained
with credentials redacted. A skipped, cancelled, incomplete or failing suite
fails the run. Child intervals show whether execution actually overlapped;
parallel mode alone does not establish overlap or a performance improvement.

SIGINT/SIGTERM cancel owned process groups, including Node test workers, and wait
for child close before database cleanup. A child failure cancels its peer and
prevents queued launches. New database, migration and suite launches require at
least a one-minute cleanup margin before allocation expiry. Commands have bounded
deadlines capped by the remaining lease minus that reserve. Linux process-group
inspection confirms no live descendant remains; any already terminated,
reparented zombies are reported separately without claiming they were reaped by
this runner. Uncertain live-group state retains database custody for cleanup.
Cleanup continues after expiry; it must not be abandoned with resources
still owned.

Cleanup rechecks the instance, database OID, owner and custody marker. It refuses
changed identities and active connections, and never uses `DROP ... FORCE` or
terminates unrelated sessions. It drops only successfully identified resources
created by this invocation, then verifies absence. This lookup/drop sequence
assumes the allocated instance is exclusive; it is not a lock against a competing
administrator replacing databases.

A lost CREATE acknowledgement or a failure before identity/marker capture can
leave an uncertain resource. The journal records its exact requested name; the
runner does not infer ownership from a later name match. Cleanup failure remains
a failing result alongside the original error, with the manifest and journal
retained for the allocation's cleanup custodian. Do not blindly rerun a DROP by
prefix or remove the output evidence. A preexisting sentinel belongs to its
separately recorded custodian throughout negative testing.

## Verify the lifecycle helper

The ordinary conformance test exercises actual local child processes without
opening database connections:

```sh
node --test tests/conformance/postgres-isolated-runner.test.mjs
```

Real lifecycle acceptance requires a separate explicit selector, the protected
allocation and a new evidence directory:

```sh
OCC_TEST_ISOLATED_POSTGRES=1 \
OCC_ISOLATED_POSTGRES_CONFIG=/path/to/protected-allocation.json \
OCC_ISOLATED_POSTGRES_EVIDENCE=/path/to/new-lifecycle-evidence \
node --test tests/integration/postgres-isolated-lifecycle.test.mjs
```

Explicit selection without required inputs fails. Without that selector, broad
test discovery reports this privileged fixture unavailable with a skip; ordinary
`OCC_TEST_DATABASE_URL` never authorizes provisioning. Such a skipped run is not
lifecycle acceptance. The selected lifecycle checks cover instance mismatch,
preexisting-state preservation, partial setup, changed marker/OID refusal, real
SQL child failure, and interruption of the actual two-suite runner with verified
cleanup. Full successful individual and overlapping suite runs remain separate
acceptance evidence.
