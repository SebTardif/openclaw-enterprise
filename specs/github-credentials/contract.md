# GitHub credential contract

[RFC overview](../github-credentials.md). This companion specifies the proposed unmerged repository capability for admission, worker, Compute and credential-service implementers. Existing platform owners remain authoritative for their unchanged behavior.

## Admission and authority

An Agent requests `repositoryRef` and an optional `profile`. Resolution supplies the selected profile, configured `providerId`, and grant identity `{providerInstanceId, repositoryId, grantId}`. These identify the upstream instance, native repository and authorized grant independently. Opaque grant identities are nonempty, at most 512 UTF-8 bytes, without ASCII controls.

OCC checks Namespace policy and selected Driver/Provider membership. The immutable revision freezes Driver ID/implementation, resolved bindings and `deadlineWallMs`, an absolute deadline. Admission and queued work commit through State before external session creation. Later configuration cannot widen the revision. Revalidation rejects drift while retaining access to restrictive cleanup.

The receiving credential service independently resolves Namespace/repository/profile policy from its registry and exactly compares the expected frozen grant. Before creating authority or files, it rejects binding/profile drift and invalid duration, enforces the registry and service duration ceilings, and bounds the session by the original absolute deadline.

One configured GitHub App installation supports at most sixteen distinct repository bindings per Agent. Each session fixes one repository, grant and deadline. Repository-set sessions remain an independent unselected alternative.

| Profile             | Exact token permissions                                                  | Operations                                                                          |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `git-read`          | `metadata:read`, `contents:read`                                         | Clone, fetch and checkout. Push discovery/RPC deny before mint or dispatch.         |
| `git-write`         | `metadata:read`, `contents:write`                                        | Native Git writes subject to repository rules. This is the omitted-profile default. |
| Explicit `git-full` | `metadata:read`, `contents:write`, `pull_requests:write`, `issues:write` | Git and the selected API routes below.                                              |

Both Git-only profiles deny every API route. Reject `read-write`. Every issuance and replacement explicitly requests one repository and validates the complete permission map. Missing, surplus or inherited permissions fail without widening or ambient credentials. Selected read-first new assignments belong to later IAM work, not today's omission behavior.

Current authority is the team's App installation, including one-to-one chat. GitHub attributes API actions to the App. OIDC sign-in and permission to invoke an Agent do not delegate a user's repositories.

Later explicit personal mode uses the same repository App with service-owned user tokens and renewal secrets. Admission must bind consent, verified OCE/GitHub account, current requester and authority mode. Access intersects user, App, installation and OCE grants. OIDC/account, invocation, IAM and credential owners must qualify consent withdrawal, renewal/revocation, both modes and cross-user refusal. Personal failure must never silently fall back to team authority. Invocation/Audit and personal-mode owners must audit the current requester and selected authority separately from Git commit author metadata.

## RepoDriver operations

`RepoDriver extends Driver` has capability `repo`. Composition supplies it to OCC and worker through the existing selected-Driver model. There is no repository CRUD, public issuance API or generic broker resource. Common session/custody/lifecycle owners must not branch on provider names or assume one-hour tokens. The emitted credential service starts independently of worker/database dependencies.

The selected operations are:

```ts
resolve(input: {
  readonly namespaceId: string;
  readonly bindings: readonly RepositoryBindingRequest[];
}): RepositoryCredentialResolution;
open(input: OpenRepositorySessionInput, signal: AbortSignal): Promise<OpenRepositorySessionResult>;
status(sessionId: string, signal: AbortSignal): Promise<RepositoryCredentialSessionStatus | undefined>;
close(sessionId: string, signal: AbortSignal): Promise<RepositoryCredentialSessionStatus | undefined>;
```

`resolve` returns admitted `bindings` and configured `sessionDurationSeconds`, bounded by registry policy. `open` takes `namespaceId`, immutable `admissionId`, admitted `binding`, `durationSeconds`, `deadlineWallMs` and optional `recoverOnly: true`. Cancellation uses the supplied signal. Duration cannot extend the admitted deadline.

```ts
type OpenRepositorySessionResult =
  | {
      readonly kind: "created";
      readonly session: RepositoryCredentialSessionStatus;
      readonly files: RepositoryCredentialSessionFiles;
    }
  | { readonly kind: "recovered"; readonly status: RepositoryCredentialSessionStatus }
  | { readonly kind: "missing" };
```

Creation returns private files once. Recovery returns status only. `recoverOnly` can return recovered or missing and never creates authority. Missing is authoritative absence, distinct from unavailability. Missing `status` and `close` return `undefined`.

Public status contains exactly `sessionId`, `state`, `deadlineWallMs` and `binding`. Its state is `OPEN`, `CLOSED` or `DISPOSED`. Validate the complete private response before constructing fresh public snapshots and bindings for all four result paths. Disposal rejects active uses, active/pending/uncertain cleanup or auxiliary obligations. Historical expired/revoked counters may remain.

Permanent control refusal maps to `ScopeViolationError`. Unavailable, retryable or inconsistent control results map to `DependencyUnavailableError`. Reject wrong bindings, extended deadlines, creation on recovery-only and an OPEN close response. `maintenanceIntervalMs` is 30000 in this implementation, not a withdrawal guarantee.

Compatibility preserves opaque Driver identities and persisted payloads without a rename migration. Keep private validators, closed material schemas and no emitted runtime dependency from the private client DTO. Source guards, entrypoints and build consumers must agree. Guards detect regressions, not malicious-code isolation.

Custody retains separate issuance and streaming senders, original-object borrowing, disposal sealed before awaiting, and temporary-copy wiping before response disposal. Preserve retry semantics and introduce no test-only public API.

## Material delivery and recovery

The worker persists attempt identity before `open`, then session identity before handing private files to Compute. Claim ownership and phase updates fence concurrent workers. These checkpoints surround an external effect and are not a distributed transaction. State stores safe correlations and cleanup work, not a durable provider-token journal.

After a lost control response, reconcile the original admission. Recovery-only absence fences delayed creation. If matching material survives, retain it. Otherwise close known-undelivered authority before explicit replacement, preserving the original grant and deadline. Status cannot regenerate files. Outage cannot be treated as absence.

`RepositoryCredentialSessionFiles` contains UTF-8 `bearer`, `client.json`, `gitconfig`, `gh/hosts.yml`, `gh/config.yml` and optional `ca.pem`. The bearer has at least 32 random bytes and service lookup uses its digest. `RepositoryCredentialRuntimeBinding` supplies `repositoryRef`, `sessionId` and `deadlineWallMs`, plus either `kind: "new"` with files or `kind: "retained"` without them.

Compute validates the complete requested generation before publication. It owns immutable scoped Kubernetes Secrets, private 0700/0600 placement, atomic publication, complete-generation readiness, exact missing-subset repair and retirement using actual Pod references and UID/resourceVersion checks. A retained entry must match its original session.

Stock Git uses native configuration and credential-helper selection from effective remotes. Bounded `gh` routing selects the actual target. Reject ambiguous or conflicting selection without mutating a global selected-repository file. This requires neither a custom Git grammar nor verified-checkout startup gating.

## Request lifecycle

![Proposed admission, material delivery, request and cleanup lifecycle](request-lifecycle.svg)

Proposed lifecycle. Time flows downward, with requests and replies using normal sequence notation. This is not runtime qualification. [Editable Mermaid source](request-lifecycle.mmd).

1. The gateway resolves the bearer to a server-owned session and checks its exact repository/profile before acquisition. An exchange is one effective HTTP request, not an entire Git command.
2. A provider attempt acquires credentials on demand under the original grant/deadline. Concurrent waiters share acquisition and its fixed budget. Individual cancellation does not extend that budget. Last-waiter cancellation still retains capture and settlement responsibility.
3. Custody captures every observed token before scope/validity acceptance, including rejected and late material. Credential lifetime is independent of session lifetime. Renewal after idle expiry uses a fresh JWT and unchanged grant, retaining the same bearer/files beyond hour 13.
4. Dispatch requires sufficient remaining validity.

   - Validity covers the full remaining exchange budget plus margin. Trusted wall and monotonic time govern budgets. Backward wall time cannot extend authority or cleanup, and forward time alone cannot certify remote expiry.
   - After asynchronous preparation, recheck authority/validity synchronously before dispatch, then join I/O before releasing custody.
   - Drain-before rotation protects active pushes. Retiring a predecessor must preserve its replacement.

5. Cancellation retains settlement responsibility.

   - Timeout or cancellation requests a stop without proving settlement. Preserve original handles, outcomes and reservations. Unknown issuance blocks automatic remint.
   - Possibly accepted writes and invoked uncertain cleanup are not automatically replayed. Pre-invocation queue rescheduling is different.
   - Reconcile remote effects with bounded unique ownership markers. Report ambiguous, missing or truncated readback before separately authorized follow-up.

6. Stop and provider settlement have separate completion conditions.

   - The worker persists closing phases and registers owned cleanup before attempting closure. Close denies new use before cancelling exchanges. After the close attempt, the worker rechecks stop intent and retires exact owned runtime/material without waiting for provider settlement or `DISPOSED`. Unavailability or unsettled cleanup leaves work with the existing cleanup owner.
   - `CLOSED` retains cleanup capacity until actions, captures and auxiliary renewal authority settle. `DISPOSED` requires resolved obligations and actual finalization, not just a status predicate. One session must not finalize the shared signing key.
   - Confirmed GitHub revocation requires an observed HTTP 204. Other responses or lost acknowledgments remain uncertain. Runtime stop proves neither session closure, disposal nor provider revocation. Neither session state proves runtime termination.
   - Finite shutdown may exit with unresolved obligations. Elapsed grace does not settle them.

## Security and request bounds

App/TLS private material remains service-only, behind protected file ownership, permissions, ancestor and descriptor checks. Reject symlinks, nonregular/oversized inputs and replacement races. The Unix control channel is unavailable to Agents. Failed transfer must dispose still-owned candidate bytes, including failed descriptor close. Temporary-byte wiping is best effort, not forensic JavaScript erasure. Provider authentication is attached only by the upstream sender.

The Agent holds a confidential gateway bearer and the selected Harness's model credential. This proposal therefore does not establish an all-Agent credential ban. Bearer possession proves neither originating workload nor current human. Routing is not network confinement. Ordinary process/container/filesystem separation is the present trust assumption.

Authorize every effective request. Reject ambiguous framing and noncanonical targets, including traversal and encoded aliases. Fixed origins, canonical `github.com` identity, verified TLS/SNI and gateway port 443 are required. Discard inbound credentials, cookies and hop-by-hop fields, plus upstream authentication challenges. Allowlisted headers, reconstructed framing and validated/rewritten follow-up links preserve body text. There is no ambient proxy, redirect, retry, login or PAT fallback.

Selected routes use exact repository identity:

| Target                                                                    | Methods            |
| ------------------------------------------------------------------------- | ------------------ |
| `/OWNER/REPO.git/info/refs?service=git-upload-pack` or `git-receive-pack` | GET                |
| `/OWNER/REPO.git/git-upload-pack` or `git-receive-pack`                   | POST               |
| `/repos/OWNER/REPO`                                                       | GET                |
| Its `/pulls` and `/issues` collections                                    | GET, POST          |
| Their numbered items                                                      | GET, PATCH         |
| Its `/issues/{number}/comments`                                           | GET, POST          |
| Its `/issues/comments/{id}`                                               | GET, PATCH, DELETE |
| `/meta`                                                                   | GET                |
| `/graphql`                                                                | POST               |

API routes require `git-full`. Query, media and framing policy remain bounded, including pagination, repository-ID links and bodyless 204 responses. Every GraphQL POST is a possible write. There is no field or branch filtering, and GitHub may return permitted public information. Arbitrary API coverage, whole-command preflight, administration, extra workflow permissions, SSH, LFS and extra-repository submodules are excluded.

These source defaults are observable limits, not final-artifact qualification:

| Resource                               | Default                                   |
| -------------------------------------- | ----------------------------------------- |
| Sessions including cleanup             | 16                                        |
| Credential slots                       | 2 per session                             |
| Provider actions                       | 1 active, 64 queued                       |
| Sockets                                | 64 per listener                           |
| Exchanges                              | 32 total, 4 per session, 1 per connection |
| Headers                                | 32 KiB, 64 pairs                          |
| Target / control body                  | 8 KiB / 16 KiB                            |
| Fetch input                            | 1 MiB                                     |
| Push input and output                  | 256 MiB each                              |
| API input / response                   | 1 MiB / 8 MiB                             |
| TLS, header, connect, stall deadlines  | 5 seconds each                            |
| API/fetch input, first response header | 30 seconds each                           |
| Exchange / provider action             | 5 minutes / at most 30 seconds            |
| Validity margin / shutdown grace       | 60 seconds each                           |
| Token / renewal material / PEM         | 16 KiB / 16 KiB / 64 KiB                  |

Wire and decoded input bounds are independent. Queue/input time counts toward the original total budget, and push input uses the exchange deadline. Incoming header timing follows TLS handshake. Upstream response-header timing begins after upload unless headers already arrived. Overrides must be positive safe integers under tested policy. Unknown keys reject, zero is never unlimited, and hard material/action caps remain. Saturation and rejection cannot drain indefinitely or discard obligations. HTTP/1.1 is supported, with no CONNECT, HTTP/2, arbitrary forwarding or transparent interception. Node 24 and `gh` 2.100.0 define the source-qualified client profile, not universal CLI compatibility.

## Restart and future obligations

Worker replacement may retain sessions when the credential service and delivered material survive. Service replacement loses sessions and provider inventory, requires a new material generation and can replace the Agent Pod. Issued tokens may survive until expiry. Repeated crashes defeat an aggregate outstanding-token bound derived from process-local limits. Invalidation is not disposal or revocation, and interrupted work is not seamless continuation.

Credential custody and State owners retain restart-safe issuance/custody/outcome accounting: preserve original obligations, fence predecessors and reconcile before issuance. Repeated-crash proof must demonstrate cleanup and refusal of unsafe remint/replay. Encrypted material recovery is a separate, deferred mechanism. No JWT/Postgres recovery design is selected, and persistence alone cannot guarantee exactly-once provider effects.

Worker, Compute and Harness owners separately retain safe material refresh or explicit resume, workspace ownership and observed predecessor writer termination. Ordinary-Agent model/tool and real-Git evidence must establish continuity without stale credentials, concurrent writers or uncertain-effect replay.

Other retained successors have distinct closure requirements:

- IAM/Work owns explicit read-first new assignments, root Work, fresh per-effect authorization, durable dispatch permits, PR submission identity/deduplication and unknown outcomes.
- Identity/Compute and credential receivers own disabled preparation, independently observed execution, fresh immutable admission, delivery/recheck/enable and protected receiving evidence before acquisition or dispatch.
- Egress owns mandatory routing and authenticated currentness ordered against withdrawal. Measure closure of new and active use within 30 seconds, including renewal loss and any selected tighter bound. Network, repository composition and protected currentness require separate evidence.
- Custody/State owns encrypted inventory, canonical holds, original-key retirement and compatibility drains. Repository-publication owners retain per-ref receive-pack/receipts, approved retained candidates, branch policy and ownership/visibility protection.
- Compute/Harness owns dedicated/gVisor delivery, readiness, retirement and retained-workspace writer exclusion. Runtime/Compute owns helper aggregation, independent children, stop/start/result delivery, compatible context restoration and host-loss recovery.
- OIDC/account retains identity-only login and discarded login tokens. Invocation/Audit must distinguish the current requester from deployer and reader using safely observed or explicitly unknown facts. Native-token and offline-read modes require independent qualification and are never fallbacks.

These later obligations do not become new gates for the narrow refinement. Their owners must update current documentation with exact-source evidence when each outcome is delivered.
