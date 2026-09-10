# GitHub publication dispatcher

`GitHubPublicationDispatcherV1` implements the publication application's
`PublicationDispatcherV1`. It prepares one push or one draft pull request for an
original State effect. A push and its subsequent draft PR are separate effects;
preparing or issuing a token never supplies approval for either operation.

The existing metadata and Git read profiles remain separate. Publication uses
`oce-github-publication-v1`, its own closed frame grammar, and original publication
Work/State/native operands. No read permit can be adapted into this dispatcher.

## Construction and originals

Construction requires the actual `GitObjectCustodyV1`, an original protected
`GitHubPublicationNativeOwnerV1`, a maximum entry count (1–64), and a maximum local
prepared lifetime (1–120000 milliseconds). The class captures the custodian's
original prototype methods and the native owner's original method receivers once.
Original State then calls `bindState` once with its publication dispatch participant:
`inspectEffect`, `assertUse`, and `consumeUse`. Rebinding is refused.

The State binding retains State's original actor, publisher, Work, candidate,
approval, effect and use types. `GitHubPublicationOriginalsV1<B>` selects only this
dispatcher's two private receipt types: `GitHubPublicationPreparedV1` and
`GitHubPublicationOutcomeV1`. Their diagnostic shape grants nothing. Only the
constructing dispatcher's private maps recognize them; copies and foreign receipts
are refused. The same effect cannot be prepared a second time, including after
retirement. The same use cannot enter two submissions.

Publisher/effect/call membership is required from the original native/controller
and State owners. The dispatcher's retained object identities and the State
`inspectEffect` comparison do not invent a publisher authentication producer.
`GitHubPublicationNativeOwnerV1` is a mandatory original construction operand. Its
port declaration supplies no positive connection, policy, credential or permission.
The actual native owner must recognize the publisher, original effect and exact
`PublicationCallV1`, retain the original service registration/attachment, and
resolve repository IDs to its current qualified owner/name and endpoint. It must
preserve that original association through fresh native inspection and withdrawal.

The original Work producer remains responsible for its authority and clock
contract. This component's monotonic timeout only withdraws and starts cleanup.
It cannot qualify an unavailable Work clock, extend an operation's original
horizon, or replace the current authority checks with a cached allow decision.

## Preparation and the once-only send

`preparePush` first asks the genuine custodian to recognize the exact capture,
match the complete graph to the candidate, and independently prove the existing
expected target is an ancestor of the proposed commit. It reads the retained PACK,
makes a bounded detached borrower copy, and verifies its exact size and prefixed
SHA-256. Both read and borrower copies are erased after their corresponding
borrow. The native owner must retain its own bounded copy before its preparation
promise settles. Rust independently validates the complete graph and PACK before
reporting readiness. A draft PR is prepared from the immutable candidate only.
No caller HTTP body, URL, credential or receive-pack command is accepted.

Native preparation performs no provider effect. It waits for the original Rust
session to validate its fixed operation and retain verified upstream TLS. The
returned native original must inspect to the exact publisher, effect, call and
action digest. Before any send is possible, the dispatcher captures the native
session's preinstalled original result and physical-drain promises. Malformed
preinstalled tickets fail preparation and retire that same native session.

The publication application reacquires its original State use after preparation.
On `submit`, the dispatcher checks its original receipt, call and effect, checks
State's original use, and checks the original native session. It then invokes
`State.consumeUse(use, prepared, originalCall)` immediately followed by the fixed
native `submit(session)`, synchronously. No await, newly selected body or route,
credential getter or sink callback lies between those calls. The native submit
sends exactly the pending committed response with its use-specific token to the
same held Rust connection. There is no submit retry.

Once the attempt starts, a synchronous throw or malformed return from lower
submission still returns the already retained ticket. A local submission fault
makes its outward drain fail after joining the lower drain, while preserving any
known original result for State's uncertain recording. The private result and
physical-work ownership remain available to `releasePrepared` even when the
application did not receive a usable outward ticket.

## Cleanup and observation custody

Cancellation, expiration, release and a failed submission all retire the same
native original. An outward timeout, signal, broken pipe or rejected drain is not
physical retirement. The entry stays held until original native retirement is
acknowledged and both result and drain have settled. Failed retirement can be
retried on that same original. An internal 30-second retry retains failed cleanup
for a preparation that never exposed a receipt; it never repeats preparation,
State consumption, token release or provider submission.

The native producer must join the actual Rust run, HTTP driver, worker and
credential cleanup. Its protected result/drain participant must exist outside the
operation channel that may be lost. EOF alone does not prove that all work drained
or that a known result was transferred. A known PR or push observation cannot be
replaced with null merely because terminal RPC delivery failed.

Outcomes have independent private custody. Retiring a prepared session does not
delete an issued outcome or its original native observation. `inspectOutcome`
returns immutable comparison data; the original publication application checks
correspondence and transfers every offered observation to State. Mismatched known
OIDs and PR attributes are preserved for State uncertainty. State's original
observer is responsible for durable accounting/recovery transfer before retiring
an effect. This dispatcher creates no parallel journal.

Entry count bounds concurrency, including pending preparation and cleanup. Peak
PACK memory includes the custodian read, dispatcher copy, and native retained
copy, each individually capped at 80 MiB. Operators must choose the entry count
with those simultaneous allocations in mind. Native preparation and response
budgets also remain finite and pinned to the original operation. The implementation
does not claim that cancellation zeroizes transient maintained-library buffers.

## Closed native protocol

One protected Unix connection uses actual mutually authenticated TLS and the
separate publication ALPN. No reconnect, replay, multiplex, early data or session
resumption is selected. Each frame starts with big-endian metadata and suffix
lengths (two 32-bit values), followed by bounded duplicate-aware UTF-8 JSON and the
exact suffix. Metadata is at most 262144 bytes. The suffix is permitted only for
an opened push (the exact retained PACK, at most 80 MiB) or committed reply (one
1–16384-byte visible-ASCII token). It never appears in JSON.

Every frame retains version 1, a nonwrapping request sequence and original
32-hex-digit session reference. Operation frames bind the original call reference,
complete effect, action digest, qualified repository and DNS route, and where
applicable the exact outgoing body/request hashes and actual TLS certificate
hash. The original native state machine must compare all immutable fields on the
same session; successful grammar decoding alone establishes no original authority.

| Rust request           | Native reply | Effect on the original session                                 |
| ---------------------- | ------------ | -------------------------------------------------------------- |
| `open-publication`     | `opened`     | Retain candidate/effect and original PACK for push             |
| `prepared-publication` | `committed`  | Wait for State consumption, then release token exactly once    |
| `check-publication`    | `current`    | Check current original authority and the previous finite lease |
| `result-publication`   | `recorded`   | Transfer an attributed outcome; never grant another send       |

Only `denied` and `cancelled` negative replies are admitted. Successful frames
retain finite `server_time_ms`, `valid_until_ms` and immutable
`operation_until_ms`. Short lease renewal cannot outlive the original operation
or revive an expired prior lease. The authenticated original time/authority
producer remains required; the parser validates only comparison ranges and shape.

Push is one fixed POST to the qualified repository's `git-receive-pack` endpoint.
Rust builds one expected-old/proposed-new branch command with `report-status`, a
flush, and the genuine complete PACK. Independent ancestry and provider
expected-old comparison are both required. No additional ref, deletion, forced
update, caller command, hook, helper, LFS, submodule or alternate host is admitted.
Only a complete exact unpack/ref success observation confirms the push.

Draft PR is one fixed POST to `/repos/{owner}/{name}/pulls` with canonical
`base,body,draft,head,title` JSON from the original candidate. The fixed GitHub
branch-name API does not atomically fence expected head/base OIDs. Exact response
correspondence can confirm the attributed observation; mismatches or races remain
partial/unknown with the actual observed attributes and prior confirmed push
retained. No atomic PR pinning claim is made. Both operations refuse redirects,
informational responses, response compression, trailers and credential reflection;
response acquisition is at most 1 MiB. Credential substitution, token lifetime,
verified TLS and full physical retirement belong to the actual original native
and Rust owners.

## Verification scope

The conformance source contains pure frame/digest/boundary tests and dispatcher
lifecycle tests with explicitly controlled State/native component doubles. The
latter require a separately selected actual custodian fixture, using a pinned
local executable opened for custody but never run by these cases. They cover
original/copy mismatch, wrong capture, once-only consumption, delayed result and
drain, throw after possible send, cancellation, finite preparation and retained
outcomes. They cannot establish actual State authority, native identity, token
custody, upstream effect or composed publication acceptance. A skipped fixture
must be reported as unavailable, never as a passing integration.
