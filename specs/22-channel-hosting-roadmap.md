# Channel hosting: direct gateways to durable intake

Status: **Proposed**. This is a staged implementation proposal, not a release
claim or a new architecture authority. It follows the
[platform design](../docs/design.md), including one gateway per deployed Agent,
exact Namespace ownership, selected Drivers, and independent provider
authorization. The [current channel reference](../docs/reference/channels.md)
and [source flow](../docs/flows/channel-delivery.md) describe what exists now.

The intended sequence is a bounded direct-channel baseline, independently
durable intake while retaining separate apps, shared-app routing with outbound
authorization, and optional stronger availability. **Intake availability is
not execution availability:** a receiver may accept work during a gateway
upgrade while replies wait.

None of these stages implies universal zero loss, exactly-once tools/sends,
zero-downtime execution, or isolation from every trusted operator. Each stronger
claim needs evidence for its selected failure and authority boundaries.

## Relationship to the shared-Agent release

These channel stages do not redefine the accepted Walk scope: two authorized
collaborators use one persistent Agent natively in Slack and independently in
Teams, continue with saved completed context and workspace after a participant
disconnects and a supported runtime restart, and receive attributable results
with bounded overlap handling and safe operator disable/stop behavior.
Separate threads may have separate conversation context while sharing the
same authorized Agent workspace; cross-platform transcript synchronization is
not required.

Product task databases, planning boards, and autonomous scheduling remain
outside this channel roadmap; ordinary reconciliation and turn ordering do not
require them.

| Staging choice                                            | Scope that remains required                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack text-first validation                               | A test sequence, not a Slack-only Walk release. Teams application setup, authenticated public webhook, retry handling, sender/audience authorization, and the same two-person scenario remain release gates.                                                                                                                                    |
| Full gateways with direct per-gateway channel credentials | The selected reference release still requires Kubernetes, OpenShell, Kata, and SPIFFE/SPIRE, including actual runtime/identity enforcement. Channel tokens stay outside the dedicated execution boundary. This does not certify the current direct model-credential path against the selected release's credential requirements.                |
| M0 maintenance acceptance                                 | Supported restart, completed-context/workspace retention, interruption visibility, and safe single-writer replacement are baseline obligations. Cross-version upgrade/rollback tests gate any such offered support; automatic rollback, portable snapshots, and host-loss recovery are not silently made prerequisites of every Walk component. |
| M3 stronger availability                                  | Optional failure-domain/RTO improvements, not permission to postpone the selected release's required containment or identity. Existing alpha gVisor and other reviewed Drivers retain their separately documented scope.                                                                                                                        |
| M1/M2 services and optional reconciliation                | Separate proposed increments. Do not block unrelated baseline work on a shared app, generic connector framework, Graph subscriptions, active-active gateways, or a runtime PostgreSQL port.                                                                                                                                                     |

This selected release profile does not replace platform-wide Driver flexibility.
Current [SandboxDriver](../docs/reference/drivers/sandbox.md),
[OpenShell](../docs/reference/drivers/openshell-sandbox.md),
[gVisor](../docs/reference/drivers/gvisor.md), and
[security](../docs/reference/security.md) limits still apply. Model mediation,
workload identity, and [repository access](20-repository-access-modes.md) have
separate contracts; a channel broker cannot stand in for them. Required native
Git/gh access and optional stronger repository modes are not redesigned here.
Any narrower release claim requires an explicit scope decision rather than
treating this roadmap as evidence that missing requirements passed.

## Stages and exit gates

| Stage                              | Smallest increment                                                                                                                                                                               | Claim only after its acceptance passes                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0: direct hosted channels         | Complete Agent-owned gateways; private runtime state; distinct provider identities for independently routed gateways; supported text/threads, networking, diagnostics, and maintenance behavior. | The selected conversations work on the tested tuple and retain completed context/workspace through the supported replacement. Gateway downtime can interrupt intake; unreceived events and storage loss remain explicit gaps. |
| M1: independent durable intake     | One small receiver/forwarder deployment and a channel-specific inbox in the existing PostgreSQL service. Keep separate provider apps.                                                            | Commit-before-ACK custody remains accounted for through authenticated gateway handoff while that gateway is down, within measured load, durability, quota, and retention bounds. Replies can be delayed.                      |
| M2: shared app and outbound broker | Extend intake with exact conversation ownership and mediated provider operations; retain shared credentials only in the trusted service.                                                         | One app can serve several Namespaces without copying its broad credential into their gateways or broadcasting content across them. The broker remains a trusted cross-Namespace service.                                      |
| M3: stronger availability          | Fenced active-passive recovery and a selected replicated/durable storage and restore design.                                                                                                     | Measured execution recovery and protection against specifically tested failure domains. Active-active writers and a runtime database redesign remain separate decisions.                                                      |

M0 can use one channel-owning Agent per team, or a distinct provider identity
per independently routed gateway. One app per Namespace is insufficient if
multiple Agent gateways compete for its events. App names, multiple secrets
for one application, and local channel filters do not establish separate
provider authority. Slack's multi-connection contract does not partition
events by department; Teams endpoint routing does not narrow bot credentials.
See [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
and [Teams application credentials](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/app-authentication/client-secret).

## Current starting point

Reuse [native channel configuration](../docs/reference/configuration.md#native-channel-configuration),
the [private gateway storage contract](../docs/reference/drivers/kubernetes-compute.md#storage-and-credentials),
and the implemented [manual binding APIs](../docs/reference/channel-bindings.md).
Do not introduce a second installation/binding inventory merely because an
earlier proposal treated all mapping as future work.

Existing installation, human, and Agent records have retained unique ownership,
immutable identity/target fields, versioned status, selected-IAM checks, and
transactional audit. Their resolver is explicitly mapping-only. M1/M2 still
need verified receiving-installation facts, complete audience policy,
conversation/checkpoint custody, immutable queued targets, authenticated
dispatch, and operation-level outbound authority. Proposed additions are not
fields accepted by today's binding API, and the architecture's target `Channel`
and `ChannelDriver` are not interchangeable with these manual records.

Likewise, [receipt normalization](../docs/reference/shared-turn-receipts.md) is
identity/classification, not storage. The existing PostgreSQL controller queue
owns infrastructure reconciliation, not provider events. Runtime-intent and
allocation storage is a useful foundation, not evidence that production
lifecycle, channel admission, or workload-identity callers are connected.

Upstream source observations below refer to
[`c7dc2c68e246383b046863c0445a27e2ca72b319`](https://github.com/openclaw/openclaw/tree/c7dc2c68e246383b046863c0445a27e2ca72b319).
They are not deployed-image assertions. The
[headless probe](../docs/reference/upstream-consumption.md) pins a different
source revision and is verification-only; the
[runtime image recipe](../deploy/runtime/README.md) is a third, configurable
surface. Acceptance must record the actual image/plugin tuple.

## Roadmap chapters

The original proposal sections continue in these chapters:

- [M0 acceptance and maintenance](22-channel-hosting-roadmap/m0-acceptance.md).
- [M1 durable intake and M2 conversation authority](22-channel-hosting-roadmap/durable-intake-and-authority.md).
- [Optional history reconciliation, diagnostics, and channel profiles](22-channel-hosting-roadmap/recovery-and-operations.md).

## Delivery and documentation gate

Implementation must update the owning [channel reference](../docs/reference/channels.md),
[bindings](../docs/reference/channel-bindings.md),
[configuration](../docs/reference/configuration.md),
[security](../docs/reference/security.md), applicable Driver reference,
[deployment/testing guidance](../docs/README.md#start-and-deploy), and
[source flow](../docs/flows/channel-delivery.md) together. Record actual source
and image identities, selected profiles, tests and pass/fail/skip counts, measured
limits, and unresolved gaps before changing a proposal status or public claim.
Documentation integration does not complete these implementation gates.
