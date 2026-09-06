# Lifecycle handler and observation definitions

The lifecycle handler modules define the next in-process boundary for admitted
work and authorized status reads. They add closed observation/result schemas,
strict data parsers, provider-preserving interfaces and independent producer,
handler and operator examples. They supply no handler implementation, current
authority, observation producer, queue registration or management route.

The existing bodyless deploy route and immutable revision response remain in
place. A schema-valid capability or result cannot enable a later protocol.
Installing a live handler requires the actual codec, constraints, dispatcher,
receiving guards and compatible control processes to be reviewed together.

| Module                                                    | Meaning                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@openclaw-enterprise/contracts/lifecycle-admission-v1`   | Existing canonical command, intent, immutable association, receipt, operation projection and `ReconcileAgentLifecycleV1` input   |
| `@openclaw-enterprise/contracts/lifecycle-observation-v1` | Closed observation, status, pagination, capability and handler-result values; strict parsing and request/response correspondence |
| `@openclaw-enterprise/occ/lifecycle/handler-ports-v1`     | Handler, authentic observation producer, canonical provider composition and authorized read interfaces                           |

The new types reuse the accepted admission request, intent and receipt identities.
They also reuse the actual runtime authority, effect, fence, cleanup and writer
types. There is no replacement effect journal or generic remote stop receipt.
The API-to-worker handoff remains persisted work; no RPC enters admission's
atomic transaction and no transport or generated browser client is selected here.

## Handler and producer calls

`LifecycleHandlerPortV1.reconcile` accepts exactly the canonical admitted-work
input and an in-process call containing existing authenticated service custody,
deadline/cancellation bounds and original queue-claim correlation. Parsed work,
a claim token, a TypeScript interface or a previous result is not permission.
The real handler loads and verifies the complete immutable owner, operation,
audit and original-work association before binding any driver.

The closed steps are `observe`, `deny-predecessor`, `terminate-predecessor`,
`prepare`, `activate`, `publish` and `cleanup`. Current running work requires
current original-actor/reference/profile authorization at every accepting
boundary. Disabled or stopped intent forbids preparation, restore, activation,
repair or creation for user work. A new desired intent does not resolve an
unknown predecessor or allow a successor writer.

`LifecycleObservationProducerPortV1.observe` receives the same work identity and
independently authenticated service call. Its actual implementation derives
observations from its authoritative records and source receipts. The caller
cannot publish an aggregate claimed status through this port. Missing source,
coverage or currentness stays unavailable or unknown. A publisher still needs
its own atomic current-version guard; these declarations implement no publisher.

`LifecycleHandlerProvidersV1` keeps the existing runtime assignment authority,
runtime effects, effect-admission/fault gate, workspace writer/store evidence and
work reader as distinct exact interfaces. An actual server-owned composition
must qualify those implementations. Their structural presence in an object does
not authenticate, select or authorize them.

## Truthful status and separate disclosure

Authorized reads use the existing `LifecycleReadCallV1` and closed read result.
Every status, exact operation, page and capability read requires current exact
Agent read permission and owner restriction. Revision documents separately
require both Agent and AgentRevision permission. Mutation permission alone does
not grant these reads or enlarge a mutation receipt.

Status keeps requested, selected and serving revisions separate. A database
selection is not serving. `observedLifecycleGeneration` is the actual observed
generation or null; copying the desired generation into it does not establish
freshness. Original provider `observedAt` and OCC `recordedAt` remain distinct,
including missing timestamps. Receiving old evidence again cannot refresh its
source time. Unknown evidence cannot become convergence because work finished.

| Result                        | Required actual producer facts                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running convergence / serving | Matching current running intent and selected assignment, fresh required runtime/identity/storage/authority evidence, effective routing and writer safety   |
| Disabled convergence          | Affirmative new-access denial, effective route withdrawal and recorded cancellation request; physical termination may remain pending or unknown            |
| Stopped completion            | Current stopped intent, affirmative denial and route withdrawal, every affected runtime terminated and every possible create resolved absent or terminated |

Access denial, route removal, execution termination, credential revocation and
state retention have separate conditions. Credential aggregation needs every
affected tracked credential's confirmed revocation or expiry. It cannot be
inferred from physical stop. Retention has its own retained, verification-pending
or unknown outcome and conveys no content, path, credentials or purge authority.
Boolean false for serving does not imply termination; a cleanup or fence receipt
does not itself prove all possible writers are gone.

Exact operation reads reuse the immutable admission operation projection and add
its separate sanitized observation. Older operations remain readable after head
advancement, with superseded or retained historical observations; they cannot
authorize new work. Discovery pages contain only the minimal immutable operation
fields, omitting retained revision, actor, audit, work and runtime details.
Requests use an explicit null-or-positive `afterGeneration` and a bounded limit.
Items and `nextAfterGeneration` come from the same exact owner-restricted page.
Foreign row counts cannot influence the page or disclose hidden existence.

The parsers reject absent, zero, fractional, unsafe or otherwise invalid
generations where null-or-positive is required. Request/response helpers compare
scope, original work/operation, generation, page order, limits and cursor. They
do not query the store, authorize the reader, attest COMMIT or prove observation
freshness. Public reasons are a closed safe enumeration; internal error text,
provider URLs, credentials, transcripts and unfiltered causes never enter it.

## Deadlines, uncertainty and retained cleanup

Every real call is bounded by the remaining enclosing deadline and any stricter
policy. Existing ceilings remain authoritative: lookup 3 seconds, each provider
request 10 seconds, preparation 900 seconds, graceful stop 30 seconds and a
termination observation episode 120 seconds. Source observation age is at most
15 seconds with trusted uncertainty at most 2 seconds; active authority recheck
is at most 5 seconds plus each accepting-boundary check. These values are limits,
not measured guarantees supplied by this module.

Reconcile backoff remains 1, 2, 4, 8, 16 and 30 seconds with bounded jitter and
deadline caps. The independent five prior-writer observations per 120-second
episode limit still wins; the schedule grants no extra observations. The
60-second local denial target remains unmeasured. Exhaustion leaves blocked or
unknown state under the same original responsibility.

Before any possible submission, the actual owner retains the exact original
operation/effect identity and normalized request digest. Cancellation, claim
loss, expired deadlines or a lost response afterward cannot be translated into
absence, successful stop, a reminted locator or replacement generation. Unknown
effect, authority, fence and cleanup outcomes retain their respective canonical
identities. Readback uses the exact original owner and a fresh authorized call;
an empty or unavailable read does not prove the old operation cannot still commit.

Request closure does not erase admitted cleanup or writer exclusion. Further
cleanup requires its own current service authority and exact independently
retained responsibility, even after the initiating human is revoked. It cannot
create, resume, purge or touch a successor. The expired call is not extended and
the original human's authority is not reused. Lifecycle POST is never retried
automatically; lost-response discovery remains uncertain when no exact accepted
locator is known.

## Compatibility and consumer checks

The capability schema represents legacy, drain and live stages with the closed
supported consumer version for each API, worker, maintenance and receiving role.
It is an observation of server-owned installation compatibility. A configuration
toggle cannot fence an old process, establish retained-stop capability or prove
that a handler is installed. The actual publisher verifies those facts.

Drain preserves the existing retained-state shutdown requirements. Live requires
every affected consumer to participate and old writers to be excluded; there is
no per-process opt-out or mixed-version guarantee. Unsupported older processes
must refuse startup, lease acquisition and mutations. Missing capability leaves
the affected operation unavailable. No automatic backfill, inferred running
assignment or automatic legacy restart follows from these types.

The independent producer, handler and operator fixture modules import public
package subpaths. They use injected future ports and existing trusted call types,
construct no authority and preserve exact request/result correspondence. Their
strict compilation and pure negative vectors establish definition compatibility,
not actual PostgreSQL, provider, lost-COMMIT, serving or termination behavior.

Real observation collection, publication, authorized repositories, lifecycle
transactions, route/client cutover, queue registration and accepting runtime
effects remain separate implementation work. A future accepted shared-client
migration must provide its producer-owned browser-client conformance separately;
this module chooses no framework or generated client.
