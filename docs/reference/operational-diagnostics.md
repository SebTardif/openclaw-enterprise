# Operational diagnostic records

The controller's `createOperationalDiagnosticsV1` adapter submits bounded
operational copies of canonical lifecycle read values and projected security
events to the existing OCC Pino logger. It preserves the source's generation,
attempt, reasons and timestamps. It does not read state, authorize a caller,
publish lifecycle observations or append mandatory security evidence.

The adapter is available for composition; production lifecycle routes and
component emitters are not connected to it by this change. Existing local
container logs and the optional Collector/backend remain the operator surfaces.
There is no new log-query API, audit reader, dashboard or application metrics
endpoint. See the [observability procedure](../guides/observability.md).

## Call from the owning composition

Import the adapter from
`apps/controller/src/diagnostics/operational-diagnostics-v1.ts`. Construct it once
with the composition's existing `OccLogger`; that type is the original Pino
`Logger` alias. The adapter imports the Pino type directly, avoiding unrelated
controller/SDK module initialization.

```ts
const diagnostics = createOperationalDiagnosticsV1(logger);
const result = await reader.readStatus(scope, currentReadCall);
if (result.kind === "read") {
  const submission = diagnostics.emitLifecycleStatus(scope, result.value);
  // Retain the original read result. Submission reports only local log calls.
}
```

The real reader owns current authentication, Installation custody, exact Agent
authorization and hidden/foreign-resource behavior on every call. A parsed DTO
or a previous read grants no access. The canonical sanitizer/reader wrapper does
not implement those real account, IAM or repository checks. Failed or hidden
reads must not become target-bearing diagnostic records. Their original
authorization-denial audit path remains responsible for its own evidence.

`emitLifecycleOperation(request, operationStatus)` accepts an already authorized
historical read. The request supplies exact Namespace/Agent scope; the canonical
decoder checks the operation reference. The reader still owns historical
ownership and visibility. Logging neither resumes work nor retries a mutation.

`emitSecurityEvent(event)` accepts an already projected `SecurityEventV1`.
Its producer supplies authentic facts and scoped reference resolution before
this call. The [security-event contract](security-events.md) owns semantics,
mandatory append, access and retention. This best-effort copy does not discharge
the producer's durable evidence obligation. The legacy audit append is unchanged.

## Records and correlation

All records carry `diagnosticSchema: "operational-diagnostics/v1"`. Each payload
is bounded to 8,192 UTF-8 bytes before the existing logger envelope; over-limit
or invalid inputs are rejected without truncating identities or writing partial
groups. There are at most six fixed records per invocation.

| Event                   | Transported facts                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `diagnostics.lifecycle` | Exact Namespace/Agent; nullable head operation, desired mode and generation; requested, selected and serving revisions; observed lifecycle generation; attempt, phase, step, reason and retry time; original serving, stop-complete and retention values |
| `diagnostics.condition` | Same operation/generation/attempt correlation; one of access denial, route removal, execution termination, credential revocation and state retention; original status/reason and its observation/recorded times                                          |
| `diagnostics.operation` | Exact authorized request scope, historical operation reference/generation/kind, requested revision, accepted time and original observation phase/step/attempt/reason/retry and source/recorded times                                                     |
| `diagnostics.security`  | Existing event identity, scope and available Agent/revision/attempt/request/assignment/generation correlation; closed source/category/action/decision/phase/result/reason and occurrence/receipt/observation times                                       |

No aggregate source timestamp is invented for lifecycle status. A condition's
`observedAt` describes its source fact and `recordedAt` describes receipt. Null
times remain null locally and unavailable remotely. A later receipt or Pino/CRI
timestamp does not refresh a stale observation. Requested, selected and serving
revisions stay distinct; access denial does not establish termination or token
revocation. Historical operations remain historical after a newer head.

Lifecycle values have no Installation field; the adapter does not invent one
from a request label. Actual Installation custody remains with the reader.
Security events retain their existing Installation ID. Correlation locators do
not establish permission or authenticated resource identity.

The projection excludes arbitrary details, actor/account material, conversation
contents and identifiers, headers, credentials, provider bodies, file content and
raw exceptions. Blocked lifecycle summaries, unknown conditions and
denied/failed/unknown security results use warning severity; other records use
info. Existing logger levels may suppress either. Severity is a diagnostic
choice, not a lifecycle state or authority decision.

## Local submission and downstream failure

Calls return immutable counts for `submitted`, `suppressed`, `failed` and
`rejected`, plus a fixed failure code or null. Submitted/suppressed/failed count
records; rejected counts invalid input groups. `downstreamDelivery` is always
`unobserved`. A normal Pino return does not prove an asynchronous write, flush,
durable commit, Collector acceptance or remote receipt. Destination backpressure
cannot be interpreted as delivery success.

`localSubmissions()` returns process-lifetime aggregate counters with saturation
at `Number.MAX_SAFE_INTEGER`. The most recent failure code remains visible after
later successful calls; those calls do not prove downstream recovery. It contains
no resource IDs and is not a per-tenant metric or live sink-health check. There
is no queue, automatic retry or recursive failure log. Synchronous failures
return `LOCAL_LOG_SUBMISSION_FAILED` without the caught error. Invalid input
returns `INVALID_DIAGNOSTIC` before any part of its group is submitted.

Use existing protected Collector error logs and metrics for downstream failure,
refusal and queue pressure. Compare `otelcol_exporter_queue_size` with
`otelcol_exporter_queue_capacity`; inspect failed exports and refused records.
Local submission and process health alone do not prove remote receipt. Collector
outages remain best-effort operational loss and cannot replace or alter the
mandatory security-evidence policy for new authority or protective operations.

## Collector mapping and access

The shared Collector accepts these four names with the exact diagnostic schema
from its existing OCC API/worker transport classes. Closed scalars become
`diagnostic.*` log attributes alongside existing `occ.agent.id`,
`occ.namespace.id`, `occ.revision.id` and `request.id` correlation mappings. It
drops unapproved JSON fields and uses only the event name as the remote body.
Transport-derived service/container identity and Engine/CRI time stay separate.

Source times become `diagnostic.observed_at`, `diagnostic.recorded_at`,
`diagnostic.occurred_at`, `diagnostic.received_at`, `diagnostic.accepted_at` and
`diagnostic.retry_at` when supplied. Observation/recorded availability attributes
are derived from retained timestamp attributes, not claimed input booleans.
Status summaries have no aggregate observation time. This is format/allowlist
filtering, not canonical lifecycle validation or producer authentication.

Existing queue, retry window, credentials, isolation and storage settings are
unchanged. The Collector is not the mandatory security-event spool. IDs never
become metric labels or authority. Restrict local logs and remote backend access
separately; Agent status permission does not grant audit/context/log retrieval.
Actual `audit_reader` resolution, pagination/export authorization, durable event
delivery and retention/erasure remain separate implementations.

## Verification and remaining integration

Run the focused actual-Pino tests with Node 24:

```sh
node --test tests/conformance/operational-diagnostics-v1.test.mjs
```

Lifecycle cases consume the original canonical
`tests/fixtures/lifecycle-status-projector-v1/sanitized.json`; they explicitly skip
if that fixture has not been integrated. An independently reviewed fixture may
be selected with `OCC_TEST_LIFECYCLE_DIAGNOSTIC_FIXTURES` and its exact
`OCC_TEST_LIFECYCLE_DIAGNOSTIC_FIXTURE_SHA256`. Explicitly selected missing,
oversized or hash-mismatched input fails. Fixture coverage proves data transport,
not an authenticated reader or provider result. The compiling consumer uses the
original ports and rejects treating a mutation receipt as status.

`tests/integration/logging-collector.test.mjs` adds adapter-produced records,
source-time mapping, canary filtering and exporter outage/queue recovery to the
existing actual-Collector fixture. It requires `OCC_TEST_LOGGING_COLLECTOR=1`,
the separately prepared original Collector environment and canonical fixture.
These cases create real local containers and are not run by the pure suite.
Authored integration cases are not runtime validation.

| Producer or consumer       | Current boundary                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Canonical lifecycle values | Existing contracts and owner-supplied fixtures; real current-authorized source/route hookup remains separate     |
| Security-event families    | Original projection/scenarios consumed; authentic emitters and mandatory append are not installed here           |
| Local Pino destination     | Actual library exercised with bounded capture, suppression and throwing/backpressured destinations               |
| Collector/backend          | Mapping and real-fixture tests authored; actual execution must be recorded separately                            |
| Retrieval and retention    | Existing protected operator procedures; no new product reader, role implementation, durable spool or erasure job |

Actual lifecycle/provider observations, current read authorization, installed
emitters, remote export and audit delivery/access/retention evidence remain
necessary for full diagnostic integration. Browser presentation and operator
procedures remain with their existing consumers.
