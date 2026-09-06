# Lifecycle worker effect guard

`LifecycleEffectGuard` is an internal controller collaborator for checking a
retained work claim and lifecycle intent around bounded effect calls. It consumes
the existing lifecycle reader, queue heartbeat and runtime authority/effect ports.
It does not register a queue handler or change the installed worker call sites.

The implementation is
[lifecycle-effect-guard.ts](../../apps/controller/src/worker/lifecycle-effect-guard.ts).
Its running path accepts only original deploy work with the installed
revision-backed correspondence. Protective transitions, resume and maintenance
reenqueue remain unsupported by that correspondence.

## Construction and calls

Create one guard for a worker run. Supply the real lifecycle reader and heartbeat,
the original OCC `WorkClaimLostError` constructor, a trusted clock, and the
selected runtime gate/effect services. Cleanup additionally uses the selected
assignment authority. Missing capabilities produce a blocked result; shape-valid
inputs cannot supply them.

| Method                                               | Required input and behavior                                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(context, request)`                              | Original admitted association, installed operation, claimed work, Installation, worker cancellation and independently authenticated service call. Checks running intent and claim around create or active-route calls. |
| `cleanup(original, request, authorityRequest, call)` | Original association, exact bound-instance cleanup and its separate current cleanup service call. Checks retained target, binding, responsibility and successor exclusion through the existing authority/effect ports. |
| `readOriginal(locator, call)`                        | Read-only recovery of the complete original effect locator. It never submits or retries a mutation.                                                                                                                    |
| `lifecycleEffectAfterClaimLoss(error)`               | Retrieves this guard's retained possible-effect observation from an original claim-loss exception. The exception constructor and `instanceof` classification remain unchanged.                                         |

The caller retains original admitted requests and effect locators before invoking
the guard. The guard parses snapshots through the canonical lifecycle/effect
helpers, verifies the original canonical request digest and does not modify or
remint IDs, ownership predicates, source timestamps or request bytes.

## Running work

The guard checks already-aborted worker state before renewal. It reads the
retained association and current head, compares the complete installed work,
claim token and expiry, and samples the clock after the read. Renewal must return
the same claimed work and token. Cancellation and current state are checked again
after renewal and after later gate/effect waits.

Current stopped or disabled intent suppresses deploy and active-route repair.
An older generation, foreign Agent, different original association or unavailable
reader cannot be repaired by renewing the claim. The supplied gate must match
the exact request, report current authority and have the applicable admission
open with fresh evidence. The original evidence is checked again immediately
before submission and observation return, retaining its source age and clock
uncertainty. A later await never refreshes its timestamps.

These are necessary local checks. A lifecycle snapshot, gate observation or
renewed lease is not a permit or an atomic provider fence. Each real accepting
effect port must independently authenticate its caller and enforce current
original-actor/reference/profile authority, exact responsibility, generation,
UID/resourceVersion and writer conditions. The guard adds no generic readiness
or preparation purpose to the assignment resolver.

Each local read wait is bounded by the earlier caller deadline and the existing
three-second lookup ceiling. Each provider wait uses the earlier caller deadline
and ten-second provider ceiling. `maxWaitMs` may tighten these local limits.
Forwarded calls preserve the original authenticated deadline, context and
correlation exactly; local timers and cancellation enforce the tighter wait
without changing the exchange identity. Worker
cancellation retains the original `WorkClaimLostError` classification. A timeout
or cancellation bounds this caller's wait; it does not establish that a peer
stopped, rolled back or never submitted a request.

The guard checks claims around calls; it does not install an additional periodic
heartbeat loop. The queue/worker owner retains ongoing lease monitoring and must
propagate known claim loss through the worker cancellation signal. Actual provider
fencing remains necessary while an external operation is in flight.

## Uncertain effects and exact cleanup

After any possible submission, timeout, cancellation, claim loss, malformed or
mismatched response, lost currentness and dependency failure retain the original
effect locator as unresolved. A late result cannot publish completion for a newer
head. `unknown` and `not-found` readback remain unresolved; absence of a current
row does not prove that an earlier request cannot finish.

Within one guard instance, a previously attempted effect is not submitted again;
the caller must explicitly request exact readback. Changed bytes under its
original effect identity conflict. The
bounded local attempt map is not durable idempotency: restart recovery still
uses the canonical admitted operation/effect records and their exact readback.
The guard introduces no automatic retries or new effect IDs.

Cleanup has a separate call and deadline. It does not borrow the cancelled
running-work signal, renew the old claim or require the initiating human's old
grant. It requires fresh independently accepted cleanup authority for the exact
original target, binding and responsibility. It cannot create, resume, purge,
adopt a successor or remove a permanent execution-root reservation. Retained
store references and original UID predicates pass unchanged to the existing
effect port. Unbound-object cleanup stays with its existing Compute owner.

`observed` means a correlated effect response was obtained under the local
checks. It does not mean serving, effective routing, physical termination or
successful queue completion. `blocked` supplies no new authority. `unresolved`
requires exact readback and retained cleanup responsibility.

The guard never completes work, publishes serving or marks a prepared candidate
terminal. Before candidate terminality, the existing owner must durably retain
exact cleanup through the canonical fault/stop admission and confirm its
acceptance or preserve commit uncertainty. This responsibility survives original
worker/human loss; no local return value replaces it. Unresolved predecessor
effects cannot release a writable successor.

## Verification boundary

Run the focused actual-module suite with prepared worktree-local dependencies:

```sh
node --test tests/integration/lifecycle-worker-guard.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/lifecycle-worker-guard/consumer.tsconfig.json --pretty false
```

The tests use controlled reader, heartbeat and authority/effect peers to exercise
the guard's ordering, cancellation, correspondence and uncertainty behavior.
They do not implement a successful provider, authenticate a service, renew an
actual PostgreSQL lease or prove a live UID fence. The installed queue, restart
recovery, durable cleanup, actual Compute effects and combined worker/finalizer
adoption retain their separate integration and runtime acceptance requirements.
