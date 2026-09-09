# Work owner and invocation diagnostic values

The work-authority V2 module defines two immutable diagnostic values and their
decoders. They describe an owner and original invocation provenance. Successful
decoding establishes representation only. The accepting service must obtain
actual identity, original event correspondence and current operation authority
from their owning components.

This development slice has a direct source module at
`packages/contracts/src/work-authority-v2.ts`. It has no package export or runtime
integration. Existing V1 account, lifecycle and journal behavior continues to
define the implemented runtime contracts.

## Owner value

`WorkOwnerValueV2` has exactly these fields:

- `kind`: `service` or `user`.
- `principalId`: an opaque principal reference.
- `installationId`: the existing typed Installation ID.

Both kinds decode successfully when their representation is valid. A service-only
work admission rule belongs to the actual admission consumer. It must resolve a
service owner to the canonical `ServicePrincipal`, and a user owner to a
`Principal`. A `ServiceAccount` is a credential resource and cannot establish
that relationship. Reference text alone cannot prove which resource or principal
exists behind it.

## Invocation value

`WorkInvocationValueV2` has exactly five opaque references:

- `actorPrincipalId`: the original initiating principal.
- `sourceInvocationRef`: the original invocation.
- `sourceEventRef`: the original source event.
- `originalTargetRef`: the original target or conversation.
- `invocationDecisionRef`: the original invocation decision.

A human initiator can differ from the service owner. The decoder neither requires
those references to match nor invents uniqueness between provenance fields. The
ingress and journal consumers must establish the actual associations, exact
event bytes, original target and replay rules. An earlier invocation decision
does not authorize a later model request, repository credential or delivery.

## Decoding and bounds

Use `decodeWorkOwnerValueV2(input)` or `decodeWorkInvocationValueV2(input)` with an
unknown input. Each returns `{ kind: "decoded", value }` or `{ kind: "invalid" }`.
The decoded result and its detached flat value are frozen. Later mutation of the
input cannot change the snapshot. A decoder never returns a permission or an
authenticated handle.

The object must have exactly the required own, enumerable data properties. An
ordinary or null-prototype object is supported. Accessors, symbol properties,
extra or missing fields, custom prototypes, nested values and arrays are
rejected. The decoder reads property descriptors before checking or serializing
its captured copy, so it does not invoke input getters or `toJSON` hooks.
Reflection failures return `invalid`. This is data validation within the caller's
JavaScript process; it does not isolate arbitrary proxy traps or hostile code.

References contain 1 through 200 ASCII characters and match
`^[A-Za-z0-9][A-Za-z0-9._:/-]*$`. Installation IDs use the existing exact
`InstallationId` schema. No coercion, trimming or truncation occurs. Capture
rejects strings over 1,024 code units, and the validated copy must fit within
16 KiB of UTF-8 JSON.

The two supported shapes are flat objects with three or five string fields.
Their accepted representation is therefore stricter than the general contract
limits of depth 12, 2,048 nodes, 128 own keys, 64 array elements and a 32 KiB
observation. Nested structures are unsupported regardless of their size. These
values have no timestamp, duration, work horizon, ancestry or feed cursor.

## Producer and consumer responsibilities

The original semantic successor separates invocation entitlement from service
work authority. Its operation mapping remains a definition for future consumers:

- `work.invoke` binds actual ingress, the initiating actor, exact target and
  invocation permissions.
- Work admission, child admission and authority issue or renewal require the
  canonical service identity, current service policy, protected origin and
  complete logical-work ancestry.
- Model and repository-credential operations additionally require current
  permissions for the exact credential and selected provider or resource.
- Delivery requires an independently authenticated executor, a pre-admitted
  sealed result, exact destination, current audience and posting rights, and
  original finite-delivery and submission constraints.

These names are not added to the V1 operation vocabulary by this module. Parsing
either value implements none of those permission decisions. It also supplies no
logical-work store, transaction token, issuer, revocation feed or delivery sender.
Those components must agree and implement their original supplier interfaces
before a work-authority runtime can consume these values.

## Verification

The direct structural suite is
`tests/conformance/work-authority-v2.test.mjs`. It exercises the real decoders,
including both owner kinds, exact reference and Installation grammar, closed
shapes, distinct owner and initiator, accessor rejection and detached immutable
snapshots. With a compatible prepared workspace and supported Node version, the
focused command is:

```sh
node --test tests/conformance/work-authority-v2.test.mjs
```

These structural tests do not verify identity resolution, permission decisions,
transaction isolation, provider access or runtime enforcement. Such verification
requires the corresponding real producers and consumers.
