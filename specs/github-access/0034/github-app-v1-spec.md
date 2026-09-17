# GitHub App Access v1 Specification

Provider-specific contract for [RFC 0034](../0034-github-app-credentials.md), using
[Credential Broker v1](credential-broker-v1-spec.md). Status: draft. **Must**
identifies a conformance requirement. This spec describes target behavior;
documentation does not qualify an implementation.

## Scope and proposed release selection

V1 targets organization-managed GitHub.com App installations, one private repository per
Agent execution and credential, HTTPS Git, and the bounded [Git and PR-helper workflow](github-mediated-access.md#command-qualification). Personal
credentials, GitHub Enterprise hosts, SSH, LFS, submodules, arbitrary uploads,
and unlisted operations are excluded.

| Mode     | Release scope                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Mediated | Required in production under [OCE’s credential boundary](../../../docs/design/safeguards.md#secret-access). |
| Native   | Development/testing only; never a production fallback.                                                      |

The MVP selects one Kubernetes/gVisor profile. `read` permits repository metadata
and HTTPS clone/fetch; explicit `read-write` adds direct push and minimal
same-repository PR creation. Verified checkout, genuine root Work and current
operation authority are required. Root-only execution may qualify first; helpers
need proven shared context, aggregate limits and stop ownership. Broader Work,
independently admitted children and public Stop/Start controls remain deferred.

Local Git remains ordinary Git. The mediated path supports direct `git push`
and the bounded `oce-github pr-create` helper; general `gh pr create` and issue/PR
reads are outside its closed catalog. Model proxies or token-forwarding helpers
alone do not establish production GitHub mediation.

Execution and logical work may be explicitly uncapped. Access/enforcement leases,
provider credentials, and operation time/resource limits remain finite and fit
every configured original horizon. No universal Agent or job duration is imposed.

## Client versions

Git 2.55.0 is the proposed Git qualification pin. Pin the `oce-github` helper
with the Agent image; general `gh` compatibility is not selected.
Evidence must pin binaries, image digests, configuration, and exact command
variants. Another version needs its own compatibility evidence and cannot
qualify these pins. [Git credential helper interface](https://git-scm.com/docs/gitcredentials),
[gh environment](https://cli.github.com/manual/gh_help_environment)

## Enrollment and configuration

### Enrollment

The [proposed Agent configuration](repository-configuration.md) is admin-managed
and frozen into `AgentRevision`; it is not an existing public repository field.
OCC authorizes the exact Namespace administrator, Agent/Configuration operation,
and each referenced binding, broker, and Secret. Invocation allowlists and the
App's broader installation access cannot replace these service grants.

1. An Installation operator selects the issuer and trusted GitHub.com endpoints.
   The organization installs the App on explicit repositories within supported
   permission profiles.
2. A Namespace administrator binds the exact App installation to its
   `SecretBroker`, referencing protected signing material through the selected
   backend. OCC verifies Namespace ownership and authorization for the broker,
   Secret, and integration binding. Public resources and revisions contain only
   references and metadata.
3. The issuer verifies App/installation identity, organization ownership,
   repository membership, and available permissions against GitHub. Unavailable
   checks report unverified or degraded enrollment. Configuration alone is not
   verification; enrollment neither mints a runtime token nor activates an Agent.
4. OCC admits one private repository grant for an Agent revision,
   recording the binding/profile versions, repository ID and canonical name,
   permission profile, mode, checkout commit, lease horizon, and configured
   limits. Authorize every referenced resource. Missing support, multiple
   repositories or unresolved scope denies admission.

### Admitted data

Provider data has this closed shape. Field names are illustrative; this is not a
public REST API:

```ts
type GitHubAccessV1 = {
  schemaVersion: 1;
  issuerBindingRef: OccReference;
  issuerBindingGeneration: number;
  providerProfileVersion: 1;
  repositoryId: number;
  repositoryName: string; // verified owner/name; ID is authoritative
  accessProfile: "read" | "read-write";
  tokenProfile: "repository-read-v1" | "repository-write-v1";
  accessMode: "native" | "mediated";
  checkoutCommit: string; // resolved full object ID for the admitted repository
  policyDigest: string;
  policyGeneration: number;
  accessHorizon: Timestamp | null; // explicit uncapped grant ceiling; leases stay finite
};
```

`OccReference` and `Timestamp` use validated OCC codecs. `read` is the default;
its token profile is `repository-read-v1`. Read-write fixes
`repository-write-v1` for every allowed operation, including reads. The binding
resolves host, App ID, installation ID, organization identity and protected key
version. Reject caller-supplied hosts, accounts, keys, permission maps and longer
horizons, and malformed or cross-Namespace references.

### Configuration changes

Ongoing ownership/visibility revalidation is a
[known MVP gap](github-publication.md#destination-security-and-accepted-limits). Exact numeric
repository binding remains required; display-name changes cannot redirect a grant.
Enrollment changes require revalidation. Configuration/profile edits require new admitted revisions; revocation
can deny active access immediately. Both increases or decreases to admitted permission scope require
a fresh Pod/gVisor sandbox and eligible context before serving the changed
authority; a new container in the old Pod is insufficient. Existing connections,
background processes, caches, and queued requests cannot inherit the new context.

Planned key rotation follows the
[shared sequence](credential-broker-v1-spec.md#configuration-and-admitted-records):
verify the replacement against the same App/installation, select its generation
and close old leases, then admit new revisions. Failed verification preserves
the working binding.

## Repository preparation

1. **Authorize and contain.** OCC authorizes a separate read-only preparation
   lease for the admitted candidate. Compute provides execution and an empty
   candidate-owned staging volume; SandboxDriver establishes and verifies
   admitted containment. OCC gates checkout and Harness startup on the required
   observations. OCC constructs and hands off the separate preparation authority;
   readiness or a pending assignment grants nothing. Use its own read-only
   bearer/lease and token; never borrow execution material.
2. **Fetch and verify.** Fetch the exact repository and resolved commit using
   fixed configuration and safe argument arrays. Disable repository hooks, setup
   scripts, submodules, and LFS. Reject redirects, traversal, symlink escapes, and
   inherited helpers. Verify the commit and repository identity, stop
   preparation, and close its lease before handoff. Neither credentials nor
   preparation authority enter the resulting checkout.
3. **Promote safely.** Preserve the active workspace and uncommitted changes.
   Compute owns the explicit staging/promotion protocol and must observe
   previous writers terminate before replacement. Backends without safe handoff
   are unsupported. Preparation failure preserves the serving revision; rollback
   requires fresh admission and leases, never revived tokens or execution
   generations.

## Acceptance

The MVP requires the shared broker, live scope/revocation evidence, safe
preparation, genuine root Work, online-only dispatch, bearer binding/denial and
selected read/write protocols. Prove concurrent-request custody and dispatch races,
unknown outcomes, independent finalization and observed writer handoff with one
active gateway and identical-version restart. Recipe loading and a positive
controlled second-backend operation prove extensibility, not live provider support.
Native helper evidence supports development/testing only. An issuer or helper alone
cannot satisfy the [acceptance matrix](lifecycle-acceptance.md#acceptance-matrix).

## Related specifications

- [GitHub Repository Scope and Publication](github-publication.md)
- [GitHub Issuer Policy and Token Lifecycle](github-issuer-policy.md)
- [GitHub Client Credentials and Mediated Access](github-mediated-access.md)
