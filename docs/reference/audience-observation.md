# Complete-reader audience observations

`@openclaw-enterprise/contracts/audience-observation-v1` defines the observation
boundary for the selected Slack private-channel and Microsoft public-cloud Teams
standard-channel profiles. It exports closed diagnostic schemas, safe decoders,
process-local handle interfaces, native observation and account-check ports, and
pure rejection helpers. It does not provide a live roster implementation,
authenticated handle factory, account resolver, or effect authorization.

The existing [account-authority interface](account-authority.md) remains the source
of exact account operations and current account evidence. Reading a conversation
requires the existing Agent `read` check and current human-collaborator and
conversation-read grants. A silent reader needs those disclosure permissions;
append, tool-use and cancellation permissions belong to the acting human's
separately resolved operation. Every reader must cover the unchanged approved
common workspace and resource boundary. A consumer cannot reduce that boundary
until only the available grants remain.

## Data and custody

`AudienceObservationRequestV1` binds one request ID to the exact Enterprise
installation, channel installation, provider tenant or workspace, recipient app,
native channel, opaque root thread, immutable message, target and stage. Teams
additionally binds its team and public cloud. Provider references are opaque and
are compared whole and bounded to 1 KiB of well-formed UTF-8; a tenant is not an
Enterprise Namespace. Conversation and common-grant references retain the exact
account interface's narrower 200-character token representation.

The target contains the server-resolved Namespace, Agent, conversation and common
grant, an exact target version, and digests of the approved boundary and immutable
message. Digest representation is checked here; trusted target resolution and
digest provenance belong to the accepting implementation. The request is not a
replacement for a canonical turn, attempt, delivery slot or effect carrier.

An observation includes its own identity, the complete original request, timestamps,
clock uncertainty, every human reader and the native completeness mechanism's
version references. Decoding validates representation and internal relationships.
`audienceObservationMatchesRequestV1` rejects mismatched request data regardless of
object key order. Neither helper proves that a reader exists or that a provider
observation is authentic.

`AudienceInvocationHandleV1` and `AudienceObservationHandleV1` are nominal interfaces
for process-local custody. Only the real native owner can create them from its
authenticated invocation and recipient. Implementations must enforce private
identity, exact immutable correspondence, lifetime and revocation; TypeScript
branding alone is insufficient. JSON decoding never creates either handle. A remote
transport mapping requires separate architectural acceptance and an actual custody
implementation.

## What complete means

Both selected profiles require a complete nonempty set of 1 through 100 human
readers. Qualification still requires two distinct human collaborators on each
selected platform; that workload requirement is not a perpetual audience-size gate.
The configured delivery bot is the sole selected nonhuman reader and is recorded
separately. Unknown users, unclassified humans, additional bots/apps, unsupported
scope and overflow fail the observation. Enumerating only participants, recent
authors, users with local grants, or a first page cannot establish completeness.

| Profile                | Required native mechanism evidence                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack private channel  | Positive private-channel classification; all channel members across all pages; stable user classification; channel access-policy coverage; a qualified reader-set snapshot and change-detection mechanism. Shared/Connect, guest-restricted and other unsupported forms remain excluded.                  |
| Teams standard channel | Positive standard-channel and tenant/app/team classification; all team and channel readers across all pages; user classification; applicable tenant reader coverage and tenant access policy. A not-applicable tenant-reader claim requires an actual versioned determination by the qualified mechanism. |

The schema requires the corresponding fields and rejects inconsistent data, such
as a tenant reader alongside a not-applicable tenant claim. The actual producer
must establish the truth of those claims and a coherent reader set across the
retrieval and change-detection boundary. Page exhaustion by itself is insufficient.
Mechanism and source-capability references identify independently qualified native
implementations; callers cannot use arbitrary strings to register one. This module
does not add Graph permissions, broaden existing source certificates or provide a
provider enrollment path.

## Freshness and lifecycle

Each message requires a new observation at ingress/admission, dispatch and native
consumption. Each protected result, status and cancel acknowledgement create also
requires new evidence. An explicitly permitted no-effect retry needs new evidence;
the previous observation reference alone is not proof of no effect. The only
selected update is the known-ID status reconciliation update, which also requires
fresh evidence. Every other update remains outside this profile.

The dependency query deadline is at most five seconds from the original request
start. The observation's consumed age is at most five seconds, conservatively
including uncertainty. `validUntil` cannot exceed that request deadline. Native
owners must retain the original monotonic deadline across awaits, framing and
rechecks; a wall-clock adjustment cannot renew the budget. Unknown or excessive
clock uncertainty fails closed. A stricter current account, policy, operation or
provider deadline always wins.

`audienceObservationTimingV1` checks finite local elapsed time and conservative
wall-clock bounds, returning `within-bounds` or `invalid-or-expired`. Its clock input
must come from the accepting owner's real clock, and `within-bounds` is only a
representation/timing result. It cannot certify source currentness or native effects.

`observeV1` fetches new evidence without positive reuse or automatic allow retry.
`inspectV1` freshly checks the existing exact observation's native source and
invalidation state; it does not renew the observation or consume an effect.
Re-evaluation invalidates an earlier unconsumed response. If consumption may already
have happened, the canonical owner must reconcile the exact original effect and
retain unknown ownership. A new observation never authorizes another create after
an ambiguous result.

Cancellation signals reach every underlying provider operation. Implementations
own and join losing work, retain its capacity until it settles, and prevent later
delivery after cancellation. `releaseV1` joins remaining observation work; it does
not close journal ownership or assert that a possible remote effect was cancelled.
The caller must retain the native handle until its final release completes.

## Account and effect composition

The existing current-caller account port accepts an actual authenticated request
handle. It cannot be called as another reader by casting that reader's ID into a
handle. `AudienceReaderAccountPortV1` defines the missing account-owner composition:
validate the native invocation and observation custody, resolve every exact human
through current authoritative external bindings, and return the separate
`AudienceReaderAccountsResultV1` observation with its own
account-owner custody. Passive readers need no active login: this observation has
no session, key or caller-credential version. It reuses the existing account,
installation, grants, IAM policy, semantic mapping and driver-selection version
components, plus the actual human binding and Role/AccessBinding decision evidence.
No new epoch, account store, credential or issuer is defined. The original acting
caller continues to use the unchanged authenticated account-authority path.

The passive-reader diagnostic records the exact `conversation.read` operation and
full original request. Its earliest evaluation and validity bounds cannot outlive
the original request or native observation. Every binding version, account state,
selected IAM driver and grant must be current.
Missing or disabled humans, changed bindings or grants, duplicates and incomplete
sets reject the whole audience.

The acting human is independently checked for the exact admission, dispatch,
delivery or cancellation operation. Current account success remains evidence for
the canonical consumer, not a portable permit. Real current comparisons must repeat
at consumption under the sole OCC transaction; a completed account call does not
bridge a later invalidation race.

The exact canonical attempt/slot/effect declarations required for the final
compare/consume composition are not an input to this module revision. Accordingly,
there is no substitute journal DTO, consume API or positive effect-completion
export. The account example ends with `missing-effect-composition` even after all
supplied preparatory checks pass. Completing that boundary requires the original
declaration owner and canonical consumer to supply and accept the exact carriers.
Actual full-reader account resolution, native completeness and provider change
detection also remain implementation dependencies.

## Errors and compatibility

Internal diagnostics use closed `denied`, `not-visible`, `unavailable`, `invalidated`
and `reconciliation-required` variants. Unavailable reasons distinguish absent
native, reader-account or effect producers from incomplete/unsupported readers,
overflow, clock uncertainty, deadlines, cancellation and dependency failures.
Invalidation covers stale data, scope/readers/accounts changing and supersession.
Unknown possible effects require reconciliation and carry no retry permission.

Decoder traversal is bounded to 16,384 values, 14 levels and 256 KiB of serialized
diagnostic data. This supports the 100-human passive-reader envelope with up to
64 Role and 64 AccessBinding references per human when it fits the byte limit.
Every reference retains its own representation limit; exceeding an aggregate
bound rejects the complete record without truncation.

These detailed diagnostics are not automatically safe channel responses. Denial,
busy, status and cancellation-acknowledgement content requires its own disclosure
check or remains available only through an independently authorized status surface.
Decoders reject unknown versions and extra fields. A future version or native
capability cannot be silently downgraded to this profile.

## Verification

The separately compiled native producer and account consumer examples import the
actual package leaf exports. The producer accepts only an owner-supplied invocation
and port. Its synthetic Slack record demonstrates serialization only. Compile-time
negative assertions distinguish native and account diagnostics from handles. The
consumer passes the original native custody, checks complete exact reader
observations, and releases account and native custody in nested `finally` blocks;
it never implements an effect issuer. The separate passive-reader decoder rejects
session and credential fields and requires account, human-binding and Role/AccessBinding
evidence. Its full-set matcher verifies data correspondence; actual currentness
remains the provider and canonical consumer's obligation.

Run the focused checks from the repository root with the workspace dependencies
prepared normally:

```sh
node node_modules/typescript/bin/tsc -p tests/fixtures/audience-observation-v1/native-producer.tsconfig.json --pretty false
node node_modules/typescript/bin/tsc -p tests/fixtures/audience-observation-v1/account-consumer.tsconfig.json --pretty false
node --test tests/conformance/audience-observation-v1.contract.test.mjs
```

Conformance checks exercise the actual decoders, immutable copies, both selected
scope representations, stage matching, missing completeness fields, duplicate and
overflow readers, exact foreign target/scope changes, clock/deadline bounds, closed
errors, malformed arrays/accessors and UTF-8 byte limits. The account requirement
test calls the existing account composition functions. These checks establish
schema and example behavior; they do not establish a live roster, current account
producer, provider cancellation, journal transaction, native write or certificate.
