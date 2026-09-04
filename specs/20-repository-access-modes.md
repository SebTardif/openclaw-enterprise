# Repository access modes

Status: implementation direction; modes and configuration below are not yet supported or verified. This proposal refines repository access within the existing platform design. It does not replace current feature reference or alter the resource model.

## Delivery priority

Normal Git and `gh` are the primary implementation target. Stronger repository-access profiles are optional additions and may ship when their own implementation and acceptance evidence are ready. They must not become prerequisites of the native profile.

| Profile          | Runtime access                                                                                   | Benefit                                                            | Limitation                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Native           | Scoped short-lived GitHub App installation token and an ordinary Git checkout                    | Standard local Git and selected ordinary gh/API/HTTPS Git commands | Runtime code can read/reuse its bearer token and fetched history; upstream token revocation is separate from local disable |
| Mediated         | GitHub tokens remain trusted-side; ordinary checkout/history may be local                        | Protects upstream tokens and mediates supported network operations | Requires separately tested REST/GraphQL and smart-HTTP support; local history and offline Git remain visible               |
| History-isolated | Approved working-tree snapshot; upstream Git state and repository operations remain trusted-side | Withholds upstream historical objects from execution               | Requires a defined repository-service/tool interface; full native Git semantics are not promised                           |

## Credential and authority contract

All profiles keep platform long-lived model credentials, GitHub App private keys, backend credentials and channel application credentials outside the untrusted tool runtime. The native profile explicitly permits only the scoped ephemeral GitHub installation token there. Model mediation remains a separate requirement; this proposal does not claim that existing model-credential runtime paths already satisfy it.

A trusted broker reads the App key through the selected protected SecretDriver/backend seam. It verifies current workload assignment, admitted profile and common Agent/repository authority before requesting installation tokens with explicit repository IDs and minimum permissions. Native returns that token to its runtime; other profiles retain it outside execution. GitHub defines installation-token expiry; a shorter local lease cannot shorten its upstream validity. Do not issue user-private broader authority into a shared workspace.

Test a pinned Git/gh command matrix using real clients: clone/fetch, local status/diff/log/branch/commit, scoped push and selected issue/PR/API operations. Installation permissions constrain available commands. Support credential refresh without storing tokens in platform-managed URLs, argv, logs, artifacts or persistent client configuration. A helper or environment variable does not make a native token unreadable to malicious runtime code. A changed environment outside a running process does not refresh that process.

Native authorization records issuance, not every subsequent command's human intent. Enforce any required branch/operation restrictions through upstream rules or a narrower permission set; wrappers cannot prevent direct API use. Explicitly allow only tested GitHub network destinations in native mode. Other profiles deny direct GitHub/token-issuance bypasses. Unknown/unimplemented profiles and dependency failures must never silently downgrade policy.

Revoke all affected outstanding native tokens on disable, grant/repository narrowing, mode change and runtime retirement/reassignment. Maintain protected inventory and revocation material across replicas/restarts; a lost memory cache or fingerprint alone cannot revoke a GitHub token. Record provider confirmation or pending/unknown with expiry. Local dispatch/issuance denial and containment do not guarantee immediate invalidation of token copies used outside the sandbox during a provider outage.

## History isolation contract

Credential injection alone does not prevent Git fetch from delivering old objects. Shallow/partial clones and deleting `.git` after cloning are not history isolation.

The strict profile materializes only an authorized snapshot at a server-approved commit and keeps upstream object databases, refs, packs, bundles, alternates, worktree links and caches outside execution, including transient state. The runtime edits files and submits bounded changes bound to the approved base/manifest. An agent may create its own empty repository; the protected property is withholding upstream history, not the spelling of a directory.

A trusted repository service must also withhold historical data from raw/blob/commit/compare/archive APIs, arbitrary old refs, PR diffs, remote command output, merge/rebase conflicts, stderr, comments, metadata and artifacts. No unrestricted gh API or remote git-show escape is allowed. Apply output policy or reject the operation. Explicit release of history requires a separately admitted context or a changed guarantee; it cannot occur while retaining the strict no-history claim.

Expose only documented tool/client operations. Full local log/blame/rebase/bisect and tools that derive versions from Git metadata need explicit alternatives or incompatibility. Trusted Git workers must not execute repository hooks, filters, credential helpers or project code with signing-key/backend access; isolate parsing and publication from secret-reading authority and constrain remotes, paths and resource use.

Entering strict mode from any history-permitting or provenance-unknown restored state requires a fresh runtime, workspace and conversation/session boundary. Do not inherit old object caches, transcripts, artifacts or recovered workspace data. Import working changes only through bounded review. Snapshot path/file-type/symlink/submodule/LFS handling and current-content inspection require their own tests. Withholding history does not prove approved current source or dependencies contain no secrets.

## Integration and acceptance

Select a profile in admitted Agent configuration/revision under operator policy; the exact schema remains implementation work. Avoid mixed weaker/stronger repository contexts in one shared workspace. Profile changes cannot be requested by repository contents or ordinary tool/chat input. Do not present the proposed modes as supported settings until implemented.

Native acceptance covers real client compatibility, scoped issuance, safe platform-managed token handling, expiry/revoke/outage/retirement, upstream permission boundaries and explicit network policy. Optional profiles add independent credential-absence, request-policy and historical-canary tests. Seed a secret only in an old/deleted revision and prove strict mode does not expose it through files, transient objects, APIs, command output or recovery. Tests must exercise actual components and disclose unrun live checks.

## Primary protocol references

- [GitHub installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub installation authentication and HTTPS Git](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Token revocation](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)
- [Git clone behavior](https://git-scm.com/docs/git-clone)
- [gh environment behavior](https://cli.github.com/manual/gh_help_environment)
