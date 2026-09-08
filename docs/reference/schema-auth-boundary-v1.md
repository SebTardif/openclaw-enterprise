# Schema and auth persistence boundary

`SchemaAuthBoundaryV1` defines the database and schema types that OCC supplies to
the controller's auth composition. It preserves the existing PostgreSQL pool,
canonical schema objects and BetterAuth adapter options. The definitions now have
an [OCC-owned binding producer](postgres-auth-binding.md) and extracted core table
modules. The controller auth composition now consumes that supported factory and
keeps BetterAuth assembly and sign-in quota ownership in the controller.

## Supported imports

Import the auth definitions from
`@openclaw-enterprise/occ/auth-persistence/schema-auth-boundary-v1`:

| Export                       | Contract                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `SchemaAuthSchemaV1`         | The complete type of the canonical PostgreSQL schema module.                                       |
| `SchemaAuthBoundaryV1`       | Readonly `schema` and `database`, with the database typed as `NodePgDatabase<SchemaAuthSchemaV1>`. |
| `SchemaAuthBindingFactoryV1` | The existing `PostgresPool` input and an asynchronous binding result.                              |
| `SchemaAuthAdapterOptionsV1` | `provider: "pg"`, the full schema, `camelCase: true`, and `transaction: true`.                     |

Import `CoreSchemaRootV1`, `CoreResourceSchemaV1` and `AuthTableSchemaV1` from
`@openclaw-enterprise/occ/schema/core-schema-boundary-v1`. They refer to the
original schema root and table types; these modules export no runtime values.
Drizzle remains an OCC dependency. BetterAuth and its adapter remain controller
dependencies; consumers need no dependency anchor into another package.

The [controller fixture](../../apps/controller/tests/fixtures/schema-auth-boundary-v1/consumer.ts)
calls the actual BetterAuth `drizzleAdapter` with the typed binding and assigns
its result to `NonNullable<BetterAuthOptions["database"]>`. The
[producer fixture](../../apps/controller/tests/fixtures/schema-auth-boundary-v1/producer.ts)
checks supplied canonical values and query inference. It does not construct a
production database. The
[core consumer](../../apps/controller/tests/fixtures/schema-auth-boundary-v1/core-consumer.ts)
and [negative fixtures](../../apps/controller/tests/fixtures/schema-auth-boundary-v1/type-negatives.ts)
compile as separate projects through
[the conformance harness](../../tests/conformance/schema-auth-boundary-v1.test.mjs).
All four projects use the controller package's declared OCC dependency and resolve
the actual public exports. These tests require explicit dependency preparation
and perform no installation.

## Canonical objects and references

[shared.ts](../../packages/occ/src/state/schema/shared.ts) owns the single
`occSchema = pgSchema("occ")`, `collatedText` and `identifierPatterns` definitions.
The five core table modules import those shared values directly.
The [provider, audit and channel schema modules](schema-domain-modules.md)
retain their original tables and explicit parent references through the aggregate.
[postgres-schema.ts](../../packages/occ/src/state/postgres-schema.ts) imports and
reexports the original public root and table names while retaining every other
domain declaration and factory invocation. The controller auth composition
receives this **complete module namespace object** from the supported producer.
The producer supplies that namespace with the explicit
`drizzle({ client: pool, schema })` overload, so a structural pool cannot be
mistaken for Drizzle configuration. The controller supplies the binding's exact
schema object to `drizzleAdapter`.
A five-table projection cannot replace that runtime input: quota tables and all
other existing exports remain part of the schema namespace.

`CoreResourceSchemaV1` selects `installation`, `namespaces`, `configurations`,
`secrets` and `serviceAccounts`. Installation and Namespace are independent roots;
Namespace has no `installation_id` column. Configuration, Secret and
ServiceAccount reference the original Namespace ID with restrictive update and
delete behavior. Configuration's JSON Secret-binding check invokes
`occ.secret_bindings_are_valid`; it is not an ordinary SQL foreign key.

`AuthTableSchemaV1` selects `user`, `session`, `account`, `verification` and
`apikey`. Session and Account reference the original `user.id`, with cascade
delete and restrictive update. `apikey.referenceId` deliberately has no IAM
foreign key: it resolves through the selected IAM Driver.

The following is a static inventory of existing inbound references. It conveys
no ownership transfer or permission to alter those domains.

| Existing source                                                                                                             | Core target                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `configurations`, `secrets`, `serviceAccounts`                                                                              | `namespaces.id`                                                                          |
| `serviceAccountDriverBindings`                                                                                              | Composite `serviceAccounts.namespaceId, id`                                              |
| `agents`                                                                                                                    | `namespaces.id`, composite Configuration and ServiceAccount keys                         |
| `iamIdentities`, `iamRoles`, `iamGroups`, `iamGroupMemberships`, `iamAccessBindings`, `iamRestrictions`                     | `namespaces.id`                                                                          |
| `controllerWork`                                                                                                            | `namespaces.id`                                                                          |
| `agentRuntimeIntents`, `channelInstallations`, `channelHumanBindings`, `channelAgentBindings`, `runtimeServiceTrustRecords` | `installation.id`                                                                        |
| Existing `createTurnJournalTables` invocation                                                                               | Receives the original `occSchema` and `installation`, alongside Agent and Channel tables |
| Existing `createWorkloadProfileTables` invocation                                                                           | Receives the original `occSchema`, `installation` and `namespaces`                       |

This inventory includes nineteen directly authored core foreign-reference edges
and two factory argument groups. It does not replace metadata inspection of
those factories or comparison against the migrated PostgreSQL schema.

## Pool, transaction and failure ownership

The binding producer accepts the existing caller-selected `PostgresPool`. Actual
startup supplies a `pg.Pool`; the current public pool interface intentionally
exposes fewer methods. The binding producer handles that existing Drizzle type
crossing internally, without strengthening callers' requirements or exposing an
`unknown` database or schema.

Construction creates no pool, opens no readiness transaction, runs no migration
and exposes no teardown method. The application's existing teardown owner
continues to call `PostgresPlatformState.close()`, which delegates to `pool.end()`.
An asynchronous import or binding-construction failure propagates to the caller;
it neither closes the caller's pool nor activates an in-memory fallback.

Sharing a pool does not share a transaction. BetterAuth's `transaction: true`,
OCC's resource/work/audit transaction owner and the sign-in quota store retain
their distinct boundaries. OCC units of work, guarded clients and current-account
capabilities do not become auth inputs. Account provisioning retains its existing
compensation when later IAM or audit provisioning fails. This boundary does not
turn that sequence into an ambient cross-auth/OCC transaction.

## Implementation destinations and acceptance

The OCC-owned binding implementation is
[`createPostgresAuthBinding`](../../packages/occ/src/auth-persistence/postgres-auth-binding.ts).
BetterAuth assembly,
plugins, quota injection, logging and redaction remain in the existing
[controller auth composition](../../apps/controller/src/auth/index.ts).

The core declarations are in
`packages/occ/src/state/schema/shared.ts`, `installation.ts`, `namespace.ts`,
`configuration.ts`, `secret.ts` and `service-account.ts`. Each declaration appears
once, preserving its exact object and shared root. The canonical
`postgres-schema.ts` aggregate exposes the same complete module shape. Tables
must not be copied or spread-cloned, foreign-key targets replaced, or existing
domain factories invoked twice.

Aggregate wiring and supported exports stay with the composition owner.
[drizzle.config.ts](../../drizzle.config.ts), migrations and generated snapshots
remain with their existing owners. Agent, runtime, journal, ProviderAccountLinks
and auth-repair source are excluded from this extraction. The controller now uses
the supported auth binding instead of its former
dependency anchor and private source-URL import. Its three obsolete
[boundary exceptions](../../scripts/module-boundaries/exceptions.json) have been
removed with that adoption. Construction and controlled-refusal coverage does
not establish the PostgreSQL transaction acceptance below.

The implementation acceptance checks must establish:

- Strict producer, controller adapter, core consumer and expected-negative
  compilation through the supported package imports.
- Runtime `===` identity of every exposed root, table and column, each foreign-key
  target, and the schema object supplied to both Drizzle and the auth adapter.
- Before/after metadata equality for schema/table/column names, SQL types,
  nullability, defaults, primary and unique keys, checks, indexes, foreign keys
  and their actions; compare generated migration output without introducing DDL.
- The exact caller pool reaches the producer; construction performs no pool
  connect/end or migration call. Import/construction failures reject without
  fallback or teardown. Actual application teardown retains its original owner.
- Actual auth, quota and OCC transaction behavior on PostgreSQL, including
  rollback and existing account compensation at the adopting composition.

After explicit dependency preparation, run
`node --test tests/conformance/core-schema-extraction.test.mjs` for actual
root/table/column identity, original core metadata and inbound foreign-key
correspondence. The fixture was captured from the original complete schema using
Drizzle metadata, including references from domains outside this extraction.
[Factory conformance](../../tests/conformance/postgres-auth-binding.test.mjs)
checks actual construction and failures plus separate public consumer projects.

Structural TypeScript compatibility cannot prove runtime identity, pool lifetime,
transaction isolation or migrated schema equivalence. The definition fixtures
prove their compile contracts and the absence of runtime exports only. Factory
and extraction conformance perform no database execution. Actual auth, quota and
OCC transactions and integrated application teardown remain acceptance work for
the adopting controller composition.
