# Channel hosting: durable intake and authority

Historical proposal sections from the [channel hosting roadmap](../22-channel-hosting-roadmap.md).
The [recorded status and staging context](../22-channel-hosting-roadmap.md) apply.

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

[Return to the roadmap](../22-channel-hosting-roadmap.md).
