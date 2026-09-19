# Basic observability: architecture

[Overview](../31-basic-observability.md) · [Interfaces](interfaces.md) · [Security](security.md)

**Status:** Proposed connected design. Existing audit source does not establish serving History.

## Components and dependencies

History extends the existing `AuditEvent` ledger. Lifecycle and work owners carry original causation. Audit constructs and validates closed owner-specific projections. State persists those facts and queries retained rows. The selected IAM Driver authorizes access, while authentication supplies current account and session validity. HTTP discloses an authorized result and the console renders it.

These are existing ownership boundaries, not new network services. Repository-specific behavior stays in its credential Driver/Provider, exposing a provider-neutral consumer contract to core. Observability adds no execution store, invocation queue, authority lease or substitute native Gateway client. The [repository journey](repository-read.md#connect-authentic-handoffs) consumes actual owners' evidence.

At [pinned main](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/packages/occ/src/state/platform-state.ts#L410), State exposes `append` and unbounded `list`. Controller records describe deployment and reconciliation authority. They do not establish which human initiated a later invocation. The proposed [closed lifecycle shapes](interfaces.md#facts-and-events) still need the complete serving composition.

At newer main `12fddc4`, [deployment status](https://github.com/openclaw/openclaw-enterprise/blob/12fddc4805a1b090331af363ad10bf3b58ea5897/docs/reference/agents.md#L50-L77) reads the original revision reconcile work under exact AgentRevision `read`. It returns `queued/running/succeeded/failed`, safe errors and saved startup warnings. A `202` deploy response records admission. A saved success records historical activation or an already-active revision, not live health, human invocation attribution, physical termination or recovery from unknown mutation COMMIT. Later deployments do not rewrite the original result. This existing read grants no `read_audit` permission and does not implement protected History.

## Request lifecycle

![Proposed lifecycle from local acceptance through authorized History disclosure](request-lifecycle.svg)

Proposed lifecycle. Time flows downward and bottom actors mirror the top actors. Solid arrows are requests and dashed arrows are replies. The diagram shows intended composition, not installed qualification. [Editable Mermaid source](request-lifecycle.mmd).

1. Lifecycle accepts a real create, update, deploy or stop operation. Local mutation, mandatory evidence and accepted controller work commit together in the existing State transaction. The [existing transactional append](https://github.com/openclaw/openclaw-enterprise/blob/724dcb5cb80b5e76a62e8267a21185a2e91a85c2/apps/controller/src/index.ts#L1765) supplies this foundation.
2. Work carries the original causation through claims, retries, supersession, completion and failure. Each later fact states only what its producer observed. Queue completion cannot certify physical workload stop or provider success.
3. Reader C authenticates and requests one historical Agent's History. The API binds a short State write transaction with IAM read-bound authorization. It acquires the [shared guard order](interfaces.md#disclosure-transaction) before locking retention.
4. State samples trusted database time after the retention lock, applies exact current authorization and executes the indexed bounded query. It constructs events from retained producer facts plus trusted receipt and sequence metadata.
5. Immediately before appending disclosure evidence, the API reauthorizes. Only acknowledged COMMIT allows response bytes. A denial, dependency failure or refused/unknown commit yields a sanitized error without a page.

Exact mutation observation uses the same disclosure and restore gates. A prepared recovery reference proves no commit. [Interfaces](interfaces.md#mutation-outcomes) defines accepted versus unknown and keeps observation separate from execution.

## Availability and delivery

The delivery sequence has four independently assessable outcomes:

1. **Optional diagnostics.** Use real authenticated Compose OCC and supported Namespace lifecycle traffic to verify sanitized host-file output. Interrupt the sink and confirm API and mandatory audit outcomes remain intact. Verify file handling. Docker/Podman admission limits cannot prove Agent or model turns, which require supported Kubernetes.
2. **Non-serving source cuts.** Review closed facts, shared account/policy guards, bounded query and recovery contracts, and every audit writer's SQL. These cuts do not enable History early.
3. **First serving lifecycle History.** Join State, IAM, recovery, API and the actual browser across create/update/deploy/stop. Cover retries, supersession, lost COMMIT, restart/replica/key rotation, pagination and privacy. Exercise cross-scope access and races involving revoke, accounts, Groups and Restrictions. Limited-role PostgreSQL must prove exact audit grant/revoke/regrant after Agent deletion. Every console state must work. Both retention modes, actual restore continuity, installed durability and sweeper enforcement pass together.
4. **Complete selected feature.** Distinct A/B/C complete the genuine [ordinary-Agent repository-read acceptance](repository-read.md#acceptance-and-delivery).

Preserve the historical diagnostic checkpoint and its test evidence. Qualify proposed packaging through cumulative, buildable RFC-first successor cuts. Retain necessary supplier ancestry and final-tree equality. Complete contract/documentation checks, SQL review, security review and independent integrated review after writers stop. Repeat affected review after repairs. Update current references, generated API, guides and flows when implementation lands.

Record exact revisions, dependencies, fixtures, cleanup and missing proof separately for source/database, composed, installed, live-provider and release evidence. These are acceptance requirements, not reported passes. A green source check cannot stand in for the next evidence level.

## Optional diagnostics

The [existing export procedure](https://github.com/openclaw/openclaw-enterprise/blob/e9766f35a25afa240ee109b41a6ef821fb68687e/docs/guides/observability.md) supports an operator-owned OpenTelemetry Protocol (OTLP) receiver behind the filtered Collector. This RFC proposes a local diagnostic-file overlay with a pinned image, read-only native configuration and mounted output directory. It reuses the existing endpoint setting and adds the [diagnostic settings](interfaces.md#diagnostic-configuration).

Ordinary development needs no Collector. Authentication, exact selected-IAM authorization, secret filtering and mandatory PostgreSQL audit remain enforced. Add no application log API, global logging mode or Agent file mount. Trusted Drivers can retain `runtimeLogging: "driver"` pipelines.

The diagnostics sink is best effort. Operators own file access, rotation, disk bounds, copies and cleanup. Sink failure must preserve API/audit outcomes. These files establish no protected History, receipt, complete attribution, verified execution, retention guarantee or independent integrity. Later History cannot promote old logs into evidence.

## Dependencies and tradeoffs

Exact historical-Agent authorization does not require a live Agent row. Authentic retained parentage enables the narrowly scoped [audit-role policy operations](interfaces.md#authorization-and-policy-consumption) after deletion. This preserves investigative access without granting configuration or conversation content access.

Protected History remains unavailable until actual State/IAM, recovery and [retention/restore](retention.md) dependencies are installed and validated. Dependency loss cannot select a weaker implementation. Diagnostic availability does not waive this gate.

Local accounts suffice. Federation and every neighboring runtime/channel milestone are not prerequisites for lifecycle History. The later repository scenario needs one qualified ordinary admission/runtime/channel path, not every provider, Harness or retained-workspace delivery. This keeps the selected journey bounded while preserving its genuine execution requirement.
