# Password-attempt budget fixtures

Run `password-budget-manual` only against seven separately owned, disposable
PostgreSQL 18.6 servers. The suite changes database state and the negative cases
require cluster-wide role memberships. Never use a shared development or
production server. The fixture owner provisions and removes the complete
instances; the test does not create roles or establish cleanup authority.

This is component qualification. It does not enable authentication, register the
SQL supplier, establish deployment key custody, or prove two running controllers.
The positive case uses two State instances and SQL backends.

## Prepare each database

Follow the [PostgreSQL setup](postgresql.md) with the exact candidate's normal
migrator. On each server, provision `occ_app` and `occ_migrator` without
SUPERUSER, CREATEDB, CREATEROLE or BYPASSRLS. Create one fresh database named
`openclaw_ci_password_budget_` followed by twelve lowercase hexadecimal digits,
with the normal `occ` and `drizzle` schema ownership and application grants.
Migrate as `occ_migrator`; leave `occ.installation` empty. Do not apply
`sql-suppliers/password-attempt-budget.sql` yourself: the tests apply those
checked-in bytes and inspect their outcomes.

All seven databases must start from the same candidate migration history. The
owner retains exact server, database, role, migration and resource identities,
capacity limits and cleanup receipts. Bind each server to a distinct loopback
port and keep administrator access for teardown outside the application/test
manifests. A failed or uncertain test is not proof of rollback or removal; stop
use of that fixture and let its owner reconcile and remove it.

## Select the role cases

The positive server has no extra `occ_app` membership. For each negative server,
create only the role graph shown below, **after** normal migration. Temporary
roles `occ_password_budget_member_test` and `occ_password_budget_bridge_test`
are nonprivileged NOLOGIN roles. `pg_maintain` is PostgreSQL's predefined role.
The fixture owner makes these grants; the restricted test clients do not.

An edge `member → parent` denotes membership in `parent`. Specify all three
options explicitly; PostgreSQL defaults are not the test contract.

| Manifest environment variable                              | Membership edges                                                                              | SET           | INHERIT       | ADMIN         |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------- |
| `OCC_PASSWORD_BUDGET_FIXTURE_MANIFEST`                     | None                                                                                          | —             | —             | —             |
| `OCC_PASSWORD_BUDGET_DIRECT_ROLE_FIXTURE_MANIFEST`         | `occ_app → occ_password_budget_member_test`                                                   | TRUE          | FALSE         | FALSE         |
| `OCC_PASSWORD_BUDGET_TRANSITIVE_ROLE_FIXTURE_MANIFEST`     | `occ_app → occ_password_budget_bridge_test → occ_password_budget_member_test`                 | TRUE on both  | FALSE on both | FALSE on both |
| `OCC_PASSWORD_BUDGET_DIRECT_MAINTAIN_FIXTURE_MANIFEST`     | `occ_app → pg_maintain`                                                                       | FALSE         | TRUE          | FALSE         |
| `OCC_PASSWORD_BUDGET_TRANSITIVE_MAINTAIN_FIXTURE_MANIFEST` | `occ_app → occ_password_budget_bridge_test → pg_maintain`                                     | FALSE on both | TRUE on both  | FALSE on both |
| `OCC_PASSWORD_BUDGET_DIRECT_ADMIN_FIXTURE_MANIFEST`        | `occ_app → occ_migrator`                                                                      | FALSE         | FALSE         | TRUE          |
| `OCC_PASSWORD_BUDGET_INHERITED_ADMIN_FIXTURE_MANIFEST`     | `occ_app → occ_password_budget_bridge_test`; `occ_password_budget_bridge_test → occ_migrator` | FALSE on both | TRUE; FALSE   | FALSE; TRUE   |

For example, the owner creates the direct ADMIN counterexample with:

```sql
GRANT occ_migrator TO occ_app WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
```

Apply that only on its dedicated negative server. The inherited ADMIN case must
not grant `occ_app` effective USAGE of `occ_migrator` or any alternative SET path.
The test inspects the complete reachable membership edges, not just the presence
of its intended grant. Do not add unrelated grants or role attributes.

## Write private manifests

Each selector names an absolute path to a mode-0600 regular JSON file with exactly
these connection fields:

```json
{
  "appUrl": "postgresql://occ_app:REPLACE_WITH_FIXTURE_PASSWORD@127.0.0.1:55432/openclaw_ci_password_budget_012345abcdef",
  "migratorUrl": "postgresql://occ_migrator:REPLACE_WITH_FIXTURE_PASSWORD@127.0.0.1:55432/openclaw_ci_password_budget_012345abcdef"
}
```

Replace the port, unique database suffix and passwords with that fixture's
values. Percent-encode password characters when forming URLs. Both URLs must
identify the same loopback host, explicit port and database, with no query or
fragment. Keep files and values out of Git, command output and reports. Only
paths are selected through the environment. No `predecessorSupplierPath`,
baseline database or private historical source is required.

## Run and interpret the lane

With all seven selectors set in the test process and the matching repository
dependencies prepared, run from the repository root:

```sh
node scripts/ci/run-tests.mjs run password-budget-manual \
  --state /absolute/private/password-budget-state.json \
  --results /absolute/private/password-budget-results.json
```

The lane has no preparation hook and is outside `ci` and `full`. It requires the
positive reservation case and all six named negative role cases in
`tests/integration/postgres-password-attempt-budget.test.mjs`; missing fixtures
or skipped expected cases do not qualify the lane. The positive case permits
30 seconds, each negative case 15 seconds. The operator also supplies a finite
outer run/cleanup deadline and resource budget; test timeouts do not prove that
a query or backend has settled.

The positive case applies the current supplier with safe roles, then checks
reservation limits, capacity, expiry, maintenance and app-role restrictions.
It is the reproducible positive control. ADMIN cases apply the **same checked-in
supplier** with the specified unsafe memberships. They require SQLSTATE `42501`
and the distinct `password budget application has role administration authority`
message. The supplier reaches that diagnostic only after its other application
and object-privilege checks pass. Thus a permission failure elsewhere cannot
stand in for the ADMIN refusal. Each negative case rolls back the aborted
supplier transaction and verifies its objects are absent.

Retain exact source, role/membership and test-result evidence, then close clients
and remove only the identity-checked owned instances. Independent cleanup
readback is separate from test success. A synthetic transport test, a lane
inventory audit or ordinary PR CI cannot substitute for these database results
or the real sign-in workflow proof.
