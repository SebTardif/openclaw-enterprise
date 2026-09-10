# Feature Spec: Codex plugin driver inventory

**Date:** 2026-09-09
**Status:** Accepted — implementation authorized
**Owner:** Controller and Codex plugin driver maintainers

## Problem and Decision

Generate a reviewed JSON inventory by calling Codex app-server `plugin/list`,
then bundle it with a small Codex plugin catalog driver in the controller image.
The [plugin list API](24-driver-plugin-list-api.md) serves this immutable inventory.
This lets operators discover supported plugin identities without copying a
developer's account state or requiring a running Agent for every list request.

Current Enterprise has six [Installation Driver capabilities](../packages/contracts/src/index.ts)
and no native plugin catalog driver. The proposed driver ID `codex` names this
catalog adapter; it is neither a Compute Driver ID nor a native plugin ID.
This proposal adds no seventh Installation capability, package registry or
per-Agent Driver selection. Native plugin installation remains Agent-scoped.

## Scope

**Changes**

- A repeatable local inventory-generation command using `plugin/list`.
- A closed, credential-free snapshot schema and release review boundary.
- A bundled Codex catalog reader consumed by spec 24.

**Does not change**

- No account credentials, linked-app setup, native package installation or
  deployment state are distributed with the inventory.
- No custom marketplaces, tenant uploads, background refresh service or live
  account-eligibility promise. Deployment outcomes belong to specs 25–26.

## Contract

### Identity and ownership

The controller release owns one inventory for driver ID `codex`. Its entries
are **catalog-valid**: reviewed identities supported by that released adapter
and its pinned Codex runtime. They are not promises that a particular Agent's
account can install or invoke those plugins. The Agent runtime rechecks its
own policy and credentials when installing; the snapshot grants no authority.

Preserve `PluginSummary.id` as an opaque ID, unique within this driver. Keep
`remoteMarketplaceName`, required `remotePluginId`, and display `pluginName`
separately. Remote `plugin/install` takes `{remoteMarketplaceName,
pluginName: remotePluginId}`; the RPC field is not the display name. Reject missing
remote IDs, duplicate IDs or conflicting locators. Never derive IDs from labels.
[Codex summary and installation types](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs#L654-L691).

### Snapshot format

The generated file and API `data` use this same closed envelope; spec 23 owns
the field definitions. `plugins` is sorted by `id` for reviewable diffs.

```json
{
  "driverId": "codex",
  "inventory": {
    "schemaVersion": 1,
    "generatedAt": "2026-09-09T23:00:00Z",
    "codexVersion": "0.152.1",
    "sourceMethod": "plugin/list"
  },
  "plugins": [
    { "id": "sample@approved-catalog", "remoteMarketplaceName": "approved-catalog", "remotePluginId": "remote-sample", "pluginName": "sample", "version": null }
  ]
}
```

The example is illustrative, not a discovered plugin. `generatedAt` is the UTC
capture time; `codexVersion` identifies the binary actually queried. `version`
is the advertised remote version or `null`; it is not a package digest or an
installation pin. The build must match the snapshot to its supported runtime
version, currently [0.152.1](../deploy/runtime/Dockerfile). Release review and
the image identify the published artifact; no new database record is needed.

### Generation, privacy and freshness

The release maintainer runs the pinned binary in an isolated generation home,
initializes its app-server protocol, and calls `plugin/list` with
`{"forceRefetch":true}` while omitting `cwds` and `marketplaceKinds`. In this
release, explicitly choosing `local` excludes the default remote catalog;
default listing can include it when runtime features and authentication allow.
[List contract](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs#L128-L185).

Use an approved generation account only when remote discovery requires one;
its credentials stay in the isolated generation environment. The command
must not initiate login, refresh-token recovery or package installation.
Only allowlisted curated marketplace entries approved for redistribution enter
the snapshot. Exclude workspace-directory, private/shared/user-created and
local-path entries, even when their names resemble a curated marketplace.
Project fields explicitly; never serialize the raw response into the bundle.
Drop installed/enabled state, availability and account policy, sharing data,
local paths, URLs and raw diagnostics. Keep raw capture/review evidence private.

Generation fails without replacing the prior snapshot on RPC failure,
marketplace load errors, missing expected remote catalog, unsupported protocol,
invalid identity or an unreviewed source. A successful empty result is not proof
of a complete empty catalog: the [processor](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/app-server/src/request_processors/plugins.rs#L545-L808)
can return empty when disabled or local-only after remote failure. Release
review must establish the intended curated collection was returned, including
any intentionally empty collection; this is not an account-wide completeness claim.

Regenerate and review for every supported Codex runtime change and deliberate
catalog update. Routine API reads never refresh it. Age alone does not make
the snapshot invalid; expose the capture time so callers know its freshness.
Write through a temporary file and rename only after validation and review.

## Implementation

1. Add `scripts/generate-codex-plugin-inventory.mjs` for the bounded RPC capture,
   explicit projection and validation. Keep an optional raw evidence output
   outside the repository; serialize generation per destination file.
2. Add `apps/controller/src/drivers/plugins/codex/inventory.json` beside its
   catalog reader and include it in the controller build/package output. This
   is the inventory bundled with the Codex plugin driver, not an npm install hook.
3. Share its closed schema with the API contract; missing/malformed files or
   runtime mismatch make that catalog unavailable without blocking Installation
   bootstrap. Spec 24 owns the authenticated API error and response behavior.
4. At implementation, update Driver/API reference and packaging documentation
   with generation, review, bundled-file and freshness checks.

## Verification

| Required outcome | How to verify |
| --- | --- |
| Real source inventory | Run the actual pinned app-server `plugin/list` against the approved collection; retain private request, binary version and capture evidence. |
| Identity and privacy | Normalize a captured response; verify ID/locator preservation, duplicate rejection and absence of account state, paths, URLs and unknown fields. |
| Complete publication | Missing expected catalog, partial errors and malformed responses preserve the previous file; deliberate empty collection requires recorded release review. |
| Bundled availability | Build the controller package/image and exercise spec 24 against the included artifact; missing file or runtime mismatch returns its dependency error. |

Specification-phase evidence: an isolated, unauthenticated local Codex 0.147.0
`plugin/list {}` call returned zero marketplaces and no load errors. It proves
the RPC was called, not a release-ready inventory. Generation with the pinned
0.152.1 runtime and approved curated collection remains an implementation gate.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-09 17:09: Drafted inventory contract and recorded isolated RPC evidence; review checkpoint pending (01a088a1-94f8-7860-9b77-be2f9d6af52b - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716).

- 2026-09-09 18:15: User approved simplifications and implementation; corrected remote install identity and sibling link; fresh validation pending.
