# Feature Spec: Codex plugin autocomplete suggestions

**Date:** 2026-09-15
**Status:** Implemented; PR validation pending
**Owner:** OCC suggestions API

## Problem and Decision

Give the plugin console a small checked-in list of OpenAI-curated names and IDs
for autocomplete. Suggestions are static metadata. Enablement, account access,
installation status, and runtime validity are deferred; suggesting an entry
makes no claim about any of them.

This replaces this spec's earlier dynamic API, app-server, and SWR proposals.

## Scope

- One bundled list and one authenticated, Namespace-scoped read endpoint.
- No Plugin Service calls, app-server provisioning, credentials, cache/TTL,
  status fields, background work, or changes to Agent selection/install behavior.
- Console UI implementation is separate; consumers filter the returned list locally.

## Contract

`GET /namespaces/:namespaceId/plugin-suggestions` returns the existing list
response envelope: `{data:[{id,name}],meta:{requestId}}`.
Authorize exact Namespace `read` and verify its Installation ownership using
existing OCC behavior. The caller needs no Agent, PluginDriver selection,
Provider, ServiceAccount, or runtime. Preserve standard authentication, denial,
and missing-resource responses.

Each entry has a stable Enterprise-native ID
`codex-plugin:<slug>@openai-curated-remote` and a display name. Start with 26
common entries whose slugs were verified in the existing Codex 0.153.4 inventory
capture from September 10; this is a maintained subset, not an exhaustive catalog.
Keep a single immutable source list. Return deterministic ordering and no
availability, enabled, installed, policy, or tool metadata.

Do not require membership in this suggestions list when saving an Agent's plugin
map. Existing structural validation and native startup behavior remain unchanged.
Adding or removing a suggestion only changes future list responses.

## Implementation

1. Add the catalog-owned data module under `apps/controller/src/drivers/plugin`.
2. Add the response schema, declarative route, and controller handler, reusing
   OCC Namespace read for authorization. Do not manufacture Agent context or
   invoke native `PluginDriver.listCatalog` for autocomplete metadata.
3. Update API generation, the Agent plugin reference, and its request flow.

## Verification

- Through real Fastify/OCC/IAM, list suggestions before any Agent, Provider,
  ServiceAccount, or selected PluginDriver exists.
- Verify unauthenticated and cross-Namespace requests are denied and missing
  Namespaces retain the existing error behavior.
- Verify stable native IDs, unique deterministic results, and metadata-only
  responses without invoking native discovery or contacting an upstream service.
- Run affected HTTP integration tests, typecheck, OpenAPI, workspace, formatting,
  docs length, and flow validation. No live plugin proof is required for static
  autocomplete suggestions.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-15 08:38: Specified lazy public-API inventory and configurable one-hour SWR caching (01a091f2-5124-7732-ab79-15625b5facae - ab242ba0ec0d5deebc90400018c3ab13db8b3a78).
- 2026-09-15 08:46: Simplified to one reader, three cache states, and focused acceptance checks (01a091f2-5124-7732-ab79-15625b5facae - ab242ba0ec0d5deebc90400018c3ab13db8b3a78).
- 2026-09-15: Replaced dynamic inventory with static console autocomplete suggestions; deferred enablement and account/runtime checks (01a091f2-5124-7732-ab79-15625b5facae - c7bbe7dc1ee0a2c3eec4f698391d891aaf6ae3ea).
