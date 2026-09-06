# Shared native scenario fixtures

These fictional Slack/Teams traces check the relationships between injected admission labels, dispatched work, scoped context and immutable output targets. They contain opaque references and no native journal or provider payloads. Every result remains `evidenceAuthenticated:false` and `runtimeQualified:false`.

- `manifest.json` selects the exact current SDK source, declaration/export targets, archive/package layout, dependency preparation and original profile identities. The checker compares these selected identities; it does not open those external artifacts or certify them.
- `cases.json` defines the fixed 20-case selection, explicit supplied `mentioned-text` input-path labels, two-human interaction labels and accepted attempt bindings. Busy/duplicate/conflict labels come from the scenario, not a new permission or receipt classifier.
- `traces.json` supplies ordered synthetic observations for each case. Native completion and the separate labeled OCC checkpoint record have different event kinds.
- `checker.ts` accepts three JSON strings through `checkScenarioPacket`, validates bounds/shapes and produces deterministic coverage/findings. Its only runtime dependency is Node's built-in `Buffer`.
- `consumer.ts` uses only erased public SDK type imports and schema result signatures. `observePublicTurn` projects already-decoded public values without calling a decoder, callback or SDK API. This observation projection is a separate input boundary; it does not manufacture admission labels or OCC checkpoint evidence.
- `consumer.tsconfig.json` defines the authored strict consumer policy. A selected private linked preparation may add `preserveSymlinks:true`, explicit Node24/ws8 type roots and its exact owned fixture paths. Preserve the original source bytes and full configuration difference in its receipt.

Run the focused tests from an already prepared repository root:

```sh
node --test --test-concurrency=1 --test-reporter=tap tests/conformance/shared-native-scenarios-v1.test.mjs
```

The 20 scenarios are coverage identities, not a count of live native attempts or the number of Node tests. See [the reference](../../../docs/reference/shared-native-scenarios-v1.md) for observation semantics, limits, current public input requirements and original-owner handoffs.
