# Gateway startup material

The local material borrower assembles one Gateway composition from an original
protected source after the Runtime owner has confirmed its sole startup claim.
It does not enroll a process, authorize a startup, read an ambient credential,
create a provider token, or open a network connection.

The implementation is in `apps/gateway/src/startup-material.ts` and
`apps/gateway/src/startup-material-custody.ts`. Production requires the original
Installation/process enrollment, protected physical reader and lifecycle
consumer-settlement join. Those integrations are not supplied by this module.
A data fixture, metadata Secret lookup or callback stub cannot establish them.

## Original owner inputs

`createGatewayStartupMaterialBorrowerV1(owner, selected, source)` is an internal
trusted-composition factory. It captures the original methods once and snapshots
nonsecret selection data before awaiting work. It must only be attached to the
original Runtime grant's post-confirmed-claim `borrowMaterial` phase. No public
route accepts these arguments or reconstructs their capabilities from JSON.

| Input            | Required meaning                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime owner    | Actual recipient/process incarnation and confirmed original claim; immediate invalidation signal, synchronous currentness fence and conservative original startup time remaining. |
| Selected binding | Complete original startup, selection, configuration, profile, assignment, module and path-ownership references and versions.                                                      |
| Source           | Original protected reader for that exact recipient; current immutable material versions, source invalidation, conservative original lease time and one owned release callback.    |
| Consumer join    | Original lifecycle owner's completion of pending preparation and every native consumer, including failures before an owned prepared handle was returned.                          |

An absent Slack or Teams channel is explicit `null` in both the selected metadata
and supplied composition. Omitting an input is not absence. A configured channel
cannot be dropped, and an absent channel cannot add credentials or a module.
For selected channels, the Slack bot/app credential references and versions, bot
identity, channel profiles, Teams credential reference/version, tenant/app, team,
service origin, endpoint and listener must correspond exactly. The local comparison
also checks the complete Gateway configuration, native configuration digest,
state paths and every selected module. The identity, Harness and persistence
owners and policy callbacks remain required with no channels. A digest comparison supplies data
correspondence only; the original protected source still establishes actual
bytes, immutable versions and path ownership.

The original identity, harness and persistence modules and admission callbacks
remain their owners' implementations. This borrower neither installs replacement
authority nor derives serving readiness from a successful comparison.

No-channel borrowing and preparation do not establish host startup: the currently
prepared upstream host still requires a channel module. See the
[hosted Gateway boundary](hosted-gateway.md#compose-actual-dependencies) for the
additional SDK and production-composition prerequisites.

## Borrowing and currentness

A borrower permits one acquisition attempt and has no waiting queue. The attempt
is consumed before source work begins, including when it fails. Concurrent or
later calls cannot acquire a second bundle or renew the original claim.
One-use is enforced per borrower. The original Runtime claim/enrollment owner
must bind exactly one such borrower to its original recipient; constructing
another borrower is not a replacement claim or recipient-wide uniqueness proof.

The acquisition deadline is the minimum of the original startup time remaining,
the original source lease time remaining and 5,000 milliseconds. An elapsed
local deadline refuses the borrow, invalidates the local capability and retains
its original pending acquisition for cleanup. It does not infer that the source
request ended, forget a late lease, retry the request or invent a provider expiry.

Every material fence accepts only synchronous `undefined` from the captured
original owner/source fences. Returned promises and Booleans are failures.
Rejected native promises are observed without accepting them as authority or
exposing their original rejection reason. Source withdrawal, parent invalidation,
closed custody or an expired source lease prevents further local use.

Native Slack's currentness callback and both Teams currentness callbacks include
the material fence. They preserve the original owner checks. Original native
admission/output/journal checks remain necessary; these wrappers are not a new
human authorization policy. The native admission owner also supplies
`installationRef`, `agentRef`, `assignmentRef` and `runtimeGeneration`. This
module preserves that tuple; it does not infer an equality between Gateway and
Agent assignments or qualify the tuple's relation to the original startup.
That exact correspondence remains an original admission-owner obligation.

## Native credential delivery and limits

When selected, Slack requires two Gateway-only strings in the native composition. Each must be
nonempty, well-formed UTF-8, contain no NUL and fit 32,768 bytes. The owned Slack
material plus a current Teams token result must fit 65,536 bytes. Inputs are
denied rather than truncated. These are local material bounds, not a claim about
native SDK memory or all retained copies.

Teams token requests retain the native supplier's exact signature. The wrapper
requires the selected credential reference, app, tenant and the exact
`https://api.botframework.com/.default` scope. It permits one in-flight request,
refuses additional concurrent requests, combines caller/material cancellation,
checks currentness before and after the original call and applies the same byte
limits. After validating the request, it passes a frozen exact selected target to
the supplier; later caller mutation cannot redirect that target. Every subsequent request calls the original supplier again; there is no
positive authorization or token cache and no fallback scope or credential.

The module does not implement the original supplier's exchange, refresh, expiry
observation or provider revocation. Those belong to its protected source owner.
Long-lived provider/issuer material is not made into a general execution secret.
Native string APIs prevent this module from zeroizing copies already retained by
the SDK or JavaScript runtime. Revocation therefore fences new use and retains
truthful source/consumer cleanup limits; it does not promise instantaneous erasure.

## Close ownership and uncertain cleanup

Invalidation fences immediately. It does not by itself release resources that a
native consumer may still hold. `close()` publishes one join before aborting, so
synchronous reentry receives the same promise.

The original lifecycle owner initiates preparation/native shutdown. Material
close then waits for `joinConsumers()` to resolve with `undefined`, joins its
own pending acquisition/token callbacks, and releases original leases in reverse
acquisition order. It never calls native module close independently. In
particular, invoking material close concurrently with prepared close is not proof
that the prepared/native consumers have settled. The genuine join must cover
late preparation, partial preparation and native shutdown without depending on
material release to complete itself.

A rejected or non-undefined consumer-join result yields `unknown` and retains the
material leases. A never-settling join keeps material close pending; an outer
deadline cannot turn that into confirmed cleanup. The source release callback is
invoked at most once. A late acquisition after refusal is retained and disposed;
an available disposer is retained even if the returned lease has an invalid or
throwing signal. Such malformed custody stays `unknown`.

`finished`, `failed` and `unknown` report owned cleanup only. They are not process
termination, provider revocation, registration withdrawal or inventory completion.
Acquisition/fence errors, malformed results and token supplier diagnostics handled
by this module become the constant `Gateway startup material unavailable` error; material is not included
in returned diagnostics, logs or receipts.

## Validation boundary

The focused tests are
`tests/conformance/gateway-startup-material-custody.test.mjs` and
`tests/conformance/gateway-startup-material.test.mjs`. They exercise local owned
callbacks with synthetic material: explicit absent-channel selection, required
core owners and configured-channel material, selected-input mismatch, no duplicate borrow,
late acquisition, invalidation, rejected fences, byte limits, uncached exact-target
token requests, consumer-settlement ordering and uncertain cleanup.

Independent compile-only producer and consumer fixtures are under
`tests/fixtures/gateway-startup-material-v1/`, each with its own strict no-emit
project. Positive capabilities are required inputs, not fabricated fixture
credentials or readiness proofs. The controlled callback tests do not qualify
the complete native admission tuple or its production mapping. Negative cases reject metadata-as-source,
Boolean/currentness and asynchronous fences. SDK declaration qualification,
provisional Runtime contract inputs and actual commands/results are recorded by
the integration owner; source tests do not establish native or production
provider compatibility.
