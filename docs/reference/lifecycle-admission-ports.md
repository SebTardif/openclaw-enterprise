# Lifecycle admission and durable work definitions

The lifecycle modules define a local admission-to-worker boundary. They provide closed value parsers, immutable association checks, sanitized projections, interface declarations and compiling consumer examples. They do not implement admission, authentication, transactions, a lifecycle dispatcher or runtime effects. Installing the exports does not enable the new management protocol.

The existing bodyless deploy route and its immutable revision response remain unchanged. Its optional trusted-domain generation check is a compatibility bridge. The new protocol requires an explicit expected generation and has a different minimal response; using it in a management route requires coordinated admission, storage, worker and client integration.

| Module                                                  | Responsibility                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@openclaw-enterprise/contracts/lifecycle-admission-v1` | Canonical request, intent, association, receipt, historical operation and work-input values; strict parsers and pure projections                              |
| `@openclaw-enterprise/occ/lifecycle/ports-v1`           | In-process admission, authorized read, post-unwind recovery and internal worker-read interfaces                                                               |
| `@openclaw-enterprise/occ/lifecycle/work-v1`            | Existing work/claim parsing and pure correspondence between canonical lifecycle input, retained association, installed work and supplied head/claim snapshots |

OCC remains a domain library. The API and separate worker communicate through transactionally persisted work. There is no RPC inside the atomic unit and no public worker-command service in these definitions.

## Requests, intent and immutable association

A mutation request identifies the exact Namespace and Agent, the action and a mandatory `expectedLifecycleGeneration`. Its value is null for no head, or a positive safe integer. Missing, zero, negative, fractional, string and unsafe values reject. Resume additionally requires an explicit `retained` or `saved-draft` revision source; the other actions cannot add it. For example:

```ts
import { parseLifecycleAdmissionV1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";

const request = parseLifecycleAdmissionV1("mutationRequest", {
  schemaVersion: 1,
  kind: "stop",
  namespaceId: "ns_11111111-1111-4111-8111-111111111111",
  agentId: "agt_22222222-2222-4222-8222-222222222222",
  expectedLifecycleGeneration: 7,
});
```

This only parses a request. Installation, original principal and management entitlement come from the real authenticated controller/store context. A body cannot supply them, a transition locator, audit/work identity, assignment or provider target. The accepting implementation must check current exact permissions and semantic entitlement under the authoritative transaction guard. Earlier observations and parsed fields do not grant permission.

The new `LifecycleIntentV1` imports the existing runtime intent fields and explicitly distinguishes running with a selected revision from disabled/stopped with a nullable selected revision. A first protective transition has no revision. That null lineage can continue across later protective transitions until a real revision is admitted. The installed `RuntimeIntent` and its storage repository still require a revision string. The new nullable definition cannot be cast into that installed representation or passed to the existing runtime-authority record API.

An admission association contains the exact parsed command, immutable intent, original audit identifier and original work identifier. Parsing checks scope, kind, source, next generation, selected revision and attribution correspondence. It does not establish that independently persisted intent, history, head, revision, audit, work and cleanup rows exist. Those facts must be committed together and independently verified by the owning implementation. Prior-mode legality, retained revision compatibility and cleanup responsibility require actual predecessor state and authority.

Keep each identity and counter distinct:

| Value                                   | Meaning                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Configuration generation                | Authorized mutable draft version                                                            |
| Lifecycle generation                    | One increment for each accepted material transition; no-head is null, never generation zero |
| Runtime generation                      | Independently allocated execution-instance generation                                       |
| Record/evidence/preparation versions    | Their specific owning producer's concurrency checks                                         |
| `transitionRef` / public `operationRef` | One retained transition locator, never a bearer capability                                  |
| `workId`                                | The original durable-work identity, separate from the transition locator                    |
| `requestId`                             | Diagnostic correlation; equal request IDs do not establish exact admission identity         |
| Assignment and effect references        | Existing runtime authority/effect identity, not a lifecycle work receipt                    |

## Minimal receipts and separate reads

Every accepted mutation returns only its disposition and the new operation's locator, kind, revision source, lifecycle generation, desired mode and acceptance time. It omits revision, previous operation, actor, audit, work, assignment and runtime details. A protective action need not have Agent read permission merely to receive this minimal result.

A matching same-mode disable/stop returns only `disposition: "unchanged"`, the submitted lifecycle generation and requested protective mode. It creates no new intent, work or mutation-success audit. Stale CAS still conflicts. An unchanged result does not reset retries, repair a runtime, recreate cleanup or prove convergence. Material counter overflow conflicts; a matching unchanged request at the maximum counter remains representable.

The request/result correspondence helper verifies that a declared accepted or unchanged response matches the submitted command and generation. It does not query a head or establish that the CAS actually succeeded. Likewise, the pure projection helpers sanitize declared association data; calling one never attests COMMIT.

`LifecycleReadPortV1` exposes a separate current-intent head projection and immutable historical operation projection after current exact Agent read authorization. The latter adds only the selected revision ID to the minimal operation fields. Revision documents still require both owning Agent and exact AgentRevision reads. Actor, request, audit, work, transcripts, outputs and credentials are not included. Observation/status fields have a separate owner; these definitions do not infer serving, termination or stop completion from a work state.

## Transaction outcome and recovery

The controller retains its one-use transition locator and diagnostic request ID before opening admission. `LifecycleAdmissionPortV1.admit` owns the atomic admission outcome. A confirmed accepted result requires COMMIT of all mandatory associations. Admission failure must make an enclosing unit rollback-only even when its caller catches the error. No provider create, route change, native import or teardown belongs inside that transaction.

An uncertain commit has a separate in-process outcome containing an opaque recovery handle. The future owning implementation may issue this handle only after the failed unit has fully unwound, retaining all immutable expected association fields privately. The handle is correlation and process custody, not authority. No parser or constructor for it is exported, and TypeScript branding is not a runtime security mechanism.

`recoverAfterUnwind` requires a fresh authenticated read call and a new store read, never the failed ambient unit. Confirmation compares the exact Installation, owner, command/source, original actor/request, transition, generation/revision, audit and original work. A later current head or completed/failed original work does not invalidate a complete historical acceptance. A partial association, foreign owner, unavailable dependency or missing current read permission cannot confirm it.

An unconfirmed result is not proof that a transaction rolled back or cannot still commit. It authorizes no retry. The admission example submits once and performs only exact recovery after an unknown outcome. Reusing the trusted locator is a conflict even for an identical request. If an HTTP caller never learned its locator, authorized discovery is separate; equal draft contents, timestamps or diagnostic request IDs cannot select an admission automatically.

## Work compatibility and effect boundaries

`ReconcileAgentLifecycleV1` is the accepted future handler definition. Its closed input contains schema version, handler name, exact Namespace/Agent, transition locator, lifecycle generation and original work ID. The worker must load the complete immutable association and independently authenticate its service context. The payload carries no claimed trusted actor, revision, audit, Installation, runtime URL or selected peer.

The installed queue still supports namespace reconciliation and revision-backed Agent reconciliation. Its work objects use `Date` timestamps, optional legacy association fields, a claim token and a lease; PostgreSQL nulls are represented by omitted optional fields. The installed parsers preserve these representations and reject incomplete pairs. They do not create a database row or issue a claim.

The same PostgreSQL queue also retains a distinct `ReconcileRuntimeFaultV1`
cleanup variant. Its exact original fault digest, intent, responsibility, gate
version and fence epoch stay separate from a human lifecycle transition. Claiming
it requires the original lifecycle worker capability and installed fault-work
compatibility. The dispatcher retains pending responsibility while provider
fencing is unavailable; it never sends that work to running preparation or
declares physical stop from a queue result. See [canonical closed gate and fault
retention](runtime-preparation/gates.md#canonical-closed-gate-and-fault-retention).

Installed deploy work has identity `agent_revision:<revisionId>:reconcile`. That revision-keyed identity cannot represent repeated material lifecycle commands on the same retained revision. The current child-work schema also requires a revision and its admission association. Nullable protective intent, resume and the new handler therefore cannot be silently translated into installed work. The pure correspondence helper reports unsupported transitions rather than constructing an enqueue operation. A real versioned queue codec, constraints, dispatcher and handler must be integrated together before any new capability can enqueue work.

Historical association comparison and current head/claim preflight are separate operations. A historical match can survive head advancement and terminal work. A supplied current snapshot can reject a stale generation, owner or claim, but it supplies no authentic clock, service provenance, current policy or effect authority. Queue lease expiry does not prove cancellation, physical termination or writer exclusion.

`LifecycleWorkerReadPortV1` imports the existing runtime service invocation context. Its implementation must verify private service/recipient/purpose custody before exposing the complete internal association. A returned read snapshot cannot replace the existing runtime authority and conditional-effect guards. Running work rechecks current original-actor/reference permissions and profiles. Accepted exact cleanup uses its own independent responsibility after human revocation and cannot create, resume, purge or affect a successor. Unknown creates, writers and termination remain unresolved until their real producers establish the required outcomes.

## Consumer checks and integration limits

The admission and worker fixture modules import the public package subpaths independently. They compile without constructing authenticated handles, recovery handles, runtime authority or effect permits. Their functions accept injected future ports; the tests do not instantiate a live admission service or invoke a runtime provider.

Focused conformance covers closed values, required CAS, nullable revision restrictions, immutable owner/request/audit/work correspondence, minimal projections, partial or lost-response association vectors and the distinction between historical acceptance and current snapshots. These are pure definition and correspondence checks. They are not memory/PostgreSQL transaction, restart, unknown-COMMIT, live authorization or termination evidence.

Actual account/session custody, selected IAM and management entitlement through COMMIT, immutable approved profiles, lifecycle storage/cleanup writes, authorized query implementations, queue cutover, accepting effect guards and truthful observations remain required. Missing producer capability stays unavailable. These modules neither replace those producers nor enable the future management routes or worker handler.
