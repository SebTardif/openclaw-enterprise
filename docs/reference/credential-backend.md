# Credential backend profile V1

The `@openclaw-enterprise/contracts/credential-backend-profile-v1` subpath defines
and validates a **local TypeScript backend declaration** for the existing
[credential storage contract](credential-storage.md). It selects named Kubernetes
Secret access and the existing PostgreSQL ambient transaction owner. It creates no
backend, issuer, account registry, protected handle, listener or authorization path.

`parseCredentialBackendProfileV1` accepts a plain data object;
`parseCredentialBackendProfileJsonV1` accepts bounded JSON. Both reject unknown
fields, unsupported versions and placements, inconsistent bindings and altered
storage bounds. The JSON parser also rejects duplicate decoded keys and numeric
lexemes that could lose precision. Errors contain one constant message, without
input values. Successful parsing returns an immutable copy.

`assessCredentialBackendProfileV1` reports `compatible-declaration` only when every
required capability is declared supported by its exact selected adapter. It
reports `incomplete-declaration` with capability names otherwise. **Both results
say `runtimeAttestation: "not-established"` and `authority: "not-granted"`.**
Capability evidence references are supplied by owners; this module does not resolve
or verify them. A compatible declaration cannot activate credential use.

## Selected ownership and configuration

Every profile requires a versioned profile reference; exact original-runtime
cache partition; installation, Namespace, Agent, provider, account, secret and
binding versions; adapter references; and trusted service placement/identity.
There are no installation or account defaults. Account links, account version
observations, authority handles and protected material retain their existing owners.

| Selection                                    | Required mapping                                                                                                                                                         | Current capability limit                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kubernetes-secret-driver`                   | Existing `SecretDriver`; exact cluster binding, namespace, name, key, UID, opaque resourceVersion and immutable protected version record matching `secretVersion`        | Existing named lifecycle and metadata-only `resolve` do not supply protected reads, immutable history, encryption/key custody or atomic cross-store rotation                             |
| `postgresql-ambient-owner`                   | Existing owner, database binding, one journal, UoW and audit binding; same borrowed client, transaction lifetime and poisoning; same-transaction metadata audit coupling | A generic database or a second transaction in the same database does not establish durable credential inventory, unique claims, restart-complete scans, or correct outer-commit ordering |
| `external-protected-adapter` or `unprovided` | Owner-supplied material, token and revocation custody bindings plus versioned encryption/key-custody profile                                                             | Protected material/token/revocation custody is mandatory. No implementation is supplied here; the honest missing state is `unprovided`, with unsupported or unproved capabilities        |
| `local-typescript`                           | Trusted service and SPIFFE identity outside Agent execution; local handles and callbacks                                                                                 | Configuration does not establish identity, service placement, network isolation, or secret exclusion. Remote processes and serialized handles are unsupported by this V1                 |

A named backend selector is a private operator/owner declaration, not a workload
selector. Actual `SecretDriver.id`, selected implementation and authoritative OCC
Secret identity/backend projection must match the declaration when the real owner
composes it. Kubernetes UID/resourceVersion denotes an observed object revision;
it does not itself provide immutable credential-version history. ResourceVersion
is opaque and must not be interpreted as a monotonic numeric credential version.

Rotation stages the new immutable protected version, then uses the existing owner
to CAS the logical binding together with invalidation and affected-scan intent.
The ordinary mutable Kubernetes `update`/`resolve` methods alone cannot implement
this protocol. PostgreSQL atomicity covers its metadata transaction; it does not
make Kubernetes or provider effects transactional. Failed or uncertain publication
must retain exact staged-version and operation responsibility for reconciliation.

The selected audit coupling is **same transaction**, as required of the actual
journal/audit/invalidation owner composition. An outbox declaration is rejected by
this profile even though the storage requirements also permit a separately
qualified outbox design. A database selector does not prove that the selected
same-transaction credential adapter exists.

## Local type binding

`CredentialBackendLocalBindingsV1` requires the actual
`CredentialStorageDependenciesV1`, `ProtectedCredentialPortV1` and
`OutstandingTokenInventoryPortV1`. The `SecretDriver` type comes from its supported
owner leaf. The ports retain the existing nominal current-authority, management,
read and mitigation handles, material and token handles, generic callbacks,
operations, CAS and result unions. No handles have a JSON representation.

`CredentialBackendModelProjectionV1` reuses the accepted account version vector,
secret binding, protected model binding and model cache partition. It is an inert
projection, not a currentness observation producer. A cache contains scoped,
versioned material identity only. Permission is never cached, and actual consumers
must recheck current authority and all versions at each effect boundary.

Separate producer and consumer fixtures compile through supported package
subpaths. They bind existing supplied ports and callbacks; they do not manufacture
an issuer, a material handle or a successful backend. A real owner must compare
its installed adapter/Secret/account bindings and implement every claimed
capability before any runtime use.

## Capability declarations

Each inherited requirement has a required capability description with status
`supported`, `unsupported` or `unproved`. A supported description includes the exact
selected adapter's reference/version/digest and an owner evidence reference.
Unknown keys, omitted requirements, missing capability entries, and supported
claims against a different owner are invalid. An unprovided custody adapter cannot
make either custody capability supported.

The named-secret owner supplies authenticated exact protected access and versioned
read/rotation. The custody owner supplies external custody and protected
encryption/key custody. The inventory owner supplies CAS, intent/claim ordering,
delivery intent, complete snapshots, exact readback, audit coupling and independent
preauthorized mitigation. Inventory-before-release additionally depends on the
custody requirements; partial support never yields a compatible declaration.

These are declarations of implementation capability, not measured evidence.
Missing providers or unproved owner integration must remain visible. Do not label
generic Kubernetes Secrets or PostgreSQL as supporting all these requirements.

## Commit and failure ordering

The normative examples in `tests/fixtures/credential-backend-profile-v1/traces.mjs`
express protocol correspondence. They are not a simulated backend or executed
crash/restart proof.

1. Before mint, durably commit immutable issuance intent. The named-use owner must
   then commit the unique relationship among that reservation, use operation and
   preknown `providerAttemptRef` in the same operation journal. Only the known
   outer commit permits a provider callback. A method-local write or provisional
   return from an open ambient transaction is insufficient.
2. Before delivery, persist known token and revocation material in protected
   custody, then commit the inventory row and delivery intent under the owning
   metadata protocol. Recheck and consume exact current original-turn authority
   and binding/assignment/grant/invalidation versions at release. The callback
   cannot run inside an uncommitted outer transaction. If actual injected ports
   cannot provide that guarantee, the mapping remains unavailable.
3. Lost COMMIT acknowledgment retains the original operation, method, intent
   digest and original CAS. Use exact original readback. `not-found`, unavailable
   readback, an existing reservation or fresh authority does not permit reminting.
   No hidden queue, blind retry, implicit rollback or second provider attempt is
   introduced. Delivery callback or acknowledgment loss remains delivery-unknown.
4. Late provider evidence is retained after rotation, narrowing, reassignment or
   a definite CAS conflict. A fresh authorized reconciliation operation may use
   the current CAS while preserving original effect, digest/CAS history,
   issuance/provider attempt and original revoke claim. It cannot overwrite an
   old digest, erase stronger evidence or authorize another provider effect.
5. Mint outcome without evidenced provider expiry stays `expiry-unproven`.
   Clock passage or a cache deadline cannot establish expiry. Known tokens with
   unproved expiry/scope remain mitigation-only. Provider-confirmed revocation,
   failed-terminal, pending, unknown and evidenced expiry remain distinct.
6. Revocation claim expiry does not prove that an in-flight provider attempt
   ended. Takeover reconciles the previous exact attempt before any independently
   safe new attempt. Late evidence retains the original claim/attempt history.
7. Mandatory audit failure denies new authority, issuance and delivery. It does
   not suppress independently preauthorized exact mitigation. Preserve a durable
   audit obligation where possible or expose missing evidence and unknown state;
   neither is provider confirmation. An outage cannot create emergency authority.
8. Persist snapshot reference/version, exact filter digest and bounded cursor.
   Enumeration spans replicas and restart and includes reserved, unknown and late
   outcomes. An empty final page covers only that persisted snapshot; it is never
   global closure or permission to discard pending obligations.

## Finite bounds and retention

The complete `CREDENTIAL_STORAGE_LIMITS_V1` object is required unchanged. Limits
are selected ceilings and minima, not performance measurements.

| Area                                                             | Bound                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Call                                                             | 5,000 ms; no hidden queue or blind retry after unknown commit                                              |
| Material cache                                                   | 128 entries, 4,194,304 bytes, 60,000 ms maximum age                                                        |
| Material / token                                                 | 32,768 / 16,384 bytes                                                                                      |
| Storage request / response / JSON depth                          | 65,536 / 262,144 bytes / 32                                                                                |
| Repositories / permissions                                       | 20 / 8                                                                                                     |
| Inventory page / cursor / snapshot age                           | 20 items / 256 bytes / 60,000 ms                                                                           |
| Outstanding / concurrent issuance                                | 4 per Agent, 128 per installation; one issuance per scope                                                  |
| Revoke claim / attempt                                           | 5,000 / 5,000 ms                                                                                           |
| Revoke retry                                                     | Five attempts per burst, backoff 1,000 / 2,000 / 4,000 / 8,000 ms; later retry interval at least 60,000 ms |
| Clock uncertainty / expiry safety / native GitHub refresh margin | 2,000 / 5,000 / 300,000 ms                                                                                 |
| Audit append                                                     | Existing `SECURITY_EVENT_POLICY.appendDeadlineMs` (2,000 ms)                                               |
| Terminal inventory retention                                     | Existing storage minimum, derived from the current 30-day audit policy                                     |

Unresolved/outstanding inventory rows must never be evicted to satisfy capacity
or age. Deny new work instead. Terminal-inventory retention is a minimum and is
separate from retention or deletion of an audit copy. No pending/unknown row
becomes terminal merely because its retention interval passed.

The profile parser has a smaller 16,384-byte input allowance, 2,048 nodes, 64 keys
per object/array representation and 1,024 characters per string, with inherited
depth 32. These constrain this small configuration document only. They do not
relax or replace storage request, response, material or cursor bounds.

## Verification and implementation boundaries

Run the focused pure conformance file with Node's TypeScript stripping support:

```sh
node --test tests/conformance/credential-backend-profile-v1.contract.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/credential-backend-profile-v1/producer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/credential-backend-profile-v1/consumer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/credential-backend-profile-v1/negatives.tsconfig.json
```

These checks require the workspace contracts/utils links and the pinned TypeScript,
TypeBox and Node type dependencies. They test this parser and compile against
supported source-package subpaths. They establish no packed-package, Kubernetes,
PostgreSQL, protected custody, provider, encryption, audit-sink, restart, containment
or performance result.

Inventory/journal implementation and protected named-custody/cache implementation
remain separate owner modules, using the same accepted ports and the existing
transaction/account/Secret owners. The coordinator serializes any migration,
shared UoW, export or navigation changes with those owners. This definition adds
no migration, inventory implementation or shared transaction edit. Preparation
credentials and candidate Jobs require their own accepted purpose-specific
composition and are outside this original-runtime profile.

A future remote adapter requires a separately accepted authenticated transport and
closed operation mapping from the original owners before implementation. Local
opaque authority/material handles cannot be serialized to obtain that mapping.
