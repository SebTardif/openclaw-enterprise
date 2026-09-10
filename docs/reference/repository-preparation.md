# Repository preparation credentials

The repository preparation V1 contract gives a candidate revision its own bounded, read-only repository credential purpose. It defines the values and protected in-process ports needed to reserve issuance, use named credentials, retain token inventory, deliver a recorded token, reconcile revocation, and consume exact checkout receipts. A failed or replaced candidate retains its own cleanup obligations while an independently serving revision keeps its existing authority and resources.

The package exposes two supported imports:

```ts
import type {
  RepositoryCredentialSubjectV1,
  RepositoryCredentialAuthorityV1,
  RepositoryPreparationCredentialPortV1,
  RepositoryPreparationReceiptPortV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";
import {
  parseRepositoryPreparationV1,
  parsePreparationReceiptExchangeV1,
} from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
```

These exports provide schemas, immutable value parsing, canonical intent encoding, correspondence checks and interface declarations. Implementations of the existing credential, lifecycle, identity, persistence and Compute owners must supply the protected effects and currentness checks. Parsing a value establishes its shape and consistency; it does not establish that its claimed producer, authority, origin, staging area or observation exists.

## Two explicit purposes

`RepositoryCredentialSubjectV1`, `RepositoryCredentialAuthorityV1`, `RepositoryCredentialRequestV1`, `RepositoryCredentialExchangeV1` and `RepositoryCredentialInventoryRecordV1` distinguish these variants:

| Purpose                            | Authority and attribution                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `original-turn-runtime`            | The canonical current original-turn binding, current credential authority, request and inventory dictionaries, including the required nullable execution-cap projection. Canonical encoding delegates to credential storage. |
| `candidate-repository-preparation` | A lifecycle-admitted candidate subject, a preparation-specific authority observation, purpose-tagged requests and inventory retaining that exact candidate. It has no fabricated original turn or runtime assignment.        |

The new purpose is carried by every preparation credential request. The original member of each new request union explicitly excludes preparation keys, including for structurally wider TypeScript values. Closed parsers reject mixed or relabeled variants. The original-turn branch delegates canonical encoding to the existing [credential storage contract](credential-storage.md).

Only original-turn execution duration may be uncapped. Candidate preparation,
credential authority, and invocation deadlines retain their separate finite bounds.

A preparation subject binds:

- Installation, namespace and Agent scope; a preparation reference and concrete-incarnation correlation reference.
- Candidate revision ID and digest; lifecycle gate, generation, fence epoch, plan and preparation responsibility; an authorization generation.
- The admitted operation, request digest, actor and request correlation; the exact versioned preparation grant.
- A native repository credential profile and account; one positive decimal repository ID; a full lowercase SHA-1 commit object ID.
- Versioned protected origin-profile and staging-store references, creation time and expiration.

The repository grant is exactly that one repository and read-only `contents`, with optional read-only `metadata`. Other modes or Git object formats require an admitted contract variant. References do not authorize branch resolution, arbitrary hosts, redirects, repository expansion, storage reuse or writes. The accepting owner resolves and compares the protected profile and account records, expected origin, repository identity, commit and staging mapping.

The gate must describe a running preparation responsibility. Credential-facing reference values do not extend the runtime assignment component or Kubernetes resource-kind unions. The runtime producer separately defines and qualifies actual Job, Pod, execution identity, effect and staging applicability.

## Current authority and custody

`CurrentPreparationCredentialAuthorityV1` uses the existing protected current-authority handle identity with a distinct preparation observation. The observation retains the exact subject, named-secret binding, account version vector, lease, authority and invalidation versions, decision, request correlation and one of `reserve-issuance`, `mint-token` or `deliver-token`.

The accepting owner authenticates the caller and verifies that the handle was issued for the exact purpose, requested effect, current subject and protected account/profile/binding. It checks lease expiry, current versions, lifecycle and authorization generations, grant validity, audit acceptance and capacity. It repeats currentness checks after asynchronous acquisition and immediately before an effect or credential release. Cancellation, replacement, rotation or expiry winning an intervening race denies new use. Neither the TypeScript brand nor a parsed observation implements those checks.

The in-process material and ephemeral-token handles retain their existing owner and custody semantics. No schema contains a secret, bearer value or handle constructor. Named material reaches only the fixed trusted callback. Native token delivery reaches only the registered candidate receiver through the existing protected custody path. This contract does not establish per-command human attribution for a readable native token or unconditional provider revocation bounds.

A remote service boundary requires a separately accepted authenticated transport and capability mapping. Serializing these local opaque handles cannot supply it.

## Protected port ordering

`RepositoryPreparationCredentialPortV1` is an additional purpose of the same accepting credential owner, inventory and operation journal. It is not a second issuer or store.

| Method                   | Required accepting-owner behavior                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveIssuanceV1`      | Persist the exact immutable issuance intent, semantic digest and mandatory audit before any possible mint. Exact retry/readback retains the existing reservation and outcome.                                                                                                          |
| `withNamedCredentialV1`  | Load the exact durable reservation and atomically claim its single preknown `providerAttemptRef` under inventory CAS before invoking the trusted callback. A lost acknowledgement, new operation ID or restarted caller cannot authorize a second possible mint for the same issuance. |
| `recordMintOutcomeV1`    | Preserve authenticated provider truth against the original issuance and provider attempt. Accepted tokens require the actual protected token handle; unknown or no-token outcomes explicitly require `undefined` material.                                                             |
| `deliverRecordedTokenV1` | Require durable known-token and revocation custody, matching returned scope and conservative expiry, then commit the exact delivery intent before callback. Recheck current candidate authority at release; retain delivery uncertainty after callback or acknowledgement loss.        |
| `listAffectedV1`         | Read a persisted snapshot bound to the exact candidate, scope, binding, invalidation and filter digest. Include pending, unknown, overlapping and late inventory across restart.                                                                                                       |
| `claimRevocationV1`      | Claim only the exact token and retained mitigation responsibility. Claim expiry or takeover preserves whether a previous provider attempt may still be pending or unknown.                                                                                                             |
| `recordRevocationV1`     | Record authenticated evidence against the original issuance, token, provider attempt and applicable claim. Pending, unknown, confirmed and conservatively expired remain distinct.                                                                                                     |
| `readOperationV1`        | Read the exact original operation, method and intent digest through current protected read authority. Missing or unavailable readback permits no effect replay.                                                                                                                        |
| `fencePreparationV1`     | Atomically fence future candidate use with exact grant/invalidation CAS and retain a durable responsibility and affected-inventory scan. The result requires subsequent inventory reconciliation and exact candidate cleanup.                                                          |

The fence request advances invalidation by one and matches the admitted subject's grant version. A `fenced` response binds the candidate, operation receipt, advanced grant and invalidation versions, responsibility and scan. Its evidence-missing branch reports the missing local record without manufacturing a provider outcome. Fencing neither proves token cessation nor performs Job termination or staging cleanup.

Only an independently authorized exact mitigation responsibility permits cleanup after new-use authority is lost. That responsibility cannot mint, redeliver, target a successor or mutate the independently serving grant. Mandatory audit failure denies new authority; it cannot suppress already preauthorized exact mitigation. Durable audit obligations and missing-evidence incidents remain explicit.

## Unknown, late and crash outcomes

The inventory retains the existing five states: `reserved`, `mint-unknown`, `not-issued`, `resolved-without-token` and `outstanding`. Every preparation row embeds the original preparation issuance and its canonical digest. A future provider-derived expiry on unknown issuance does not invent token custody or resolve possible issuance early.

After a timeout, lost response or cancellation acknowledgement, retain the same operation and provider-attempt identity. Read back that exact operation before deciding whether any further action is permitted. Local deadline expiry, transport closure and an expired claim do not prove that the provider stopped.

A known token arriving after replacement, cancellation, rotation or authority loss remains attributed to the old candidate and enters mitigation-only inventory. Mismatched or unproved returned scope, unproved expiry and superseded invalidation also prevent delivery. No late outcome may be reattributed to the successor.

After a **definite CAS conflict**, a separately authorized reconciliation operation may use the current expected inventory version to record authenticated historical truth. It preserves the original issuance, token, provider attempt and applicable claim, compares the retained original attempt record, and cannot overwrite stronger terminal evidence or repeat a possible effect. This differs from acknowledgement loss: an uncertain original commit first requires exact original-operation readback, without rewriting its intent digest or CAS history.

Pagination binds snapshot, version, filter digest and cursor. The page's live counts cannot understate its own known rows; persisted snapshot coverage remains bounded. An empty final page does not prove that all issuance, late outcomes or future inventory changes are globally resolved. Unknown rows without provider-derived expiry remain expiry-unproven.

Terminal inventory retention and audit-copy retention keep their existing independent policies. Active unknown inventory remains a protected obligation. Its retention does not extend audit-copy retention or suppress required audit-evidence-loss reporting.

## Checkout receipt and currentness

`PreparationCheckoutRequestV1` binds the complete subject, original operation, expected effect reference, semantic digest, request correlation and bounded invocation deadline. Its digest includes a `repository-checkout-v1` domain and omits only top-level `requestId`, `createdAt`, `deadline` and the self-digest field. The complete subject remains part of the immutable intent. Retry metadata does not change that intent. The accepting producer retains the originally accepted request and effect deadline as immutable evidence. A later read call may use fresh correlation and call bounds, but cannot extend the original effect deadline or the admitted preparation deadline.

The runtime producer supplies a protected receipt matching the exact request, effect reference and digest, incarnation, revision, actual full commit and staging binding. Provenance retains the accepted producer/profile/port references, evidence version and original source clock. The four clock fields are closed: `sourceObservedAt`, `receivedAt`, `validUntil` and `uncertaintyMs`. Both source and evaluation clocks preserve the canonical rule that validity ends no later than 15,000 ms after source observation; source time cannot exceed received time plus declared uncertainty.

`RepositoryPreparationReceiptPortV1.readReceiptV1` authenticates exact read scope and retrieves or reobserves protected evidence without refreshing the original source time on a cache read. A live complete result carries a producer-owned, invocation-bound `ProtectedPreparationReceiptHandleV1`. After awaits, `assertCurrentReceiptV1` checks that actual handle, exact retained evidence and current candidate state. The owner rejects forged, foreign, replayed, expired or superseded handles.

`parsePreparationReceiptExchangeV1` validates diagnostic data and exact request correspondence using a separately supplied trusted-owner evaluation clock. `receivedAt` in that clock is the evaluation time. The function matches semantic checkout intent and checks source age, uncertainty, evidence validity, the fresh read-call deadline, the retained original effect deadline and the candidate deadline conservatively. A later call deadline cannot extend the original effect authority; the receipt continues to contain the producer's original request. It returns no protected handle. Authentication and currentness remain accepting-owner duties.

Complete checkout evidence still requires the lifecycle owner's separate readiness decision. `incomplete`, `unknown`, `rejected`, `cancelled`, `stale`, `conflict` and `not-visible` remain explicit. Cancellation or rejection metadata alone does not prove absence of a late effect. Consumers retain exact readback or scoped-cleanup responsibility and preserve independently serving resources.

## Numerical bounds and encoding

The new contract reuses the existing selected limits:

| Boundary                                             | Limit                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Preparation lifetime and maximum checkout invocation | 900,000 ms, further bounded by the admitted subject deadline                        |
| Credential storage invocation                        | 5,000 ms                                                                            |
| Authority lookup                                     | 3,000 ms                                                                            |
| Active authority recheck                             | At most 5,000 ms; effect boundaries still require current checks                    |
| Maximum observation source age                       | 15,000 ms                                                                           |
| Maximum uncertainty in each clock                    | 2,000 ms; exchange validation conservatively adds source and evaluation uncertainty |
| Credential request / diagnostic response             | 65,536 / 262,144 UTF-8 bytes                                                        |
| JSON depth                                           | 32                                                                                  |

Inventory, snapshot, claim, capacity, expiry and retention limits continue to come from `CREDENTIAL_STORAGE_LIMITS_V1`. A bounded call does not prove that a provider effect ended. These values are contract requirements, not measured service capacity.

Parsing rejects unknown keys, unsupported variants, unsafe numbers, malformed times, accessors, proxies, cycles and non-plain objects. Raw JSON additionally rejects duplicate decoded keys, fractional or exponent numeric lexemes, negative zero and unsafe integer precision. Parsed outputs are detached and deeply immutable. Canonical credential intent omits only top-level per-call `requestId`, `createdAt` and `deadline`; all candidate, scope, profile, generation, effect and CAS fields remain bound.

## Conformance and remaining implementation

The [fixture family](../../tests/fixtures/repository-preparation-v1/README.md) provides an independent producer, credential/lifecycle/Compute consumers, parser vectors, compile negatives and normative failure traces. Pure checks cover value consistency, exact original-turn digest compatibility, currentness data boundaries, unknown/late inventory and closed failure vocabulary. The traces state the required durable ordering; they do not execute a storage backend, credential provider or Job.

Actual protected preparation admission, current authorization, registered custody callbacks, persistence transactions, native credential delivery, Job identity/effect observation, staging isolation, cancellation, exact cleanup and readiness require their original owners' implementations and qualification. No live credential, provider or runtime success is implied by these exports.
