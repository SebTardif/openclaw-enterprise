# GitHub Repository Scope and Publication

Draft supporting specification for [RFC 0034](../0034-github-app-credentials.md).
See the [series index](../README.md) for scope and the other contracts.

## Repository scope

### Admission and grant selection

OCC admits one private GitHub.com repository by numeric identity for each Agent
execution. Its immutable `read` or `read-write` grant fixes the token profile
and original Work context. IAM checks requester invocation separately from the
service's repository authority. Chat text, local remotes and personal GitHub
permissions grant nothing. Multiple-repository execution is outside the MVP.

Each request selects the original server-owned grant through its validated
Agent access token and checks current Work, assignment, lease and IAM authority.
Preparation has a separate read-only grant and never borrows execution material.
The [broker contract](credential-broker-v1-spec.md#current-authority-and-workload-origin)
owns currentness; ending a model turn does not close logical Work.

### Trusted publication

The gateway permits direct push and independent same-repository PR creation
under an explicit read-write grant. No retained candidate, human approval,
branch allowlist or provenance check is required. A PR head may have been created
by another execution and need not follow this execution's push. GitHub repository
rules and permissions apply without an App bypass.

#### Direct push

Permit all valid refs GitHub accepts, including branch/tag creation, force
updates, deletion and multiple updates. Capture the complete bounded receive-pack
command prefix, validate every update, authorize its immutable facts and digest,
then forward the exact prefix unchanged and stream bounded PACK data with
backpressure. The permit binds the prefix digest; a complete-body hash is later
outcome evidence, and partial hashes must be labeled. Git validates PACK/object
contents. This does not establish reviewed contents.

Commit dispatch intent before submission. Retain unpack and per-ref results;
HTTP 200 alone does not prove success. Possible submission, timeout, cancellation,
process death or uncertain receipt commit preserves the original known/unknown
outcome and never licenses automatic retry or failover. A later intentional push
needs fresh authorization and its own receipt.

#### PR request and result

Accept only `POST /repos/{owner}/{repo}/pulls` on `api.github.com`, for the admitted
repository, with bearer authentication, JSON and one canonical lowercase UUIDv4
in `X-OCE-Operation-Id`. Reject query parameters, compression, duplicate headers,
caller-selected API versions and ambiguous framing.

| Field          | Contract                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`        | Required nonempty string, at most 256 UTF-8 bytes; no CR/LF or NUL.                                                                                                           |
| `head`, `base` | Required distinct unqualified branch names, at most 1024 UTF-8 bytes each; validate `refs/heads/<name>`. Reject owner prefixes, full refs, SHA/revision expressions and URLs. |
| `body`         | Optional string, default empty, at most 60 KiB UTF-8.                                                                                                                         |
| `draft`        | Optional boolean, default `false`.                                                                                                                                            |

Reject unknown fields, arrays/null, wrong types, invalid UTF-8/JSON, unpaired
surrogates and duplicate decoded keys. Both input and canonical output fit
64 KiB, including escaping. Serialize owned UTF-8 JSON in fixed order `title`,
`head`, `base`, `body`, `draft`, `maintainer_can_modify`; set the last field to
`false`. The versioned digest binds all bytes, method, route, numeric repository
identity and the fixed API version. Retain these bytes unchanged through dispatch;
never forward the caller's original body, bearer or operation-ID header upstream.

Bound the provider response at 1 MiB on wire and after decoding. Never forward
or retain whole provider JSON, nested repository/user objects, title/body echoes
or raw errors. A successful projection contains only operation/receipt IDs,
PR ID/number/URL, open state, draft flag and head/base repository IDs, refs and
observed SHAs. Require `201`, exact repository IDs, requested branches/draft,
valid SHAs and `https://github.com/<admitted owner>/<repo>/pull/<number>`.
Preserve provider IDs as lossless decimal strings and require a positive safe
integer PR number. Response SHAs are observations, not approved or locked commits.
Malformed, oversized or mismatched success responses are unknown outcomes.

#### One submission per retained operation

Use shared PostgreSQL uniqueness on `(accessId, clientOperationId)`, independent
of bearer bytes and lease renewal. Bind original Work/execution/assignment and
canonical request digest. Authenticate and check current operation authority
before claiming or disclosing any existing state, including conflicts.

1. Atomically claim the key/digest before credential preparation. An existing
   key returns retained pending/result/error/unknown state, or conflicts on
   changed contents; it never mints or submits again.
2. In the same State transaction as authority, closure and capacity checks,
   consume `claimed -> dispatch-admitted`, retaining one dispatch ID and receiver
   incarnation. Only a known commit gives the original receiver one-use authority.
3. An uncertain commit needs exact readback. Only the original live process and
   registered permit owner may proceed through the synchronous final submission
   gate. Another request, worker-claim expiry or restart cannot reconstruct it.
4. Register independent finalization before dispatch, consume the permit once,
   and submit once. Finalization has cleanup bounds independent of the connection,
   cancellation and request deadline. Return success only after known receipt commit.

Retain original claim, dispatch, receiver, digest, timestamps, admission evidence,
submission state and bounded safe outcome. Confirmed pre-submission failure is
`not-submitted`; replay returns its stored failure without resubmission. Provider
5xx, redirects, timeouts, malformed results or uncertain commits after possible
submission remain `outcome_unknown`. A provider refusal is not proof that an
existing PR belongs to this operation.

Retain keys throughout active access, closed-access receipts for at least 30 days,
and unresolved obligations until resolved. Never reuse access IDs or erase keys
while they could authorize replay. No PR reconciliation endpoint or rollback is
selected. A fresh operation ID is an explicit caller decision; this guarantee is
at most one gateway submission per retained key, not a total PR-creation quota.

#### Later authorization modes

Human-approved retained-candidate publication, independent approval and finer
branch/object policy remain future capabilities. They do not gate direct-write
access in this MVP.

### Scope changes and closure

Changing the repository, profile or Work context requires fresh admission and
execution. Old inventory, canonical target holds and receipts survive. Closure
stops new dispatch and preserves independently authorized cleanup/finalization;
it does not reverse provider effects or prove physical writer termination.
Never reopen an old lease or replay an unknown operation during replacement.

## Destination security and accepted limits

**Known MVP gap — push destination security:** admission selects a private
repository, but ongoing ownership/visibility revalidation and controls preventing
it becoming public while access or writes remain outstanding are deferred.
Repository contents and PR text may become public. This accepted limitation is
not an MVP launch gate.

### Required checks

Retain exact admitted numeric repository binding on every route, fixed token
scope and current operation authority. Reject other repositories, forks,
redirects and unlisted mutation routes. An App's broader access cannot select a
different destination. The [runtime boundary](github-mediated-access.md#runtime-boundary)
must deny direct provider access and tunnels around the gateway.

### Other limitations

Mutable branches, copied bearers, combined write-token permissions, downstream
CI/notifications and absent total PR-create quotas remain accepted limitations.
Revocation cannot undo accepted provider effects.

## Related specifications

- [Overview and contract](github-app-v1-spec.md)
- [GitHub Issuer Policy and Token Lifecycle](github-issuer-policy.md)
- [GitHub Client Credentials and Mediated Access](github-mediated-access.md)
