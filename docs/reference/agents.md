# Agents

An Agent is a named, persistent resource representing one AI workload inside a
[Namespace](namespaces.md). Each Agent has its own identity and revision
history. Agents in the same Namespace remain separate, and Agents never cross
Namespace boundaries.

```text
Namespace: support
├── Agent: ticket-triage
│   ├── Service principal: unique to ticket-triage
│   └── Gateway: unique to deployed ticket-triage
└── Agent: customer-help
    ├── Service principal: unique to customer-help
    └── Gateway: unique to deployed customer-help
```

Creating an Agent records its platform resource, exact Namespace-owned
Configuration reference, and identity. It does not start a workload, deploy a
model, or create a revision until an authorized caller explicitly requests
deployment.

Agent persistence does not impose a lifetime on each task. The
[execution duration setting](#execution-duration-selection) supports
`maximumExecutionMs` with an uncapped default and immutable revision selection.
The [selected journal component](turn-journal.md#selected-native-execution-retention)
retains mandatory stop responsibility for both finite and uncapped attempts.
Production dispatch/native composition and complete task/Agent stop controls
remain follow-up work; the
[implementation record](../../specs/24-configurable-execution-limits.md) records
these boundaries and the outstanding runtime qualification.

## Supported operations

Agent operations are scoped beneath `/namespaces/:namespaceId/agents`. Creation
returns `201`, reads and updates return `200`, and deployment returns `202`
with an accepted operation receipt. Revision documents have separate read
operations. Collection reads include only Agents
for which the caller has an exact `read` grant. The [API reference](api.md)
owns route schemas, response envelopes, and permission annotations.

A representative creation body is:

```json
{
  "name": "ticket-triage",
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "executionMode": "dedicated",
  "providerId": null
}
```

Creation requires an existing Namespace in `provisioning` or `ready` status
and a same-Namespace Configuration with `kind: "agent"`. The caller needs
Agent `create` permission in that Namespace and `read` permission on the
exact Configuration. An optional associated service account requires its own
exact `read` permission. [Authentication](authentication.md) establishes the
caller; [authorization](authorization.md) defines its grants.

## Provider association

An Agent can reference one Installation-configured [Provider](providers.md)
through `providerId`. Create omission means `null`; PATCH omission preserves the
saved value, while explicit `null` clears the draft reference. A nonnull ID must
resolve to a configured Provider. No default is inferred. The nullable reference
is returned on both Agent and AgentRevision responses.

The Provider reference is independent of native model names and Harness
selection. Providerless Agents remain supported with native API-key or
independently supplied model credentials. A managed access token requires the
matching Provider and private account binding at admission and reconciliation;
see [Provider deployment checks](providers.md#agent-association-and-immutable-deployment).
Creating an Agent does not create a provider account or issue credentials.

## Workspace files

Read, create, or replace `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`
in an Agent's live workspace:

```text
/namespaces/:namespaceId/agents/:agentId/workspace/files/:name
```

| Method | Operation                  | Agent permission | Response `data`     |
| ------ | -------------------------- | ---------------- | ------------------- |
| `GET`  | Read the file              | `read`           | `{ name, content }` |
| `PUT`  | Create or replace the file | `operate`        | `{ name, size }`    |

Authenticate with a session or scoped service API key. Session-authenticated
writes must pass the [CSRF checks](authentication.md). The Agent must have an
active revision and a reachable gateway.

`PUT` accepts one `content` field:

```json
{ "content": "You are a support assistant.\n" }
```

`content` must be well-formed Unicode without NUL characters and fit within
16 KiB when encoded as UTF-8. The complete request body is limited to 48 KiB.
Successful requests return `200`; `size` is the written content's UTF-8 byte
count. Successful writes record the Agent, file name, and outcome in the audit log.

| Error                        | Meaning                                              |
| ---------------------------- | ---------------------------------------------------- |
| `400 INVALID_REQUEST`        | Invalid file name or content.                        |
| `404 NOT_FOUND`              | The requested Agent or file was not found.           |
| `413 PAYLOAD_TOO_LARGE`      | The request body exceeds 48 KiB.                     |
| `503 DEPENDENCY_UNAVAILABLE` | Workspace access is unavailable.                     |
| `503 UNKNOWN_OUTCOME`        | OCC could not confirm the write or its audit record. |

After `UNKNOWN_OUTCOME`, read the current file before deciding whether to submit
another write.

See [gateway routing](gateway-routing.md) for transport configuration and
[workspace-file setup](../guides/deploy.md#agent-workspace-files) to enable
access, the [HTTP API](api.md#get-namespacesnamespaceidagentsagentidworkspacefilesname)
for request and response schemas, and the [execution flow](../flows/workspace-files.md)
for implementation details.

## Namespace ownership

An Agent belongs to the Namespace in its creation URL. The controller assigns
that ownership; request bodies cannot select a different Namespace or
Installation.

Names are unique within one Namespace. Two different Namespaces can each own an
Agent with the same name, but neither can read or operate the other's Agent
without its own scoped permissions.

You can create an Agent while its Namespace is still `provisioning`. A failed
or deleting Namespace rejects new Agents.

## Agent service principal and workload credentials

Every Agent owns exactly one stable, platform-owned service principal.
Separate Agents receive separate service principals, even when they share a
Namespace. The service principal is immutable, belongs to its exact Agent and
Namespace, and remains the same across every revision of that Agent.

An Agent service principal does not inherit your permissions, session cookie,
provider credentials, or another Agent's identity. It has the same
role-granted capabilities as a human Principal: an appropriately scoped Role
and AccessBinding can grant any platform action, including administrative
actions and access to another Agent in the same Namespace. Its Namespace scope,
exact resource grants, and matching Restrictions still apply. The public Agent
response intentionally does not expose its internal `servicePrincipalId`.

Workload identity is execution credential evidence, not a third platform
principal. For a `dedicated` Agent, the
[Kubernetes Compute Driver](drivers/kubernetes-compute.md) uses separate
gateway and Codex ServiceAccounts. Only Codex receives the short-lived,
audience-scoped projected token for its exact Agent's existing
`servicePrincipalId`; production requires this projection. An `embedded`
gateway necessarily shares its exact Agent's projected workload identity and
Agent-specific model credential because that same process runs the built-in
Harness. Both modes are supported in production. OCC token verification,
identity exchange, and ServicePrincipal
authentication through the controller API remain deferred.

An Agent may also reference one same-Namespace, OCC-owned
[service account](service-accounts.md) through `serviceAccountId`; updating
the field to `null` detaches it. This optional credential reference does not
replace its ServicePrincipal or Kubernetes ServiceAccount.

## Execution mode

Each Agent explicitly records how its selected Harness runs:

- `embedded` starts one OpenClaw gateway with its built-in Harness. It is the
  default when creation omits `executionMode` and is supported in development
  and production; the combined workload receives its own Agent identity and
  model key.
- `dedicated` starts an Agent-owned gateway and a separate Codex app-server.
  Production uses separate workload identities, authenticated gateway-to-Codex
  transport, and either an operator-owned model API key or an associated
  account's directly projected access token mounted only into Codex.

The Agent's native Configuration selects a Harness through model/provider
`agentRuntime.id` policy. The [Harness execution reference](harness-execution.md)
owns supported runtime selections, model catalogs, transport, and credential
boundaries. OCC rejects conflicting, unknown, or mode-incompatible selections
before admitting a revision. A selected SandboxDriver currently requires
`dedicated` Codex execution; it does not support embedded OpenClaw.

An Agent update may include `executionMode`, `serviceAccountId`, and `providerId`
alongside its required `configurationId`. Omission preserves the current value;
`serviceAccountId: null` detaches the account and `providerId: null` clears the
Provider. Existing revisions retain their immutable placement, account, and
Provider association.
See the
[Harness execution topology flow](../flows/harness-execution-topology.md) for
runtime selection, identity boundaries, and activation.

## Execution duration selection

`maximumExecutionMs` selects an Agent's execution duration cap in milliseconds.
Create omission defaults to `null` (uncapped). PATCH omission preserves the saved
value; explicit `null` clears a finite cap. A finite value must be a positive
safe integer, from `1` through `9007199254740991`. There is no fifteen-minute
configuration ceiling. For example, a two-hour selection is:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000",
  "maximumExecutionMs": 7200000
}
```

Agent reads always return this field. Deployment copies the saved value into
its immutable revision; a subsequent draft edit affects future deployments.
The retained deployment command's `expectedDraft.maximumExecutionMs` must match
the saved selection exactly, including `null`, so a changed cap conflicts with a
stale command. Configuration selection alone grants no execution authority.

Historical immutable revisions can omit `maximumExecutionMs`. Absence means the
revision has no recorded execution policy and cannot supply a new executable
selection; it does not mean uncapped. Every newly admitted revision explicitly
records either `null` or a finite value. Existing attempt policies remain
unchanged. The [selected journal](turn-journal.md#selected-native-execution-retention)
requires the actual consumption authority's explicit selection and, for a finite
cap, a safe-integer sum of its original anchor and configured duration. The
[hosted native owner](hosted-native-execution.md) still requires matching SDK/native
codecs and production composition to bind that authority to this revision
snapshot. Credential lifetimes remain separate from this persisted configuration
contract.

## Editable configuration

An Agent's `configurationId` selects exactly one native OpenClaw Configuration
document with `kind: "agent"` in its own Namespace. A PATCH requires
`configurationId`, exact-Agent `update`, and exact-Configuration `read`.
For example, the body below replaces the reference and preserves the current
execution mode, service account, and Provider:

```json
{
  "configurationId": "cfg_123e4567-e89b-42d3-a456-426614174000"
}
```

The request returns `200` with the updated Agent. Update the Configuration's
native nested document through its own exact-resource PATCH endpoint; see
[Configuration CRUD](configuration.md#create-read-update-and-delete). Changing
the Agent reference or Configuration values does not queue Compute work,
change the active revision, or mutate earlier revisions. Agent create and update
accept a Configuration reference, optional execution mode, and optional service
account and Provider associations; they do not accept an inline configuration
document or competing gateway settings. Multiple Agents can
share the same Configuration;
each deployed Agent still owns its own gateway and stable service principal.

## Revisions and deployment

An AgentRevision is the immutable admitted configuration for one deployment
of its owning Agent. An Agent owns an ordered revision history and at most one
active revision, identified by `activeRevisionId`. Deployment does not overwrite
an earlier revision or make the new revision active immediately.

The revision records the source `configurationId`, `configurationKind`, and
`configurationGeneration`, its complete admitted native `configuration`
document, the approved Harness identity/version/mode, selected Compute identity,
nullable `providerId`, and any associated service account's opaque credential
reference. The account association contains no credential bytes. Native Configuration values must use
unresolved inline SecretRefs because the admitted document is persisted and
returned through the API; see [secret boundaries](configuration.md#secret-boundaries).
Nested objects and arrays are immutable.

When a SandboxDriver is selected, its `configureAgent` hook can transform a
copy of the source document before admission and snapshotting; it does not
update the reusable Configuration or its generation. The admitted revision
therefore records the source generation and the effective document after that
transformation. Its SandboxDriver selection and the Agent's stable service
principal are retained internally and are not exposed by the current HTTP
revision schema. See [SandboxDriver](drivers/sandbox.md).

An authorized `POST /namespaces/:namespaceId/agents/:agentId/deploy` requires an
[identified V2 command](lifecycle-deploy-v2.md#command-identity). Its body retains
the original `operationRef`, explicit `expectedLifecycleGeneration` and exact
saved-draft expectations, including `expectedDraft.maximumExecutionMs`. Bodyless
requests reject. Admission requires a `ready` Namespace, exact-Agent `deploy`,
exact Configuration `read`, and exact associated-account `read` when present,
along with the original enrolled admission and workload-profile capabilities.

A successful `202` returns the accepted operation receipt, not the revision
document. The immutable revision, running runtime intent, original reconciliation
work and attributable success audit commit together; acceptance does not mean
the workload is ready. Later Configuration edits or changes to an account's
selected credential reference affect only future deployments. A snapshot freezes
a Secret reference, not the value stored at that reference.

For a new command, `expectedLifecycleGeneration: null` requires no intent head;
a positive safe integer requires that exact current generation. The saved draft
and lifecycle comparison run under the existing locks before admission. A
mismatch leaves no new revision, intent, success audit or work. A stopped or
disabled intent conflicts: deploy does not implicitly resume it.

An exact retry retains the same command identity and original attribution. After
current authorization over the original operands, it returns the original
accepted association without rebuilding today's draft or admitting another
revision. Unknown outcomes require exact readback; they do not authorize a new
operation identity or another provider submission. The
[deployment command reference](lifecycle-deploy-v2.md) owns this protocol and its
remaining composition requirements.

An admitted intent alone grants no runtime authority. Namespace locking also
serializes deployments to different Agents in the same Namespace. Admission
currently reads the full revision history to allocate the next revision number;
history reads are unpaginated and their cost grows with retained history.

The internal `controller.deployment.getAcceptedDeployOperation` reader accepts
an exact Namespace, Agent, and retained operation locator. It checks the
current selected IAM Driver's `read` permission on that Agent before reading
and again before returning. A reader does not need the original deployer's
grants or permission to read revision contents. The result contains only
`operationRef`, `kind`, `revisionSource`, `lifecycleGeneration`, `desiredMode`,
`acceptedAt`, and `requestedRevisionId`; it includes no revision document,
actor, request, audit, work, credential, or runtime details.

This reader recognizes the original deploy-admission format by verifying its
exact retained revision, intent, deploy audit, and original reconciliation
work together. Its fixed `deploy` and `saved-draft` values describe that
format; an arbitrary running intent does not establish a deploy operation.
`acceptedAt` is the stored intent creation time, not a measured database commit
time. Later draft changes, head advancement, or terminal work leave the
original acceptance readable. Reads use a fresh storage snapshot and reject
calls inside an active mutation. Missing proof does not establish that an
in-flight transaction rolled back or permit an automatic retry.

This compatible reader does not expose an HTTP lifecycle route or report
runtime observations, convergence, or current execution authority. Its IAM
checks retain the existing read policy; they do not supply the account and
semantic currentness protocol required for live lifecycle control.

The worker checks each revision's retained original intent association before
its first Compute call. Later head advancement preserves the older association
and the existing supersession and active-maintenance behavior. Historical
revisions admitted before these associations existed retain their prior
reconciliation behavior; an active pointer or healthy workload does not create
an association. These records do not attest runtime identity or provide provider
allocation, effect fencing, or stop/disable execution.

The separate PostgreSQL controller worker prepares the exact Agent gateway and
revision, activates its route, retires its predecessor, and sets
`activeRevisionId`. Each Agent owns its gateway; sibling Agents never share
one. The default PostgreSQL-backed development Compute Driver starts Docker
runtime containers for embedded OpenClaw or dedicated Codex topologies. Selected
Kubernetes Compute starts either an Agent-owned gateway plus a dedicated
Codex workload with its separate ServiceAccount, or one embedded combined
gateway/Harness. Without a SandboxDriver, Compute owns the Codex Deployment;
with one selected, that Driver provisions the dedicated Harness workload.
Both embedded and dedicated modes are supported in production, subject to the
selected Drivers' mode constraints. A replacement must preserve
its predecessor's Service selector until activation succeeds. Without an
eligible worker, revision work remains queued.

Revision list and read operations are scoped beneath the exact Namespace and
Agent. Each returned revision requires its own authorized read; substituting a
parent does not grant access to another Agent's history. Public response shapes
are defined by the [API reference](api.md).

## Service boundaries and verification

[AgentService](../../packages/occ/src/services/agent/service.ts) owns draft
creation, editing, and authorized Agent and revision reads.
[DeploymentService](../../packages/occ/src/services/deployment/service.ts) owns
admission, immutable snapshot construction, and retained-admission recovery.
The controller assembles both services with methods selected from the same
Installation-bound mutation runner and resolves selected Drivers when an
operation needs them. Existing controller methods delegate to these services.
The [Agent HTTP handlers](../../apps/controller/src/routes/agent.ts) use the
current controller lazily; create and update keep mutation, success audit, and
response projection inside the existing outer transaction.

Deployment still commits the revision, runtime intent, admission proof, audit,
and reconciliation work as one unit. A caught admission failure poisons that
unit. If PostgreSQL commit acknowledgement is lost, the HTTP controller waits
for the failed unit to unwind and asks the deployment service to verify the
retained locator through a fresh storage read. Recovery checks the exact
Installation, Agent scope, actor, and request; an unavailable proof remains a
dependency failure. These services add no independent store or runtime worker.

Focused coverage is in the [Agent service tests](../../tests/integration/agent-service.test.mjs),
[deployment service tests](../../tests/integration/deployment-service.test.mjs),
and [actual HTTP application tests](../../tests/integration/agent-service-api.test.mjs).
The [PostgreSQL Agent tests](../../tests/integration/postgres-agent-service.test.mjs)
and [PostgreSQL deployment tests](../../tests/integration/postgres-deployment-service.test.mjs)
exercise persisted ownership, concurrent admission, rollback, and lost commit
acknowledgement. They use separately prepared disposable databases selected by
`OCC_AGENT_SERVICE_DATABASE_URL` and `OCC_DEPLOYMENT_SERVICE_DATABASE_URL`,
respectively; follow the [test database settings](settings.md#postgresql-test-environment)
for application-role access.

## Current limitations

The public API has no Agent deletion operation, revision mutation/deletion,
or explicit rollback endpoint. An Agent therefore prevents deletion of its
Namespace. Editing a Configuration or Agent does not update a running workload;
a new deployment is required. Brokered model credentials and controller API
authentication for Agent service principals remain unavailable. The optional
[OpenShell SandboxDriver](drivers/openshell-sandbox.md) is supported with the
bundled Kubernetes Compute Driver and dedicated Codex; other sandbox execution
combinations are rejected.

## Failure semantics

- `400 INVALID_REQUEST`: The Provider ID is malformed or empty.
- `404 NOT_FOUND`: The nonempty Provider ID does not name a configured Provider.
- `401`: The session cookie is missing, invalid, expired, or revoked.
- `403`: Your principal lacks the exact permission for the Agent or Namespace.
- `404`: The Namespace or Agent does not exist under the requested parent.
- `404`: The selected Configuration does not belong to the Agent's Namespace.
- `404`: An associated service account does not belong to the Agent's Namespace.
- `409 RESOURCE_CONFLICT`: The associated account has no credential, stores an
  unsupported OAuth credential, or uses a provider-managed access token with
  an unsupported non-Codex or embedded Harness, or lacks a matching Provider
  and private managed-account binding.
- `409 RESOURCE_CONFLICT`: Another Agent already uses that name in the same
  Namespace, or the Namespace cannot accept new Agents.
- `409 NAMESPACE_NOT_READY`: The backing Namespace infrastructure is not ready
  for deployment.
- `503 DEPENDENCY_UNAVAILABLE`: A selected Harness descriptor, Compute
  implementation, or other required dependency is unavailable.

## Related

- [Quickstart](../guides/quickstart.md)
- [Development and production deployment](../guides/deploy.md)
- [Harness execution](harness-execution.md)
- [Namespaces](namespaces.md)
- [Controller worker](controller.md)
- [Namespace Configuration and immutable snapshots](configuration.md)
- [Service accounts](service-accounts.md)
- [Kubernetes Compute Driver](drivers/kubernetes-compute.md)
- [IAM](authorization.md)
- [Controller configuration](settings.md)
- [Implementation architecture](../ARCHITECTURE.md)
- [Agent lifecycle implementation](../../packages/occ/src/index.ts)
- [HTTP resource schemas](../../packages/contracts/src/api/resources.ts)
- [API integration coverage](../../tests/integration/occ-api.test.mjs)

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-09-01 08:47: Document nullable providerId selection, immutable revision association, and managed binding admission. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- [2026-08-28 17:55]: Recast as the current Agent and AgentRevision feature reference; separate procedures and correct Harness and SandboxDriver boundaries. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)
