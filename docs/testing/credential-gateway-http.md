# Credential gateway HTTP head checks

Run the focused native HTTP component checks from the repository root with Node.js 24 and the pinned pnpm version, using a matching frozen dependency installation:

```sh
pnpm check:credential-gateway-http-types
node --test tests/conformance/credential-gateway-http-request.test.mjs
pnpm check:workspace
pnpm format:check
git diff --check
```

The request inspector returns deeply frozen, untrusted route and framing candidates. It inspects the actual `IncomingMessage` method, target, HTTP version and flat `rawHeaders`, without reading a body or retaining Authorization text. Missing credentials can still produce a parsed head; subsequent credential presentation and authentication own that decision.

The tests send actual bytes through loopback raw sockets into Node's strict HTTP/1.1 parser. They exercise all six routes, literal repository spelling, route and query ambiguity, singleton header admission, framing and declared body caps, content coding, canonical PR operation IDs, and header count and size denials. A native parser rejection is recorded separately from an inspector denial. Each exchange has a finite socket timeout and closes its server and sockets.

A consuming server must use `maxHeaderSize: 32768`, `insecureHTTPParser: false`, and `maxHeadersCount = 0`. The zero count setting preserves every raw pair so the inspector can reject more than 64 pairs. The native parser enforces original request-head bytes; the inspector's retained name/value ceiling is supplemental and cannot reconstruct wire bytes. The target operand ceiling is 32 KiB. Headers and values use a closed singleton ASCII policy. Incoming Host names support only the two GitHub hosts, with optional port 443.

GET candidates have zero body limits and accept only absent or zero Content-Length. Fetch POST candidates permit 1 MiB, push POST candidates 256 MiB, and PR JSON candidates 64 KiB, for both wire and decoded limits. Declared lengths are checked here. Actual EOF, chunk framing, trailers, gzip validity, decoded counters, stream use and body authorization remain separate obligations.

These checks qualify this component only. The authenticated HTTPS server must share inspection between request, checkContinue and checkExpectation handling, validate SNI/Host, reject CONNECT and upgrades, reserve capacity and authenticate before emitting 100 Continue, and enforce body and authority deadlines. Head inspection cannot establish a push probe. The `checks-baseline` CI lane runs the focused compiler and this conformance file; see [CI suite ownership](ci.md). Production callers, curated package exports, independently installed backend composition, ordinary Agent workflows, replicas and live GitHub operations require their own acceptance evidence.

If a case fails before the inspector runs, investigate the native parsing boundary. If the focused compiler cannot resolve Node types, restore the repository's matching declared dependency installation; do not substitute transitive packages. A passing root build does not select this isolated gateway configuration.
