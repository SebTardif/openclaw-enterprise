# Lifecycle status API

The lifecycle read API exposes sanitized status, accepted-operation discovery,
exact historical operations and compatibility observations for one Agent. These
reads use the existing [lifecycle observation contracts](lifecycle-handler-ports.md)
and [status projector](lifecycle-status-projections.md). They never submit work,
retry a mutation or change runtime state.

The HTTP catalog and handlers consume optional server-owned dependencies: an
original authenticated read call and an authorized lifecycle reader. The server
must verify the current account/session, selected IAM policy and exact Agent-read
permission at disclosure, including after its own waits and on every page.
An actor ID, request header, earlier admission result or TypeScript interface is
not a replacement for that private call or authorization. Installation identity
comes from controller/store custody, never the caller.

Production composition supplies the private request bridge and a bounded
PostgreSQL reader. The original protected Fastify registration mints a one-use
handle for the exact route, Agent and page. It retains the original request's
30-second ceiling and verified session/key expiry, closes on client disconnect
or response completion, and rechecks the actual BetterAuth account/session or
service key and selected native IAM policy before and after the data read.
Authentication uses the primary store with cookie caching and refresh disabled;
a human account must retain its actual local credential relation. Explicit
service-key failure never falls back to a cookie.

The data read uses one read-only transaction, capped at three seconds and bounded
by the same request signal. It reads retained deploy/protective associations,
the current intent, the selected revision and the protected compatibility record.
The existing auth and IAM interfaces have no cancellation argument: those calls
are joined, and an expired or closed request suppresses disclosure after they
return. The read bridge does not claim to cancel those underlying queries.

Runtime observation publication and capability publication remain separate
producers. Without a qualified runtime observation, status and operation reads
retain `NOT_OBSERVED` and unknown outcome conditions; queue success supplies no
serving or stop proof. An absent capability record returns
`503 DEPENDENCY_UNAVAILABLE`. The reader neither creates a legacy record nor
advances compatibility. Full production startup and runtime qualification remain
separate from the focused PostgreSQL/Fastify read checks.

## Requests and envelopes

All paths below use the existing `ns_...` and `agt_...` lowercase UUID-v4 IDs.
Every request is a bodyless `GET` and requires a fresh `read` decision for that
exact Agent. Unknown query fields, caller-selected Installation IDs and authority
fields are rejected.

| Operation                 | Path                                                                          | Query                               | Semantic action                             |
| ------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| Current status            | `/namespaces/:namespaceId/agents/:agentId/lifecycle`                          | Empty                               | `openclaw.agents.lifecycle.read`            |
| Operation discovery       | `/namespaces/:namespaceId/agents/:agentId/lifecycle/operations`               | Optional `limit`, `afterGeneration` | `openclaw.agents.lifecycle.operations.list` |
| Exact operation           | `/namespaces/:namespaceId/agents/:agentId/lifecycle/operations/:operationRef` | Empty                               | `openclaw.agents.lifecycle.operations.read` |
| Compatibility observation | `/namespaces/:namespaceId/agents/:agentId/lifecycle/capability`               | Empty                               | `openclaw.agents.lifecycle.capability.read` |

`operationRef` is an unprefixed lowercase UUID-v4 from an actual retained
operation. It is a locator, not a bearer capability or a work ID. Exact recovery
also verifies the operation's association with the requested Namespace and Agent.

A successful response is HTTP 200 with the closed envelope
`{ "data": <canonical value>, "meta": { "requestId": <request ID> } }`.
The request ID is diagnostic correlation, not proof of an accepted operation.
Lifecycle handler responses use `Cache-Control: no-store`.

Operational reads include only the declared public fields. They exclude actor
and account identities, protected audit details, conversation content,
credentials, protected paths and raw provider errors. A revision ID does not
disclose its document: the existing exact revision endpoint still requires
the applicable Agent and AgentRevision read permissions. Mutation permission
and a mutation receipt do not grant any of these reads.

## Pagination

The URL query uses decimal text because the HTTP transport does not coerce values
or insert defaults. `limit` accepts `1` through `100`; omission selects 20 in the
handler. `afterGeneration` accepts a positive safe integer through
`9007199254740991`. Omit it for the first page; do not send `null`, `0`, a signed
value, a fraction, exponent notation, leading zeros or whitespace. The handler
converts the bounded decimal text into the original numeric/null page request and
validates its safe-integer bounds.

For example, `?limit=20&afterGeneration=7` requests at most 20 operations whose
generations are greater than 7. A page's `data` contains exactly `operations` and
`nextAfterGeneration`. Operations are strictly ordered by increasing generation
within the exact owner scope. Each item has only:

- `operationRef`, `kind`, `revisionSource`;
- `lifecycleGeneration`, `desiredMode`, `acceptedAt`.

Discovery does not include `requestedRevisionId` or observations. A nonnull
`nextAfterGeneration` equals the last returned generation and can be supplied in
the next independently authorized request. It can accompany a short page:
`limit` is a maximum, not a promise to fill the page. A null cursor ends the
returned scan; an empty page or null cursor does not prove that an in-flight
mutation rolled back. No automatic page walk or mutation retry is performed.

## Current status

Status preserves all of the following fields from the canonical producer:

| Field                                               | Meaning                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespaceId`, `agentId`                            | The exact authorized owner scope.                                                                                                                                                  |
| `head`                                              | Null, or the current `operationRef`, `lifecycleGeneration`, `desiredMode` and `requestedRevisionId`. A protective intent before any selected revision may have a null revision.    |
| `requestedRevisionId`                               | Revision requested by the current intent, when one exists.                                                                                                                         |
| `selectedRevisionId`                                | Revision selected by the control plane, when known. Selection alone does not establish serving.                                                                                    |
| `servingRevisionId`                                 | Separately observed serving revision identity, when known. It may describe a prior revision while `serving` is false.                                                              |
| `observedLifecycleGeneration`                       | The generation actually observed, or null. It is not copied from the head to make an observation appear current.                                                                   |
| `phase`, `attempt`, `step`, `reasonCode`, `retryAt` | Closed progress fields and a nullable server retry time. A retry time does not instruct the client to repeat a POST.                                                               |
| `conditions`                                        | Five independent outcome conditions described below.                                                                                                                               |
| `serving`                                           | True only with the current running generation and the required matching revision, runtime, authority, routing and writer evidence. False does not imply termination.               |
| `stopComplete`                                      | True only for the current stopped intent after denial, effective route removal and termination of all affected runtimes, with every possible create resolved absent or terminated. |
| `retention`                                         | `retained`, `verification-pending` or `unknown`; no content, path or purge-completion claim.                                                                                       |

The five conditions are `accessDenied`, `routeRemoved`, `executionTerminated`,
`credentialRevocation` and `stateRetention`. Each contains `status`, `observedAt`,
`recordedAt` and `reasonCode`. Its status is `confirmed`, `pending`, `unknown` or
`not-requested`.

`observedAt` retains the original source observation time, or null when that
source does not provide one. `recordedAt` is the control plane's receipt time,
also nullable where the contract permits. A newer receipt does not refresh older
evidence. Display both times when present and preserve null values. Actual source
provenance and freshness checks belong to the producer; a valid JSON shape or a
recent HTTP response does not establish them.

Disabled intent can converge after new-access denial, effective route withdrawal
and cancellation request while physical termination remains pending or unknown.
Stopped intent requires affirmative physical completion. Credential revocation
and state retention remain separate even when `stopComplete` is true. A missing
runtime response, expired deadline or empty provider listing cannot settle an
unresolved possible create. A no-head status does not establish that legacy
execution is absent.

## Exact operation and capability values

An exact operation response has `data: { operation, observation }`. The immutable
operation includes the discovery fields plus its retained `requestedRevisionId`.
The observation contains `phase`, `attempt`, `step`, `reasonCode`, `retryAt`,
`observedAt` and `recordedAt`. Phase is `pending`, `reconciling`, `blocked`,
`converged` or `superseded`. The closed steps are `observe`, `deny-predecessor`,
`terminate-predecessor`, `prepare`, `activate`, `publish` and `cleanup`.

An old operation can remain readable after head advancement, including a
historical converged or superseded observation. Its historical result does not
establish the current head's serving or stop outcome. Completed controller work
does not by itself supply a runtime observation.

Capability data contains `schemaVersion`, `protocol`, `stage`,
`capabilityVersion` and `supportedConsumerVersions`. The protocol is
`lifecycle-control-v1`; the stage is `legacy`, `drain` or `live`; consumer version
slots are `api`, `worker`, `maintenance` and `receiving`. This is a read of the
server-owned compatibility record. It does not toggle a stage, authorize a
mutation or prove runtime health. Publishing live compatibility requires actual
compatible consumers, retained shutdown where required and exclusion of old
writers. Source exports, a migration or a configuration flag cannot supply those
facts; no fabricated legacy or live record substitutes for an absent publisher.

## Errors and compatibility

Errors retain `{ "error": { "code", "message", "details"? }, "meta":
{ "requestId" } }`, with bounded public messages. The read routes declare:

| HTTP | Code                     | Interpretation                                                                                                              |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST`        | Invalid path, query, body or canonical request.                                                                             |
| 401  | `UNAUTHENTICATED`        | Current authentication is missing or invalid.                                                                               |
| 403  | `FORBIDDEN`              | The current exact read is denied.                                                                                           |
| 404  | `NOT_FOUND`              | Unknown, hidden, foreign or mismatched target; no owner distinction is disclosed.                                           |
| 409  | `NAMESPACE_NOT_READY`    | Preserves an explicit existing source outcome. Reading status does not itself introduce a deployment-readiness requirement. |
| 500  | `INTERNAL_ERROR`         | An explicit sanitized internal failure.                                                                                     |
| 503  | `DEPENDENCY_UNAVAILABLE` | Required call/source missing, unavailable or invalid, or a result suppressed after cancellation or dependency replacement.  |

The separate `POST /namespaces/:namespaceId/agents/:agentId/deploy` requires the
[identified V2 command](lifecycle-deploy-v2.md): a retained `operationRef`, explicit
`expectedLifecycleGeneration` and complete saved-draft expectations, including
the exact workload-profile selection. Its HTTP 202 envelope contains
`data: { disposition: "accepted", operation }` and `meta.requestId`. The operation
has only `operationRef`, `lifecycleGeneration`, `acceptedAt`, `kind: "deploy"`,
`revisionSource: "saved-draft"` and `desiredMode: "running"`; it returns no
AgentRevision document or `data.id` revision locator.

An accepted receipt is not status, discovery or an exact-operation response and
does not grant their current read permissions. Read `requestedRevisionId` through
the authorized exact-operation endpoint; revision documents require their own
Agent and AgentRevision read permissions. Exact committed replay retains the
original command and association and requires fresh original-operand
authorization before today's draft/head comparison. Unknown outcomes do not
authorize a new operationRef or automatic POST retry.

These reads do not supply missing genuine deployment collaborators or enable
public disable/stop/resume handlers. The default deployment composition still
lacks complete profile suppliers. See [lifecycle recovery](../guides/lifecycle-recovery.md)
for the conditional submission procedure and remaining runtime recovery limits.

The [portable sanitized examples](../../tests/fixtures/lifecycle-status-projector-v1/sanitized.json)
are synthetic presentation fixtures, not observed installation state. Schema,
service and controlled Fastify handler checks validate their respective
boundaries; they do not establish a production authenticated reader, complete
controller startup, provider behavior, physical stop or measured recovery latency.
