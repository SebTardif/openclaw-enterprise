# Operation enforcement and Work lifecycle

Part of the proposed [Work authority specification](work-authority-spec.md).
Read [repository grants, admission and durable records](admission-and-records.md)
first; the initial root Work and later independent-child requirements have
different delivery scopes.

## Operation Enforcement

### Admission and dispatch sequence

1. Authorize invocation, service access, workload access, data eligibility and exact scope through OCC and the selected authorities. Freeze the work ceiling, effective duration policy and any configured work horizon.
2. Select a qualified execution under current authority. A former assignment's lease cannot authorize its successor. From the initial release, any successor must have observed termination of the old writer before writing retained state, alongside assignment fencing and the fresh-Pod rule for changes to admitted permission scope. RFC 0037 owns that evidence. Continuing the same Work across replacement attempts remains a later Work lifecycle capability.
3. Issue a finite enforcement lease in an authoritative order with cancellation and revocation. Bind it to the work, assignment and accepting service.
4. At GitHub dispatch, validate the Agent access token and resolve its original server-owned grant, Work and execution. Derive action and resource from the actual operation and check current OCC/IAM authorization, assignment, lease, purpose, scope and allowances. Bearer possession does not establish the presenter's container; caller IDs cannot retarget the grant. Protected-origin authentication requires a separately qualified future profile.
5. Atomically reserve dispatch responsibility and allowances with current authority and closure checks under the original operation key. Only a known commit permits submission. Preserve request identity and bytes through submission and retain the observed outcome. Duplicates resolve the original dispatch state; pending or unknown submission cannot trigger another submission.

For PR creation, retain immutable canonical request contents under `(accessId, clientOperationId)` with a UUIDv4 client ID. Claim consumption and dispatch admission share the State transaction with authority, capacity and closure checks. A known commit grants only the original receiver one-use submission authority; another request or restart cannot reconstruct it. Same-key requests require current authorization before returning retained state; changed contents conflict. Register independently bounded finalization before dispatch, and return success only after known receipt commit. RFC 0034 owns the [request/result protocol and retention rules](../0034/github-publication.md).

Possibly submitted pushes and PRs are never automatically resubmitted. Unknown outcomes survive disconnect, cancellation, restart and Work closure; this profile supplies no PR reconciliation endpoint. Closure denies further ordinary dispatch while preserving independently admitted finalization and cleanup.

### Keep enforcement outside Agent control

Only RFC 0027's active revision and exact authorized workload may perform Agent execution. Retain the exact Harness/construction cancellation and helper-stop owners before construction. Enforcement remains outside Agent-controlled execution. A denied decision is not retried against another adapter.

Current policy can narrow access. Renewal preserves original work identity, purpose, audience and cancellation dependencies. Later permission growth cannot expand `W`, admitted provider selections or any configured horizon. Policy recovery restores access only within an unchanged, still-open work record.

Streams and queued operations retain their original-work bindings and obey the same dispatch and withdrawal rules. An open connection or surviving process cannot adopt later authority. A late successful check cannot revive an expired lease or closed stream.

### Preserve provider mediation

RFC 0034 owns broker mediation and credential replacement. Provider bearer credentials remain in trusted mediation. Identity certificates and short token lifetimes alone do not make leaked provider tokens harmless. A model proxy neither supplies GitHub mediation nor authorizes native fallback.

Credentials authenticate or enable provider access; they do not record work scope, cancellation or immutable effects. Durable receipts preserve uncertainty across token changes and execution replacement.

## Renewal and Withdrawal

### Renew through current authority

Authority renewal is a fresh decision through OCC and the selected policies while work remains open, within its original ceiling and every configured horizon.

RFC 0035's issuer must bound every lease by:

- Its issuance-time maximum.
- Applicable work and ancestor horizons and configured attempt deadlines.
- Purpose and stop deadlines.
- Withdrawal targets, including clock and enforcement allowances.

Every issued lease and every applicable deadline must be finite, consistent and authoritative. An explicitly uncapped work policy omits a work deadline; it does not omit the lease expiry or other required bounds. Missing policy is not an uncapped fallback. A deadline calculator does not supply these inputs' authority.

### Select and measure withdrawal profiles

Ordinary profiles may target withdrawal on the scale of minutes; sensitive profiles may target seconds with reduced availability. These are tolerance scales, not selected TTLs or measured guarantees.

RFC 0035 owns each profile's withdrawal start point, external-IAM observation delay, issuer fencing, holder enforcement delay, trusted-clock assumptions and provider-effect boundary. Requested withdrawal and proven effective withdrawal remain distinct.

Selected GitHub dispatch stops whenever current OCC authorization is unavailable. A future qualified outage-read profile must stop by its original lease deadline; reconnection or restart cannot move that deadline. Tightening a target must account for outstanding leases before advertising the tighter guarantee: new policy cannot retroactively shorten an unseen old lease.

### Preserve state through restart and collection

RFC 0035 owns ordered issuance/revocation, issuer fencing and durable, monotonic holder synchronization. A restarted holder whose clock or revocation state is untrustworthy synchronizes before serving.

Collection of obsolete enforcement entries must not erase terminal work, current policy or descendant withdrawal obligations. Effect receipts and cleanup retain their own lifetimes.

## Authority Outages

### Qualify application reads explicitly

A bounded-read freshness profile remains future scope. Selected GitHub access requires current OCC authority for every dispatch, including reads and credential maintenance. Authentication does not imply cached permission.

Only application reads expressly selected and qualified for such a profile may continue during an authority outage under an existing, unexpired enforcement lease. Eligibility follows operation semantics, not HTTP method.

The selected authentication, local revocations, scope, inventory, freshness and every other mandatory check still apply. Missing required evidence denies the affected operation.

### Keep other actions dependent on current authority

Application writes, message posting, new admission, renewal, expansion and new execution assignment require current authority.

Trusted credential maintenance may preserve existing read access only when explicitly preauthorized under the same lease and an enforceable read-only credential profile. It cannot:

- Reuse a broader write-capable credential.
- Create work or broaden scope.
- Extend the authority deadline.

Missing provider or inventory evidence denies maintenance. RFC 0034 retains its accounting and uncertainty rules.

In a selected future outage profile, finite enforcement leases would bound disconnected use while allowing expressly qualified reads to finish. Requiring current authority for writes and renewal makes the availability tradeoff explicit.

## Later Capability: Attached Children

This section specifies the Work lifecycle stage. Initial repository Work uses the [root and subordinate-helper profile](admission-and-records.md#initial-helper-boundary). Independent child admission and continuation without a running coordinator are not initial release requirements.

### Admit distinct, bounded child work

An attached child has a distinct work identity, immutable parent/ancestor links, and its own original scope and duration policy bounded by its ancestors. An uncapped child cannot escape a finite ancestor horizon. Child admission requires current authority.

A child need not create another Agent. A logical child in a shared process gains no separate security boundary.

Separately admitted children require their own scope, authority, lineage, status and cleanup. Initial root/helper cancellation and physical stop remain mandatory independently of this later capability.

### Renew without a running parent process

Already-admitted children can receive fresh enforcement leases through the authority service's own narrow identity while logical ancestors remain open and authorized, even when no parent process runs. Renewal checks:

- Current lineage and workload permission.
- Original ceilings and eligible execution/receiver.
- Every applicable ancestor horizon and withdrawal target.

A child's longer ordinary withdrawal target cannot weaken a sensitive ancestor's shorter target.

Fresh authoritative issuance is not capped by a former parent execution lease's expiry. Local attenuation remains capped by its originating lease and cannot admit a child, renew authority or assign execution. Fresh issuance neither restores the parent execution's authority nor detaches the child.

### Preserve cancellation and required joins

Ancestor cancellation fences future descendant issuance and withdraws affected leases under RFC 0035's profile. A child cannot silently detach to survive it; independent work requires its own admission.

Parent computational completion waits for required child joins and preserves unresolved effects under the admitted completion policy.

For example, a coordinator can admit two attached repository reviews and wait without running. Each child renews from current authority. During an outage neither renews. Initial GitHub dispatch stops without current authority; a future qualified-read profile could continue only until the existing lease deadline. Canceling the coordinator's logical work governs both children regardless of which processes remain alive.

### Leave scheduling separate

General schedules and orchestration remain separate proposals. A schedule would require its own authorization and fresh work admission for each run. Durable attempts consume this work model; they cannot introduce competing authority records or permission to replay historical effects.

Attached lineage supports ordinary child work without requiring a general scheduler. Logical work avoids tying valid child authority to the lifetime of a coordinator process or provider token.

## Completion and Delivery

### Admit finite delivery before closure

Completed-result delivery remains later scope. Where supported, bind the completed result to RFC 0037's finite, separately admitted delivery responsibility before logical Work closes. Delivery may be admitted with the original Work; binding content at completion must satisfy the admitted output contract. A report-delivery grant cannot authorize GitHub writes; direct push and PR creation require the selected write grant and their own current operation admission.

The exact audience, destination and original absolute delivery horizon cannot grow. Creating delivery responsibility after closure requires fresh admission.

### Authorize task and Agent controls separately

Initial root/helper cancellation requires authority withdrawal, physical stop evidence and terminal closure. The later Work lifecycle profile adds public Stop/Start controls and completed-result delivery. Their permissions remain separate wherever exposed.

Stop task targets one exact work and its owned helpers or admitted descendants. Own-task, shared-task and Agent lifecycle permissions remain distinct; permission to invoke the service or view its inventory does not imply permission to stop other work. Each new control requires current exact-resource authorization and attributable durable acceptance. Already-admitted protective cleanup retains its independent stop responsibility when ordinary continuation authority is unavailable.

Stop Agent durably blocks new work and drives stopping of affected work. Incoming messages, stale queued dispatch and controller restart cannot undo that intent. Start Agent is separately authorized and cannot bypass administrative disable, revive terminal work or replay uncertain effects. RFC 0037 owns physical termination and truthful status; stop acceptance alone does not prove observed termination.

### Distinguish graceful stop from cancellation

The default Stop action and any graceful-drain option need explicit product semantics. Where selected, graceful Agent stop preserves pending delivery of an already completed, authorized result. A trusted executor can deliver independently of the worker, using its own narrow identity and current content, audience, Channel and provider authorization. It cannot continue computation, reopen work or choose a fallback audience.

Cancellation or security revocation withdraws affected delivery even after the Agent stops. RFC 0037 owns finite drain and physical termination. Stop cannot extend work, lease or delivery horizons.

Authority withdrawal, process termination, provider revocation and accepted effects remain separate. Cleanup retains independent authority that can only reduce recorded access.

### Preserve the original effect and uncertainty

Completed-result delivery retries retain the original horizon, operation identity and outcome. A definitive no-effect result may permit a policy-approved delivery retry within remaining authority. Possible submission with an unknown outcome remains unknown until independently resolved; a new token, assignment or Work record cannot justify reposting the uncertain effect.

Possibly submitted business operations obey the same no-replay rule; RFC 0034 owns retained PR-key outcomes even after confirmed no-submission. Closure neither retracts an accepted effect nor proves it failed. Finite delivery avoids keeping a worker alive solely to post a completed report.

## Qualification Evidence

### Establish the actual boundary

This specification does not establish an implemented issuer, trusted transport or production guarantee. Qualification requires the actual Harness, verifier, connector, authority store, selected IAM suppliers and Kubernetes/gVisor runtime. Fixtures and declared interfaces cannot supply missing authority or writer-stop evidence. Protected-origin checks qualify their future authentication profile; the selected bearer path retains its copied-token limitation.

### Cover the required behavior

| Area                               | Required evidence                                                                                                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data and isolation                 | Shared-state eligibility, private-work isolation and denial of attempts to retarget a bearer to another grant or Work; copied live bearers retain the original grant's known limitation.                                                                                                     |
| Authority changes                  | Allow/deny, shrinking permissions, expiry and policy recovery without scope growth.                                                                                                                                                                                                          |
| Durable admission and effects      | Genuine root Work projected into inventory; duplicate admission, conflicting immutable PR inputs, current authorization before retained-result disclosure, one committed submission claim and independent finalization across closure/restart.                                               |
| Renewal and duration               | Finite leases for explicit uncapped work; finite configured caps retained across turns and provider-token replacement; missing policy denied and no automatic horizon extension.                                                                                                             |
| Preparation and helpers            | OCC-constructed, separately admitted read-only preparation handed to access delivery without borrowing execution material; observed preparation-writer stop. Helpers share root context, aggregate budget and cancellation, with demonstrated physical stop ownership.                       |
| Push and PR creation               | Explicit immutable read-write grant, read-only denial, current operation authorization, exact admitted repository, immutable request submission and no replay of possible effects. Destination ownership/visibility protection remains the accepted RFC 0034 gap.                            |
| Durable children and continuations | Work lifecycle: separate child admission, parentless renewal, ancestor cancellation, required joins and qualified continuation across fresh attempts.                                                                                                                                        |
| Controls and delivery              | Initial root/helper stop and terminal closure; separate exact-resource control permissions wherever exposed. The Work lifecycle stage adds richer controls and selected graceful delivery, with exact audience and cancellation withdrawal.                                                  |
| Outage and restart                 | GitHub reads, writes and maintenance denied without current OCC authority; any future qualified-read profile distinguished from writes and admission; preserved deadlines, stale-issuer fencing and measured withdrawal for each selected profile.                                           |
| Assignment and replacement         | Initially: fresh Pod on changes to admitted permission scope, denial of old assignments while credentials remain valid, and observed old-writer termination before any successor writes retained state. Work lifecycle: qualified continuation of the same Work across replacement attempts. |

Unknown provider outcomes must remain unknown rather than becoming manufactured successful retries. Audit preserves attribution and safe references while excluding credentials and message bodies.

## Unresolved Questions

- Which shared-data classes, membership administration and isolation evidence qualify the initial baseline?
- Which selected IAM policies govern continued invocation eligibility, requester withdrawal and audience checks?
- Which compartment and writer-stop evidence qualifies the selected Kubernetes/gVisor Harness?
- What numerical lease profiles, clock assumptions and issue/revoke protocol meet measured withdrawal targets?
- Which original invocation, State, execution and custody suppliers will complete and qualify the initial root Work flow?
- Which runtimes can demonstrate complete physical stop custody for subordinate helpers?
- For later stages, which child join, allowance and delivery-horizon policies should be admitted, and which Stop/graceful-drain semantics should be selected?
- For a later outage profile, which reads and providers can qualify bounded read-only credential maintenance?
- How should service-owner admission integrate with existing original-requester dependencies without weakening their cancellation or withdrawal behavior?
