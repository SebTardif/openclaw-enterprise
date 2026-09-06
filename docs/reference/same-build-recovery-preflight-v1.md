# Same-build recovery preflight V1

The public `@openclaw-enterprise/occ/persistence/same-build-recovery-preflight-v1`
entry currently compares the existing decoded `ProducerTupleV1` and
`CheckpointRefV1` values. It provides `compareRecoveryProducerTupleV1` and
`compareRecoveryCheckpointV1`, plus an enclosing
`evaluateSameBuildRecoveryPreflightV1` that preserves the missing native candidate
boundary as `unavailable`.

The two descriptor comparison helpers may return `compatible` or `incompatible`.
The enclosing preflight currently returns only `incompatible` or `unavailable`:
a complete original-owner native candidate/capability descriptor and accepted
predecessor/target replacement declaration are not available to this module.
There is no successful full-recovery preflight or runtime wiring. Matching the
existing artifact-ledger reference does not independently compare its unresolved
material image digests or prove the deployed images.

Every result is an inert local comparison. A compatible descriptor result does
not establish checkpoint currentness, actual native capability, current
authorization, retained-store integrity, prior-writer termination or permission
to import or activate a runtime.

A complete recovery comparison requires the exact admitted revision,
configuration version and digest, source and build identities, protocol and
schema versions, native import adapter and complete material artifact tuple.
Unknown versions and changed material inputs cannot qualify merely because two
version strings or transport envelopes agree. A future transport envelope must
preserve the canonical UTF-8 RFC 8785 bytes and their digest unchanged; its
version is independent of checkpoint, native database and adapter versions.

The current checkpoint must match the exact expected checkpoint identity,
completion sequence, digest and metadata. Numeric counters stay within the
nonnegative safe-integer range, and a completed recovery checkpoint has a
positive completion sequence. Hash comparison operates on the original bytes;
it does not parse, canonicalize, normalize or reserialize their JSON.

The required, not yet bound replacement comparison names gateway-only, harness-only or both components,
and compares the exact expected predecessor and target assignments. The replaced
component gets a different assignment; the retained component keeps its expected
assignment. Historical checkpoint-producing assignments remain provenance and
may differ from the immediate predecessor after earlier replacements.

Required quiet allocation, restricted completed-context import, exact owned
segment readback and finite transport/import capacity must be explicitly
supported. An absent capability remains unavailable. Comparison never falls
back to ordinary native start/resume, chooses an older checkpoint, creates an
empty context, performs a conversion or replays a historical turn.

The native and runtime owners separately supply the authentic descriptor
producers, native importer and receiver, current preparation authority, complete
store verification and physical prior-writer evidence. They retain the actual
gateway-only, harness-only and combined replacement tests, as well as schema,
filesystem, fault and subsequent-context-continuation qualification.

## Usage and verification

Supply values from the original trusted decoders and server-owned records. The
checkpoint helper compares all immutable reference fields and hashes the original
bytes with SHA-256. Its sanity guards reject missing fields, unknown versions and
unsafe counters; they are not a JSON/native decoder or provenance check. It does
not establish that arbitrary matching bytes are canonical or that their contents
match a manifest; those are original producer/decoder obligations.

```ts
const result = evaluateSameBuildRecoveryPreflightV1({
  expectedCheckpoint,
  checkpoint: decodedManifest,
  candidateTuple: decodedCandidateTuple,
  canonicalBytes,
});
// Exact available comparisons currently end with:
// { kind: "unavailable", reasonCode: "native-candidate-descriptor-unavailable", ... }
```

Run the focused pure tests and strict public-subpath consumer check from the
repository root with the declared Node version and prepared locked dependencies:

```sh
node --test tests/unit/same-build-recovery-preflight.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/same-build-recovery-preflight-v1/tsconfig.json --pretty false
```

The fixture bytes and tuples are synthetic comparison data. These tests establish
full-field comparison, preserved bytes, safe-integer rejection and the explicit
unavailable boundary. They execute no storage, native import, capability
negotiation or replacement. Actual changed-image/material-ledger comparison,
capability and capacity agreement, and all three expected assignment replacement
variants remain pending the original declarations and consumer handoffs.
