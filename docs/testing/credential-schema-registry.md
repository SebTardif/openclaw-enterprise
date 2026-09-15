# Credential schema runtime verification

Run the canonical JSON component conformance file from the repository root with
the pinned Node.js 24 toolchain and the prepared workspace dependencies:

```sh
node --test tests/conformance/credential-schema-json.test.mjs
```

The suite imports the actual internal OCC implementation. Independent expected
strings check recursive UTF-16 key ordering, array order, negative-zero
normalization, scalar escaping, Unicode and number encoding. Other cases check
immutable own-data snapshots, source mutation, finite limits, byte/depth/node
boundaries and denial without executing caller getters, `toJSON` or proxy traps.

## Canonical JSON protocol

`snapshotCanonicalJsonV1(input, {maxBytes, maxDepth})` returns a deeply frozen
JSON value and its canonical string. Objects become own-data objects with a null
prototype; arrays retain their order. Repeated references are copied separately;
cycles deny. Object keys sort by UTF-16 code units. Scalars use JSON.stringify
escaping and number formatting after complete JSON admission. Negative zero
becomes zero. The encoder emits no whitespace and counts UTF-8 bytes as it emits
each bounded chunk. This protocol does not claim RFC 8785 compatibility.

Limits are positive safe integers: at most 65,536 canonical UTF-8 bytes and depth 32. The root has depth zero. Each call permits at most 8,192 value nodes,
including the root. A preliminary minimum-byte budget bounds the admitted copy;
the encoder then enforces the exact canonical byte limit. Admission rejects
nonfinite numbers, undefined, bigint, functions, symbols, accessors, hidden or
symbol properties, nonplain objects, proxies, sparse arrays and extra array
properties. Malformed inputs and limits produce the sanitized `INVALID_VALUE`
error. Input objects with Object.prototype or a null prototype are supported.

## Proof boundary and integration

These checks establish canonicalization and immutable bounded data for the
schema runtime. The helper is internal and supplies no identity, authentication,
nonsecret semantic guarantee or dispatch authority. Schema admission, registry
ownership, digests and strict restoration belong to the registry implementation.

The `checks-baseline` CI lane runs canonical JSON, admission and registry
conformance files and
`pnpm check:credential-gateway-types` for the five explicit contract fixtures;
see [CI suite ownership](ci.md). Required broader proof remains actual installed
external-package startup and rollback, the registry through broker/State/IAM/Work,
the regular Agent workflow, two installed replicas and live GitHub operations.
Component conformance does not satisfy those integration requirements.

When a case fails, check the exact canonical byte count and root-zero depth first.
Unsupported data must be converted explicitly by its trusted producer before
admission. Do not add coercion or invoke caller serialization hooks to repair it.

## Registry lifecycle verification

Run the registry conformance suite against the same prepared dependencies:

```sh
node --test tests/conformance/credential-schema-registry.test.mjs
```

The suite uses the actual registry, accepted schema compiler, Ajv evaluator and
canonical JSON implementation. A subprocess runs from packages/occ and imports
the public @openclaw-enterprise/occ entry point, then registers, commits,
validates, retains, restores and discards a schema. Independent schema and value
digest calculations check the domain-separated wire protocol. This public package
self-import exercises the current source entry point; it does not establish
installed external-package startup or regular Agent integration.

Trusted startup supplies exact recipe `DefinitionRef` identities and the required
`admittedPrimitives` data allowlist to `createCredentialSchemaRegistryV1`.
Definitions include recipe ID/version/digest, the recipe contract version and
exact interpreter primitive. Each admitted identity begins one registration
scope. Packages receive the scope's `schemas` owner and submit data-only
registrations naming their canonicalization primitive. The fixed internal
catalog permits only exact installed and Installation-admitted name/version/digest
matches of the correct kind. Callback, factory, resolver, path, module and URL
injection refuse without invoking caller code.

Registration stays pending until `commit()` seals it. Duplicate
role/schema namespace/name/version tuples reject even when digests agree.
Codec operations require a committed scope. `discard()` is idempotent and
permanently invalidates every codec and value, including formerly committed
scopes. Private WeakMaps authenticate original codecs and values. Foreign
registries, other codecs, copies, borrowed method receivers and mismatched
bindings reject. Reentrant operations during canonicalization reject; discard
during evaluation prevents issuance and revokes earlier handles.

The normal suite uses the actual static catalog. A dedicated isolated Node
subprocess runs `tests/fixtures/credential-schema-primitive-faults.mjs` with
`--experimental-test-module-mocks` and substitutes only the internal installed
canonicalizer selection. It preserves the actual compiler, Ajv, bounded encoder
and registry while exercising trusted-code throw, bad post-output, non-idempotence,
reentry and discard faults. The original eight/nine-field `__proto__` matrix runs
at root, nested object and array-item placements with optional/required keys.
The production API exposes no fault flag, injected implementation or public hook.
These fault cases establish containment of substituted trusted-code faults;
they do not establish a real backend-specific primitive's semantic correctness.

## Primitive and schema digests

The generated internal manifest binds the final installed source closure
(`schema-primitives.ts`, `schema-admission.ts`, `schema-json.ts` and the public
`schema.ts`) and Ajv 8.20.0. Both fixed primitive entries hash
`oce-core-schema-primitive-v1` followed by NUL and canonical JSON containing
`kind`, `name`, `version`, sorted `files: [{path, sha256}]` and
`dependencies: {ajv: "8.20.0"}`. The generated manifest excludes itself.
The conformance fixture independently hashes final source bytes and checks
literal manifest digests, so source changes require regenerated pins before
review. Changing descriptor data never introduces another implementation.

Current schema digests hash `oce-schema-recipe-v1` followed by NUL and the exact
canonical object `{canonicalization, jsonSchema, maxBytes, maxDepth,
profile: "oce-closed-draft7-v1"}`. The canonicalizer identity and both independent
limits are bound. Old package-first schema digests cannot be reused as recipe
evidence. Run all three current component suites together:

```sh
node --test tests/conformance/credential-schema-json.test.mjs tests/conformance/credential-schema-admission.test.mjs tests/conformance/credential-schema-registry.test.mjs
node scripts/ci/run-tests.mjs audit
pnpm check:credential-gateway-types
```

## Retention and restoration

Retained values contain copied frozen binding data, canonical JSON and a
domain-separated SHA-256 digest; they carry no authority. Restoration accepts
exact ordinary own-data envelope fields, checks binding and digest, bounds text
before parsing, and requires canonical re-encoding to match the original bytes.
It reruns the installed canonicalizer and rejects any changed canonical result.
Successful restoration issues a fresh local handle. Missing or extra fields, accessors,
proxies, malformed JSON, duplicate keys, whitespace, noncanonical numbers and
identity/version/digest changes reject without migration or repair.

The canonical payload's declared byte bound applies independently of envelope
overhead. A valid 65,536-byte payload remains restorable even when escaping that
payload makes the retained envelope larger. Consequential failure cases also
check installed primitive input/output rejection, mutation after registration,
permanent discard, receiver ownership and denial without getter or proxy effects.

If restoration fails, verify exact definition and schema identity, domain digest,
canonical bytes and the installed canonicalizer's idempotence. Reissue data
through its trusted producer when those facts change; retained data must not silently repair them.
The required checks-baseline lane enrolls all three suites. The broader caller,
installed and live-provider requirements above remain open.

## Unsupported legacy records

Current recipe admission and restore explicitly refuse `credential-backend-v1`
records without mutation, relabeling or deletion. The suite retains the original
complete package-first vector and its literal schema/value digests, then verifies
refusal and unchanged bytes alongside a successful current recipe round trip.
Preserve the accepted legacy supplier and original retained bytes/digests.
Readback and cleanup of existing obligations remain with the original approved
version and owner. No upgrade/removal may abandon those obligations or invent
cleanup authority. See the [contract reference](../reference/credential-gateway-v1.md)
for the current supported identity boundary.
