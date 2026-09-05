# Channels and delivery boundaries

OpenClaw Enterprise configures native channel plugins in an Agent-owned
OpenClaw gateway. This page connects the current configuration, binding,
storage, and verification contracts; it does not add an ingress service or
change the [platform design](../design.md). The
[channel-hosting roadmap](../../specs/22-channel-hosting-roadmap.md) is a
proposal, not supported configuration or release evidence.

## Current surfaces

| Surface                                                                       | Current behavior                                                                                                                            | Boundary                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Native channel configuration](configuration.md#native-channel-configuration) | Kubernetes Compute recognizes enabled `slack` and `msteams` configuration and projects Agent-specific channel credentials into the gateway. | Dedicated execution and a reviewed channel egress proxy are required. Unknown enabled providers and channels in embedded mode fail closed.                    |
| [Manual channel bindings](channel-bindings.md)                                | Authenticated administrators create, read, list, enable, and disable app, human, and exact Namespace/Agent mappings.                        | These are retained configuration records, not verified provider delivery, complete audience approval, or turn admission.                                      |
| [Shared-turn receipt identity](shared-turn-receipts.md)                       | Internal helpers normalize event/logical-message identity and classify supplied history.                                                    | They perform no I/O and provide neither a durable receipt journal nor dispatch authority.                                                                     |
| [Controller reconciliation](controller.md)                                    | PostgreSQL persists platform resources, audit, and Namespace/AgentRevision work.                                                            | Infrastructure reconciliation work is not a channel inbox. Stored runtime-intent/allocation primitives do not themselves wire lifecycle or channel execution. |
| [Upstream consumption probe](upstream-consumption.md)                         | An opt-in source probe checks a pinned headless kernel seam.                                                                                | Verification-only: not a production channel adapter, packaged remote queue, or live collaboration proof.                                                      |

Channel app installations are distinct from the singleton Enterprise Installation.
A provider workspace or tenant ID is not an Enterprise Namespace ID. Binding
scope currently records a Slack private channel or Teams standard channel;
it does not discover or certify that channel's current readers. The internal
resolver returns `candidate-mapped` with `mapping-only` authority after current
IAM checks. A successful mapping is not a revocation lease and cannot authorize
later admission, execution, or a provider operation.

## Direct runtime and credentials

Use the [native configuration contract](configuration.md#native-channel-configuration)
for actual JSON and the
[Kubernetes runtime settings](drivers/kubernetes-compute.md#configuration) for
credential and proxy provisioning. The console edits draft channel settings;
redeployment is required to capture them in an immutable AgentRevision.

Each deployed Agent owns its gateway even when several Agents share one
Namespace. The dedicated Harness receives neither the gateway's channel
credentials nor its private state claim. A Secret named for an Agent does not
reduce the permissions of the provider credential stored inside it. Direct
adapters use the configured provider identity; an HTTPS proxy is not a
conversation-authorizing outbound broker.

Separate independently routed gateways need deliberately assigned provider
identities, memberships, and permissions. Multiple receivers holding one app's
credentials must not be treated as independently authorized channel partitions.
Keep any shared-app routing and credential-broker proposal separate from this
direct deployment contract.

The [security reference](security.md) owns infrastructure and credential
boundaries. Namespace labels, channel allowlists, and separate Agent names do
not by themselves establish hostile-tenant isolation. Cluster and control-plane
administrators, approved gateway plugins, storage, and configured shared services
remain part of the applicable trust boundary. The
[alpha gVisor profile](drivers/gvisor.md) has its own supported scope; it is not
evidence for a different sandbox or identity profile.

## State and custody

Gateway runtime storage and controller PostgreSQL have different owners:

| State                                               | Owner and supported limit                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration, bindings, IAM/audit, controller work | The control plane and its selected state store; gateway workloads do not receive the controller database credential.                                                                                                                      |
| Gateway databases, session state, and media         | The exact Agent's private gateway claim. The [storage contract](drivers/kubernetes-compute.md#storage-and-credentials) retains complete database directories and WAL/SHM siblings for the configured layout, not the entire runtime home. |
| Dedicated workspace                                 | A separate same-Agent shared workspace, with its existing directional mount permissions. It is not the gateway-private database claim.                                                                                                    |

The Kubernetes claim is SQLite-compatible filesystem storage, not a switch that
moves upstream runtime state to PostgreSQL. Actual SQLite/session behavior still
depends on the selected gateway image; a source probe or image recipe is not an
attestation of the deployed image. Additional upstream agent directories or
custom workspace paths need their own persistence inventory.

One replica with `Recreate` and a retained RWO volume does not provide distributed
old-writer fencing. Process replacement with intact storage, node or storage
loss, and restore from a sanitized snapshot are different recovery cases. A
snapshot must not be assumed to retain pending sends or reverse completed
provider/tool effects. See the roadmap's
[maintenance acceptance](../../specs/22-channel-hosting-roadmap.md#maintenance-and-recovery-acceptance)
before making a stronger upgrade or recovery claim.

Likewise, receipt identity, successful local admission, durable turn adoption,
completed execution, and confirmed reply delivery are different outcomes.
Local plugin queues cannot keep receiving while their gateway is unavailable.
There is no current Enterprise commit-before-ACK channel inbox, authenticated
cross-service custody protocol, or shared-app outbound broker. Missing or
ambiguous delivery must not be reported as successful completion.

## Verify and diagnose

Start with the [deployment guide](../guides/deploy.md) and
[testing guide](../testing.md). Identify the actual gateway/plugin image,
dedicated Harness, selected Driver, enabled channel mode, protected credentials,
network path, and persistent volumes before choosing a test.

- Slack has a documented [live integration path](../testing.md#slack). That
  bounded test is not proof of all event classes, two-human shared-context
  authorization, upgrade/rollback, or outage recovery.
- Teams configuration exists, but the public authenticated `/api/messages`
  webhook and end-to-end Teams verification remain outside the native-channel
  milestone. Gateway readiness or a saved Teams draft does not prove that
  Microsoft can reach the webhook or receive a reply.
- Binding API tests verify configuration and selected-IAM behavior. They do
  not verify live sender authenticity, the complete audience, or turn execution.
- For retained state, use the
  [Kubernetes verification limits](drivers/kubernetes-compute.md#verification-evidence)
  and record the exact image and replacement path. Fixture-only checks and
  skipped live cases do not establish real gateway/model outcomes.

When troubleshooting, distinguish configuration/admission failure, gateway
readiness, provider connectivity, pending custody, and unknown external
outcomes. Preserve sensitive payloads and credentials in their authorized
stores; ordinary logs and audit are not a transcript archive. The
[channel delivery flow](../flows/channel-delivery.md) identifies the current
source boundaries, while the
[roadmap](../../specs/22-channel-hosting-roadmap.md) defines proposed delivery
diagnostics, durable intake, and stronger recovery acceptance.
