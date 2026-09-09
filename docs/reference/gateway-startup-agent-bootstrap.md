# Agent Gateway startup bootstrap

The Agent/V2 components retain the exact Installation, Namespace and Agent subject
through a confirmed startup claim, local enrollment and material delivery. They
provide trusted programmatic composition. The executable's
`requireAdmittedGatewayConfiguration()` remains unavailable until its original
protected producers are connected.

See [protected Gateway startup](gateway-startup-v1.md) for command/process ownership
and [hosted Gateway composition](hosted-gateway.md) for the fixed Slack/Teams host
adapter and its implementation limits.

## Construction and local lifetime

`createGatewayStartupBootstrapV2(service, confirmedMaterial, adapter)` receives the
original `GatewayStartupServiceSourceV2`, confirmed material factory and fixed
adapter from trusted application code. Call its `enroll()` to obtain the original
local pair, then call `usePort.start(recipient, startup)`. Copied handles, foreign
pairs and historical Installation handles cannot enroll an Agent startup.

The Source validates the original binding, submit/consume events and exact
recipient before local enrollment. The bootstrap performs one confirmed durable
consume. Later currentness reads inspect that same consumed claim; they do not
consume again. An unavailable or uncertain consume grants no local enrollment or
automatic retry.

`GatewayStartupConfirmedMaterialFactoryV2.bind` receives the original Source,
private Source handle and `GatewayMaterialRuntimeOwnerV1` from the local owner's
private state. This local lifetime interface does not change the V2 startup
subject. The parent exists before binding, after the confirmed consume, and
retains that one material acquisition. The factory remains responsible for actual
configuration, protected paths, selected module capabilities and currentness.

The original parent fences new preparation and host startup when revoked. Its
`joinConsumers()` joins registered preparation and original prepared cleanup,
including late results. Material acquisition and borrowing retain their separate
owners; the consumer join does not wait on itself. Failed or unknown prepared
cleanup cannot authorize material release. No serialized reference or matching
digest supplies the missing original owner.

Only `started` exposes the retained host lifetime. Awaiting `lifetime.closed` does
not request shutdown; `close()` joins the original cleanup. Bootstrap `close()`
also retains Source and material cleanup. Local cleanup outcomes always leave
physical termination unknown, so they cannot authorize replacement of an
unsettled process.

## Separate Agent material transport

The Source derives `GatewayMaterialDeliveryRequestV2` from its confirmed claim,
retaining the exact Agent subject and admitted selection. Its material call
reserves the original work and checks Source currentness after the callback
settles. Request metadata alone is not a disclosure permit.

The implemented path uses `createGatewayChannelMaterialClientV2`,
`createGatewayStartupMaterialServiceSourceV2`, the Controller's
`createChannelMaterialNativeServiceV2` and `createGatewayMaterialDeliveryV2`.
Each requires its original current Source, registration, account, selected
material and cleanup participants. These constructors do not install the
executable supplier or establish a live provider credential.

## Verification boundaries

`tests/conformance/gateway-startup-agent-bootstrap.test.mjs` and
`tests/conformance/gateway-agent-material-delivery.test.mjs` exercise the real
local bootstrap and delivery components with controlled collaborators, including
claim correspondence, original handle membership, consumer-parent ownership and
late cleanup.

`tests/integration/gateway-agent-material-native.test.mjs` exercises the actual
TypeScript endpoints, Go child, Workload API and mutual TLS. Its startup,
registration, account, current-selection and selected payload peers remain
controlled. A successful disclosure qualifies the transport exchange; it does
not establish real account admission, live material custody, complete accepted
workload capabilities, hosted readiness or a provider-backed turn. Executing
these checks and composing the original production suppliers are separate work.
