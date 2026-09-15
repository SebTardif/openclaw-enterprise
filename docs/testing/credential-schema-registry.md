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
