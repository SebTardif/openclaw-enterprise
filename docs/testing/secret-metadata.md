# Secret metadata repository testing

OCC persists Secret ownership and backend references through the
[memory repository](../../packages/occ/src/state/memory/secrets.ts) and
[PostgreSQL repository](../../packages/occ/src/state/postgres/secrets.ts).
Their factories borrow the existing transaction snapshot or guarded database
client and retain the original metadata validation, reference checks, and
transaction lifetime. Configuration bindings, active revisions, and pending
revision work continue to prevent metadata deletion.

Run the focused metadata storage checks from the repository root:

```sh
node scripts/test-files.mjs -- tests/conformance/secret-repository-memory.test.mjs
node scripts/test-files.mjs -- tests/integration/postgres-secret-repository.test.mjs
```

The PostgreSQL command requires `OCC_SECRET_REPOSITORY_TEST_DATABASE_URL` pointing
to a separately prepared disposable database through the limited application
role. Follow the [PostgreSQL test environment](postgresql.md#postgresql-test-environment)
requirements. The suite checks that Installation and controller work are empty
before its bootstrap rollback case, then runs its queue-reference cases before
other fixtures append pending work. It may leave its own committed metadata;
allocate fresh database state before repeating it. Use a different database for
ordinary regression suites. An absent selector skips the live database cases.
These checks cover metadata ownership, references, transaction closure, and
resource/work/audit rollback. Kubernetes value storage and gateway delivery
require their existing separate runtime verification.
