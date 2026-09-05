# Security events

The contracts package provides a versioned, allowlisted projection for security
events, a strict parser, and audit access and retention predicates. These are
contract helpers for producers and consumers. **Production component emission,
durable storage, export, authentication and retention jobs are not connected by
this module.** The delivery fixtures are an executable specification using a
simulated in-memory disk; they do not prove filesystem durability or runtime
security.

## API and compatibility

Import the following from `@openclaw-enterprise/contracts`:

```ts
import {
  SECURITY_EVENT_SCHEMA,
  SECURITY_EVENT_POLICY,
  projectSecurityEvent,
  parseSecurityEventJson,
  serializeSecurityEvent,
  canReadSecurityEvent,
  canDeleteExpiredSecurityEvent,
} from "@openclaw-enterprise/contracts";
```

`projectSecurityEvent(audit, context)` selects fields from an existing
`AuditEvent` and separately supplied authoritative producer facts. The output
uses `schema: "openclaw.security-event/v1"` and `schemaVersion: 1`. It reuses the
audit envelope's event identity, scope, timestamp, request and decision links;
it does not change the existing `AuditEvent` type, its schema version, or any
existing sink. Arbitrary audit `details`, actor labels, action text, free-form
reasons and authorization objects are excluded. The producer classifies the
actual audited operation into the new closed action and reason vocabularies.

`parseSecurityEvent(input)` validates an already decoded event and returns a
fresh, deeply frozen value. `parseSecurityEventJson(text)` additionally bounds
the input before JSON decoding. Use it at import boundaries with a bounded
request reader. `serializeSecurityEvent(input)` validates again before emitting
JSON. No helper accepts unknown schema versions, unknown output fields or raw
string diagnostics. An incompatible schema change needs a new schema name and
an explicit consumer upgrade; there is no silent version fallback.

A parseable event is **not authenticated evidence**. A consumer must establish
its producer, integrity, delivery and exact scope separately. Imported events
cannot authenticate a user, authorize execution, or establish release acceptance.

## Authoritative inputs and references

The producer obtains `SecurityEventProjectionContext` from its authenticated
request, authorized resource lookup and observed runtime state. It must never
spread a channel event, HTTP body, log record or caller-supplied `verified` flag
into that context. The projection function does not perform those lookups or
verify tokens itself.

The raw audit Installation, Namespace and resource must match the context
exactly. A verified initiating human must match the audit `actorId`. For a
workload-only action, `human.state` is `not_applicable` and the audit actor must
match the verified workload principal. Unresolved human identity cannot be
upgraded into an allowed action by a verified workload. Allowed collaborative
turns require a verified human. Human and workload identity are separate fields;
channel bot credentials do not establish either user's permission.

`context.resolveReference(kind, rawId)` is a trusted, scope-specific lookup. It
returns a canonical lowercase UUID for a previously approved internal reference,
or `undefined` for an unknown or unauthorized value. Each input is bounded to
256 UTF-8 bytes before lookup. The resolver must:

- Verify scope before producing an opaque reference. An unknown URL, token,
  claimed sender or arbitrary label must not allocate a new reference.
- Preserve the same reference for the same entity and event across retries and
  restarts. Resolution keys include the Installation/Namespace/context as needed;
  two tenants must not accidentally share a mapping.
- Map the same Installation or Namespace entity identically when referenced as
  the event scope and as the target resource. Event IDs remain stable across
  retry; a new observed fact receives a new event ID linked by attempt/request.
- Preserve those mappings for the event's retention and deduplication window.
  Do not use credential bytes, URLs, usernames or raw channel/thread text as
  exported identifiers. UUID syntax alone does not prove a mapping is trusted.

The functions reject invalid references and replace resolver errors with
`SecurityEventContractError`, code `SECURITY_EVENT_REJECTED` and the fixed message
`Security event rejected by contract.` No input or original error cause is
included. Log only the fixed code and safe operation label, not a raw caught
error, request, file path or producer context.

## Event fields

All references in the projected record are opaque UUIDs. Timestamps are canonical
UTC ISO strings with millisecond precision. Receipt time must be at or after
occurrence; observation time lies between them. Producers need synchronized
clocks and must diagnose invalid clock state without copying input fragments.

| Field                                                                   | Meaning                                                                                                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `schema`, `schemaVersion`                                         | Stable event identity and independent security-event schema                                                                                               |
| `installationId`, optional `namespaceId`, `resource`                    | Exact target scope; `resource` contains `kind`, `id`, and matching Namespace when applicable                                                              |
| `occurredAt`, `receivedAt`, optional `requestId`, `admissionDecisionId` | Producer fact time, trusted receipt time, and existing request/decision links                                                                             |
| `source`                                                                | `api`, `occ`, `gateway`, `identity`, `credential`, or `runtime`                                                                                           |
| `category`                                                              | `management`, `access`, `credential`, `identity`, `lifecycle`, `dispatch`, or `confinement`                                                               |
| `action`                                                                | Closed operation vocabulary listed below; paired with exact resource and grant references                                                                 |
| `decision`                                                              | `allowed`, `denied`, `not_applicable`, or `unknown`; policy decision is separate from execution result                                                    |
| `phase`, `result`, `reasonCode`                                         | The bounded truth claim described below                                                                                                                   |
| `human`                                                                 | `verified` with `principalId`, `unresolved`, or `not_applicable`                                                                                          |
| `workload`                                                              | `verified` with `principalId`, `assignmentId`, `agentId`, `revisionId` and positive safe-integer `generation`; otherwise `unresolved` or `not_applicable` |
| `correlation`                                                           | Optional `agentId`, `revisionId`, `conversationId`, `channelEventId`, `turnId`, `attemptId`, `grantId`, `policyId`, `registrationId`                      |
| optional `previousRuntime`                                              | Prior assignment and generation for identity replacement; new verified assignment must differ and generation must increase                                |
| optional `credential`                                                   | Credential category only: destination `model`/`github`, mode `mediated`/`native`/`history_isolated`, optional token `expiresAt`; never a token value      |
| optional `observation`                                                  | Observed phase only: `observedAt` and source `controller`, `runtime`, `identity_provider`, `credential_provider`, or `gateway`                            |

Actions are `create`, `read`, `update`, `delete`, `deploy`, `operate`, `administer`,
`issue`, `use`, `register`, `rotate`, `replace`, `expire`, `disable`, `revoke`,
`stop`, `admit` and `cancel`. The emitter must select the actual operation and
resource. A broad management permission such as `operate` must not conceal a
more specific known operation such as `stop`.

Reasons are `Authorized`, `AccessDenied`, `IdentityUnresolved`, `WrongScope`,
`StaleGeneration`, `IdentityRegistered`, `IdentityRotated`, `IdentityReplaced`,
`PolicyRejected`, `CredentialAllowed`, `CredentialDenied`, `RequestReceived`,
`DurablyAccepted`, `Serving`, `Disabled`, `StopUnconfirmed`, `Stopped`,
`ProviderConfirmed`, `Expired`, `RuntimeUnreachable`, `Queued`, `Busy`, `Duplicate`,
`Interrupted`, `AuditUnavailable`, `ResourceLimitExceeded` and `Unknown`.

A missing optional reference means the fact is unavailable or does not apply;
it never implies authorization, completion or a wildcard scope. Producers omit
unavailable correlation rather than inventing an ID. The explicit attribution
states distinguish unknown identity from work with no initiating human/workload.
Verified workload attribution describes authenticated identity, not an allow
decision; a correctly authenticated retired generation can still be denied.

Namespace is mandatory for non-Installation targets. An Installation target has
no Namespace and must equal `installationId`; a Namespace target must equal
`namespaceId`. A verified workload must match the Agent/revision in correlation.
Conversation/turn/channel-event correlation requires a Namespace, Agent and
conversation; dispatch additionally requires the accepted channel-event
reference. The trusted producer must authorize that conversation before emitting
its reference. Denials before mapping may use an access event without conversation
correlation, rather than copying attacker-supplied routing labels.

A completed identity replacement includes `previousRuntime` and the new verified
assignment/generation. Rotation within an existing assignment does not falsely
claim a generation change. Model credentials use the mediated mode. Optional
repository modes in this enum are vocabulary, not implemented-mode claims.
Credential allowances require a verified workload plus exact grant and policy
references, including when no human initiated the background operation.

## Acceptance and observation

| Phase       | Allowed results                                                                           | Meaning                                                                    |
| ----------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `requested` | `pending`                                                                                 | A request was received; no durable admission or remote effect is implied   |
| `accepted`  | `pending`, `queued`, `duplicate`                                                          | The owning component durably accepted the relevant local operation/receipt |
| `observed`  | `completed`, `denied`, `failed`, `busy`, `duplicate`, `interrupted`, `revoked`, `expired` | The named source observed this fact at the supplied time                   |
| `unknown`   | `unknown`                                                                                 | The producer cannot establish the result; no observation is fabricated     |

An authorization denial has decision/result `denied` and an observed policy
result; this does not require a remote effect. An existing audit `success` alone
cannot create an observed completion: the new phase and observation come from
the owning component's authoritative facts. An existing audit denial cannot be
projected into an allowance.

Stop completion requires reason `Stopped` and a runtime observation. Accepted
stop cannot use a completed reason. `StopUnconfirmed` is an unknown stop result;
runtime unreachability never establishes shutdown or deletion. Native token
revocation uses `revoked` only with `ProviderConfirmed` from
`credential_provider`; lack of confirmation is `unknown`. Observed expiry uses
credential action `expire` or `revoke`, result `expired`, reason `Expired`, and a
required expiry timestamp no later than observation. Both actions reject an
absent or future expiry timestamp. The reasons `Expired` and `ProviderConfirmed`
require their corresponding terminal results; they cannot describe a failed
operation. `Disabled` requires a completed lifecycle `disable` action.
Expiry records cessation of token validity, not cancellation of earlier effects
or provider-confirmed revocation. There is no unconditional off-sandbox
revocation deadline in this contract.

Duplicate deliveries with the same `id` and canonical serialized content are
one event. A different payload reusing an ID is an integrity conflict, not a
new action or an update. Requested, accepted and observed facts use distinct
IDs and shared request/attempt correlation. Persisting an event never proves
an external tool or provider operation completed.

## Selected contract policy

These are explicit **v1 contract and fixture requirements**, not deployed
configuration or measured capacity. Component integration must implement and
verify them or obtain a reviewed versioned policy change before claiming this
profile. No human approval or production qualification is implied by these
constants.

| Limit                     | Selected requirement                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Encoded event             | At most 8,192 UTF-8 bytes; no truncation of identities or scope                                              |
| Raw reference input       | At most 256 UTF-8 bytes before trusted resolution                                                            |
| Record structure          | Fixed allowlist with at most six object levels; no recursive details or arrays in events                     |
| Durable local spool       | At most 10,000 events **and** 64 MiB serialized payload; reject when either limit is reached                 |
| Local append deadline     | 2,000 ms; timeout is an unknown commit state, never an acknowledgement                                       |
| Export batch              | At most 100 events                                                                                           |
| Automatic export attempts | Five total, with waits of 1, 2, 4 and 8 seconds; preserve attempt count across restart                       |
| Retention                 | 30 days from trusted receipt time in local audit and exported copies                                         |
| Deletion sweep            | Remove eligible records within a further 24 hours; expired pending evidence produces a visible loss incident |
| Reader/retention grants   | At most 64 grants, each with at most 128 exact context references                                            |

### Mandatory delivery and responsibility

All security categories above are mandatory when their underlying operation
occurs. Diagnostic/debug records use a separate best-effort path and cannot
substitute for mandatory evidence.

1. The producer projects and validates before persistence or export. It owns the
   obligation and stable event ID until the local sink acknowledges a successful
   atomic durable append. The selected integration target is a protected local
   durable audit store/spool; its actual implementation and filesystem remain a
   downstream choice and require crash tests.
2. **The transfer point is the durable commit, acknowledged only after all bytes
   and required index/transaction metadata are committed.** An enqueued item,
   write call, buffered flush, exporter send, or remote connection is insufficient.
   The sink owns export/recovery after commit. On an ambiguous acknowledgement,
   the producer conservatively retains its obligation and retries the same event
   ID; both sides must tolerate this overlap.
3. An unavailable/full/slow local sink denies new grants, credential issuance,
   dispatch and privileged mutations before granting new authority. When those
   changes share a database transaction, commit state and the mandatory event
   together. Do not perform the external action and then retroactively present
   an audit failure as a denial.
4. Disable, revoke, stop and other actions that reduce authority must continue
   even when the audit sink is unavailable. Their owner retains the event
   obligation in existing durable operation state when possible, exposes
   `AuditUnavailable` and unknown/missing-evidence status, and retries within
   declared bounds. If all durable state is unavailable, continue the safe
   restriction, raise a visible incident and report the evidence gap; do not
   manufacture successful delivery or a passing acceptance result.
5. An exporter outage uses the committed local spool. Retry at the selected
   bounded schedule. After five failures, quarantine export with visible health
   and pending counts; operator recovery can explicitly resume it after repair.
   Restart must not reset the retry ceiling. Backpressure is local and scoped:
   an unrelated working Namespace need not freeze if its storage can still
   durably acknowledge its own mandatory events.
6. Recover committed frames/index state on reopen. Discard or quarantine only
   incomplete uncommitted tails without resetting valid history. Retry remote
   acknowledgement loss with the same identity. Consumers deduplicate by
   Installation/event ID and compare canonical content. Do not replay tool
   actions because an audit receipt is missing.
7. Expose bounded counters for pending/quarantined/lost records and append/export
   failure. IDs belong in authorized events, not high-cardinality metric labels.
   Missing or expired mandatory evidence disqualifies the affected acceptance
   case. Best-effort debug drops alone need not halt safe operation.

The synthetic delivery model tests committed-frame preservation, ambiguous
acknowledgement, partial-write-before-commit, duplicate conflict, count/byte
capacity, exporter outage and retries across simulated reopen. It does not run
an actual clock deadline, fsync, database transaction, filesystem, power-loss
recovery or durable producer outbox. Those remain required integration evidence.

### Audit access and retention

`audit_reader` grants read only the exact Installation/Namespace and listed
conversation contexts. An Installation-scoped grant does not imply Namespace
access. Namespace events with no conversation require the Namespace grant;
conversation events additionally require that exact context ID. Ordinary
participant/operator access does not implicitly grant audit access.

`audit_retention_admin` permits deleting expired records under the same exact
scope/context rules and does not grant read access. `canReadSecurityEvent` and
`canDeleteExpiredSecurityEvent` are predicates over **already authenticated,
server-owned grants**. They do not authenticate principals, query IAM or create
production roles/routes. Consumers must validate current grants at use, including
revocation, and apply the same filters to errors, counts, exports and pagination.
Wrong-role/scope and credential-bearing error paths return denial without raw
error content. The server enforces writer credentials and a category/source
allowlist; audit readers cannot append or rewrite events.

`isSecurityEventExpired` is eligibility only. Trusted receipt time starts the
30-day window; only an authenticated retention administrator/sweeper may delete
expired data. The sink, exporter, artifact storage and backups need aligned
retention and authorized cleanup. No indefinite retention or automatic legal
hold is selected here. A required hold/export exception needs explicit operator
policy outside this default profile. Expired unexported records must not remain
silently forever: purge within the additional 24 hours, increment a
mandatory-evidence-loss incident, and keep the affected verification case failed.
The synthetic purge model does not prove external erasure or backup deletion.

## Redaction and diagnostic boundary

The projection excludes authorization/cookie headers; all token values,
including short-lived repository tokens; SVIDs/private keys; URLs and their
userinfo/path/query; arbitrary nested properties; raw exceptions/provider
bodies; prompts, transcripts, tool output and file content. None belongs in this
schema. All output text is a closed enum, canonical timestamp or trusted opaque
reference. Pattern-based token replacement is not the security boundary.

Canary fixtures include apparently benign input fragments and log-injection
characters, not just strings resembling credentials. Ignored payload objects
are never traversed, including deep/recursive properties and getters. Invalid
selected fields fail with constant diagnostics. No test should print the
rejected input in an assertion failure or collected artifact.

Startup diagnostics have a separate implementation in the launcher/loader
paths. Their contract is compatible: fixed safe codes and operation labels;
no arbitrary message, cause, excerpt, path, context name, cluster URL or benign
input fragments. Preserve nonzero startup failure, explicit context validation
and verified TLS. This module neither modifies nor substitutes for testing those
actual paths.

## Emitter responsibilities and verification handoff

| Producer                        | Authoritative facts and fixture cases                                                            | Integration still required                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| API/OCC authorization           | `management-change`, `access-allowed`, `access-denied`; exact resource/action and verified human | Actual IAM/account/channel denial events and transactional mutation append                                     |
| Gateway collaboration           | `turn-accepted`, `turn-queued`, `turn-busy`, `turn-duplicate`, `turn-interrupted`                | Native authenticated Slack and Teams ingress; durable turn ownership, audience checks and routing              |
| Credential mediator             | `credential-allowed`, `credential-denied`, all `revoke-*`                                        | Actual workload authentication, grants, model/repository operation, native provider revocation/expiry evidence |
| Identity component              | `identity-register`, `identity-rotate`, `identity-replace`, `stale-generation-denied`            | Actual attestation, trust-domain/assignment checks, retirement, renewal/expiration and outage tests            |
| Lifecycle/runtime               | All `disable-*`, `stop-*`, `confinement-denied`                                                  | Actual admission/enforcement, observed disable/stop, failed observation and workspace retention                |
| Audit delivery/operations       | Synthetic delivery, access and retention tests                                                   | Selected sink, reader/writer authorization, exporter, failure health, bounded recovery and actual deletion     |
| Diagnostics/artifact collectors | Canary projection and constant-error tests                                                       | Real startup, log, metric, export and release-artifact surfaces under hostile input                            |

Run the focused synthetic contract suite with Node 24:

```sh
node --test tests/integration/security-events-contract.test.mjs
```

It exercises the real projection/parser/predicates and explicitly labeled
synthetic delivery model. Its pass does not establish live identity, runtime
containment, model calls, Slack/Teams operation, token revocation, persistent
storage reliability or release readiness. Record each subsequent real test's
source/schema/fixture hashes, environment prerequisites, exact commands,
pass/fail/skipped counts and evidence gaps separately.
