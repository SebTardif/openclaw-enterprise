# OCE external model dataplane

This directory contains the selected Dream Serpent Rust components and two OCE
adapters: `oce-dnsgate` for DNS admission and scoped nftables enforcement, and
`oce-egress` for fixed-origin HTTPS model requests with external credential custody.
The TLS adapter uses Hyper HTTP/1 and rustls on the exact admitted socket.

The workspace also includes the inactive `oce-native-egress` library for a
finite GitHub HTTPS route profile. It has no executable or positive production
admission supplier. See [GitHub transport](../docs/reference/native-github-egress.md)
for its credential boundary, DNS validation, and real-client test commands.

The [external egress reference](../docs/reference/egress.md) owns configuration,
local-development commands, supported boundaries and troubleshooting. The
[request flow](../docs/flows/external-model-egress.md) traces the implementation.
The [platform design](../docs/design.md) remains authoritative.

From the repository root, after explicit dependency preparation, run:

```sh
node scripts/build-mvp.mjs native
```

The build uses the pinned Rust toolchain and locked, offline Cargo dependencies;
it emits only the two selected executables under `.build/mvp/native/`. Missing
cached dependencies or toolchains fail explicitly. See the reference for image
preparation and the local launcher. These adapters require a separate canonical
OCE authority; this source does not provide that service. Missing authority denies
readiness and provider dispatch. This is an implementation candidate, not a
qualified production deployment or proof of a provider-backed turn.

Library and adapter tests are retained with their fixtures. Tests using controlled
authority frames or recorded enforcement prove those component decisions, not
canonical authorization or kernel effects. Tests requiring local sockets must run
in an environment that permits those sockets. The `disposable_nft_probe` example
is a verification tool; run it only in an explicitly owned disposable network
namespace with the required capabilities. It is not a shipped daemon.

See [LICENSE](LICENSE), [NOTICE](NOTICE), [source manifest](SOURCE_MANIFEST.json),
and [dependency notices](third-party-notices/THIRD_PARTY_NOTICES.txt) for attribution.
