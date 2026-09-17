# Mediated-network DATA checks

Run the decoder contract suite from the repository root with Node.js 24 or newer
and the matching installed workspace dependencies:

```sh
node --test tests/integration/mediated-network-contract.test.mjs
```

## Public data API

The public `@openclaw-enterprise/occ` entry point exports
`decodeMediatedNetworkPacketV1`, `MEDIATED_NETWORK_PROFILE`, and the
`MediatedNetworkPacketV1` and `MediatedNetworkPeerV1` types. The profile constant
is `credential-gateway-v1`.

The decoder accepts an `unknown` JSON-compatible object and returns a detached,
deeply frozen packet. Pass the decoded object; raw JSON text is rejected.
Every rejection throws `Error("Invalid mediated network packet.")` without a
caller-derived cause or value. Caller getters, proxy traps, iterators and
`toJSON` hooks are never invoked.

Validation covers:

- At most 64 KiB of UTF-8 JSON representation, 4,096 visited nodes and depth 10,
  with bounded records, arrays and label dictionaries.
- Exact closed-record fields, canonical literal addresses, hostname and label
  syntax, fixed service/Harness ports, image and CA digests, and duplicate or
  conflicting endpoint rules. Upstream HTTPS routes require public single-host
  `/32` or `/128` CIDRs.
- Correspondence between the supplied binding and Agent/gateway ownership
  labels, together with the selected profile and workload roles.

The current decoder also rejects `github.com` and `api.github.com` in
`scopedDns.platformHosts`. Those reserved-name exclusions are fixed in the
decoder; provider-supplied hostname-rule composition is absent.

See the [decoder source](../../packages/occ/src/credential-gateway-v1/mediated-network.ts)
for field definitions and exact limits, and the
[producer fixture](../../tests/fixtures/mediated-network-contract/producer.ts)
for a complete example of supplied deployment data.

## Coverage and integration boundary

The suite exercises the actual public source-package decoder, independent field
vectors, input bounds, refusal behavior, alias detachment and deep freezing.
It separately compiles producer and consumer fixtures with strict checking and
`skipLibCheck: false`. These compiler checks use `--noEmit`; they do not exercise
an emitted or installed OCC package.

There is no production producer or runtime consumer of this packet. The
[consumer fixture](../../tests/fixtures/mediated-network-contract/consumer.ts)
reads selected fields without installing resources or invoking Compute.
Ordinary Compute uses its separate
[ordinary network profile](../reference/drivers/kubernetes-compute/networking-and-isolation.md#explicit-network-profiles);
it does not consume this decoder's packet.

Binding and label equality establish internal correspondence only. The packet
does not authenticate ownership, establish current revision, approve a provider
destination or confer Work/IAM authority. Trusted production construction and
Compute integration remain pending, including endpoint/CA/profile replacement
with observed writer stop, scoped DNS installation and effective policy
enforcement. Component success supplies no cluster, ordinary Agent workflow or
live-provider qualification.
