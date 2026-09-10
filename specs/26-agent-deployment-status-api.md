# Feature Spec: Agent deployment status API

**Date:** 2026-09-09
**Status:** Accepted — implementation authorized
**Owner:** OCC API, persistence, and controller worker maintainers

## Problem and Decision

Return a deployment ID when an Agent revision is admitted and expose its durable
outcome through a polling endpoint. Reuse the immutable revision ID and its
existing reconciliation job. A successful deployment can include plugin installation
errors; those errors must survive worker restarts and remain visible to callers.

Currently [deployAgent](../packages/occ/src/index.ts#L1533) admits an immutable
revision and queues reconciliation. [HTTP admission](../apps/controller/src/index.ts#L1762)
returns that revision with `202`, while [the worker](../apps/controller/src/worker.ts#L960)
performs activation and predecessor retirement. There is no deployment-status API.
The queue's [`complete` method](../packages/occ/src/state/postgres-work-queue.ts#L416)
ignores its result argument; the work row stores state but no durable error report.
The following contract is proposed, not current behavior.

## Scope

**Changes**

- Return deployment identity, poll its state, and persist fatal and plugin errors.
- Carry the recoverable plugin failures defined by [spec 25](25-graceful-plugin-installation-failures.md) through the existing worker lifecycle.
- Update the existing deploy response consumer and API/reference documentation.

**Does not change**

- Immutable AgentRevision contents, Driver selection, workload ownership, or authorization requirements.
- Installation/Namespace provisioning, Agent creation, maintenance health, or runtime rollback semantics.
- No new job service, deployment table, callbacks to clients, cancellation API, deployment history endpoint, or automatic plugin repair.

## Contract

### Identity, admission, and access

One admitted AgentRevision has one deployment, owned by its exact Namespace and
Agent. `deploymentId` equals the revision's existing `id`; it is stable across
worker claims and retries. The original `agent_revision:<id>:reconcile` work row
owns the outcome. Maintenance jobs for that revision cannot modify this report.

The bodyless `POST /namespaces/:namespaceId/agents/:agentId/deploy` returns
`202 { "data": { "deploymentId": "rev_…", "revision": { "id": "rev_…", "…": "existing revision fields" } }, "meta": { "requestId": "…" }`.
The existing immutable revision payload is nested under `revision`; update its
consumers together. Revision admission, original work creation, and attributable
audit evidence commit atomically before returning `202`. Admission failure returns
the existing HTTP error and creates no deployment. `202` never asserts readiness.

Add `GET /namespaces/:namespaceId/agents/:agentId/deployments/:deploymentId`.
It returns `200` in the existing `data`/`meta.requestId` envelope, with data fields
`deploymentId`, `namespaceId`, `agentId`, `status`, `pluginErrors`, and `error`.
The ID also locates the immutable revision through the existing revision-read API.
Apply the [exact revision-read authorization](../packages/occ/src/index.ts#L850)
and ownership checks: `read` on `agent_revision` with ID `deploymentId` under the
server-owned Installation and exact Namespace/Agent. Add no IAM resource kind.
Preserve existing authentication, denial auditing, `403`, and parent-mismatch `404`
behavior. Never return claim tokens, actor IDs, raw work rows, or Driver diagnostics.

### State and error semantics

| Public `status` | Meaning |
| --- | --- |
| `queued` | The original job is queued or its claimed lease has expired awaiting recovery. |
| `running` | The original job has a live claim lease; this is not workload readiness. |
| `succeeded` | The worker completed activation, verified the active revision, and completed required predecessor retirement. |
| `failed` | The original job reached permanent failure or exhausted its existing retry/deadline policy. |

`pluginErrors` is always an array of `{driverId, pluginId, code, message}`.
The runtime adapter reports only `{driverId, pluginId}`; OCC validates them against this revision's
admitted plugin selections. Initially `code` is `PLUGIN_INSTALL_FAILED` and
`message` is the fixed platform text `Plugin installation failed.`
Keep one entry per `(driverId, pluginId)`, bounded by the admitted selection set.
Store neither credentials, paths, upstream text, nor command output in this report.

`error` is `null` until terminal failure, then `{code, message}` with an existing
worker failure code including `REVISION_SUPERSEDED` and a platform-owned safe summary.
Plugin errors alone do not set `error` or make the deployment fail. For example,
`{"status":"succeeded","pluginErrors":[{"driverId":"codex","pluginId":"example","code":"PLUGIN_INSTALL_FAILED","message":"Plugin installation failed."}],"error":null}`
means the Agent activated with that plugin excluded. A later fatal runtime failure
produces `failed` plus `error`, while preserving earlier `pluginErrors`.
Spec 25 owns which installation errors are recoverable and how exclusion is proved.

Persist a terminal reason on original work completion, including internal success.
Internal `succeeded` with reason `REVISION_SUPERSEDED` maps to public `failed`
with that code; ordinary activated completion maps to `succeeded`. Preserve existing
supersession audit semantics. An internal no-op success cannot imply activation.
A completed deployment remains `succeeded` after a newer revision replaces it.
Polling reports the historical deployment outcome, not whether it still serves traffic.
`activeRevisionId` alone is insufficient: [finalization can still be pending](../apps/controller/src/worker.ts#L1010)
after the pointer changes. Fatal cleanup/activation failures retain existing safety
behavior and cannot be downgraded to plugin errors or implicit rollback.

### Persistence, retries, and concurrency

Extend the existing work row with validated plugin errors and terminal reason code.
The worker supplies spec 25's awaited identity-only callback and owns validation,
deduplication, fixed public messages and live-claim writes before later runtime work.
It projects failed identities from that report for exclusion; no second persisted list.
Reports survive existing queue transitions and recovery; terminal state and reason
commit together, including success, recovery and exhaustion paths.

Reuse [claim fencing, per-Agent claim exclusivity, and retries](../packages/occ/src/state/postgres-work-queue.ts).
A lost claimant cannot publish errors, exclusions, or terminal state. The next owner
re-observes native state before continuing; uncertain plugin side effects cannot be
treated as a safe exclusion. Preserve current bounded worker attempts and convergence
deadline; an unavailable worker leaves a deployment queued until recovery resumes.
Repeated POSTs intentionally admit different immutable revisions, as today. Client
idempotency keys are deferred. Client guidance: never auto-replay an uncertain POST.

## Implementation

1. Add deployment response types and the scoped GET route in [API contracts](../packages/contracts/src/api/routes.ts), then implement admission serialization and exact authorized lookup in OCC/controller. Adapt [the console deploy consumer](../apps/controller/src/console/agents/detail.mjs#L279) to `data.revision`.
2. Extend [work persistence](../packages/occ/src/state/postgres-schema.ts#L646), the queue, and the platform read repository. Enforce bounded report/terminal-state invariants with database constraints; the in-memory test adapter mirrors them and exposes admitted work as queued without fabricating execution. Missing persisted work for an admitted revision is a dependency error, never fabricated success.
3. Wire spec 25's reporting callback into [revision reconciliation](../apps/controller/src/worker.ts), preserve errors on every transition, and terminalize superseded original deployments accurately. Preserve maintenance behavior and claim ownership; implement this with spec 25 before enabling the new response contract.
4. Update [Agent reference](../docs/reference/agents.md), generated API reference/OpenAPI, and [worker flow](../docs/flows/controller-worker.md) when implementation ships. Keep current reference behavior unchanged during this specification phase.

## Verification

| Required outcome | How to verify |
| --- | --- |
| Admission is atomic and scoped | Real API/PostgreSQL tests assert the returned ID resolves its exact revision/job; denied admission creates neither; cross-Agent/Namespace and denied revision reads reveal no outcome. |
| Successful deploy may report plugin failure | Supported runtime plugin test injects a genuinely rejected selected plugin, proves its exclusion plus Agent readiness, then polls `succeeded` with the exact safe error. |
| Fatal failure preserves plugin errors | Real worker test records a plugin error, triggers later readiness/cleanup failure, and polls terminal `failed` with both error channels. |
| Retry/restart preserves the report | Extend [worker revision tests](../tests/integration/postgres-worker-agent-revision.test.mjs) and [stale-claim tests](../tests/integration/postgres-worker-stale-claim.test.mjs): recover before/after activation, deny stale writes, retain plugin exclusions, and persist terminal exhaustion/deadline codes; expired claimed work polls queued before recovery. |
| Concurrent revisions have honest outcomes | Real worker tests supersede an unfinished revision, retain an earlier successful report after retirement, and show maintenance cannot change either report. |
| Wire data is safe and clients remain usable | API schema/OpenAPI checks reject raw diagnostic fields; console test proves nested revision handling; queued-without-worker behavior is explicit. |

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog
- [2026-09-09 17:09]: Draft deployment identity, polling, and durable outcome contract for coordinated review. (01a088a1-94f8-7860-9b77-be2f9d6af52b - ee53c7b562ab0d593a3bfb8ecfd6e700ee98a716)

- 2026-09-09 18:15: Applied approved simplification direction: identity-only adapter reporting, one persisted outcome, existing supersession reason and lease-aware status; final review pending.
