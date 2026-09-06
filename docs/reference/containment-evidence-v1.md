# Containment evidence comparison and fault requests V1

The OCC containment modules compare supplied effective-control evidence and forward an exact fault request to the existing Runtime fault sink. A comparison result is advisory. The modules do not authenticate producers, establish an admitted profile, allocate responsibilities, persist denial, or execute a stop.

The public imports are:

```ts
import {
  emptyContainmentEvidenceStateV1,
  evaluateContainmentEvidenceV1,
} from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import { ContainmentFaultRequestAdapterV1 } from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";
```

These modules consume the original [containment controls](containment-controls-v1.md), Runtime authority and Runtime effect declarations. They introduce no alternate identity, policy, authority or fault protocol. Their structured references are internal evidence data; external status readers still apply their original authorization and sanitization rules.

## Pure comparison

`evaluateContainmentEvidenceV1(input, previous)` performs one finite transition. It accepts an exact `ContainmentControlInputV1`, its original observation result, an original `ResolveAssignmentRequestV1`/`ResolveAssignmentResultV1` exchange, a clock sample, and the owner's retained comparison state. It returns `scope: "comparison-only"`, a `satisfied`, `denied` or `unknown` decision, bounded findings and proposed immutable state.

The owner supplies the actual admitted containment profile and **complete** required-control set. The evaluator checks exact correspondence to these supplied requirements; equality cannot establish that a caller selected the complete admitted set. It checks the complete original target and execution binding, including the protected restart discriminator, and correlates the original authority request and response. The accepting boundary still verifies each producer's authenticity, original watermarks, current purpose authority, and any current account, turn and resource authority.

`satisfied` means the supplied values agree and are within their stated bounds. It never authorizes activation, serving, a model call, a credential, a route, a writer or a successor. Every other decision fails the comparison. A rejected exchange does not advance source watermarks; the accepting owner preserves denial and uses its original fault path when appropriate.

The supported purpose branches retain their original distinctions:

| Purpose                                             | Original positive branch                                                     | Identity comparison                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `identity-registration`                             | `candidate-eligible`, exact preparation operation and responsibility version | A bound observation may have null target identity.                                                                       |
| `readiness-probe`                                   | `candidate-eligible`, exact probe operation and responsibility version       | Original local and peer registration evidence are both required; observed local identity must be verified and match.     |
| `runtime-peer`, `model-call`, `repository-issuance` | `current`                                                                    | Original identity, serving and mutation-eligibility evidence are required; observed identity must be verified and match. |

`cleanup` and `completed-context-restore` return `unsupported-purpose` in this bound containment comparison. Their existing authority branches remain with their original consumers. A preparation result cannot be promoted into a current user-work result. The control projection itself still supports only its original bound gVisor Harness input; this evaluator adds no prebinding requirement to the separate original Runtime observation port.

Complete Runtime evidence retains separate desired, delivered and effective runtime policy. All three must agree, and the runtime policy digest must match the original binding. Every required control must retain its desired, delivered and effective stages with an effective outcome. Missing stages, unknown outcomes, policy mismatch and incomplete Runtime observations cannot satisfy the comparison.

## Original clocks and ordering

The owner injects a canonical UTC `now` and a nonnegative safe-integer `monotonicMs` from a trusted clock domain. Both must be nondecreasing relative to the retained state. Dates before the Unix epoch and malformed clock samples return a closed result. Reinitializing a clock or deserializing state does not establish a trusted restart.

Every consumed original provenance clock is checked, including Runtime observation, owner chain, execution correspondence, runtime delivered/effective policy, observed identity, each control stage and each original purpose-specific authority source. The original maximum age is 15 seconds and maximum uncertainty is 2 seconds. The exact input may make either bound stricter, including zero. For an original source time `s`, validity end `u`, uncertainty `e` and sample `t`, the comparison requires:

```text
s <= t + e
t - s + e <= requested maximum age
t + e <= u
e <= requested maximum uncertainty
```

An authority envelope must also have been evaluated no later than the sample and remain within its original validity and the requested age limit. Receipt timestamps are retained by the original contracts but cannot refresh source age. A newer projection or authority envelope cannot renew historical stage evidence. An unchanged policy stage can be replayed while its own original source remains valid.

The state tracks logical source slots for an exact assignment, execution, containment profile and required-control set. Projection epochs and original control-producer epochs are separate. Within an epoch, lower evidence versions or source times are rejected; the same version with different proof content conflicts. An epoch transition requires a higher protected epoch version, a different epoch reference and a nondecreasing source time. Lexicographic reference ordering has no meaning. A projection restart cannot reset any original producer's history, and an unexpected producer replacement cannot silently reset an existing slot.

Runtime and authority declarations without a producer-epoch field do not acquire one from the observer. Their original source versions remain monotonic for the exact execution. The authority envelope's original evaluation time orders that envelope; original assignment, selection and source versions are tracked separately. A fingerprint compares original proof content with receipt times excluded. The original request's transient read correlation is not part of the projection proof fingerprint.

A recorded control failure blocks that exact source slot until newer matching original evidence addresses it. Purpose-specific authority failures remain scoped to that purpose. An original current retirement or replacement response is retained for the assignment across observer, profile and execution changes; late success cannot revive that assignment. A fresh correlated retirement is retained even if accompanying observer evidence is stale. Unrelated assignments have independent state. Comparison retirement is still an advisory record: it does not perform the original durable fault transaction.

State is explicit, detached and deeply frozen. The owner must retain it serially in its existing protected custody; it is not a new persistent authority or journal. Bounds are 32 subjects, 96 watermarks per subject, 32 retired assignment keys, 64 findings, 1 MiB of encoded state and finite traversal limits. Overflow returns an explicit closed result without evicting history. Invalid retained state returns `nextState: null`; the owner must preserve the original history and resolve the problem through its existing authority, rather than treating null as permission to start empty.

## Exact fault submission and readback

`ContainmentFaultRequestAdapterV1` wraps an injected original `RuntimeFaultSinkV1`. `prepare(fault, expected)` accepts a complete owner-supplied `ExactRuntimeFaultV1` and the expected original target, guard, cleanup responsibility and cause. A containment finding is not Runtime evidence and cannot be converted into a fault cause. If the owner has no applicable original cause or retained responsibility, the adapter cannot manufacture one.

Preparation snapshots the original fault, validates it with the original parser, computes `canonicalRuntimeFaultRequestV1` and compares its SHA-256 digest with `operation.requestDigest`. Expected target, guard, cleanup responsibility and cause must produce the same canonical payload. The original operation reference, scope, operation kind, digest and full fault remain unchanged through every continuation.

`submit(continuation, call)` invokes at most one `recordFaultAndRequestStop`. `readback(continuation, call)` invokes at most one `readRequest` for the retained exact operation. Every call carries the original authenticated context, request reference, recipient reference and deadline unchanged. A linked local abort signal and injected scheduler bound the local wait. Submission waits at most 10 seconds; authority readback waits at most 3 seconds; both are limited by the remaining original deadline and may be configured more strictly. The local wait never rewrites the authenticated deadline.

The owner supplies real original-authorized calls and retains the latest continuation serially under its existing responsibility. A deserialized continuation or an older `submit-allowed` value does not prove non-submission, authenticate the caller or grant a mutation. The original sink independently verifies authority, currentness, applicability and exact durable request semantics.

| Observed adapter outcome                                                                 | Continuation and meaning                                                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Local failure conclusively before invocation                                             | `not-invoked`; an existing `submit-allowed` continuation may be tried again with the same exact bytes and a fresh original-authorized call. |
| Throw, timeout, cancellation, malformed or mismatched response after possible invocation | `commit-unknown`, `readback-only`; keep denial and resolve the exact original operation.                                                    |
| Original `unavailable`, `commit-unknown` or `not-found`                                  | Preserve the original status and `readback-only`; no proof of noncommit or permission to allocate a replacement operation.                  |
| Original `accepted` or `exact-replay`                                                    | `resolved`, with the original correlated durable receipt.                                                                                   |
| Original `conflict`                                                                      | `resolved` conflict; no claim that this supplied fault was committed.                                                                       |

Accepted readback must match the complete retained fault and canonical payload in addition to the original operation locator. The adapter applies the original full-request response comparison to that receipt. A matching operation ID alone cannot substitute a different fault. Late completion of a timed-out promise cannot change the already returned continuation.

All adapter outcomes retain `admission: "denied"` and `downstreamStop: "not-proved"`. An accepted original receipt proves only its stated durable closure and cleanup obligation. OCC's original sink owns that write; the original cleanup executor owns physical stop. Cancellation does not establish remote rollback, credential revocation, writer exclusion or successor eligibility. There is no automatic retry loop, background worker, persistence layer or competing operation allocator in this adapter.

## Source verification

The two conformance suites execute these actual modules through public package subpaths. Synthetic original-port values and a controlled finite clock drive original age, uncertainty, replay, conflict, restart, retirement, unknown-commit, cancellation and full-receipt readback traces. Four independent strict compiler projects exercise modules, producer composition, consumer usage and negative type boundaries.

With the repository's prepared dependencies and pinned Node available, run:

```sh
node --test tests/conformance/containment-evidence-v1.test.mjs tests/conformance/containment-fault-request-v1.test.mjs
node node_modules/typescript/bin/tsc -p tests/fixtures/containment-evidence-v1/module.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/containment-evidence-v1/producer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/containment-evidence-v1/consumer.tsconfig.json
node node_modules/typescript/bin/tsc -p tests/fixtures/containment-evidence-v1/type-negatives.tsconfig.json
```

These checks qualify the in-process source behavior with synthetic evidence. They do not qualify a live Runtime producer, identity verifier, database transaction, provider, network control, physical stop or deployed integration.
