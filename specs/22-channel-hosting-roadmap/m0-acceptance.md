# Channel hosting: M0 acceptance

Historical proposal sections from the [channel hosting roadmap](../22-channel-hosting-roadmap.md).
The [recorded status and staging context](../22-channel-hosting-roadmap.md) apply.

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
   [wrapper](../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
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

[Return to the roadmap](../22-channel-hosting-roadmap.md).
