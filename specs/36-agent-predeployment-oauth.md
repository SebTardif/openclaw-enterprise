# Authenticate an Agent before deployment

**Date:** 2026-09-23\
**Status:** Acquisition and custody implemented locally; API and runtime integration in progress\
**Scope:** Agent-owned OAuth acquisition, staging, handoff, and recovery

## Selected behavior and ownership

OpenClaw Enterprise (OCE) completes consent while an Agent is a draft. Deployment
consumes that authentication without opening another login. Each Agent owns one
connection and one selected native auth profile, reused across its revisions.
After initial import, native OpenClaw (OC) owns refresh and persists rotations in
Agent-private durable storage.

This flow replaces the deployment-time consent proposed by
[OCE #252](https://github.com/openclaw/openclaw-enterprise/pull/252). It does not
adopt its auth-only Agent Pod, deployment consent endpoints, or browser-waiting
worker. Reusable Namespace provider setup metadata does not carry OAuth custody:
each Agent selecting it must authenticate into its own `aoc` generation.

The main provider task owns catalog, Console presentation, and revision
selection. This task owns Agent OAuth HTTP and WebSocket endpoints, lifecycle,
credential custody, and runtime delivery. The current user requirement is actual
setup-to-deployment support for every offered native-supported method; disabled
placeholders are not a completed deliverable. The native SIWC owner supplies
its supported interface; OCE does not implement SIWC itself.

## Proposed shared contract

Use the existing Agent primitive, created before consent but not deployed. Keep
public DTOs material-free:

| Contract             | Fields or behavior                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth selection       | Draft references reusable `pco` metadata; custody separately records Agent-owned `connectionId`, `generation`, `providerId`, `methodId`, `profileId`                         |
| Auth status          | Selection, `attemptId`, phase, deadline, safe failure code, and model access status separately (`unverified`, `verified`, `failed`)                                          |
| Begin/reconnect      | Exact Namespace/Agent, current `providerConnectionId`, expected OAuth generation; server resolves the native method and returns safe status and private consent instructions |
| Read/cancel          | Exact Namespace/Agent/attempt/generation; cancellation invalidates completion authority                                                                                      |
| Deployment admission | Requires completed consent, qualified image, current generation, and current actor authority; returns private projection references                                          |
| Handoff completion   | Internal, exact Agent/generation/profile/PVC UID and deployment ownership; records durable native persistence before cleanup                                                 |

The [custody flow](../docs/flows/agent-oauth-custody.md) records the coordinated
HTTP and socket contract. The admitted OAuth revision variant remains a
coordination point with the provider task.
The browser cannot choose backend locations, native state paths, commands, or
runtime images. Consent instructions are available only to the initiating actor;
audit and logs exclude device codes and callback payloads.

## Attempt authority and custody

An OCC lifecycle record binds the Namespace, Agent, initiating actor, connection,
generation, attempt ID, deadline, selected method/runtime, and safe phase. Use
PostgreSQL constraints and compare-and-set transitions through
`PlatformStateStore`; the existing workspace-setup and repository-session
repositories provide ownership and transition patterns. This needs reviewed OCE
persistence changes, not a new native OC SQLite schema.

Authorize acquisition with exact-Agent `administer` and `operate`, plus `operate`
on the selected provider connection; authorize deployment with
exact-Agent `deploy`. Verify the Agent still belongs to the exact Namespace and
is not deleting. Completion must match the initiating actor, pending attempt,
unexpired deadline, and current generation. Recheck authorization after awaited
provider work and immediately before storing or handing off credentials. A
process-local promise, attempt ID, or possession of a callback is not authority.

Invoke the qualified native managed-login interface in an isolated temporary
state directory. Native code validates provider-required state and PKCE. OCC
supplies cancellation and current-attempt checks before native persistent effects.
Controller restart terminates an unfinished attempt with an actionable new-login
requirement unless native resumption is explicitly qualified. Do not hold a
database transaction while waiting for consent.

Stage the complete provider-qualified native OAuth credential: access and refresh
tokens, expiry, and supported client/account/auth-flow metadata. Preserve native
schema fields; do not reduce the bundle to an API key. Store bytes through the
selected SecretDriver in a private generation-owned Secret, outside ordinary
Configuration bindings and public Secret CRUD. OCC retains only its backend
reference and safe lifecycle metadata. Clean up temporary acquisition state after
staging or cancellation; acquisition must not continue refreshing the bundle.

Reuse Kubernetes ownership labels, backend UID checks, size bounds, redacted
errors, and tenant-local RBAC. Existing storage relies on operator-configured
Kubernetes encryption at rest and protected backups; OCE adds no built-in
encryption. Ordinary Secret creation uses random backend names. Private `stage`
and `findStaged` operations add immutable, identity-derived creation and recovery.
Reconnect creates new staging material instead of
overwriting an older generation's Secret.

## Conditional handoff and refresh ownership

Before exposing staged material, OCC records its generation and exact durable
PVC UID. Compute projects the bundle only into the model-executing runtime's
initialization step. A dedicated gateway must never mount it. An existing
successful runtime is stopped and termination confirmed before its replacement
may open the shared native store or refresh credentials. This intentionally
permits deployment downtime to preserve one refresh owner.

The initializer uses public `updateAuthProfileStoreWithLock` from
`openclaw/plugin-sdk/provider-auth`. Its synchronous updater inspects the native
profile under the native write transaction. Insert the expected profile only
when absent; a retry finding that same generation's persisted profile leaves it
unchanged, including rotated tokens. A nullable failure is a failed handoff.
Reopen the persisted profile before reporting success. Do not copy SQLite files,
add receipt fields to native credentials, or invent another native schema.

Generation identity must be distinguishable inside this conditional operation.
Proposed encoding: reserve a generation-qualified native profile ID and select
only that profile. Explicit reconnect stops the old owner, then atomically
replaces the retired selected profile with the new generation; ordinary revisions
keep the same profile. Confirm this detail with the main task before implementation.

OCC marks a generation consumed only after durable native completion. It retains
the consumed generation and PVC UID after deleting staging. A consumed generation
cannot initialize an empty store again; a different PVC UID requires reconnect,
even if stale staged material remains. Before acknowledgment, retry on the same
PVC observes the native profile instead of overwriting it. Superseded workers
cannot acknowledge or delete another generation's material.

Enforce that fence at each actual import, including a restart from an older Pod
template; a dispatch-only check is insufficient. Qualify how the initializer
obtains current authority before enabling the method. Remove the staging
projection from the steady-state deployment template before deleting its Secret,
so ordinary Pod replacement can reopen native state without that Secret.

Record pending cleanup before deletion and retain exact backend references until
deletion succeeds. Agent deletion must drain this cleanup before removing its
custody record. Local deletion, upstream revocation, and stopping an Agent have
separate outcomes; do not report remote revocation from local cleanup.

## Failure and recovery contract

| Condition                                             | Required outcome                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Consent cancelled, expired, or superseded             | Reject completion; clean temporary material; start a new authorized attempt              |
| Credential stored, deployment not started             | Retain private staging; deployment performs no new consent                               |
| Import fails or acknowledgment is lost                | Retry the same generation/PVC; preserve an existing native profile                       |
| Pod replaced or revision redeployed                   | Reopen current native store on the same PVC; never reseed consumed material              |
| PVC replaced or native profile lost after consumption | Return `reconnect_required`; do not restore the original OAuth bundle                    |
| Access token expires                                  | Native OC refreshes and persists rotation; terminal refresh rejection requires reconnect |
| Reconnect or replacement deployment                   | Stop the previous refresh owner, fence old attempts, import only the current generation  |
| Secret cleanup or upstream revocation fails           | Keep separate retryable cleanup state; keep disconnected authority unusable              |
| Authentication succeeds but model access fails        | Show authenticated state and model failure separately; block activation                  |

## Qualification and evidence

Acquisition supports **embedded OC on Kubernetes, provider `openai`, methods
`oauth` and `device-code`** at the adapter boundary. Deployment requires the native managed-login prerequisite
[OC #153046](https://github.com/openclaw/openclaw/pull/153046), a qualified immutable
runtime image, and genuine provider lifecycle proof. SIWC and bare dedicated
Codex remain gated pending their own native contracts, custody, and image proof.
Catalog labels or current source support do not qualify a deployed image.

| Provider/method            | Placement               | Current qualification                                                                         |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| OpenAI browser/device-code | Embedded OC, Kubernetes | Acquisition adapter and native-store tests only; deployment fence and immutable image pending |
| OpenAI SIWC                | Embedded OC             | Native owner's source contract only; hosted callback and image qualification pending          |
| OpenAI OAuth               | Dedicated Codex         | Unsupported: current native OC refresh/store ownership is not established in this topology    |

OCE's baseline runtime image pins OC/plugins `2026.9.1` and Codex `0.156.0`.
These are not OAuth-qualified versions for this flow. The native prerequisite
commit below is source evidence; no deployed-image digest is claimed.

Investigation baseline: OCE `43776d25c5007e017f7d0ffdca6b06f063afcd37`, especially
[Secret storage](../apps/controller/src/drivers/secret/kubernetes/index.ts),
[platform state](../packages/occ/src/state/platform-state.ts), and
[deployment dispatch](../apps/controller/src/worker.ts). Native prerequisite source
was inspected at `314758d46ef4db2deb4084f2c44ee81573fac461`: managed-login runtime,
provider auth exports, credential schema, and the transactional auth-store updater.
These are source observations, not a supported release matrix or live proof.

Implementation acceptance requires real API/PostgreSQL/Kubernetes workflow tests
for consent-before-deploy, handoff, uncertain acknowledgments, stale attempts,
Namespace/actor isolation, redaction, refresh rotation, restart, PVC loss, and
exclusive refresh during replacement. Genuine consent, model access, refresh,
and revocation need separately reported provider evidence. No provider/Harness
combination is enabled yet. The acquisition adapter, custody owner, PostgreSQL
repository, and conditional native initializer are implemented locally; the
[custody flow](../docs/flows/agent-oauth-custody.md) records their current boundary.
Deployment import still needs an execution-owner fence. Existing Pod status
transport is read-only, and current Compute has no import/exec capability. A
restartable Secret projection alone cannot reject a superseded import. Runtime
image qualification, model access, real refresh/revocation, and shared
catalog/revision integration remain acceptance work.
