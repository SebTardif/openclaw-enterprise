# PostgreSQL auth database binding

`createPostgresAuthBinding` is the OCC-owned implementation of
[`SchemaAuthBindingFactoryV1`](schema-auth-boundary-v1.md). Import it from
`@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding` and await its
result with the existing caller-selected `PostgresPool`.

The result contains `schema`, the complete canonical PostgreSQL schema module,
and `database`, its typed Drizzle database. The factory passes the exact supplied
pool through to Drizzle using its explicit client option, including structural
pool implementations with configuration-like fields. It creates no pool,
connects to no database, runs no
query or migration, and owns no teardown. Import or construction failures reject
with the original error; there is no fallback. Application/state composition
continues to own pool cleanup.

The controller can pass the result to its own BetterAuth adapter using exactly
`provider: "pg"`, `schema: binding.schema`, `camelCase: true`, and
`transaction: true`. The same complete schema object must reach both Drizzle and
that adapter. Core/auth metadata projections cannot replace it. BetterAuth
assembly, quota injection, plugins, logging and account policy remain in the
controller package. Sharing a pool does not join auth, quota and OCC transactions.

The controller’s `createPostgresControllerAuth` now consumes this supported
factory in both production and development PostgreSQL composition. It passes the
returned database and complete schema directly to its own BetterAuth adapter and
retains its existing sign-in quota store on the same caller-owned pool. Real
authentication/PostgreSQL acceptance remains separate work. The binding provides
no current-account or effect authority.

After explicit dependency preparation, run
`node --test tests/conformance/postgres-auth-binding.test.mjs`.
The [conformance tests](../../tests/conformance/postgres-auth-binding.test.mjs)
invoke the real factory and Drizzle, check caller pool/schema identity and the
absence of constructor I/O, and exercise genuine dependency-import error propagation. Constructor-accessor
coverage verifies that the explicit client option does not inspect caller-owned
metadata. Construction-error propagation follows the direct uncaught call to
Drizzle; the suite does not inject a replacement Drizzle constructor. Three independent controller fixture projects check the actual
producer, BetterAuth adapter and expected type rejections through supported
imports. Emitted-import checks cover the package dependency boundary. These tests
perform no database execution and do not establish transaction isolation or
integrated authentication behavior.

The [controller adoption tests](../../tests/conformance/postgres-controller-auth-binding.test.mjs)
run with `node --experimental-test-module-mocks --test tests/conformance/postgres-controller-auth-binding.test.mjs`.
Delegating observation wrappers call the real supported binding and BetterAuth
adapter, checking the exact database/schema pair, adapter options and caller pool
identity. Construction checks cover structural pools with configuration-like
fields and production cookie defaults and overrides. The returned controller’s
real `signInEmail` method is exercised directly with a controlled pool connection
refusal; this checks quota wiring and the sanitized dependency-unavailable result,
not HTTP route registration or successful authentication. Isolated, bounded child
processes also refuse actual binding dependency resolution and check original
error identity without pool acquisition or teardown. These tests execute no SQL
and do not establish persistence, transaction isolation or actual quota accounting.
