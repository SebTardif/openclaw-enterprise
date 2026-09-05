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

## M0 acceptance

Pin the supported gateway/plugin/Harness versions, image digests, configuration,
channel scope, credential placement, ports, proxy/egress, storage, and required
runtime/identity profile. Retain complete native channel plugins as the first
reuse unit; a source-level headless probe is not a production extraction package.

For each required channel, two independently authorized humans must complete a
bounded useful repository task and follow-up in the same permitted conversation.
Preserve the verified sender, exact Agent and native thread through context,
execution, and replies. Test denied senders/readers, another Agent/Namespace,
duplicate events, concurrent requests, revocation, and a separate thread.
Enforce at most one mutating turn per shared workspace across threads, with
bounded queued/busy outcomes. Sender allowlists alone do not prove that every
reader of shared output is authorized.

Prove continued use after the first collaborator disconnects and after the
supported gateway/Harness restart. Saved provider messages or an intact workspace
alone do not prove restored completed Agent context. Interrupted work must be
visible; uncertain external effects must not be silently replayed. Disable must
block new authority and report actual termination or unknown failure separately
from retention/purge. Measure any selected latency target rather than promising
it from an API response.

Teams requires its actual HTTPS Bot messaging endpoint, Service/route/network
policy, provider authentication, channel readiness, and receive-to-reply proof.
The current native configuration and private gateway route do not complete that
path. Slack's documented live test likewise does not prove the two-human,
shared-context, authorization, or recovery gates by itself.

### Maintenance and recovery acceptance

SQLite remains a valid bounded runtime choice; control-plane PostgreSQL and
embedding/search services do not replace gateway sessions, ingress, leases, or
outbound state. The inspected upstream core has concrete shared and per-agent
SQLite owners, not a general runtime PostgreSQL configuration switch.

For a supported replacement—and for each offered version upgrade/rollback—prove:

1. Pin the old/new image, plugins, configuration, schema compatibility, and
   supported state layout. Rehearse with an inert copy that has neither provider
   ingress nor credentials capable of receiving or emitting real work.
2. Fence new admission/dispatch, drain accepted work within a chosen bound or
   record interruption/unknown effects, and prove shutdown reaches the actual
   gateway child. The current
   [wrapper](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
   forwards the first `SIGTERM` or `SIGINT` to its direct gateway or Codex child and
   schedules a `SIGKILL` fallback after eight seconds. Set and test a compatible
   termination grace and drain bound against that behavior. Signal forwarding,
   one replica, and `Recreate` alone do not prove this protocol.
3. Stop and fence every state writer before maintenance. Verify a matched,
   access-controlled recovery set covering shared and relevant agent databases,
   required configuration and credential references, workspace, and media. The
   current mounted `main` agent directory does not cover arbitrary additional
   upstream agents or a custom workspace automatically.
4. Apply only the pinned supported state transition under sole ownership. Start
   exactly one candidate; prove readiness, retained completed conversation/media
   continuity, and a new completed turn before reopening admission.
5. Rehearse rollback with the old image **and compatible state**, in a fresh
   private target with the candidate fenced. A binary rollback is not a schema
   rollback. Account separately for pending delivery and already completed
   provider/tool effects; restoring state cannot undo those effects.

The pinned upstream
[snapshot sanitizer](https://github.com/openclaw/openclaw/blob/c7dc2c68e246383b046863c0445a27e2ca72b319/src/state/openclaw-state-snapshot-sanitizer.ts)
removes outbound delivery queue entries, leases, and transient expiring blobs.
That supported snapshot is not a lossless pending-send checkpoint. An ordinary
restart retaining an intact PVC is a different path.

Record maintenance RTO separately from backup/host-loss RPO. SQLite WAL with
`synchronous=NORMAL` distinguishes application-crash durability from possible
committed-transaction loss after system/power failure; neither setting nor a PVC
proves survival of volume loss. [SQLite durability](https://www.sqlite.org/pragma.html#pragma_synchronous).
RWO, `Recreate`, and a local runtime lock do not fence a partitioned old writer.
Stronger sync, replication, or failover claims require their own acceptance.

## M1: small independent inbox and custody transfer

Use the existing PostgreSQL service initially, with a **new channel-specific
schema, least-privileged roles, transaction contract, quotas, and retention**.
A receiver and forwarder may share one deployment; replicas and database
durability must match the selected SLO. Kafka, Redis, a new database cluster,
and active-active gateways are not intrinsic requirements.

Keep the acknowledgment path small: authenticate provider delivery, bound and
validate the payload, resolve exact authorized ownership, commit event/logical
identity and custody, then acknowledge. Do not place model/tool execution,
attachment downloads, history expansion, or general plugin startup on this path.

Persist authenticated source/receiving-app facts, bounded payload and digests,
event and logical-message identities, stable Namespace/Agent and conversation,
binding version, and delivery disposition atomically. Reuse existing identity
vocabulary without treating supplied keys or mapping results as authentication.
Unknown, ambiguous, or revoked routes receive restricted rejection/quarantine
handling, never delivery to a fallback Namespace.

The handoff must authenticate the current component and exact destination, bind
the receipt to the original owner, and be idempotent against durable gateway
custody. A timeout is not evidence that custody failed. Retry with the same
identity, reconcile uncertain acknowledgments, and release intake custody only
when destination custody is known. Recheck current permissions, complete audience
and common grants, lifecycle state, conversation/checkpoint, and mutation
authority at their actual admission/dispatch boundaries; a previously observed
binding version is not a revocation lease.

Acceptance includes failures before commit, after commit/before provider ACK,
before and after gateway custody acknowledgment, duplicate/concurrent handoff,
stale workers, gateway replacement, poison payloads, and retention boundaries.
Every accepted record remains accounted for as pending, transferred, rejected,
interrupted, failed, or explicitly unknown. These are proposed diagnostic
categories, not new current API states. Per-conversation admission/handoff
ordering does not promise ordered completion of replies/tools; whole-Agent
mutating-turn serialization remains a separate requirement.

### Adapter reuse limits

The pinned upstream
[Slack relay consumer](https://github.com/openclaw/openclaw/blob/c7dc2c68e246383b046863c0445a27e2ca72b319/extensions/slack/src/monitor/relay-source.ts)
is an authenticated message handoff seam, not parity for slash commands, actions,
or every event class. It still needs an acting provider credential in the
gateway; the inspected provider rejects Enterprise Grid org-wide relay.
Enterprise must supply reviewed relay secret/configuration and WebSocket egress
and test failed-append/no-ACK and duplicate custody behavior. Existing HTTPS
proxy settings alone do not prove relay connectivity or tenant-safe routing.

Teams needs a production authenticated delayed-replay seam. Its
[local replay context](https://github.com/openclaw/openclaw/blob/c7dc2c68e246383b046863c0445a27e2ca72b319/extensions/msteams/src/replay-context.ts)
is useful in-process reuse, not an authenticated network endpoint. Original
Microsoft JWTs expire; Slack signed requests also have freshness checks. Verify
provider input while valid, retain bounded verified facts, then authenticate the
internal receipt/route-bound handoff. Never disable validation or indefinitely
replay old HTTP credentials. [Connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0),
[Slack signature verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

The pinned ordinary message paths already
[journal locally before successful acknowledgment](https://github.com/openclaw/openclaw/blob/c7dc2c68e246383b046863c0445a27e2ca72b319/src/channels/message/ingress-monitor.ts);
they are not merely in-memory callbacks.
[Durable turn adoption](https://github.com/openclaw/openclaw/blob/c7dc2c68e246383b046863c0445a27e2ca72b319/src/channels/message/ingress-drain.ts)
can complete ingress custody and clear the raw payload before the reply finishes.
Recovery after that transfer belongs to turn/outbound state, not blind replay
of the original event. Prove the selected image and event classes end to end;
public SDK interfaces do not establish a ready remote queue implementation.

## M2: exact conversation ownership and outbound authority

Extend the existing manual inventory with a reviewed setup and routing contract,
not a second competing architecture or invented current API syntax:

- Verify the receiving provider app and installation; keep the Enterprise
  Installation, provider tenant/workspace, app, conversation, and native thread
  identities distinct. An administrator-supplied channel ID is not proof of
  authority to claim it. Manual approved onboarding is sufficient initially.
- Bind each supported conversation/event scope to exactly one stable Namespace
  and Agent plus current participant/audience policy. Resolve the ready runtime
  server-side, never from an arbitrary inbound URL or caller-selected tenant.
  DMs, group chats, and external/shared channels need explicit profiles; do not
  infer ownership from a missing team ID or default route.
- Persist the original queued owner and route version immutably. Rebinding must
  not move old tenant data to a new tenant. Pause, drain, archive, or explicitly
  reapprove under a reviewed transition; deny stale dispatch. A revision change
  within the same Agent needs an explicit checkpoint/cutover policy, not implicit
  retargeting of accepted work.
- Select and authorize the destination **before content crosses its boundary**.
  Broadcasting into all gateways and filtering later is insufficient: native
  ingress can persist payloads before later local channel/sender policy.
- Retain broad shared-app credentials only in the trusted broker. Authenticate
  each current gateway/component independently and authorize each send, edit,
  delete, reaction, attachment, history read, and proactive operation against
  the installation, exact conversation/thread, and allowed action. Implement
  only reviewed operations and deny unsupported ones. Ingress-only routing does
  not narrow credentials copied into gateways.

Acceptance includes wrong-tenant delivery and persistence denial, ambiguous
ownership, stale route/runtime generation, revoked grants, forged destination,
cross-conversation history/attachment access, and outbound-result ambiguity.
Workload authentication establishes caller identity, not conversation authority.
Shared intake, database, broker, administrators, and backups retain explicit
trust; this is not a universal strong-isolation certification.

## Optional bounded history reconciliation

History can reconstruct available message state, not every original event,
transient interaction, intermediate edit/delete, or lost event order:

| Provider surface              | Boundary to preserve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack HTTP Events API         | Initial retries and opt-in Delayed Events are bounded settings. Do not treat the documented delayed retry window as an arbitrary-offline Socket Mode replay guarantee. [Events API](https://docs.slack.dev/apis/events-api/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Slack history/replies         | Permission-, retention-, pagination-, and installation-category-limited reads. Track replies under old roots; do not assume broad user tokens or universal rate/page limits. [History](https://docs.slack.dev/reference/methods/conversations.history/), [replies](https://docs.slack.dev/reference/methods/conversations.replies/), [rate-limit clarification](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).                                                                                                                                                                                                                                                                                                                                                                    |
| Teams Bot activity            | Slow handling can cause retries/duplicates, but the inspected Bot contract does not establish a complete missed-activity replay API. [Bot handlers](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/bot-concepts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Graph notifications and reads | Separate notification retries and renewal/drop behavior; reads return current message state. Channel roots and replies need complete pagination. The documented user-chat-wide delta API is not a per-channel/RSC delta switch, and Teams recovery must not rely on Outlook-only `missed` notifications. [Graph delivery](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks), [message semantics](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage), [channel listing](https://learn.microsoft.com/en-us/graph/api/channel-list-messages?view=graph-rest-1.0), [chat delta](https://learn.microsoft.com/en-us/graph/api/chatmessage-delta?view=graph-rest-1.0), [lifecycle support](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events). |

Persist **scan-complete-through** coverage per installation/conversation and
separate pagination progress. Scan overlapping fixed windows, completely paginate
within rate budgets, and reconcile tracked old threads separately. A newest live
timestamp or partial scan must not advance complete coverage. Report untracked
threads, expired cursors, missing permissions, unsupported events, and incomplete
intervals explicitly.

Share logical-message/version deduplication with live intake, retaining a
`history-reconcile` origin rather than inventing provider event IDs or mentions.
Match dedupe retention to the entire retry/reconciliation horizon; the existing
bounded upstream guards are not unlimited ledgers. Historical discoveries
default to context or operator-reviewed pending work, not automatic execution
of old commands. Recheck current ownership, permission, activation, and age policy.

Outbound recovery is separate. A timeout may follow a successful send. Known
text-marker reconciliation is not universal media/tool idempotency: absence,
partial evidence, or an unreadable history scan must preserve an unknown outcome,
not trigger blind replay. Graph subscriptions and broader history permissions
are optional extensions, not hidden M0 dependencies.

## Diagnostics, quotas, and channel profiles

For M0, expose bounded configuration/launch failures, runtime unreachability,
queued/busy/interrupted work, and known delivery uncertainty. For M1/M2, add
append/ACK errors, oldest pending age, retry/dead-letter counts, custody-transfer
state, incomplete reconciliation intervals, authorization failures, and unknown
sends. Distinguish intake acceptance, gateway custody, adopted turn, completed
execution, and confirmed reply. Health/readiness alone is not delivery status.

Choose per-tenant and service-wide limits for event bytes, pending count/bytes,
age, retries, concurrency, and retention before claiming durable intake. Test
backpressure and storage exhaustion so one tenant cannot fill the common store.
Retention must cover dedupe and supported retry/recovery windows while bounding
raw payload, dead-letter, and backup exposure; pruning must not silently create
a fresh command. Authorize status/history disclosure and keep credentials and
message content out of ordinary audit/logging.

Each channel/mode needs a reviewed capability profile: maintained plugin and
license/redistribution basis; exact host/plugin tuple; accounts and credential
modes; stable installation/sender/conversation/event identities; supported text,
threads, media, edits, commands, interactions, and proactive operations; secrets,
ports, egress, state, ACK/custody semantics, retention, and known gaps. Verify
genuine receive/ACK/reply, duplicates, restart, revocation, and wrong-Namespace
denial for each claimed mode. Upstream plugin availability does not extend the
current Enterprise Slack/Teams allowlist automatically.

Read-only data sources and MCP search tools are a different category from
bidirectional chat channels. They still require source-ACL, revocation/deletion,
indexing, and cursor contracts; do not force them into a chat-event abstraction
or replicate all accessible data to every Agent.

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
