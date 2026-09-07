# Persistence schema domain modules

Provider account bindings, audit events, channel bindings, Agents, IAM tables and controller work have separate schema modules under `packages/occ/src/state/schema/`. The canonical `postgres-schema.ts` aggregate continues to expose the same table names and objects to persistence consumers and the [auth database binding](postgres-auth-binding.md).

`provider-account-bindings.ts` declares the existing ServiceAccount Driver binding table and references the original ServiceAccount columns. `audit.ts` declares the existing audit event table. Both use the shared `occSchema` object. `channel.ts` exports the internal `createChannelTables` constructor; the aggregate calls it once with the original Installation and Agent columns, then exposes the three resulting channel tables.

`agent.ts` constructs the existing Agent and revision pair; `iam.ts` constructs the six existing IAM tables from the original Namespace and Agent columns. The Agent metadata callback reads its IAM identity target synchronously after the aggregate finishes constructing that table. `work-queue.ts` constructs the existing controller work table and reads the original runtime-admission and lifecycle-admission references only in its metadata callback. This preserves the aggregate's construction order without module import cycles. An early metadata read fails; no reader creates a replacement table, performs I/O or grants authority.

These modules preserve columns, defaults, checks, indexes, foreign keys and delete/update actions. The channel constructor does not resolve metadata eagerly, allocate a database connection or add authorization behavior. It receives already selected canonical parent objects. Factory helpers and shared implementation helpers remain outside the aggregate schema exports.

Existing journal, workload-profile, lifecycle-admission and credential-inventory factories keep their own source ownership and receive the same original table objects. Moving `auditEvents` does not create a delivery backend, acknowledge export, or change the lifecycle outbox. Database triggers, deferred constraints, migrations and transaction ownership remain unchanged.

## Verification

On a prepared workspace, run the focused checks:

```sh
node --test tests/conformance/domain-schema-extraction.test.mjs
```

Three fresh processes exercise different import orders through the actual aggregate and leaves. A fourth process constructs the actual Agent/IAM cycle once, verifies rejection of a premature metadata read, then resolves the completed original foreign-key targets. The checks compare the fourteen moved tables and their related foreign keys against the canonical objects, including Drizzle's distinct local extra-config columns. A fixture captured from the real pre-extraction aggregate retains the full export set, detailed moved-table metadata, related references and a digest of the complete normalized schema. An intended later schema change requires a newly reviewed baseline; changing only this fixture cannot establish unchanged schema behavior.

The extraction also requires a same-input comparison using actual drizzle-kit snapshots and generated DDL, plus affected strict compilation and module-boundary checks. Retain the existing [schema/auth boundary](schema-auth-boundary-v1.md), including caller-owned pools and distinct authentication/OCC transactions. Metadata and DDL-generation checks do not execute database migrations or establish real authentication, database constraints, delivery or runtime behavior. Those checks retain their own selected infrastructure and owners.
