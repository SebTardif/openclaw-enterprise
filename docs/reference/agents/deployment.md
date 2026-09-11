# Agent identity and deployment

Use this reference to select an [Agent](../agents.md) execution mode and understand its stable identity, immutable revision, and asynchronous deployment. Creating or editing an Agent alone does not start a workload.

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
[Kubernetes Compute Driver](../drivers/kubernetes-compute.md) uses separate
gateway and Codex ServiceAccounts. Only Codex receives the short-lived,
audience-scoped projected token for its exact Agent's existing
`servicePrincipalId`; production requires this projection. An `embedded`
gateway necessarily shares its exact Agent's projected workload identity and
Agent-specific model credential because that same process runs the built-in
Harness. Both modes are supported in production. OCC token verification,
identity exchange, and ServicePrincipal
authentication through the controller API remain deferred.

An Agent may also reference one same-Namespace, OCC-owned
[service account](../service-accounts.md) through `serviceAccountId`; updating
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
`agentRuntime.id` policy. The [Harness execution reference](../harness-execution.md)
owns supported runtime selections, model catalogs, transport, and credential
boundaries. OCC rejects conflicting, unknown, or mode-incompatible selections
before admitting a revision. A selected SandboxDriver currently requires
`dedicated` Codex execution; it does not support embedded OpenClaw.

An Agent update may include `executionMode`, `serviceAccountId`, and `providerId`
alongside its required `configurationId`. It can also update `maximumExecutionMs`
and an explicit `workloadProfileSelection`; see [draft editing](../agents.md#editable-configuration). Omission preserves the current value;
`serviceAccountId: null` detaches the account and `providerId: null` clears the
Provider. Existing revisions retain their immutable placement, account, and
Provider association.
See the
[Harness execution topology flow](../../flows/harness-execution-topology.md) for
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
unchanged. The [selected journal](../turn-journal/execution.md#selected-native-execution-retention)
requires the actual consumption authority's explicit selection and, for a finite
cap, a safe-integer sum of its original anchor and configured duration. The
[hosted native owner](../hosted-native-execution.md) still requires matching SDK/native
codecs and production composition to bind that authority to this revision
snapshot. Credential lifetimes remain separate from this persisted configuration
contract.

## Admission availability

New deployment requires an exact saved `workloadProfileSelection`, its current
admission and original enrollment capabilities, and an applicable ServiceAccount
credential association. No implicit profile or credential association is selected.
The selected application composition must install the genuine invocation,
transaction/read enrollment, profile resolver, and current account/reference
guards. Missing producers leave deployment unavailable. A valid command or
stored runtime credential does not supply those capabilities. The bounded
admitted-configuration grammar also rejects unsupported native options and
plugins; see [identified deployment commands](../lifecycle-deploy-v2.md).

The execution topologies described above are Driver capabilities. They do not
establish that every native configuration can pass the current V2 admission path
or that an installed application supplies the required producers.

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
returned through the API; see [secret boundaries](../configuration/secrets.md#secret-boundaries).
Nested objects and arrays are immutable.

When a SandboxDriver is selected, its `configureAgent` hook can transform a
copy of the source document before admission and snapshotting; it does not
update the reusable Configuration or its generation. The admitted revision
therefore records the source generation and the effective document after that
transformation. Its SandboxDriver selection and the Agent's stable service
principal are retained internally and are not exposed by the current HTTP
revision schema. See [SandboxDriver](../drivers/sandbox.md).

An authorized `POST /namespaces/:namespaceId/agents/:agentId/deploy` requires an
[identified V2 command](../lifecycle-deploy-v2.md#command-identity). Its body retains
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
[deployment command reference](../lifecycle-deploy-v2.md) owns this protocol and its
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
are defined by the [API reference](../api.md).
