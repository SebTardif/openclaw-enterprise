# Manual channel bindings

Channel bindings associate a Slack or Microsoft Teams app installation with existing
Enterprise humans and exact Namespace/Agent targets. The controller exposes the same
administration service in development and production, backed by its configured
platform state store. PostgreSQL retains records across controller restarts; the
in-memory adapter is suitable for development and conformance testing.

These records are manual configuration. Registering a channel does not connect a
bot, verify a sender or channel audience, admit a turn, or start an Agent. The
controller has no public receipt-resolution or channel-ingress endpoint for this
feature. See the [API reference](api.md) for generated request and response schemas.

For direct native runtime behavior, see [Channels and delivery](channels.md)
and the [source flow](../flows/channel-delivery.md). The
[channel-hosting roadmap](../../specs/22-channel-hosting-roadmap.md) builds on
these existing records; its durable inbox, conversation custody, and shared-app
broker are proposals, not extra fields or authority in this API.

## Authority and prerequisites

Every create, read, list, and status operation requires the selected IAM driver's
`administer` permission on the server-owned singleton Installation. The eight
operations on channel installations and human bindings additionally require an
authenticated human session and a current explicit Installation-administrator
mapping on a granting AccessBinding. An admitted service principal cannot perform
those operations. See [Channel administration](channel-administration.md) for the
mapping, request custody, and currentness boundaries. The four Agent-binding
operations retain their existing human or Installation-scoped service admission;
Namespace-scoped keys and Agent-owned service principals cannot administer them.
Cookie-authenticated mutations use the controller's same-origin protection;
invalid supplied service keys do not fall back to a session cookie.

An administrator also needs current `read` and `operate` on the exact Agent when
creating or enabling a channel-to-Agent binding. The Namespace must be ready and
own that Agent. Disabling an existing binding requires Installation administration
and remains available when the original human or Agent is unavailable.

The humans must already exist in the selected IAM provider. Supply their exact
issuer and subject; the server resolves and stores the Principal ID and selected
IAM driver ID. Email aliases, display names, service principals, and caller-supplied
Principal IDs cannot substitute for that lookup.

Agent permissions must also be provisioned through the selected IAM provider's
existing setup. Creating an account or granting Installation access does not grant
Agent access. This API does not create Roles, AccessBindings, restrictions, or other
IAM grants. Custom IAM providers remain responsible for their own provisioning.

## Register an app, humans, and a channel

Use the normal authenticated API client and configured controller origin. Each
successful create returns HTTP 201 with `{ "data": record, "meta": { "requestId":
"..." } }`. Record IDs, Installation ID, timestamps, attribution, enabled status,
and initial version 1 are server-generated.

First send `POST /api/channel-installations`:

```json
{
  "platform": "slack",
  "providerTenantRef": "tenant-example",
  "recipientAppRef": "app-example"
}
```

Use its returned `chi_...` ID as `channelInstallationId`. For each already
provisioned collaborator, send
`POST /api/channel-installations/:channelInstallationId/human-bindings`:

```json
{
  "providerSubjectRef": "external-human-a",
  "principal": {
    "issuer": "https://identity.example.test",
    "subject": "human-a"
  }
}
```

A second collaborator uses their own external subject and independently resolved
issuer/subject. An administrator's Agent permissions do not become either human's
permissions.

Then send `POST /api/channel-installations/:channelInstallationId/agent-bindings`
with an existing Namespace and Agent:

```json
{
  "channelRef": "channel-example",
  "scopeKind": "slack-private-channel",
  "namespaceId": "ns_11111111-1111-4111-8111-111111111111",
  "agentId": "agt_22222222-2222-4222-8222-222222222222"
}
```

The supported combinations are `slack` with `slack-private-channel`, and `msteams`
with `msteams-standard-channel`. Scope kind records the operator's intended scope;
it does not prove live visibility or current membership. The APIs reject tokens,
callback URLs, event payloads, `verified`, audience approval, and other extra fields.

Provider tenant, app, subject, and channel references preserve exact case and
Unicode. Each must contain 1–1024 UTF-8 bytes without control characters or malformed
Unicode. Provider tenant IDs are separate from Enterprise Namespace IDs.

## Read, disable, and recover

All three resource collections support GET collection and GET item operations.
Nested item routes use `:bindingId` beneath their owning app:

| Collection                                                         | Item suffix               |
| ------------------------------------------------------------------ | ------------------------- |
| `/api/channel-installations`                                       | `/:channelInstallationId` |
| `/api/channel-installations/:channelInstallationId/human-bindings` | `/:bindingId`             |
| `/api/channel-installations/:channelInstallationId/agent-bindings` | `/:bindingId`             |

Lists return `data.items` in ascending record-ID order, including disabled records.
The default and maximum `limit` is 100. If `data.nextCursor` is present, supply it as
`cursor` with the same collection, parent, and limit. A cursor is a continuation
position, not a snapshot; concurrent creates may appear on subsequent pages.

PATCH an item with only its current version and desired status:

```json
{ "expectedVersion": 1, "status": "disabled" }
```

A real status change increments the version exactly once and records the admitted
actor. A same-state request at the exact current version returns the existing
record without another mutation audit. A stale version conflicts. Re-enabling a
human re-resolves the original identity through the same selected IAM authority;
re-enabling a route rechecks its original target and administrator permissions.

Disabling an app prevents new or re-enabled child bindings and makes candidate
resolution fail even if its existing children still say enabled. Disabled app,
human, and route records remain readable by administrators. Their original unique
keys stay reserved. Hard deletion, identity replacement, subject reassignment,
Agent retargeting, and app reinstallation aliases are unsupported.

Successful mutations and their audit events commit together. The audit identifies
the admitted actor, record, status/version change, validated authorization evidence,
and exact Agent target where relevant. It omits request bodies and credentials.
If a transaction's commit acknowledgement is lost, its outcome remains unknown:
use authenticated scoped reads/listing and audit readback to reconcile it before
attempting another create. Do not assume a failed acknowledgement rolled back.

| HTTP status | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| 400         | Malformed/extra fields, unsupported scope, invalid cursor, or invalid human target                |
| 401         | Missing or invalid credential                                                                     |
| 403         | Current selected-IAM permission or credential/origin boundary denied                              |
| 404         | Missing record or wrong parent/Namespace/Agent ownership after caller authorization               |
| 409         | Retained duplicate, stale version, or child mutation under a disabled parent                      |
| 503         | Required IAM, state, or audit dependency unavailable; a commit outcome may require reconciliation |

## Internal candidate mapping

The internal resolver consumes the existing normalized receipt identity and matches
its exact Installation, app, platform, provider tenant, recipient app, sender, and
channel against persisted records. It preserves the native root thread, event key,
and logical-message key. Parsing that identity does not authenticate its sender.

The resolver checks enabled records, current Namespace/Agent ownership, the
original human identity, and that human's current exact Agent `read` and `operate`.
It rereads binding versions after asynchronous IAM calls and rejects observed
changes. A successful result is tagged `candidate-mapped`, with `mapping-only`
authority and the observed IDs/versions. It has no persistence or dispatch effects.

The result explicitly lacks verified delivery, shared workspace/repository grants,
complete current channel-reader evidence, conversation/checkpoint state, durable
admission, runtime authority, and the Agent mutation fence. It is not a revocation
lease. Future admission and delivery must establish those requirements independently
and reread current permissions. A manual sender list never proves the full audience.

## Verification

The memory and PostgreSQL channel repositories borrow the platform transaction's
working snapshot or guarded database client. Their factories resolve the current
Installation when operations run, so bootstrap and channel writes share one unit
of work. The platform owner serializes channel mutations, drains admitted operations
before commit, and closes escaped repository methods after completion.

Run the focused conformance and API tests with the repository's supported toolchain:

```sh
node --test tests/conformance/channel-binding-memory.test.mjs tests/conformance/channel-repository-memory.test.mjs tests/conformance/channel-principal-resolution.test.mjs tests/integration/channel-bindings-api.test.mjs
node --test --test-concurrency=1 tests/integration/postgres-channel-bindings.test.mjs tests/integration/postgres-channel-repository.test.mjs
```

The PostgreSQL suite requires `OCC_TEST_DATABASE_URL` for an isolated, initialized
test database. The repository bootstrap case additionally uses
`OCC_PRODUCTION_WIREUP_DATABASE_URL` for a separately migrated empty disposable
database and rolls its changes back. Missing selectors skip their associated
cases. Without the main database selector, persistence,
concurrency, privileges, and restart behavior have not been verified. Tests exercise
real adapters and the selected IAM boundary; they do not verify live Slack/Teams
transport or audience membership.
