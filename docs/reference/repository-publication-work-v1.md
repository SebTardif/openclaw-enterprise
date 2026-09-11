# Publication Work authority

The publication Work owner holds the Work permission needed to prepare a scoped
push and draft pull request. It implements the publisher's
`PublicationWorkSourceV1` contract. Human approval, Git object custody, effect
claims, provider dispatch and independent outcome observation have separate
owners.

## Construction

Construct `RepositoryPublicationWorkOwnerV1` with one fixed original invocation
source, one fixed original State source, a protected clock and a positive
`maximumActive` limit. The invocation source must authenticate the controller's
exact actor and call against its genuine native invocation, selected service
and execution. Controller actor enrollment alone does not provide that native
association.

The State source supplies held admission and use leases. It recognizes the
original invocation, publication request and call; it owns SQL locks, private
admission/use receipts and durable recovery. The constructor captures its
methods once. Missing original methods refuse. Comparison data or a nominal
TypeScript brand cannot register a supplier.

`PublicationWorkPrivateBindingsV1` keeps actor, invocation, admission and use
types distinct. Its defaults are `never`. Supply the actual original types at
the trusted composition point. Do not cast an object into one of these slots.

The owner exposes:

- `acquire(actor, request, call)`: authenticate and obtain a private Work handle.
- `inspect(work, call)`: return a detached immutable publication binding after
  currentness checks.
- `assertCurrent(work, call)`: synchronously return `undefined` or refuse.
- `recognize(work, call)`: return the same known State admission retained by
  the original Work owner, for State's publication recognizer.
- `release(work)`: invalidate use immediately and join original retirement.
- `close()`: refuse new acquisitions and join all entered operations.

The call and request objects remain original objects. Their comparison values
are captured separately. A copied handle or call, a changed request body, or a
different original operation refuses.

## Admission and use

Acquisition follows this sequence:

1. Acquire and privately recognize the original invocation lease.
2. Retire its initial SQL readset through `prepareStateUse`. Only native
   membership is checked across this handoff.
3. Acquire State's held admission unit and validate the exact publication
   selection while its currentness is held.
4. Prepare and revalidate that unit. Only `commitAdmission` may advance to
   outer acknowledgement and terminal cleanup.
5. Require a known original committed admission. Unknown or refused outcomes
   return no publication Work handle; State retains recovery ownership.
6. Release the admission unit, acquire original current use and prepare it.
   Recheck the same admission, operation, request, policy and full readset before
   issuing the private handle.

The shared `WorkAdmittedExecutionV2` projection and
`compareWorkAdmittedExecutionV2` comparator describe service-owned Work,
requester, invocation, exact execution, complete ancestry and original horizons.
They support read/publication producer correspondence without changing the
existing metadata or Git-read owner. Their return values do not mint a State
admission or implement an absent invocation supplier.

Every later inspection checks held use and the original native association.
No currentness callback may return a Promise or another non-void result.
An entered asynchronous assertion invalidates use before its continuation is
joined. Restoring old comparison data cannot revive a poisoned handle.

## Closed publication policy

`parsePublicationWorkPolicyV1` accepts only version 1 policy with operation
`work.repository.publish`, permission `repository:publish`, and the ordered
actions `push`, `create-draft-pr`. It rejects unknown policy fields and extra
permission arms. Metadata V2 and Git-read V3 policies never authorize publication.

A policy names the exact Installation, Namespace, Agent revision, owning
service, execution profile and numeric GitHub repository. It supplies permitted
base/target branches, whether creation is allowed and explicit time limits.
This profile rejects attached child Work. It supplies no renewable child
horizon, universal lifetime or implicit permission fallback.

`publicationWorkPolicyDigestV1` hashes the decoded policy using the
`work-policy` domain of the publisher's canonical digest.
`publicationWorkExecutionDigestV1` uses its `execution-binding` domain.
`comparePublicationWorkSelectionV1` validates an admitted selection, original
invocation comparison, exact publication request and bounded clock reading.
Central can use these exports inside its actual held unit; it must still
authenticate the original objects independently.

Work compares complete root-to-current lineage, scope, revisions, withdrawal
revisions, open state, original horizons, execution and current policy. It binds
the requester, authority revision, operation/invocation and request digest.
Clock uncertainty, original call deadline, Work horizon, policy horizon and
authority horizon all constrain use. Trusted construction requires an original
`PublicationWorkClockV1`. Its reading adds two mandatory positive integer bounds
on top of `wallMs` and `uncertaintyMs`:

- `maxWallAdvancePpm`: the qualified maximum ratio of protected wall-time advance
  to this process's captured `process.hrtime.bigint` domain, in parts per million.
  This is the complete rate, not drift added to an assumed baseline.
- `validForMonotonicMs`: how long the original producer guarantees that initial
  upper time and rate, including clock adjustments and suspend behavior.

The reading must apply to a fresh sampling instant during that exact read.
Cached samples must first be advanced conservatively. An issued guarantee cannot
be retracted by later reads or source-health changes. Throughout its validity
interval, the original producer must guarantee:

```text
true time <= wallMs + uncertaintyMs + ceil(elapsedNs * maxWallAdvancePpm / 1e12)
```

Work captures the local start before entering each clock callback and before any
acquisition, conservatively including callback latency. Both the first fixed
sample and the latest sample must remain valid and below the original deadline.
No rate or validity default is provided; missing or invalid bounds refuse.
Copying numeric fields does not establish clock qualification. The original
clock producer and its exact monotonic-domain relationship remain required
construction inputs; the existing two-field clock contract alone is insufficient.

Initial admission, post-prepare validation and later currentness retain the first
clock-before-fence check. After the last clock read, they recheck original
native/State membership and recapture the same selection. The final comparison
uses only detached data and the captured local monotonic clock. Exact integer
arithmetic rounds projected time upward. The first anchor and deadline remain
fixed, so a later reading cannot renew the original validity interval or Work
horizon. Authority or timing failure permanently invalidates that Work handle.

## Cancellation and cleanup

Abort immediately invalidates currentness. Entered acquisitions, commit
continuations and asynchronous assertion failures remain owned until settled.
Each returned lease's release method is captured before its data is inspected,
including late leases returned after cancellation.

Release is idempotent and concurrent releases join the same cleanup. A failed
finalizer retains its original incomplete retirement; a later release may retry
that retirement without reacquiring Work or repeating a publication effect.
Successful retirements are not repeated. Independent historical outcome
observation remains with the publisher/State observer, not this closed user call.

## Verification and limits

The component cases in
`tests/conformance/repository-publication-work-v1.test.mjs` exercise the actual
Work implementation with explicitly controlled private invocation and State
peers. They cover publication/read separation, immutable comparisons, original
object recognition, currentness, unknown admission, cancellation and retirement.
They do not establish real controller/native enrollment, SQL COMMIT, GitHub
approval or provider dispatch. The constructor fixture checks actual exported
type correspondence when run by the receiving validation.

Component execution and exact input bindings are recorded with the source
handoff. Component clock models do not qualify a production host clock.
Production composition requires the original native/execution supplier,
original State implementation and controller enrollment, followed by coherent
receiving checks. Missing dependencies refuse; they are not completed by parser
success, fixtures or a copied State receipt.
