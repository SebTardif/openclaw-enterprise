# Controller, Agent, and Configuration service testing

These focused checks exercise current OCE services, repository transactions, and
worker behavior. Prepare dependencies through the [development loop](../development-loop.md)
and databases through [PostgreSQL testing](postgresql.md). Use the limited
application role for test execution; each named dedicated selector requires its
own fresh, migrated disposable database. An absent selector skips the associated
suite and supplies no PostgreSQL evidence.

## Agent and deployment services

Focused coverage is in the [Agent service tests](../../tests/integration/agent-service.test.mjs),
[deployment service tests](../../tests/integration/deployment-service.test.mjs),
and [actual HTTP application tests](../../tests/integration/agent-service-api.test.mjs).
The [PostgreSQL Agent tests](../../tests/integration/postgres-agent-service.test.mjs)
and [PostgreSQL deployment tests](../../tests/integration/postgres-deployment-service.test.mjs)
exercise persisted ownership, concurrent admission, rollback, and lost commit
acknowledgement. They use separately prepared disposable databases selected by
`OCC_AGENT_SERVICE_DATABASE_URL` and `OCC_DEPLOYMENT_SERVICE_DATABASE_URL`,
respectively; follow the [test database settings](postgresql.md)
for application-role access.

## Configuration services and repositories

After preparing development dependencies, run the focused service and HTTP
checks with `node --test tests/conformance/configuration-service.test.mjs tests/integration/configuration-http.test.mjs`.
For real PostgreSQL coverage, select a fresh, migrated disposable database with
the non-superuser `occ_app` role in `OCC_CONFIGURATION_SERVICE_DATABASE_URL`, then
run `node --test tests/integration/postgres-configuration-service.test.mjs`.
That suite checks lazy Installation persistence, ownership, concurrent generation
updates and conditional edits, and mutation/audit atomicity. An absent database selector is a skip,
not PostgreSQL evidence. These checks use the existing Configuration storage
fixture; they do not establish live Kubernetes ConfigMap or RBAC proof.

Run the focused storage checks after preparing development dependencies:

```sh
node --test tests/conformance/configuration-repository-memory.test.mjs
node --test tests/integration/postgres-configuration-repository.test.mjs
```

For the PostgreSQL command, `OCC_TEST_DATABASE_URL` selects the prepared
application-role database for ordinary storage cases.
`OCC_PRODUCTION_WIREUP_DATABASE_URL` separately selects an independently prepared,
empty disposable database for same-unit bootstrap coverage. Follow the existing
[PostgreSQL test environment](postgresql.md) requirements.
An absent selector skips its corresponding database cases. These checks exercise
Secret references, generation contention, transaction closure and cross-resource
atomicity through the actual storage adapters.

## Worker lifetime, leases, and reconciliation

Run the exported worker lifetime and finalization cases:

```sh
node --test tests/integration/controller-worker-lifetime.test.mjs tests/integration/worker-finalization-outcome.test.mjs
```

The lifetime suite controls pool and Driver waits without replacing worker
lifecycle methods. It does not establish database readiness. Finalization cases
check completion ordering, with real PostgreSQL conflict cases when the ordinary
application-role database is selected.

With the [PostgreSQL application-role test configuration](postgresql.md),
run [postgres-worker-leases.test.mjs](../../tests/integration/postgres-worker-leases.test.mjs)
and [postgres-worker-reconciliation.test.mjs](../../tests/integration/postgres-worker-reconciliation.test.mjs)
using `node --test` and each file's path. The lease suite targets actual database
lease loss, successor-claim protection, and shutdown draining. The reconciliation
suite targets claim identity and attribution, Namespace denial and supersession,
active-revision compare-and-set races, failure between publication and completion,
and transactional audit rollback. Their recording Drivers observe worker
ordering; live Docker, Kubernetes, and Harness execution require their separate
runtime suites described in the [testing guide](README.md).

## Mutation and runtime admission persistence

```sh
node --test tests/conformance/mutation-coordinator.test.mjs tests/conformance/runtime-assignment-memory.test.mjs tests/conformance/runtime-admission-memory.test.mjs
node --test tests/integration/postgres-mutation-atomicity.test.mjs tests/integration/postgres-runtime-assignment-state.test.mjs tests/integration/postgres-runtime-admission.test.mjs
```

Use the ordinary application-role PostgreSQL test selector. These cases cover
real constraints, concurrent transactions, mutation atomicity, and lost COMMIT
acknowledgements. Run affected actual API and revision-worker consumers as well.
Compute observations in these tests do not establish live provider identity,
effect fencing, selected-runtime approval, or deployment qualification.
