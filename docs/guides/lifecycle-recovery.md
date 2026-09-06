# Lifecycle recovery

Use authorized reads to investigate an uncertain operation before deciding on any
new command. A lost response, timeout, cancellation or empty history page does
not prove that admission rolled back or that runtime effects stopped. Do not
automatically repeat a deployment POST.

The [lifecycle status API](../reference/lifecycle-status-api.md) provides four GET
contracts and their server adapters. Successful reads require the deployment to
supply the original private authenticated call and an authorized lifecycle source.
The default composition has no production source or account/currentness bridge
for these reads and returns `503 DEPENDENCY_UNAVAILABLE` when either is missing.
The steps below apply when those dependencies are actually available; an
unavailable read must remain unavailable.

## Start with the existing deployment contract

The current deployment procedure remains in the
[deployment guide](deploy.md). The existing request is bodyless:

```sh
scripts/occ-api POST "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/deploy"
```

Submit it only as a deliberate deployment action. Its HTTP 202 response still
contains the existing AgentRevision as `data`, not a new lifecycle operation
receipt. Repeated POSTs are not an idempotent retry protocol and can admit
distinct revisions. The lifecycle read API does not change that behavior or
install public disable, stop or resume commands.

Keep any actual returned revision ID and diagnostic request ID in the appropriate
protected operator record. A revision ID, request ID, matching draft or timestamp
does not identify a lost lifecycle operation. Do not convert one into an
`operationRef` or construct an accepted receipt. The existing exact Agent and
revision reads remain available under their own current permissions:

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/revisions/$REVISION_ID"
```

Use the revision command only with an actually known revision ID. A selected
Agent revision or readable revision document is not evidence that the runtime is
serving. Deploy permission and a deployment response do not automatically grant
lifecycle, Agent or revision read permission.

## Read current status and a known operation

Use an existing authenticated API session or service identity with current read
permission for the exact Agent. Every request is authorized afresh; an old receipt
or the initiating actor's earlier permission cannot authorize disclosure.

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle"
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle/capability"
```

Inspect requested, selected and serving revision IDs separately, along with the
observed generation. A historical serving revision can remain visible while
`serving` is false. Keep source `observedAt` and control-plane `recordedAt`
separate; receiving another response does not refresh the source observation.
Read each condition, rather than treating a generic converged phase as proof of
every outcome.

If an exact operation locator is already known from an actual accepted operation
or independently established recovery association, read that locator:

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle/operations/$OPERATION_REF"
```

The locator must be the original unprefixed lowercase UUID-v4. Repeated authorized
GETs have no execution effects. They can return the exact immutable historical
operation even after newer operations have advanced the head. Interpret its
observation as historical; do not promote it into the current head's result.
Fresh authorization still applies if the initiating actor has since lost access.
`NOT_FOUND` intentionally does not distinguish hidden or foreign operations from
missing ones.

## When the locator was lost

If no exact locator is known, request the bounded owner-scoped operation page:

```sh
scripts/occ-api GET "/namespaces/$NAMESPACE_ID/agents/$AGENT_ID/lifecycle/operations?limit=20"
```

`limit` defaults to 20 and must be decimal text from 1 through 100. When the
response supplies a nonnull `nextAfterGeneration`, use that exact positive
integer as `afterGeneration` in a separate GET. Omit the cursor for the first
page and stop the scan when it is null. Every page requires a new current read;
there is no automatic page walk or permission cache. A page may contain fewer
than `limit` records and still provide a next cursor.

Discovery returns minimal accepted-operation summaries. It does not reveal
original actors, request/audit associations, revision documents or provider
details. Treat matching rows as candidates: equal kind, draft contents or time
does not establish that one row came from the lost request. An empty page cannot
rule out an in-flight commit. If multiple candidates fit or the source is
unavailable, preserve the uncertainty and the original diagnostic correlation.
Do not guess a row, fabricate an operation or repeat POST automatically.

A server's definitive admission recovery requires a fresh authorized read after
the failed transaction has unwound and a complete match to the original retained
immutable association. Public discovery is not a replacement for that recovery.
Choosing a later deployment is a separate deliberate action with its own current
authorization and consequences; it does not resolve what the earlier request did.

## Denied access and an unreachable runtime

Read `accessDenied`, `routeRemoved`, `executionTerminated`,
`credentialRevocation` and `stateRetention` independently. Confirmed denial and
route removal can coexist with unknown termination. Disabled intent includes
denial, route withdrawal and cancellation request; it does not by itself promise
physical stop. For stopped intent, `stopComplete` remains false until every
affected runtime is terminated and every possible create outcome is resolved.
An expired deadline, cancelled request or unreachable provider does not prove
absence. Credential revocation and retained-state verification can remain
unresolved even after physical stop completes.

This API addition provides no public disable/stop/resume operation, retry-work
endpoint, purge shortcut or supported unreachable-runtime teardown procedure.
Keep retained state and exact recovery evidence intact while those outcomes are
unknown. Manual database edits, guessed queue entries and arbitrary provider
deletion are not supported recovery steps. Follow the deployment's separately
approved retained-shutdown procedure when one exists; otherwise report the
unavailable recovery path instead of claiming stop completion. Uninstalling the
control plane does not establish termination of its tenant workloads.

Capability is only a compatibility observation. Neither its stage nor a source
configuration switch authorizes recovery or demonstrates old-writer exclusion.
Production shutdown, credential outcomes, retained storage and queue/claim/lock/
backend timing require their actual implementations and measurements. Focused
schema or controlled HTTP tests do not establish those outcomes or a measured
disable-to-denial latency.
