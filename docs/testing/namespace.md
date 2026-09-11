# Namespace service and storage testing

Prepare dependencies through the [development loop](../development-loop.md) and
use the [PostgreSQL setup](postgresql.md) for each explicitly selected disposable
database. These suites exercise Namespace application and persistence behavior;
live worker and Kubernetes qualification remain separate.

## Application and HTTP checks

From a prepared checkout, run the focused application and HTTP checks:

```sh
node --test tests/conformance/namespace-service.test.mjs tests/integration/namespace-http.test.mjs
node --test tests/integration/postgres-namespace-service.test.mjs
```

The PostgreSQL service suite requires `OCC_NAMESPACE_SERVICE_DATABASE_URL` to
select a fresh, migrated disposable database using the non-superuser `occ_app`
role. An absent selector skips that suite. The checks cover exact IAM scope,
lazy bootstrap, child-resource deletion restrictions, resource/work/audit
atomicity, and rejection of stale or foreign lifecycle evidence. Lifecycle
checks use the existing deterministic Compute fixture; live worker and
Kubernetes verification is separate.

## Storage checks

Run the focused storage checks from a prepared checkout:

```sh
node --test tests/conformance/namespace-repository-memory.test.mjs
node --test tests/integration/postgres-namespace-repository.test.mjs
```

These checks exercise empty Namespace lifecycle and tombstones, resource presence,
transaction lifetime and atomic commit/rollback across repositories. For the
PostgreSQL command, set `OCC_TEST_DATABASE_URL` to a prepared disposable database
using the application role. Set `OCC_PRODUCTION_WIREUP_DATABASE_URL` to a separate,
prepared, initially empty application-role database to include bootstrap and
rollback coverage. Each missing selector skips its corresponding database cases;
see [PostgreSQL test settings](postgresql.md).
