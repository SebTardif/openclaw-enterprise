# Agent plugins

An Agent owns desired plugin selections independently of its reusable
[Configuration](configuration.md). Agent create/update stores structurally valid
selections as draft data. Saving that data does not install a package, modify an
active revision, or qualify plugin behavior for deployment.

## Current support

The current deployment admission path rejects every **nonempty** desired plugin
map with HTTP `501`, `NOT_IMPLEMENTED`: plugin deployment requires an immutable
workload-profile binding. This includes disabled and `never` selections because
they remain entries in the map. The refusal happens before Configuration
material acquisition, candidate/revision insertion, and provider workload work.
It leaves the saved draft available for later editing.

Absent selections and `{}` follow the existing plugin-free deployment path,
subject to all ordinary admission prerequisites. They add no plugin ConfigMap,
mount, environment variable, native configuration, or startup program to the
fixed Kubernetes renderer. Clearing the map does not by itself prove that the
rest of a deployment is available or admitted.

Trusted [PluginDriver selection and internal catalog discovery](drivers/plugin.md)
remain implemented. Catalog membership and a configured Driver do not supply
the missing immutable executable, configuration, and startup-material binding.
There is no public per-Agent plugin inventory or installation endpoint.

Explicit legacy Docker components retain plugin translation and startup helpers.
These components are separate from current admitted Kubernetes deployment and
do not bypass its HTTP `501` boundary. SSH retains its plugin-free embedded
OpenClaw path and rejects nonempty selections before host effects.

## Lifecycle

New Agents have no desired user plugins. Adding an entry records install intent;
it does not install a package in the controller or a running Agent. Setting
`enabled:false` retains that intent entry. Removing the entry removes the desired
selection. Neither operation immediately revokes an active tool or interrupts a
turn.

A deployment request with a nonempty map now stops at admission. It does not
create a plugin candidate whose later startup could make the request succeed.
Kubernetes also rejects nonempty retained/replayed revision selections at its
prepare, activate, prepared-verification, and current-launch boundaries before
opening provider or launch work. An older revision snapshot is not an exemption.

Historical revisions and explicit legacy component inputs can contain requested
plugin IDs/policies and their Driver identity. Such snapshots do not pin the
resolved native release, app mapping, or installed configuration. Legacy startup
can resolve different current catalog metadata on a later attempt. Those records
remain useful history, not evidence of current immutable-profile admission.

Read `Agent.plugins` for saved selections and the existing revision/status
surfaces for historical outcomes. An active revision pointer alone is not
installation or readiness evidence. Saved selections remain readable if a catalog
entry or Driver disappears.

## HTTP operations

Plugin selections use the existing Agent create/update API. There is no separate
plugin resource, install/delete endpoint, policy mutation endpoint, or plugin-tool
invocation endpoint.

| Method and path                                  | Body                                          | Successful response                            |
| ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `POST /namespaces/:namespaceId/agents`           | Agent create body with optional `plugins` map | `201`, Agent response containing the saved map |
| `PATCH /namespaces/:namespaceId/agents/:agentId` | Agent update body with optional `plugins` map | `200`, Agent response containing the saved map |

Agent creation requires Agent `create` on the Namespace and the existing exact
Configuration and ServiceAccount reads. Update requires exact-Agent `update`
and the existing exact reads. GET requires exact-Agent `read`. Existing Namespace
and resource checks apply. A successful draft write does not imply that an
explicit deployment request will succeed.

### Request fields

Use a Driver-qualified curated plugin ID matching the identifier grammar. Plugin
and tool IDs are 1–253 characters matching `^[A-Za-z0-9._~:@-]+$`. Callers cannot
submit a native identity, Driver identity, source, version, or arbitrary settings.
Unknown fields and `plugins:null` are invalid. Structural validation does not
prove catalog membership or native behavior.

On create, an absent `plugins` field and `{}` both mean no desired user plugins.
On update, omission preserves the existing map, `{}` clears it, and a nonempty
object replaces the whole map. Updates do not merge entries or nested policies.

In the table, **mode** means `always`, `never`, `prompt`, or `auto`. These fields
record requested policy. The native mappings below describe retained component
behavior; they do not enable current nonempty deployment admission.

| Plugin map value field        | Type                             | Meaning                                                          |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `enabled`                     | Boolean                          | Required enablement intent.                                      |
| `approvalMode`                | Mode                             | Required plugin default.                                         |
| `approvalsReviewer`           | Optional `user` or `auto_review` | Requested native reviewer; omission inherits the native setting. |
| `destructiveActions`          | Optional mode                    | Requested destructive-tool category override.                    |
| `writes`                      | Optional mode                    | Requested write-tool category override.                          |
| `tools`                       | Optional object keyed by tool ID | Requested individual tool overrides.                             |
| `tools.<toolId>.enabled`      | Optional Boolean                 | Explicit tool enablement override.                               |
| `tools.<toolId>.approvalMode` | Optional mode                    | Explicit tool approval override.                                 |

Each supplied tool override must contain `enabled`, `approvalMode`, or both.
Omitted fields inherit the plugin/category/native policy where representable.
Remove an optional override by replacing its containing entry without that field.
Remove all selections with `"plugins": {}`.

For example, this Agent create/update fragment stores an OpenClaw selection. An
explicit deployment with the saved map currently returns HTTP `501`:

```json
{
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": true,
      "approvalMode": "always"
    }
  }
}
```

A later update can record `"enabled": false`; the map is still nonempty, so the
same deployment refusal applies. This nested example likewise records draft
policy only:

```json
{
  "plugins": {
    "occ-plugin:diffs": {
      "enabled": true,
      "approvalMode": "auto",
      "destructiveActions": "never",
      "writes": "prompt",
      "tools": {
        "example_tool": { "enabled": true, "approvalMode": "always" }
      }
    }
  }
}
```

The bundled Diffs catalog lacks reliable per-tool metadata. That limits the
legacy translator independently of the current earlier deployment refusal.

### Response fields and historical revision snapshots

Agent GET, create, and update return saved selections under `data.plugins`.
Successful mutations and authorization denials retain attributable audit evidence.
Existing revision and deployment-status reads describe their own recorded
outcomes; the draft response is not an installation receipt.

Historical [AgentRevision responses](api.md) and legacy component inputs may
include this optional `plugins` snapshot:

| Revision `plugins` field | Type                      | Meaning                             |
| ------------------------ | ------------------------- | ----------------------------------- |
| `driver`                 | Driver identity object    | Recorded `id` and `implementation`. |
| `plugins`                | Object keyed by plugin ID | Recorded requested selections.      |

This is a record format, not another mutation body or proof that current
admission can create a nonempty plugin revision. Requested selections do not
qualify resolved release metadata or complete immutable runtime material.

## Approval policy

| `approvalMode` | Requested behavior                                                                   |
| -------------- | ------------------------------------------------------------------------------------ |
| `always`       | No plugin approval step; authorization and other restrictions still apply.           |
| `never`        | Block tool execution.                                                                |
| `prompt`       | Request review for each call through the effective reviewer.                         |
| `auto`         | Use native annotations and remembered-approval behavior to decide whether to review. |

`approvalsReviewer` independently selects `user` or `auto_review`. It does not
force review. For enabled tools, requested precedence is explicit tool mode,
then the stricter applicable category override, then the plugin default.
Category strictness is `never > prompt > auto > always`. Disabled plugins/tools
cannot be re-enabled by a mode override. Destructive classification uses native
`destructiveHint=true`; missing metadata is conservative. Writes means native
`readOnlyHint` is not true. Classification does not use a tool's name.

The API stores structurally valid policy. Retained legacy translators must also
be able to represent the complete policy exactly; unknown tool metadata can
produce `tools:null` and translation refusal. See
[native mappings and current limits](drivers/plugin.md#native-mappings-and-limits).
These component rules do not replace immutable workload-profile admission.

## Failures and boundaries

- `400`: invalid body or identity/source fields.
- `403`: denied exact-Agent permission.
- `404`: missing or foreign Agent or Configuration.
- `409`: ordinary Agent or deployment conflict.
- `501`: an otherwise authorized deployment has a nonempty saved plugin map;
  the immutable workload-profile plugin binding is not implemented.
- `503`: temporarily unavailable platform dependency.

Errors use `{error,meta:{requestId}}`, without `data`; the
[generated API reference](api.md) owns the complete envelope. Earlier validation,
authorization, and ownership errors can still take precedence over deployment
normalization.

Structurally invalid writes fail before save. A valid saved map may later receive
HTTP `501` on deployment without changing the earlier write's successful result.
Missing catalog credentials, authentication, installation, and transport failures
remain distinct errors in their own internal/legacy operations. They are not the
current reason nonempty admitted deployment is unavailable.

Namespace plugin configuration, arbitrary catalogs, importing an owner's Codex
configuration, plugin-specific credential APIs, Code Mode, and new permission
restrictions are outside this feature. Existing IAM, sandbox, network,
filesystem, and managed policy controls remain mandatory. Approval settings do
not grant filesystem access or isolate plugin code.

## Verification boundary

Source and component tests cover draft structure, refusal, catalog interfaces,
and retained translation behavior. They do not establish a current admitted
Kubernetes plugin deployment or live native behavior. Historical native results
in [Agent plugin testing](../testing/plugins.md) retain their original source,
runtime, account, and execution scope. A real immutable plugin-material producer
and its admission integration must exist before a live test can qualify that
new deployment path; a successful legacy component test cannot provide it.

The [generated API reference](api.md),
[request schemas](../../packages/contracts/src/api/common.ts), and
[response schemas](../../packages/contracts/src/api/resources.ts) own the wire
definitions.

## Related documentation

- [PluginDriver](drivers/plugin.md): selection, internal catalogs, and component mappings.
- [Agent plugin flow](../flows/agent-plugins.md): draft, admission refusal, and legacy boundaries.
- [Agent plugin testing](../testing/plugins.md): fixtures and historical proof notes.
- [Agent lifecycle](agents.md) and [deployment](../guides/deploy.md).
