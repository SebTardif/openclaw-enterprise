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

The `checks-baseline` CI lane runs this conformance file and
`pnpm check:credential-gateway-types` for the four explicit contract fixtures;
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

Trusted startup supplies exact admitted DefinitionRef identities to
createCredentialSchemaRegistryV1. Each identity can begin one registration
scope. Packages receive the scope's schemas owner. Registration remains pending
until commit() seals it; duplicate definition/role/schema namespace/name/version
tuples reject even when their digests agree. Codec operations require a committed
scope. discard() is idempotent and permanently invalidates every codec and value
from the scope, including a formerly committed scope.

The registry authenticates codecs and validated values with private WeakMaps.
Foreign registries, other codecs, copied handles, borrowed method receivers and
mismatched bindings reject. Semantic validation receives a frozen bounded copy
after real schema validation; its output passes the same validation again. Nested
codec operations during a hook reject. A hook may discard its scope, but the
outer operation then rejects before issuing a value. Synchronous hooks cannot
be preempted; reviewed hooks must terminate and enforce nonsecret semantics.
Schemas alone cannot identify arbitrary secrets.

## Retention and restoration

Retained values contain copied frozen binding data, canonical JSON and a
domain-separated SHA-256 digest; they carry no authority. Restoration accepts
exact ordinary own-data envelope fields, checks binding and digest, bounds text
before parsing, and requires canonical re-encoding to match the original bytes.
It reruns the semantic hook and rejects any changed canonical result. Successful
restoration issues a fresh local handle. Missing or extra fields, accessors,
proxies, malformed JSON, duplicate keys, whitespace, noncanonical numbers and
identity/version/digest changes reject without migration or repair.

The canonical payload's declared byte bound applies independently of envelope
overhead. A valid 65,536-byte payload remains restorable even when escaping that
payload makes the retained envelope larger. Consequential failure cases also
check hook input/output rejection, mutation after registration, permanent
discard, receiver ownership and denial without getter or proxy effects.

If restoration fails, verify exact definition and schema identity, domain digest,
canonical bytes and the hook's idempotence. Reissue data through its trusted
producer when those facts change; retained data must not silently repair them.
The existing CI/navigation owner retains suite enrollment and full documentation
integration. The broader caller, installed and live-provider requirements above
remain open.
