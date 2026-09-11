# Shared-turn receipt identity and classification

The controller's internal `shared-turn-receipt.ts` module validates normalized
receipt data and classifies supplied receipt history. It is not connected to
channel intake, admission, or dispatch. No configuration or service startup is
required. Import its functions directly from
`apps/controller/src/channels/shared-turn-receipt.ts`.

The [manual binding resolver](channel-bindings.md#internal-candidate-mapping)
consumes this identity for mapping-only checks. That connection does not add
authenticated intake, durable history, or dispatch. See
[Channels and delivery](channels.md) for the current boundaries and the
[source flow](../flows/channel-delivery.md) for their separation.

## Normalized identity

`parseReceiptIdentityV1(input)` accepts unknown input and returns either a frozen
`ReceiptIdentityV1` or `{ kind: "invalid", reason: "identity" }`. The closed input
contains `schemaVersion: 1`, `platform` (`slack` or `msteams`), and these fields:

| Fields                                              | Meaning                                                 |
| --------------------------------------------------- | ------------------------------------------------------- |
| `installationRef`, `channelInstallationRef`         | Distinct Enterprise and channel app installation scopes |
| `providerTenantRef`, `recipientAppRef`              | Provider tenant and receiving app                       |
| `normalizationProfileRef`                           | Adapter normalization profile                           |
| `providerEventRef`, `eventDigest`                   | Event identity and normalized event digest              |
| `providerMessageRef`, `contentDigest`               | Logical message identity and normalized content digest  |
| `providerSubjectRef`, `channelRef`, `rootThreadRef` | Stable sender and native channel/thread binding         |

References must be nonempty, well-formed Unicode without C0/C1 control characters,
and at most 1,024 UTF-8 bytes each. Opaque values preserve whitespace, case and
Unicode spelling. Digests must be `sha256:` followed by 64 lowercase hex digits.
The parser validates digest syntax, not agreement with an absent payload.
Only plain objects or objects with a null prototype are accepted. Extra fields,
symbol keys, accessors, proxies, missing fields and supplied key overrides fail.
Transport retry IDs and receipt times do not belong in this input.

The output adds full SHA-256 `eventKey` and `logicalMessageKey` values, each with a
`sha256:` prefix. Hash inputs are UTF-8 fixed-position JSON arrays:

```text
scope = [installationRef, channelInstallationRef, platform, providerTenantRef, recipientAppRef]
event = ["oce.shared-turn.event.v1", ...scope, providerEventRef]
message = ["oce.shared-turn.message.v1", ...scope, channelRef, providerMessageRef]
```

The profile is outside both keys so changed normalization cannot make an existing
message fresh. Neither parsing nor possession of these keys authenticates a user,
provider, installation, or message.

## Supplied receipt history

`classifyReceiptV1(identity, eventSnapshot?, logicalSnapshot?)` accepts a parsed
identity and optional exact-key snapshots. Only `undefined` means absent. Each
snapshot has exactly `identity`, `ownerReceiptRef`, and `disposition`. An
`accepted` snapshot also requires `turnRef`; all other dispositions prohibit it.
Snapshot identities use the normalized output shape including checked keys.
Owner and turn references obey the same 1,024-byte reference grammar.

| Result             | Meaning                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `new-candidate`    | Neither exact-key record was supplied; grants no admission or reservation                                                       |
| `existing-pending` | Original canonical owner remains pending                                                                                        |
| `duplicate`        | Preserves original `accepted`, `busy`, `denied`, or `ignored` disposition and canonical owner; accepted also preserves its turn |
| `conflict`         | Existing event binding, logical binding, canonical owner, or recorded decision disagrees                                        |
| `invalid`          | Malformed identity/snapshot or a snapshot for a different lookup key                                                            |

Event replay requires the same event digest and immutable logical binding.
Logical twins may have different event IDs/digests but must share profile,
subject, channel, native thread root and content digest. Both lookup rows must
agree on owner, disposition and accepted turn. Final busy/denied/ignored
outcomes never become fresh candidates merely because current policy or
occupancy changed. Pending/final disagreement is a conflict that the caller
must resolve using authoritative history; this helper does not choose a winner.

Outputs are defensively copied and frozen. Failures expose only fixed reason
codes, without logging incoming identifiers or payloads. Receipt and turn
references are internal; a consumer must authorize status disclosure before
returning them to users.

## Verification and integration limits

Run the actual module's conformance tests with Node 24 or newer:

```sh
node --test tests/conformance/shared-turn-receipt.test.mjs
```

The helper performs no I/O and stores no receipt journal. Caller-supplied
snapshots do not prove transactional uniqueness, freshness, authentication,
permission, or delivery. `new-candidate` means only that no history was supplied.
Adapters must independently verify transport identity and select normalized
payload semantics. Production admission still requires current participant and
audience policy, exact target/checkpoint binding, durable atomic event/logical
ownership, whole-Agent reservation, canonical execution-attempt ownership,
retention rules and runtime fencing. There is no database, live channel,
model, runtime, or cancellation coverage in this helper's tests. See the
[platform design](../design.md) for the surrounding architecture and the
[testing guide](../testing/README.md) for integration verification.
