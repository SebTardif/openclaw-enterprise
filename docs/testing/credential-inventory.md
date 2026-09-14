# Credential inventory verification

Run the metadata component against a new disposable loopback PostgreSQL database
named `openclaw_inventory_*`. Follow the [PostgreSQL role and schema setup](postgresql.md),
using that name when creating the database. Apply migrations with `occ_migrator`,
then run the suite as `occ_app`:

```sh
OCC_MIGRATION_DATABASE_URL=postgresql://occ_migrator:occ-migrator-local@127.0.0.1:55432/openclaw_inventory_local \
  pnpm db:migrate
OCC_CREDENTIAL_INVENTORY_TEST_DATABASE_URL=postgresql://occ_app:occ-app-local@127.0.0.1:55432/openclaw_inventory_local \
  node --test tests/integration/postgres-credential-inventory.test.mjs
node --test tests/conformance/credential-inventory-owner-phase.test.mjs \
  tests/conformance/postgres-transaction-commit.test.mjs
```

The database must have no Installation or inventory rows. The suite never resets
existing state. Missing `OCC_CREDENTIAL_INVENTORY_TEST_DATABASE_URL` skips the real
PostgreSQL proof; the CI PostgreSQL lane provisions a dedicated database and
requires the expected test to execute.

## What the tests prove

The real suite constructs ordinary Installation, ready Namespace, Agent,
configuration and revision resources through State methods. Its ledger documents
contain historical observations only; no Runtime assignment, current credential
authority, custody producer, or accepting audit callback is constructed.

Independent transactions prove one winner for competing mint claims and stale
version updates. Exact operation and mint-claim readback survive a fresh
connection. Database tests execute immutable triggers, scope and identity checks,
foreign keys, row-lock privileges and prohibited updates/deletes. Caught and
unawaited codec failures roll the original transaction back; captured repositories
cannot be used after their phase closes.

The TCP fault proxy consumes a real PostgreSQL COMMIT acknowledgment and closes
the connection. The owner reports an unknown outcome; an independent connection
recovers the unchanged original operation, claim and version. This is real
PostgreSQL transport proof, not a patched query return. The conformance protocol
fixture separately covers ambiguous SQLSTATEs and cleanup errors.

These tests qualify [metadata storage](../reference/credential-inventory-v1.md).
They do not qualify provider effects, credential release, a deployed custody
volume, independent cleanup after Agent deletion, or live repository use.

The component must land with the actual Agent/Token owner that uses these records.
Storage tests alone do not establish a usable credential capability.
