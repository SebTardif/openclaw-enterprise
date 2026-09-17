# Credential Lifecycle Acceptance Matrix

Draft supporting specification for [RFC 0034](../0034-github-app-credentials.md).
See the [series index](../README.md) for scope and the other contracts.

## Acceptance matrix

The MVP requires the checks below for its single-repository, bearer-authenticated
read/read-write profile. Unsupported operations deny. G2, G5 and O2 describe
separate future/development profiles and do not gate this MVP. Stronger
ownership/visibility checks remain a known gap, not an unfulfilled acceptance gate.

Ship one active gateway with observed predecessor stop before replacement and
downtime permitted. Qualify concurrent requests and identical-version restart
against real PostgreSQL; multi-replica operation and overlapping rollout are
deferred. Controlled checks retain the supported protocol, authority, credential,
uncertainty and recovery cases below. Installed evidence covers one pinned
Kubernetes/gVisor/client profile, containment, closure and bounded restart; G1/E1
define the live GitHub minimum. Broader live fault, force/delete, rotation, upgrade
and interoperability campaigns are deferred, without dropping controlled safety
coverage or the required runtime-authentication supplier handoff.

| ID           | Required evidence                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------- |
| C1–C5        | Current authority, fixed-profile issuance, two-slot renewal, cleanup and immutable grant changes. |
| S1 / P1      | Root Work, original execution binding, cancellation and qualified shared helpers.                 |
| G1 / G3 / G4 | Live read/write scope, exact destination binding and durable push/PR outcomes.                    |
| R1           | Separate read-only preparation and observed writer handoff.                                       |
| M1–M3        | Bearer guarantee, installed containment and closed protocol catalog.                              |
| O1 / E1      | Recovery, executable recipes and the regular Agent workflow.                                      |

### C1: Authority

- Deny forged/cross-Namespace references, stale revisions/assignments, closed
  leases and wrong Work; allow legitimate current operations.
- Authorize the administrator's exact Agent/Configuration mutation and every
  binding/broker/Secret reference. Draft save grants nothing. Freeze one private
  repository, checkout, profile and generations; reject multiple repositories.
- Verify `read` default and that existing read-only records do not acquire writes.
  Invocation permission and App-wide installation scope grant no repository access.
- Exercise genuine Work/IAM/custody owners; IDs or reconstructed handles cannot
  supply authority. Separate grants retain independent leases and obligations.
  Work closure closes its leases; a model turn ending alone does not.

### C2: Issuance

- Use one gateway with real PostgreSQL. Concurrent mint requests and restart
  retain one original claim and at most two aggregate outstanding slots.
- Verify the exact immutable read/write profile and numeric repository returned
  by GitHub. Write-grant reads reuse its write profile; preparation stays read-only.
- Reserve before issuance, commit protected material/inventory before use, and
  reconcile lost acknowledgements without remint or premature exposure.
- Unknown attempts, provider-valid retired tokens and late captures remain
  charged. Rotation, aliasing, new leases or changed profiles cannot erase holds.

### C3: Renewal

- Cross provider expiry and model-turn boundaries under still-open Work.
- Exercise uncapped Work and configured finite horizons; leases and operations
  stay finite. Missing duration policy never implies uncapped authority.
- Retain one current token and at most one same-profile replacement. Current plus
  provider-valid retired material fills both slots and blocks another mint.
- Only definite no-issuance, confirmed revoke or evidenced expiry releases a slot.
  Worker-claim expiry and local retirement do not. Token replacement cannot
  extend operation/Work deadlines or create another business submission permit.

### C4: Cleanup

- Cancel during mint/delivery and exercise key rotation, withdrawal, deletion,
  lost cleanup claims and restart. Account for every known/uncertain token.
- Preserve original issuer settlement, late captures and independent cleanup
  authority after source-key/resource loss. A hash alone cannot revoke.
- Report local closure, observed withdrawal, provider cleanup and physical
  execution termination separately.

### C5: Scope narrowing

- Current IAM may deny/narrow operations within the fixed grant. It must not
  switch a read-write lease to a second read-token profile.
- Admitted repository/profile/Work changes require fresh admission, execution and
  Pod/gVisor isolation. Deny in-place changes and old-context reuse.
- Read-only access denies push/PR creation. Preparation never borrows execution
  credentials. Old inventory, receipts and target holds survive replacement;
  policy recovery cannot reopen closed authority or cleanup-only material.

### S1: Series integration

- Verify server-owned Agent/revision/assignment, root Work and enforcement lease
  independently; caller identity/Work headers cannot change the bearer binding.
- Cancellation denies new effects and retains cleanup. Register construction,
  Harness and helper-stop ownership before construction begins.
- Fresh assignment requires current authority and observed predecessor stop.
- Register independent finalization before dispatch; it survives disconnect,
  cancellation and deadline. Completed-result delivery remains a future product
  capability and is not needed to retain required receipts.

### P1: Persistent work

- Continue the same root across turns; closure blocks its queued/retried requests
  even when the process survives. A fresh execution cannot adopt old requests.
- Qualify helpers only with shared root scope, aggregate limits and stop ownership.
  Unsupported helper combinations deny while root-only execution may qualify.
- Deny mixed-authority reuse and unqualified cross-assignment continuation.
  Independently admitted durable children remain future scope.

### G1: Live provider

Use disposable private repositories and synthetic content to verify:

- Metadata, clone/fetch, allowed push and PR creation through real Agent callers.
- Exact returned token scope, read-only denial and observed revoke-then-deny.
- GitHub rules apply without App bypass. PR creation works without a preceding
  push by the execution; default `draft` is false and returned SHAs are observations.

### G2: Pinned native clients

Native delivery remains development/testing only. Its selected Git/CLI pins,
per-child delivery, exact scope, refresh and ambiguous-write non-replay require
separate evidence and cannot qualify the mediated production workflow.

### G3: Public publication

Verify private admission and exact numeric repository binding. Deny alternate
remotes, forks, cross-repository PRs and arbitrary mutation routes even when the
App has broader access. Ongoing ownership/visibility protection is a known MVP
gap: do not claim that becoming public closes outstanding access or accepted
writes. Use synthetic contents and report this guarantee boundary explicitly.

### G4: Direct push and PR creation

- Validate every update in the complete bounded command prefix and forward
  exactly those bytes. Permit valid tags, force, deletion and multiple updates
  subject to GitHub rules. Reject unbounded/malformed prefixes and PACK limits.
- Retain push unpack/per-ref outcomes; HTTP success alone is insufficient.
- Accept only the bounded canonical PR fields; reject duplicate keys, invalid
  encoding, unsupported fields, wrong repository and invalid branch names.
  Project safe results without whole provider objects or raw errors.
- Race concurrent requests with the same `(accessId, clientOperationId)`. The atomic
  claim/dispatch/closure transition admits one original receiver and one POST.
  Repeated keys need current authority; changed contents conflict without minting.
- Simulate lost request/result commits, provider timeout, cancellation and process
  death. Preserve not-submitted/known/unknown states without reconstructing a
  submission permit. Success requires known receipt commit; independent
  finalization survives request loss. No automatic replay or reconciliation POST.
- Preserve operation keys across lease/token replacement and closed-access
  retention. Fresh IDs do not imply a total PR-creation quota.

### G5: Later publication policy modes

Human-approved retained candidates, independent approvers and finer branch/object
policies need separate contracts and qualification. They do not gate this MVP.

### R1: Preparation/runtime

- OCC constructs separate read-only preparation authority and hands it to access
  delivery; a pending assignment or readiness flag alone fails.
- Verify repository and checkout OID before Harness startup; preserve user work.
  Observe preparation stopped before handoff and predecessor stopped before
  successor writes. A timeout or revoked token is not stop evidence.
- Test cancellation, same-Pod restart, replacement and deletion. Profile/context
  changes require a fresh Pod/gVisor sandbox. Pin runtime/image artifacts.

### M1: Bearer binding and copy limits

- Validate the bearer and resolve its original grant. From another reachable
  location, possession can exercise that still-authorized grant; physical-origin
  denial is not claimed. GitHub rejects the OCE bearer itself.
- Deny malformed, duplicate, unknown, expired or revoked credentials and attempted
  grant/Work/repository substitution. Closure denies the original token.

### M2: Boundary enforcement

- Keep installation tokens, App keys and CA keys outside execution. Deliver only
  the execution's OCE token and public CA; strip caller auth before upstream use.
- Prove installed DNS/routing and both TLS legs, with matching SNI/Host/routes and
  independent GitHub TLS verification. Inspect additive NetworkPolicies.
- Deny direct provider/issuance access, alternate credentials, CONNECT, upgrades,
  redirects and model/control-channel tunnels. No anonymous or native fallback.
- Verify response/log projection excludes provider credentials and protected data.

### M3: Protocol scope

- Run pinned Git metadata/clone/fetch/push and the bounded PR helper through the
  complete gateway. Validate buffered fetch requests, streaming limits and probes.
- Deny all unlisted REST/GraphQL routes, forks, PR update/close/merge and issues.
  Broader token permissions cannot enable new operations or fallback profiles.
- Prove the helper preserves its generated operation ID and never automatically
  submits with a new ID after uncertainty. General `gh pr create` is not selected.

### O1: Operations

- With valid tokens retained, make OCC unavailable and deny all new dispatch,
  including reads and mint/maintenance. Active exchanges stop on expired
  observations or database loss. Recovery cannot replay uncertain effects.
- Test unavailable custody/storage, throttling, restart and operator recovery;
  report actual outcomes and retained tombstones without exposing secrets.
- Load GitHub and an independently authored synthetic non-GitHub recipe through actual
  startup/interpreter and broker/State/IAM/Work without an OCE source edit. Execute
  a positive bounded operation against controlled services with supported
  authentication; exercise opaque identities, alias holds and separate service
  authority. Synthetic credentials do not establish live-provider compatibility.
- Reject unknown schemas, executable recipe content, unsupported combinations
  and unavailable authentication/download/remote modes before effects. The
  executable remote-broker runtime and control harness remain deferred.
- Pin one immutable version per bundle; verify identical-version restart,
  original cleanup after retirement and premature replacement/removal denial.
  Offline upgrade requires observed stop, verified request/finalizer and
  obligation drain, and compatible retained records. Unknown obligations may
  delay upgrade; record or key deletion cannot manufacture drain.

### O2: Read continuity

Offline read continuity and maintenance are future work requiring their own
finite authority, withdrawal and recovery qualification. The MVP denies offline
GitHub dispatch, including when a provider token remains valid.

### E1: Complete mediated profile

1. Pin one implementation, configuration, Kubernetes/gVisor runtime and client
   manifest with one active gateway. Enroll/admit through real OCC/IAM, broker
   and PostgreSQL; prove installed containment, closure and bounded forced-stop/
   identical-version restart with persistent State.
2. Prepare, activate and use a regular Agent to check out, edit/commit, push
   and create a helper PR against an admitted live GitHub repository. Retain
   exact artifacts, PR URL/head/base and workflow effects.
3. Observe bearer validation, current authority and protected upstream token
   substitution, scoped issuance, read-only push/PR denial, confirmed provider
   revocation and subsequent denial. Pre-start checkout alone does not prove
   this continuing Agent path.
4. Retain outcomes, cleanup and unresolved obligations. Controlled tests cover
   credential replacement, provider faults and uncertainty; installed tests prove
   closure, writer termination and restart. Old requests cannot acquire fresh authority.

Keep source, composed-component, installed-runtime and live-provider evidence
separate; no earlier layer establishes the next.

## Related specifications

- [Overview and contract](lifecycle.md)
