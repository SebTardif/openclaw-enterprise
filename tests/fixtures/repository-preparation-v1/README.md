# Repository preparation V1 conformance fixtures

This fixture family imports the supported `@openclaw-enterprise/contracts/repository-preparation-v1` and `repository-preparation-codec-v1` package subpaths. It preserves the original credential package's exports and semantic encoding. Source imports do not use the broad contracts barrel.

## Independent compilation

Each producer or consumer has its own strict TypeScript configuration:

| File                     | Role                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `producer.ts`            | Boundary adapter examples requiring real protected credential/receipt owners and a trusted evaluation clock. It creates no authority, material, token or receipt handle. |
| `credential-consumer.ts` | Consumes all preparation credential methods, pairs purpose/request/results and preserves actual custody handles.                                                         |
| `lifecycle-consumer.ts`  | Retains live receipt handles across a lifecycle read and calls the original producer's currentness check before consuming a diagnostic.                                  |
| `compute-consumer.ts`    | Preserves original producer clocks and exact staging/effect correspondence, with explicit separation from concrete runtime applicability.                                |
| `type-negatives.ts`      | Requires compile errors for purpose relabeling, original/preparation substitutions, invented custody, missing protected receipt handles and immutable-value writes.      |

The configurations inherit strict, exact optional property and unchecked-index checks from `tsconfig.base.json`. They also inherit `skipLibCheck: true`; this fixture does not claim a declaration-library audit. The declaration configuration emits only the selected leaf closure and does not build every workspace project.

## Pure runtime checks

`tests/conformance/repository-preparation-v1.contract.test.mjs` uses the existing Node conformance-test layout. `vectors.mjs` supplies synthetic, non-resolving metadata for all schema-map entries. `traces.mjs` provides eight immutable sequences covering successful ordering, replacement/cancellation, unknown effects, late CAS reconciliation, protected receipt correspondence, independent serving resources, audit failure and unknown expiry. Trace actions are normative requirements, not simulated durability or producer enforcement.

Run from the repository root using installed compatible tools directly:

```sh
node --test tests/conformance/repository-preparation-v1.contract.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/declarations.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/producer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/credential-consumer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/lifecycle-consumer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/compute-consumer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/repository-preparation-v1/negatives.tsconfig.json --pretty false
```

Node must support the repository's TypeScript execution convention. These checks make no network, native client, provider, token or runtime calls. They validate schemas, encoders, immutable decoding, request/result relationships and independent import compatibility. Protected backend transactions, authority enforcement, actual Job identity, credential custody and readiness require separate integration evidence.
