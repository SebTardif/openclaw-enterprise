# Credential gateway v1 contracts

OpenClaw Control Plane (OCC) exposes its curated public credential-gateway types
and GitHub App supplier constructors through `@openclaw-enterprise/occ`. Import
credential inventory data from `@openclaw-enterprise/contracts`. Issuance
coordination, transaction lifetimes and inventory transaction ports remain
internal to OCC; they are not exported from the package entry point. These
declarations describe the current source interfaces and their supplier boundaries.
Gateway composition, installed operation and live-provider qualification remain
pending; importing a type does not admit Work or grant credential access.

## Supplier boundaries

| Supplier             | Current interface and responsibility                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IAM Driver           | `IAMDriver.authorize(AuthorizationRequest)` returns `Promise<AuthorizationDecision>`. The request contains the original principal, exact permission action and resource. Current authorization remains with IAM and the authority owner.       |
| Secret Driver        | `SecretDriver.resolve(Secret)` returns `Promise<SecretBackendRef>`, a safe backend reference. It provides no plaintext read API. Protected material acquisition belongs to its credential owner.                                               |
| Provider and Drivers | `Provider<Client>` retains its `id`, `client` and Driver map. `ServiceAccountDriver.createCredential` and `PluginDriver.listCatalog` retain their existing platform contracts. A token issuer does not replace Provider composition.           |
| State                | `PlatformStateStore.read` borrows a `PlatformReadView`; `transact` borrows a `PlatformUnitOfWork`. The existing State owner controls the transaction and audit commit.                                                                         |
| Transaction lifetime | The internal `RepositoryTransactionLifetime` class owns `assertActive`, `run`, `finish` and `close`. Its private identity prevents a copied public shape from substituting for the actual lifetime.                                            |
| Inventory            | The internal `CredentialInventoryTransactionV1` port retains scoped operation/record reads and writes, live counts, mint claims and revocation claims. `commitRef` is preallocated correlation, not evidence of commit.                        |
| GitHub App material  | `createGitHubAppMaterialV1` returns `GitHubAppMaterialV1`; `withJwt` borrows bounded material and `close` stops material admission. The protected owner supplies the immutable key identity and currentness checks.                            |
| GitHub App protocol  | `createGitHubAppTokenIssuerV1` returns `TokenIssuerV1`; `createGitHubAppTokenRevokerV1` returns cleanup-only `TokenRevokerV1`. Construction receives real owner-selected options, including dispatch currentness, clock, endpoint and custody. |

Internal issuance contracts join protected-source loading, original-owner
settlement, retained material, commit evidence and charged lease capacity. OCC
owns this coordination; package consumers use the public supplier interfaces
rather than orchestrating these internal phases.

The inventory metadata module's existing
`transactCredentialInventoryMetadataV1(store, scope, work, { keys?, commitRef? })`
callable borrows the original State transaction. It is an internal composition
boundary, not an additional package-root constructor. Every inventory mutation,
audit and custody reference shares the outer commit. Caught failures poison that
transaction; uncertain commit requires reconciliation. No database transaction
may remain open across a provider call.

## Recipe schema identities

`DefinitionRef` identifies an exact admitted recipe with `backendId`, `recipeId`,
positive safe-integer `recipeVersion`, lowercase SHA-256 `recipeDigest`,
`contractVersion: "credential-backend-recipe-v1"` and an exact `interpreter`
`PrimitiveRef`. Primitive references contain a bounded name, positive
safe-integer version and lowercase SHA-256 digest. Descriptor possession does
not establish Installation admission, Work or IAM authority.

Trusted core construction calls
`createCredentialSchemaRegistryV1(admittedDefinitions, {admittedPrimitives})`.
Both inputs are data snapshots supplied by the server-selected Installation
owner. The required primitive allowlist intersects with the closed installed
catalog. `CREDENTIAL_SCHEMA_PRIMITIVES_V1` and
`INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1` expose immutable data descriptors for
the closed schema interpreter and bounded JSON canonicalizer. The interpreter
uses the current closed draft-07 schema profile; it is not a broker operation
interpreter. Full recipe loading and Installation startup remain separate work.

A `SchemaRegistration` contains only `binding`, `jsonSchema`, `maxBytes`,
`maxDepth` and `canonicalization: PrimitiveRef`. It cannot supply a callback,
resolver, module or executable implementation. The core admits only its fixed
JSON protocol: it creates one bounded immutable snapshot and canonical encoding,
validates that snapshot against the closed schema, and retains the same value
and bytes. The encoder bounds the actual UTF-8 output, including escaping.
Generic JSON canonicalization supports already-approved nonsecret projections;
it cannot identify arbitrary secrets or establish backend resource equivalence.
Backend-specific semantics belong to their original owner's reviewed primitive
before schema admission; this codec does not execute transformations. See [schema verification](../testing/credential-schema-registry.md)
for the bounded profile, digest protocol and lifecycle checks.

Current recipe registries explicitly refuse old `credential-backend-v1`
admission and retained restoration. They never convert or delete old records.
Retain original bytes, digests, accepted legacy implementation and custody
obligations. Existing readback and cleanup require the original approved version
and owner; an upgrade must not abandon those obligations or create new cleanup
authority.

## Original binding and root Work

`OriginalCredentialBindingV1`, `CredentialProfileV1` and
`CredentialRepositoryGrantV1` are exported inventory data types. The original
binding projects the canonical journal's original turn, attempt, reservation,
conversation, message, receipt and committed dispatch facts. It is immutable data
and supplies no callable authority.

Authenticated start/deploy root Work requires its own selected producer and
accepting inventory-consumer contract. That declaration is not present in this
source. Do not manufacture journal identities, reinterpret a runtime allocation
as admitted Work, or cast a start/deploy projection into the original journal
binding. Composition must wait for the real Work and inventory owners' contract.
An uncapped execution duration still requires finite credential leases, bounded
operations and independently authorized cancellation.

## Exact repository correspondence

`GitHubAppSelectionV1` uses numeric installation and repository IDs. Inventory
`CredentialRepositoryGrantV1.repositoryIds` uses canonical decimal strings matching
`[1-9][0-9]{0,19}`. Their common exact numeric domain is **1 through
9007199254740991**. The runtime owner must require safe positive integers and exact
round trips: `String(Number(s)) === s` and `Number(String(n)) === n`. Reject leading
zeros, signs, whitespace, exponents, fractions, unsafe numbers and rounded values.
A TypeScript `number` or `string` alone proves none of these invariants.

`providerInstallationRef` is opaque; it is not the numeric installation ID. The
credential/provider owner must resolve its exact immutable mapping and compare
actual provider repository identity and returned permissions. This interface
change supplies no runtime conversion or provider-response qualification.

## Fixed token profile

The admitted access grant fixes one token profile for its leases:

| Admitted access                 | Fixed profile and exact permissions                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `read`                          | `repository-read-v1`: `metadata:read`, `contents:read`                                       |
| `read-write`                    | `repository-write-v1`: `metadata:read`, `contents:write`, `pull_requests:write`              |
| Separately admitted preparation | `repository-read-v1`, with independent authority, material ownership and writer-stop handoff |

Metadata and fetch under read-write access use that grant's write-capable profile.
Operation kind never selects another profile. Each operation still requires
current Work/assignment/IAM authority, immutable facts and its own finite,
single-use dispatch permit. Preparation cannot borrow execution material.
`GitHubRepositoryWriteSelectionV1` is an additive declaration; the existing
`GitHubAppSelectionV1` and read issuer constructor remain read-only.

Normally retain one current token. Allow at most one same-profile replacement,
one in-flight mint claim and two aggregate outstanding slots per lease across
replicas. Reservations, dispatched or unknown attempts and provider-valid retired
tokens remain charged. Only definite no-issuance, confirmed revocation or evidenced
expiry frees capacity. Unknown inventory or two charged slots denies another mint;
cache eviction, new grants and profile changes cannot erase original obligations.
Runtime enforcement of this policy remains with the authority, inventory and
credential owners.

## Material settlement and verification

`GitHubAppTokenCustodyV1.capture` stages protected material synchronously;
`withRevocationToken` authenticates an original custody handle. Capture does not
prove durable inventory recording. Trusted construction supplies bounded material
and custody callbacks; requests supply original attempts and finite bounds rather
than signing keys, token bytes or caller-selected permissions.

Retain each exact issuer result before downstream use and join its original
`settleAttempt` finalizer before releasing authority. Settlement performs no
additional provider action and does not turn an unknown outcome into success.
Cleanup uses the original retained handle and needs no App signing key. Unknown
issuance, dispatch and cleanup outcomes retain their obligations without automatic
replay.

The dedicated compile checks cover public supplier imports and internal contract
correspondence, including read/write separation, safe-reference return types and
complete inventory ports.
They establish source compatibility only. See the [testing guide](../testing/README.md)
for validation procedures and the [Provider reference](providers.md) for platform
composition requirements. Compiler success supplies no composed, installed,
provider or release evidence.
