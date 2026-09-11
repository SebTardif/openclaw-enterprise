# Runtime preparation admission and closed gates

Part of the [Retained runtime preparation](../runtime-preparation.md) reference.

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
