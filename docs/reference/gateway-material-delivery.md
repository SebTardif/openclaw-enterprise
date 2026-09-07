# Protected channel material delivery

The Runtime coordinator implements one bounded material disclosure from an already
consumed [Installation startup](gateway-startup-v1.md) claim. It exposes the
`@openclaw-enterprise/contracts/gateway-material-delivery-v1` metadata types and
`@openclaw-enterprise/occ/gateway-startup-v1/material-delivery` internal composition
factory. The factory is programmatic and has no accepting default participants.
Missing native authentication, original current selection or actual material source
returns `unavailable` before a material read.

This source does not install an endpoint or supply production credentials. The
original central current reader, dedicated native transport, IDN startup-handle
correspondence and CRD physical source must be composed by their original owners.
An actual Teams token supplier remains required for a Teams invocation. No model
credential, refresh credential, alternate provider or new issuer substitutes for it.

## Separate purpose and original identity

`read-selected-channel-material` uses a separate
`installation-channel-material-v1` profile and
`owned-child-stdio-installation-channel-material-v1` connection. Startup retains
exactly `consume-startup`, `read-current` and `read-operation`. The material call
has its own authenticated fixed recipient and is subordinate to the original
startup and Source lifetime; reconnecting cannot renew those lifetimes.

The request contains the original startup locator, immutable selection record,
consumed operation reference/digest/record version, and recipient record. Its two
closed uses are `startup-slack-pair` and `teams-invocation-token`. A caller cannot
select arbitrary material references. The original accepting participant resolves
and authorizes the exact selected material and versions before CRD reads them.
The request parser validates closed metadata using the original startup locator
and record grammar; parsing does not authenticate or authorize a request.

The Runtime checks correspondence against the actual current record held by the
original current owner: consumed head, original acceptance, original submitted
create and its binding, exact consume operation, recipient incarnation and process
observation, record and head versions, predecessor operation, selection, and create
effect. Installation process generation remains distinct from host runtime
generation. Native controller transport recipient remains distinct from the
Gateway recipient. Source registration and configuration remain separate records;
no equality with a native profile source reference or bootstrap configuration
version is inferred.

## Held current scope and disclosure

`createGatewayMaterialDeliveryV1` captures three original collaborators:

- `native.inspect` authenticates the exact private call, full request and original
  bounds and returns the original connection lease.
- `current.withCurrent` enters one original owner scope, supplies its protected
  consumed current record and opaque selected-material value, and holds applicable
  authority, currentness, selection and process responsibilities throughout the
  callback. It must return that callback's exact outcome after joining its work.
- `source.readSelected(scope,use)` receives that SAME held scope, reads only its
  original selected material for the requested use, and returns a joined encoded
  borrow under a release obligation. Selected data and a signal cannot reconstruct
  the physical source owner capabilities.

`GatewayMaterialReadScopeV1<TSelected>` requires synchronous current assertions,
fresh asynchronous current rechecks, remaining lifetime, and
`confirmDisclosure`. The latter completes the original mandatory metadata-only
audit/transaction disposition before disclosure while retaining the applicable
current leases. An ordinary `read-current` result whose leases have already closed
cannot implement this scope. The generic selected type belongs to the original
material producer; OCC does not duplicate the credential or Secret schema.

The coordinator rechecks after acquiring the scope, after the material read, and
after disclosure confirmation. The fixed native writer allocates its single bounded frame inside
`withEncodedPayload`, uses the supplied `encodeInto` capability on its payload view,
then awaits `confirmDisclosure` and synchronously calls `consumeDisclosure` with
the exact private permit, lease, header and payload-capability identities immediately
before writing. The original mandatory confirmation therefore follows encoding. The permit is one-use and only exists
inside its original active callback. It cannot be constructed from a serialized
flag, copied DTO or type brand. A skipped or mismatched consumption cannot yield a
`delivered` result. The trusted native implementation owns the actual enforcement
at its write boundary; a caller-supplied native implementation is not authority.

No second durable startup consume, material claim store, alternate transaction
owner or new currentness clock is introduced. The original current owner must
poison caught or unawaited participant failures in its own transaction and drain
accepted work. The coordinator also refuses repeated, delayed or unawaited scope
entry and retains pending callback work before closing its native lease.

## Bounds, buffers and cleanup

The original absolute deadline is forwarded unchanged. The coordinator limits
local work to the minimum of that remainder, all supplied original lease
remainders and five seconds, using a monotonic elapsed-time bound as well as the
original deadline. Synchronous assertions must return exactly `undefined`;
thenables are rejected, observed and drained. Asynchronous recheck, confirmation,
disclosure and cleanup methods must settle with `undefined`. Invalidation cannot
revive a call or extend its deadline.

The dedicated native mapping uses a binary encoded CRD bundle of at most 28 KiB,
metadata header of at most 2 KiB and complete frame of at most 32 KiB.
`withEncodedPayload(work)` holds the actual CRD borrowed-use interval and provides
exact encoded `byteLength`, actual live source `backingByteLength` and a synchronous
`encodeInto(target)` capability. Runtime never allocates an encoded payload. It
requires a nonempty encoded length within 28 KiB, source backing within 32 KiB,
and an exact ordinary mutable target view backed by the native frame within 32 KiB.
Shared targets, oversized backing, repeat encoding and encoding outside that
interval are refused. CRD owns the real codec, length preflight and disposal; its
callback must reject unknown use instead of translating `recovery-required` into
fulfilled `undefined`.

The explicit endpoint allocation bound is two live application-owned payload/frame
allocations and 64 KiB at EACH fixed endpoint: Controller TypeScript, Controller Go,
Gateway Go and Gateway TypeScript. The conservative complete-call bound is eight
allocations and 256 KiB. Controller TypeScript counts the physical source backing
and native encoding frame; Go receiving/sending frames count, as do Gateway frames.
Pipe copies are not free. The original native and CRD composition must verify its
actual allocation, streaming and backpressure behavior against those bounds.
No endpoint may silently allocate a third payload or treat this as a new queued
call allowance. There is no base64/JSON secret payload, truncation or duplicate
encoding. Local checks do not prove another component's accounting. Provider/SDK
strings and native TLS/OS internal buffering remain separately disclosed and are
not claimed erased. Original 32 KiB selected-item and five-second bounds remain.

Each coordinator admits one active call. Its WeakMap/WeakSet membership enforces
only local one-use, never durable cross-process replay protection. Before entering
`withCurrent` work, the genuine original accepting owner must admit the one initial
Slack bundle attempt or an independently authorized later Teams invocation. Unknown
or failed original delivery cannot be repaired by changing requestRef, reconnecting
or reminting a child. This exact attempt/current producer is still unprovided here;
no second store or global one-use-per-startup rule is implemented. Distinct later
qualified Teams calls remain possible only with their actual original authority.
The same private proof cannot retry a finished attempt. Deadline or currentness loss may return a refusal while a late
read or write is still settling; the slot stays occupied. `close()` is idempotent,
refuses new work and joins that retained settlement. Acquired native `close` and
bundle `release` methods are captured before other fallible acquired-object
accesses. Bundle release follows disclosure settlement; native close follows the
current owner's callback and cleanup. CRD retains disposal and any consumer joins.

`delivered` means the bounded original write settled and its local cleanup
completed. It does not mean Slack/Teams accepted a request, physical process
termination occurred or a successor may start. A disclosure attempt with an
uncertain write or failed cleanup returns `recovery-required`; it cannot be
retried using the same proof. Normal cleanup invalidation does not erase already
settled delivery history. No payload appears in an outcome, metadata audit,
operation readback or diagnostic error.

## Verification and remaining composition

Run the focused controlled suite with:

```sh
node --test --test-concurrency=1 tests/conformance/gateway-material-delivery.test.mjs
```

The strict public-subpath consumer is
`tests/fixtures/gateway-material-delivery-v1/tsconfig.json`. It inherits the
repository's `strict: true` and `skipLibCheck: true` settings and includes negative
purpose, permit, selected-source and secret-header cases.

The tests execute the real local startup owner to produce coherent accepted,
submitted and consumed history, then exercise the real material coordinator with
controlled current, native and binary-source collaborators. They check exact
correlation refusal, invalidation during waits, once-only disclosure, bounded
buffers and joined late cleanup. They do not execute native TLS, PostgreSQL,
Kubernetes Secret reads, an external token supplier or a live provider. There is
no production configuration switch that replaces those missing participants.
