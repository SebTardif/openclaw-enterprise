# Hosted gateway application

The gateway application packages an Agent-owned runtime with the upstream Gateway
Host and the selected native Slack and Teams channel modules. OCC retains Agent
lifecycle and activation decisions; Compute realizes the admitted infrastructure.
The application adds no platform resource, workload identity or authorization
authority.

## Current implementation boundary

The application contains a fixed two-channel composition and lifecycle wrappers
around the public `openclaw/plugin-sdk/gateway-host`, `slack-hosted` and
`msteams-hosted` exports. These wrappers own local startup and cleanup. They do
not supply human authorization, journal provenance, admitted startup or an
Installation process supervisor.

The executable is intentionally unavailable while the protected startup consumer
is missing. With Node 24, this command exits with status 1 and a fixed diagnostic:

```sh
node apps/gateway/src/main.mjs
```

It does not read channel credentials from the environment, accept startup JSON,
load native packages or start a listener. `admitted-configuration.ts` marks the
missing protected startup binding; it defines no provisional wire schema. The
entrypoint must be connected to the real producer and fixed composition before
deployment is supported.

## Compose actual dependencies

`createGatewayComposition` accepts the existing `GatewayHostConfigurationV1`,
the existing policy hooks and genuine identity, Harness and persistence modules,
plus the native adapters' public input types. It adds exactly the Slack and Teams
channel modules and preserves the admitted module order. Missing, duplicate or
mismatched selections are unavailable. Required module functions are structural
checks; their presence does not prove a production implementation or permission.

`loadGatewayCompositionFactories` loads only the three fixed public package
entrypoints. Trusted composition passes those actual exported functions to the
wrappers. Channel content and startup JSON cannot choose a module path. Calling
the loader is not startup admission or evidence that all official plugin runtime
artifacts are installed.

Prepare the composition before invoking its single-use `start()` method. Its
Slack projection exposes only the existing inspect and output ports for wiring
the genuine receiver. The native transport lifetime remains private. A caller
must preserve the original verified input, exact reply target, current output
authority and journal responsibility; the projection creates none of them.

## Startup material and authority

The upstream host replaces its ambient environment before starting modules.
Resolve exact gateway-only material and bind trusted handles through the admitted
producer before that point. Module wrappers cannot depend on inherited provider
or identity environment variables surviving startup. Acquisition, refresh,
revocation and material custody remain the actual producer's responsibility.
Keep secrets out of configuration evidence and diagnostics. Dedicated Harness
credentials stay with the Harness.

The actual protected startup producer must bind the Installation, Namespace,
Agent, revision, assignment, generations, profiles and state paths. The existing
unbound allocation and mapping-only channel resolver do not establish current
serving authority. Required but missing production dependencies must leave the
application unavailable before channel activation.

## Native lifecycle

### Slack

The Slack module constructs one adapter and starts it with the original receiver.
Its `slack.hosted-transport` capability means that native connected health was
observed while the local host fence and supplied currentness check held. It is
not a grant to execute or publish output.

Initial connection recovery remains within that native lifetime. Loss of a
previously ready connection makes the host generation unavailable; the host
contract cannot restore readiness after that transition. A per-event blocked
receipt diagnostic alone is not transport termination.

Closing aborts the adapter lifetime and joins its transport run. If the native
adapter reports retired host receipts, cleanup remains pending until their
actual settlement produces stopped health. Transport closure does not release
those receipts or authorize another turn. Missing terminal cleanup evidence
does not produce a successful close result.

### Teams

The Teams module owns the direct ingress factory and built-in listener. Its
`msteams.hosted-listener` capability describes only successful listener startup
under the current local fence. The underlying app and server are not exposed for
additional mounts or overlapping listeners.

Factory construction and listener startup can outlive cancellation. Their late
results remain owned and must be closed before local cleanup settles. An
unexpected listener close or error removes readiness. Local cleanup never proves
process termination or that every SDK operation has settled.

The selected deployment requires an actual Installation process owner to prevent
overlapping generations and retain predecessor occupancy until supported
termination observation succeeds. Unknown termination keeps replacement
unavailable. The module wrappers and generic Gateway Host do not implement that
owner. See the upstream hosted ingress documentation for the per-factory intake
and pending SDK work boundaries.

## Journal and execution correspondence

The real journal owner must preserve one committed claimant through the actual
native first effect. Returning a consumed Boolean and then writing after the
callback returns does not satisfy that contract. A second consume in the Harness
does not repair it. Cross-process deployment requires the accepted original
callback and provenance binding, with independent authority for later output,
subscription, cancellation and reconciliation.

The current public Teams ingress input still carries the legacy admission
dependency type. The lifecycle wrapper preserves that interface and advertises
no execution capability. It does not convert legacy consumption into the newer
initiation callback or supply the missing production bridge.

## Verification and troubleshooting

Run the focused source conformance cases with the selected Node 24 toolchain:

```sh
node --test --test-concurrency=1 tests/conformance/gateway-composition.test.mjs
```

Controlled native peers exercise the real wrappers' readiness, cancellation,
late completion and cleanup transitions. They do not prove Slack or Teams
authentication, current human/audience authority, durable receipts, process
replacement or live collaboration. Record the exact executed cases separately
from unavailable package and production integrations.

Prepare dependencies separately before type or installed-consumer checks. A
declaration-only SDK artifact does not provide the executable root package or
official plugin runtime artifacts. Missing public exports, plugin runtime files
or the protected startup binding are setup or implementation failures; do not
repair them by importing private source paths or weakening checks.

The current executable diagnostic means the admitted startup consumer is not yet
connected. Native module unavailability indicates a failed selection, currentness
check or lifecycle transition. Keep details in the owning component's bounded
diagnostics without logging credentials, untrusted event bodies or raw provider
errors. Successful local cleanup still leaves process termination to Compute.
