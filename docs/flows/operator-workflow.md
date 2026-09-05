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
4. Admit the current draft using the bodyless deploy operation:

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID"
scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy"
```

The API returns HTTP `202` with an immutable revision in `data` and a request ID
in `meta.requestId`. Save the returned revision ID as `REVISION_ID` for subsequent
reads. Admission schedules reconciliation; it does not confirm serving. See
[revisions and deployment](../reference/agents.md#revisions-and-deployment) for
permission and validation requirements.

If the deploy response is lost, the result is **unknown**. Inspect Agent and
revision history before issuing new intent. This route has no documented
idempotency key or operation-status lookup; revision history alone may not
uniquely identify which of concurrent requests was accepted. Do not blindly
repeat the POST or infer that no revision was admitted from an absent response.

## Inspect selection and runtime

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/revisions"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/revisions/$REVISION_ID"
```

Compare the Agent's `data.activeRevisionId` with the admitted revision ID. The
console calls this **Selected revision**. A different viewed snapshot changes
only what you inspect. Agent and revision responses do not expose an observed
serving revision, observation timestamp, runtime generation, failed activation,
or confirmed shutdown state. Missing observation stays unavailable.

Use the installed environment's [runtime verification and troubleshooting
steps](../guides/deploy.md) to check the actual workload, allowed and denied
connections, and a real interaction. Control-plane readiness, revision
selection, and an open connection each establish only their own result. They
do not prove a completed model turn, safe cancellation, or restart continuity.
Repeat reads after a conflict or failure and retain the request/revision identity
with the observed result. A stale-generation lifecycle conflict and its recovery
cannot yet be exercised through a supported Agent lifecycle endpoint.

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
cutover, disable/stop, retention, or purge. See the [test guide](../testing.md)
for the independently required environment checks.
