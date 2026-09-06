# Named credential custody and material cache V1

This local TypeScript component implements bounded material lease caching,
exact named metadata resolution, fixed callback admission and staged-version
rotation control for the accepted credential storage V1 contract.

It supplies **no protected backend, current-authority issuer, database transaction,
provider route, login flow or deployment**. The default missing capability remains
unavailable. The selected Kubernetes Secret driver resolves ownership metadata;
it cannot supply immutable protected versions or material by itself.

## Composition

The owning OCC package exposes four leaves:

- `credential-custody-v1/custody`: `createNamedCredentialCustodyV1` and its
  `ProtectedCredentialPortV1`-compatible local owner.
- `credential-custody-v1/ports`: explicit trusted owner dependencies.
- `credential-custody-v1/cache`: bounded opaque material lease cache.
- `credential-custody-v1/backend`: exact metadata/account projection checks.

The factory snapshots the selected backend declaration and fixed callback
identities at trusted startup. Only an explicitly registered callback may consume
a real protected adapter's handle. No request can select a callback, material
accessor, URL or credential class fallback.

The actual installed composition must provide:

1. An authoritative current binding/account/Secret projection from existing
   owners, including logical and immutable versions, exact account link and
   backend namespace/name/key/UID/resourceVersion.
2. The existing `SecretDriver.resolve` and `ProviderAccountLinks.find`, under
   their original transaction/lifetime ownership.
3. A protected immutable adapter that authenticates exact backend access, verifies
   immutable history, owns encryption and key custody, and transfers only the
   minimum invocation-material lease. A declaration of support is not evidence.
4. A current model-use owner that authenticates the actual invocation-bound handle,
   checks the exact original operation/profile/account/binding/current invalidation,
   durably accepts mandatory audit and consumes authority at the fixed callback.
   The existing operation journal rejects exact replays, changed bodies under an
   existing operation and possible prior effects after unknown outcomes, including
   across facade restart. The material facade adds no operation/permission ledger.
5. For rotation, a management owner that checks authority before staged-version
   lookup and again in the existing atomic binding/invalidation/scan/audit
   transaction, returning success only after the known outer commit.

All dependencies are local trusted process interfaces. Their nominal TypeScript
types are not an authentication boundary. A malicious or incorrectly implemented
injected owner can violate the interface; it must be reviewed and qualified.

## Existing metadata reader

`readNamedCredentialMetadataV1` accepts the canonical
`Pick<SecretReadRepository, "findSecret">`,
`Pick<ServiceAccountReadRepository, "findServiceAccount" | "findServiceAccountProviderBinding">`,
`ProviderAccountLinksAccess` and the selected `SecretDriver` metadata resolver.
The existing trusted composition supplies the exact OCC Secret ID, Secret driver
and account/Namespace/provider/provider-driver/workspace selection. Installation
and transaction/read lifetime remain with that composition. The provider driver
and Secret driver are separate identities. The reader opens no transaction.

The reader validates exact returned ownership and returns a closed metadata
observation. Missing or foreign rows, undefined memory provider bindings, an
aborted read or resolver errors return a constant unavailable diagnostic.
Account credential name/key hints are never joined to an OCC Secret or returned.
The observation is valid only for the owner's read lifetime; it is not a current
binding projection and must not be retained as permission.

Even a successful metadata observation reports both named capabilities as
`unsupported / capability-unimplemented`, custody as `unprovided`, and external
custody as `unsupported / adapter-unprovided`. It creates no full backend profile,
logical/account/immutable version or authority. `credentialIssued`, external IDs,
backend UID and name/key remain observations. A separately provided immutable
custody and current accepting owner are still required for credential use.

## Exact selection and freshness

Every invocation reads the authoritative binding, resolves exact backend ownership
and reads the existing provider-account link. It repeats the projection after
asynchronous metadata work, and repeats that resolution around cached material
selection. The current effect owner still checks current authority at actual use.
A warm material cache never supplies permission, audit acceptance or a mint claim.
Model use requires declared audit coupling plus the actual current/audit owner;
rotation also requires declared CAS, exact readback and affected-snapshot support.
Unrelated repository-mint capability declarations do not gate model use.

ResourceVersion is compared as opaque identity. It is never converted to
`secretVersion`. A name alone, foreign Namespace/owner/account, changed UID,
stale logical version or unavailable protected custody cannot yield material.
API-key and trusted-login/federation partitions are distinct. Login cache and
refresh state stay at the external owner; only an access-token/account-context
handle may enter the invocation lease.

Repository mint currently returns `inventory-unavailable`. Its later composition
must load the original durable issuance and atomically claim the unique
issuance/use-operation/preknown-provider-attempt relationship in the existing
inventory journal. Only known outer commit can precede a fresh compare-and-consume
callback. Existing claims, unknown commits and readback cannot create another
callback. This module adds no journal, issuer or claim registry.

## Bounds and material lifetime

| Control                 | Behavior                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Entries                 | At most 128, including pending loads and invalidated busy leases                                        |
| Material                | At most 32,768 bytes per lease; each occupied slot reserves that full size                              |
| Total reserved material | At most 4,194,304 bytes                                                                                 |
| Concurrent calls        | At most 128; timed-out pending owners retain their charge until settlement                              |
| Same partition          | One active borrower; concurrent use receives capacity exhaustion                                        |
| Maximum cache age       | 60,000 ms, conservatively reduced by clock uncertainty                                                  |
| Expiry                  | Earlier adapter expiry, with 5,000 ms safety margin and current uncertainty                             |
| Clock                   | Nonnegative safe integers; uncertainty at most 2,000 ms; reversal or unexplained drift closes the cache |
| Call deadline           | Earlier caller cancellation or supplied deadline, capped at 5,000 ms                                    |

A complete canonical partition includes scope, profile, account, binding,
immutable version and model binding or repository grant. Its cache key is a
SHA-256 digest. Capacity exhaustion denies new work; no queue or background
renewal is created. Idle expired entries are reclaimed on access. Busy invalidated
entries remain charged until their borrower settles. A nonsettling adapter remains
bounded but can exhaust capacity; cancellation does not prove its operation stopped.

The cache stores opaque leases, not raw byte arrays. The adapter must synchronously
invalidate a released handle and overwrite its owned mutable buffers. A release
failure closes the cache and retains the charge. This cannot guarantee erasure of
JavaScript strings, GC copies, SDK internals, native memory, swap, crash dumps or
backend replicas. The byte budget accounts for declared lease material, not total
process RSS or a dishonest adapter's allocations.

## Rotation and uncertain outcomes

New immutable material is staged by the existing protected owner before this
component confirms it. No import, mutable Secret update, secret creation or
operator login occurs here. The rotation path checks management, confirms the exact
staged version, invalidates local material, then delegates atomic logical-binding
CAS, invalidation version, affected-token scan intent and audit to the original
journal owner. Local material is invalidated again after the result.

Kubernetes/provider effects are not part of the PostgreSQL transaction. Unknown
publication retains staged material and original operation/digest for exact
readback. No cleanup or blind retry is attempted. Concurrent old-version results
remain attributable to their original effect; invalidation cannot undo a callback
that already began. Each instance must receive invalidations, and authoritative
current checks must fence other instances even if its material remains cached.

Callback exception or cancellation after invocation returns `effect-unknown`.
Before invocation, cancellation denies use and prevents late callbacks. Backend
exceptions become validated closed scoped failures; raw provider/store errors and handles
do not appear in diagnostics. Used results retain only the closed audit/operation
diagnostic and the actual fixed callback value. Foreign or malformed uncertainty
cannot retarget readback away from the original request.

## Verification and remaining qualification

With the normal workspace dependencies and Node 24 installed:

```sh
node --test tests/conformance/credential-custody-v1.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/credential-custody-v1/tsconfig.json
```

The test double uses synthetic process-local sentinels and bytes. It exercises
cache capacity, lifetime and invalidation, metadata mismatch, class separation,
fixed callbacks, cancellation, concurrent rotation, uncertain outcomes, zeroing
and diagnostic canaries. Restarting the local cache proves only that it starts
empty and re-resolves the same synthetic owner.

Actual selected-adapter access denial, encryption/key protection, immutable version
history, two-instance rotation, restart recovery, installed memory/process
containment and real diagnostic canaries remain unrun. The selected metadata
driver and account link do not supply these capabilities. Actual operator
import/login renewal, current-authority/provider integration, runtime evidence and
preparation-specific custody remain separate implementation responsibilities.
