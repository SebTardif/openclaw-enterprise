# GitHub App provider protocol

Status: **inactive provider component**. The module implements GitHub App signing,
installation-token creation and exact-token revocation. It has no production
registration, API route, Secret resolver or native delivery implementation.

This is part of the native direction in
[repository access modes](../../specs/20-repository-access-modes.md). The
[native Git and gh client](native-git-client-mechanics.md) still requires its actual
original-authority and inventory-backed delivery owner.

## Fixed external composition

`packages/occ/src/github-app-provider-v1/material.ts` holds one external owner's
immutable RSA private-key lease. Construction requires an actual private RSA
`KeyObject`, exact App client ID, logical binding and immutable version, a trusted
clock and a synchronous owner currentness assertion. The module never reads an
ambient key, imports a runtime-supplied key or exports key bytes. It checks the
same identity and lease before signing and after the asynchronous consumer settles.
The consumer also receives a synchronous lease assertion, which the provider
rechecks after original dispatch authorization immediately before network dispatch.
Closing the lease prevents subsequent use. JavaScript cannot erase all copies of
a key retained elsewhere or force immediate destruction of a `KeyObject`.

This lease does not establish Secret UID/version provenance or authenticate an
App/account association. The protected immutable Secret adapter and its genuine
owner must supply that correspondence. A caller-provided identity string is not
proof of custody. The module adds no material cache or persistent key store.

`provider.ts` requires startup-fixed trusted App/installation/repository selection,
key material, external token custody, clock, endpoint profile and a synchronous
original-dispatch assertion. Its caller must reserve and claim the exact provider
attempt durably through the existing
[credential inventory](credential-inventory-v1.md) before invoking it. The assertion
must authenticate that retained original authority; this component cannot derive
it from repository metadata. Promise-returning assertions are refused.

## Provider behavior

The production endpoint profile is fixed to `https://api.github.com`. Calls use a
fresh verified HTTPS connection without redirects, connection pooling, ambient
proxy selection or automatic retry. An explicit `local-protocol-test` profile
accepts only an HTTPS loopback IPv4 peer and supplied test CA; it is not a
production endpoint override.

The material lease signs an RS256 JWT with the selected client ID, an issued-at
value 60 seconds in the past and expiry no later than five minutes or the call's
remaining deadline. GitHub documents these claims and RS256 signing in its
[App JWT reference](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).

Minting sends `POST /app/installations/{installation_id}/access_tokens` with
explicit numeric repository IDs and the selected finite permission set. This
component permits metadata read, contents read/write, issues read and pull-request
read/write. Selection must contain one to 100 distinct repositories. The response
must contain exactly the selected repository identities and permissions, plus an
unexpired provider expiry no more than one hour ahead. Missing or broader scope
is not accepted. See GitHub's
[installation-token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).

A recognizable token is passed synchronously to the fixed external custody
owner, including when the response has an invalid scope or expiry. That preserves
material for exact mitigation instead of losing a possibly live token. Custody
must copy the temporary byte buffer before returning; the provider wipes its
mutable copy. This callback stages protected material. It does **not** prove a
durable inventory commit or authorize release into a runtime. The result exposes
only the owner's opaque material handle and bounded outcome metadata.

Revocation calls `DELETE /installation/token` using the exact handle's token,
with at most one invocation of the provider callback. Only an actual HTTP 204
response yields provider confirmation. A custody callback cannot fabricate that
acknowledgment without executing the request. See GitHub's
[revocation endpoint](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token).

## Bounds and ambiguous outcomes

Calls require a finite trusted deadline at most 30 seconds ahead. Each provider
instance admits one active operation. Response bodies are limited to 256 KiB and
tokens to 16 KiB. The final dispatch assertion and deadline checks occur immediately
before bytes are handed to Node. Mint results repeat currentness after response
and material capture, and the key lease checks its own validity after the await.

A dispatched request with a lost response, unsupported status, malformed or
excessive response, cancellation, or invalid scoped token returns `unknown` with
`reconcile-only`. Known mint rejection statuses expose only their numeric status;
provider response diagnostics and credential bytes never appear in result objects.
No outcome starts an automatic retry. The durable inventory owner must prevent
reinvocation of an ambiguous provider attempt across calls and restarts.

Both mint material and revocation custody promises are bounded for their callers.
The provider permits one callback per invocation and accepts only that callback's
actual result. It joins actual HTTP work even if an owner returns early or throws
synchronously after invoking its callback. If an owner does not cooperate with
cancellation, the instance retains its active-call charge until that owner's real
settlement. A timeout cannot silently open a second request slot. Late callbacks
still pass the original deadline and dispatch checks. Upstream key/custody cleanup
remains the external owner's responsibility.

Provider success must be recorded with the existing inventory's known outer
commit before token delivery. Runtime release additionally requires a fresh exact
original-authority check at the release boundary. Neither provider success nor a
staged material handle permits `NativeDeliveryPort` to become positive by default.
Unknown mint, revoke, push and PR outcomes keep their original operation identities
for reconciliation.

## Verification

With the matching installed dependencies, run:

```sh
node --test --test-concurrency=1 tests/conformance/github-app-provider-v1.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck --allowImportingTsExtensions packages/occ/src/github-app-provider-v1/material.ts packages/occ/src/github-app-provider-v1/provider.ts
```

The suite generates synthetic RSA keys, verifies actual signatures and uses a
local HTTPS peer with TLS verification enabled. It checks exact request scope,
response ceilings, captured mitigation material, response loss without replay,
late currentness/key loss, cancellation, synchronous assertion enforcement,
revocation callback ownership and pending-custody capacity. Its in-memory custody
and currentness controls are explicitly test inputs. They are not production
material, human/turn authority, durable token inventory, or live GitHub permission
qualification. Actual App selection, protected key source, inventory owner joins
and runtime delivery remain required integration work.

## Protected material integration

[Protected GitHub credential custody](protected-github-custody.md) implements encrypted
installation-token retention, exact recovery and revocation without the App signing
key. Its material receipt does not replace original inventory/current-authority
or committed-release acceptance.
