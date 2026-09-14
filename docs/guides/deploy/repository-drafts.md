# Configure repository drafts in development

Use this procedure to register an unverified repository binding and edit an Agent's
repository draft. Repository deployment is inactive; the supported deployment check
uses an empty repository selection. See the [feature reference](../../reference/repository-drafts.md)
for exact permissions, limits, and failure behavior.

## Register a binding and save the Agent

Use an existing authenticated session cookie jar at `$COOKIE_JAR`, your controller
origin at `$OCC_ORIGIN`, and the actual Namespace and Secret IDs. Keep credentials in
protected files, not command literals. Create a descriptor file containing:

```json
{
  "appId": 123,
  "installationId": 456,
  "repositoryIds": [789],
  "keySecretRef": {
    "kind": "secret",
    "namespaceId": "ns_11111111-1111-4111-8111-111111111111",
    "id": "sec_22222222-2222-4222-8222-222222222222"
  }
}
```

Replace the illustrative IDs with your real same-Namespace references, then send:

```sh
curl --fail-with-body --cookie "$COOKIE_JAR" \
  -H 'content-type: application/json' --data-binary @repository-binding.json \
  "$OCC_ORIGIN/namespaces/$NAMESPACE_ID/repository-bindings"
```

The returned `data.id` and `data.generation` identify the unverified descriptor.
To update it, send all four descriptor fields plus its current `expectedGeneration`
with PATCH to the returned binding's exact route. A stale generation returns 409.

Read the Agent's current `configurationId` through its GET route. Create an
`agent-repositories.json` file containing that `configurationId` and a
`repositoryAccess` value using the [selection shape](../../reference/repository-drafts.md#agent-selection).
Send the update through the authenticated Agent API:

```sh
curl --fail-with-body --cookie "$COOKIE_JAR" -X PATCH \
  -H 'content-type: application/json' --data-binary @agent-repositories.json \
  "$OCC_ORIGIN/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
```

Read the Agent again to verify persistence. A supplied selection replaces the
saved array; omission preserves it. Agent updates have no draft version guard,
so coordinate simultaneous editors before submitting replacements.

## Verify and recover

Verify login, same-Namespace save/read/update, denied foreign references, and a stale
binding PATCH. A nonempty repository deployment must return
`REPOSITORY_VERIFICATION_UNAVAILABLE` with no new revision or queued work.

Clear the draft with `{"schemaVersion":1,"repositories":[]}`, save, and use the
existing [Agent deployment procedure](../../reference/agents/deployment.md). Check the
admitted revision and actual worker/runtime separately; an API receipt alone does
not prove serving or a model turn. Existing providerless and provider-backed
no-repository configurations retain their current behavior.

For a failed or ambiguous mutation, GET the exact binding/Agent and inspect its saved
generation/value before resubmitting. An administrator must grant the exact
Namespace, binding, and signing-Secret permissions listed in the feature reference.
GitHub enrollment and repository verification remain unavailable.
