# Protected credential storage interfaces

The contracts package exports versioned, closed metadata schemas and local
adapter interfaces for named credential custody and outstanding token inventory.
These interfaces let a protected storage owner, model adapter and native token
delivery adapter compile against one contract.

**This is an interface checkpoint.** It includes parsers, canonical request bytes,
strict examples and protocol conformance fixtures. It supplies no secret backend,
credential authority, provider client, authenticated service factory, deployment,
database migration or live token issuance. A schema-valid record is a diagnostic
value; it cannot grant permission or establish backend protection.

The existing `SecretDriver` continues to own named backend lifecycle. Its
`resolve` method returns a safe backend reference, not credential bytes. An
implementation of these new ports must separately provide protected custody,
versioned access, durable inventory and current-authority integration.

## Supported exports

Import from `@openclaw-enterprise/contracts`:

- `credential-authority-v1` exports canonical original-binding/profile values and
  opaque current-effect, management, mitigation and read handles. It reuses the
  existing runtime assignment codec, account version vector and resource IDs.
- `credential-storage-v1` exports `ProtectedCredentialPortV1`,
  `OutstandingTokenInventoryPortV1`, their request/result types,
  `CredentialStorageSchemasV1`, `parseCredentialStorageV1`,
  `parseCredentialStorageJsonV1`, `canonicalCredentialStorageRequestV1` and
  `credentialAffectedFilterDigestV1`.

Both modules are exported through the package root. Package builds emit their
TypeScript declarations. Public metadata excludes material and every trusted
handle. Handles have no parser, factory or raw-byte accessor here. The actual
owner must enforce their provenance, scope, recipient and invocation binding;
TypeScript brands do not contain a hostile process.

| Interface method         | Required capability                             | Contract boundary                                                                                                              |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `withNamedCredentialV1`  | Current original-effect authority               | Select exact binding/version and fixed adapter; repository mint must load its durable issuance reservation before material use |
| `rotateBindingV1`        | Exact credential-management authority           | Commit replacement, invalidation and affected-inventory scan intent atomically                                                 |
| `reserveIssuanceV1`      | Current original-effect authority               | Durably record immutable intent before contacting the provider                                                                 |
| `recordMintOutcomeV1`    | Exact original issuer/mitigation responsibility | Record accepted, rejected, unknown or subsequently resolved issuance; accepted bytes require a custody handle                  |
| `deliverRecordedTokenV1` | Fresh original delivery authority               | Couple protected inventory and durable delivery intent to the guarded material release                                         |
| `listAffectedV1`         | Exact authorized read/filter capability         | Read a durable bounded snapshot, including pending and unknown issuance                                                        |
| `claimRevocationV1`      | Independently preauthorized exact mitigation    | CAS-claim or reconcile an exact attempt; a successful live result supplies only a protected token handle                       |
| `recordRevocationV1`     | Exact mitigation responsibility                 | Preserve confirmed, pending, unknown, failed-terminal and conservatively evidenced expired outcomes                            |
| `readOperationV1`        | Exact original-service read capability          | Observe the original method, operation and digest; readback never creates effect authority                                     |

The local methods take separate nonserializable capabilities and an abort signal.
Requests carry bounded creation/deadline values. An accepting implementation must
apply the earlier deadline and actual trusted clock; parsing does not establish
freshness. Aborting a local call does not establish provider nonexecution.

## Ownership and current authority

The original binding is a projection from the sole canonical turn journal:
installation, Namespace, Agent, assignment/revision/generations, original actor,
conversation, workspace, message/receipt, attempt/reservation, common grant,
route/audience/policy versions and the original execution limit. The canonical
producer supplies required `turnNotAfter`: a timestamp for a finite execution cap
or explicit `null` for uncapped duration. Missing policy is invalid; null grants
no current authority and does not remove credential or operation deadlines.
The profile fixes provider,
account, transport and credential mode through immutable versioned references.
References are exact protected lookups, never caller-selected URLs or new registry
entries.

`CurrentCredentialAuthorityV1` pairs an opaque capability with its diagnostic
observation. Only the actual authority owner can provide the pair. The storage
acceptor must verify that both refer to this invocation, exact original binding,
selected account/Secret/version, operation, current policy and dispatch fence.
A parsed observation, successful account check, unexpired token, stored
reservation or completed operation readback cannot substitute for that capability.

Current checks apply at each new effect. Reservation, mint material use and native
delivery are distinct effects. A deny, invalidation-channel loss or dependency
outage closes new authority; it cannot be hidden by a warm material cache. The
accepted operation-start ceiling is five seconds after guarded comparison and
never beyond an earlier lease or applicable finite original turn deadline.
The lease and operation-start limits remain finite for uncapped work. Actual assignment,
original-human/common-grant and before-send checks remain mandatory.

The model schema can describe API-key import, trusted operator login and separately
qualified workload-federation profiles. Their presence in the dictionary does not select or qualify either
profile. An unqualified effective model/catalog configuration, missing immutable
native binding, unsupported generation cap or required auxiliary/safeguard
composition keeps that concrete credentialed path unavailable. Do not replace a
requested model or disable a required safeguard to satisfy these interfaces.

## Named bindings and cache partitions

A `CredentialSecretBindingV1` fixes installation/Namespace/Agent ownership,
logical binding and CAS versions, named Secret and material version, provider,
account, selected driver and protected backend-binding reference. All values are
metadata. Backend addresses, key material and credentials are outside the record.
Rotation preserves the logical owner and increments its binding version exactly
once while selecting a newer Secret version. Old in-flight outcomes remain
attributable to the old version and must be reconciled.

`CredentialCachePartitionV1` includes exact owner, profile/account/transport,
binding/material version and, for repository use, installation/repository/permission
scope. Material caches do not cache permission. Their TTL is also capped by
credential expiry, rotation, invalidation and every stricter selected profile.
Eviction must dispose of material according to the actual implementation's memory
and allocator limits; this interface does not claim copies can always be erased.

`CredentialStorageBackendRequirementsV1` describes required capabilities:
authenticated exact named access, external protected custody and key management,
versioned rotation, durable CAS, intent before mint, inventory and delivery intent
before release, complete restart-safe scans, exact readback, transaction/outbox
audit coupling and independently preauthorized mitigation. A populated requirements
object is not evidence that a selected backend supplies those capabilities.

### Model setup, protected binding and refresh

Trusted operator setup may import an API key or perform the admitted login flow
outside execution. `ProtectedModelBindingV1` names the existing provider-account
link/version, upstream workspace reference, exact provider/driver/Secret version,
invocation profile and protected external custody. Its link refers to the existing
account owner; the storage adapter must verify the complete Installation,
Namespace, Provider, Driver, workspace and account correspondence. It creates no
second account-link record or retrieval endpoint.

The closed setup variants are `api-key-import`, `trusted-login` and separately
qualified `workload-federation`. The profile credential class must agree with the
setup. API-key setup names its exact rotation owner and lifecycle profile. Login
and federation setup name the sole trusted refresh owner and lifecycle profile.
Both model named use and material-cache partitions include this exact descriptor;
changed account/session/lifecycle versions cannot reuse an old partition.

The fixed model adapter receives only an opaque handle to the minimum invocation
material: the selected API key, or the current access token and admitted upstream
account context. Login cache, refresh material and real account/header values stay
with the external protected owner and never appear in these metadata schemas.
The owner validates expiry, performs permitted renewal under its selected lifecycle
and publishes changed protected versions through the existing binding/rotation
boundary. Renewal is a trusted lifecycle operation, not broader authority granted
by a model-use handle. Current authority is still checked for every model effect.
Unavailable or expired renewal returns a sanitized unavailable/expired outcome;
it does not fall back to another credential class or profile.

The Agent and sandbox relay receive only admitted substitute credentials or opaque
correlation. The external proxy authenticates the actual workload/current original
attempt, strips caller-supplied substitute and account material, and constructs the
selected upstream authentication. No real model key, login state, refresh token or
protected-store access is delivered to execution. A login-derived bearer cannot
be moved to the API-key endpoint merely by replacing a token. Exact provider,
model, transport and payload compatibility remains separately qualified.

## Durable issuance, delivery and reconciliation

### Intent and exact idempotency

`reserveIssuanceV1` records exact service/owner, original turn, binding/profile,
repository IDs and minimum permission set, authority/invalidation versions,
audit reference and operation before any mint. IDs and permissions use canonical
ordering; duplicate permission names, write access to metadata, omitted repository
scope and unknown permission kinds are rejected.

The semantic request bytes retain every ownership, profile, method, operation,
audit, payload and expected-CAS field. Only per-call `requestId`, `createdAt` and
`deadline` are excluded so an exact read/reconciliation call can have fresh
correlation and bounds. The owner computes and checks the digest; a submitted
digest does not establish its own provenance. Exact duplicate intent returns
existing state. A changed owner/body/CAS under the operation is an integrity
conflict, never permission to mint again.

A fresh `reserved` result contains only a durable reserved row and audit
acceptance. Its receipt operation and digest must match that issuance exactly;
later write and claim receipts retain their separate operation identities.
An `existing` result is reconciliation-only. `commit-unknown` and
`not-found` readback retain the original operation and do not imply no effect.
A provider does not acquire idempotent token minting merely because an internal
operation ID exists.

Repository `withNamedCredentialV1` also names a preknown `providerAttemptRef` and
expected inventory version. Before its fixed callback, the protected owner must
atomically claim that issuance's single mint attempt and durably link issuance,
named-use operation and provider attempt in the same operation journal. The
relationship survives replicas, restart and acknowledgement loss. Another named-use
operation or fresh authority cannot invoke a second possible mint against that
issuance. Uncertain claim/callback outcomes require exact reconciliation, with no
automatic callback retry. A current handle and reserved row alone are insufficient.

### Every known token is an inventory obligation

Record every usable returned token before runtime delivery, including one whose
response has mismatched scope or missing/unproved expiry. Accepted token metadata
travels with a separately supplied `EphemeralTokenHandleV1`; other mint outcomes
cannot carry that handle through the typed method overloads.

Known token metadata includes an opaque protected revocation reference, exact
original intent and version, returned-scope evidence, expiry evidence, delivery
state and revocation state. A fingerprint alone is insufficient to revoke a
bearer. `expiry-unproven`, `mismatch` or `unproved` returned scope requires
`mitigation-only`; it never becomes delivery permission merely because the
requested scope was valid.

If protected persistence fails after provider acceptance, suppress delivery,
retain the preissue unknown record and report the actual persistence/provider
uncertainty. The original trusted issuer may perform independently preauthorized
exact revocation while it still has the material. A plaintext fallback file,
a guessed expiry or a falsely successful inventory acknowledgement is prohibited.

A definite inventory CAS conflict while recording a late result permits a fresh,
independently authorized reconciliation operation using the current inventory CAS.
It retains the original issuance, token, provider attempt, claim and authenticated
outcome evidence. The owner checks the retained attempt record even if its original
claim has expired, and records historical truth without new provider work or
overwriting stronger terminal evidence. The prior operation's CAS and digest never
change. Commit acknowledgement loss instead reads the unchanged original operation
first; it must not be disguised as a definite conflict or new outcome operation.

### Unknown mint with no token bytes

`unknown` records preserve `expiry-unproven`. A timeout plus a nominal token
lifetime cannot establish provider mint time. Later `unknown-expiry-established`
evidence may supply a provider-derived deadline; the row remains `mint-unknown`
and scope-held while that deadline is in the future.

Only definitive no-issuance evidence, conservatively elapsed evidenced expiry,
or a confirmed broader revocation performed under separately established exact
responsibility can resolve that obligation without a token value. The latter
two use `resolved-without-token` with explicit evidence. A planned broader
revocation, missing delivery or empty enumeration result is insufficient. A
broader response requires its own authority and actual provider result; the
storage method creates neither.

### Delivery remains a separate effect

A recorded token is not automatically deliverable. `deliverRecordedTokenV1`
requires native mode, the exact record/token/binding and original authority,
current versions and sufficient evidenced expiry. The acceptor persists a
delivery intent before invoking its fixed delivery callback and performs the
current compare-and-consume at release. Late mint after rotation, narrowing,
retirement or disable remains tracked for mitigation.

Callback loss or commit acknowledgement loss can occur after bytes were delivered.
`delivery-unknown` therefore directs exact readback and preserves uncertainty.
Redelivery of an already issued token needs a new exact current check and retained
delivery identity; it never mints a replacement implicitly. Native execution can
read and retain delivered ephemeral tokens. Changing an environment variable,
closing a local lease or issuing a narrower token does not revoke existing copies.

## Revocation, audit loss and affected snapshots

A revocation claim has a CAS version, bounded lease, exact provider attempt and
prior-outcome state. The claim lease expiring does not prove the previous request
ended. Takeover must reconcile that exact attempt before any independently safe
new attempt. Keep provider-confirmed revocation, pending, unknown,
failed-terminal and elapsed provider expiry distinct. When an outstanding row and
its expired-revocation evidence both contain a provider deadline, they must name
the same current deadline; observation times and evidence references may differ.
A newly evidenced expiry can resolve a previously unproved deadline. Corrections
to a known deadline reconcile the current row while preserving prior evidence in
the original operation history.

New-authority mutations require durable audit acceptance under the existing
security-event contract. Audit delivery to an external sink can occur later
through an accepted durable outbox. Audit outage must not suppress independently
preauthorized exact disable, attenuation, stop or revocation. Mitigation records
therefore distinguish `accepted`, `obligation-recorded` and `evidence-missing`.
When inventory persistence is also unavailable, report a missing-evidence
incident and the observed provider outcome; do not fabricate a successful durable
write. This permits no broader emergency authority.

Affected queries bind exact owner, logical binding, cause and invalidation
operation/version to a persisted snapshot and filter digest. Cursors are opaque,
bounded and tied to that snapshot/filter; no credential values appear in them.
The backend must retain snapshot membership across replicas/restarts for its
valid lifetime and invalidate unavailable/inconsistent snapshots explicitly.
Queries include pending and unknown issuance and late outcomes, with current
ownership checked by the actual accepting owner.

Page counters describe live known-token and unresolved-issuance counts within
that snapshot. Confirmed/expired and resolved history remains retained but does
not consume a live-token count. A continuation must advance through an actual
returned record. A completed page sequence proves only coverage of its persisted
snapshot. It never proves all later effects ended or all provider tokens were
revoked; the owning invalidation/reconciliation protocol must include concurrent
late outcomes before declaring mitigation complete.

## Bounds and error handling

These are interface ceilings and implementation requirements, not capacity or
latency measurements. Stricter selected operation/profile limits prevail.

| Dimension                                              | Ceiling or rule                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Metadata request / response                            | 65,536 / 262,144 UTF-8 bytes, including raw JSON whitespace                                                               |
| JSON nesting                                           | 32 levels; closed fields, finite primitive values, no duplicate decoded keys                                              |
| Named material / ephemeral token                       | 32,768 / 16,384 bytes, handled only by protected custody                                                                  |
| Material cache                                         | 128 entries, 4 MiB total, at most 60 seconds before stricter invalidation/expiry limits                                   |
| Repository scope                                       | 20 explicit IDs; bounded canonical permission list with four declared permission kinds                                    |
| Inventory page                                         | 20 records; 256-byte opaque continuation                                                                                  |
| Live obligations                                       | Four per Agent, 128 per installation; pending/unknown issuance consumes capacity                                          |
| Concurrent mint reservation                            | One per exact issuance scope                                                                                              |
| Storage invocation / revocation claim / revoke attempt | At most 5 seconds each, capped by earlier authority/operation deadlines                                                   |
| Revocation attempts                                    | Five per bounded burst; 1/2/4/8-second backoff; later bursts no more often than every 60 seconds                          |
| Snapshot lifetime                                      | At most 60 seconds; invalidation returns `snapshot-invalid`                                                               |
| Conservative expiry                                    | Trusted uncertainty at most 2 seconds; token-use safety margin 5 seconds plus applicable pre-send delay/uncertainty       |
| Native GitHub refresh                                  | 300 seconds; separate from the selected workload-federation schedule                                                      |
| Workload-federation refresh                            | `min(120 seconds, original token lifetime / 2)`; account for rounded expiry, elapsed handoff and remaining pre-send delay |
| Audit                                                  | Existing 2-second append deadline; audit copies expire at 30 days plus authorized sweep within 24 hours                   |

Retain active or unresolved inventory until real resolution, regardless of age.
Terminal inventory evidence has a 30-day minimum retention; this is separate from
OPS audit copies, which expire 30 days from trusted receipt with an authorized
sweep within 24 hours. Unresolved inventory does not extend audit-copy retention.
Required evidence loss remains an explicit incident. Capacity exhaustion denies
new issuance rather than evicting an unresolved obligation. Historical rows may
outlive live-token capacity; storage growth and operational retention must be
implemented and monitored separately.

Raw JSON numeric fields must use exact nonnegative decimal integer spelling:
`0` or a nonzero decimal integer within the safe-integer range. Fractional,
exponent and negative-zero spellings reject even if JavaScript would round them
to an allowed integer. The object parser validates supplied numeric values but
cannot recover precision already lost by another decoder.

Parsers throw only `CredentialStorageContractErrorV1` with a constant message.
Unauthorized external callers receive `credentialStorageExternalDenialV1()`;
protected reason distinctions never expose foreign scope or provider/store text.
Do not log input objects, rejected credential bytes, provider responses or custody
handles. Readback is scoped observation even when it reports completion.

## Verification

With the repository's compatible dependencies already installed and Node 24,
run the actual package and independent compile fixtures:

```sh
node node_modules/typescript/bin/tsc --build packages/contracts/tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/credential-storage-v1/producer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/credential-storage-v1/consumer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/credential-storage-v1/negatives.tsconfig.json --pretty false
node --test tests/conformance/credential-storage-v1.contract.test.mjs
```

The independent producer fixture wires an externally supplied protected owner and
existing `SecretDriver`. The independent consumer fixture exhaustively handles
published results and injects real capabilities/fixed adapters as parameters.
Compile-negative cases reject ordinary JSON or readback as authority, mixed custody
handles and wrong accepted/nonaccepted mint arguments. None creates a successful
authorizer or backend.

Protocol traces cover rotation/mint races, narrowing/delivery, late and invalid
provider results, acknowledgement loss, restart, revocation uncertainty, audit
loss and snapshot changes. Their executed checks exercise the actual schema and
canonicalization functions. The traces specify what an adapter must do; they do
not execute or certify backend transactions, encryption, distributed guards,
provider revocation, native delivery or runtime isolation.
