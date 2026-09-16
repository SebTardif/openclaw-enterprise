# GitHub App token issuer

**Integration pending:** production startup, repository Work and regular Agent
checkout are unconnected. Do not enable repository deployment through this API.

## Owning contract

Import `TokenIssuerV1`, `TokenRevokerV1`, attempt/result types and
`EphemeralTokenHandleV1` from `@openclaw-enterprise/contracts`;
GitHub factories/types from `@openclaw-enterprise/occ`.

| Factory                             | Required options                                                                 | Returns                                    |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| `createGitHubAppMaterialV1`         | `privateKey`, `identity`, `assertCurrent`, `clock`                               | `GitHubAppMaterialV1`                      |
| `createGitHubAppTokenIssuerV1`      | `selection`, `material`, `custody`, `assertDispatchCurrent`, `clock`, `endpoint` | `TokenIssuerV1`                            |
| `createGitHubAppWriteTokenIssuerV1` | `selection`, `material`, `custody`, `assertDispatchCurrent`, `clock`, `endpoint` | `TokenIssuerV1` with a fixed write profile |
| `createGitHubAppTokenRevokerV1`     | `custody`, `assertDispatchCurrent`, `clock`, `endpoint`                          | `TokenRevokerV1`; no signing key required  |

TokenIssuer owns bounded credentials in protected custody; Provider supplies
authenticated clients to Drivers. No issuer registry or Installation
configuration surface exists.

## Select material and repository scope

| Input                                     | Contract                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privateKey`                              | Private RSA `KeyObject`, 2048–8192 bits; owner authenticates source/version.                                                                                     |
| `identity` / `selection.key`              | Exact `clientId`, `bindingRef`, `immutableVersion`.                                                                                                              |
| Read `selection`                          | Positive `installationId`; `repositories: [{ id, fullName }]` (exactly one); `permissions: { metadata: "read", contents?: "read" }`. Other permissions rejected. |
| `clock`                                   | Trusted epoch-millisecond clock.                                                                                                                                 |
| `assertCurrent` / `assertDispatchCurrent` | Synchronous, returning `undefined`; Promises refused. Dispatch checks original operation authority.                                                              |

`createGitHubAppWriteTokenIssuerV1` accepts the exported
`GitHubAppWriteTokenIssuerOptionsV1`, whose `selection` is
`GitHubRepositoryWriteSelectionV1`. It requires exactly `metadata: "read"`,
`contents: "write"` and `pull_requests: "write"` for one repository. Its constructor
snapshots own data into an immutable selection and rejects proxies, accessors,
inherited scope, extra or symbol fields, unsafe IDs and malformed repository names
before signing or network dispatch. The existing read constructor remains read-only.

Trusted grant admission fixes one token profile per lease. Read-write execution
uses its write profile for metadata, fetch, push and PR creation; operation kind
does not select a second token profile. Separately admitted preparation retains
its own read-only authority and material. This issuer does not enforce the
lease-wide one-mint claim or two aggregate outstanding slots across replicas;
Work, inventory and custody composition must enforce those limits and retain
unknown or provider-valid retired material until evidenced resolution.

Construction fixes scope and owners. Names, Secret references and caller identity
are not authority. The owner durably claims each attempt and records every
outcome before token use.

Material checks identity/currentness before signing, before dispatch and after
asynchronous work. `close()` prevents signing; external copies and immediate
`KeyObject` destruction remain outside its control.

## Mint, retain and revoke

Calls take `TokenIssuerAttemptV1`:
`{ providerAttemptRef, bounds: { signal, deadline } }`.

| Method / outcome                          | Meaning                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `mint(attempt)` → `minted`                | HTTP 201 from `POST /app/installations/{installationId}/access_tokens`; opaque `material` and `expiresAt`. |
| Mint → `rejected`                         | HTTP 401/403/404/422; returns `status`.                                                                    |
| `revoke(attempt, material)` → `confirmed` | Original custody handle; HTTP 204 from `DELETE /installation/token`.                                       |
| Either → `not-dispatched`                 | This invocation did not dispatch; says nothing about other attempts.                                       |
| Either → `unknown`                        | Reconcile only; mint may include captured `material`. Never automatically replay.                          |

Mint explicitly requests the selected repository ID. Acceptance requires exactly
that ID/name (case-insensitive name), exactly selected permissions, and expiry
in the next hour. Missing, extra or duplicate repositories are refused.

Custody synchronously copies recognizable tokens into protected material even
when scope/expiry is invalid. Observations retain returned write/admin
permissions; malformed evidence is unavailable, never replaced with requested
permissions. Capture proves neither durable recording nor permission for Agent use.

`EphemeralTokenHandleV1` has no byte accessor or serialized form; custody
authenticates the original handle, not its type brand. App keys/token bytes must
never reach the Agent. Issuer buffers, including malformed revocation copies,
are wiped; custody retains originals and cleanup. Immutable strings may survive
until garbage collection.

## Bounds and settlement

| Limit               | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Production endpoint | `endpoint: { kind: "github" }`; `https://api.github.com`, API `2026-03-10`           |
| Transport           | Fresh verified HTTPS; no redirects, ambient proxies or retries                       |
| Bounds              | Unaborted `signal`; finite integer epoch-ms `deadline`, future and ≤30 seconds ahead |
| Response / token    | ≤256 KiB / ≤16 KiB                                                                   |
| Concurrency         | One pending operation per instance until owner and actual callback finish            |

`settleAttempt(originalResult)` joins that exact result's finalizer, rejecting
copies/foreign results. It performs no network action or outcome change. Await
it before releasing original authority, even after outward timeout. A
noncooperating owner can delay settlement indefinitely; timeout never transfers
or discharges the obligation.

## Integration and verification

Required integration: startup loads protected material and binds custody to
original State/native/Work sources; the Work constructor consumes prepared
crypto/store owners and selects the issuer matching its admitted fixed read or
write profile. Connect regular Agent repository execution; require verified checkout before Harness use. Settle mint/revoke,
retain partial-startup and late/unknown cleanup through shutdown, and stop/join
Work before closing owners.

See [protocol](../testing/local.md#github-app-token-issuer-protocol) and
[protected-material proof limits](../testing/local.md#protected-github-material).
Local HTTPS/RSA proof establishes neither live GitHub compatibility, production
custody nor Agent execution. Real App-key, positive Agent workflow, scope-denial
and interrupted-read cleanup proof remain required.

## Protected material preparation

Controller `prepareProtectedGitHubCredentials({ state, client, selection, clock })`
requires:

| Owner      | Required selection                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State      | Admitted binding generation, App, installation, repository and same-Namespace logical signing Secret/Driver; rechecked before preparation and each signing use. Changes rejected. |
| Kubernetes | Operator-selected, separately sealed encrypted immutable Secret; exact loader ownership annotations, UID/resource version and envelope SHA256. Mutable metadata cannot select it. |
| Filesystem | Separate mode-0600 master-key file; persistent mode-0700 token directory with one custody writer, excluding the master key.                                                       |

Preparation grants no Work dispatch authority, verifies no repository and does
not enable nonempty repository deployment. On unavailable errors, restore
selected owners; never substitute mutable material or widen scope.

### Token-store recovery

Versioned records check envelope length/digest. Exclusive staging names commit
the complete record's SHA256 before any bytes, including empty interrupted
writes. Only complete matching records publish: no-overwrite hard link and
file/directory fsync.

Recovery refuses incomplete, corrupt, malformed or conflicting pending records
without deleting them. The original custody owner alone may finish matching
partial writes with identical context/envelope; never mint again or replace
the envelope. Errors can follow durable publication: retain original inventory
and cleanup until exact readback or reconciliation. Storage framing neither
replaces AEAD authentication nor confers Work authority.
