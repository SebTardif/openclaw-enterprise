# Runtime assignment storage verification

Run the component tests from the repository root:

```sh
node --test tests/conformance/runtime-assignment-memory.test.mjs tests/conformance/runtime-authority-memory.test.mjs tests/conformance/runtime-authority-storage-contract.test.mjs
```

Prepare a disposable database using the [PostgreSQL guide](postgresql.md), then
run the retained storage behavior with the limited `occ_app` role:

```sh
node --test --test-concurrency=1 tests/integration/postgres-runtime-assignment-state.test.mjs tests/integration/postgres-runtime-authority.test.mjs
```

`OCC_TEST_DATABASE_URL` selects that migrated database. Without it, PostgreSQL
cases explicitly skip. Tests require PostgreSQL 16 or newer and verify the
connection has no superuser, role-creation, database-creation or row-security
bypass privileges. Migrations use the separate migrator role.

The shared contract exercises scope isolation, stable Agent identity, distinct
lifecycle/execution generations, immutable initial binding, conflicting
operations, exact replay and rollback. PostgreSQL adds independent-client races
and actual constraints against direct writes by the limited role.

A loopback TCP proxy receives the real server COMMIT completion and closes the
connection before delivering it to the client. The owner must report an unknown
outcome. A fresh pool reads the exact original receipt and replays it without
creating another operation, including after intent advancement. This substitutes
transport failure only; persistence remains real PostgreSQL. It does not test a
database restart.

The fixtures do not launch gVisor, authenticate a service, issue workload
identity, authorize admission or mediate a request. The storage component must
land with the actual Agent/Token workflow and that workflow's runtime proof.
