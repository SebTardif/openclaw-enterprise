# Worker outcomes and lifetime

This implementation follows the authoritative [platform design](../docs/design.md).
The [controller reference](../docs/reference/controller.md#worker-implementation-and-verification)
owns current worker behavior; the [worker flow](../docs/flows/controller-worker.md)
traces execution.

## Applied finalization outcomes

Implemented: finalization returns an explicit disposition from the owning
transaction. Operational completion records describe the queue operation that
committed, including retry exhaustion and active-revision conflicts. A failed
transaction or lost claim cannot publish a completion record.

Revision activation retains its staged ownership: renew the claim and lock the
Agent, compare and set its active revision, commit, perform required external
activation and predecessor cleanup, then renew and recheck ownership before
committing activation evidence and queue success. The change does not alter
Compute activation order, current authorization, transaction poisoning, queue
retry/backoff, or durable audit semantics.

## Worker lifetime

Implemented: the exported worker owns one startup and shutdown lifetime. It
records startup synchronously before any awaited work and rejects concurrent or
repeated start calls. Shutdown joins awaited startup and all owned work,
suppresses later startup stages, dispatch and the started event, and closes the
owned state through its supplied pool-close capability once. Every stop caller
joins the same shutdown promise, including when cleanup fails. Startup failures
retain their original error; shutdown still performs cleanup. Start after
shutdown begins is rejected. Selected Drivers remain borrowed and their lifetime
is unchanged.
The ordinary executable already awaits startup before registering shutdown
handlers; the concurrency correction concerns the exported worker API.

## Verification

Controlled capability tests exercise the real finalizer's event timing and
ordered calls. They do not emulate queue persistence. Real PostgreSQL tests use
an actual competing store transaction to change the active revision during a
controlled Compute effect, below and at the retry budget, both before activation
and before observation completion. They verify persisted queue/audit results and
operational events together. Without the selected application-role test database,
these cases skip explicitly and database qualification remains outstanding.

Lifecycle acceptance uses the actual exported worker and controlled injected
pool/Driver waits, plus the existing lease-cancellation and PostgreSQL worker
suites. Passive Drivers and local controls do not qualify live infrastructure.
