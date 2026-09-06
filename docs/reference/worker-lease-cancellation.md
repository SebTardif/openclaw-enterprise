# Worker lease cancellation

The installed controller worker uses
[`LeasedEffects`](../../apps/controller/src/worker/leased-effect.ts) to renew its
existing queue claim before each external operation and to pass cooperative
cancellation through the selected Driver's abort-signal bridge. The worker
factory supplies its existing queue, lease duration, and abort bridge; this
behavior requires no additional configuration.

An already cancelled worker run cannot renew its claim or start another effect.
The wrapper checks cancellation immediately before renewal and after the
heartbeat settles. It also checks after registering its cancellation listener
and immediately before invoking the effect callback, including when the abort
bridge delays that callback. Cancellation observed in either gap prevents the
effect from starting.

While an effect runs, periodic heartbeats remain serialized. Once cancellation
or claim loss is observed, queued callbacks stop issuing new heartbeats. A
heartbeat already in flight is allowed to settle. The wrapper drains that
pending heartbeat work before returning, clears its timer, and removes its
cancellation listener.

Missing or expired claims and cancellation continue to use the existing
`WorkClaimLostError` class, so the worker runner retains its claim-loss
classification. Separate error instances may be constructed. An initial
heartbeat rejection continues to propagate its original error. Ordinary effect
results and errors remain unchanged while the worker retains its claim.

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
