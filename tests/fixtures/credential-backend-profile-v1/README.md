# Backend profile fixtures

These fixtures verify the bounded backend declaration parser and its use of the
existing storage and authority contracts. All identities, bindings and supported
capability declarations in the values are synthetic configuration data. They do
not identify an installed backend, resolve credentials or grant authority.

- `producer.ts` independently compiles an owner composition with supplied actual
  Secret, protected-credential and inventory ports. It creates no backend.
- `consumer.ts` independently compiles all nine storage methods through supported
  package subpaths, preserving generic callbacks and the original nominal handles.
- `type-negatives.ts` rejects raw/serialized material, missing versions, unrelated
  authority, missing token custody and unsupported placement/coupling.
- `vectors.mjs` supplies configuration values for the real profile parser.
- `traces.mjs` supplies normative ordering examples and actual storage values. The
  conformance test validates those values with the accepted storage parser; it does
  not execute a mock backend or claim that the ordering ran.

All three tsconfigs are independent, strict and `skipLibCheck: false`, with no
workspace-wide build or compiler paths aliases. Each reaches contracts through
its package export and the same canonical source identities. See the
[backend reference](../../../docs/reference/credential-backend.md) for commands,
finite limits, ordering obligations and the remaining provider/runtime evidence.
