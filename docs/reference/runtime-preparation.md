# Retained runtime preparation

The OCC platform store retains a preparation's complete closed plan, exact provider
request bytes, binding proposals and local closure history. This is an internal
repository available through `PlatformUnitOfWork.runtimePreparation`; read views
expose its three history methods. It has no HTTP endpoint or startup option.

PostgreSQL retention records durable intent and data; the memory adapter remains
process-local. Retention does not admit a provider operation,
submit a request, establish current service authority, complete a fence or authorize
a writable successor. The authenticated runtime authority service preserves its
existing mutation and purpose denials until those accepting dependencies exist.

## Effect admission consumer

`RuntimePreparationEffectAdmissionV1` implements the five local admission methods:
`readGate`, `admitChild`, `completeFence`, `recordFaultAndRequestStop` and
`readRequest`. Construct it with the original native context inspector and State
operation owner. It compares the original retained preparation, complete history
and exact provider request before the selected accepting operation. Each history
entry retains its own canonical size bound; a valid complete history is not
truncated to fit one request's byte limit.

The original source must independently qualify the exact purpose and retained
objects. Missing positive child/fence writers remain unavailable, including after
all data comparisons succeed. This consumer does not implement those writers,
issue an SDK permit or replace the provider's final currentness fence.

Cancellation and the bounded public deadline can return before late work settles.
The original owner still owns its transaction and transferred source lease;
`joinPending()` joins the consumer's outstanding continuations and cleanup.
Unknown COMMIT outcomes remain distinct from definite refusal, and a later
callback or cleanup result cannot manufacture successful admission.

Run `node --test
tests/conformance/runtime-preparation-effect-admission.test.mjs` to exercise the
real consumer and memory preparation/history repositories. Native recognition,
current-source qualification and accepting operations are controlled ports in
this suite. Its results do not establish the missing internal producers,
PostgreSQL fencing, Kubernetes effects or a complete application E2E flow.

## Canonical closed gate and fault retention

The PostgreSQL store exposes the optional internal `runtimeEffectAdmission`
repository. `retainClosedGate` resolves an exact original retained plan and its
current intent, then initializes one permanently retained Agent gate with both
ordinary and sealer admission closed. It does not admit previously retained
children: its admitted cutoff remains zero. Opening either admission class,
admitting a child, accepting provider fence completion and writable successor
release remain unsupported.

`retainFaultRequest` is an isolated, provisional storage operation. It retains the
exact fault bytes and digest, complete expected guard, advancing fence epoch and
gate version in the existing cleanup responsibility owner. Its intent reference
remains the original intent; a same-generation fault creates no human lifecycle
operation or new desired generation. The same transaction retains an independent
source audit and an exact `ReconcileRuntimeFaultV1` work association. The outer
service must authenticate the actual fault producer before exposing acceptance;
the internal storage result is not `RuntimeEffectAdmissionV1` authority.

Original disable/stop intent advancement closes this same gate in its transaction.
An older runtime-intent writer cannot supersede a retained gate without the exact
cleanup owner. Gate rows and original cleanup records cannot be deleted or reopened.
Other source-loss producers, including account/session and IAM,
still require their original accepting integrations before ordinary effects can
be enabled.

Fault work is a distinct version in the existing controller queue. Its claim and
restart recovery require the original lifecycle worker role and an independently
installed fault-work compatibility marker. Without that capability, the record
remains queued. The worker verifies exact original fault readback and defers the
same responsibility while the protected provider fence/stop implementation is
unavailable. It cannot dispatch legacy preparation or repair, exhaust cleanup
into a terminal state, or treat cancellation as termination.

After an unknown COMMIT, a fresh `findFaultRequest` with the exact original
operation and digest recovers the retained record. A later gate or lifecycle head
does not rewrite historical closure. Conflicting bytes fail; neither recovery nor
an exact replay submits a provider operation. The focused PostgreSQL test exercises
these storage boundaries with `OCC_RUNTIME_GATE_DATABASE_URL` selecting a dedicated
loopback database. Its actual worker case additionally requires a separately
provisioned limited `OCC_RUNTIME_GATE_WORKER_DATABASE_URL` for that same database
and the operator fixture URL in `OCC_MIGRATION_DATABASE_URL`. The fixture exercises
claim, deferral, restart recovery and capability withdrawal; it performs no
provider work. The work-codec test covers strict serialized input.

### Original profile withdrawal and replacement

The gate binds its immutable target to the original admitted Agent revision. Its
`workload_profile_use` identifies the exact profile admission, version, manifest,
and profile references. A gate initializes only while that original profile is
still admitted. A legacy revision without a profile remains an unassociated
closed gate.

The original profile invalidation insert closes every matching gate in the same
transaction as withdrawal or replacement. Closure advances the gate version and
fence epoch without changing the runtime intent or lifecycle generation. The
existing cleanup responsibility stores `runtime-profile-v1`, the original
invalidation reference, prior/closed guards, retained allocation membership, and
an exact schema-3 `ReconcileRuntimeProfileV1` work item in `controller_work`.
Historical readback remains available by scope and invalidation after later
lifecycle changes. It grants no execution or human authority.

The existing profile capacity advisory lock orders source management and gate
initialization. Original current-use, deployment/draft enrollment, and mutable
profile reads take its shared form before Namespace/Agent locks. Source writes
hold its exclusive form; affected Agents are locked in stable ID order before
their gates. This covers those original service paths and supported direct
profile DML. Arbitrary callers that acquire unrelated parent locks before entering
an original owner are outside that ordering protocol.

Migration 0049 uses the same source helper for already-withdrawn profiles that
have matching closed gates. This retains negative cleanup only, preserves the
original invalidation timestamp, and is idempotent by invalidation plus Agent.
It does not create an admitted profile or reopen a gate.

Schema-3 work requires the separately installed original lifecycle-worker marker
and a live `runtime_profile_version=1` compatibility record. The worker reads the
original association, reports `PROVIDER_FENCE_UNAVAILABLE`, and defers the same
claim. Restart recovery preserves pending responsibility; neither a queue result
nor missing capability establishes provider termination. Ordinary and sealer
admission remain closed until the genuine protected provider owner is available.

## Repository operations

`retain(mutation, attribution)` runs inside the existing OCC transaction. Every
mutation has a preknown operation reference, preparation reference, exact runtime
allocation target and current intent reference, mode and lifecycle generation.
Attribution contains the original internal writer reference and recording time;
it is data and does not authenticate that writer.

| Kind             | Retained result and required comparison                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retain-plan`    | Starts local version one for an admitted revision and an actually unbound allocation. Retains the complete plan and separate preparation descriptor. The local expected version is `null`; admitted-child cutoff starts at zero.                                                                                                                                |
| `retain-child`   | Appends a prepared effect and its actual UTF-8 provider wire bytes after the complete plan exists. The exact previous local version and guard must match.                                                                                                                                                                                                       |
| `retain-binding` | Retains the original binding proposal, canonical authority submission bytes and exact original authority operation locator. The allocation must still be unbound; a matching retained materialization child is required.                                                                                                                                        |
| `supersede-plan` | Retains a new complete plan, increments local and gate versions, and increments plan version under the same plan identity. Fence epoch and responsibility version cannot decrease; responsibility identity stays fixed within the preparation. A changed preparation descriptor increments its separate version. All unresolved child/proposal history remains. |
| `close`          | Appends the local state `closed` or `superseded` under the exact prior version and guard plus current intent. It preserves outstanding history and does not claim nonexecution, physical termination or cleanup completion.                                                                                                                                     |

The guard comparison includes exact scope, intent, lifecycle generation, gate
version, requested fence epoch, responsibility identity/version, plan
identity/version/digest and admitted-child cutoff. The retained-child sequence is
separate from that cutoff. Retention never advances the authoritative admitted
cutoff. Kubernetes resource versions remain opaque strings; they are retained
without local arithmetic or rebasing.

A complete plan may name multiple allocations within the same Agent scope. Every
planned assignment/create-effect owner must exist canonically, and the plan must
include the primary allocation. Plans are stored in full, including descendant
producer domains. A child must preserve its original target predicate, plan,
responsibility and exact provider target. Retained data alone does not prove that
a producer domain is complete or that a renderer/profile was approved.

## Bytes, replay and recovery

Every operation retains canonical request JSON and its SHA-256 digest. Prepared
children preserve the separate canonical logical request and provider wire
reference, digest, byte length and renderer identity, together with the actual
wire string. Each logical request and wire payload is limited to 65,536 UTF-8
bytes independently. The accepted effects schema also bounds aggregate effect
JSON to 262,144 UTF-8 bytes, depth and collections. Oversize values are rejected
without truncation. The enclosing internal mutation is bounded to 1 MiB and
retained child count to 256.

Binding proposals use the existing runtime authority schemas and bounds. They
are not inserted into the provider-effect union. The canonical authority payload
excludes its request-reference slot by contract; the complete original proposal
and original `ExactAuthorityOperationV1` are retained as well, so recovery cannot
substitute a new locator.

`findOperation(scope, operationRef)`, `findPreparation(scope, preparationRef)` and
`listHistory(scope, preparationRef)` return detached immutable retained data for
the exact Installation, Namespace and Agent. Exact operation replay compares the
complete original mutation and attribution before checking the current head.
Changed bytes, renderer, owner, locator or attribution conflict. Historical reads
and exact repeats therefore survive later head advancement, plan supersession,
closure and successor allocation without reobserving or retrying anything.

After an unknown database COMMIT outcome, read the preknown original operation
reference in a new transaction. A missing record does not prove that a provider
request was never submitted. No repository result is a current authority receipt,
a fence-completion receipt or an instruction to retry an effect.

## Transactions and verification

### Asynchronous admission origin and current worker use

The original guarded deployment transaction can retain the authenticated
account/session association alongside its newly inserted revision, intent,
audit and work. The record contains a session identifier and credential digest,
not a bearer credential. This internal historical correlation keeps the BetterAuth account/session subject separate from the original NativeIAM
principal ID. Migration 0046 checks their actual IAM association and corrects
the workload-profile JSON validation expression. It does not replace the
original session or backfill older admissions. Exact replay preserves its
original association. PostgreSQL also requires the admission and origin to be inserted in the same transaction.

`withRuntimePreparationWorkerCurrentUseV1` resolves that original association
from the actual claimed work and reacquires the current account/session and
selected NativeIAM policy on a fresh transaction. It checks the original
revision's Configuration and ServiceAccount permissions, active profile and
retained Use, exact preparation version/guard/child bytes, current running
intent and unexpired work claim. Closing the original HTTP request does not
require the worker to impersonate a new request. Session revocation, account
incarnation/version change, policy denial, supersession and missing origins
remain refusals. The returned observation expires with its transaction.

This reader supplies necessary preparation data. Its exact submission readback
returns retained API identity or uncertainty without SDK work. Migration 0043
retains immutable submission responsibility and response identity; these rows
do not grant permission to send an effect. A response retains its finite reported
observation time without comparing clocks between the SDK host and database; that
time does not establish causal ordering or timed-effect authority. Current canonical gate admission,
fault/withdrawal fencing and an original worker invocation that survives SQL
terminals remain required. The selected Compute has no prepared submission
accepting method until that owner exists. Neither a queue token nor a persisted
session locator is execution authority.

Origin INSERT remains owner-only after migration. Operators must bind that
permission to the same explicitly selected controller role already authorized
to execute `occ.read_locked_workload_profile_session_v1`, and preserve the
original account/session-before-IAM lock order. Do not grant origin INSERT to
`occ_app`. Existing rows remain readable for scoped recovery; no historical
origin backfill is supported.

### Conditional Deployment wire boundary

The Kubernetes prepared Deployment codec supports an inert `POST` with replicas
zero and a materialization JSON Patch that tests UID, resourceVersion and all
three protected annotations before replacing the spec:

- `openclaw.dev/runtime-assignment-ref`
- `openclaw.dev/runtime-create-effect-ref`
- `openclaw.dev/runtime-fence-epoch`

The codec verifies the separately retained wire digest/length and requires its
bytes to match the actual selected SDK serializer. Materialization cannot edit
ownership annotations, omit tests or rebase a predicate. Its result uses the
API-returned namespace, name, UID and resourceVersion. Ordinary server-side apply
remains a separate operation and does not become conditional effect admission.

`tests/conformance/kubernetes-prepared-deployment.test.mjs` exercises the actual
SDK against a controlled loopback HTTP server, including exact wire bytes and
response mismatch/refusal. It does not establish Kubernetes enforcement,
authenticated producer evidence or live runtime readiness.

The full-spec comparator uses the selected fixed Harness constructor, also used
by ordinary reconciliation. Its launcher operands must be the actual completed
return retained by the original lifecycle dispatcher. Copies, aborted launches,
replacement and cleanup cannot provide that custody. Comparison includes every
Pod field, including executable helpers, readiness, mounts and resource limits.
The installed renderer source must independently qualify its complete runtime
and actual image projection; absent inputs remain unavailable.

The memory adapter uses the existing working snapshot and transaction lifetime.
The PostgreSQL adapter borrows the owner's transaction and uses immutable rows,
exact allocation ownership, unique operation/child/proposal identities, local
version constraints and guarded inserts. The application role can read and append
these records, but cannot update, delete or truncate them. Failed preparation
writes poison the same existing authority transaction guard, including errors
caught by a caller; accepted work drains before commit and late submissions fail.

Run the focused memory suite with `node --test
 tests/conformance/runtime-preparation.test.mjs`. The integration suite is
`tests/integration/runtime-preparation-postgres.test.mjs`; it requires the explicit
isolated PostgreSQL application and migrator URLs and a private restart-receipt
path. It checks actual transactions, limited-role constraints, independent-client
races, cancellation and protocol-level lost COMMIT acknowledgment. Its separate
fresh-process mode verifies the retained receipt after an actual database restart.
See the [testing guide](../testing.md) for environment custody and supported tools.

The separate `tests/integration/runtime-preparation-invocations-postgres.test.mjs`
suite exercises the original worker current-use owner after real HTTP sign-in has
closed. It requires the selected controller role and isolated migrator/application
URLs. Its fixture grants and restores the narrow session-reader and origin-insert
permissions. It checks current NativeIAM policy, the genuine queue claim, terminal
lease refusal, revocation and exact readback without Compute. Its controlled
profile and stored provider responses establish storage correspondence, not
installed capabilities or provider execution.

The binding-candidate round trip consumes the actual original helper, stores its
canonical proposal and locator, and reads those same bytes after restart.
Synthetic Compute observations in that representation test qualify neither a
live provider nor authenticated mutation admission. Production acceptance still
requires current preparation/service/profile evidence and the actual provider
accepting boundary; this store does not supply those missing producers.
