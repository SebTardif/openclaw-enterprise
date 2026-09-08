# Preparation Job interfaces

The contracts package exports a separate versioned definition for candidate repository preparation on Kubernetes Jobs. It describes immutable preparation identity, Job and Pod ownership, protected runtime observations, original effects, conditional mutations and retained staging handoff. It uses the existing repository preparation, runtime authority and effect-gate contracts. These exports provide schemas, codecs and typed producer/consumer ports. A Kubernetes Job provider, preparation identity registration, authenticated observations and admission/fencing implementation are not installed by these definitions.

Import the explicit package subpaths:

```ts
import type {
  PreparationJobEffectsV1,
  PreparationJobIdentityV1,
  PreparationJobReserveV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import {
  parsePreparationJobV1,
  parsePreparationJobReadExchangeV1,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
```

The existing Deployment effects and gateway/Harness identities have different targets and authority. A Job cannot be cast into those profiles. Preparation has its own purpose, immutable candidate incarnation, authorization generation, lifecycle generation, fence epoch and exact runtime execution generation. Serving identities and activation remain independent. See [repository preparation interfaces](repository-preparation.md) for the credential-owned grant, checkout and protected receipt boundary, and [runtime authority](runtime-authority.md) and [runtime effects](runtime-effects.md) for the accepting owners' existing obligations.

## Exact identity and immutable plan

`PreparationJobTargetV1` contains the complete original repository preparation subject, cluster reference, Kubernetes Namespace name and UID, exact `batch/v1` Job name and permanent reservation reference. The subject retains the full repository ID, full commit object ID, revision and digest, preparation grant, origin profile, staging binding and original deadline. Its original gate stays unchanged when a later protective or cleanup guard is acquired.

`PreparationJobPlanV1` binds the target to exact Job and Pod-template digests, admitted execution deadline, runtime/containment/mount/resource/identity profiles and three required protected producer domains: Job controller, node runtime and staging writers. The separate identity record joins the Job UID directly to a controller-owned Pod UID, then an exact node, sandbox and container execution. There is no ReplicaSet ancestor. Each init or main execution has its own execution reference and generation; a Pod restart count or PID does not provide this identity. Protected control-plane and runtime observations retain separate source evidence.

The definition profile reserves a suspended Job with the complete admitted immutable template already present, then conditionally releases that same object. It selects one completion, parallelism one, nonindexed completion, zero configured backoff and `Never` Pod restart policy. Those settings constrain requests; they do not establish at-most-once execution. Kubernetes documents that duplicate program starts remain possible even with a single completion and parallelism one. [Kubernetes Job documentation](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

The execution-root Job has permanent reservation retention. Automatic TTL cleanup and root deletion are excluded. An unknown initial create retains its exact name, request and responsibility until the accepting owner independently resolves it; the name is never reused to bypass uncertainty. The template's admitted execution deadline remains absolute across suspension and release. The selected provider must enforce the exact job, child and node admission profile; an unsupported cluster, unqualified producer domain or unavailable protected input returns a closed unavailable outcome.

## Operations and original-effect identity

| Operation              | Required retained inputs                                                                                                                                                           | Meaning of a response                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `reserve`              | Original subject, closed plan, separate reserve effect/digest, preallocated release reference, credential checkout request and expected-absent permanent reservation predicate     | A provider acknowledgment leaves physical outcome unproven.                                                       |
| `release`              | Exact original reservation, preallocated release effect, current guard preserving the original intent, responsibility and plan, plus Job UID/resourceVersion/owner/fence predicate | Conditional release is allowed only by the actual current accepting authority.                                    |
| `seal`                 | Original reservation, independent current cleanup guard/binding, exact Job predicate and admitted-child cutoff                                                                     | Closes admission under the real fence owner and requests suspension; acknowledgment is not termination.           |
| `terminate`            | Original reservation and current cleanup binding, exact Job predicate and exact descendant Pod or runtime execution                                                                | Targets only the retained original descendant; acknowledgment is not physical writer exclusion.                   |
| `discover` / `observe` | Retained original mutation, current authorized read guard and fresh bounded call                                                                                                   | Exact observation data, or a closed unsupported/incomplete/ambiguous/unknown/conflict/denied result.              |
| `readback`             | Exact original mutation and a fresh bounded read                                                                                                                                   | Retains the original result, including its original source time, with separate fresh protected readback evidence. |
| `readClosure`          | Original effect, current cleanup authority, independently retained canonical admission snapshot and explicit closure read                                                          | Protected closure correspondence, or an unresolved result; it grants neither successor execution nor purge.       |

Every mutation has its own immutable effect reference and canonical digest. The credential checkout's `effectRef` identifies the preallocated **release** effect. Its `requestDigest` remains the credential checkout digest, while reserve and release have distinct Job mutation digests. A checkout receipt's `effectRequestDigest` must still equal its original checkout request's digest. The receipt-pair schema explicitly correlates all these records instead of substituting one digest for another.

A Job mutation digest includes every retained field except its own digest slot, including request ID, original deadlines, target, predicates, plan and checkout correspondence. Retries retain those bytes; they cannot invent a new effect or refresh the mutation deadline. Fresh exact reads have their own call bounds and preserve the expired original mutation for readback or cleanup. Cleanup may occur after the preparation deadline and under a later lifecycle generation, without rewriting the original running preparation subject. Release permits monotonic advancement of the gate version and admitted-child cutoff while preserving the exact original scope, intent, running lifecycle, fence, plan and complete preparation responsibility. It does not infer responsibility renewal or a plan transition.

Plan digests use the `preparation-job-plan-v1` canonical domain. Their only self-reference exclusions are the plan's own digest and the embedded original gate's copy of that same plan digest. All other target, authority expectation, scope, profile, deadline and admission fields remain bound. Mutation, resolved-attempt and canonical admission-membership digests use separate `preparation-job-effect-v1`, `preparation-job-attempt-manifest-v1` and `preparation-job-admission-manifest-v1` domains.

## Authority, fences and retained staging

The same canonical lifecycle owner authenticates `AuthorityCallV1`, compares current intent, generation, responsibility, plan and fence at the accepting boundary, and durably retains possible effects before submission. Mutation acceptance combines the exact object UID/resourceVersion, owner and fence predicate with those current checks. A read followed by an unconditional write does not implement this protocol. The new data schemas do not create an authority issuer, journal, transport service, authenticated call context or protected capability.

### Pre-write staging admission

Before `release`, or any earlier init/startup action that can attach or mutate staging, the original persistence/store owner and the same canonical lifecycle accepting owner must establish the current right to write the **exact** candidate/incarnation, admitted preparation/plan, `StoreBindingRefV1` version, physical object/subpath and mount policy. They must exclude competing writer admission and establish one of these conditions:

- **Fresh candidate-only staging:** the protected current allocation is physically independent of serving and other-candidate stores/permitted subpaths, has no prior possible writer, and is exclusively assigned to this candidate/incarnation and exact staging version.
- **Retained or reused staging:** the applicable canonical reservation, exact-store mapping and prior-writer barrier positively resolve every possible predecessor and pending create, including required physical termination, before admitting the new writer.

The original persistence owner retains `StoreBindingV1` physical/version/subpath interpretation. The original canonical lifecycle/reservation owner retains current preparation responsibility, exclusive admission and all possible-effect membership. The existing `WorkspaceHandoffEvidenceV1.verifyStoreBinding` / `observePriorWriters` declarations and [shared store/reservation values](runtime-effects.md#shared-store-and-reservation-values) name their accepted store and barrier boundary; the [conservative writer handoff](runtime-effects.md#observations-and-conservative-writer-handoff) remains evidence, not a cached write permit. These preparation declarations do not extend those ports' target applicability or cast a Job to a Deployment/Harness target. The original persistence and lifecycle owners must supply the exact applicable protected allocation or retained-store mapping. Missing implementations or unsupported target/store coverage remain unavailable and admit no staging writer.

Recheck the actual accepting authority, exact staging/version, candidate/plan and relevant protected allocation/barrier currentness **after waits and at each accepting write boundary**. A logical store reference, RWO, new name, Job UID, mount-policy digest, empty list, receipt, elapsed time or later closed-admission/closure record cannot supply this incoming pre-write condition. This requirement grants no writable serving handoff, successor authority or purge and preserves independently serving stores. The definition supplies neither a new schema/issuer nor a live allocation or writer-exclusion producer.

Cleanup's current guard and responsibility are distinct from the embedded immutable original gate. Its cleanup binding names the original reservation effect/digest and target plan, while carrying the actual current responsibility. A later guard cannot authorize arbitrary prior targets merely by having a larger version. The accepting owner must verify that its responsibility covers this exact original target before and after waits. Scope/monotonicity checks in the codec are necessary value checks, not that authorization lookup.

`PreparationJobAdmissionPortV1` declares the new target applicability on the same canonical gate and responsibility owner. `readAdmission` supplies its retained closed-admission snapshot, including exact ordered member identities and request digests, snapshot reference/version, current guard, target plan, cutoff, seal version and protected provenance. `assertCurrentAdmission` independently looks up that exact snapshot identity and membership again after waits. This is an additional declaration for the existing owner; it supplies no alternate journal, issuer or implemented admission service. A missing actual owner produces an unavailable result.

Closure reads must carry that independently obtained snapshot. The result must preserve it exactly and resolve exactly its admitted members; recomputing a digest over an omitted local list cannot replace expected membership. After the physical closure read, the consumer calls the canonical owner's currentness assertion and checks the original closure again using the post-await clock. Cached snapshot bytes retain their original source time. A fresh reobservation requires a distinct producer-owned evidence identity or increased evidence version; it cannot refresh timestamps on the retained observation.

Closure must cover the entire admitted effect manifest and all three protected domains. It includes the current canonical guard, target-plan digest, closed-child cutoff, admission seal version, retained suspended root UID/resourceVersion, Namespace and owner binding, exact sealed epoch, exact resolved attempts and independent staging evidence. Resolved attempts distinguish the inert retained root, prevented effects, a release whose descendant executions are excluded while its historical outcome may remain unknown, and terminated Pod/runtime executions. A sole prevented release cannot be paired with executed descendants in a positive closure. A terminated execution retains exact Pod ancestry, node, sandbox, runtime profile and execution generation. An unresolved retry, delayed create, replacement Pod, init execution or node restart keeps closure unavailable. Incomplete listing or duplicate producer coverage is rejected. When the retained release, seal or termination already names a concrete Job UID, observation and closure must match that exact UID even if every returned descendant is internally consistent with a replacement. Current resourceVersion may legitimately advance; root ownership remains exact, and a positive sealed root must have the closure guard’s requested fence epoch.

The admission owner must independently establish that the manifest and cutoffs cover **every possible admitted execution**, including creates that are not in the current Pod list. Serialized zero counters and a matching manifest digest do not establish that fact. Future controller creates and node starts/restarts must be closed under the actual protected mechanism. Completing the canonical fence revalidates current intent, responsibility, plan and cutoffs and prevents an old sealer from admitting new work. Authority loss retains a protective-fence responsibility even when the generation has not changed.

Suspension or deletion requests, a Job completion condition, revoked credentials, route withdrawal, expired calls and cancellation acknowledgments do not prove physical termination or no writers. Kubernetes suspension affects controller behavior and requests termination of active Pods; separate runtime and storage evidence is still required. [Kubernetes Job API](https://kubernetes.io/docs/reference/kubernetes-api/batch/job-v1/)

The staging binding remains retained. A closure record describes exclusion of the original writers and exact store evidence; the persistence owner must check actual current store authority before consuming it. It cannot release a successor, start restore/repair, or certify that another writer is absent. Purge and deletion of retained stores are outside this interface.

## Protected receipt composition

`PreparationJobReceiptPairV1` binds a credential checkout receipt to its exact original request, release mutation, candidate incarnation, revision, grant, full commit, staging and Job/Pod/runtime identity. `parsePreparationJobReceiptPairV1` also checks observation freshness and invokes the original credential receipt correspondence validator, preserving its original deadline rules.

The original `RepositoryPreparationReceiptPortV1` owns `ProtectedPreparationReceiptHandleV1`. Parsing a successful receipt or Job identity cannot construct that handle. Consumers obtain it from the real receipt producer, retain its invocation ownership, and call `assertCurrentReceiptV1` after waits. Missing, replaced, foreign or expired protected inputs remain unavailable. Receipt currentness, physical writer exclusion, serving identity and readiness remain separate obligations. The typed credential-consumer example demonstrates receipt readback and the post-await currentness call without performing readiness or credential release.

## Bounds and validation

The new codec rejects unknown keys, including in reused nested scope and clock fragments; duplicate decoded JSON keys; unsafe or aliased numeric lexemes; accessors; proxies; cycles; invalid canonical timestamps; stale source clocks; and inconsistent cross-record identities. Accepted values are deeply immutable. Limits are 256 KiB encoded values, depth 32, 64 observed Pods, 128 runtime executions/resolved attempts and exactly three required producer domains. Exceeding these limits requires an explicit incomplete/unsupported response, not truncation into positive evidence.

Provider mutation calls are bounded by the existing 10-second limit and exact authority reads by its 3-second limit. Source evidence keeps the existing observation-age and uncertainty bounds. Exchange validators take the actual owner's clock as an input convention, not as proof that the clock is trusted. Positive mutation acknowledgments, observations, readback and closure require a fresh call and matching protected source times. Unknown outcomes continue to retain original responsibility after deadline or cancellation. Historical acknowledgments preserve their historical source times inside a fresh exact readback record.

The fixture directory contains separately compiled Compute producer and credential, lifecycle, identity and storage consumers, plus compile-time negative assignments. These import actual public package subpaths and original authority/receipt types. The conformance suite executes the real schema and codec logic with immutable correspondence, negative and race-shaped inputs. It does not construct a provider, authenticate a service, install admission, schedule a Job or establish live no-writer evidence.

From an explicitly prepared workspace, run the installed Node and TypeScript binaries directly:

```sh
node --test tests/conformance/preparation-job-v1.contract.test.mjs
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/producer.tsconfig.json
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/credential-consumer.tsconfig.json
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/lifecycle-consumer.tsconfig.json
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/identity-consumer.tsconfig.json
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/storage-consumer.tsconfig.json
node node_modules/typescript/bin/tsc --pretty false --project tests/fixtures/preparation-job-v1/negative.tsconfig.json
```

Each compiler project explicitly enables strict checking with `skipLibCheck: false`. Actual provider implementation and selected-runtime qualification must separately prove preparation identity, conditional admission, late-effect containment, receipt/startup ordering and termination under failure. Existing Deployment/Harness runtime evidence does not qualify this Job profile.
