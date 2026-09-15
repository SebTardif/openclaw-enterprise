# Repository binding definitions and Agent drafts

Authenticated administrators can save Namespace-owned repository bindings and
Agent draft selections. Bindings remain `unverified`; nonempty selections block
deployment with HTTP 503 and
`REPOSITORY_VERIFICATION_UNAVAILABLE` before revision, queue, or Compute effects.
Empty selections retain the existing deployment flow.

## Binding API

| Method | Route                                                     | Permission                                   |
| ------ | --------------------------------------------------------- | -------------------------------------------- |
| POST   | `/namespaces/:namespaceId/repository-bindings`            | Namespace-scoped `repository_binding:create` |
| GET    | `/namespaces/:namespaceId/repository-bindings/:bindingId` | Exact binding `read`                         |
| PATCH  | `/namespaces/:namespaceId/repository-bindings/:bindingId` | Exact binding `update`                       |

POST accepts four fields:

- `appId` and `installationId`: positive safe-integer **GitHub** identifiers,
  asserted by the administrator, not enrollment evidence or an OCC Installation selector.
- `repositoryIds`: 1–32 distinct positive safe integers.
- `keySecretRef`: an existing exact same-Namespace OCC Secret reference. Create
  and update require its `operate` permission; metadata `read` is insufficient.

Responses never contain signing-key material, tokens, leases, or authorization handles.

PATCH replaces those four descriptor fields and requires `expectedGeneration`.
`generation` starts at one and advances once per successful update; stale expectations
return HTTP 409. ID, Namespace, creation time, and `unverified` state are server-owned.
There is no DELETE or list API. Bindings prevent deletion of their referenced Secrets.

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

Usual required Agent fields apply, including `configurationId` on PATCH.
Omission creates an empty selection or preserves it on update; supplying
`repositoryAccess` replaces the selection, and `repositories: []` clears it.
Drafts allow at most eight distinct binding/repository pairs, each repository in
its binding's declared set. Unknown fields, schema versions, duplicate pairs,
views, and enabled publication arms are rejected.

Checkout references accept a full 40-hex commit or a fully qualified
`refs/heads/...` or `refs/tags/...` Git ref, at most 256 UTF-16 code units. Control characters,
spaces, Git revision operators, empty or dot-prefixed path components, `.lock`
suffixes, `..`, `@{`, and a trailing dot are rejected. Ref validation does not
resolve the ref or prove its existence.

Selection requires ordinary exact Agent create/update and Configuration `read` permissions,
plus exact binding and signing-Secret `operate`; binding `read` is insufficient.
References cannot cross Namespaces. Binding generation changes never rewrite saved
drafts or immutable AgentRevisions. Agent updates have no draft version guard.

## Inactive boundary and troubleshooting

Saving does not establish GitHub enrollment, repository membership, permissions,
resolved checkout, or runtime admission. App and installation observations alone
cannot establish selection authority; activation requires a verifier and immutable
selection producer.

- HTTP 400: correct malformed input, unsupported fields, duplicates, or invalid refs.
- HTTP 403: obtain the exact binding or Secret operation permission.
- HTTP 404: inspect the exact Namespace and resource references.
- HTTP 409: read the binding again and submit its current generation deliberately.
- HTTP 503: clear the selection to use the existing deployment flow.

After an ambiguous PATCH, GET the exact binding or Agent before resubmitting.
PostgreSQL commits mutations and audit events atomically. See
[test setup](../testing/postgresql.md#repository-draft-definitions) for verification limits.
