# Configure repository drafts in development

Register an unverified binding, save an Agent draft, then check deployment refusal
and recovery. Obtain the exact Namespace, binding, and signing-Secret permissions
in the [feature reference](../../reference/repository-drafts.md) before starting.

## Register a binding and save the Agent

Set `$COOKIE_JAR` to an authenticated session cookie file, `$OCC_ORIGIN` to the
controller origin, and `$NAMESPACE_ID` and `$AGENT_ID` to the target IDs. Keep
credentials in protected files, not command literals. Create `repository-binding.json`
with actual GitHub IDs and same-Namespace Secret references:

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

Replace the illustrative IDs, then send:

```sh
curl --fail-with-body --cookie "$COOKIE_JAR" \
  -H 'content-type: application/json' --data-binary @repository-binding.json \
  "$OCC_ORIGIN/namespaces/$NAMESPACE_ID/repository-bindings"
```

The response contains `data.id` and `data.generation`. PATCH the binding's exact route
with all four fields and its current `expectedGeneration`; stale generations return 409.

GET the Agent's current `configurationId`. Put it and a `repositoryAccess` value
using the [selection shape](../../reference/repository-drafts.md#agent-selection)
in `agent-repositories.json`. A supplied selection replaces the array; omission
preserves it. There is no draft version guard: coordinate simultaneous editors
before submitting:

```sh
curl --fail-with-body --cookie "$COOKIE_JAR" -X PATCH \
  -H 'content-type: application/json' --data-binary @agent-repositories.json \
  "$OCC_ORIGIN/namespaces/$NAMESPACE_ID/agents/$AGENT_ID"
```

Read the Agent again to verify persistence.

## Verify and recover

Verify login, same-Namespace save/read/update, denied foreign references, and stale
binding PATCH refusal. Nonempty repository deployment must return
`REPOSITORY_VERIFICATION_UNAVAILABLE` with no new revision or queued work.

Set `repositoryAccess` to `{"schemaVersion":1,"repositories":[]}`, PATCH and reread,
then follow [Agent deployment](../../reference/agents/deployment.md). Check the admitted
revision and worker/runtime separately; an API receipt does not prove serving or a
model turn. Providerless and provider-backed configurations retain their existing behavior.

After a failed or ambiguous mutation, GET the exact binding/Agent and inspect its
saved generation/value before resubmitting. Saving does not verify GitHub access.
