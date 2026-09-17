# Credential Broker Operations and Recovery

Draft supporting specification for [RFC 0034](../0034-github-app-credentials.md).
See the [series index](../README.md) for scope and the other contracts.

## Broker operations

These required local ports may adapt existing methods without adding another authority or inventory store.

| Operation           | Required input                                                                                                                                                     | Result and behavior                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginAccess`       | Authenticated admission context; original work/preparation reference; exact `admittedAccessRef`, requested scope ceiling and execution binding; stable request ID. | Resolve authoritative records, check current authority, commit the authorized ceiling and unique lease binding, and return an opaque reference and deadline.                                                         |
| `renewAccess`       | Same original binding, lease reference, expected version, stable request ID.                                                                                       | Recheck authority and conditionally advance version/deadline within every configured original horizon. Preserve principal, purpose, resources, mode, and incarnation. Closed leases cannot reopen.                   |
| `acquireCredential` | Authorized operation, open access lease/version, enforcement evidence, exact provider-typed grant.                                                                 | Select an eligible recorded credential or run the durable issuance protocol. Deny when required current online authority is unavailable. Return a protected reference to the trusted delivery/forwarding owner only. |
| `deliverNative`     | Current original authority, exact recorded credential and lease, immutable receiving child/channel, delivery ID.                                                   | Require admitted native mode and durably committed delivery intent before release on that exact channel. Return safe delivery status separately from issuance status.                                                |
| `authorizeUse`      | Current online authority, original work binding, access lease/version, validated provider operation and request digest.                                            | Authorize one mediated dispatch; the trusted protocol adapter uses protected credentials. It cannot expose an arbitrary signing or forwarding endpoint.                                                              |
| `closeAccess`       | Exact lease/version and authenticated lifecycle/cancel authority, cause, operation ID.                                                                             | Commit terminal closure and cleanup obligations. Return local closure status separately from provider revocation and execution termination.                                                                          |
| `readStatus`        | Authorized reader and exact operation/lease reference.                                                                                                             | Return safe state and evidence metadata. Readback cannot authorize another provider attempt.                                                                                                                         |
| `listOutstanding`   | Existing management authority for the original ownership scope, binding/resource filter, bounded page size and snapshot cursor.                                    | Enumerate unresolved records, including tombstones, without exposing protected material or requiring the deleted resource to exist. Read authority grants no cleanup effect.                                         |

### Management and status

The accepting authority creates current-authorization context; caller fields or type brands cannot establish it. Management, workload-use, read, and cleanup capabilities are distinct.

Management status includes original ownership, safe operation IDs, blocked scope, cause, evidenced/unproven expiry, last/next cleanup attempt, and authority/evidence needed to resolve a hold. This management path and custody responsibility survive resource deletion.

### Operation results

Every mutation and effect requires a stable request/operation ID and immutable intent digest; updates require expected record versions. Results use this closed family:

| Result          | Meaning                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`            | Known committed operation, resulting version, and method-specific safe result. Protected references go only to the authorized local consumer.                     |
| `denied`        | Current authority or profile forbids this call; no new effect is admitted. Existing obligations from earlier calls remain.                                        |
| `conflict`      | Request ID reused with different intent, or a new update names a stale version; no new effect is admitted.                                                        |
| `unavailable`   | A dependency is unavailable and evidence proves this call admitted no effect.                                                                                     |
| `indeterminate` | An identified provider, commit, or delivery phase may have acted. Return its original operation reference and safe known state for reconciliation; do not replay. |

### Lease identity and retries

The unique access-lease key is:

```text
(Namespace, original work or preparation operation,
 execution assignment/generation, broker binding, admittedAccessRef)
```

`admittedAccessRef` identifies an OCC-owned immutable grant, never a caller alias or profile name. Repositories sharing a profile still require distinct references and leases.

- Look up identical operations before comparing expected versions. Lost begin/renew responses read known results under fresh authority.
- Changing an immutable binding or scope ceiling conflicts even with a new request ID for the same lease key.
- Renewal changes only the permitted deadline/version; recheck current effective scope separately.
- Readback returns known version/state, `unresolved`, or `not-found`. `not-found` does not prove that no earlier effect occurred.
- Listing uses a stable snapshot and records late obligations separately to prevent omissions during concurrent cleanup.

## Issuer interface

Each issuer exposes a fixed versioned profile and these ports. Broker calls are authorized and bounded; issuers cannot broaden accounts or grants.

| Port                    | Contract                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities`          | Declares the provider-typed scope schema, fixed or requested lifetime semantics, individual/broader/unsupported revocation, observation support, and any evidenced idempotency behavior. A declaration is not qualification.                                  |
| `issue`                 | Takes the recorded issuance/provider-attempt IDs and intent digest, exact binding/profile generation and authorized effective scope within the lease ceiling, protected material capability, current one-operation permit, deadline, and cancellation signal. |
| `revoke`                | Takes the exact issued record and protected revocation capability, recorded cleanup claim/provider-attempt IDs, independently authorized cleanup responsibility, deadline, and cancellation signal.                                                           |
| `observe`, if supported | Reads an exact earlier operation or credential's outcome under bounded read authority, without repeating its effect.                                                                                                                                          |

### Issuer outcomes

`issue` returns one of:

| Result           | Required evidence and handling                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issued`         | Protected credential/revocation references, returned scope, actual expiry or an explicitly supported expiry classification, and bounded provider evidence. |
| `not-dispatched` | Evidence that no request crossed the provider boundary.                                                                                                    |
| `rejected`       | Definitive evidence that the provider created no credential.                                                                                               |
| `unknown`        | The provider may have created a credential. Retain available protected material and evidence without enabling use.                                         |

`revoke` returns `confirmed`, `pending`, `unknown`, or `failed`, with evidence and a safe reason. Declare unsupported revocation before profile admission. `observe` returns evidence or explicit unresolved status. Aborts and exceptions do not prove that the provider did nothing.

Provider success does not establish inventory persistence or delivery. The broker validates returned scope and expiry, retaining unexpected output only for cleanup. Providers unable to meet the selected native-exposure or mediated-use policy remain unavailable. Broader administrative revocation requires separate scope authorization and cannot be an automatic fallback.

## Durable issuance and dispatch

### 1. Reserve

Check current online authority, limits and audit readiness. Atomically reserve capacity and the lease mint claim. Before any provider call, commit issuance intent bound to the original lease, exact scope, generation, and operation.

### 2. Claim

Commit one provider-attempt claim with conditional version checks. Concurrent requests and restart retries must resolve the same operation. Expired worker claims and missing acknowledgements do not prove no dispatch occurred.

### 3. Dispatch

The existing authority owner supplies a bounded operation permit, under current online authorization. The broker consumes it for the exact request at dispatch, ordered against applicable closure and invalidation:

- Locally observed withdrawal or expiry before consumption denies.
- Consumption first means an in-flight operation may finish.
- Every operation requires current online authority and its original deadline; active exchanges stop when current observations expire.

Cancellation cannot promise distributed rollback.

### 4. Record

Before use/delivery, retain accepted material in protected durable custody and commit its inventory record, actual scope, and expiry. Late results after closure or rotation retain the original attempt and enter cleanup. Reconcile partial or uncertain persistence by exact operation identity.

### 5. Use or release

Validate the credential against the original work and applicable enforcement evidence. Delivery intent requires a known durable outer commit before the first byte or release callback; returning from an uncommitted transaction is insufficient. Unknown commitment suppresses release until exact readback.

Enforce use/delivery authority at the actual boundary. Cancellation between mint and release must not expose credentials to later work.

### Uncertainty and durable inventory

Identical retries return or reconcile the original operation; different intent digests conflict. Provider profiles define safe retries after definitive no-effect evidence. `unknown`, timeout, new request IDs, or absent local read results never authorize reminting. Providers have no generic exactly-once guarantee.

Inventory must retain outstanding and uncertain obligations across restart and deletion. Conditional claims, protected custody, and audit persistence must define commit/readback behavior. Insufficient capacity, audit, or storage availability denies new effects; obligations cannot be evicted.

Token values, keys, authorization headers, and handle secrets cannot enter ordinary resource records, logs, metrics, or audit payloads.

### Business dispatch and finalization

The shared broker must admit a business operation in the same State transaction
as its required claim conditions, capacity and closure checks. A known commit
creates one original receiver's permit; uncertainty, failover or claim expiry
cannot reconstruct submission authority. Apply a synchronous one-use gate after
asynchronous preparation and immediately before submission.

Register independent receipt finalization before dispatch. Its separate bounded
cleanup authority survives caller disconnect, cancellation, permit consumption
and restart. Preserve known or unknown effects, return success only after a
known receipt commit, and never let finalization submit a provider request.
The [PR claim](github-publication.md#one-submission-per-retained-operation) is
mandatory for PR creation; adapters cannot omit it or provide replacement SQL.

## Replacement, closure, and cleanup

### Credential replacement

Replacement issues a new credential under the same still-authorized lease without renewing it, revoking predecessors, or replaying failed business operations. Track every predecessor and successor; enforce two aggregate outstanding slots and one in-flight mint per GitHub lease across concurrent requests and retained attempts. Reservations, unknown attempts and provider-valid retired tokens count; only definite no-issuance, confirmed revocation or evidenced expiry frees capacity. Caches may reuse only exact permitted scope/binding/lease matches and cannot cache authority.

### Closure and invalidation

Access-lease closure or expiry, grant withdrawal, binding rotation, incarnation retirement, and explicit disable prevent new use/delivery and require cleanup of every affected issued or uncertain credential. Commit invalidation and a complete inventory-scan obligation together, including racing/late results. Resource deletion retains a tombstone, protected references, and cleanup responsibility.

### Agent stop and result delivery

User-facing Stop task / Stop Agent / Start Agent controls remain future scope under RFC 0037. The MVP requires cancellation, authority withdrawal, and safe execution retirement. The following drain and completed-delivery behavior applies only to a separately admitted lifecycle profile. An Agent stop first closes admission of new work. If a selected graceful-stop profile admits finite drain, existing work may use or replace eligible credentials only within its unchanged original scope, enforcement evidence, and recorded drain deadline. Authority renewal requires current decisions and cannot extend the stop deadline. Completion, deadline, cancellation, disable, or retirement closes affected authority.

The accepting-service protocol must order runtime-purpose withdrawal, work closure, and broker dispatch, with finite operation and observation bounds. An open connection, renewed SVID, or refreshed GitHub token cannot bypass those bounds.

An explicitly selected graceful-stop delivery profile preserves pending delivery of an already completed result when its separate finite responsibility was admitted before work closure; it cannot keep computation's access leases open. Any GitHub write used for that delivery needs its own exact admitted scope and current authority. Cancellation or security revocation withdraws affected delivery even if the Agent is already stopped. Already admitted provider effects and independently authorized cleanup remain separately tracked.

### Cleanup authority

Cleanup uses separately authenticated platform lifecycle authority limited to reducing the exact recorded access. It survives revocation of the initiating human and cannot issue replacements or perform user work. Durably claim and record each attempt; takeover must resolve or safely account for earlier uncertain attempts before dispatch. Claim timeout alone is not success.

### Independent status dimensions

Keep these status dimensions independent:

| Dimension     | States                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization | `open`, `closed` with cause and commit time.                                                                                            |
| Issuance      | `reserved`, `dispatched`, `issued`, `not-issued`, `unknown`.                                                                            |
| Delivery/use  | `not-started`, `admitted`, `completed`, `unknown`, or `denied`.                                                                         |
| Cleanup       | `not-required`, `pending`, `confirmed-revoked`, `confirmed-expired`, `unknown`, or `action-required`.                                   |
| Execution     | Supplied independently by Compute: running, stopping, observed stopped, or unresolved. A closed lease does not imply a stopped process. |

Expiry requires a timestamp and provenance; otherwise it is unproven. Completion requires that evidenced time to have elapsed, including the selected clock uncertainty allowance. Neither a future expiry nor guessed issue time plus nominal TTL proves completion.

## Issuer service lifecycle

| Stage     | Required behavior                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| Startup   | Validate the fixed issuer profile and dependencies before serving.                                                  |
| `quiesce` | Stop admitting local calls and cancel/drain bounded in-flight work while retaining outcome records.                 |
| `dispose` | Release local clients and material handles without implying token revocation.                                       |
| Restart   | Resume from durable inventory under fresh service and cleanup authority. Cached permission decisions cannot revive. |

Shutdown reports local completion separately from cleanup obligations. Unavailable issuers or backends report degradation without fallback to another account, issuer, credential class, or access mode.

## Versioning and conformance

V1 profile identity includes interface and provider schema versions. Reject unsupported authority-bearing fields and capability combinations. Backend, authority, and runtime replacements must satisfy the lifecycle and evidence rules as well as method signatures. The [bundle lifecycle](credential-broker-v1-spec.md#backend-recipes) requires identical-version restart and verified drain before offline upgrade.

The selected provider and mode determine required provider, client, preparation, and mediation checks in [the acceptance matrix](lifecycle-acceptance.md#acceptance-matrix). Parser, mock, and component checks cannot establish real current authority, durable transactions, provider revocation, or origin binding.

## Related specifications

- [Overview and contract](credential-broker-v1-spec.md)
