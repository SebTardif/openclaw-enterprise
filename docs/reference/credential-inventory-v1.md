# Credential inventory metadata

The credential inventory is a PostgreSQL persistence component for retaining exact
issuance observations, immutable operation history, mint claims, revocation
claims. It stores metadata only. The controller does not
invoke it during ordinary Agent startup or expose it through HTTP routes. This
component must land with its actual Agent/Token owner and integration proof.

## Component contract

State owns the concrete PostgreSQL metadata transaction owner and repository.

`transactCredentialInventoryMetadataV1` takes the existing PostgreSQL State owner,
an Installation/Namespace/Agent scope, a complete bounded key set, and a metadata
callback. The owner supplies one original `transact` and `queryInTransaction`;
the repository acquires no client and sends no transaction-control statements.

The component locks Installation capacity before Namespace, Agent, and sorted
operation/record/claim keys. Repository calls admitted during the
callback serialize and drain before finalization, including calls the callback
forgot to await. A query, codec, scope, or transition failure permanently poisons
the phase. Catching an exception cannot make the outer transaction commit.
Captured repositories and detached continuations reject after their phase closes.

Inside the callback, returned values and `commitRef` are provisional. The outer
promise resolves only after the original owner receives `COMMIT` acknowledgment.
`PostgresCommitOutcomeUnknownError` means the transaction may have committed.
There is no automatic retry. Reconcile by reading the exact original operation,
record and claim through a new transaction; a missing row never proves that an
operation is safe to repeat. Stored timestamps describe observations and ordering,
not a database COMMIT event or a reconstructed authority receipt.

## Persisted invariants

| Data              | Enforced behavior                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Records           | Exact scope and original issuance identity; one-step inventory version updates; live/unresolved flags derived from the document. |
| Operations        | Installation-wide operation uniqueness, retained record parent, immutable input and digest; no synthesized original receipt.     |
| Mint claims       | One record claim, unique original use and provider-attempt identities within the Installation.                                   |
| Revocation claims | Immutable exact claim identity and unique claim version for each original record.                                                |

SQL constraints, foreign keys, immutable triggers and limited column grants
protect persistence. The V1 data codec additionally checks complete closed
shapes, timestamps, canonical intent digests and internal relationships. IDs and
original dispatch fields are historical observations. Decoding them never
establishes current Runtime, principal, policy, provider or credential authority.
`turnNotAfter: null` is retained as metadata; each recorded operation remains finite.
The `credential-authority-v1` entry point shares this original-binding schema;
its `leaseNotAfter` and `startNotAfter` observation bounds still require finite timestamps.

Rows have Installation and Agent parents with restrictive deletion. There is no
age eviction or cascade deletion. Outstanding and unknown responsibility remains
retained. Agent deletion with independently authorized cleanup still needs a
retained subject design before issuance can be activated.

## Boundaries and setup

Use the [PostgreSQL testing guide](../testing/postgresql.md) for disposable
database prerequisites and the limited application role.

No accepting authority facade, credential material store, provider mint/revoke
callback, named credential use, token release, repository lease, or startup
cleanup service is supplied. The metadata callback runs trusted persistence work;
its preparation phase is execution control, not an authorization decision.
A recorded provider-attempt identifier does not authorize an external attempt.

[Component verification](../testing/credential-inventory.md) covers real PostgreSQL
storage and transaction outcomes. It supplies no live GitHub, protected material,
current authority, deployed cleanup, or native receiver qualification.

## Troubleshooting

- A migration or privilege error requires the migrator-owned schema and limited
  application role. Do not grant broad table UPDATE or DELETE to fix a lock error.
- A poisoned or closed phase must be discarded. Inspect the original error and
  exact committed history; do not reopen the phase or clear its failure.
- An unknown COMMIT requires independent exact readback. Retain unresolved records
  and original identifiers until the outcome is reconciled.
