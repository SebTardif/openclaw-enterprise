# GitHub repository metadata protocol checks

Run the focused compiler and native HTTP suites from the repository root with the
current installed workspace dependencies:

```sh
pnpm exec tsc --project apps/credential-gateway/tsconfig.metadata.json --noEmit --pretty false
node --test tests/conformance/credential-gateway-metadata.test.mjs tests/integration/credential-gateway-metadata-http.test.mjs tests/conformance/credential-gateway-http-request.test.mjs
```

The checks exercise the application metadata adapter over real local Node HTTP
sockets. The request consumer calls the existing native request-head inspector,
requires the exact enrolled `/repos/{owner}/{name}` route, and waits for complete
zero-body EOF without trailers. The package-root
`createGitHubMetadataOperationV1` constructor supplies immutable
`GitHubMetadataOperationV1` request DATA and a versioned digest; these facts grant
no access or dispatch authority.
Client authorization and display headers are excluded from the facts.

The response consumer reads an actual Node `IncomingMessage`, accepts HTTP/1.1
status 200 with explicit Content-Length or chunked framing, and limits identity
JSON to 1 MiB. It refuses redirects, credential-bearing headers, alternative
coding, incomplete framing, trailers, invalid UTF8 or JSON, duplicate selected
root keys, and mismatched repository identity. It returns only `id`, `full_name`,
`private`, and `default_branch`, after complete verification. Numeric repository
IDs must be positive safe integers and exactly match the enrolled decimal ID.
The selected root number token is compared losslessly: `303`, `303.0`,
`3.03e2` and `30300e-2` identify the same repository, while fractions that
JavaScript would round to that integer are refused. Huge exponents are bounded
without exponent-sized allocation. Repository renames require enrollment to
resolve the new canonical identity.

The caller supplies an already-resolved repository selection and absolute
millisecond deadline with its original AbortSignal. The adapter snapshots identity
before awaiting the stream, checks cancellation and deadline throughout collection
and after awaits, and releases its listeners and timer when it settles. The
original native signal state is checked after the last caller-controlled getter
and before success, followed by a fresh clock check. Abort subscription resists
earlier `stopImmediatePropagation` listeners; unsupported signal property or
prototype shadows are refused without invoking their method getters. Cleanup uses
captured native removal even if a caller changes the signal methods after start.
Mutation cannot extend the original deadline or replace cancellation. Pass a fresh, unread
message stream without a text decoder or another body consumer.

The raw controlled-origin integration fixture covers length and chunked success,
extra-field canaries, malformed JSON/UTF8, identity and type mismatch, the exact
size boundary, overflow, trailers, truncation, redirects, headers, abort, deadline,
selection mutation and socket cleanup. Strict native parser rejection is recorded
separately when Node refuses a wire message before creating IncomingMessage.

This evidence covers the protocol component. The adapter opens no upstream
connection and emits no credentials. The authenticated gateway facade, genuine
access and inspection slot, registered operation capture, broker, TLS transport,
Work/IAM composition, installed runtime and live GitHub qualification remain
separate integration requirements. These suites require no database or GitHub
credentials. Full workspace, Controller and OpenAPI checks still require their
complete current dependency graph; a focused validation overlay does not qualify
shipping dependency pins.

For a refusal, inspect the finite result kind: `invalid-request`,
`invalid-response`, `limit-exceeded`, `unavailable`, `aborted`, or `expired`.
Provider bodies, headers and raw error text are never returned. If a local socket
cannot bind, record the host permission or loopback visibility gap before judging
the protocol behavior.
