# Lifecycle work codec and preflight

The OCC lifecycle work codec serializes the existing `ReconcileAgentLifecycleV1`
input. The preflight reloads the original queue record, operation, admitted
association and current intent before a consumer binds a driver. These modules
are library contributions. They do not register a queue kind, change queue
constraints or enable a lifecycle handler or API capability.

Import the two supported package leaves:

```ts
import {
  encodeLifecycleWorkV1,
  decodeLifecycleWorkV1,
} from "@openclaw-enterprise/occ/lifecycle/work-codec-v1";
import { LifecycleWorkPreflightV1 } from "@openclaw-enterprise/occ/lifecycle/work-preflight-v1";
```

The wire object contains exactly `schemaVersion`, `handler`, `namespaceId`,
`agentId`, `operationRef`, `lifecycleGeneration` and `workId`. Version 1 uses
`ReconcileAgentLifecycleV1` as the handler label. The transition locator and
original work idempotency identity remain distinct. Encoding has a fixed field
order; decoding accepts JSON member order and whitespace without accepting
duplicate decoded keys, unknown fields, invalid UTF-8, a BOM, shared backing
bytes, malformed identities or unsafe counters. Inputs are bounded by the
canonical admission contract's 65,536-byte limit. The codec returns frozen inert
data and a fixed `LifecycleWorkCodecErrorV1` for invalid input. Payloads cannot
supply actors, claims, authority, selected peers or runtime URLs.

Construct `LifecycleWorkPreflightV1` in the server-owned worker composition with
the Installation ID, clock, accepted `LifecycleWorkerReadPortV1` and a read-only
`readQueue` adapter. The adapter must read the exact original operation and
`ControllerWork` row under independently authenticated service custody. It must
not implement its read by calling `heartbeat`, which renews the lease. The
existing queue has no public read-by-ID method; this module installs no adapter.

Call `inspect(wire, originalAssociation, call)` using the separately retained
server association and the existing `LifecycleHandlerCallV1`. The association
must come from original admission custody or verified exact recovery, independently
of the delivered payload. The canonical lifecycle reader verifies actual stored
owner, actor, request, revision, audit and work correspondence. A supplied
structure or matching serialization does not establish that provenance. The
preflight forwards original context, request, recipient and authenticated
deadline; each local lookup is bounded by three seconds and the remaining
enclosing deadline. `maxLookupMs` may tighten that ceiling.

The result has three forms:

| Result             | Meaning                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `snapshot-matches` | The loaded original installed deploy work, association, head and unexpired claim agree. The result includes copied original input and association.                 |
| `rejected`         | The input is malformed, the owner does not match or an original association/queue identity was substituted. No replacement operation is selected.                  |
| `unresolved`       | Head or claim changed, a transition is unsupported, a dependency failed, or the call was cancelled or expired. The original input and association remain attached. |

Only the existing original revision-backed deploy correspondence is supported.
Protective transitions, resume and maintenance identities require coordinated
queue and handler implementation. Their schema definitions do not make them
dispatchable here. A terminal duplicate cannot pass the claim check. A fresh
preflight instance reloads state and does not invent a new attempt or work ID.

Matching snapshots grant no effect authority or lease. Queue and lifecycle reads
are separate observations; a claim can change during the later lookup, and
either state can change after return. Every receiving effect boundary must still
perform current claim, intent, original actor/reference/profile authority and
generation/object fence checks. A test consumer's second inspection demonstrates
suppression of an intervening change; it does not replace the actual provider's
atomic guard. Read cancellation and lease expiry do not prove that a previous
provider call, process or writer has terminated.

The worker retains original uncertain effect and exact cleanup responsibility
independently of preflight. A `snapshot-matches` result cannot justify resubmitting
an uncertain create or releasing writer exclusion. Superseded or cancelled
running work cannot prepare, activate or repair execution. Late-created and
inactive candidates still require exact original cleanup under fresh independent
service authority; this module neither cleans them nor changes their target,
effect locator or responsibility. Cleanup cannot target a successor, resume or
purge. Missing physical/provider evidence remains unknown.

Run the focused pure checks and compile-only consumer from a prepared checkout:

```sh
node --test tests/conformance/lifecycle-work-preflight-v1.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/lifecycle-work-preflight-v1/consumer.tsconfig.json --pretty false
node --test tests/integration/lifecycle-work-preflight-v1-repositories.test.mjs
```

The repository suite uses actual OCC memory admission/history/audit repositories;
its memory claims are explicitly synthetic. PostgreSQL cases require
`OCC_TEST_DATABASE_URL` for an allocated, migrated loopback test database with no
competing queued work. They exercise real queue leases, terminal duplicate
delivery, restart, immutable admission recovery and post-preflight claim/intent
changes. Without that variable PostgreSQL cases are skipped and provide no
database evidence. Genuine repository imports also need the repository's existing
supported runtime dependency closure. No provider or native runtime is started
by these tests, and their results do not qualify real currentness, cleanup or
physical termination.
