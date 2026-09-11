# Create and deploy Agents in the console

Create a saved Agent draft, manage supported initial Kubernetes runtime credentials,
and submit a retained deployment command from the [platform console](../console.md).
Start by signing in and selecting the intended Namespace. Deployment additionally
requires a saved applicable ServiceAccount, an admitted workload-profile selection,
and the genuine server-side admission capabilities.

## Create an Agent

Select **Create Agent** from the Agents page to create one Namespace-owned Agent.
Enter an Agent name and review the prefilled native Configuration JSON. The
editable starter matches the selected execution mode: dedicated uses
`codex/gpt-5.1`; embedded uses `openai/gpt-5.1`. These are examples, not discovered
Installation defaults or a guarantee of model access. Review the model and
provision the required credentials before deployment. Changing execution mode
updates untouched JSON; use **Reset template** to replace your edits. The form
requires valid JSON with an object at its root.

Use the Slack and Microsoft Teams cards to configure initial channels before creating
the Agent. Their settings update the same Configuration JSON, including the required
plugin entries. No channel request is sent until you submit **Create Agent**. Enabled
channels require Dedicated execution. Slack credentials can be provisioned from the saved Agent draft; Teams credential provisioning remains an operator procedure.

Workspace files cannot be initialized during creation: the backend accepts files
only after the Agent has an active revision and a reachable gateway. Create and
deploy the Agent, then open **Workspace files** to load or create the four supported
files. The creation form does not store unsaved file contents.

Choose an optional Provider and service account from the select lists. Provider
discovery requires Installation `administer`; service accounts are readable
accounts in the selected Namespace. Select the two associations independently.
Unavailable or loading lists show their status. You can leave either association
unset; the form does not accept freeform association IDs.

Submitting creates a same-Namespace `kind: "agent"` Configuration from the JSON,
then submits `POST /namespaces/:namespaceId/agents` with its returned ID and the
selected execution mode and associations. If the Configuration saves but Agent
creation fails, its ID remains visible and the saved JSON and execution mode are fixed.
Correct the name or associations and retry to reuse that Configuration. These are separate
API writes; failure does not remove the saved Configuration or retry automatically.
If a write’s reply is interrupted or unavailable, its outcome is unknown. The
form disables further creation until you leave or refresh it. Inspect the Agent
and Configuration collections before starting again; a lost response can follow
a successful write.
Successful creation opens the Agent detail page at
`/console/agents/:agentId?...&revision=draft`. It does not
admit an AgentRevision, deploy a workload, or prove runtime health.

## Initial runtime credentials

For an eligible saved draft without any historical revision, open the initial
runtime-credential panel. This path supports the Kubernetes Compute Driver's native per-Agent
OpenAI API key and optional Slack Socket Mode credentials. It does not replace
Provider-managed ServiceAccount credentials or Configuration Secret bindings.
The provisioning path rejects an associated ServiceAccount, model Secret binding,
saved `workloadProfileSelection`, or historical AgentRevision. These boundaries
keep initial native credentials separate from V2 admission; provisioning cannot
satisfy profile or account authority. Agents with a saved ServiceAccount, profile
selection, or model binding skip this legacy credential API in the console; stored
legacy credentials are not the deployment gate.

Enter the OpenAI API key and, when Slack is enabled, its app and bot tokens.
The server generates independent gateway and app-server transport tokens and a
local gateway password. The password is projected only when native Configuration
explicitly selects the supported environment reference; it is never returned by
the credential API.
Inputs are masked and cleared after submission; the browser does not store them
in local storage, URLs, or Configuration. The API returns only whether each
complete, correctly owned credential group is stored. **Stored** does not mean
the provider accepted a credential or that a gateway is connected.

The API uses `GET` and `POST` on
`/namespaces/:namespaceId/agents/:agentId/runtime-credentials`. Reading requires
exact Agent `read`; provisioning also requires `operate`. The server derives all
Kubernetes names from the admitted Namespace, Agent, and Installation driver
configuration. Credential values are transient API inputs and are stored only in
the Agent-owned Kubernetes Secrets; audit records contain the actor, target,
action, and outcome, never the values.

Provisioning creates missing whole Secrets before any AgentRevision exists.
It never rotates or overwrites existing credentials. A retry may reuse complete,
owned groups; supplying a different value for an existing group is a conflict.
Malformed or foreign Secrets require operator investigation. If a response is
lost or a dependency fails, refresh stored status before explicitly retrying.
Already-created Secrets remain in place even when later storage or audit work
fails; there is no automatic retry or rollback deletion.

## Deploy a saved draft

**Deploy saved draft** requires a saved applicable ServiceAccount and exact
`workloadProfileSelection`, along with all valid saved-draft expectations. It is
disabled when those prerequisites are absent. Initial native runtime-credential
provisioning cannot supply them: that path rejects both associations. The server
also needs the original invocation, enrollment, profile and account capabilities;
the UI cannot create authority or make an unavailable composition deployable.
See [admission availability](../agents/deployment.md#admission-availability) and
the [identified V2 command](../lifecycle-deploy-v2.md) for exact constraints.

The browser must grant persistent storage and support strict IndexedDB durability.
If it cannot, the console sends no deploy request and directs the operator to
`scripts/occ-deploy.mjs`. Fresh authorized Agent, Configuration, and lifecycle
reads compare the viewed saved inputs. The console then generates a UUID command
identity and atomically retains the immutable exact command and body for the
current account, origin, Namespace, and Agent before one POST. A changed draft
requires refresh; separate browser reads never replace the server's atomic draft
and lifecycle comparisons.

HTTP `202` is shown as an admission receipt. It neither opens a revision as though
it were serving nor establishes runtime readiness. Reloading the view retains
the original command and enables **Read original deployment**, which reads that
exact operation through the lifecycle operation endpoint with current authorization.
Any uncertain outcome, including a POST error or interruption after local command
reservation, blocks another submission. Do not clear browser records to resolve
an unknown outcome; no request is replayed automatically.

**Prepare another deployment** performs its own authorized exact read of the
original operation. Only confirmed acceptance allows it to clear the active
local pointer with a compare-and-delete; the original command history remains.
A separate **Deploy saved draft** click is required for a new command. Missing
or unavailable readback leaves the original outcome unresolved and does not
permit another operation identity. For runtime checks after admission, use the
[operator workflow](../../flows/operator-workflow.md).
