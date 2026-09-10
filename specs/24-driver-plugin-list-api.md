# Feature Spec: Driver-scoped plugin list API

**Date:** 2026-09-09
**Status:** Accepted — implementation authorized
**Owner:** Controller API and built-in plugin catalog adapter maintainers

## Problem and Decision

Add `GET /plugins?driverId=codex` so an Installation administrator can discover
valid plugin catalog entries for one explicitly selected driver. The controller
returns the reviewed, bundled inventory defined by [spec 23](23-codex-plugin-driver-inventory.md).
It does not contact an Agent or use the caller's Codex account during this read.

Current [routes](../packages/contracts/src/api/routes.ts) have no plugin list API.
The six existing [Driver capabilities](../packages/contracts/src/index.ts) own
platform infrastructure; none is a Codex plugin catalog. Here `codex` names a
new built-in plugin catalog adapter, distinct from a configured Compute Driver,
Provider ID, plugin ID, or Agent Harness execution mode. This spec adds no new
generic Driver capability or lifecycle. These are proposed API semantics.

## Scope

**Changes**

- One authenticated, read-only endpoint with required driver selection.
- A closed response schema that exposes safe catalog entries and provenance.
- Explicit distinction between a valid empty catalog and unavailable inventory.

**Does not change**

- Per-Agent selection, installation, installed/enabled status, account setup,
  tool authorization, or deployment status. See [spec 25](25-graceful-plugin-installation-failures.md)
  and [spec 26](26-agent-deployment-status-api.md) for installation outcomes.
- Tenant access to Installation-wide catalogs, a driver discovery API, catalog
  search/pagination, dynamic refresh, arbitrary packages, or local marketplaces.
- Existing Installation-selected Driver registration and package trust rules.

## Contract

### Request and authorization

Register operation `listPlugins`, action `openclaw.plugins.list`, resource kind
`installation`, authorization target `installation`, IAM action `administer`.
Reuse the authenticated [controller route pipeline](../apps/controller/src/index.ts)
and `requireInstallationAdmin`, matching the existing `listProviders` boundary.
The server derives the singleton Installation ID; the caller cannot choose one.
The selected IAM Driver decides exact Installation authority and authorization
denials retain existing attributable audit behavior. Authorize before resolving
the requested catalog or exposing inventory availability.

`driverId` is a required single string query parameter, using a new `PluginCatalogDriverId`
schema in [API common schemas](../packages/contracts/src/api/common.ts), with
the same bounded, trimmed, no-control-character constraints as `ProviderId`.
Omission, empty/invalid values, repeated values, and unknown query parameters
return `400 INVALID_REQUEST`. An authorized request for a well-formed but
unsupported driver returns `404 NOT_FOUND`; the first supported ID is `codex`.
Requiring the ID directly reflects the requested per-driver list and prevents
an implicit default or mixed-driver result as adapters are added.

The endpoint is Installation-scoped because its input is a shared release
catalog, not an Agent's account or configuration. Namespace read permission does
not grant this operation. A future Agent-scoped eligible/selected plugin list
must authorize its own exact Agent and evaluate its runtime/account separately.

### Response and meaning of valid

Return `200` with `{data: inventoryEnvelope, meta: {requestId}}`, using the
existing [response envelope](../packages/contracts/src/api/resources.ts).
Spec 23 owns `inventoryEnvelope`: `driverId`, `inventory` provenance, and
`plugins`. Reuse that schema instead of defining a second catalog wire model.
Provenance identifies the schema version, generation time, exact Codex version,
and `plugin/list` source method. Each plugin preserves its opaque native ID,
remote marketplace name, required `remotePluginId`, display plugin name, and
version or `null`. Installation passes `remotePluginId` as RPC `pluginName`.

For example, an authorized `GET /plugins?driverId=codex` returns the exact
validated bundled envelope in `data`. A validated inventory containing no entries
returns `200` with `data.plugins: []`, retaining provenance and the request ID.
The API returns only the requested driver's entries in the artifact's stable
order; native plugin IDs are never parsed to recover installation locators.

**Valid means admitted to the reviewed catalog for this bundled adapter/runtime.**
It does not mean that a target Agent's account can see, install, authenticate to,
or execute the plugin. A catalog entry grants no authority. Selection/deployment
must still enforce the target account, runtime compatibility, and native policy.
The list contains neither raw app-server response fields nor credentials,
account/workspace IDs, local paths, installed/enabled flags, or auth/setup state.

### Availability and freshness

The adapter validates and retains one immutable inventory snapshot per process
release. Concurrent requests read that same snapshot; the operation has no writes,
installation side effects, or retry/idempotency state. Refresh requires the
reviewed regeneration and package rollout owned by spec 23.

Missing or malformed inventory, an unsupported inventory schema, or mismatch
with the packaged supported Codex runtime returns `503 DEPENDENCY_UNAVAILABLE`
through the existing sanitized error envelope. Inventory failure affects this
endpoint, not unrelated platform operations or startup. It cannot become an
empty-success response or trigger live account fallback. A validated empty
snapshot remains a success; the successful-empty/unavailable distinction follows
the existing [Provider API tests](../tests/integration/console-api.test.mjs).

Generation time describes snapshot freshness; elapsed age alone does not
invalidate a release or establish current account eligibility. A target-side
installation failure after listing is reported by the deployment workflow.
No automatic TTL, remote polling, or general catalog database is introduced.

## Implementation

1. After spec 23 provides its normalized artifact and validator, expose its
   in-memory safe envelope to controller composition; preserve an explicit
   unavailable result for unusable inventory without failing platform startup.
2. Add the required query and shared response schema in `packages/contracts/src/api`,
   then wire `listPlugins` in `apps/controller/src/index.ts` with exact IAM and
   sanitized errors. Keep the static adapter lookup separate from the existing
   `(capability, id)` Driver registry.
3. Extend real Fastify integration coverage alongside `console-api.test.mjs`.
   At implementation, regenerate OpenAPI/API reference and document the catalog's
   Installation access and snapshot semantics in current feature documentation.

## Verification

| Required outcome | How to verify |
| --- | --- |
| Required driver selection | Real route rejects missing, repeated, empty/invalid and unknown query fields; unsupported valid ID returns 404 after authorization. |
| Correct access | Installation administrator succeeds; unauthenticated caller gets 401 and Namespace-only reader gets 403 with audit evidence, for present and absent catalogs alike. |
| Exact safe response | Real serializer returns the validated spec 23 envelope and request ID; no account, credential, path, or raw policy fields escape. |
| Honest availability | Valid empty snapshot yields 200 with provenance; missing, malformed, unsupported-schema and incompatible-runtime artifacts yield sanitized 503 while unrelated API operations still work. |
| Stable read behavior | Concurrent requests share identical catalog content without mutating state, contacting app-server, or borrowing manager/Agent credentials. |
| Contract integration | Generated OpenAPI check and typed route checks pass; later deployment tests independently prove target account denial despite catalog membership. |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-09 17:08: Drafted required driver selection, Installation authorization, shared inventory response and failure semantics for review. (01a088a1-94f8-7860-9b77-be2f9d6af52b - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716)

- 2026-09-09 18:15: User approved simplifications and implementation; clarified selector schema and remote ID; required driverId retained, console default remains a separate proposal.
