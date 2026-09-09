# Protected outstanding-token inventory V1

The OCC inventory adapter implements the transaction logic behind the accepted
[credential storage interface](credential-storage.md). It reserves immutable
issuance intent, claims one provider mint attempt, retains mint outcomes, reads
exact original operations, persists affected snapshots, and claims and records
revocation outcomes. It creates no issuer or alternative turn authority.

**Production backend composition is unprovided.** This slice supplies a
query-only PostgreSQL repository, its five-table schema and database migration.
Production use still needs participant composition with the existing transaction
owner, actual accepting-authority owner, immutable protected token/revocation
custody, and mandatory audit writer. The selected metadata-only Secret driver
does not supply these capabilities. Credential delivery remains disabled.
The separate [GitHub App provider component](github-app-provider.md) implements
bounded provider protocol handling; it is not connected to this inventory's
production authority or custody owners and does not enable native delivery.

## Public composition

The OCC package exports these subpaths:

| Subpath                                                    | Purpose                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| @openclaw-enterprise/occ/credential-inventory-v1/inventory | createCredentialInventoryV1 and its explicitly injected owner dependencies |
| @openclaw-enterprise/occ/credential-inventory-v1/ports     | Transaction, accepting-owner and unique mint-claim interfaces              |
| @openclaw-enterprise/occ/credential-inventory-v1/backend   | Selected backend profile correspondence and explicit unsupported results   |

Transaction functions are internal implementation leaves. Production callers
use the validated facade. It applies existing closed storage codecs, nominal
authority/custody types, bounded abort/deadline handling, and trusted clock
uncertainty. Parsing a valid observation never establishes authority.

The constructor is a trusted composition function. Its accepting owner must
authenticate each local handle, immutable invocation and scope, current canonical
original turn/attempt/grant, and current binding/profile versions. The module
has no accepting-owner implementation. The selected backend binder can reject
missing capabilities and absent owner composition; successful binding still
reports runtimeQualification as not-established.

## Internal PostgreSQL composition

The internal [PostgreSQL repository](../../packages/occ/src/credential-inventory-v1/postgres.ts)
exports `createPostgresCredentialInventoryV1(context, dependencies)`. It borrows
the existing query client and checks the original owner's active transaction
phase before and after asynchronous work. It opens no connection or transaction
and classifies no COMMIT result. Actual custody and mandatory audit producers
must be injected; missing producers fail closed.

The original accepting owner ensures that Installation, Namespace and Agent
scope locks are acquired in that order once. It may use
`preparePostgresCredentialInventoryScopeV1` to implement this preparation.
A composition that has already performed the exact scope sequence must not
invoke the helper again. The owner then locks the complete bounded,
deterministically ordered key set; `preparePostgresCredentialInventoryKeysV1`
provides that preparation helper. Preparation does not establish authority.
The owner must revalidate current authority after waits and before acceptance,
enforce the exact accepted invocation and mode, and check complete transition
facts before committing. The repository reports validated record, operation,
claim, snapshot, custody and audit completion facts to that owner; these facts
create no second journal.

The internal [schema factory](../../packages/occ/src/state/postgres/credential-inventory-schema.ts)
exports `createCredentialInventoryTablesV1(schema, parents)`. It accepts the
existing OCC schema and Installation/Agent table columns, and returns
`credentialInventoryRecords`, `credentialInventoryOperations`,
`credentialInventoryMintClaims`, `credentialInventoryRevocationClaims` and
`credentialInventorySnapshots`. The declarations define scoped keys, immutable
claim uniqueness, record references, version bounds and document checks. The
database migration installs these same five tables. It preserves immutable
issuance identity and one-step record version updates, rejects history mutation,
and gives the existing application role only the column updates needed for
record CAS and ordered row locks. Lock privileges on immutable tables do not
permit rewriting them. No deletion or truncation privilege is granted.
The migration creates no credential issuer, database role, authority access
policy or encrypted material store. These internal leaves are not additional
OCC package subpath exports.

## Transaction and operation identity

The existing transaction owner implements CredentialInventoryTransactionOwnerV1.
Its run callback receives a scoped query-only inventory unit using the original
borrowed client and transaction lifetime. The complete transition, audit
acceptance, custody-reference publication and final checks require one failure
latch. A caught application error must poison that transition and prevent outer
commit. Per-query lifetime checks alone are insufficient.

The owner locks installation capacity before scope and operation/record keys,
using its accepted authority and phase ordering. Counts, uniqueness, CAS updates,
snapshots and journal writes observe the same transaction. No method here
obtains a connection, autocommits or retries.

| Owner result   | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| committed      | Outer COMMIT acknowledgment is positively observed; acknowledgedAt records that observation time |
| commit-unknown | Commit may have happened; retain exact original operation, digest and CAS for readback           |
| unavailable    | The owner positively established no commit, such as pre-start rejection or definite rollback     |

Unexpected thrown transport failures conservatively return commit-unknown.
New correlation, fresh authority, missing readback or a new operation name never
repairs uncertainty by itself.

The journal's recordedAt is an in-transaction ordering timestamp, not a database
COMMIT event time. Its preallocated commitRef is correlation until the outer
owner confirms commit. Public receipts are formed after positive acknowledgment.
An exact duplicate returns an unchanged original receipt only when the existing
owner supplies its retained originalReceipt projection. Otherwise the write
response is unavailable/inventory-unavailable, while exact readback can report
the original committed record. This missing-receipt result does not declare
rollback or permit replay. Supplied original receipts must pass the closed codec and match
the original operation, digest, commit reference and inventory version. Safe-integer
version exhaustion denies mutation before any audit, write or custody action.
There is no separate receipt cache or second journal.

## Issuance and known token responsibility

Reservation computes the canonical accepted intent digest, binds the original
service/scope/profile, and requires accepted mandatory audit. Changed duplicate
bodies, owners or CAS values conflict. Identical reservation intent returns
reconciliation-only state. Capacity is four live rows per Agent, 128 per
installation and one unresolved issuance per scope. Unresolved rows are never
evicted to make room.

The owner-facing claimProviderMintV1 loads the exact reservation, compares its
original binding, grant, profile and CAS, and durably links issuance, named-use
operation and preknown provider attempt in the same journal. It changes the row
to mint-unknown with expiry-unproven before returning a claim. A second claim is
reconciliation-only even under a fresh operation name. A claim contains no
credential or provider authority. The named-use owner must consume fresh current
authority at its fixed callback boundary after known outer commit; late
acknowledgment cannot extend authority. Repository named-use composition
remains a separate owner contribution.

Accepted mint outcomes require actual custody handles. The transaction owner
validates provenance and retains exact token/revocation references before
publishing metadata. It preserves staged material for exact mitigation through
rollback or acknowledgment loss. Known tokens in this slice always remain
mitigation-only and not-delivered.

Unknown mint never acquires expiry from elapsed wall time or nominal lifetime.
Provider-expiry evidence can bound an unresolved row without resolving it.
Expiry resolution checks both the original evidence uncertainty and the accepting
clock's conservative lower bound; provider evidence cannot erase local clock uncertainty.
Definitive rejection, conservatively elapsed evidenced expiry or separately
confirmed broader revocation can resolve it without token material. Each write
preserves its original operation and expected CAS. Late outcomes use a fresh
reconciliation operation with current CAS after definite conflict; unknown
acknowledgment requires unchanged original readback.

## Revocation and audit failure

Revocation claims retain their original operation, claim version and provider
attempt. Lease expiry permits reconciliation of the same attempt; it does not
prove the provider request ended. The adapter does not schedule a new attempt.
Late evidence can match a retained old claim with a fresh reconciliation
operation and current inventory CAS. Confirmed or expired outcomes cannot be
overwritten by pending, unknown or failed evidence.

New reservation and mint claims require accepted audit. Independently accepted
exact mitigation may retain obligation-recorded or evidence-missing without
being suppressed by audit loss. Neither means provider confirmation. If the
inventory transaction fails, uncertainty remains explicit. There is no plaintext
fallback or fabricated successful receipt.

## Affected snapshots and retention

The owner persists a bounded snapshot of all affected live known-token and
unresolved issuance rows, with exact service, scope, profile, filter digest,
version and cursor seed. A cursor matches that snapshot and its actual preceding
row. Tampering, expiry, missing state and changed filters return snapshot-invalid.

Snapshots freeze row observations. A pending member remains represented even
when a late result arrives after snapshot creation; a new snapshot observes
the newer outcome. A completed or empty page covers only its persisted snapshot.
It cannot prove that all provider effects ended or no later obligation exists.
The owning invalidation protocol must reconcile later effects.

Live/unresolved responsibility does not expire by age. Terminal inventory
retention has the inherited 30-day minimum. Audit copies have separate 30-day
retention and an authorized sweep within 24 hours; unresolved inventory does not
extend an audit copy's lifetime. This module implements no deletion sweep.

## Verification and limits

With compatible workspace dependencies already available:

```sh
node --test tests/conformance/credential-inventory-v1.test.mjs
node --test tests/conformance/credential-inventory-postgres.test.mjs
node --test tests/integration/postgres-credential-inventory.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/credential-inventory-v1/tsconfig.json
```

Tests execute the real facade, accepted codecs and transitions against an
explicitly synthetic memory transaction owner. They cover immutable digests,
two synthetic owner instances, lost acknowledgment, unique mint claims, custody
denial, original receipt replay, missing receipts, capacity, retained snapshots,
late results, audit loss, claim takeover, historical CAS, nominal-handle denial,
clocks and public subpath loading. Compile-only producer, consumer and negative
fixtures preserve the existing nominal interfaces.

The PostgreSQL conformance cases exercise the actual repository through query
and phase doubles. They cover scope rejection, ordered lock preparation, CAS,
immutable readback, transaction lifetime, missing custody/audit producers and
frozen audit projections. They execute no SQL. Focused source checks use the
actual installed SDK and Drizzle declarations with strict checking and
`skipLibCheck: true`; they do not validate every dependency declaration or prove
that a database accepts the schema.

The PostgreSQL integration suite requires
`OCC_CREDENTIAL_INVENTORY_TEST_DATABASE_URL` to select an empty, migrated,
disposable loopback database named `openclaw_inventory_*`, using the limited
`occ_app` role. It has no general database fallback and never resets existing
state. It executes the actual inventory repository through the existing
`PostgresPlatformState` transaction and borrowed query method, with the real
inventory execution phase. The phase's test scheduling inputs confer no
credential authority, and the suite supplies no accepting-owner, audit or
custody producer callbacks.

Storage cases cover fresh-pool recovery of exact original records and operations,
one durable mint claim under competing transactions, CAS and scope rejection,
rollback after a caught post-write decoding error, retained snapshots and
revocation-claim metadata, database uniqueness and foreign keys, document
bounds, and immutable-table privileges. The transport fault proxy consumes an
actual PostgreSQL COMMIT acknowledgment before closing the connection. The
original transaction owner reports unknown commit; an independent connection
reads the unchanged original operation, claim and inventory version. Readback
creates no original receipt, new provider attempt or permission to replay.

Memory serialization and JSON reconstruction are algorithm tests. They do not
prove PostgreSQL transactions, process restart, multi-process exclusion, access
control, encryption, external custody, mandatory audit persistence, runtime
isolation, provider behavior, delivery or production resource bounds. Those
qualifications require actual selected owners and separately authorized backend
tests. A passing synthetic case manufactures no current authority or production
capability. The real PostgreSQL cases establish metadata persistence and the
observed transaction behavior only; they do not establish authentic authority,
audit acceptance, protected token custody, provider effects or native delivery.
