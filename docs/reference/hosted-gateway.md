# Hosted gateway application

The gateway application packages an Agent-owned runtime with the upstream Gateway
Host and the selected native Slack and Teams channel modules. OCC retains Agent
lifecycle and activation decisions; Compute realizes the admitted infrastructure.
The application adds no platform resource, workload identity or authorization
authority.

## Current implementation boundary

The application contains a composition with explicitly selected channels and lifecycle wrappers
around the public `openclaw/plugin-sdk/gateway-host`, `slack-hosted` and
`msteams-hosted` exports. These wrappers own local startup and cleanup. They do
not supply human authorization, journal provenance, admitted startup or an
Installation process supervisor.

The fixed startup consumer is implemented, but the executable remains unavailable
until the genuine protected bootstrap supplies its original local enrollment.
With Node 24, the current unbound command exits with status 1 and a fixed diagnostic:

```sh
node apps/gateway/src/main.mjs
```

It does not read channel credentials from the environment, accept startup JSON,
load native packages or start a listener. `admitted-configuration.ts` marks the
missing protected startup binding; it defines no provisional wire schema. The
entrypoint calls the original sealed startup port once, using only its enrolled
recipient and startup handles. A started result retains its owner lifetime; main
awaits `lifetime.closed` without requesting immediate shutdown. Denied, unavailable
or recovery-required results fail without retry or disclosure of the operation
locator. Failed or unknown local cleanup also fails. The genuine bootstrap,
material and currentness producers must be connected before deployment is supported.

The [Agent/V2 bootstrap](gateway-startup-agent-bootstrap.md) supplies a separate
programmatic local owner and material join. It does not install the executable
supplier. The existing direct Compute runtime path is a separate integration;
its execution does not qualify this hosted application's admitted native startup.

## Compose actual dependencies

`createGatewayComposition` accepts the existing `GatewayHostConfigurationV1`,
the existing policy hooks and genuine identity, Harness and persistence modules,
plus the native adapters' public input types. Each channel input is either its
complete selected configuration or explicit `null`. It adds only the selected
Slack and Teams modules and preserves the admitted module order. A no-channel
composition still requires the identity, Harness and persistence owners and all
policy callbacks. Omitted inputs, missing configured channels, duplicate or
mismatched selections are unavailable. Required module functions are structural
checks; their presence does not prove a production implementation or permission.

The V2 workload-profile manifest can likewise select no channel modules while
retaining its complete core-module, material, path and capability requirements.
This removes a local composition prerequisite; it does not install the genuine
Agent/V2 material factory or make the unbound executable available.

The currently prepared upstream `startGatewayHostV1` still requires at least four
modules and one channel. Its schema rejects a configuration containing only the
three core modules with `INVALID_CONFIG` before the required-channel check.
No-channel support here covers manifest representation, material borrowing and
local preparation/cleanup. Starting that configuration additionally requires a
reviewed upstream host change and refreshed SDK artifact. This application does
not add a placeholder channel to bypass that requirement.

`loadGatewayCompositionFactories` loads only the three fixed public package
entrypoints. Trusted composition passes those actual exported functions to the
wrappers. Channel content and startup JSON cannot choose a module path. Calling
the loader is not startup admission or evidence that all official plugin runtime
artifacts are installed.

`prepareGatewayComposition` is the fixed adapter captured by the protected startup
owner. It loads the fixed factories and returns an owned prepared handle before
any transport starts. The handle's single-use `start()` returns the host
synchronously so its owner can retain it and register revocation before waiting
for readiness. A revoked owner quiesces/closes immediately, even while readiness
is pending, and retains late results until cleanup settles.

The prepared handle's idempotent `close()` prevents a later start and joins all
constructed module closes before host ownership. Once start returns a host,
cleanup delegates to that host's close owner. Its `{ cleanup }` result describes
local cleanup only. If preparation rejects before returning a handle, the actual
material owner retains pre-transfer resource and late-preparation cleanup; that
producer responsibility must not be inferred from the adapter's types.

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

The Gateway material client is constructed with
`createGatewayChannelMaterialClientV1(source, options)`. Capture the original
startup Source and protected native deployment configuration once; configuration
records cannot enroll a Source handle or establish current authority. Its
`open(parent, request, bounds)` consumes the existing material-client port used
by `createGatewayStartupMaterialServiceSourceV1`. It checks the original parent,
exact consumed request and recipient, verifies the selected executable, and
starts only the fixed `channel-material-client` mode with owned pipes and an
empty inherited environment. The actual binary, protected parent directories,
SPIFFE/SPIRE configuration, registration and material producers remain required.

Each constructed client admits one active child without a queue or automatic
retry. The original Source deadline/cancellation and the dedicated five-second
ceiling cannot be renewed by a connection or result. The existing native wire
bounds and exact peer/exchange/challenge/request correlation apply. Payload views
remain borrowed until the actual consumer callback settles, including late
settlement after cancellation; retirement clears the owned backing before the
completion ACK. `withPayload` returns with its original pipe open so the Source
consumer can perform its final currentness check. Explicit `close()` then sends
EOF and joins the child. A pending join retains ownership and capacity; a timeout
is not proof of cleanup. The ACK is transport settlement, not provider use,
durable journal responsibility or new serving authority.

Controlled filesystem/pipe fixtures exercise this client's local lifetime and
refusal behavior. They do not establish an authenticated native/TLS exchange,
installed discovery, selected channel-material delivery or live provider
qualification. The actual admitted composition must supply all original owners
before enabling this path.

The actual protected startup producer must bind the Installation, Namespace,
Agent, revision, assignment, generations, profiles and state paths. The existing
unbound allocation and mapping-only channel resolver do not establish current
serving authority. Required but missing production dependencies must leave the
application unavailable before channel activation.

### Agent/V2 material delivery

`createGatewayChannelMaterialClientV2`,
`createGatewayStartupMaterialServiceSourceV2`, the Controller's
`createChannelMaterialNativeServiceV2` and the original
`createGatewayMaterialDeliveryV2` owner implement the separate Agent material
path. They preserve the full Agent startup subject and confirmed claim. The
[local bootstrap](gateway-startup-agent-bootstrap.md) binds material to its
original consumer parent after the sole confirmed startup consume. These
constructors still require the original Source, account, registration, selected
material and lifetime participants; they create no installed startup authority.

`gateway-agent-material-native.test.mjs` exercises the actual TypeScript endpoints,
Go child, Workload API and mutual TLS with controlled startup, registration,
account, current-selection and payload peers. A successful byte exchange qualifies
that transport boundary. It does not establish live material custody, complete
workload-profile capabilities, hosted readiness or a provider-backed turn.

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

The executable's fixed diagnostic means startup or local cleanup is not confirmed.
In the current unbound deployment, the missing protected bootstrap is the cause. Native module unavailability indicates a failed selection, currentness
check or lifecycle transition. Keep details in the owning component's bounded
diagnostics without logging credentials, untrusted event bodies or raw provider
errors. Successful local cleanup still leaves physical termination and nonoverlapping replacement to the actual external process owner.
