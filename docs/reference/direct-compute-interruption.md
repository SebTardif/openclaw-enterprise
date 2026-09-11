# Direct-Compute interruption preparation

The finite interruption runner exercises controlled calls through the exported
`RuntimeEffectsV1` contract. It prepares create, observe and route scenarios at
three interruption points: before the call, in flight and after a response is
produced but its acknowledgment is lost. It records the original attempt and
exact readback separately, including unresolved outcomes. The runner is a test
utility; it is not a production lifecycle controller or runtime qualification.

The implementation lives in
[`tests/runtime/direct-compute-interruption/`](../../tests/runtime/direct-compute-interruption/).
It reuses the existing IFC-04 representation fixtures and lifecycle consumer
from [`tests/fixtures/runtime-effects-v1/`](../../tests/fixtures/runtime-effects-v1/).
Their imports select the actual runtime-effects module directly, so preparation
does not load the unrelated native journal SDK. No codec, fixture function or
provider behavior is replaced.

## Run the controlled checks

Use the repository's pinned Node 24 toolchain and explicitly prepared local
TypeScript, TypeBox, Node types and workspace utility dependencies. Follow the
[development verification loop](../development-loop.md) for dependency
preparation. These commands do not install packages, construct a Kubernetes
Driver, contact a cluster or execute a native runtime.

```sh
node tests/runtime/direct-compute-interruption/run.mjs --list
node --test tests/runtime/direct-compute-interruption/runner.test.mjs
node node_modules/typescript/bin/tsc --project tests/runtime/direct-compute-interruption/tsconfig.json --pretty false
node tests/runtime/direct-compute-interruption/run.mjs --controlled --output /tmp/direct-compute-interruption.json
```

The output path must be a new file in an existing directory. The CLI writes it
with mode `0600` and refuses to replace earlier evidence. It runs one sample of
each of the nine scenarios, in create/observe/route order. The default controlled
transport returns incomplete discovery and unresolved readback. Those outcomes
are intentional recorded results, not runtime passes. The test suite separately
checks exact applied and durable non-submission receipts.

`--list` only reads inert descriptors and works without the codec dependencies.
`--controlled` is the only execution mode. A missing dependency, invalid input,
unavailable output directory or existing output file fails the command. Correct
the explicit preparation or select a new output path; the runner does not repair
the environment.

## Inputs and evidence

Each case binds its source commit and tree, current source-file SHA-256 values,
fixture identity, declared image digests and image-set/configuration/profile
digests. It also carries exact owned provider targets and the actual contract
request, including assignment, generation, effect locator and canonical digest.
The controlled CLI obtains source identities from its own checkout; dirty source
bytes appear in the file hashes. Its image and provider records are the existing
synthetic representation fixtures, not measured image or resource identities.
The source manifest covers the full local contracts and utilities source trees,
their package export manifests, workspace/lockfile inputs and the runner's
fixtures and source. It does not authenticate provider data or qualify a build.

`runInterruptionScenario` accepts the exact IFC-04 create, observation or route
request and a caller-supplied controlled session. The session supplies the existing
effect methods and caller context. The runner cannot authenticate that context or
grant an effect. The fixture uses an inert context sentinel solely for recording
calls; it never reaches an authority implementation. Production callers and
providers retain their independent accepting-boundary checks.

Inputs are checked and snapshotted before opening a session. The full matrix is
validated before any case starts. Cases must be unique and follow the fixed
manifest order; incomplete source/configuration/resource inputs, mismatched
request digests and cleanup targeting another assignment are rejected. The
known execution's image/configuration/profile tuple must match the declared
sample. Cleanup must match any execution already bound to the primary request;
if readback identifies a different execution, cleanup is recorded as not invoked.
No new cleanup request is derived from the observed replacement identity. The
matrix has at most nine cases, each with one primary call, at most three
readback rounds, and at most one explicitly supplied retained-state cleanup
call with its own readbacks. A provider call is bounded by the selected timeout,
at most 10 seconds. There is no automatic create or route replay.

The original request and canonical bytes remain immutable through interruption
and readback. Before-call cancellation records that the runner did not invoke
the port; it does not fabricate the provider's durable `not-submitted` receipt.
After possible submission or lost acknowledgment, cancellation and timeout leave
the mutation unresolved. Discovery with zero candidates, incomplete evidence or
an exact object does not settle the original effect. `readEffect` uses the same
effect locator and digest, then validates any returned receipt against the full
original request. A `not-found` result remains unresolved. Settled absence
requires a correlated durable non-submission result.
IFC-04 has no settled-empty discovery variant: a zero-candidate search remains
incomplete discovery, not authoritative absence.

Reports preserve the primary attempt, its resolution, the cleanup attempt and
its resolution as four separate fields. Explicit cleanup carries a distinct
preaccepted effect and must retain stores. A cleanup error cannot replace the
primary outcome; a successful control-object receipt cannot establish physical
termination. The report retains original producer observation clocks without
refreshing them to the runner's receipt time. It separately records ordered local
events, start/end times and elapsed runner time. Raw thrown diagnostics are not
included in evidence.

An in-flight checkpoint or lost-acknowledgment checkpoint is supplied by the
controlled transport. `checkpointReached: false` means the intended interruption
point was not exercised, even if the call itself completed or timed out. A local
AbortSignal only bounds the runner's wait. It does not prove cancellation of the
provider, database lease loss or physical termination. Late results cannot mutate
the returned report.

## Retained execution requirements

All controlled reports label access denial, route removal, provider cancellation,
execution termination and credential revocation independently as `unmeasured`.
Original observation times and route/termination subresults remain visible as
fixture data. No timer, local signal or applied control object becomes a measured
runtime result or a new serving/writer permit. The denial target remains
unmeasured.

The existing
[`Kubernetes lifecycle fixture`](../../tests/fixtures/kubernetes-lifecycle-collaborators/README.md)
owns the selected Driver `runScenario` entrypoint and its public-operation
coverage. The new manifest names relevant cases and leaves them `unrun` during
this preparation. That entrypoint constructs a Driver and needs its original
owner's dependency and execution allocation. This runner neither duplicates its
collaborators nor substitutes controlled IFC-04 records for that coverage. Actual
Kubernetes, gVisor, routing, retained-store and native-runtime acceptance remains
with the existing producers and operator.

Replacement of gateway/harness, quiet native restore and overlapping-turn update
cases are frozen inert descriptors. They contain no request, callback or loader,
and the executable runner rejects their IDs. They require the original lifecycle,
persistence, native-context and collaboration acceptance. There is no replacement,
restore, purge, protected-observation or durable-stop implementation here.

Before later measurement or same-build interruption acceptance, the owning
consumer must freeze sample counts, exact source/image/configuration tuple,
expected failures, actual owned resource and execution identities, observation
producers, bounded authority/provider calls, cleanup responsibility and a current
operator allocation. Missing prerequisites stay blocked or unrun. Any bridge to
an evidence bundle must preserve these measured-versus-prepared distinctions and
original source clocks. See the [runtime effect contract](runtime-effects.md) for
the accepting-boundary semantics and the [testing guide](../testing/README.md) for actual
runtime environment requirements.
