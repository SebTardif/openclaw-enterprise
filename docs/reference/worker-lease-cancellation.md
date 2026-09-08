# Worker lease cancellation

The installed controller worker uses
[`LeasedEffects`](../../apps/controller/src/worker/leased-effect.ts) to renew its
existing queue claim and carry cooperative cancellation through the selected
Driver's abort-signal bridge. Running revision effects require `runRevision` and
the original execution's
[`WorkerRevisionCurrentness`](../../apps/controller/src/worker/revision-currentness.ts).
Each currentness check reads the original admission and retained intent against
a fresh head; it never turns those records into account or provider authority.
The existing `run` path remains for Namespace effects and separately classified
legacy cleanup. The installed worker's original pool supplies a 250ms acquisition
timeout for the bounded currentness reads.

An already cancelled run cannot renew its claim or start another effect.
Running revisions check currentness before and after renewal and around the
effect wait. The same owned callback checks the wrapper's first-failure latch at
the preparation-to-activation or deactivation boundary. A provider that ignores
abort and returns late cannot start that next stage after observed claim loss,
even when its revision's intent head is unchanged.

While an effect runs, periodic renewals remain serialized. The first observed
cancellation, claim loss or revision-currentness failure stops queued renewals
and aborts the operation signal. Once the effect settles, the wrapper clears its
timer and listener, then joins pending heartbeat work. Later errors cannot replace
its latched first failure. No database lock spans a Compute wait.

Missing or expired claims and cancellation retain `WorkClaimLostError`, including
cancellation during a rejecting currentness read. A changed running intent uses
`WorkerRevisionCurrentnessLostError` and suppresses stale running effects and
successful publication. A live signal's repository error remains unchanged;
ordinary namespace and legacy cleanup behavior retain their existing path.
These checks neither authorize retirement nor create a new queue terminal state.

Cancellation is cooperative. An effect that has already started may have changed
external state even if the wrapper later reports claim loss. The wrapper waits
for the effect and pending heartbeat to settle; it does not establish provider
termination, absence of an effect, durable cleanup acceptance, or permission to
replay an uncertain operation. Queue completion and revision finalization remain
with the existing worker finalizer.

Run the focused cancellation checks with:

```sh
node --test tests/integration/worker-lease-cancellation.test.mjs
```

The suite executes the actual `LeasedEffects` implementation with controlled
heartbeat responses, cancellation timing, and an abort bridge. Its fixture
resolves that module's OCC import directly to the actual PostgreSQL queue module
to use the original `WorkClaimLostError` without loading the unrelated OCC
barrel and upstream SDK. This is a scoped component test, not qualification of
the full controller import graph, a live database lease, or a provider runtime.
The fixture does not replace the worker implementation or the queue error class.

See the [controller reference](controller.md) for worker reconciliation and
finalization, the [lifecycle worker guard](lifecycle-worker-guard.md) for the
separate current-intent and exact-effect boundary, and the
[testing guide](../testing.md) for infrastructure-dependent verification.
