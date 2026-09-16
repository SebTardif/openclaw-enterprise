# Credential gateway protocol DATA checks

Run these checks from the repository root with Node.js 24 or newer and the
matching installed workspace dependencies:

```sh
pnpm check:credential-gateway-types
node --test tests/conformance/credential-gateway-protocol-data.test.mjs
node --test tests/conformance/credential-gateway-metadata-data.test.mjs
```

The protocol suite exercises the two constructors through the public OCC
entry point. It protects distinct request and client identities, nominal digest types,
fixed fetch and PR targets, ordered digest encodings, and
immutable repository/input snapshots. Independent vectors include the 154-byte
PR body with escaped quotes and Unicode. Hostile inputs cover throwing and
reentrant getters, bounds, invalid native byte storage, and caller mutation
after byte capture. The metadata suite preserves its separate numeric domain.

The new protocol constructors accept canonical positive decimal identifiers
of at most 32 digits without converting them to numbers. Both validate the
repository's matching owner/name path, bounded resource/schema fields and
positive safe-integer schema version. Fetch additionally requires a lowercase
64-hex schema digest. PR retains the metadata schema digest's bounded text domain.

Fetch takes observed encoding/framing/count data and decoded native bytes. It
copies fixed, attached ArrayBuffer storage using native accessors; shared,
resizable, detached, proxied or non-Uint8Array input fails with `null`.
Discovery requires an empty identity body and no Expect or chunked framing.
Fetch requires a nonempty decoded body and content-length or chunked framing.
Encoded and decoded byte counts each fit 1 MiB.

PR takes all six normalized fields, including explicit body/draft defaults and
`maintainer_can_modify: false`. It checks Unicode scalar strings, branch syntax,
256-byte titles, 1024-byte branches, 60 KiB bodies and 64 KiB serialized JSON.
It returns the exact JSON alongside the operation. Request adapters own raw
UTF-8/JSON parsing, duplicate/unknown-field rejection, defaults and HTTP 400/413
responses. Constructor refusal is `null`; it does not select an HTTP status.

The push-result input type exposes only operation kind, destination ref names
and capabilities. The existing observer owns their bounded snapshot and
response parsing. This type cannot construct an operation, capture or permit.

## Compiler and CI coverage

The strict credential-gateway compiler target includes both the OCC fixture and
`apps/credential-gateway/type-tests/github-protocol-data.ts`. They import the
curated public entry point through real package resolution. The app fixtures
call the existing metadata, fetch and PR constructors with their public inputs;
they project complete push facts to the smaller status-observer input and consume
HTTP/PR results. They check a compiler seam, not migrated native adapters.

`GitHubProtocolRepositoryV1` retains the metadata repository's readonly schema.
`GitHubProtocolOperationV1` has seven separately discriminated members: metadata,
fetch discovery/fetch, push discovery/probe/push and PR creation. Each member
retains its fixed host/method and required facts. Its identities and digests are
strings; constructor-refined fetch/PR DATA assigns to it, while structural DATA
cannot assign back to the nominal views or original authority handles.

The result declarations preserve finite status/code pairs, partial upload/ref
observations, unknown stages and exact optional-field presence. `HTTPResult<T>`
is the sole HTTP envelope; `Result<T>` is its compatibility alias. Provider
`pr-created` with status 201 is an observation, while `created` receipt DATA also
requires original operation/receipt IDs and replay information. These declarations
supply neither validation nor proof that a receipt committed.

Negative cases protect hidden exports, nominal category swaps, seven-way
extraction, literal routes/API fields, non-submission classification, forbidden
status/code combinations, missing receipt fields and nested readonly data. The
target sets `skipLibCheck: false` and is included in `pnpm typecheck`, the existing
baseline CI compiler step and protocol-suite preparation hook.

For a separately built OCC artifact, set the test-only
`OCC_TEST_PROTOCOL_DATA_ENTRY` to its absolute entry-point file path.
The suite then executes those emitted constructors with the same vectors and
hostile cases. To check physical emitted declarations, first run `pnpm exec tsc --build
tsconfig.json --force --pretty false`. Compile both fixtures with strict checking,
`exactOptionalPropertyTypes: true` and `skipLibCheck: false`, resolving the OCC
public import to `packages/occ/dist/index.d.ts` and the OCC-only original-module
imports to their corresponding emitted declarations. Use the freshly built files;
never supply fabricated declarations, ambient modules or a source fallback.
Ordinary workspace package resolution still selects source; this separate check
does not certify a packaged installation.

## Qualification boundary

These checks establish constructor and public API behavior. They do not prove
native packet parsing, gzip integrity, EOF/trailers, cancellation or finite
cleanup. The fetch and PR request adapters integrate this DATA contract in
separate changes. Work/IAM admission, grants,
credential custody, durable PR claims/receipts, ordinary Agent use, installed
gateway behavior and live GitHub effects require their own integration proof.
The PR digest's fixed write-profile label supplies DATA rather than grant
admission. See [HTTP component checks](credential-gateway-http.md) and
[CI selection](ci.md) for adjacent proof.
