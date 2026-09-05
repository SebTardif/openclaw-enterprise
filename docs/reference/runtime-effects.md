# Runtime effects and observation V1

The contracts package exports versioned requests, results and strict value codecs for
conditional runtime effects, provider fences, runtime observations, retained-store
handoff and durable fault requests. Independent producer and lifecycle-consumer
examples compile against that public package entrypoint.

**These are interface definitions and conformance checks.** This module does not
implement a Kubernetes client, a mutation acceptor, a database journal, a runtime
observer or physical termination. A parsed record establishes shape and intrinsic
consistency. The actual accepting services must independently establish provenance,
current authority and the physical facts required by each positive result.

## Exported surface

Import from `@openclaw-enterprise/contracts`:

| Interface                    | Operations                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `RuntimeEffectsV1`           | `create`, `discover`, `observe`, `setRoute`, `stopRetainingState`, `readEffect`, `advanceFence`, `readFence` |
| `WorkspaceHandoffEvidenceV1` | `observePriorWriters`, `verifyStoreBinding`                                                                  |
| `RuntimeFaultSinkV1`         | `recordFaultAndRequestStop`, `readRequest`                                                                   |
| `RuntimeEffectAdmissionV1`   | The same fault operations, plus `readGate`, `admitChild`, `completeFence`                                    |

`RuntimeEffectsSchemasV1` supplies closed schemas for every request/result family,
including child-admission results and the fence-completion proposal. Use
`parseRuntimeEffectsV1` for untrusted values and `parseRuntimeEffectsJsonV1` for
untrusted JSON text. The latter detects duplicate keys before ordinary JSON parsing
could discard them. Both return detached, deeply frozen data and a constant error
message for invalid input.

`parseRuntimeEffectExchangeV1` correlates mutation results with the complete
original request and its canonical digest. `parseRuntimeEffectsResponseV1` performs
method-specific correlation for discovery, observation, effect/fence readback,
store/writer evidence, fault requests and child admission. A valid result for a
different operation is not a valid response.

The module imports the existing runtime authority assignment, binding, scope,
evidence and trusted-call declarations. It does not widen the permissions of the
historical operation-read profile. In particular, the new `fault-and-fence`
operation has its own locator; it is not silently added to the existing closed
runtime authority operation union.

## Ownership and accepting boundaries

The existing OCC lifecycle and preparation/effect records remain the canonical
writers of desired intent, exact responsibility, admission, operation history and
cleanup requests. Compute owns provider submission and observation. The protected
Compute acceptor alone holds the scoped provider write credential for this resource
domain. Every ordinary execution, route, repair and cleanup writer must use that
acceptor. A worker certificate, role string, resource name, mutex or queue lease
cannot replace current authorization.

`RuntimeEffectCallV1` and `RuntimeReadCallV1` extend the existing trusted
`AuthorityCallV1`; caller identity is not serialized into an effect request. The
actual context factory must inspect the live independent service and its exact
recipient, role, scope and admitted profile. Mutation and independent candidate
observation require their separately admitted privileges. Target workload SVID
availability is not an authentication prerequisite for its independent observer.

A locator resolves a retained server-owned operation. Possessing it does not grant
permission to mutate or disclose its result. Historical readback may continue under
its own exact original-service or accepted cleanup scope after a newer generation
exists; it never authorizes resubmission, binding or positive-purpose work.

## One closed plan and immutable submissions

Before the first possible provider submission, retain a complete resource plan:
exact cluster and Namespace UID, deterministic target name/kind, assignment and
create-effect identity, allowed mutations and immutable desired-spec digest. Declare
controller descendants, node starts/restarts and other possible writer domains
separately, with their required protected producer and capability. A list of
currently visible Pods is not that domain definition.

`RuntimeGateGuardV1` binds the current desired intent/mode/lifecycle generation,
requested monotonic fence epoch, responsibility/version, canonical gate version,
plan reference/version/digest and complete admitted-child cutoff. Runtime generation,
lifecycle generation, fence epoch and opaque provider resourceVersion are distinct.
None may be recycled or locally substituted for another.

`RuntimePreparedChildV1` binds the complete typed request, canonical request bytes,
their digest, exact target and immutable provider predicate. Its `providerWire`
reference, byte length/digest and renderer profile identify the **exact separately
retained provider wire bytes** in the same canonical effect record. The actual
acceptor must resolve and verify those bytes, their renderer/spec correspondence,
allowed operation and conditional predicates before admission. It must submit those
bytes unchanged. A digest or renderer label supplied by a caller does not attest to
that correspondence. The contract parser verifies the logical request binding; it
does not implement or qualify the renderer or inspect a referenced provider record.

`canonicalRuntimeEffectRequestV1` returns canonical UTF-8 JSON text, excluding only
the request's own digest slot. Object keys are sorted; operation identity, gate,
predicate, profile and store fields remain. Hash those bytes with SHA-256 and retain
the same effect ID and complete payload across retries. A new predicate is a new
admitted child under a still-current responsibility, never an edit to unknown
history.

## Supported conditional mechanism

This definition selects a protected acceptor with same-object Kubernetes conditional
mutation. Its implementation must demonstrate the following primitives and writer
custody before enabling effects:

| Operation                | Required condition                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reserve execution name   | A valid, admitted Deployment with replicas zero is created at the exact deterministic name. This reserves an inert object; it does not establish a runtime instance.                |
| Materialize              | One atomic provider operation tests UID, resourceVersion and protected owner/create-effect/fence values, then applies the admitted executable state. No unconditional apply.        |
| Change route             | The same exact object predicates condition the selector/backend update. Inactive routing uses an explicitly reserved unmatchable value; an empty selector must not broaden traffic. |
| Seal                     | An independently authorized conditional mutation raises the fence epoch on that same target and makes the root/route inert. Ownership is preserved.                                 |
| Remove an allowed object | Both UID and resourceVersion are required. Execution-root reservations and tombstones are retained permanently and cannot use this deletion variant.                                |

If an old request wins first, retain its actual or unknown historical outcome and
seal the resulting exact version. If the seal wins first, the old immutable
predicate cannot apply. An old worker may not fetch the successor's resourceVersion
and rebase its request.

An unknown initial inert POST remains owned even if discovery finds zero objects.
A protective inert reservation at the same name can exclude the delayed original
POST. Permanent reservations prevent later name reuse. Namespace recreation,
foreign adoption, unaccounted writers and lost credential custody invalidate the
domain. Finite capacity admission must refuse new preparation while preserving
existing reservations and unresolved history. This version defines no garbage
collection or uncertain-name reclamation protocol.

## Fence completion and authority loss

`advanceFence` and `readFence` explicitly expose pending, established, conflict,
unavailable and commit-unknown outcomes. Per-target and per-child coverage remains
visible. Unknown coverage cannot establish a fence. A historical child may remain
unknown after a seal prevents its future effect; fencing does not rewrite history.

`RuntimeSealV1` represents an exact protective child prepared by `advanceFence` and admitted through the same canonical gate. It seals a reserved object without inventing a runtime binding for an execution that may never have materialized. Its safe state is replicas zero or an explicitly inactive route; it cannot materialize or activate.

The completion input is `RuntimeFenceCompletionProposalV1`. It contains the exact
request and proposed coverage, **not a fabricated post-commit receipt**.
`completeFence` must use one canonical acceptance transaction to:

1. Recompare all gate fields, current authority and the complete admitted-child cutoff.
2. Verify exact retained predicates and full target coverage.
3. Record establishment and atomically close the completed sealer's new child admission.
4. Permit only matching current ordinary successor admission, subject to every
   independent preparation, authority and writer barrier.

Supersession also closes the old sealer and carries its retained children forward.
A completed/superseded sealer may only resolve already retained requests.
`parseRuntimeFenceCompletionV1` checks the proposed data against a supplied current
gate snapshot. It is a conformance/validation helper; calling it before an
unconditional database write would not implement the required transaction.

Applicable service/profile/responsibility/authoritative-lease loss must durably
close ordinary admission and request a protective fence even when lifecycle
generation is unchanged. `ExactRuntimeFaultV1` represents that loss with exact
source versions, protected currentness evidence and independent recovery
responsibility. The currentness/recovery path must run while the affected worker
is paused or dead and recover outstanding records before a restarted acceptor
admits new work. An ordinary queue lease is not execution authority.

`recordFaultAndRequestStop` persists denial and exact retained cleanup/fence
responsibility in the canonical writer. Accepted/replay receipts remain distinct
from downstream stop. Conflict, unavailable, commit-unknown and not-found never
mean that no earlier transaction may commit. Stop acknowledgment failure does not
retract denial. This port grants no create, resume, purge or initiating-human power.

## Observations and conservative writer handoff

`observe` accepts either an exact bound instance or an admitted preallocated
candidate. The candidate branch binds the original create effect/responsibility
and nonmutating preparation, or a satisfied writer barrier when startup can write.
It requires no prior target SVID, binding, serving selection or completed restore.
Results are complete/incomplete/ambiguous/unknown. A complete observation includes
actual provider UID, inherited exact gVisor or gateway binding, protected owner and
execution correspondence, separate desired/delivered/effective profile versions
and original source times. Optional absent target identity evidence never means
identity-ready. The only eligibility label is `observation-only`.

Provider sealing, effective route observation, actual termination and writer
release are independent facts. A sealed Deployment does not close pending
ReplicaSet/Pod creation, kubelet starts, same-Pod restarts, init, repair or restore
writers. Their actual protected start/termination boundary or complete controller
drain remains a required producer capability. A missing producer returns
incomplete/unavailable evidence.

`PriorWriterResultV1` can represent release only with the exact canonical
reservation/workspace association, complete closed-plan cutoff, store bindings,
every writer resolved and every declared producer domain closed by its named
producer/capability. Each possibly executed predecessor requires actual exact
execution identity and observed termination. A protected proof that an exact
owner/effect never submitted or materialized needs no invented runtime ID, but
still needs closed start domains. Zero discovery, an empty caller list, Ready,
replicas zero, elapsed quiet time, route withdrawal and lease expiry are not proof.

An initial writable preparation requires the canonical whole-Agent reservation.
Initial nonmutating observation has its own explicit branch. A journal-confirmed
no-attempt state is distinct from an unknown attempt; no synthetic turn/attempt ID
is created. Historical business outcome may remain unknown after physical
termination. That does not authorize replay, checkpoint publication or a new turn.

The result is a prior-writer barrier observation, not permission to mutate a
successor. Its actual accepting boundary must recheck current authority, exact
reservation/store versions, complete ownership and source freshness before every
writable init, repair, restore or ordinary effect.

## Shared store and reservation values

`completed-state-v1.ts` publishes `StoreBindingRefV1` and `StoreBindingV1` once.
`workspace-reservation-v1.ts` publishes the whole-Agent reservation and exact
attempt locator once. The runtime module imports them. Their public Installation,
Namespace and Agent IDs are the same validated canonical OCC identities.

A retained store binding is immutable **admitted policy**, including exact claim/PV
UIDs, local node UID/affinity, filesystem/access mode and approved directional
subpaths. It contains no successor mount observation. `StoreBindingResultV1`
separately binds the actual runtime mount, filesystem identity, effective
ownership/mode and exact component subpaths to that immutable version. Gateway
private mounts cannot be exposed to the harness. A configuration backend object
has its exact opaque backend version and never masquerades as a PVC/workspace.

Mount binding does not certify durability. Workspace syncfs, completed checkpoint
ordering and filesystem restart qualification remain the persistence producers'
responsibilities. Retained-state stop preserves all owned stores and permanent
reservations. Purge is a separate authorized operation absent from these ports.

## Bounds, errors and verification

| Bound                                       | V1 ceiling                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| Parsed message                              | 256 KiB UTF-8, depth 32                                                    |
| Closed plan                                 | 32 explicit targets, 16 producer domains                                   |
| Admitted children                           | 256 per represented cutoff                                                 |
| Store/writer evidence                       | 16 stores, 64 possible writers                                             |
| Canonical request/provider wire record      | 64 KiB each                                                                |
| Provider RPC / required authority read      | 10 seconds / 3 seconds, each within remaining deadline                     |
| Original evidence age / trusted uncertainty | 15 seconds / 2 seconds; stricter purpose limits prevail                    |
| Stop grace / observation attempt            | 30 seconds / 120 seconds, ending in actual observation or explicit unknown |
| Denial target                               | 60 seconds, unmeasured; not a physical termination guarantee               |

These collection bounds are interface limits, not measured deployment capacity.
The operator still supplies a finite retained-reservation capacity profile. Oversize
coverage rejects rather than truncates. The narrower completed-context restore
operation retains its 30-second deadline. Cancellation before any possible
submission must prevent mutation; cancellation after possible admission/submission
preserves unknown ownership and exact readback.

`runtimeEffectEvidenceFreshV1` checks original source time, uncertainty and a
monotonically newer evidence version against an injected trusted clock. Receipt
time cannot freshen an old fact. It does not authenticate the clock or producer.
The independent consumer also rejects stale nested evidence and distinguishes a
provider fence from a complete writer barrier.

With the repository's compatible installed dependencies, run:

```sh
node --test tests/conformance/runtime-effects-v1.contract.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-effects-v1/tsconfig.producer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-effects-v1/tsconfig.lifecycle-consumer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-effects-v1/tsconfig.type-negatives.json
node node_modules/typescript/bin/tsc --build packages/contracts/tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-effects-v1/tsconfig.declarations.json
node scripts/verify-workspace-boundary.mjs
```

The producer adapter forwards to injected real ports and validates correlation.
The lifecycle consumer evaluates typed barriers and never retries an unknown
create. Conformance traces cover delayed routes, duplicate/same-name effects,
pre/post-submission abort, source-time/order errors, partial fences, stale
completion, sealer rebasing, same-generation authority loss/restart, unknown
COMMIT, capacity refusal, prebinding observation, unresolved descendant/restore
writers, exact mount policy and non-disclosing malformed input.

These checks prove exported signatures, serialization and intrinsic/evaluator
consistency. They do not run PostgreSQL, Kubernetes, runsc, identity issuance,
provider requests, real routing, filesystem durability or physical termination.
Actual canonical transaction/unknown-ACK behavior, protected writer custody,
conditional provider races and all positive runtime/store evidence remain required
before enabling the corresponding implementation.
