# Runtime identity currentness and stream ownership

`packages/occ/src/runtime-identity/purpose-guard-v1.ts` implements the accepted
`RuntimeIdentityPurposeGuardV1` port. It composes the actual local workload
verifier with the existing `RuntimeAssignmentAuthorityV1.resolve` callable.
`stream-lifetime-v1.ts` owns terminal stream state, independent timers and pending
operation settlement. The [runtime identity contract](runtime-identity.md) remains
unchanged.

Construct `createRuntimeIdentityPurposeGuardV1({ verifier, authority, limits })`
at the accepting service with its actual verifier and authority. The factory
captures their methods and the validated, immutable limits once. The verifier
must be the maintained [runtime peer verifier](runtime-peer-verification.md),
which supplies private proof membership, original registration metadata and a
per-call settlement participant. A structural verifier replacement cannot supply
the latter by asserting a flag. Construction requires the actual participants;
the optional trusted clock/scheduler supports deterministic integration tests.
Request data cannot select dependencies, clock or limits.

No purpose producer is supplied here. An existing resolver's `unavailable` /
`lookup-unavailable` result remains unavailable; missing native, authenticated
registration or currentness production cannot be filled with a local evaluator.
The guard does not mint an authority context or convert an Installation context.
The original authority implementation and current-purpose writers remain owned
by Runtime.

## Fresh exact checks

Each `check(proof, request, call)` reparses the complete canonical request before
any await. It preserves scope, assignment, purpose, operation reference,
responsibility version and cleanup/restore suboperation. The actual opaque call
context remains the same object. Request reference, recipient and signal are
captured once; later mutation of the caller's request or call cannot replace
them.

The guard inspects the original proof, calls the original resolver, and inspects
the same proof again after that authority await. The verifier owns actual native
connection/registration inspection. The guard checks its private original
registration metadata against the result's full target and immutable binding,
including create effect, runtime/lifecycle generations, bound instance and
restart discriminator. Identity profile, registration/bundle versions, request
and operation correspondence must match. Restore checks retain the exact
responsibility, suboperation, assignment, revision and binding version.

Every await stays within one captured monotonic check budget: the minimum of the
original absolute deadline, the existing 3-second lookup ceiling and the
configured assignment/policy deadlines. A stream additionally caps checks by
its original monotonic lifetime. Wall-clock rollback, delayed callbacks and a
later call deadline cannot renew that budget. Cancellation and timer expiry race
the public wait; freshness and terminal state are checked again after awaits.
The original source timestamps are retained and tested against the configured
runtime, policy and identity evidence ages and clock uncertainty. Delivery time
never refreshes an old observation.

All seven authority outcomes retain their canonical shape:

| Outcome              | Guard behavior                                                       |
| -------------------- | -------------------------------------------------------------------- |
| `current`            | Return the exact serving-purpose observation.                        |
| `candidate-eligible` | Retain only the original registration, readiness or restore purpose. |
| `cleanup-eligible`   | Retain the exact cleanup responsibility and operation.               |
| `pending`            | Return the nonpositive observation.                                  |
| `not-current`        | Return the denial without a saved allow.                             |
| `not-visible`        | Preserve the scope-hidden shape.                                     |
| `unavailable`        | Preserve lookup unavailability.                                      |

Opening or checking never dispatches an operation. Every privileged dispatch and
authority-sensitive delivery must call `check` and apply its own current human,
turn, resource and effect authorization. Independent registration and cleanup
services still use their existing authority with their own service context;
they do not acquire a target-SVID bootstrap requirement from this guard.

## Exact streams and independent invalidation

`openStream` performs its own fresh check. A nonpositive observation returns
`not-opened`; a successful opening is not permission for even the first delivery.
The resulting handle captures one proof, full request, call context, recipient,
original signal and connection/attempt. `stream.check(call)` rejects another
context, request reference or recipient. An additional signal may shorten a
check, while the original stream signal and deadline remain in force.

The immutable stream horizon is the minimum of the original call deadline,
original proof expiry and original authentication time plus connection maximum
age. Periodic fresh checks run at the stricter of stream-recheck and
identity-health-poll intervals. Independent timers expire original source
evidence and check health, even while a lookup is blocked or the data consumer
is paused. Fresh checks can refresh their evidence/health observations within
the original lifetime; they cannot reopen a terminal stream or extend that
lifetime. There is no positive allow cache.

`invalidate(reason)` synchronously marks terminal state and aborts the stream.
Installed owners may report the accepted `watch-lost`, `watch-gap`,
`connection-closed` and other fixed invalidations through this method. No watch
transport or subscription protocol is added; this implementation uses polling
and independently scheduled health checks. A closed or invalidated stream
never starts another check. A check paused before invalidation cannot return a
late positive. Data adapters must apply the fresh check at each protected
delivery and respect terminal `signal` state; this component has no data buffer
or delivery callback and does not retroactively withdraw a value already
delivered to a caller.

## Cleanup and capacity

`close()` aborts synchronously before its first cleanup await. It is idempotent
and joins original owned operations within `streamCloseDeadlineMs`. A timeout
returns the fixed `cleanup-unsettled` transport failure and preserves terminal
state. Both unresolved resolver work and the verifier's nested native/registration
work remain owned until their actual promises settle, even after the public
check has already returned cancellation or timeout. The verifier supplies the
per-original-signal join; a response-only timeout is insufficient settlement.

All proofs of one actual connection share its private transport binding, which
keys stream capacity. The configured maximum connections, streams per connection
and pending checks are enforced. Timed-out checks and closing streams retain
their capacity until actual settlement. This permits safe late cleanup without
starting replacement work against an unjoined predecessor. Timer cancellation
and signal-listener removal are synchronous; there is no borrowed connection or
Source closure.

Stream cleanup establishes no physical stop, effect rollback, interrupted-effect
resolution, native termination or hosted-Harness synchronous `assertCurrent`
integration. The real protected final-hop adapter and hosted-Harness integration
remain with their existing native and transport owners. Lifecycle integration
must still qualify real disable/restart, denial of old unexpired SVIDs, deployment
limit selection and the measured total denial budget. Effects that may already
have started retain their existing interrupted/unknown outcome and owner.

## Controlled verification

The two conformance suites execute the actual guard, internal lifetime and
genuine peer verifier against controlled canonical resolver/native/registration
timing. The fixture supplies synthetic observations explicitly; it does not
implement the guard's decisions or claim a production positive currentness
producer. Cases include warm connections, all seven outcomes and purposes,
request mutation, wrong target/attempt, reconnect, foreign proof, simultaneous
streams, stale evidence and watch health, paused/buffered delivery checks,
original deadlines, cancellation, close timeout and later actual nested-work
settlement. The strict consumer imports the accepted contract and both actual
implementations without an SDK declaration stub.

Run from a prepared worktree using its existing dependencies:

```sh
node --max-old-space-size=1536 --test --test-concurrency=1 \
  tests/conformance/runtime-identity-purpose-guard.test.mjs \
  tests/conformance/runtime-identity-stream-lifetime.test.mjs
node --max-old-space-size=1536 node_modules/typescript/bin/tsc \
  -p tests/fixtures/runtime-identity-currentness/tsconfig.json --pretty false
```

These are deterministic component checks. They require no native helper,
provider, cluster, database, SDK installation or new dependency. They establish
neither a live deployment denial bound nor a completed consumer handoff.
