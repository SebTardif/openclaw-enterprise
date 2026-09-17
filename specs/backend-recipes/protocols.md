# Protocol and admission requirements

**Status: Proposed.** Requirement IDs extend the [RFC](README.md).

## Bound records

**D-01 — Records.** Core MUST retain these immutable identities:

| Record     | Required fields                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definition | Recipe/version/digest, closed schema identities and exact capability tuples.                                                                            |
| Connection | Canonical upstream instance, immutable configuration generation, admitted services/endpoints/trust/audiences and protected source or broker references. |
| Grant      | Requester, genuine Work/Agent execution, canonical resource, operations, limits and finite lease.                                                       |
| Attempt    | Original request/facts digest, definition/connection/executor identities, admission decision, observations and cleanup obligations.                     |

**D-02 — Authority binding.** Core MUST derive and authenticate this immutable
binding from real ownership and registered facts; IDs alone are insufficient.
Its canonical digest MUST include every field:

| Group     | Fields                                                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor     | Installation/Namespace; requester/service principal; Work/ancestors and original ceilings/horizons; Agent/revision; assignment incarnation/generation; grant/lease; selected IAM instance/configuration generation.                                                                                |
| Operation | Definition/schema version; connection generation; canonical upstream instance/resource/credential authority; service/audience/receiver; operation and mapped IAM action/resource; authentication profile; input/facts digest; original attempt/inspection reservation; required original PR claim. |
| Bounds    | Authority/request deadlines, allowance/capacity units, revocation/withdrawal profile. Trusted owner time; caller values may only narrow limits.                                                                                                                                                    |

## Authorization and submission

**A-01 — Companion ports.** Preserve `IAMDriver`; require a reviewed companion
owned by its selected implementation. Unsupported companions MUST deny the profile.
Recipes/clients MUST NOT supply authorization callbacks or access evidence handles.

The [named companion ports](interfaces.md#owner-reference) are
`SelectedIamAdmissionOwner.prepare/consumeIn` and `WorkAdmissionOwner.checkIn`;
`uow` is the existing `PlatformUnitOfWork`.

- **A-02 — Evidence.** The trusted owner MUST retain the full binding digest,
  decision, policy/selection generation, observation mode/time/cursor and finite
  expiry behind an authenticated one-use local handle. Require finite retention
  and active-handle bounds at startup. Expiry, failed admission, restart or owner
  replacement MUST discard it. Serialization, imitations, another instance or audit
  IDs MUST NOT reconstruct authority.
- **A-03 — Effect ordering.** Acquisition, exchange, refresh and resource dispatch
  MUST each own an original attempt and current-authority admission before
  submission. Resource dispatch MUST obtain fresh evidence after authentication
  preparation. Material MUST have a known State retention commit before use;
  capture alone is insufficient. External IAM calls MUST finish before the local
  admission transaction.
- **A-04 — Native fence.** `prepare` MUST hold an Installation-wide shared fence
  throughout coherent policy, selection and monotonic-epoch capture; issue evidence
  only for an allowed exact binding. Every relevant identity, membership, group,
  role, binding, restriction, policy-configuration, import/bootstrap and IAM-selection
  writer MUST lock exclusively and advance the epoch within its mutation.
  `consumeIn` MUST lock shared through commit/rollback, read current locked epoch
  and selection generation, compare evidence, verify binding/expiry and spend the
  handle. Stale snapshots, conflicts or unavailable current reads MUST abort.
  Replacement MUST commit durable selection generation before activation; every
  stale gateway instance MUST deny. Process-local activation or version equality without
  the writer protocol is insufficient.
- **A-05 — Local transaction.** For new work, the existing State UnitOfWork MUST
  consume IAM evidence and check actual Work ownership, open Work and ancestors,
  original ceilings/horizons, current assignment/execution, lease, local revocations,
  selected configuration,
  connection generation and authentication binding. Atomically consume original
  inspection reservations, reserve aggregate capacity, record dispatch/closure
  and audit. Consume a required original PR claim only at resource dispatch,
  never credential acquisition. Relevant mutations MUST share locks/conditional
  transitions; adapters MUST NOT omit conditions or supply allow predicates.
- **A-06 — External IAM.** Require an online exact-dispatch decision, authenticated
  issuer/request binding, documented observation point, finite maximum observation
  lag, decision-to-send interval, local enforcement/propagation delay, clock
  allowance and withdrawal contract. Deadline MUST derive from observation plus
  the interval, capped by local horizons. Advertise only supported combined
  withdrawal bounds; retain provider policy/version evidence only when supplied.
  Local admission MUST check deadline, selected owner and latest observed
  withdrawal. Missing/ambiguous evidence, timeout, required-currentness outage or
  unsupported bounds MUST deny. No default offline grace, TTL-manufactured validity
  or claimed SQL atomicity with independent external policy. Observation-only
  evidence MUST NOT satisfy policy equality at later submission.
- **A-07 — Gate and uncertainty.** Only known successful admission commit creates
  a permit. After asynchronous preparation, the trusted gate MUST synchronously
  check exact receiver, expiry and latest local withdrawal, consume permission
  once and immediately submit. Later changes fence future admission/withdrawal;
  they cannot recall submitted effects. Unknown commits MUST retain original intent
  without reconstructed permits. Possible submissions MUST retain observed/unknown
  outcomes; concurrent requests, restart, profiles and backends MUST NOT replay
  ambiguous effects.
  Finalization MUST survive cancellation; [L-05](interfaces.md#lifecycle-requirements)
  governs cleanup after closure.

## External broker requirements

**Future enablement, outside the recipe MVP.** X-01–X-07 remain mandatory for any
remote implementation. Initial activation MUST reject remote tuples before effects;
positive remote acceptance belongs to [T-03](conformance.md#before-remote-enablement).

- **X-01 — Isolation and credentials.** Custom executable code MUST run outside
  OCE in a separate workload/identity with restricted networking, resource limits
  and independently provisioned narrow credentials; no OCE State/secret-store
  access, sensitive shared volumes or blanket root/signing-key handoff. Same-Pod
  sidecars require separate isolation assessment. A compromised broker can exercise
  its credentials' full upstream scope independently of grants; process separation
  neither attenuates that authority nor removes RPC/parser risk. OCE credential
  delegation requires qualified protected delivery to the exact broker, upstream
  resource/operation/audience/lifetime enforcement and retained lifecycle obligations.
- **X-02 — Transport.** Use versioned HTTPS, mutual service authentication, admitted
  fixed endpoints/peer trust and authenticated OCE caller/tenant on every method.
  Bind service, destination policy, audience and connection generation; reject
  unadmitted routes/redirects. No arbitrary proxy, callbacks, executable payloads
  or broker-selected OCE endpoints.

**X-03 — Future wire contract.** The proposed `remote-broker-v1` MUST implement:

| Method/value                | Required contract                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute(admission, input)` | Core-derived D-02 binding plus original admission, broker registration generation, schema/definition versions, destination and finite byte/request ceilings; registered closed input schema/digest.                         |
| `inspect(attempt)`          | Passive original-attempt observations; no acquisition, refresh, replacement permits or replay.                                                                                                                              |
| `cancel(attempt)`           | Idempotent request; `prevented` requires a durable tombstone defeating delayed execute delivery. After possible dispatch, report requested or too-late/unknown, never rollback.                                             |
| Attempt reference           | Durable owner/original-registration-authenticated lookup; not bearer authority or serialized local handles. Gates, custody and original-instance callbacks stay local.                                                      |
| Observation                 | Version, original attempt, request digest; state `accepted/running/settled/unresolved`; effect `not-submitted/observed/unknown`; cancellation `none/requested/prevented/too-late-or-unknown`; optional registered evidence. |

- **X-04 — Delegated closure.** OCE MUST atomically admit delegation against closure,
  capacity and original claims. Its final gate covers only RPC submission; remote
  preflight MUST NOT claim to gate later upstream use. Admitted attempts may finish
  after local closure. Closure MUST stop new delegation and request cancellation.
  Brokers MUST check deadlines before effects; deadlines/cancellation/expiry MUST
  NOT prove upstream nonexecution or revocation.
- **X-05 — Durable dispatch.** Replicas MUST share deduplication keyed by authenticated
  owner, registration and original attempt with exact digest. Duplicates return
  retained state; conflicts fail. Atomic accepted-to-dispatch selects one winner;
  only its known committed decision permits sending. Losing/uncertain/recovered
  contenders MUST NOT reconstruct authority. Missing records, lost replies and
  partitions MUST NOT prove non-submission. Retain dedupe/tombstones beyond validity,
  delivery and recovery windows; unsupported recovery or unbounded clock uncertainty
  MUST deny. This provides at-most-once dispatch decisions, not exactly-once effects.
- **X-06 — Results.** Reject unknown versions/fields/tuples, oversized schemas/data,
  wrong attempt/digest bindings and illegal transitions. Ignore authority expansions;
  retain minimal registered evidence, never raw provider errors. Authentication/schema
  validation MUST NOT prove arbitrary text secret-free or replace required provider
  evidence. Keep remote acceptance, upstream observation and known OCE receipt
  commit distinct; apply L-04/L-05 to remote retirement and unknowns.
- **X-07 — Streams.** JSON-only `remote-broker-v1` MUST NOT perform native Git
  fetch/push or derived downloads. Optional `git-stream-v1` requires authenticated
  attempt framing, owned capture/digests, aggregate byte/time limits, backpressure, finite cancellation,
  completion and unknown-push semantics. Return bytes, never arbitrary fetch URLs;
  delegated streams retain X-04.

## Protected children

Implement this bridge only for an actual future backend requirement. Until then,
unsupported profiles MUST deny before child requests or capability disclosure.

- **C-01 — Custody.** Signed download capabilities MUST enter protected custody from an
  authenticated parent response; exclude them from ordinary recipe/result values,
  locators, cursors, logs, evidence and Agent custody. Deliver content bytes.
  Bind the protected capability to the original parent attempt, authentication,
  grant/resource, admitted destination and observed expiry.
- **C-02 — Child admission.** Each OCE-mediated range, retry and redirect MUST own
  durable intent, fresh admission, one-use gate and final currentness checks under
  minimum parent/grant/source/capability validity and aggregate byte/request/time
  limits. Bind each child's permitted method, object and range to that retained
  parent/capability. Admit redirect destinations separately without automatic credential
  forwarding. Remote mediation requires a qualified authenticated durable-reference
  bridge; missing bridges MUST deny before effects or capability disclosure.
