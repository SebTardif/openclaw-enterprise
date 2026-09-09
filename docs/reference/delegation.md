# Delegated authority library

The internal OCC delegation library provides root grant constraint checks,
persisted runtime-owner inspection, and extraction of a Codex model request's
opaque turn reference. It includes a transaction-bound PostgreSQL grant store. No controller route,
workload authentication, grant issuer, provider proxy or runtime startup path
calls that store. The accepting authority still needs genuine current workload,
turn and policy producers before it can authorize provider use.

The [platform design](../design.md) remains authoritative. See
[authorization](authorization.md) for current IAM enforcement,
[controller runtime storage](controller.md) for the unbound assignment foundation,
and [harness execution](harness-execution.md) for supported runtime behavior.

## Grant constraints

The source is under `packages/occ/src/delegation/`. Its internal modules are
directly importable by repository consumers and tests; they are not exported
through the OCC package entrypoint.

- `grant-contract.ts` parses closed `RootGrantV1` data and returns a detached,
  deeply immutable value. A root binds one exact human/turn/attempt/common grant,
  harness assignment, revision, runtime generations, profile references and
  accepting-service audience. Unknown fields, child/delegation fields,
  unsupported operations and duplicate tuples are rejected.
- `evaluate-grant.ts` checks the immutable root ceiling and all four supplied
  current ceilings: actor, common resource grant, Agent and operator. An
  operation pairs its provider binding with its exact model ID and selected
  HTTP transport profile. Independent lists cannot accidentally grant every
  combination of providers and models. The function also checks exact binding,
  validity, terminal status and supplied request/concurrency counters.
- `runtime-owner.ts` reads actual Installation, Namespace, Agent, revision,
  runtime intent and allocation records in one platform view. It rejects
  missing or mismatched ownership and stale lifecycle intent. Matching records
  return `unbound`, including historical component allocations whose ownership
  still matches. They never return executable currentness.
- `repository.ts` declares the transaction-local storage contract. `postgres.ts`
  implements it on the original PostgreSQL platform connection. Root and operation
  transitions have database guards and mandatory immutable storage history. Genuine
  attributable authorization audit must still be appended through the same platform
  transaction by the accepting authority.
- `operation-contract.ts` parses operation records and checks supplied dispatch,
  inspection and continuation state. Dispatch requires an accepted reservation
  before its immutable deadline. Continuation requires a dispatched operation;
  inspection cannot restore dispatch permission. These guards do not consume a
  reservation or prove a transaction committed.
- `credential-binding.ts` requires exact equality between the supplied canonical
  provider/account/credential-profile selection and an acceptor's fixed custody
  configuration, including audience, provider profile, transport and origin.
  It loads no secret and establishes no provenance for either input.

`constraints-satisfied` means only that the supplied data satisfies the library's
rules. The library does not authenticate its input, load human/common/model
policy, verify an SVID, resolve an active bound runtime, authorize a turn or
consume a request budget. Acceptors must obtain those facts from their actual
owners and recheck them at the effect boundary. A receipt, caller JSON or
unexpired opaque reference supplies none of those proofs.

The evaluator's `operatorPolicyVersion` identifies only the supplied operator
model-policy dimension. It is not an identity binding revision, grant version or
applied network-policy revision. Real integration must preserve each authority
dimension and its original observation/expiry evidence. A new RPC timestamp
cannot make old evidence current, and a verified accepting-service identity does
not prove the harness identity that service presents.

Grant timestamps use exact UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; references use bounded
ASCII spellings and assignment locators use lowercase UUID-v4 values. Operation
lists have at most 32 unique entries. Validity and budget are explicit inputs;
there is no default grant lifetime, wildcard, implicit permission hierarchy or
parent/child support. These parser bounds are not throughput or revocation SLAs.

The storage port requires a stable random reservation reference encoded as exactly
64 lowercase hexadecimal characters and an exact request digest before admission.
The operation parser enforces this spelling; generation remains the accepting
service's responsibility. Its separate atomic dispatch transition records the
first consumption under the grant lock. Only an acknowledged first transition
permits sending provider bytes. An ambiguous dispatch result or readback of a
consumed reservation cannot authorize sending again; there is no provider retry.
Renewing a live stream never changes the original dispatch deadline. Unknown
effects retain their active reservation until verified reconciliation; completed
execution or guaranteed no dispatch releases concurrency once without refunding
the charged request. The PostgreSQL implementation enforces these storage transitions; it supplies no
exactly-once external-effect guarantee.

Operation expiry is separate from the first-dispatch deadline; neither renews.
Explicit outcome records distinguish ended, verified stopped, never dispatched
and unknown work. Ended/stopped does not imply business success. The consumed
dispatch marker remains present even when later evidence proves zero provider
application bytes were sent.

## PostgreSQL storage

`PostgresPlatformState.delegationTransactionHost().transact((unit, grants) => ...)`
provides the original platform unit and a borrowed delegation repository. The host
loads the server-owned Installation. Existing platform callers can use
`delegationInTransaction(unit)` after loading that Installation in their ordinary
write transaction. The repository rejects another Installation and expires with
the callback. It cannot join protected profile, turn-command, credential-inventory,
gateway or bootstrap owner transactions through this ordinary adapter.

Root insertion preserves the complete immutable input. Exact replay returns its
current lifecycle and counters, including after retirement; changed binding or
context reuse conflicts. Retirement checks the expected version and only permits
active-to-closed/revoked or closed-to-revoked. Each operation reservation is unique
within its Installation, Namespace and Agent, across roots. Admission replay returns
the original operation's current state without a new charge.

Mutations require READ COMMITTED isolation and lock Namespace then Agent. Database
guards serialize admission, retirement
and dispatch, check root versions, selected model tuples, validity and immutable
deadlines using the database wall clock, and reject illegal state changes. Total
requests are derived from retained operation rows; active requests include accepted,
dispatched and unknown rows. Completion and cancellation release the active count
without deleting rows or refunding total requests. Expiry and retirement alone do
not release unknown work. The accepting owner must supply actual reconciliation
evidence before requesting a known outcome.

Every transition appends immutable storage history in the same SQL statement.
These records carry no credentials or request body. Storage history is not an
attributable authorization audit. The accepting owner must authenticate its caller,
resolve current runtime/turn/policy facts, append its genuine audit through
`unit.audit`, and enforce the canonical Agent-wide capacity policy in the same
owning transaction. This adapter enforces each root's request and concurrency
ceilings; the existing grant contract does not define an Agent-wide limit.

All results inside the callback are provisional. External dispatch must wait for
the original transaction's acknowledged return. A `PostgresCommitOutcomeUnknownError`
requires exact readback/reconciliation; a persisted dispatch marker never permits
resending. No provider effect belongs inside the transaction callback.

Run `node --test tests/integration/postgres-delegation.test.mjs` with
`OCC_TEST_DATABASE_URL` selecting an isolated migrated PostgreSQL 18.6 database as
`occ_app`. The suite exercises the real platform owner, limited-role SQL guards,
concurrent clients, rollback, borrowed lifetimes, database deadlines, and a real
protocol fault that drops a COMMIT acknowledgment. It is storage verification;
no workload identity, current-turn authority or provider dispatch is exercised.

## Codex request context extraction

`parseCodexMediationContextV1` in `codex-context.ts` accepts a raw UTF-8 body and
lossless HTTP header name/value pairs for ordinary `POST /v1/responses`. The
selected body carrier is the JSON string at
`client_metadata["x-codex-turn-metadata"]`. Its decoded object must contain
`openclaw_mediation_context`, a 1–128 character ASCII reference matching
`[A-Za-z0-9._:-]+`.

The parser rejects invalid UTF-8, a byte-order mark, duplicate decoded JSON keys
at every layer, malformed metadata and ambiguous repeated compatibility headers.
If an `x-codex-turn-metadata` HTTP header is present, its context must equal the
required body context. Additional tool metadata can differ between body and
header. A header alone cannot provide the reference. No trimming, name
normalization or active-turn fallback takes place.

Local bounds are 16 MiB of body, 8 KiB per metadata value, 128 header entries,
64 JSON nesting levels and 20,000 JSON values per parsed document. The HTTP
acceptor must preserve duplicate header information, bound all header names and
the aggregate header bytes, enforce framing/content type and receive limits,
and parse every request before passing this data. The byte limit applies before
JSON materialization; depth and value limits apply during the subsequent key scan.
This helper does not validate the complete provider request or make an upstream
connection. A successfully extracted reference remains untrusted.

`parseCodexModelRequestV1` in `codex-request.ts` additionally checks a narrow
ordinary text and client-tool profile using one private body snapshot. It requires
`store: false` and `stream: true`, refuses unknown top-level controls, and rejects
background work, `previous_response_id`, conversation linkage, access programs,
remote provider tools, media and external resource references. It checks nested
namespace and tool-search definitions so remote tools cannot enter through those
paths. The result exposes only the model ID and untrusted context.

Function parameters, client tool-search parameters and structured-output schemas
apply the same recursive reference restriction: `$ref`, `$dynamicRef` and
`$recursiveRef` may contain only `#` or a fragment beginning `#/`. External,
relative-document and named-anchor references are outside this selected profile.

Client-tool definitions describe tools dispatched by Codex; they can include
functions backed by client-side MCP. This profile does not authorize those tool
effects or prove they stay local. Inline reasoning ciphertext is opaque replay
content without a provenance claim. Responses Lite, internal chat metadata
passthrough, encrypted function arguments, and compaction/control inputs are
outside the selected profile.

The carrier corresponds to the selected Codex 0.153.0 request shape. These tests
verify extraction, not live Codex execution. Model WebSocket messages, remote or
manual compaction, startup prewarm and detached auxiliary work are outside this
parser's selected route. Integrations must explicitly qualify their own request
profiles or deny them, without borrowing a different turn's authority.

The runtime adapter must also prevent configured metadata from overriding the
reserved key and enforce its native writer boundary. A read-only JavaScript
turn object does not prevent another native client from steering an active turn.
Equal-privilege code inside a shared runtime may be able to use later turn
credentials; this library does not create per-human or child isolation.

## Verification and integration

With the existing workspace dependencies installed and Node 24 or later, run:

```sh
node --test tests/conformance/delegation-*.test.mjs
pnpm --filter @openclaw-enterprise/occ typecheck
pnpm check:workspace
```

The conformance cases execute the actual parser/evaluator and actual in-memory
platform repositories. They cover tuple intersections, exact scope and generation
substitution, lifecycle-head changes, immutable snapshots, validity/budget limits,
and raw JSON/header ambiguity. They establish no PostgreSQL grant persistence,
identity attestation, provider credentials, model turn or measured revocation.

`invalid-input` or parser rejection means the selected representation is
unsupported. `not-visible` conceals missing/foreign ownership. `not-current`
means persisted intent or the requested owner tuple disagrees; `unavailable`
means the platform read failed. `unbound` is expected for current assignment
storage and must never be treated as serving permission. Grant denials do not
consume budget or change persisted state.

Before wiring executable use, integrate canonical grant tables/constraints and
the accepting transaction integration, current identity/runtime purpose resolution, exact
admitted original-turn state, current IAM and common/model policy, attributable
audit and the accepting service's effect/revocation protocol. Keep storage
evidence, authentication, authorization, dispatch and external outcomes distinct.
There are no operator settings or public endpoints for this library yet.
