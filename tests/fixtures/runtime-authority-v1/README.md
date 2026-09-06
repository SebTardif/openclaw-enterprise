# Runtime authority contract fixtures

The versioned module is exported by `@openclaw-enterprise/contracts`. It defines
the local `RuntimeAssignmentAuthorityV1` port, strict request/result parsers,
immutable direct Kubernetes gateway and gVisor harness bindings, independent
evidence records, and the injected `RuntimeAuthorityContextFactoryV1` dependency.
Existing OCC allocation and intent value types retain their original fields and
imports through the OCC state module. No runtime authority provider is installed.

`producer.ts` compiles an unavailable provider against the actual port and existing
OCC read repository. `run-consumer.ts` handles every binding/readback outcome;
`credential-consumer.ts` handles all seven lookup results and the separate restore
suboperations. `type-negatives.ts` checks nominal context separation and the
compatible type extraction. Each has an independent TypeScript project.

Run the focused structural vectors with:

```sh
node --test tests/conformance/runtime-authority-v1.contract.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.producer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.run-consumer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.credential-consumer.json
node node_modules/typescript/bin/tsc --project tests/fixtures/runtime-authority-v1/tsconfig.type-negatives.json
```

## Incremental compiler checks

Prepare dependencies and the upstream SDK separately, then inspect preparation
with `node scripts/check-development-setup.mjs --json` before compiling. Each
configuration checks its original source and declaration dependencies with the
same strict options. Fixture checks use `noEmit`; package declaration builds and
the workspace project references keep their existing commands and behavior.

The first check writes TypeScript build information to
`.build/runtime-authority-v1/<project>.tsbuildinfo`. Later checks reuse unchanged
semantic diagnostics. TypeScript still reads current inputs and invalidates
changed source, declarations, compiler options and affected consumers. The four
project names are `producer`, `credential-consumer`, `run-consumer` and
`type-negatives`; each owns a separate file.

Keep these ignored files local to the current worktree. Serialize checks of the
same project within a worktree, and never copy or share its build information or
package `dist` with another worktree. A fresh compiler check can use an unused
`--tsBuildInfoFile` path under that worktree's `.build` directory. Append
`--extendedDiagnostics` to the commands above to observe parse, check and emit
work; an unchanged incremental run can omit checking while still parsing inputs.
Emitting build information does not mean fixture JavaScript or declarations were
emitted.

A successful `type-negatives` compile means all four `@ts-expect-error`
assertions still reject their annotated inputs. If a declaration change makes an
assertion valid, TypeScript reports an unused directive and the check fails.
Both fresh and reused type errors return a nonzero status; cached failure output
is not passing evidence.

Run the compiler-cache regression with:

```sh
node --test tests/conformance/runtime-authority-incremental.test.mjs
```

It uses the four configurations in temporary, independently owned declaration
projects to verify source/configuration/declaration invalidation, expected-negative
errors and cache separation. The full fixtures above retain responsibility for
checking the actual runtime authority and SDK types.

The parsers reject unknown fields/versions/purposes, duplicate JSON keys, invalid
codecs, intrinsically contradictory timestamps and incompatible result tags.
Image entries use unique names in ascending ASCII order. Registry references and
digests never dereference URLs or fetch profiles. Binding snapshots have no latest
observation pointers; a protected observation is separate from instance identity.

The context factory is a required process-local verification dependency, with no
provided constructor that turns JSON into trust. Its implementation must retain
actual transport provenance and reject copied, foreign, stale or wrong-recipient
handles. Type branding alone is not authentication. The authority must validate
the factory result, current allowed role/scope and exact protected records on every
call; a parser cannot establish them.

Positive lookup results are observations at their original source times. They are
not bearer grants, cached authorization or permission to issue model/repository
effects. Current human/turn/resource policy and the real accepting-boundary guard
remain separate. Candidate registration/probe/restore is not serving. Retained
cleanup is not physical termination, provider-token revocation or permission to
touch a successor. Unknown commits and not-found readback permit only exact
readback, never an inferred retry/create.

These are contract and compilation checks. They do not execute authentication,
an OCC authority transaction, PostgreSQL replay, provider discovery, registration,
runtime qualification, restoration, protected process restart observation or
physical stop. Actual implementations must supply those checks. Direct gVisor
requires observed predecessor termination and resolved possible creates before
any writable successor, including initialization, restore and repair. Neither a
generic fence nor a syntactically valid evidence reference establishes that proof.
