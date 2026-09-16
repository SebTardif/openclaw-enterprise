# GitHub App token issuer

**Integration pending:** production startup, repository Work and regular Agent
checkout are unconnected. Do not enable repository deployment through this API.

## Owning contract

Import `TokenIssuerV1`, `TokenRevokerV1`, attempt/result types and
`EphemeralTokenHandleV1` from `@openclaw-enterprise/contracts`;
GitHub factories/types from `@openclaw-enterprise/occ`.

| Factory                         | Required options                                                                 | Returns                                   |
| ------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `createGitHubAppMaterialV1`     | `privateKey`, `identity`, `assertCurrent`, `clock`                               | `GitHubAppMaterialV1`                     |
| `createGitHubAppTokenIssuerV1`  | `selection`, `material`, `custody`, `assertDispatchCurrent`, `clock`, `endpoint` | `TokenIssuerV1`                           |
| `createGitHubAppTokenRevokerV1` | `custody`, `assertDispatchCurrent`, `clock`, `endpoint`                          | `TokenRevokerV1`; no signing key required |

TokenIssuer owns bounded credentials in protected custody; Provider supplies
authenticated clients to Drivers. No issuer registry or Installation
configuration surface exists.

## Select material and repository scope

| Input                                     | Contract                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privateKey`                              | Private RSA `KeyObject`, 2048–8192 bits; owner authenticates source/version.                                                                                     |
| `identity` / `selection.key`              | Exact `clientId`, `bindingRef`, `immutableVersion`.                                                                                                              |
| `selection`                               | Positive `installationId`; `repositories: [{ id, fullName }]` (exactly one); `permissions: { metadata: "read", contents?: "read" }`. Other permissions rejected. |
| `clock`                                   | Trusted epoch-millisecond clock.                                                                                                                                 |
| `assertCurrent` / `assertDispatchCurrent` | Synchronous, returning `undefined`; Promises refused. Dispatch checks original operation authority.                                                              |

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
crypto/store owners and selects its fixed read-only issuer. Connect regular
Agent read; require verified checkout before Harness use. Settle mint/revoke,
retain partial-startup and late/unknown cleanup through shutdown, and stop/join
Work before closing owners.

The [protocol tests](../testing/local.md#github-app-token-issuer-protocol) verify
local HTTPS/RSA behavior. The opt-in [live App-key test](../testing/github-app.md)
checks issuance for one private repository, live token scope and keyless
revocation against GitHub. Its test-process custody does not prove protected
production custody or regular Agent execution; see the
[protected-material proof limits](../testing/local.md#protected-github-material).
Production delivery still requires the positive Agent workflow, scope-denial and
interrupted-read cleanup cases through the actual startup and repository-read caller.

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
