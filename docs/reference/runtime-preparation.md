# Retained runtime preparation

The OCC platform store retains a preparation's complete closed plan, exact provider
request bytes, binding proposals and local closure history. This is an internal
repository available through `PlatformUnitOfWork.runtimePreparation`; read views
expose its three history methods. It has no HTTP endpoint or startup option.

PostgreSQL retention records durable intent and data; the memory adapter remains
process-local. Retention does not admit a provider operation,
submit a request, establish current service authority, complete a fence or authorize
a writable successor. The authenticated runtime authority service preserves its
existing mutation and purpose denials until those accepting dependencies exist.

## Reference chapters

- [Runtime preparation admission and closed gates](runtime-preparation/gates.md): Effect admission consumer; Canonical closed gate and fault retention.
- [Runtime preparation records and recovery](runtime-preparation/retention.md): Repository operations; Bytes, replay and recovery.
- [Runtime preparation transactions and submission](runtime-preparation/submission.md): Transactions and verification; Selected node-network observation.
