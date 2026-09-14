# GitHub credential gateway MVP

Status: **Accepted implementation direction; implementation and qualification pending.**

This proposal implements the [platform design](../docs/design.md#repository-access-profiles).
It supersedes the archived [repository modes](archive/20-repository-access-modes.md)
and [native read milestone](archive/2026-09-10-github-read-mvp-release.md) for new
GitHub gateway work. Historical source acceptance remains valid at its original
scope. Current [feature references](../docs/reference/README.md) describe the
components that exist today.

## User outcome

An authorized Agent reads repository metadata, clones and fetches over HTTPS,
and uses ordinary direct `git push` when its admitted repository grant explicitly
permits writes. A read grant never implies a write grant. The service authorizes
the exact operation and repository, then substitutes a real GitHub credential
immediately before dispatch to the fixed, TLS-verified GitHub origin.

Initial writes use the repository's read-write grant without an additional OCE
branch allowlist or human publication step. Qualified Git ref updates include
branch/tag creation, update, force update and deletion, subject to GitHub's own
permissions and repository rules. Stronger branch restrictions, PR-only workflows
and approval policies are future capabilities. Keep explicit request-inspection
and policy interfaces so those capabilities can later evaluate all destination
ref updates before a push is submitted.

Ordinary local Git and fetched repository history remain visible to the Agent.
This profile does not provide history isolation or a generic forwarding proxy.
PR creation, additional API routes and Git extensions are later scope requiring
explicit protocol selection and qualification; unsupported requests fail closed.

## Service and authentication

Create `apps/credential-gateway` as an external TypeScript service with its own
Deployment, Service, scaling, readiness and shutdown lifecycle. Use Node HTTPS/TLS
and bounded streams with existing service libraries. Each replica composes local
mediation, broker, issuer and custody application services against shared
OCC/State/IAM contracts. No provider-token RPC or serialization of process-local
credential handles is needed between these local owners.

The Agent receives a cryptographically random opaque OCE bearer through its
execution-owned delivery path. This is a real secret credential accepted only by
OCE; it is not a GitHub-valid token. Store its verification hash and immutable
binding to admitted root Work, execution, revision, repository and grant. Commit
that binding before delivery. Reject unknown, expired, closed or revoked bearers
and alternate caller credentials. Never log bearer material or put it in remote
URLs, command arguments, ordinary revision metadata or durable client config.

Server-authenticated TLS protects Agent-to-gateway traffic. Bearer possession
does not establish physical container origin: a copied bearer can exercise its
still-current bound authority. Agent-to-gateway mTLS and protected originating
execution proofs are future profiles with their own key custody and runtime
qualification. Neither is a prerequisite for this bearer MVP.

## Current authority and custody

Every metadata, Git discovery, fetch or push operation requires real current OCC
and selected IAM authorization. The gateway retains the admitted root Work and
execution binding across asynchronous processing; it never replaces them with
whichever Work is currently active. Token refresh does not renew Work authority.
OCC unavailability denies new dispatch. Closure, cancellation, revocation and
finite enforcement bounds govern entered work and subsequent credential use.

Canonicalize the requested repository and operation and retain immutable request
facts before authorization. For push, inspect all ref commands and negotiated
control data before releasing provider credentials or sending the push. Preserve
exact command-to-forwarded-byte correspondence while streaming the bounded pack.
Apply aggregate request, mint and credential-overlap budgets across replicas.

GitHub App keys and installation tokens remain in trusted service custody. Share
encrypted token material, inventory, mint claims, original attempt records and
cleanup obligations through PostgreSQL. Protect encryption keys outside SQL;
authenticate ciphertext against its immutable inventory context. Existing crypto
and provider code may be reused, but a single-writer filesystem store or
per-replica memory map does not provide the shared custody contract.

Only confirmed no-issuance, revocation or expiry releases credential capacity.
Unknown mint or dispatch outcomes retain their original target and accounting.
Closure does not erase late-token cleanup duties. Shutdown stops admission and
joins entered operations while retaining unresolved obligations. An HTTP success
status alone cannot establish a successful Git push: retain actual per-ref
results, partial rejection and unknown outcomes. Never automatically replay a
push after an uncertain submission or lost acknowledgment.

## Routing and containment

Scoped DNS for selected Agent workloads resolves `github.com` and
`api.github.com` to the gateway. Provide the appropriate public CA trust and
protected server certificate material for that route. Gateway upstream resolution
and public trust must remain independent, preventing a DNS loop or acceptance of
the Agent interception CA as public GitHub authority.

Effective network controls must prevent direct GitHub, alternate DNS, proxy or
tunnel bypasses on the selected profile. DNS rewriting alone is not containment.
Audit additive policies and actual service translation on the installed runtime.
Use scoped CoreDNS and Kubernetes/network integration; a particular old native
node-fence implementation is not an automatic service dependency.

## Delivery and verification

Deliver bounded slices with explicit interfaces and preserve existing source
ownership. Existing native/Rust transport, identity, publication and host
connector code is optional reuse or a separate future profile. Its accepted
tests do not qualify this new service; its unfinished assembly does not gate it.
Real root Work admission, current OCC/IAM, custody and lifecycle behavior remain
required within the new implementation.

1. Implement admitted read/read-write access, bearer issuance and closure, shared
   SQL ciphertext custody, distributed mint claims and original outcome records.
2. Build the standalone HTTPS service and real metadata/Git request path. Qualify
   bounded parsing, auth challenges, streaming, gzip and chunk framing, push
   control data, large uploads, per-ref outcomes and cancellation.
3. Package the service and regular Agent startup/client configuration. Install
   scoped DNS, trust and effective network policy. Validate useful repository
   work through that normal path and actual configured components.

Required evidence includes real PostgreSQL and two-replica accounting; unknown,
revoked and cross-scope bearer denial; read-only push denial; allowed read/write
operation results; policy/Work closure races; provider credential absence from
Agent-visible state; replica loss during read, push and mint; and installed
TLS/network bypass denial. Use real Git clients and actual OCE components.
Controlled external peers may qualify their stated boundaries, but do not prove
live GitHub permissions or installed runtime enforcement.

Implementation changes must update the relevant feature references, client and
operator guides, flows, and troubleshooting together. This documentation change
supplies no new executable behavior, release acceptance or deployment claim.
