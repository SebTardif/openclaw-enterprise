# Authority leases and runtime qualification

Part of the proposed [workload identity enforcement specification](enforcement-spec.md).
Apply [identity, registration and request verification](identity-registration.md)
alongside these lease and lifecycle contracts.

## Outage operation

The GitHub gateway MVP requires online OCC authority for every operation,
including reads and credential maintenance. Cached provider tokens do not bypass
these checks. The following optional exception needs separate selection and
qualification as a future profile; finite leases alone do not enable it.

Writes, message posting, admission, renewal, expansion and reassignment require
current authority. Only qualified application reads may continue during an
authority outage under an existing unexpired lease. Eligibility follows operation
semantics, not HTTP methods.

Protected origin, complete local revocation state, trustworthy time and all
mandatory evidence remain required. OCC and the selected IAM authority retain
permission decisions. Read freshness and protected content versions need explicit
qualification; a resource lease does not authorize newly protected content.

This refines RFC 0027's current-authority and unavailable-state denial rules,
including SecretBroker access; its baseline stands until the refinement is accepted.

Credential maintenance may preserve read access only when preauthorized under
the same lease and qualified by RFC 0034. It cannot create work, expand access,
extend deadlines or permit application writes. Broader outage profiles require a
separate proposal.

## Lease issuance and ordering

OCC and the selected policy authorities issue leases for admitted original work,
using the root record in the initial stages and RFC 0036's hierarchy later.
Each lease records:

- Issuer and committed issuance version.
- Installation and Namespace.
- Work, immutable scope and the admitted finite-or-uncapped horizon selection.
- Exact assignment and generation.
- Intended accepting service and purpose.
- Applicable policy and ancestor scopes.
- Absolute expiry and synchronization requirements.

Issuance and renewal recheck current policy, workload eligibility and work/ancestor
closure. An authority service uses its own narrowly scoped identity; a certificate
or lease reference alone cannot authorize issuance.

Commit issuance and revocation in a defined authoritative order and fence stale
issuers. Revocation prevents subsequent affected issuance or renewal, including
descendants. Previously committed issuance returned late keeps its original
absolute expiry. Cached policy, delayed signing and future validity starts cannot
reset the interval from issuance commit.

Each selected IAM integration must establish its policy-observation and ordering
guarantees or remain unavailable for this profile.

## Lease bounds and ancestry

Execution duration defaults to uncapped under the selected initial policy.
Admission records that choice or an explicitly configured finite horizon;
missing or unverifiable policy state is not an uncapped choice. Logical work
may also have a finite or uncapped horizon. The admitted work and execution
horizons are immutable: renewal and reconnect cannot extend a configured cap.
Each enforcement lease still has a finite absolute expiry.

For issuance committed at `t`, expiry must satisfy:

```text
expiresAt <= min(t + maximumLeaseDuration, all applicable finite bounds)
```

`maximumLeaseDuration` is finite. An explicitly uncapped horizon contributes no
duration bound; any finite ancestor, purpose or stop deadline still applies.
Applicable bounds include:

- The issuance-time maximum.
- Any configured finite execution, original-work and ancestor horizons.
- Purpose and stop deadlines.
- Every applicable withdrawal target after clock and enforcement allowances.

Ordinary profiles may target minutes and sensitive profiles seconds. These are
tolerance scales, not chosen lifetimes or measured guarantees. A child cannot
weaken an ancestor's withdrawal target.

Fresh authoritative child renewal requires open, authorized logical ancestors,
not a running parent or a valid parent execution lease. Renewal cannot expand
scope, extend a configured cap or reopen terminal work. An uncapped horizon does
not authorize offline writes or replay of uncertain effects. Offline attenuation can
only narrow an existing lease and retains its expiry; it cannot admit children,
renew authority or reassign execution.

## Revocation and continuity

A trusted holder installs authenticated revocation state with complete scope
coverage and a monotonic cursor satisfying the lease's synchronization
requirements. Applying revocation and consuming authority must be locally ordered.
Gaps, rollback, incomplete scope coverage or lost clock continuity block affected
use until synchronization restores trustworthy state.

An initialized disconnected holder may continue only the qualified reads above.
Persisting a signed snapshot alone does not establish continuity after restore.
Concrete synchronization, retention and clock mechanisms remain implementation
choices requiring qualification.

Revocation acceptance, distribution, local observation and effective withdrawal
are separate outcomes. Effective withdrawal requires complete acknowledgements
from affected holders or proven expiry of outstanding leases, including
descendants and clock/enforcement allowances.

Qualified read leases trade a bounded withdrawal delay for availability during
authority outages. They cannot support an immediate withdrawal claim for an
unreachable holder.

Tightening a profile cannot retroactively shorten a disconnected holder's lease;
the tighter guarantee waits for affected old authority to end. Any bound measured
from an external IAM change also includes its observation delay. A bound from
OCC's observed revocation commit must be labeled as such.

Transient revocation entries may be removed only after no affected lease or
descendant can survive the applicable bounds and restore risks. Retain current
policy, permanent disable and terminal work state so collection cannot permit
fresh issuance.

## Dispatch and lifecycle

Dispatch permits bind assignment/generation, original work and authority version,
operation digest and evidence deadline. Connections and streams recheck purpose
before privileged dispatch or protected delivery. The accepting service rechecks
mandatory evidence at final submission; reservation or queuing cannot postpone
submission past the deadline. Offline allowance consumption requires qualified
preallocation and durable accounting; exhaustion cannot authorize fresh credit.

The effective dispatch deadline is no later than any applicable certificate,
verification-handle, enforcement-lease, work-horizon, approval, broker-access,
provider-credential or purpose deadline. Identity renewal and reconnect cannot
extend work, lease or drain deadlines. Previously admitted provider effects may
finish; record their outcomes separately.

Reconnects obtain new verification handles. Renewal cannot extend a handle's
original evidence lifetime; fresh authentication produces fresh evidence. Missing
trust, expired evidence, untrustworthy revocation state or terminal invalidation
blocks use; late success cannot reopen a closed stream.

Changes to admitted permission scope use the [fresh sandbox transition](identity-registration.md#execution-registration). Withdrawal of old
dispatch authority and physical termination are separate facts: denying the old
assignment is not proof that its processes stopped or relinquished shared state.

Retirement withdraws authority under the selected bound and preserves cleanup
responsibility; report retirement as effective only after that withdrawal is
established. Registration deletion and certificate expiry do not prove
termination. Compute resolves uncertain creates and observes predecessor
termination before any writable successor, including initialization or restore.
Cleanup survives Agent deletion under its own retained authority. Termination,
provider revocation and accepted effects remain separate outcomes.

## Runtime qualification

The first deployment targets Kubernetes. Qualify the GitHub gateway's bearer,
authority and lifecycle boundaries through the regular Agent workflow. Binding a
token to its original grant does not prove which container presents it. Accepting
these invariants does not establish installed-runtime qualification.

Runtime qualification must demonstrate:

- Exact grant and assignment binding for co-located workloads and restarts;
  copied live tokens remain bound to their original still-authorized grants.
- Renewal, reconnect and warm-stream behavior.
- Retired-execution denial while credentials remain valid.
- Increases or decreases to admitted permission scope using fresh Pod/gVisor sandboxes, with old
  dispatch denied and retained-state handoff checked.
- Finite lease expiry and current-authority renewal for explicitly uncapped work,
  with any finite ancestor, stop and purpose deadlines preserved.
- Online-only profiles denying affected dispatch when current authority is
  unavailable; separately selected read exceptions stopping at lease deadlines.
- Write, renewal and reassignment denial without current authority.
- Uncertain provisioning, deletion cleanup and uncertain predecessor termination.

Measure withdrawal from the profile's declared start point, including
policy-observation, issuer-fencing, clock and holder-enforcement delays. Record
authorization closure, connection closure, physical stop and external revocation
separately. Unit fixtures cannot establish installed-runtime qualification.

Optional SVID/protected-origin profiles additionally require distinct authenticated
sandbox callers and registration-timeout recovery. Host process IDs, shared labels
and SPIRE selection alone do not establish gVisor origin. Each attestor and
transport remains unavailable until its mechanism is specified and demonstrated.

The following mechanism questions remain unresolved for their respective profiles:

- For protected-origin profiles, which gVisor attestation and transport mechanism
  proves the originating execution?
- Which protocol orders lease issuance, purpose withdrawal and accepting-service
  enforcement, including disconnected and restarted holders?
- Which read operations qualify for outage continuation, and what measured
  withdrawal bounds apply to each profile?
- What certificate, handle and lease lifetimes meet those bounds, and how are trust
  configuration and explicit profile migration qualified?
