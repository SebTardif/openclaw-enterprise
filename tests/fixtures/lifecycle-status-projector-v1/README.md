# Lifecycle status projection fixtures

These synthetic fixtures exercise the public data boundary of
`projectLifecycleStatusReadV1` and document consumption of
`createSanitizedLifecycleStatusReaderV1`. They contain no authenticated source,
current-account grant, provider implementation, or evidence of a running Agent.

The fixture files have distinct purposes:

| File                    | Purpose                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `values.mjs`            | Fresh canonical data factories and separate richer inputs with synthetic private fields, accessors, cycles, and proxies for the real projector tests.       |
| `sanitized.json`        | Portable public test values for presentation and serialization checks. Its labels and grouping objects are fixture metadata, not a management API envelope. |
| `authorized-port.ts`    | Independently compilable examples that receive an external qualified reader and its original `LifecycleReadCallV1`, then invoke one sanitized read.         |
| `operator-consumer.ts`  | A presentation consumer using type-only imports. It preserves canonical values and closed failures without starting reads or mutations.                     |
| `projector-consumer.ts` | A server-side consumer of the pure projector, with method-specific canonical request and result types.                                                      |
| `type-negatives.ts`     | Compile-only checks for exact type aliases, receipt/read separation, opaque authentication, nullable facts, method correspondence, and readonly conditions. |

`sanitized.json` contains four minimal mutation results and eighteen read cases.
The mutation results use the existing `LifecycleMutationResultV1`: accepted and
unchanged receipts, conflict, and commit-unknown. A receipt retains only its
accepted operation or unchanged disposition; it supplies no detailed read,
current conditions, or serving proof. The read cases use the existing
`LifecycleReadResultV1<T>` for the four methods of `LifecycleStatusReadPortV1`:

| Method           | Canonical request                 | Successful value             |
| ---------------- | --------------------------------- | ---------------------------- |
| `readStatus`     | `LifecycleScopeV1`                | `LifecycleStatusV1`          |
| `readOperation`  | `LifecycleOperationReadRequestV1` | `LifecycleOperationStatusV1` |
| `listOperations` | `LifecycleOperationPageRequestV1` | `LifecycleOperationPageV1`   |
| `readCapability` | `LifecycleScopeV1`                | `LifecycleCapabilityV1`      |

The underlying schemas and strict request-response correspondence live in
`@openclaw-enterprise/contracts/lifecycle-admission-v1` and
`@openclaw-enterprise/contracts/lifecycle-observation-v1`. The projector's
`LifecycleStatusReadRequestV1<K>`, `LifecycleStatusReadValueV1<K>`, and
`LifecycleStatusReadResultV1<K>` alias those existing types. They do not define a
parallel protocol. The new OCC runtime entry points are
`@openclaw-enterprise/occ/lifecycle/status-projector-v1` and
`@openclaw-enterprise/occ/lifecycle/status-reader-v1`.

The public cases preserve distinctions that a renderer must keep visible:

- A missing head and an initial protective request retain nullable revision and
  observed-generation facts.
- Requested, selected, and previously serving revisions can all differ. An old
  serving revision remains informative while `serving` is false.
- An exact historical operation retains its original accepted identity and
  observation after the current head advances. The fixture's `historicalContext`
  links the two cases without adding fields to either canonical response.
- A partial page can have a continuation cursor equal to its last returned
  generation. Empty discovery does not prove rollback. Multiple accepted
  operations do not identify a lost mutation response; the `discoveryContext`
  deliberately has no accepted locator. Neither case permits an automatic POST
  retry or automatic choice of an operation.
- Old `observedAt` values remain old when `recordedAt` is later. The projector
  supplies no authoritative clock and does not refresh source evidence.
- Confirmed access denial can coexist with unknown physical termination or an
  unresolved possible create. Credential revocation and state retention remain
  independent conditions. The correlated `stopComplete` example is public test
  data, not proof that every runtime or possible create has been resolved.
- Legacy, drain, and live capability records remain declarations. They do not
  prove that a deployment's compatibility gate is installed or grant permission
  to mutate.

The richer inputs stay in `values.mjs`. Each `richLifecycleStatusReadCase(method)`
retains an independent public `expected` value and a `privateReads()` counter.
Dropped private accessors, serialization hooks, cyclic objects, and proxies must
not be examined. Canonical malformed public fields belong in rejection tests;
sanitization must not repair them into a positive result. No richer private
fields are serialized in `sanitized.json`.

A browser can load the portable JSON and use compatible type-only declarations
at its presentation boundary. It does not need to import OCC runtime modules or
Node-only canonical decoders to render the file. This directory does not install
a UI framework, browser bundle, server route, source adapter, or authenticated
transport. The application still needs its actual authorized reader and
independently qualified source composition. Compiling `authorized-port.ts` proves
its package/type usage, not authentication, current authority, repository
visibility, or safe execution of a provider effect.

From the repository root, the focused pure component tests are:

```sh
node --test tests/conformance/lifecycle-status-projector-v1.test.mjs
node --test tests/conformance/lifecycle-status-reader-v1.test.mjs
```

Those tests exercise the real projector and bounded reader adapter. Actual
current-account authorization, persisted owner filtering, production route
registration, runtime reconciliation, and browser integration require their
respective implementations and verification. Consumer compilation is a separate
check: each of the four TypeScript files is a standalone entry point importing
the public package exports, with strict checking and no skipped library checks.

To regenerate the portable file after an intentional fixture change:

```sh
node --input-type=module <<'EOF'
import { writeFileSync } from 'node:fs';
import { lifecyclePortableFixtures } from './tests/fixtures/lifecycle-status-projector-v1/values.mjs';
writeFileSync('tests/fixtures/lifecycle-status-projector-v1/sanitized.json', JSON.stringify(lifecyclePortableFixtures(), null, 2) + '\n');
EOF
```

Review regenerated values against the canonical parsers and their semantic
correspondence. The fixture generator provides data; it does not implement the
projector or authorize any read.
