# Runtime preparation transactions and submission

Part of the [Retained runtime preparation](../runtime-preparation.md) reference.

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

This reader supplies the complete retained preparation and exact child wire data
to the original submission owner. Its submission readback returns retained API
identity or uncertainty without SDK work. Migration 0043 retains immutable
submission responsibility and response identity; these rows do not grant
permission to send an effect. A response retains its finite reported observation
time without comparing clocks between the SDK host and database; that time does
not establish causal ordering or timed-effect authority. Neither a queue token
nor a persisted session locator is execution authority.

### Historical create references and physical correlation

The historical create-reference resolver selects one retained child effect or
immutable submission, verifies its complete preparation history and returns the
exact original create input with `expectedObject: null`. It preserves canonical
submission and response timestamps without ordering their independent clocks.
The correlation codec validates and freezes the associated request, record and
provenance data. Neither function authenticates a native exchange or authorizes a
provider operation.

The Kubernetes Driver exposes a physical correlation owner through the same
selected Driver. It compares the retained Namespace and Deployment identities,
reads the observed assignment/create annotations and fence encoding, and returns
physical data. Its `prepareCommit()` performs one memoized second read of both
objects; concurrent and later calls join that same preparation. Closing the
owner joins entered work before releasing its selected Driver hold.

`createComputeDriver` accepts the trusted runtime observation dependencies as
its sixth optional argument. `createSelectedComputeCorrelationObservationOwner`
uses the original method captured at factory construction and rejects a copied,
external or differently selected Driver. The installation caller does not yet
supply those dependencies. Original native purpose and exchange recognition,
State enrollment and retained writer/provenance authority are still required
before production composition can use the physical reader. Matching annotations
or a successful local comparison cannot supply those authorities.

The controlled conformance suites are
`runtime-preparation-create-reference.test.mjs`,
`runtime-create-correlation.test.mjs`,
`runtime-create-correlation-observation.test.mjs` and
`compute-create-correlation-factory.test.mjs`. They exercise the real resolver,
codec, Driver and factory with controlled history, SDK and authority inputs;
they do not establish a live Kubernetes or native producer.

### Submission and independent response retention

`PostgresPlatformState.runtimePreparationSubmissionOwnerV1` captures the selected
current-use reader, capabilities, original invocation participant and independent
response source once. It retains the exact submission marker in its original
transaction. Only a newly acknowledged marker, after that transaction settles,
can invoke the participant. A repeated marker, a rejected marker or an unknown
COMMIT cannot invoke it again. Response retention uses a separate original
transaction and observation lease, so it can finish after the old claim or
current-use transaction has closed. Nested or outlived participation poisons the
original owner; pending operations and transferred cleanup are joined.

The selected Kubernetes Driver has a `KubernetesPreparedSubmission` bridge. Its
provider adapter captures the original clients and exact immutable request. The
bridge requires an original execution lease, the original lifecycle effect guard,
and a separately acquired response-observation call. The original effect owner
alone may enter the provider adapter. It rechecks currentness around asynchronous
work, refuses late callbacks after invocation closure, and joins entered provider
and response-retention work before releasing its leases.

These constructors are implemented interfaces, not installed positive suppliers.
The original current gate, protected provider-entry authority, observation
recognition and corresponding application composition remain required. Missing
suppliers refuse before State submission; a controlled test participant does not
satisfy the production construction requirement.

The revision worker selects retained preparation explicitly. Once selected, its
result stays on the original queue's deferral path, including exhausted or aged
work. A failed deferral cannot fall back to legacy preparation, retry exhaustion
or provider replay. The profile/fault cleanup consumer similarly requires the
original retained cleanup association and independently authorized cleanup or
readback call. Claim loss may retain an entered effect's result for that owner;
it does not authorize a successor operation or turn an unknown result into
completed cleanup.

Run the submission contract and owner conformance files with `node --test
tests/conformance/runtime-preparation-submission-contract.test.mjs
tests/conformance/runtime-preparation-submission-owner.test.mjs`. The owner suite
exercises the actual State transaction finalizer with controlled transport and
authority ports. Worker and provider regressions exercise their real consumers
with controlled peers. These checks do not establish PostgreSQL durability,
live Kubernetes effects or complete internal producer composition. The dedicated
PostgreSQL suites below retain their separate environment requirements.

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
See the [testing guide](../../testing/README.md) for environment custody and supported tools.

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

## Selected node-network observation

The Kubernetes constructor and selected Compute factory accept an optional trusted
`nodeNetworkObservation` configuration containing the existing node client, network
name and interface name. It is passed to the same Driver alongside its original
observation dependencies. Configuration must match the selected gVisor and cluster
context; omitting it preserves the observation-only construction.

For a selected Harness observation, the node client keeps physical execution and
original CNI ADD attachment handles distinct and compares their retained association.
The observation joins actual entered supplier reads and cleanup even when cancellation
wins an outer timeout. Late supplier success does not replace the chosen refusal.
This invocation's pending work is separate from the create-correlation operation's
own reads and lifetime. Native close failure remains a refusal.

A genuine creator/assignment-to-CRI-to-ADD record and current original execution
reader are still required. A new physical snapshot, copied association or configured
node client cannot establish that authority. The original native and State owners
must enroll and persist the first association; missing inputs continue to refuse.
