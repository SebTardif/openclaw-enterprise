# Lifecycle status service and HTTP fixtures

These fixtures exercise the lifecycle status service and provide a controlled
source for transport tests. The service consumes the existing
`LifecycleStatusReadPortV1`, resolves the current server-owned Installation and
source, and delegates through the existing sanitized reader. It does not create
authentication, authorize Agent reads, or produce runtime observations.

| File                    | Purpose                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.ts`             | A test-only source with supplied canonical replies, an invocation log, and private-map correlation handles.                                          |
| `service-consumer.ts`   | A standalone public-subpath consumer receiving external Installation/source resolvers and original calls.                                            |
| `type-negatives.ts`     | Compile-only checks that the service retains the existing read port, opaque calls, canonical scopes, exact operation locators, and readonly signals. |
| `service.tsconfig.json` | Focused strict checking of all three TypeScript fixtures, with no output or skipped library checks.                                                  |

`createControlledLifecycleStatusSourceV1` establishes only membership in its
private fixture map. Its explicit authenticated-handle type cast is test
scaffolding, not a production handle issuer. The controlled visible, denied,
hidden, and unknown-handle responses do not implement an account/session store,
selected IAM authority, owner-filtered repository, or authentic producer. The
fixture's supplied successful replies are synthetic data. No allowed account
observation, source provenance, provider fact, or effect authority is produced.

The fixture records each method, parsed request, and original call before
returning its controlled result. It does not sanitize results itself; the real
service and existing sanitized reader perform projection. Deliberately malformed
JavaScript replies in the conformance suite exercise that actual boundary.

Successful test values come from the existing
[`sanitized.json`](../lifecycle-status-projector-v1/sanitized.json). There is no
second positive fixture family here. Those values preserve no-head and nullable
protective states, distinct requested/selected/serving revisions, historical
operations, old source timestamps, partial and ambiguous discovery, unresolved
creates, and independent credential/retention conditions. Minimal mutation
results remain separate from read envelopes and are rejected as read results.

The real authentication and repository owners must supply the private
`LifecycleReadCallV1` and qualified source. That source owns fresh exact Agent
read authorization and hidden/foreign visibility at disclosure, including around
its own waits and on every page. Comparing the resolver's Installation and source
identities before and after an awaited read suppresses changed composition; it
does not establish current account or producer authority. Installation is private
server/store custody and is never added to the caller's canonical Namespace/Agent
scope. Missing dependencies remain unavailable.

The consumer imports
`@openclaw-enterprise/occ/lifecycle/status-service-v1` and the existing focused
contract/port subpaths. It accepts its original call from the application, performs
one explicit read per invocation, and starts no mutation retry or automatic page
walk. Compiling it verifies package and type correspondence, not successful
production composition. The compile-only negative function is never invoked.

With the repository's declared dependencies prepared, run the focused checks
from the repository root:

```sh
node --test --test-concurrency=1 tests/conformance/lifecycle-status-service-v1.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/lifecycle-status-http-v1/service.tsconfig.json --pretty false
```

The service suite checks portable-value preservation, one corresponding source
invocation, missing/invalid Installation, absent or throwing resolvers, changed
Installation/source during a wait, explicit page reads, closed source failures,
cancellation, signal replacement, redaction and request-response correspondence.
These are pure service/controlled-source tests. Transport integration, real
authentication, owner-filtered persistence, capability publication, runtime
reconciliation, and browser hookup require their own implementations and evidence.
