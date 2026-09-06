# Runtime activation and exact predecessor retirement

`@openclaw-enterprise/occ/runtime-activation-v1` exports a bounded in-process consumer of the original Runtime assignment, effect, workspace and containment ports. `RuntimeActivationOrchestratorV1` sequences complete selected inputs, current readiness resolution, control evaluation, prior-writer release, exact store verification and a conditional route request. It also sequences authority retirement, route withdrawal and exact retained-state cleanup through separately authorized cleanup calls.

This component has no production composition. Real protected profile selection, current assignment authority, authenticated observations, accepting-boundary guards and original owner persistence are still required. The actual service remains unavailable where its existing producers are absent. Controlled tests exercise protocol correspondence and sequencing; they do not establish a live workload, PostgreSQL persistence, physical termination or admission authority.

## Activation inputs and current observations

The caller supplies the complete admitted runtime and containment profiles and all eight selected control expectations before observation. Missing selection, a partial or conflicting control set, a changed target or an incompatible cursor refuses before invoking the containment observer or evaluator. Serialized identifiers and producer references do not authenticate their source.

The containment path accepts only the original bound `occ/kubernetes-gvisor` Harness input with `readiness-probe` authority. Gateway, prebinding, cleanup and completed-context restore are outside that evaluator's selected scope. Their original interfaces remain separate. The implementation imports the accepted control codecs, evaluator and fault adapter; it adds no alternate evaluator or default profile.

Activation checks exact assignment, revision, lifecycle/runtime generation, binding and plan correspondence. It requires the original full prior-writer release, its canonical owner snapshot reference/version, exact reservation and stores, and individually verified store observations. Partial closure, ambiguous execution, stale observations or unavailable store evidence cannot authorize a route. Original observation times remain intact. The accepting effect provider must independently check its original current authority, claim, gate, complete target plan, cutoff and provider preconditions when it accepts the effect; a satisfied comparison does not replace that transaction.

Current readiness and the original evidence are checked again after awaited workspace work. The final route submission also rechecks evidence after retaining its operation. The original conditional route request includes the exact provider target, UID/resourceVersion predicate, generation and original effect identity. An observed route result must correspond to that complete request and include fresh effective route evidence. Even then the result says `serving: "publication-unavailable"`: publishing serving still belongs to the original lifecycle owner after the required composed observations agree.

## Protected continuation and uncertain outcomes

`RuntimeActivationStateV1` carries the original evaluator history/cursor, a monotonically increasing local continuation version, a closed-activation flag and at most eight exact retained operations. The component has no state initializer or reset function. The actual owner supplies a protected serialized continuation and implements `RuntimeActivationOwnerV1.checkpoint` using its existing persistence and exact previous-state/version comparison. This required consumer port is not a new store, authorization token or replacement worker claim. Caller-created state is not a production substitute.

Every possibly submitted effect, authority retirement or fault is retained before invoking its original acceptor. Retention uncertainty returns the immutable proposed state with `stateRetention: "unknown"` and prevents further effects. The owner must recover that exact proposal before advancing; it must not treat the returned prior state as proof that no transition committed. Provider response loss retains the full original operation as `readback-only`. A fresh independently authenticated call can invoke `readOperation`; not-found, unavailable or mismatched readback never proves non-submission and never permits automatic replay or replacement identity.

Invalid state, bounded-capacity exhaustion, clock rollback and unresolved effects deny advancement. Invalid input is not replaced with empty evaluator history. Owner state must remain serialized across processes and restarts; the supplied test owner is an in-memory controlled peer only.

The original caller context, request reference, recipient and UTC deadline are forwarded unchanged. A derived abort signal enforces local waits, with three-second authority/readback/owner waits and ten-second provider waits, all bounded by the original deadline and monotonic elapsed time. Cancellation, timeout and a late response preserve possible-effect truth. These local waits change no provider grace period or physical termination policy.

## Retirement and independent cleanup

Retirement consumes the exact original target, binding version, current-selection precondition and retained cleanup responsibility. A fresh cleanup service call resolves the applicable `remove-route` and termination/removal purpose; it does not require the target SVID merely to authenticate the independent cleanup service or require the original human grant to remain live. Applicable current cleanup responsibility, original expiry, provider predicate and successor exclusion checks remain mandatory at their original acceptors.

The sequence retires original authority, observes conditional inactive routing and then requests exact UID-bound cleanup while retaining shared stores. The retirement receipt alone asserts no termination. An observed cleanup result is accepted only with exact execution/binding correspondence and fresh termination evidence. The returned `termination: "observed"` describes the supplied original provider result, not an independent observation made by this module.

If any step becomes uncertain, only its original retained operation can be read back. This bounded component does not automatically resume later unsubmitted steps after a process restart: it has no supplied durable complete retirement plan or retry authority. The actual original owner must retain and recover that plan before such a continuation can be implemented. No new cleanup IDs, successor targets, replacement stores or guessed absence are created here.

## Faults and remaining integration

`requestFault` requires a complete original Runtime fault and exact expected correspondence. It delegates to `ContainmentFaultRequestAdapterV1`, preserves the original operation and marks activation closed before submission. An accepted fault requests durable denial/stop through the original sink; it is never converted into physical-stop evidence or a second cleanup executor. Unknown fault outcomes use exact readback.

ISO-01's actual selected profile and protected evidence, CTL-03's current assignment/preparation producers, CTL-04's real worker/acceptor guards and the original continuation/serving owner remain required for integration. Actual gVisor/SPIRE, no-old-writer, endpoint/control and effective-routing proof stays at the existing runtime/component acceptance boundaries. This leaf enables controlled executable sequencing without claiming those prerequisites are complete.

Related definitions: [runtime authority](runtime-authority.md), [runtime effects](runtime-effects.md), [containment controls](containment-controls-v1.md), and [containment evidence](containment-evidence-v1.md).
