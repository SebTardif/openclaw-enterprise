# Workload profile candidate binding and composition

[Back to workload profiles](../workload-profiles.md).

## Candidate binding qualification

[`createWorkloadProfileCandidateBindingsSourceV2`](../../../packages/occ/src/workload-profiles/admitted-use.ts) composes an original `WorkloadProfileCandidateRecordsReaderV2` with four fixed qualifiers. Construct it with the genuine suppliers, then pass the result to `createWorkloadProfileCandidateSourceV2(contexts, bindings)` for the existing Use resolver. The records reader must recognize the original deployment unit and tracked operation, returning its captured locked normalization records and separate opaque source identity without acquiring new parent locks.

The PostgreSQL state's `workloadProfileCandidateContextV2(...)` supplies this reader as `records`, beside `candidates` and `contexts`. It reads the same completed normalization slot and selected admission head. Returned observations include the normalized Configuration, locked Agent and ServiceAccount, actual optional provider-binding lookup, and Secret metadata in original binding-entry order, including repeated aliases. API-key normalization leaves the provider binding undefined. Reads issue no new SQL or Driver resolution. The opaque identity belongs to the original slot; copied units or another operation cannot use it to enroll.

Each record lease owns only its observation. Retain it through the original transaction's final currentness checks, then release it; the enclosing owner retains and cleans up the original Driver guards. Currentness is synchronous, remains valid after acquisition closes while the owner is live, and fails after observer release, owner expiry or a guarded source change. Reusing a released observation poisons the recognized owner. The component protocol is exercised by `node --test tests/conformance/workload-profile-candidate-context.test.mjs` with actual state, repositories and normalizer over controlled SQL and Driver peers; it does not establish PostgreSQL locking or the four semantic qualifications below.

Each qualifier recognizes the same original records and supplies its own retained lease:

- `native`: installed native Configuration and module semantics.
- `credentials`: exact ServiceAccount credential/backend and model-provider association.
- `storage`: original logical storage policy and installed mount mapping.
- `roles`: admitted role records and their current original semantic sources.

The factory compares captured Agent, Configuration, ServiceAccount, provider, ordered Secret references and admission-head associations. Qualified outputs must match the original account credential reference, admitted roles and declared gateway/Harness mounts. Manifest expectations, generic JSON validation and copied records cannot supply the missing qualification producers.

The returned lease exposes `bindings`, synchronous `assertCurrent()` and idempotent asynchronous `release()`. Cleanup is retained before supplied data is inspected. Failed currentness remains latched; release joins pending assertions and closes acquired leases in reverse order. Currentness checks fail after release completes. Acquisition failure poisons the original tracked operation and joins captured cleanup. Consumers retain the lease through the original owner's terminal checks and cleanup. The outer Use resolver still owns complete capability acquisition and inserted-row verification.

Missing genuine records or qualifiers remain unavailable. This factory installs no production default, mints no admitted Use and grants no provider-call authority. For an `unavailable` result, inspect missing suppliers, original enrollment, cancellation and currentness; for `selection-mismatch`, inspect the exact captured references and qualified outputs. Do not substitute caller-provided records for an unavailable original source.

With Node.js 24 or newer and matching workspace dependencies prepared, run:

```sh
node --test tests/conformance/workload-profile-candidate-bindings.test.mjs
node --test tests/integration/workload-profile-candidate-mock-e2e.test.mjs
```

The focused suite checks fixed composition, detached inputs, correspondence, retained currentness and joined cleanup with controlled record and qualifier issuers. The composed suite calls the actual controller deployment service with the candidate source, binding factory, capability aggregator, Use resolver and selector. It checks first-insert Use correspondence, selected-row verification, commit/cleanup ordering, exact replay and refusals over scripted SQL and controlled account, Driver and qualification dependencies. Neither suite establishes a production records producer, authentic authority, PostgreSQL locking or durability, credential issuance, native support or provider execution. The composed suite does not exercise HTTP routes, the worker or a live runtime.

## Production composition and current verification boundary

Production now passes the actual PostgreSQL candidate context/records and inserted-row storage to the existing candidate and Use adapters. The same selected capability aggregator is used for definition acceptance, Use acquisition and inserted-row revalidation. Its missing original contributors and candidate qualifiers remain explicit unavailable dependencies. This composition does not grant renderer-only support, reinterpret metadata as native authority, or permit an unqualified deployment.

Production and PostgreSQL development assemble these connections in two stages.
The original invocation source is created once and enrolled with State before
owner collaborators are constructed. Candidate construction then borrows the
captured credential consumer from that same State context. Credential
qualification retains the original ServiceAccount observation and its paired
policy through currentness checks and joined cleanup; copied metadata cannot
replace either participant. The binding factory checks that the records reader
and all four qualifier methods are present before acquiring a record or invoking
any qualifier. An incomplete owner composition remains unavailable.

The maintained candidate-binding, candidate-source, prepared-use, use-v2 and
construction conformance suites exercise the real adapters, selector and
controller construction with controlled collaborators. They verify composition
and refusal behavior; they do not supply the missing production credential
issuer, complete capability contributors or a successful live deployment.

The selected Compute factory binds its renderer source once to the original
Driver-owned capability. Admission composition and prepared Harness verification
use that same instance; a second composition or replacement of a constructor-bound
source fails. The independent custodian's revision lease preserves its original
Harness launch operands through source currentness and cleanup. Missing operands
remain unavailable, and copied launch values do not acquire dispatcher custody.
These connections do not install the missing immutable-definition custodian or
complete contributors, select a native launcher, or authorize provider submission.

The focused operator and request-custody suites cover the registered HTTP boundary, actual BetterAuth sign-in with memory storage refusal, exact purpose/command consumption, replay refusal and cancellation-held cleanup. Controlled session-reader cases do not prove PostgreSQL writer exclusion. A separate allocated PostgreSQL production request must verify successful inert preparation/readback, current-account revocation and unchanged record counts after failed acceptance before those behaviors are treated as runtime evidence. No successful full profile deployment is claimed by this source increment.

## PostgreSQL development composition and verification boundary

PostgreSQL development also connects the registered operator routes to the original service, authenticated request/account/session custody and selected IAM. It passes the captured candidate context/records and inserted-row storage to the candidate source, capability aggregator, selector and Use resolver. The same aggregator serves definition acceptance, Use acquisition and inserted-row revalidation. The independent immutable renderer-definition custodian, complete contributors and candidate qualifiers remain required; missing suppliers remain unavailable.

The bounded PostgreSQL development check covers authenticated inert preparation, exact original-actor readback, current-session and request refusals, and genuine missing-contributor acceptance refusal. Failed acceptance must leave active admissions, retained history, capacity, successful acceptance audits and Compute effects unchanged. These observations must identify the exact receiving source, composition and database permissions.

A temporary isolated-fixture grant to existing `occ_app` of `EXECUTE` on `occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text)` establishes only that fixture permission. Retain inner-helper and direct-account-record denial, revoke the grant after all application work joins, and verify restoration of the original outer-function ACL. This component check does not establish production role enrollment, complete profile admission or physical/provider support. An accepted private result does not establish behavior at a different receiving revision, composition or permission setup.
