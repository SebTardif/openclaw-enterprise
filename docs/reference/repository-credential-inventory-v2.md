# Repository credential inventory V2

The internal repository-lease extension stores GitHub token responsibility under
the existing [credential inventory](credential-inventory-v1.md) transaction owner
and operation journal. It retains immutable Work, execution and access-lease
correspondence, bounds overlapping credentials, and prevents a new lease or
Namespace from bypassing a held provider target.

This is a storage component. Production accepting authority, mandatory audit,
protected token material and committed release require their original owners. The extension
does not register an API, issue authority, mint a token or enable credential
delivery. Work observations and successful database reads confer no permission.

## Stable ownership

An access lease retains the original `WorkOriginalOperationV2`,
`VersionedWorkRefV2` and `WorkExecutionAssociationV2` values. It does not reinterpret
them as an older original-turn credential binding. The complete lease document
is immutable. Its Installation, Namespace, Agent, execution receiver and Work
cannot change under the same access-lease reference.

The stable provider target consists of:

- OCE Installation ID;
- canonical host `github.com`;
- GitHub App ID;
- GitHub installation ID;
- repository ID.

Provider IDs use canonical positive decimal strings. They remain strings in
storage so persistence never rounds an ID. The provider boundary must
separately reject IDs it cannot represent exactly. Repository aliases, Namespace,
binding, permission-profile revision and key generation are absent from the stable
target key. Both TypeScript and PostgreSQL verify its SHA-256 encoding.

## Existing transaction and journal

`createPostgresCredentialInventoryV1` supplies the internal `repositoryLeaseV2`
query projection on its same guarded query client and transaction phase. The
existing V1 facade and original-turn records keep their formats. V2 records and
operations use the existing inventory record and operation tables; mint attempts
use the existing immutable mint-claim table. Cleanup claims use the existing
immutable revocation-claim table. An additional immutable access-lease
table stores ownership, not another operation journal.

`transitionRepositoryInventoryV2` applies the storage transitions. Every `staged`
result remains provisional inside the original transaction. The existing owner
must authenticate the actual operation, append mandatory audit, verify custody
and complete currentness/finalization before it can acknowledge outer COMMIT.
This component has no independent COMMIT or positive accepting callback.

The original owner locks Installation capacity before Namespace and Agent, then
prepares the complete operation/record key set. The Installation lock serializes
target-wide hold and capacity checks across Namespaces. The extension never adds
a second scope lock pass or acquires an independent transaction. A caught query
or decoding failure poisons the original phase.

## Recovery identity before mint

The versioned V2 mint claim includes the complete nonsecret custody identity:
the immutable access lease, the selected App key's client ID, binding reference
and immutable version, the original provider attempt, and the preallocated token
and protected-revocation references. This identity is part of the claim operation's
digest and must commit before the single provider invocation. The original
material source authenticates the key selection; these stored values confer no
authority themselves.

The V2 reader uses its exact versioned decoder on the same original claim table.
The V1 seven-field decoder remains unchanged. A legacy V2 claim lacking recovery
identity fails closed; the reader cannot reconstruct it using guessed token
references or a newly selected App key. Accepted token metadata must match the
references committed in the original claim.

After a crash between protected capture and accepted-outcome COMMIT, the original
owner can use that retained identity to address the same ciphertext and immutable
key selection. The accepting owner still must authenticate the protected retention
and observed result. A claim, captured material, or successful readback alone does
not authorize another mint.

## Capacity and uncertainty

Each access lease has two database-enforced live slots and at most one active mint
reservation/claim. Reserved and unknown mints consume capacity alongside known
tokens. The existing Installation-wide maximum of 128 potentially live records
also applies. There is no eviction that releases a slot.

A claimed mint becomes `mint-unknown` before any possible provider invocation.
It holds the stable target until an outcome is retained. A known token with
mismatched, unproved, contradictory or late evidence becomes `mitigation-only`.
Retirement also places a known token in that state. Both states hold the target
against new issuance under other access leases, Namespaces or binding generations.

Known matching material can become `current-check-required` only within the
original issuance and access-lease deadlines and an evidenced provider expiry.
That state requests a genuine current-authority check; it is not a release permit.
This component stores token and revocation references only. Actual custody must
already retain and authenticate material before the original owner accepts its
metadata transition.

Known material retains the provider's actual bounded returned-permission map,
including broader permissions that require mitigation. If the response was
missing or malformed, or historical custody did not retain that observation,
`returnedPermissions` is exactly `{ "kind": "unavailable" }`. An empty map means
an observed empty permission map; requested permissions cannot stand in for an
unavailable observation. Unavailable permissions never satisfy eligibility,
even if a separate scope flag is true. The original owner can still record the
known token as `mitigation-only`, recover its exact material and claim cleanup.

Definite non-dispatch can resolve an unclaimed reservation. After a durable claim,
`recordRepositoryMint` can record authenticated `definitely-not-dispatched`
evidence for that exact original attempt and inventory version. It is distinct
from a provider rejection. A later invocation's busy/refused result cannot prove
that the original invocation sent nothing. Only accepted definite nonissuance,
confirmed provider revocation or conservatively
elapsed evidenced expiry releases capacity. An unknown outcome cannot replace a
previously established expiry with a different or unproved value. Contradictory
expiry accompanying a recognizable token retains the token for mitigation with
unproved expiry; previous evidence stays in immutable operation history.

Exact duplicate operations return the original stored observation and
`reconcile-only`. They do not create a new claim or receipt. Lost COMMIT
acknowledgment requires unchanged original operation readback through the original
owner. Missing readback is not permission to replay. Terminal records and operation
history remain retained; live lease enumeration includes only the outstanding
responsibilities in that lease.

## Durable cleanup

`claimRepositoryRevocation` binds the exact record, token, protected-revocation
reference and revocation operation to a versioned claim in the original journal.
The first claim allocates one provider attempt and a five-second claim lifetime.
It retires the token to `mitigation-only`. A competing claim cannot take over an
unexpired lease; conservative clock uncertainty also applies to lease expiry.

After expiry or an unknown outcome, a new claim version can reconcile only that
same provider attempt and revocation operation. It must identify the preceding
outcome. Claim expiry does not establish that the token was revoked, release its
slot, or permit an unrelated provider attempt. Historical claim rows remain
immutable, including after a restart or an unknown COMMIT acknowledgment.

`recordRepositoryRevocation` validates the exact durable claim, token, attempt and
current inventory version. `unknown` and `not-dispatched` retain the target hold
and require the current claim reference; stale nonterminal evidence cannot retire
a newer active claim. An authenticated confirmation from an older claim for the
same attempt can settle the current responsibility with its current record CAS.
Confirmed revocation records a terminal responsibility and releases its live slot.
The outcome operation retains the exact historical claim and evidence references.

Provider execution follows known claim COMMIT and occurs outside the transaction.
The original mitigation owner authenticates cleanup, late capture and outcome
recording independently of the closed Work or disconnected user receiver. This
storage projection creates no mitigation handle or provider receipt and supplies
no token bytes.

## Verification

With prepared workspace dependencies, use:

```sh
node --test tests/integration/postgres-repository-lease.test.mjs
```

The suite requires `OCC_REPOSITORY_LEASE_TEST_DATABASE_URL` selecting its own empty,
migrated loopback database named `openclaw_inventory_*`, with the restricted
`occ_app` role. It never resets a database and has no general connection fallback.
Database preparation follows the existing [test settings](../testing/postgresql.md#postgresql-test-environment).

The suite exercises the actual inventory queries/transitions and original
`PostgresPlatformState` transaction against PostgreSQL. Storage observations and
phase scheduling controls do not supply current Work authority, admitted revisions,
audit acceptance, protected token material or provider effects. These are separate
producer contributions required before the broker can use this component in a
production flow.
