# Credential gateway protocol DATA checks

Run these checks from the repository root with Node.js 24 or newer and the
matching installed workspace dependencies:

```sh
pnpm check:credential-gateway-types
node --test tests/conformance/credential-custody-construction.test.mjs
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
and capabilities. The integrating observer must own their bounded snapshot and
response parsing. This type cannot construct an operation, capture or permit.

## Compiler and CI coverage

The credential-gateway type fixture imports the curated public entry point
and checks assignment to the original private operation types inside OCC.
Negative cases protect hidden exports, nominal category swaps, literal
kind/host/method/API fields and nested readonly data. The baseline CI preparation
compiles this fixture before the protocol suite runs.

For a separately built OCC artifact, set the test-only
`OCC_TEST_PROTOCOL_DATA_ENTRY` to its absolute entry-point file path.
The suite then executes those emitted constructors with the same vectors and
hostile cases. Declaration consumers must use strict checking with
`skipLibCheck: false` and the actual emitted root declarations.

The custody construction test loads the controller facade through the gateway's
package resolution and verifies its implemented exports. Deferred capture/open
and SQL-envelope factories remain type-only; compiler fixtures check their
construction signatures. Set `OCC_TEST_CUSTODY_CONSTRUCTION_ENTRY` to the absolute
emitted controller facade path to repeat the module-loading check against JavaScript.
This check constructs no owner and performs no credential operation.

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
