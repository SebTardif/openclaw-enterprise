# AgentRevision repositories

AgentRevision repositories store the admitted Configuration, selected Driver and
ServiceAccount credential references used by an Agent revision. They expose
`findRevision`, `listRevisions` and `createRevision` through the existing platform
read view and unit of work. They do not change deployment admission, select a
runtime or store Secret material.

The [memory adapter](../../packages/occ/src/state/memory/revisions.ts) borrows the
transaction owner's live revision and Namespace maps. The
[PostgreSQL adapter](../../packages/occ/src/state/postgres/revisions.ts) borrows the
existing guarded client. Shared validation, row decoding and Secret availability
checks remain supplied by the platform store. Factories perform no I/O during
construction and resolve the current Installation only when creation needs it,
including when Installation and revision ownership are created in the same unit.

Creation compares the revision's Agent, service principal, Provider and optional
ServiceAccount identity with the current Agent. It preserves the admitted
Configuration and credential snapshot instead of substituting newer metadata.
Secret bindings retain existing normalization and exact Namespace availability
checks. Returned records and history are immutable copies. PostgreSQL history
uses revision-number order; memory retains its stored insertion order. Ordinary
deployment admission creates sequential revisions.

The PostgreSQL application role has explicit execution permission on the read-only
credential-selection CHECK validator. The validator runs with the caller's own
privileges and verifies the stored selection's shape and Installation/Namespace/
Agent/revision scope. Revision update and delete privileges remain absent; the
validation grant supplies no credential-use or runtime authority.

Repository methods share the outer transaction lifetime. Operations accepted
before the callback closes drain through their internal collaborators; escaped
handles reject subsequent calls. PostgreSQL commit/rollback, authority poisoning,
audit and work-queue ownership remain with the existing store. The adapters open
no nested transaction or independent connection. A revision's storage success
does not establish runtime activation or delivery.

From an explicitly [prepared worktree](../development-loop.md), run the focused
memory contract:

```sh
node scripts/test-files.mjs --test-concurrency=1 -- tests/conformance/revision-repository-memory.test.mjs
```

The PostgreSQL contract requires its own fresh, migrated database selected by
`OCC_REVISION_REPOSITORY_TEST_DATABASE_URL`, using the limited application role
from the [PostgreSQL test environment](settings.md#postgresql-test-environment).
It checks the empty Installation before its bootstrap rollback case, then tests
the wired adapter and a factory using an uncommitted owner connection:

```sh
node scripts/test-files.mjs --test-concurrency=1 -- tests/integration/postgres-revision-repository.test.mjs
```

Without that selector, the database cases skip; the constructor-only case does
not prove PostgreSQL behavior. These storage tests cover immutable snapshots,
owner and Secret checks, lifetime closure and rollback with sibling resources,
active revision, work and audit. They do not access a live runtime or Secret
backend. Relevant deployment/CAS and repository commit-outcome regressions remain
part of validation when composing a storage change.

The credential-validator privilege regression uses `OCC_TEST_DATABASE_URL` with
`occ_app` on an explicitly selected, migrated disposable database. It checks the
actual function ACL, creates and reads revisions through the PostgreSQL store,
and verifies database rejection of malformed or mismatched credential records.
Its transaction rolls back every fixture row:

```sh
node --test tests/integration/postgres-revision-validator-privilege.test.mjs
```
