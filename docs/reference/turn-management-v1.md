# Authorized turn status and cancellation

`turn-management-v1` defines a bounded application port in the existing service.
It reuses the current account authority and the sole turn journal. It supplies
closed value codecs, exact correlation helpers and compiling consumer examples.
The accepting application, authentication and current scope guards must still be
implemented by their existing owners.

## Operations

| Method                | Current authorization                                                           | Journal operation                                                                                    | Result                                                                        |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `status`              | Authenticated caller, exact owning view, `conversation.read`                    | `read` / `findAttempt`                                                                               | Content-free phase/outcome and record version                                 |
| `requestCancellation` | Exact owning view plus current `turn.cancel.own` or `turn.cancel.shared`        | Existing `authorizeCancellation`, `inspectCancellation`, one outer `transact` / `commitCancellation` | Committed intent, existing intent, conflict, too-late or explicit uncertainty |
| `findCancellation`    | Fresh current owning view and the same original own/shared cancellation purpose | `read` / `findCancellation` only                                                                     | Exact recorded intent or nondisclosing unavailable/not-visible                |

`AuthenticatedRequestHandleV1` comes from the real accepting authentication
factory and stays outside wire JSON. Caller principal fields are expectations to
compare against that actual subject. `turnManagementAccountRequestV1` composes
existing account operands; it does not resolve an untrusted locator, authenticate
it, or authorize disclosure. The host resolves the exact target in its permitted
view before passing those operands to the real selected-IAM implementation.

Own cancellation requires the caller to be the original initiator. Shared
cancellation uses the requester's **current explicit shared-cancel grant** and
must not fail solely because the initiator was revoked. Native cancellation
acknowledgment independently checks the original actor, canceller and complete
current audience; management permission supplies no native delivery permission.

## Immutable operation binding

The locator binds installation, Namespace, Agent, conversation, receipt, turn,
attempt, reservation, original principal, requesting principal and common grant.
Each field resolves to the exact original committed record. The Ref spellings are
same-value projections, never labels, aliases or normalization rules. Additional
management references use at most 200 ASCII characters; wider existing journal
values are unsupported by this surface rather than truncated.

A cancellation identity includes the existing `ExactCancellationOperationV1`,
the chosen own/shared mode, original account version vector and a preknown
transaction reference distinct from the operation and invocation request IDs.
Generate these identifiers before submission and retain them through uncertainty.

The lowercase SHA-256 `operation.requestDigest` covers UTF-8 bytes of
`turn-management-v1`, newline, then canonical JSON of the complete cancellation
identity with **only** that digest member removed. Object keys sort by JavaScript
string order; arrays retain order. All original target, caller, mode, versions,
transaction and operation references, `startedAt` and `deadline` are included.
The selected shapes have ASCII keys and safe integer values. There is no Unicode
normalization. `turnCancellationDigestV1` computes this value from a structurally
valid identity with a placeholder digest; it grants no authority.

The original journal must compare the entire exact operation on duplicate
submission before interpreting current attempt progress. Unchanged input returns
the original responsibility; changed input at the same operation reference
conflicts without replacing the original. The identity's digest binds management
fields absent from the journal's direct operand, including the original outer
transaction reference. The accepting mapper must preserve this selected digest
domain end to end; an existing backend using a different digest recipe needs its
original owner's explicit adaptation, not silent reminting.

## Commit, interruption and readback

Unit-of-work results are provisional. `projectTurnCancellationCommitV1` consumes
the existing outer `JournalCommitResultV1<CancellationResultV1>`; a local recorded
result has the wrong type. Return an intent acknowledgment only after that outer
transaction actually commits and the current disclosure guard still succeeds.

Lost commit acknowledgment, a thrown submission, timeout or disconnect after
submission means `commit-unknown`. Keep the original locator and identity and
perform only a separately authorized exact readback. Do not automatically retry,
hedge, create another operation, cancel a transaction as rollback, initiate a
turn, or release an Agent reservation. `unavailable` also gives no evidence that
an earlier submission cannot commit. Explicit not-visible/absent readback does
not establish rollback or authorize a fresh mutation.

A readback invocation has fresh current account versions and a fresh bounded
request deadline. It carries the **unchanged** original cancellation identity,
even after the mutation deadline expires or later progress advances. An original
mutation's deadline or version vector cannot be renewed by that fresh envelope.
The returned observation time describes this read, not renewed effect authority.
Actual metadata read scope remains with the original accepting owners.

Cancellation means recorded interruption intent. Even
`cancelled-before-dispatch` does not certify that every other possible workspace
writer ended. A terminal/unknown status, lease expiry or cancel acknowledgment
never proves physical termination or releases a reservation. Genuine runtime
effects and no-mutator proof remain with the original runtime/journal owners.

## Projection and disclosure

Status exposes a bounded outcome name and stage, exact caller-visible locator,
record version, observation time and `none`/`intent`/`consumed` dispatch evidence.
The admitted-undispatched common branch works without fabricated dispatch
authorization, operation or expiry. Genuine early full authorization does not
itself become intent. Execution/checkpoint status preserves actual consumption.

`completed` means the exact journal record references its published canonical
checkpoint. The projection contains no transcript, checkpoint bytes, evidence
references, native session IDs, exception text, tool results or provider URLs.
Retrieving completed content requires its own current view and canonical
checkpoint verification. Native output also requires its immutable destination
and independent current audience authorization. This module has no native sink,
browser-chat endpoint, interruption executor or reservation-release method.

Not-found, foreign and denied share `not-visible` with no echoed resource or
principal fields. Other closed failures are `invalid-request`, `unavailable` and
`overloaded`; cancellation adds `conflict`, `too-late` and `commit-unknown`.
Conflict/too-late must only be returned behind the currently authorized exact
view. Real routes apply uniform nondisclosing errors and response timing policy.
They recheck current guards after awaited work and immediately before emitting
protected fields. Diagnostic observations, versions and successful parsing are
never accepting guards.

## Selected bounds

| Limit                                                               | V1 selection                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Request JSON                                                        | 16 KiB UTF-8, including serialized whitespace                  |
| Result JSON                                                         | 32 KiB UTF-8                                                   |
| Invocation and original cancellation window                         | At most 5 seconds, positive canonical UTC millisecond interval |
| Object depth / visited values                                       | 12 / 2,048                                                     |
| Simultaneous surface calls per installation                         | 32, shared across these three methods                          |
| Application queue / automatic mutation retries / automatic readback | 0 / 0 / 0                                                      |

The byte/time limits reuse the current account interface. The 32-call cap is a
selected application admission ceiling, not measured capacity or a claim of an
installed distributed limiter. The service's accepting owner must enforce it
across replicas or use a stricter bound. Check overflow before journal submission.
Maintain ownership of losing asynchronous work until real settlement; returning
an RPC timeout must not free a slot for still-running dependency work or imply
execution stopped. Use the earlier of original absolute deadlines and actual
dependency/authority limits, with the real trusted clock and uncertainty policy.

Codecs reject unknown fields, duplicate JSON members, accessors, hidden or symbol
properties, custom prototypes, cycles, malformed Unicode, unsafe integers and
noncanonical times. They return immutable snapshots. They do not authenticate
arbitrary in-process proxies; authentic handles and final guards remain out of
band. All parse failures use the same sanitized error.

## Consumers and evidence boundary

The compiling examples in `tests/fixtures/turn-management-v1/consumers.ts` exercise
the actual account, journal, cancellation provenance and application signatures.
The owner example requires externally supplied real view/currentness callbacks;
it implements no authentication factory or authority issuer. The presentation
example makes one selected call, validates its matching response and never
converts an intent into termination or retries a mutation.

Conformance vectors exercise immutable bindings, phase projections, unknown
commit/readback, callback ordering, revocation and disconnect with synthetic
dependencies. They do not prove PostgreSQL locking/restart behavior, current
selected IAM, authenticated routes, distributed backpressure, native audience
completeness, supervisor termination or public deployment. Those implementation
and live qualification obligations remain with their original owners.
