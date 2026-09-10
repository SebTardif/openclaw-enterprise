# Plugin and deployment specification coordination

**Status:** Simplifications approved and applied; implementation authorized on separate worktrees.
**Source base:** `ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716`.

## Scope and owners

| Specification | Author responsibility |
| --- | --- |
| [23: Codex inventory](../23-codex-plugin-driver-inventory.md) | `plugin/list` collection, sanitized bundled inventory, provenance and validity |
| [24: Plugin list API](../24-driver-plugin-list-api.md) | Required driver selector, response and exact authorization |
| [25: Graceful plugin failures](../25-graceful-plugin-installation-failures.md) | Plugin-local failure isolation and safe workspace preparation |
| [26: Deployment status API](../26-agent-deployment-status-api.md) | Deployment identity, polling, durable fatal and nonfatal outcomes |

The four documents are proposals. The existing source exposes six Installation
Driver capabilities and immutable Agent revisions; it has no Agent plugin
installer or plugin-catalog Driver. Earlier plugin-primitive work remains a
dependency proposal, not verified runtime support.

## Shared drafting decisions

- `driverId=codex` selects the proposed built-in plugin-catalog driver. It is
  separate from an Installation Driver instance ID, Harness ID, or native plugin
  ID. Catalog listing alone does not require a seventh Installation capability.
- Listing requires a driver ID. The initial static catalog API follows the
  existing Installation-authorized provider-list pattern. It is distinct from
  a later Agent-specific view of selected, installed, and account-eligible plugins.
- Catalog-valid means a reviewed, structurally valid entry in a supported
  bundled snapshot. It does not imply target-account entitlement, credentials,
  successful installation, or runtime callability. Collection must use
  `plugin/list`; account-specific results cannot be published indiscriminately.
- Workspace means the Agent's private runtime workspace. A plugin-local error
  may permit the remaining workspace and Agent deployment to succeed only after
  failed-plugin effects are safely absent or disabled. Trusted platform Driver
  loading, identity, policy, isolation, and necessary runtime failures remain fatal.
- Deployment identity reuses the admitted revision ID. Existing revision work
  owns execution and the proposed durable result; no new scheduler is needed.
  Plugin errors are independent from overall success/failure. A completed
  deployment result remains historical after a newer revision replaces it.

## Evidence and implementation boundaries

- [Driver capabilities and revision contracts](../../packages/contracts/src/index.ts)
  and [selection reference](../../docs/reference/drivers/selection.md) define
  trusted package loading, not Agent plugin installation.
- [Deploy route](../../packages/contracts/src/api/routes.ts) currently returns
  an immutable revision with HTTP 202. [Admission](../../packages/occ/src/index.ts)
  records revision reconciliation in the existing transaction.
- [Worker](../../apps/controller/src/worker.ts) already handles claims,
  convergence deadlines, retry limits, activation and supersession.
  [Queue](../../packages/occ/src/state/postgres-work-queue.ts) currently ignores
  `WorkResult.details`; exposing durable deployment outcomes requires explicit
  persistence changes and outcome mapping, not just a new route.

## Review checkpoint

Each draft will be frozen for independent correctness and simplification
reviews. Review JSON and digest validation are stored outside this repository.
The coordinator will present one combined direction and wait for Kevin before
applying reviewer-proposed changes. Changed documents then require fresh review
validation before the specification workflow can finish.

### Required corrections identified so far

- **23 / remote identity:** preserve `PluginSummary.remotePluginId`. Codex 0.152.1
  passes JSON-RPC `pluginName` as the remote plugin ID when installing from a
  remote marketplace; a display/native name is not the install locator. Keep
  opaque selection `id`, remote locator and display name distinct.
- **25 / native error contract:** current Codex `plugin/install` collapses native
  failure types into generic JSON-RPC errors. Safe plugin-local classification
  needs a supported structured error contract; parsing messages or treating all
  install failures as nonfatal would violate the selected safety boundary.
- **25 / admitted selection:** identify the owner and closed immutable revision
  snapshot used to validate reported plugin IDs. Catalog/list specs alone do not
  provide selection admission. The dependent console proposal supplies creation
  input; its snapshot and native installer dependencies still need exact contracts.
- **25 / exclusion evidence:** name the actual candidate `CODEX_HOME`, native
  observation APIs and reset/verification sequence. Failed RPC or Pod readiness
  alone cannot prove tools, skills and hooks are excluded. Missing native proof
  support must remain an explicit implementation prerequisite.
- **26 / expired claims:** public `running` requires a live lease. Map expired
  claims to `queued` while awaiting existing recovery; only persisted terminal
  failure produces a fatal error. Prove the before/after-recovery API response.
- **26 / supersession:** current queue completion can mean successful handling
  of a superseded revision, not activation. Persist its existing
  `REVISION_SUPERSEDED` terminal reason even on internal success, then map that
  reason to public deployment failure. Retain existing internal audit semantics
  and use the same reason publicly rather than introducing a duplicate name.
- **Minor:** correct spec 23's sibling link and status vocabulary; identify the
  bounded catalog-driver query schema explicitly in spec 24.

### Simplification direction for approval

All four frozen drafts passed the review-phase digest validator. Specs 23 and 24
received `no-meaningful-simplification`; specs 25 and 26 received
`changes-proposed`, so final validation is still blocked pending direction.

| Proposal | Why sufficient / retained behavior | Tradeoff or constraint |
| --- | --- | --- |
| 25: adapter reports only failed `(driverId, pluginId)` | OCC validates, deduplicates and writes its one fixed public error shape before later failures | Keep the early awaited callback; a return-only result loses the diagnosis if later work throws |
| 25: project failed identities from the persisted report | One durable owner supplies retry exclusion | Do not add a second persisted exclusion list |
| 26: reuse existing `REVISION_SUPERSEDED` reason | Only the public outcome mapping must change | Pre-activation supersession still reports failure; historical success remains success |
| 25–26: compress repeated recovery/test wording | Retain outcome-based tests and existing safety suites | Do not drop distinct crash-after-activation, stale-claim, containment or ownership coverage |
| 26: put uncertain-POST handling in client guidance | Repeated POSTs keep existing distinct-revision semantics | Client must not auto-replay an uncertain deployment request |

Keep concrete selection/native-install dependencies visible. The simplification
suggestion to remove dependency detail is safe only when another agreed document
owns the exact contract. Preserve honest queued behavior for any supported
in-memory/no-worker API mode rather than synthesizing deployment success.

### Review summary and ordering

| Spec | Correctness review | Simplification verdict |
| --- | --- | --- |
| 23 | Major remote install identity correction; minor link/status corrections | No meaningful simplification |
| 24 | Minor explicit query schema clarification; also inherits 23's identity correction | No meaningful simplification |
| 25 | Major typed failure, admitted snapshot and native exclusion-proof gaps | Changes proposed: narrow adapter report and consolidate ownership/proof prose |
| 26 | Major expired-claim and superseded-success mappings | Changes proposed: reuse reason code and shorten repeated recovery/client wording |

Implementation order after approval: (1) 23 inventory/schema, then 24 listing;
(2) admitted selection/snapshot and native candidate contracts, coordinated with
console 27; (3) 26 durable outcome storage and 25 failure reporting/exclusion
together; (4) expose 26 polling and validate the dependent console end-to-end
flow. Storage/API-only progress must not claim graceful native installation works.

Deferred work: broader Driver capability/lifecycle machinery, custom marketplaces,
live catalog refresh/account eligibility APIs, client idempotency keys, automatic
plugin repair and additional runtime paths. The initial real `plugin/list` call
used isolated unauthenticated Codex 0.147.0 and returned empty arrays. A reviewed
redistributable inventory from pinned 0.152.1 and live installation/turn proof
remain implementation gates, not completed verification.

No product tests were run in this specification phase. All four original spec
digests remain unchanged; all four structured simplification reviews passed
`--phase review`. `--phase final` is pending approved edits and fresh verdicts.

### Dependent console proposal

The parent task owns console spec 27 and will present one combined approval
question. It proposes creation input `plugins:[{driverId,pluginId}]`, initially for
dedicated Codex and Installation administrators, and server-side locator resolution.
It also proposes allowing `GET /plugins` to omit `driverId` and resolve the
release-owned default, avoiding a browser hardcoded ID or discovery endpoint.
That is a deliberate alternative to spec 24's frozen required-selector contract,
not an applied change. Missing default would fail explicitly; explicit driver
requests retain their by-driver semantics. Namespace-only users could still create
plugin-free Agents without broader catalog permissions.

## Changelog

- 2026-09-09 17:08: Recorded four-author ownership and source-backed shared drafting direction (session `01a088a1-94f8-7860-9b77-be2f9d6af52b`; source `ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716`).

## Approved implementation handoff

Kevin requested: “Make simplifications. Then implement in subagents on separate worktrees.”
The task branch rebased to fresh `origin/main` at `277ed179f716b661ef72eaa283c74944a53a60d6`.
Canonical docs/lifecycle changes remain unrelated and untouched. Console 27 remains
a separate unapproved proposal; required `driverId` is retained.

Focused correctness reviews resolved remote identity, exact Agent-create authority,
snapshot ownership, expired lease and supersession mapping. Source verification
confirmed pinned native installed-plugin, skill, hook and MCP-status observation APIs.
The safe minimal failure boundary now accepts explicit per-install RPC application
errors only after fresh candidate reconstruction and effective exclusion proof;
transport/cancel/credential/unknown local failures remain fatal. Detailed upstream
error subtypes are unnecessary for the fixed public error and remain unavailable.

Initial implementation ownership: inventory and shared plugin types; catalog API
plus selection/snapshot; native runtime preparation; deployment result/worker API.
Each works in a separate worktree. Coordinator integrates local commits, resolves
shared-file conflicts, runs combined checks and obtains independent code review.
No remote writes or changes to existing deployments are authorized.
