# Repository binding definitions and Agent drafts

Authenticated administrators can save Namespace-owned repository binding descriptors
and select repositories on an Agent's editable draft. Every binding remains
`unverified`. Repository deployment returns HTTP 503 with
`REPOSITORY_VERIFICATION_UNAVAILABLE` before revision, queue, or Compute effects.
Agents with an empty repository selection retain their existing deployment flow.

## Binding API

| Method | Route                                                     | Permission                                   |
| ------ | --------------------------------------------------------- | -------------------------------------------- |
| POST   | `/namespaces/:namespaceId/repository-bindings`            | Namespace-scoped `repository_binding:create` |
| GET    | `/namespaces/:namespaceId/repository-bindings/:bindingId` | Exact binding `read`                         |
| PATCH  | `/namespaces/:namespaceId/repository-bindings/:bindingId` | Exact binding `update`                       |

POST accepts `appId`, `installationId`, `repositoryIds`, and `keySecretRef`.
The first two identifiers are positive safe-integer **GitHub** App and installation
identifiers. They are administrator assertions, not enrollment evidence or an OCC
Installation selector. `repositoryIds` contains 1–32 distinct positive safe integers.
`keySecretRef` is an existing exact same-Namespace OCC Secret reference. Both create
and update require `operate` on that exact Secret; metadata `read` is insufficient.
The API never returns signing-key material, tokens, leases, or authorization handles.

PATCH replaces those four descriptor fields and requires `expectedGeneration`.
The server starts `generation` at one, advances it once per successful update,
and returns HTTP 409 for a stale expected generation. ID, Namespace, creation time,
and the `unverified` state are server-owned. No DELETE or list API is provided.
An existing binding prevents deletion of its referenced Secret.

## Agent selection

Agent POST and PATCH accept:

```json
{
  "repositoryAccess": {
    "schemaVersion": 1,
    "repositories": [
      {
        "bindingRef": {
          "kind": "repository_binding",
          "namespaceId": "ns_11111111-1111-4111-8111-111111111111",
          "id": "rb_22222222-2222-4222-8222-222222222222"
        },
        "repositoryId": 789,
        "checkoutRef": "refs/heads/main",
        "readProfile": "checkout",
        "publication": { "mode": "disabled" }
      }
    ]
  }
}
```

The usual required Agent fields still apply, including `configurationId` on PATCH.
Create omission stores an empty selection. Update omission preserves the saved
selection; a supplied array replaces it; `repositories: []` explicitly clears it.
A draft may contain at most eight distinct binding/repository pairs. Each repository
must occur in its binding's declared repository set. Unknown fields, schema
versions, duplicate pairs, views, and enabled publication arms are rejected.

Checkout references accept a full 40-hex commit or a fully qualified
`refs/heads/...` or `refs/tags/...` Git ref, at most 256 UTF-16 code units. Control characters,
spaces, Git revision operators, empty or dot-prefixed path components, `.lock`
suffixes, `..`, `@{`, and a trailing dot are rejected. Ref validation does not
resolve the ref or prove its existence.

Selecting a repository requires the ordinary exact Agent create/update and
Configuration read permissions, exact binding `operate`, and signing-Secret
`operate`. References cannot cross Namespaces. Even an editor who can read a binding
cannot select it without operate permission. Binding generation changes never
rewrite a saved Agent draft or immutable AgentRevision.

## Inactive boundary and troubleshooting

Saving is not GitHub enrollment, repository membership verification, permission
verification, checkout resolution, or runtime admission. GitHub App and installation
observations alone do not establish complete repository-selection authority. A future verifier and immutable selection
producer must supply those facts before repository deployment can become available.

- HTTP 400: correct malformed input, unsupported fields, duplicates, or invalid refs.
- HTTP 403: obtain the exact binding or Secret operation permission.
- HTTP 404: inspect the exact Namespace and resource references.
- HTTP 409: read the binding again and submit its current generation deliberately.
- HTTP 503: repository deployment remains unavailable. Clear the selection to use
  the existing deployment flow.

After an ambiguous PATCH response, read the binding or Agent through its authorized
GET route before deciding to submit another mutation. PostgreSQL stores mutations
and their audit events in one transaction. See [test setup](../testing/postgresql.md#repository-draft-definitions)
for the source verification boundary.
