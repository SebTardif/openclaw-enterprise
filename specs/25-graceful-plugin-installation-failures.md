# Feature Spec: Graceful plugin installation failures

**Date:** 2026-09-09
**Status:** Accepted — implementation authorized
**Owner:** OCC admission, worker and dedicated Codex runtime maintainers

## Problem and Decision

A bad selected plugin must not prevent an otherwise safe Agent workspace from
starting. Keep one fixed plugin-install error, rebuild the nonserving candidate
without failed plugins, and deploy when native exclusion and ordinary readiness
are proven. [Spec 26](26-agent-deployment-status-api.md) reports overall success
and plugin errors independently. No native error-message classification is needed.

Current [Compute contracts](../packages/contracts/src/index.ts),
[admission](../packages/occ/src/index.ts) and [worker](../apps/controller/src/worker.ts)
have neither selected-plugin snapshots nor a native installer. These are required
implementation changes, not existing support. Workspace means the Agent's private
runtime state; singleton Installation bootstrap and Namespace readiness stay separate.

## Scope

- Admit Agent-owned plugin selections and immutable server-resolved snapshots.
- Install in a private, nonserving dedicated Codex candidate; isolate failures and
  preserve them through retries, activation and maintenance.
- Initial supported target is bundled Kubernetes Compute with dedicated Codex.
  Other Compute/Harness paths reject nonempty selections before side effects.
- No plugin call API, account consent flow, custom marketplace, shared-account
  uninstall, generic scheduler, automatic plugin repair or console changes.

## Contract

### Selection and snapshot ownership

Extend Agent creation with optional `plugins:[{driverId,pluginId}]`; omission means
`[]`. The Agent stores that set and returns it in reads. Admission requires existing
Agent creation authority on the Namespace agent collection and Installation
catalog authority for nonempty sets. Namespace-create permission alone is insufficient.
Bound the set to 32 unique tuples and reject unknown IDs or unsupported runtime
with existing invalid-request errors; unusable catalog is a dependency error.
Save Agent and selections atomically; shared Configuration cannot install plugins.

At deploy admission, revalidate the selection against [spec 23's catalog](23-codex-plugin-driver-inventory.md)
and snapshot `selectedPlugins:[{driverId,pluginId,remoteMarketplaceName,
remotePluginId,version,catalogCodexVersion}]` into AgentRevision. `pluginId` is the
opaque catalog `id`; the server alone resolves locators. `version` is advertised
metadata or null, not an executable content pin. Later catalog changes cannot
rewrite the admitted snapshot. The worker accepts reports only for these tuples.
Client input cannot supply locators, credentials, paths, policy or native settings.

### Installation failure boundary

The native adapter calls `plugin/install` once per admitted plugin, using
`{remoteMarketplaceName,pluginName:remotePluginId}` under the Agent's own identity.
An explicit JSON-RPC application error response to that call records the fixed
`PLUGIN_INSTALL_FAILED`; do not infer a subtype from its message or code.
Structured `plugin/read` facts `availability=DISABLED_BY_ADMIN` or
`installPolicy=NOT_AVAILABLE` can reject that plugin before attempting installation.

This is a typed transport-outcome boundary, not a claim about the erased native
cause: [Codex 0.152.1](https://github.com/openai/codex/blob/rust-v0.152.1/codex-rs/app-server/src/request_processors/plugins.rs#L2073-L2094)
collapses native failures into generic JSON-RPC errors. Transport loss, timeout,
cancellation, lost claim, app-server crash, login/model credential failure,
ownership or policy failure, and unknown local exceptions remain fatal/retryable
through existing deployment handling. Never catch every exception as a plugin error.
A successful response with `appsNeedingAuth` is an installed bundle needing separate
account setup; it is not a failed install and grants no tool-call consent.

### Clean candidate and effective exclusion

Installation executes only in this revision's nonserving Codex process and private
`CODEX_HOME`. After an application error, terminate that process and recreate its
runtime home; never modify Agent user workspace files, the old serving runtime,
another Agent, or remote/backend installed state. Rebuild from admitted selections
minus persisted failures. A second failure extends that set and repeats the bounded
rebuild; at most 32 selected identities can fail. Base credentials remain private
runtime inputs and ordinary runtime validation still applies after rebuilding.

Before exposing the candidate, use the same process/workspace and exhaust paging
on native observation APIs: `plugin/installed`, `skills/list` with `forceReload`,
`hooks/list`, and `mcpServerStatus/list`. Require no failed plugin installed/enabled,
no enabled skill or hook attributed to its `pluginId`, and no MCP server/tool from it.
`plugin/read` declarations or Pod readiness alone do not prove effective absence.
If backend synchronization restores a failed plugin, any proof API fails, or exact
ownership/policy cannot be established, the candidate stays nonserving and deployment
fails. Fresh home alone is insufficient; no compensating account-wide uninstall.

Only admitted selected plugins may contribute native capabilities. Apply supported
native plugin enablement and per-tool policy in the candidate before serving;
verify effective state, reject tool ownership collisions, and preserve ordinary
native per-call approval (`prompt`, denied tools in `disabled_tools`). No direct
MCP tool call bypass is added. An unsupported policy/proof capability fails closed.

### One durable failure owner

The worker loads spec 26's persisted report and projects failed identity tuples into
`ComputeRevisionContext`, alongside awaited
`reportPluginInstallFailure({driverId,pluginId})`. The adapter sends identities only.
OCC validates, deduplicates and stores fixed code/message under its live queue claim
before acknowledging. Report immediately after the application error, before reset
or further work, so a later fatal error retains the diagnosis. There is one durable
report; context and retry exclusions are projections, not additional state stores.

A lost claim or failed persistence stops continuation. Native candidate mutation
must respect operation cancellation; an uncertain outstanding operation cannot be
replayed into a serving runtime. Existing per-Agent queue serialization and bounded
retry/deadline policy remain. Re-observe native state after recovery.

Plugin errors alone never requeue an otherwise ready deployment. Successful
activation/finalization produces `succeeded` plus `pluginErrors`; later fatal failure
produces `failed` with both channels. Maintenance retains exclusions and historical
results. An authorized new revision is the retry path for a failed plugin.

## Implementation

1. Add the closed Agent selection and revision snapshot contracts, API validation,
   OCC admission and PostgreSQL/in-memory persistence with real authorization tests.
2. Add the bounded native Codex preparation/proof adapter and connect it to bundled
   Kubernetes revision preparation. Keep transport credentials inside the runtime;
   any result-transfer boundary must verify exact Pod/Agent/revision ownership.
3. Wire identity-only failure reporting to [worker](../apps/controller/src/worker.ts)
   and [queue persistence](../packages/occ/src/state/postgres-work-queue.ts) from spec 26;
   report before cleanup, preserve through all transitions and fence stale writers.
4. Update Agent/Compute reference and runtime flow documentation with supported
   boundaries and exact executable verification commands when implemented.

## Verification

| Required outcome | Proof |
| --- | --- |
| Admission is exact and immutable | Real API/OCC/PostgreSQL tests: authorization, duplicate/unknown IDs, atomic save, server-only locators, deploy revalidation and unchanged earlier snapshots. |
| Bad plugin leaves a useful Agent | Pinned native runtime: A installs, B returns a real install application error; rebuild, native exclusion checks, activate and ordinary approved A tool call; poll success with B's fixed error. |
| Fatal boundaries and recovery | Classifier/worker tests exercise explicit RPC error versus transport/cancel/unknown exception; real PostgreSQL tests crash after reporting and around activation, reject stale writes and preserve diagnosis after later fatal failure. |
| Isolation and maintenance | Real runtime proof preserves user files/other Agent; backend-restored B or failed effective proof prevents activation; maintenance cannot re-enable B or rewrite deployment history. |

Live runtime/account prerequisites must be available for native proof. No mock,
Pod readiness or merely saved selection substitutes for installation and exclusion.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-09 17:07: Drafted isolated optional-plugin failure contract (01a088a1-94f8-7860-9b77-be2f9d6af52b; ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716).
- 2026-09-09 18:19: Applied approved simplification and source-backed correctness direction: identity-only report, explicit snapshot and RPC-outcome boundary with native exclusion proof; fresh validation pending.
