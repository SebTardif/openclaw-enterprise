# Account authority interface

The `@openclaw-enterprise/contracts` package exports the versioned account
authority interface, closed diagnostic schemas, bounded decoders, and pure IAM
request composition. It gives account adapters and accepting services a common
TypeScript boundary for current account/session state and an exact operation.
The interface does not implement an account store, credential verifier, selected
IAM adapter, grant evaluator, route, or effect guard. Importing it changes no
running service's authorization behavior.

See [authentication](authentication.md), [authorization](authorization.md), and
[service accounts](service-accounts.md) for existing running features. The
[source module](../../packages/contracts/src/account-authority-v1.ts) defines
the supported interface; its requirements apply when implementing an adapter.

## Callable boundary

`CurrentAccountAuthorityPortV1` has two asynchronous methods:

- `resolveSubjectV1(authenticated, input)` returns `current`, `denied`,
  `not-visible`, or `unavailable`.
- `authorizeExactV1(authenticated, input)` returns `allowed`, `denied`,
  `not-visible`, or `unavailable` for the exact operation and its resolved target.

Both receive an `AuthenticatedRequestHandleV1` produced by the actual accepting
service for its current invocation. `AuthenticatedRequestHandleSourceV1` describes
that dependency without implementing it. A header, principal string, session ID,
JSON object, or TypeScript cast does not authenticate a caller. A real adapter
must reject foreign or replayed handles and verify their recipient and invocation.
A remote transport needs a separately authenticated mapping.

Requests contain schema version `1`, a server-selected Installation and request
ID, the exact currentness profile, and a bounded creation/deadline interval.
An exact request also contains a closed operation/target and optional complete
`AccountVersionVectorV1` for comparison. The accepting service resolves and
scopes client locators before making the request. Caller-selected principals,
drivers, wildcard actions, and permission assertions are rejected by the schema.

Positive observations bind the principal kind and ID, selected IAM driver and
revision, active account, credential mode, request, Installation, evaluated time,
validity bound, and current version vector. Human session observations require
session fields. Independent service-key observations require key fields and keep
their optional Namespace scope; Agent-owned keys cannot enter this boundary.
Session and key fields cannot be combined. An exact observation additionally
binds the operation and Role/Binding evidence references.

`CurrentAccountResultV1` and `ExactAccountActionResultV1` require a process-local
observation handle on positive results. The corresponding exported schemas and
`decodeCurrentAccountDiagnosticV1` / `decodeExactAccountActionDiagnosticV1`
produce immutable diagnostic data with no such handle. These are protected
internal diagnostics, not public response bodies. Their successful decoding
proves representation only. Negative results contain only their `kind`; internal
reason codes, foreign identities, resource existence, versions, and provider text
are excluded.

## Exact IAM and semantic requirements

`accountIAMChecksV1` composes conjunctive requests using the existing
`AuthorizationRequest`, `PermissionAction`, and `ResourceRef` types. It evaluates
no permissions. `accountSemanticRequirementsV1` returns additional operands the
real adapter must evaluate through current registered Role/Binding evidence.
An empty additional list still requires current account, credential, selected
IAM, grant, and ownership checks.

| Operation family                       | Required distinction                                                                                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent deployment and resume            | Exact Configuration, optional ServiceAccount, and Secret references; resume additionally requires `operate` Agent and an explicit retained revision or saved draft. Current lifecycle management and separate Agent-executor Secret permission remain required. |
| Agent disable and stop                 | `operate` Agent plus current lifecycle management; collaborator access cannot supply management.                                                                                                                                                                |
| Operational status and revision detail | Status uses `read` Agent. Revision detail additionally uses `read` AgentRevision. Neither supplies conversation content permission.                                                                                                                             |
| Conversation reads and turn operations | Current human membership and exact conversation permissions remain separate from Agent IAM. Common-grant operations require the current common grant.                                                                                                           |
| Own and shared cancellation            | Own cancellation requires both exact actor equality and an explicit current own-cancel grant. Shared cancellation requires its separate explicit grant.                                                                                                         |
| Model and repository-token access      | Exact Secret permission is composed with Agent read/operate; current common grant, resource profile, turn, and attempt remain required.                                                                                                                         |
| Restore and cleanup                    | Independent service responsibility is explicit. Historical human permission, runtime serving status, or an old serialized observation cannot supply it.                                                                                                         |
| Resource administration                | Current semantic management scope supplements exact existing IAM operands; creating a child uses the existing parent-resource sentinel.                                                                                                                         |

A mapped operation is not evidence that a corresponding API route or runtime
consumer is implemented. Full audience checks, canonical attempts, runtime
assignment, reply destination, restore/store scope, and separate purge permission
remain their accepting consumers' responsibilities.

## Currentness and invalidation

`ACCOUNT_CURRENTNESS_PROFILE_V1` is `account-currentness-v1`.
`ACCOUNT_AUTHORITY_LIMITS_V1` defines a five-second maximum dependency-call and
operation-start interval, with five-second active model recheck and closure
ceilings. These are requirements for adapters and consumers, not measured
availability or revocation guarantees. A stricter credential, scope, runtime,
operation deadline, or clock bound always prevails. The decoder checks interval
relations; it does not consult a live authority or decide that historical data
is current.

Every port call must resolve the actual current account/session/key, selected
driver, and grants. Exact authorization repeats those checks and compares the
complete expected vector when supplied. The version vector covers Installation,
account, credential, grants, IAM policy, semantic mapping, and driver selection.
Account disable or recovery invalidates old credentials; recovery requires fresh
authentication. A selected driver change cannot reinterpret identities or fall
back to a native driver. An explicitly supplied invalid key cannot fall back to
an accompanying cookie.

`decodeAccountInvalidationObservationV1` validates bounded diagnostic facts from
an invalidation writer, including monotonic versions and the required changed
account/credential/grant/driver-selection field. It does not authenticate that
writer, publish invalidations, or implement storage transactions.

Final reads and effects require current authoritative comparison at the actual
acceptor, the operation's remaining scope checks, and durable audit acceptance.
An allowed observation is not a persisted permit or positive cache entry.
Remote audit export may lag only with its durable local obligation; failure to
durably accept a new operation fails that operation. Already accepted protective
cleanup has its own current service responsibility. Dependency, clock, or deadline
failure returns `unavailable`, never a remembered allow.

## Verification and troubleshooting

With the repository's matching dependencies already installed, run the actual
schema/composition tests and compile the two independently authored examples:

```sh
node node_modules/typescript/bin/tsc --build packages/contracts/tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/account-authority-v1/producer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc --project tests/fixtures/account-authority-v1/consumer.tsconfig.json --pretty false
node --test tests/conformance/account-authority-v1.contract.test.mjs
node scripts/verify-workspace-boundary.mjs
```

The producer example forwards injected trusted dependencies; it manufactures no
identity or allow result. The consumer exhaustively handles result variants and
checks at compile time that deserialized diagnostics cannot supply trusted
handles. It stops before the real guarded read. Tests exercise exported schema
and composition code, including closed fields/arrays, credential separation,
version relations, exact IAM targets, and cancellation distinctions. They do not
prove live authentication, account disable races, driver invalidation, direct
routes, active-stream closure, or effect-guard integration.

An `invalid` decoder result indicates an unsupported representation, shape, size,
timestamp relation, or version combination; it contains no provider diagnosis.
A live `not-visible` result must conceal unknown and foreign scope consistently.
Investigate `unavailable` using authorized protected diagnostics in the real
adapter; do not substitute a fixture response, cached result, or another driver.
There is no configuration flag in this module that installs a live authority
adapter or enables a new route.
