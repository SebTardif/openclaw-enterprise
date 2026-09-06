# Lifecycle guard test fixtures

The integration test imports the actual controller `LifecycleEffectGuard` and
the original OCC `WorkClaimLostError` constructor. Controlled peers provide
deferred promises, real abort signals, parsed lifecycle associations and parsed
runtime gate/cleanup observations. Effect peers return unknown or unsupported
results; none performs or reports a successful provider operation.

`vectors.mjs` is a data-only subset of the representation factories in
`tests/fixtures/runtime-effects-v1/vectors.mjs` at `c680e185`. Its import selects
the actual runtime-effects contract leaf to avoid loading unrelated SDK modules.
`peers.mjs` also uses the existing runtime-authority cleanup representation. No
application guard, lifecycle policy or provider decision is copied into these
fixtures. Inputs and returned observations are checked by the actual contract
parsers. Deliberately malformed vectors are identified in their test names.

The call context sentinel is deliberately unauthenticated. A parsed observation
does not establish trusted service custody or durable provenance. These tests
exercise local sequencing, exact correspondence, uncertainty preservation and
per-call isolation. Manually aborting a signal is not a lost PostgreSQL lease;
advancing the injected clock is not live expiry or restart evidence. Returning
after a local timeout does not prove a provider cancelled or joined its work.
Exact-deadline inspecting peers check that the original caller deadline remains
unchanged across gate and cleanup calls, while the guard still enforces its
separate local wait limit. They do not reproduce or verify native authentication.
No test proves Compute fencing, physical termination, durable cleanup, queue
finalization, SDK operation, dispatcher adoption or production integration.

Run the selected integration test in an explicitly prepared workspace:

```sh
node --test tests/integration/lifecycle-worker-guard.test.mjs
```

The compiler-only consumer uses the real narrow guard API, including run,
independently authorized cleanup, and original-locator readback. Its declared
ports do not create executable authority. Three expected type errors reject
fake abort signals, worker context used as cleanup authority, and an effect
request used instead of an exact locator.

```sh
node node_modules/typescript/bin/tsc --project tests/fixtures/lifecycle-worker-guard/consumer.tsconfig.json --pretty false
```

Neither command installs packages, prepares an SDK, starts services, or selects
a database. Whole-workspace verification and eventual owner-controlled wiring
remain separate from this focused component evidence.
