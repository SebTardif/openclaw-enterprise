# Credential Lifecycle: Recovery and Qualification

Draft recovery and acceptance plan for [RFC 0034](../0034-github-app-credentials.md).
The [broker specification](credential-broker-v1-spec.md) defines shared
requirements; the [GitHub specification](github-app-v1-spec.md) defines provider
and client behavior. This appendix describes how to test them.

## Production scope

Production requires the [mediated profile](github-mediated-access.md#mediated-operation-profile)
and current online authority for every dispatch. The MVP qualifies metadata,
clone/fetch, direct push and minimal same-repository PR creation. Native delivery
is development/testing only. Broader Work, independent children, public Stop/Start
controls, approved-candidate publication and protected-origin authentication remain
future scope.

Genuine root Work, exact revision/assignment binding, current operation grants,
cancellation, custody and durable outcomes are required from the first read.
Root-only execution may qualify first; helpers need shared scope, aggregate limits
and stop ownership. The [acceptance matrix](lifecycle-acceptance.md#acceptance-matrix)
owns the required evidence.

## Authority and identity

The [broker contract](credential-broker-v1-spec.md) distinguishes these lifetimes:

| Term                | Distinction tests must preserve                                                         |
| ------------------- | --------------------------------------------------------------------------------------- |
| Logical work        | Service-owned work can remain open after a turn or provider token ends.                 |
| Enforcement lease   | Bounded authority has its own deadline; a valid provider token cannot extend it.        |
| Broker access lease | Closure denies further access and retains cleanup obligations.                          |
| Provider token      | Local denial is separate from confirmed provider revocation or evidenced expiry.        |
| Execution process   | A process can survive access closure. Replacement requires observed writer termination. |
| Issuer service      | Restart requires durable recovery and fresh service authority.                          |

The [RFC series](../0027/runtime-access-overview.md) assigns ownership as follows:

| RFC  | Responsibility          |
| ---- | ----------------------- |
| 0034 | Credential obligations  |
| 0035 | Execution identity      |
| 0036 | Original-work authority |
| 0037 | Runtime lifecycle       |

Acceptance of those RFCs is separate from qualification of the combined
production path.

## What binds mediated access to the container

Validate the [bearer and original server-owned binding](github-mediated-access.md#mediated-origin-and-routing).
Copied live bearers may use their original authorized grant; physical-origin proof
is not claimed. Test that caller IDs cannot retarget authority and closure blocks
that original token. Other OCC/Kubernetes authentication boundaries remain intact.

## Minting, refresh, and revocation

Exercise the [issuance protocol](credential-broker-operations.md#durable-issuance-and-dispatch)
and [renewal policy](github-issuer-policy.md#refresh-and-overlap). Enforce one fixed profile, two aggregate outstanding slots and one in-flight
mint per lease across concurrent requests and retained attempts. Track predecessor tokens after replacement and report local access denial, provider revocation,
and evidenced expiry separately.

## Recovery cases

| Event                                                            | Required recovery                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Broker fails before a committed provider claim                   | Reconcile the original reservation and claim. Dispatch only with authoritative proof that no earlier attempt could have reached the provider.                                                                            |
| Mint response is lost after possible dispatch                    | Retain the original attempt as `unknown`; expiry remains unproven unless evidence establishes it. A fresh request or lease cannot bypass the hold.                                                                       |
| Custody/inventory acknowledgement is lost after provider success | Read back the exact operation. Block delivery while persistence is uncertain; retain material for cleanup. Missing readback does not authorize reminting.                                                                |
| Cancellation or rotation occurs during issuance                  | Close old authority. Attach late results to their original binding and revoke them.                                                                                                                                      |
| Refresh fails                                                    | Use an eligible recorded token only with valid original authority and all required checks, through current online authorization in the first GitHub profile. Unknown issuance or exhausted overlap blocks another mint.  |
| Delivery response is lost                                        | Record possible exposure and reconcile the same delivery. Retain cleanup obligations.                                                                                                                                    |
| Issuer restarts                                                  | Recover durable state, obtain fresh service authority, and resume cleanup/readback without cached authorization.                                                                                                         |
| Work/service authority is revoked or Agent/Namespace is deleted  | Withdraw affected access under its selected bound. Retain tombstones and protected references so independent platform cleanup can continue. Requester invocation permission and service/workload access remain separate. |
| Revocation times out or a worker claim expires                   | Reconcile the pending/unknown attempt; timeout proves neither provider success nor failure.                                                                                                                              |
| Protected token material is unavailable                          | Report action-required. Recover custody or perform separately authorized broader mitigation; a hash cannot revoke the token.                                                                                             |

The [GitHub issuance hold](github-issuer-policy.md#refresh-and-overlap) survives
replacement leases and broker restarts. A new connection or request ID does not
resolve uncertainty.

## Lifecycle

### Enrollment and preparation

| Event                     | Coordination                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Verify enrollment         | OCC authorizes exact references; issuer verifies provider identity and scope. Readiness does not mint.                                 |
| Prepare candidate         | Compute provides execution and staging; SandboxDriver verifies containment. OCC gates checkout on both and a separate read-only lease. |
| Finish/cancel preparation | Close access, observe preparation stopped, and retain cleanup. Failure preserves the serving workspace.                                |

### Active work and replacement

| Event                      | Coordination                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activate or replace        | Close old assignment authority, observe previous writers stopped, and promote verified staging through Compute. The MVP admits fresh Work. Cross-assignment Work continuation is a later qualified profile requiring fresh current assignment authorization and new leases; original scope and effect receipts remain fixed. |
| End a turn or logical work | A turn ending does not finish service-owned work. Logical-work closure closes its access leases; queued requests cannot borrow another work record through a mutable pointer.                                                                                                                                                |
| Admit Work                 | Require genuine root admission, original scope, exact Agent/revision/assignment, current operation authority, duration selection, and cancellation owner. Leases and operations stay finite. Same-scope subordinate helpers require qualification; separately admitted durable children remain future scope.                 |
| Restart within a Pod       | Change execution generation, close old leases, and establish the fresh server-owned binding. The same Pod UID or volume preserves no authority. Permission/context changes additionally require a fresh Pod/gVisor sandbox, eligible context, and observed old-writer termination.                                           |

### Stopping and result delivery

User-facing stop/start controls and completed-result delivery remain future scope.
Cancellation, withdrawal and safe retirement are required in the MVP. Independent
receipt finalization is mandatory before dispatch and survives request cancellation.

| Event                      | Coordination                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop with bounded drain    | Close new work admission; retain only eligible original work until the recorded finite deadline. Recheck authority on each effect. Completion/deadline closes access; disable or retirement overrides draining. A restart cannot extend the deadline.            |
| Disable/retire/delete      | Stop new access and affected execution independently of cleanup. Retain outstanding records until terminal evidence.                                                                                                                                             |
| Deliver a completed result | Graceful stop preserves only separately admitted finite delivery to its exact audience. Posting still requires current authority. Cancellation/security revoke withdraws delivery even while already stopped; an uncertain submission is never blindly replayed. |

## Repository preparation

For the [preparation contract](github-app-v1-spec.md#repository-preparation),
document:

- The actual workload and staging/promotion mechanism.
- Separately admitted preparation authority constructed by OCC and handed to access delivery; pending assignments/readiness confer nothing.
- Exact construction/Harness and helper-stop ownership before construction, and observed preparation/predecessor termination before handoff.
- Rollback.

A "prepared" flag alone is insufficient.

## Timing targets and outages

### Withdrawal and cleanup bounds

Each selected profile must publish numerical withdrawal bounds and their clock,
observation, and enforcement assumptions. Ordinary eligible work may target
minutes; sensitive profiles may target seconds with lower outage availability.
These are tolerance scales, not fixed TTLs or measured guarantees.

| Measurement          | Target and interpretation                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access withdrawal    | Measure the selected end-to-end target, including authority observation, issue/revoke ordering, distribution, local enforcement, and clock uncertainty. Active exchanges stop within the selected current-observation bound or original deadline; reconnect cannot extend an admitted exchange. Record authority commit separately from observed holder withdrawal. |
| Workload termination | Observe affected writers stopped before replacement. A timeout blocks unsafe promotion and reports unresolved termination.                                                                                                                                                                                                                                          |
| Upstream cleanup     | Observe for up to 120 seconds, then report confirmed revoke, evidenced expiry, pending/unknown, or action-required. Durable cleanup continues after this window.                                                                                                                                                                                                    |

### Timing evidence

Record each of the following, including clock uncertainty:

- Authenticated request acceptance, authoritative observation, and durable commit.
- Holder observation, operation admission, and provider dispatch.
- Last success, first denial, and observed termination.

Separate request-to-denial from commit-to-denial; failed or lost commits are not
successful samples. Tightening a profile cannot advertise its new bound until
outstanding older leases are accounted for.

### Authority outages

For the first GitHub profile, deny every dispatch without current online OCC
authority, including reads, issuance, and maintenance. An existing token or
unexpired lease cannot provide an offline fallback. Report already accepted
upstream effects separately, and retain cleanup obligations under their own
independent authority.

The shared broker's future read-continuity/maintenance profile requires separate
selection and O2 qualification. It cannot silently enable offline GitHub access.
Native development/testing copies remain usable until provider revoke/expiry,
including during OCE outages.

### Retries

Use bounded backoff only where retries are permitted, respecting
[`Retry-After` and reset responses](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately).
Outages retain cleanup obligations; network recovery authorizes neither
reminting nor replay of ambiguous writes.

## Implementation sequence

1. Implement admin admission, root Work and the standalone gateway through existing
   OCC/IAM and shared PostgreSQL State owners; qualify bearer delivery, fixed token
   profiles, two-slot inventory, cleanup and executable GitHub and independently
   authored synthetic non-GitHub recipes.
2. Qualify safe read-only preparation and regular Agent metadata/clone/fetch.
3. Qualify direct push and independent PR creation, including canonical input,
   safe output, atomic claims, independent finalization and unknown non-replay.
4. Qualify one active gateway on a pinned Kubernetes/gVisor/client profile with
   containment, authority withdrawal, closure and bounded identical-version restart.
   Demonstrate live GitHub checkout/edit/commit/push/helper-PR, read-only denial,
   scoped issuance and confirmed revoke-then-deny through the regular Agent.

Keep controlled safety/protocol tests, installed evidence and live GitHub evidence
separate under the [acceptance matrix](lifecycle-acceptance.md#acceptance-matrix).
Multi-replica and broader live fault/rotation/upgrade campaigns are deferred.
Component checks and synthetic fixtures cannot qualify the complete workflow.

## Acceptance evidence and current implementation limits

This submission runs documentation checks only. Implementation submissions must
identify code, configuration, and mode and provide redacted evidence for
applicable tests. Record:

- Implementation commit and configuration/profile version.
- Tool/image pins and environment.
- Command/request manifest.
- Positive/negative outcomes and unresolved results.

Publish redacted evidence with synthetic identifiers; keep secrets and private
infrastructure details outside this repository.

Existing component results may be reused where behavior matches this contract;
they do not establish the full lifecycle or installed mediated path.

## Upstream decision and implementation handoff

RFC approval covers admin configuration, the shared gateway, genuine root Work,
current online authority and the read/read-write workflow. Stronger physical-origin
and publication controls, broader Work and additional providers remain future work.
Implementation must identify genuine root-Work inventory binding and OCC's
preparation-context handoff, measured withdrawal bounds and qualified helpers.

Follow the repository's acceptance process: keep draft status until acceptance,
then create an implementation issue with milestone and evidence owners. RFC
acceptance does not qualify an implementation for production.

## Related specifications

- [Credential Lifecycle Acceptance Matrix](lifecycle-acceptance.md)
