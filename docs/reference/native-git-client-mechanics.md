# Native Git and gh client mechanics

Status: **inactive source contribution with focused mechanics verification**.
This component has no package registration, production caller, credential issuer,
or network delivery route. It implements part of the native direction in
[repository access modes](../../specs/20-repository-access-modes.md); it does not
make that proposed mode a supported platform setting.

The separate [native HTTPS transport library](native-github-egress.md) implements
a controlled, finite HTTP/1 transport subset. Its production admission remains
unavailable; it does not supply this client's credential delivery owner.

The native profile permits a scoped ephemeral GitHub installation token inside
the tool runtime. That bearer token and fetched Git history are visible to runtime
code. These helpers constrain platform-managed invocations and output handling;
they do not restrict what arbitrary code can do with a copied token.

## Source and dependency injection

| Source                                                                            | Responsibility                                                                                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [client-mechanics.ts](../../packages/github-sts/src/client-mechanics.ts)          | Selected command plans, finite permission profiles, environment/config rules, pipe framing and token-release checks. |
| [client.ts](../../packages/github-sts/src/client.ts)                              | Immutable invocation snapshots, bounded processes and output, original-attempt retention and mutation results.       |
| [Git helper](../../packages/github-sts/bin/git-credential-github-sts.mjs)         | Git credential `get`, `store` and `erase` protocol.                                                                  |
| [gh wrapper](../../packages/github-sts/bin/gh.mjs)                                | Per-new-child acquisition and a fresh `GH_TOKEN` environment.                                                        |
| [Conformance file](../../tests/conformance/github-sts-client.test.mjs)            | Real Node mechanics tests and explicitly selected native Git/gh qualification cases.                                 |
| [Controlled endpoint](../../tests/fixtures/github-sts-client/native-endpoint.mjs) | Test-only synthetic inputs, loopback TLS smart-HTTP/REST/GraphQL peers and Node probes.                              |

`createNativeClient` requires an existing original credential binding, fixed
repository metadata, a delivery port, explicit absolute tool paths, an allocated
scratch directory, an abort signal and `exclusiveCheckout: true`. There is no
default positive delivery implementation. Its original-binding type uses the
supported `@openclaw-enterprise/contracts/credential-authority-v1` export. An
original binding is retained context, not an authority constructor.

The accepting integration must provide `withCurrentToken(request, release,
signal)`. That owner must check actual current authority and protected recorded
delivery for the exact original attempt at the synchronous `release` boundary.
It must honor cancellation and settle its promise. The client verifies matching
attempt and binding digest, explicit original execution-limit projection, actual
token expiry and active invocation before forwarding bytes. A finite original
deadline must remain unexpired; explicit `null` means uncapped execution duration,
and a missing projection is invalid. It cannot establish that
the supplied token really has the described repository permissions. Configuration
and descriptors are not verified App/account/installation or Namespace binding.

`invalidateRuntimeReuse` handles helper erasure for the retained invocation. It
does not revoke upstream tokens or delete protected inventory. Synthetic attempt,
token and delivery constructors exist only in the test fixture.

## Selected command plans

Every command includes a stable `operationRef`. Fixed repository metadata includes
numeric repository ID, owner/name, exact checkout commit, base, an `oce-demo/`
branch and bounded issue/PR numbers. The planner rejects unsupported inputs and
uses explicit GitHub repository names and token-free HTTPS URLs.

| Case    | Planned operation                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| G01     | Public init, remote, shallow exact-commit fetch and detached checkout; any token request fails before the delivery owner runs. |
| G02     | Clone without checkout or recursive submodules.                                                                                |
| G03     | Fetch exact commit, detached checkout and `rev-parse HEAD`.                                                                    |
| G04     | Local status, diff, bounded log and branch listing.                                                                            |
| G05     | Create the selected branch, add explicit files and commit with bounded message.                                                |
| G06     | Push an explicit intended commit OID to the selected branch.                                                                   |
| G07     | Repository view with selected JSON fields.                                                                                     |
| G08–G10 | Bounded issue list, exact issue view and exact PR view.                                                                        |
| G11     | Draft PR create with explicit repository, head, base, title, owned body file and disabled maintainer edits.                    |
| G12–G15 | Explicit repository, commit, issue-list and PR-list REST reads with API version `2026-03-10`.                                  |

The read profile requests `metadata:read` and `contents:read`. Collaboration
reads add `issues:read` and `pull_requests:read`. The change profile requests
`metadata:read`, `contents:write`, `issues:read` and `pull_requests:write`. G05,
G06 and G11 select the change profile; G08–G10 and G14–G15 select collaboration
read. This mapping expresses requested scope for the delivery owner. It does not
grant authority or enforce branch policy against direct token use.

The selected qualification targets are Git **2.55.0** at
`e9019fcafe0040228b8631c30f97ae1adb61bcdc` and gh **2.93.0** at
`f96972ce1c11fdb8eaa556257fde962a363dffde`. The library requires caller-selected
absolute executables; it does not attest their versions or provenance. Those
selected executables are exercised only when the native qualification manifest
is explicitly supplied.

## Refresh, expiry and mutation outcomes

The client snapshots the original binding, repository, options, command and step
before asynchronous work. A later invocation B cannot replace a suspended A
invocation. Every helper `get` and every new gh wrapper child requests current
delivery for A. There is no parent token cache and no environment mutation of a
running gh process. A newly delivered token does not invalidate an earlier token.

The private per-child inherited pipe is FD 3. It supports bounded `get` and
`erase` frames, at most eight frames over the entire child lifetime. Git `store`
does not persist anything. Credential input accepts Git's newline-terminated EOF
and optional blank terminator, including repeated capability/challenge metadata;
duplicate destination fields remain invalid. Git `get` returns the actual expiry through
`password_expiry_utc`; failure returns no credential and `quit=true`. The gh
wrapper forwards only `GH_TOKEN` to its new native child, closes the credential
channel and does not forward the original binding or alternate token variables.

The default process deadline is 20 seconds, capped at 30 seconds and shortened by
the original deadline when configured. Uncapped work retains the same finite
process deadline. Child exit also joins pending delivery settlement within
that deadline. A post-release rejection or unresolved owner promise cannot turn
into success. JavaScript cannot forcibly cancel a noncooperating delivery promise;
late releases are closed locally, while upstream cleanup remains the delivery
owner's responsibility. Process-group termination is managed-process cleanup,
not a sandbox against arbitrary daemonized descendants.

`completed` means child exit zero only. Remote mutations require exact readback
even after that result. A failed or interrupted push/PR child returns `unknown`
and `exact-readback-only`, without automatic retry. Results retain operation,
original attempt/digest, repository ID, intended branch/commit, PR base and
title/body digests. G06 pushes the captured OID instead of resolving moving HEAD.
G11 copies a regular, nonsymlink body of at most 16 KiB, checks the supplied
SHA-256 digest and uses its own private snapshot. This protects the reviewed
local body across awaits.

The runner does **not** yet check the remote head OID before PR creation or perform
the required exact push/PR readback. A branch can move at the provider. The
retained intended tuple supports reconciliation; it does not prove the created PR
matches that tuple. Remote verification and unknown-outcome reconciliation remain
required integration work before this can be accepted as a repository feature.

## Managed configuration and checkout boundary

Each invocation gets a fresh private home/config directory. Environment creation
does not inherit ambient Git/gh tokens, proxy/debug/trace settings, Git config
overrides or alternate paths. Git options reset credential helpers, require HTTPS
and TLS verification. Managed Git uses HTTP/1.1 with `Connection: close` to avoid
a reused connection causing libcurl to retry a mutation after an empty response.
This costs connection reuse and does not replace exact remote readback. Options
disable redirects, hooks, automatic maintenance and common
external filter/diff paths. G05 uses explicit local metadata
`OCE Native Client <native-client@local.invalid>`; this is not user identity or
authorization evidence. No managed token appears in repository URLs or argv.

Existing ordinary `.git` directories undergo a finite config preflight that
rejects includes, executable settings, alternate remotes, linked worktrees and
alternate object stores. The caller must exclude concurrent checkout and config
mutation for the whole invocation, including while that preflight and native Git
run separately. `exclusiveCheckout: true` declares this precondition; it does not
acquire a lock or make validation race-free. Arbitrarily writable checkout state,
LFS, submodule workflows and repository preparation admission are unsupported.

Output is collected within a byte limit, then scrubbed for known raw, URL-encoded,
base64 and Basic-auth token forms, including tokens split across process chunks.
This addresses managed output, not arbitrary encodings or runtime exfiltration.
Only the invocation's own scratch directory is removed. It does not delete the
caller's checkout or restore caller-modified files.

## Verification and remaining qualification

Run from the repository root with its existing Node and matching dependencies:

```sh
node --test tests/conformance/github-sts-client.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target ES2022 --module NodeNext --moduleResolution NodeNext --types node --skipLibCheck --allowImportingTsExtensions packages/github-sts/src/client-mechanics.ts packages/github-sts/src/client.ts
node scripts/verify-workspace-boundary.mjs
node scripts/verify-module-boundaries.mjs
```

The root build/typecheck has explicit project references that omit this inactive
family. The focused compiler command above checks both new TypeScript leaves.
Use the [development verification loop](../development-loop.md) for scoped
formatting and setup checks. Verification never installs tools or dependencies.

The focused suite tests actual Node helper/wrapper subprocesses, the real client
runner and a synthetic loopback HTTP exchange. It covers immutable original
attempts and PR payloads, expired/wrong-attempt denial, refresh across new children,
erase routing, lifetime limits, split-chunk scrubbing, cancellation, post-release
owner failures and one ambiguous synthetic mutation without replay. The fixture
uses only random ephemeral synthetic tokens and records token ordinals rather
than credential bytes.

All **15 selected native cases have implemented bodies**. The default invocation
leaves them explicitly unselected. Select them with a prepared artifact manifest:

```sh
OCE_NATIVE_QUALIFICATION=1 OCE_NATIVE_QUALIFICATION_FILE=/absolute/prepared-tools.json node --test --test-concurrency=1 tests/conformance/github-sts-client.test.mjs
```

The manifest requires `schemaVersion: 1`, `execution: "local-synthetic-only"`,
`platform: "linux"`, `arch: "x64"`, an existing absolute `scratchParent` and
`gitExecPath`, and six named artifact objects: `git`, `gh`, `openssl`,
`gitRemoteHttp`, `gitRemoteHttps`, and `gitHttpBackend`. Each records an absolute
`path` and SHA-256; Git and gh also record the exact version and source commit
from the selected tool table. Preparation establishes artifact provenance;
a supplied commit string alone cannot prove how a binary was built. Partial
selection or any identity/version mismatch fails instead of skipping.

Each selected case creates a small real Git object graph and bare repository,
then runs the pinned Git and gh executables through test-only launchers. A
loopback CONNECT proxy routes only `github.com:443` and `api.github.com:443` to
a private TLS peer with a generated test CA. TLS verification stays enabled,
repository URLs stay credential-free, and Git's real helper descriptor path is
exercised. Unsupported protocol requests fail explicitly. This is a controlled
protocol compatibility fixture, not live GitHub permission enforcement.

Setup and execution share one 60-second cancellation lifecycle. Tool checks and
setup commands consume it; partial listeners and owned backend children settle
before owned scratch removal. The cases check actual clone/fetch/push and gh
results, original-attempt refresh with overlapping children, in-flight synthetic
expiry denial, and lost-acknowledgment mutation outcomes. PR creation records
attempts before duplicate rejection so one accepted effect cannot conceal a replay.
The fixture module's Node probes run only on direct invocation, never when imported
by a generated native launcher.

No live GitHub App, issuance/revocation inventory, current-authority integration,
upstream permission/rules enforcement, real runtime, Kubernetes lifecycle,
preparation-before-readiness admission or network-policy acceptance is claimed.
Those checks belong to the corresponding integration owners. See
[runtime preparation](runtime-preparation.md),
[runtime authority](runtime-authority.md) and the
[testing guide](../testing.md) for the existing platform boundaries.
