# Security event delivery, access and retention

[Back to security events](../security-events.md).

Apply the [event schema and authoritative-input contract](../security-events.md) before persistence or export. This chapter defines the selected v1 policy and outstanding component integration evidence.

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
