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

The [token lifecycle contract](credential-storage/token-lifecycle.md) keeps durable
issuance, delivery, revocation, audit loss and snapshot reconciliation together.
Its effects remain subject to the current-authority and shared bounds below.

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
