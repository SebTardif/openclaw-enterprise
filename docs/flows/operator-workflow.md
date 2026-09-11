# Minimum operator workflow

The [console](../reference/console.md) supports sign-in, scoped Agent browsing,
draft creation, immutable revision inspection, and supported Slack and Microsoft
Teams draft edits. This entrypoint connects those actions to the current
management API and deployment checks. Disable/stop and retention/purge
procedures remain unavailable in the current Agent API.

## Prepare authenticated access

Follow the [deployment guide](../guides/deploy.md) for the installed environment
and [authentication reference](../reference/authentication.md) for a provisioned
operator account or appropriately scoped service key. The console uses a
same-origin cookie session. The repository's `scripts/occ-api` helper uses
`OCC_URL` and a protected service-key response file selected by
`OCC_SERVICE_KEY_FILE`; it sends the key without printing it.

Use exact Namespace and Agent IDs from authorized inventory. The server checks
the authenticated principal and permissions for each request; selecting an ID
does not grant access. Keep service-key files, cookies, configuration documents,
and raw logs out of shared operation receipts.

```sh
scripts/occ-api GET /installation
scripts/occ-api GET /namespaces
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
```

## Prepare and admit a revision

1. Sign in to `/console/`, select the authorized Namespace, and open the Agent.
2. Inspect **Saved draft** and its Configuration generation. Review native JSON
   and unresolved credential references. Edit supported Slack and Teams settings
   only in the draft; admitted revisions remain unchanged. Unsupported native
   shapes require the existing Configuration API and operator review.
3. Read the Namespace and confirm `data.status` is `ready`. Check the selected
   runtime, required credentials, and deployment prerequisites in the
   [deployment guide](../guides/deploy.md).
4. Check the prerequisites for
   [identified deployment](../guides/deploy/production-agents.md#submit-an-identified-deployment).
   The default composition lacks complete profile-admission suppliers and remains
   unavailable. A valid command or prepared client directory does not enable it.
5. When those suppliers are installed, prepare the complete
   [V2 command](../reference/lifecycle-deploy-v2.md#command-identity) using the
   actual saved draft and lifecycle generation from authorized sources. Retain
   one lowercase UUID-v4 operation reference and every explicit expectation.
   Missing state cannot be represented as a guessed value or a latest profile.

### Retain and submit one command

With Node 24 and the repository's prepared dependencies,
`scripts/occ-deploy.mjs` offers three finite actions: `prepare`, `send`, and
`read`. Its protected input file contains this existing V2 binding shape:

```text
{
  "action": "agent.deploy",
  "scope": { "installationId": "...", "namespaceId": "...", "agentId": "..." },
  "command": { ...the complete V2 command... }
}
```

The placeholders above describe the shape, not runnable values. Obtain the
Installation, Namespace and Agent IDs from authorized inventory and use the
complete command specified in the linked reference. The supplied scope and
controller origin are retained target data, never proof of server identity or
permission. The binding's Installation is not an HTTP body operand.

Set `OCC_URL` to the exact controller origin without a trailing slash, path,
query, credentials or fragment. HTTPS is supported; HTTP is restricted to
`127.0.0.1` or `[::1]` for development. Choose one current authentication source:
the documented protected `OCC_SERVICE_KEY_FILE` or the protected
`OCC_SESSION_COOKIE_JAR` from
[human sign-in](../guides/deploy/service-keys.md#sign-in-as-a-human-administrator).
Before `prepare`, set `OCC_AUTH_BASE_URL` to the configured authentication origin
if it differs from `OCC_URL`; otherwise it defaults to the connection origin.
Both must use their canonical origin form. Cookie mutations send that separately
retained authentication Origin. The client consumes an
unexpired exact-host `/` session cookie from the curl jar. It does not sign in,
refresh credentials or fall back between credential types. A service key cannot
substitute for a human session where the server requires one.

Create an operator-owned private parent directory (`0700`) beneath ancestors
owned by that operator or the filesystem's root owner, and keep the binding
input and credential files private (`0600`). Choose a new child directory for
this one command, outside the repository and shared receipts:

```sh
node scripts/occ-deploy.mjs prepare "$DEPLOY_DIRECTORY" "$DEPLOY_BINDING_FILE"
node scripts/occ-deploy.mjs send "$DEPLOY_DIRECTORY"
```

`prepare` validates the original bytes with the strict binding codec and
exclusively publishes canonical `binding.json`, exact `command.json`,
`target.json`, and a final `prepared` marker. It syncs files and directories
before success and opens no connection. `send` uses only those retained command
bytes and the retained Namespace/Agent route. An altered binding, command or
target, a different supplied `OCC_URL` or `OCC_AUTH_BASE_URL`, or incomplete
preparation refuses before connecting. Later actions may omit those variables
to use the retained origins. The final preparation marker separately pins both
origins so changing the target file alone cannot redirect a request.

Before opening its sole POST, `send` exclusively creates and syncs
`may-have-sent`. Every later `send` refuses, including after a crash, timeout,
denial, invalid response or failure to save the acknowledgement. Preserve the
directory and marker; never remove them to retry. Partial preparation files are
also preserved for inspection. Filesystem durability requires a local filesystem
with working file and directory sync; this is not protection against a hostile
process running as the same OS user, disk loss or coordinated file replacement.

A validated HTTP `202` minimal deploy receipt is retained separately as
`acknowledgement.json`. It identifies accepted intent; it contains no revision
document and establishes no serving, provider creation or termination result.
The client checks operation reference, deploy kind and expected next lifecycle
generation. It neither needs nor invents scope fields absent from that receipt.

If the response is lost, the result remains **unknown** across client processes.
With current authorized access, perform one exact historical operation read:

```sh
node scripts/occ-deploy.mjs read "$DEPLOY_DIRECTORY"
```

`read` uses only the retained exact-operation GET and validates the current
operation-status response codec. It records the minimal historical operation,
including `requestedRevisionId`, in a separate `readback-*.json` file. It does
not query a newer head or infer serving from observations. Missing, denied,
foreign, malformed or unavailable readback stays unresolved; no old local
acknowledgement substitutes for current read permission. Each action has a
30-second request deadline and a bounded response; redirects are refused.
Credentials, cookies and raw backend errors are never printed or retained.

There is no resend, replay, automatic retry, replacement operation ID or draft
regeneration action. Follow the canonical
[lifecycle recovery procedure](../guides/lifecycle-recovery.md) for the remaining
operator decisions and independently authorized revision reads.

The lifecycle read routes use the original authenticated request bridge and
bounded PostgreSQL history reader. Every read still requires current Agent-read
permission, rechecked after the data read. Missing runtime observations remain
`NOT_OBSERVED` or unknown; capability remains unavailable until its protected
record is published. This client does not enable missing deployment suppliers.

## Inspect selection and runtime

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/revisions"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/revisions/$REVISION_ID"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle/capability"
```

Compare the Agent's `data.activeRevisionId` with the admitted revision ID. The
console calls this **Selected revision**. A different viewed snapshot changes
only what you inspect. Agent and revision responses do not expose an observed
serving revision, observation timestamp, runtime generation, failed activation,
or confirmed shutdown state. Missing observation stays unavailable.

Use the separately authorized lifecycle response for requested, selected and
serving revisions and the original observation generation. Keep source
`observedAt` separate from control-plane `recordedAt`; receiving a response does
not refresh the underlying observation. Read access denial, route removal,
execution termination, credential revocation and retained-state conditions
independently. Follow the linked lifecycle recovery procedure for exact-operation
reads and ambiguous outcomes.

Use the installed environment's [runtime verification and troubleshooting
steps](../guides/deploy.md) to check the actual workload, allowed and denied
connections, and a real interaction. Control-plane readiness, revision
selection, and an open connection each establish only their own result. They
do not prove a completed model turn, safe cancellation, or restart continuity.
Keep the admitted operation and requested revision distinct from current
selection. The [lifecycle recovery procedure](../guides/lifecycle-recovery.md)
owns conflict handling and the separately authorized status reader's limits.

## Disable, stop, retention, and purge limits

| Operation                                         | Current supported boundary                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit or disable a draft channel                   | Updates Configuration values for future deployment. It does not revoke access or stop the running Agent.                                                                                                   |
| Sign out                                          | Revokes that operator session when confirmed. It does not stop the Agent or revoke other principals.                                                                                                       |
| Disable Agent access or stop execution            | No supported Agent API/CLI procedure is available. A closed socket, unreachable runtime, or absent status cannot establish shutdown.                                                                       |
| Retain workspace and completed context after stop | No supported stop/retention procedure is available for validating this behavior. Retaining a volume alone does not prove conversation recovery.                                                            |
| Purge Agent data                                  | No authorized Agent purge API exists. There is no current guarantee covering workspace, completed context, mappings, backup copies, retained volumes, audit records, provider messages, or shared secrets. |

The [Agent reference](../reference/agents.md#current-limitations) owns the API
limits. The deployment guide's infrastructure teardown instructions describe
their narrower resource ownership: uninstalling the control plane can leave
tenant workloads, external PostgreSQL, and operator-managed Secrets or storage.
They do not provide per-Agent disablement or an audited purge. An Agent also
prevents [Namespace deletion](../reference/namespaces.md).

A complete operator acceptance run still needs supported lifecycle and purge
procedures: persist exact intent, observe denial and termination separately,
retain completed state, explicitly purge a disposable exact-owned Agent, and
verify a second Agent remains untouched. Partial or unobserved outcomes must
remain incomplete. No latency or physical-erasure guarantee is established here.

## Access and uncertain outcomes

On expired access, the console clears private views, closes pending editors,
and asks for login. Back, reload, and Refresh recheck the session and scope.
Late responses cannot restore a prior view. Denied and unavailable requests show
safe reason classes and, when present, a bounded request ID for operator log
correlation. Raw backend payloads are not error messages.

The final authorization check distinguishes withdrawn Agent-read permission, which returns a non-disclosing `404 NOT_FOUND`, from an expired or withdrawn session, which returns `401 UNAUTHENTICATED`; signing in again does not restore a removed permission.

An unconfirmed creation or channel save may already have committed. The console
does not replay it and blocks another write from that form until its state is
refreshed or left. Inspect current authorized state before submitting again.
An unconfirmed logout hides private content and requires Retry; it does not
claim that server revocation succeeded.

## Verification boundary

The console browser suites exercise real Fastify routes, Better Auth, and Native
IAM with in-memory stores: creation, revisions, both channel draft editors,
denied access, session expiry during pending reads/saves, and dropped write
responses. API coverage separately checks foreign Namespace detail and edit
requests. These tests verify the management surface and its failure behavior.
They do not prove PostgreSQL durability, live Slack/Teams interaction, runtime
cutover, disable/stop, retention, or purge. See the [test guide](../testing/README.md)
for the independently required environment checks.

`node --test tests/integration/occ-deploy-client.test.mjs` exercises actual CLI
child processes, private files and bounded loopback HTTP transport using the
real command and response codecs. It covers preparation failures, restart,
concurrent send attempts, interruption, response loss, deadline expiry,
target changes, exact readback and secret diagnostic canaries. The HTTP fixture
does not establish controller authentication or authorization, server COMMIT,
real deployment suppliers, runtime effects or disk power-loss durability.
