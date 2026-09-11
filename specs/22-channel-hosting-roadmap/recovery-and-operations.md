# Channel hosting: recovery and operations

Historical proposal sections from the [channel hosting roadmap](../22-channel-hosting-roadmap.md).
The [recorded status and staging context](../22-channel-hosting-roadmap.md) apply.

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

[Return to the roadmap](../22-channel-hosting-roadmap.md).
