# GitHub App token issuer

**Integration pending.** The GitHub implementation provides the `TokenIssuerV1`
contract for one selected repository. Production startup and the regular Agent
repository-read caller are not connected yet. Deliver this implementation with
those owners and their integration proof before enabling the capability.

## Owning contract

Import `TokenIssuerV1`, `TokenRevokerV1`, their attempt/result types and
`EphemeralTokenHandleV1` from `@openclaw-enterprise/contracts`. Import
`createGitHubAppMaterialV1`, `createGitHubAppTokenIssuerV1` and
`createGitHubAppTokenRevokerV1` from `@openclaw-enterprise/occ`.

A TokenIssuer mints bounded credentials into protected custody and revokes an
original opaque handle. It is separate from the existing Provider contract,
which supplies authenticated clients to member Drivers. There is no issuer
registry or Installation configuration surface in this change.

Trusted construction fixes the key identity, GitHub installation, exactly one
repository ID/name, read permissions, material and custody owners. Each call
carries only its original attempt reference, abort signal and finite deadline;
a request cannot choose another key, repository or permission profile.

## Select material and repository scope

Construct App material from a private RSA `KeyObject` of 2048–8192 bits, its exact
App client ID, binding reference and immutable key version, a trusted clock and
a synchronous currentness assertion. The key owner authenticates the source and
immutable version before construction. The material checks identity/currentness
before signing, before dispatch and after asynchronous work settles. `close()`
prevents subsequent signing; JavaScript cannot erase copies owned elsewhere or
force immediate destruction of a `KeyObject`.

The issuer accepts exactly one entry in `selection.repositories`. Permissions
require `metadata: "read"` and optionally `contents: "read"`. Requests for writes,
issues, pull requests or additional permissions are rejected during construction.
Every token request names the selected repository ID explicitly.

`assertDispatchCurrent` must check the original operation's current authority.
Returning a Promise is refused. A repository name, Secret reference or
caller-supplied identity does not establish that authority. The owner must durably
claim each attempt before minting and record every outcome before token use.

## Mint, retain and revoke

`mint()` calls GitHub's installation-token endpoint and accepts HTTP 201 only
when the returned repository ID/name and permission map match exactly, with an
unexpired token no more than one hour ahead. Missing, additional or duplicate
repositories and broader permissions are refused.

A recognizable token is captured synchronously even when its scope or expiry is
invalid, so cleanup retains responsibility for it. The custody owner copies the
bytes into protected material before returning its opaque handle. The issuer
wipes its temporary buffers. Returned-permission observations retain broad or
administrative permissions; malformed evidence is marked unavailable instead of
being replaced by requested permissions.

`EphemeralTokenHandleV1` has no byte accessor or serialized form. Its type brand
is not authority: custody authenticates the original handle before borrowing its
token. Capture alone does not establish durable recording or permit Agent use.
App keys and installation-token bytes must not be delivered to the Agent.

Mint results distinguish `minted`, `rejected`, `not-dispatched` and `unknown`.
Unknown results require reconciliation and may include captured material; a lost
response never permits automatic replay. `not-dispatched` describes only the
current invocation and does not prove another attempt did not execute.

A separately constructed `TokenRevokerV1` can revoke retained material after App
key loss. It borrows the exact authenticated handle, calls `DELETE
/installation/token`, and confirms only HTTP 204. Other dispatched outcomes
remain unknown. Every issuer-owned revocation copy is wiped, including malformed
material; custody retains its original bytes and cleanup obligation.

## Bounds and settlement

Production transport uses `https://api.github.com`, API version `2026-03-10`,
verified fresh HTTPS connections and no redirects, ambient proxies or retries.
Calls require a deadline at most 30 seconds ahead. Responses are bounded to
256 KiB and token material to 16 KiB. Mutable buffers are wiped on success and
failure; immutable JavaScript strings can remain until garbage collection.

An instance retains its single pending-operation capacity until the original
material/custody owner and actual callback finish. The outward deadline may
return first. `settleAttempt(originalResult)` joins that exact result's finalizer
without another network operation or changing the outcome. It rejects copies and
foreign results. The operation owner must await it before releasing its original
authority use. A noncooperating owner may leave settlement pending indefinitely;
timeout does not transfer or discharge the obligation.

## Integration and verification

The repository-read owner must load the selected protected App material during
actual startup, bind custody and the original State/native/Work sources, connect
the regular Agent repository read, and require a verified checkout before Harness
use. Partial startup acquisitions and late/unknown token effects must retain
cleanup ownership through shutdown.

The [protocol tests](../testing/local.md#github-app-token-issuer-protocol) verify
local HTTPS/RSA behavior. They do not prove live GitHub compatibility, protected
production custody or a regular Agent execution. A real App-key test and the
positive Agent workflow, scope-denial and interrupted-read cleanup cases remain
required before this delivery is complete.

## Protected material preparation

The controller's `prepareProtectedGitHubCredentials` joins an admitted repository
binding to an operator-selected immutable Kubernetes App-key source. Selection
fixes the binding generation, App, installation, repository, logical signing
Secret, encrypted source UID/resource version and envelope digest. State checks
before preparation and each signing use reject changes to the binding generation,
selected identities, same-Namespace Secret reference or Secret Driver.

Provision a separately sealed, encrypted immutable Secret associated with the
admitted logical Secret and carrying the protected loader's exact ownership
annotations. Ordinary mutable Secret metadata cannot select this source. Use a
separate mode-0600 master-key file and persistent mode-0700 token directory with
a single custody writer; the directory cannot contain the master key. App keys
and installation tokens remain outside the Agent.

The original repository Work constructor must consume the prepared crypto and
persistent token-store owners, select its fixed read-only TokenIssuer, settle
mint/revoke attempts, and stop/join Work before closing those owners. Production
Work integration and regular Agent checkout remain unimplemented. Preparation
grants no Work dispatch authority, verifies no repository and does not enable
nonempty repository deployment. See the
[protected-material proof limits](../testing/local.md#protected-github-material).

A generic unavailable error means the binding, immutable source or protected
filesystem no longer matches the selection. Restore those owners before retrying;
never substitute mutable material or widen scope.
