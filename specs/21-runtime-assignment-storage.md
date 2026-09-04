# Runtime assignment storage

Status: implemented internal persistence foundation. The current behavior is
specified in [controller reference](../docs/reference/controller.md#internal-runtime-intent-and-allocation-records).

## Scope

Add immutable runtime intent history, a compare-and-set current intent head, and
immutable unbound allocations to the existing memory and PostgreSQL unit of work.
Ownership follows the initialized Installation and exact Namespace/Agent/admitted
revision. A ready Namespace is required for mutations. The per-component runtime
generation advances under transaction locking across lifecycle changes.

Callers retain opaque transition/effect locators before their transaction starts.
Unknown commit acknowledgement is recovered with scoped exact readback. Allocation
effect replay requires unchanged immutable inputs and never allocates twice.
History and allocation rows cannot be updated or deleted by the application role;
head mutation is restricted to its next exact history key. Audit and storage
changes share the existing transaction boundary.

## Verification and boundaries

Shared behavioral tests exercise the real memory and PostgreSQL adapters. Database
tests cover competing transactions, ownership constraints, restricted grants,
immutable rows, restart readback and a loopback PostgreSQL protocol proxy that
withholds the real COMMIT acknowledgement.

This change adds no endpoints, IAM actions, queue kinds, Driver effects, runtime
binding, active assignment, stop enforcement or guest enrollment. The later
lifecycle integration must supply authorization and execution behavior; stored
intent modes alone do not implement them. Existing deployment behavior remains.
