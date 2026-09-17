# GitHub Issuer Policy and Token Lifecycle

Draft supporting specification for [RFC 0034](../0034-github-app-credentials.md).
See the [series index](../README.md) for scope and the other contracts.

## Permissions and issuer behavior

| Grant                             | Fixed profile         | Exact permissions                                        |
| --------------------------------- | --------------------- | -------------------------------------------------------- |
| `read` and separate preparation   | `repository-read-v1`  | `metadata:read`, `contents:read`                         |
| `read-write`, including its reads | `repository-write-v1` | `metadata:read`, `contents:write`, `pull_requests:write` |

One immutable profile serves every lease and operation of the grant. Reads under
read-write access use its write token; preparation retains a distinct read-only
grant and never borrows execution material. The write token carries powers beyond
individual routes, including provider operations the gateway denies. Exact
routing and protected custody contain that power; repository rules apply without
an App bypass. Workflow, administration, issues and secrets permissions are excluded.

### Issuance and validation

The issuer signs an App JWT outside execution and calls
`POST /app/installations/{id}/access_tokens` with one explicit `repository_ids`
entry and exactly the grant's fixed permissions. Never use installation-wide
defaults, a narrower per-route cache or broader fallback. Validate returned
repository identity, exact permissions and actual expiry before eligibility;
unexpected/incomplete output stays cleanup-only. Protected material and inventory
must have a known durable commit before use.
[Installation token creation](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)

### Lifetime and revocation

| Credential         | Provider lifetime                                           |
| ------------------ | ----------------------------------------------------------- |
| App JWT            | Expires within ten minutes.                                 |
| Installation token | Expires after one hour; no documented custom TTL parameter. |

Tokens are opaque variable-length strings. Shorter OCE leases do not shorten
provider validity; App key rotation does not revoke issued tokens.
[App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[installation token lifetime](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

Declare new-token issuance, provider-fixed lifetime, and individual revocation
using protected token material, without assumed mint-idempotency or lost-token
lookup. Revoke each known token with `DELETE /installation/token`; `204` confirms
revocation. Retain protected material through cleanup: a hash cannot call this
endpoint. Installation suspension/uninstall requires separate operator
authorization and is never an automatic fallback.
[Revocation](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)

## Policy enforcement

Enforce the [same effective grant](credential-broker-v1-spec.md#one-effective-grant-two-enforcement-points)
at minting and on every mediated request. GitHub's token API accepts repositories
and permission categories, without general fields for branches, arbitrary paths,
individual mutations, current visibility, OCE work, or originating containers.
Naming a profile cannot encode those restrictions.
[Token parameters](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)

| Constraint               | Enforcement                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Repository and profile   | One numeric repository and the grant's exact immutable profile.                         |
| Operation and parameters | Closed route catalog, exact Git updates and bounded canonical PR input/results.         |
| Current authority        | Online OCC/IAM, Work, assignment, lease and finite operation permit.                    |
| Execution binding        | Validated bearer resolves original server-owned context; physical origin is not proven. |
| Destination security     | Exact repository binding; ongoing visibility/ownership protection is a known MVP gap.   |

### Narrowing and additions

Current policy may deny or narrow allowed operations within the admitted ceiling
without switching token profiles. Changing the admitted repository, profile or
Work context requires fresh admission/execution and the selected isolation
transition. Old inventory, receipts and canonical target holds survive. No
per-request profile fallback can erase those obligations.

New operation classes require explicit versioned request/result and permission
contracts. Ordinary Contents permissions do not restrict arbitrary paths, refs
or reviewed objects. Fine-grained publication policy, new provider permissions
and additional routes remain outside this MVP.

## Refresh and overlap

### Cache identity

Cache by exact binding/profile, Namespace/Agent/revision, assignment/incarnation,
original work and access lease/purpose, repository/fixed profile, and
generation. Never substitute broader admitted scope or share tokens across
independently revocable leases. Every use requires current online authority, including reads and credential
maintenance; native delivery also requires current authority.

Retain one current token and at most one same-profile replacement. There is no
second read-token cache in a read-write lease. Concurrent requests and retained attempts share one durable lease mint
claim and two aggregate outstanding slots; preparation has its own read-only lease.

### Replacement limits

| Limit             | Requirement                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh threshold | Begin replacement below five minutes remaining, while the original lease remains open.                                                                                                    |
| Mint concurrency  | One active durable mint claim per lease; one original provider attempt per issuance.                                                                                                      |
| Overlap           | Two aggregate outstanding slots per lease across current and retained attempts, counting reservations, dispatched/unknown attempts and provider-valid current/replacement/retired tokens. |
| Capacity release  | Only definite no-issuance, confirmed revocation, or evidenced expiry frees a slot. Local cache retirement does not.                                                                       |
| Full capacity     | Deny minting; never evict unresolved records. Admission and status must expose these limits.                                                                                              |

After failed refresh, the broker may serve a recorded unexpired token only while
original authority, exact scope, and delivery/use checks pass. Do not run
autonomous refresh after lease closure. Respect provider throttling on permitted
retries and the shared no-remint rule for uncertain issuance.

### Authority outages

Require current online OCC authority for every GitHub dispatch: reads, writes,
issuance, renewal, and credential maintenance. Existing tokens and unexpired
leases do not permit offline dispatch. If any required authority, provider,
custody, or inventory check is unavailable, deny the affected operation.
Independently retained cleanup still owns its obligations and needs its own
applicable authority; work authorization cannot stand in for cleanup authority.

The shared broker's qualified offline-read/maintenance option is future profile
work and is not enabled here. Accepted upstream operations may finish; report
their outcomes and cleanup separately from the denied next operation.

### Unknown-mint hold

An unknown mint holds the stable provider target:

| Target component | Identity                                                     |
| ---------------- | ------------------------------------------------------------ |
| Platform         | OCE Installation.                                            |
| Provider         | Canonical GitHub host, App identity, GitHub installation ID. |
| Resource         | Repository ID.                                               |

The hold blocks issuance across binding aliases, Namespaces, profiles/permission
changes, key or binding generations, revisions, incarnations, leases, and modes.
Retain original ownership and permission evidence; configuration changes or
renewed admission cannot bypass the hold. OCC's trusted inventory enforces it
without disclosing another Namespace's records, prioritizing complete accounting
over availability.

Resolve the hold only with definite no-issuance evidence, evidence that expiry
has elapsed, or verified sufficient administrative revocation. New request IDs
and time since a timeout do not resolve it. Broader remedies require an
identified scope and corresponding operator authorization. Other targets remain
independent; never automatically switch accounts to bypass a hold.

### Client behavior

Mediated dispatches can use eligible replacement tokens without restarting the
requester. Native mode supplies eligible tokens to new Git helper invocations
and `gh` children; existing environments do not rotate. Dispatched operations
may fail on expiry or revocation. Neither mode automatically replays an ambiguous
push, PR mutation, or other write.

## Related specifications

- [Overview and contract](github-app-v1-spec.md)
- [GitHub Repository Scope and Publication](github-publication.md)
- [GitHub Client Credentials and Mediated Access](github-mediated-access.md)
