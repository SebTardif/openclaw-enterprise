# Native runtime identity

This independent Go module supplies a protected Workload API credential source
and an exact SPIFFE peer TLS transport. The repository-read mediation owner
consumes these packages and owns their source and connection lifetimes; the
module itself does not switch the default Agent authentication profile.

- `identity`: one owned X.509 watch and coherent credential snapshots from the
  local Workload API.
- `servicepeer`: TLS 1.3 connections authenticated against an exact configured
  SPIFFE peer, with current-source checks and owned connection shutdown.

These packages authenticate identity. OCC must separately authorize any service
role, represented Agent, resource operation, or credential use.

## Build and verify

Use Go 1.26 or newer, then run from this directory:

```sh
go vet -mod=readonly ./...
go test -mod=readonly -race -count=1 ./...
```

Tests require local Unix sockets. Their disposable Workload API server is a
fixture for the external SPIRE boundary; the source, SDK parsers, and mutual-TLS
transport under test are real. See the [testing guide](../../docs/testing/native-identity.md)
for coverage and troubleshooting, and the [reference](../../docs/reference/native-identity.md)
for API lifetimes and security limits.

## Dependency notices

Before distributing a consumer, collect notices from the selected module graph
and Go toolchain into its artifact staging directory:

```sh
sh licenses/collect.sh /tmp/runtime-security-notices
```

The collector includes nested license/notice files and a module-version inventory.
Executable owners must collect notices for their complete linked module graph.
