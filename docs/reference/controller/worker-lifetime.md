# Worker lifetime and finalization

[ControllerWorker](../../../apps/controller/src/worker.ts) retains the public
construction, startup, shutdown, and selected Driver lifecycle. It composes seven
internal modules. The [runner](../../../apps/controller/src/worker/runner.ts) polls,
recovers stale claims, dispatches work, and reports health.
[Namespace reconciliation](../../../apps/controller/src/worker/namespaces.ts) and
[revision reconciliation](../../../apps/controller/src/worker/revisions.ts) preserve
the exact claim, original actor, resource scope, and immutable admission checks.
[Revision inputs](../../../apps/controller/src/worker/revision-inputs.ts) resolve
current authorization, Provider bindings, and scoped Secret projections;
[cleanup](../../../apps/controller/src/worker/cleanup.ts) performs the ordered
activation, predecessor retirement, and maintenance effects.

Each worker instance permits one start attempt. `start()` records that attempt
before awaiting Installation loading, IAM validation, or Compute preflight;
concurrent or repeated calls reject. `stop()` immediately requests cancellation
and returns the same shutdown promise to every caller. It joins any pending
startup, the runner, and the owned state's supplied pool-close capability once.
Stopping during startup suppresses later startup stages, dispatch, and
`worker.started`; the interrupted start resolves after its current stage settles
unless that stage fails. Startup failures retain their original error, and a
subsequent or concurrent stop still performs cleanup. A stopped worker cannot
restart; create a new instance. Selected Drivers remain caller-owned.

The executable awaits startup sequentially; the concurrency contract applies to exported worker callers.

Each effect uses [LeasedEffects](../../../apps/controller/src/worker/leased-effect.ts)
to renew the claim before calling the Driver and serialize periodic heartbeats.
Claim loss or shutdown propagates cooperative cancellation to the active effect;
its lease scope drains pending heartbeat work before returning. Composition
supplies narrow repository callbacks and frozen projections of explicitly
selected, bound repository and queue methods. These projections restrict both
the TypeScript interface and the runtime method surface.

[Finalization](../../../apps/controller/src/worker/finalization.ts) alone owns
lifecycle publication, audit writes, and queue outcomes. Namespace publication
and completion share one queue-bound transaction. Revision success preserves the
staged sequence: compare-and-set the active revision in the first transaction,
perform applicable activation and retirement effects, then recheck the claim,
Agent principal, and active revision before recording the activation audit and
completing work in a second transaction. Activation required before the first
commit remains in revision reconciliation. Failed intervening effects retain
the existing pending and recovery behavior.

Each finalization transaction returns its applied disposition. Completion events
are emitted only after that transaction commits and describe the queue outcome:
`success`, `pending` for deferral, `retry`, or `permanent`. An active-revision
conflict reports `ACTIVE_REVISION_CHANGED`; at the shared queue attempt limit it
reports permanent failure. Revision activation success waits for cleanup and the
second transaction. A lost claim or failed transaction emits no completion.
Maintenance reports the current item's actual outcome even when it schedules a
replacement observation.

For contributor checks, see [controller testing](../../testing/controller.md).
