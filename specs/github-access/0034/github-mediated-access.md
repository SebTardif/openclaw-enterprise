# GitHub Client Credentials and Mediated Access

Draft supporting specification for [RFC 0034](../0034-github-app-credentials.md).
See the [series index](../README.md) for scope and the other contracts.

## Native client contract

Native installation-token delivery is development/testing only and never a
production fallback. The MVP Git client and PR helper receive only the
[Agent access token](#agent-access-token). Keep credentials out of URLs,
arguments, persistent Git configuration and stores; disable inherited helpers
and unmanaged fallback. Denials never select personal tokens or another account.

## Mediated origin and routing

### Agent access token

An **Agent access token** is an OCE-issued opaque bearer, invalid at GitHub.
Generate 32 random bytes in a versioned encoding; durably retain its SHA-256 hash
and exact access/lease/Work/revision/execution binding before delivery through an
execution-owned Kubernetes Secret. Mount it only in the intended client container;
Namespace RBAC prevents access to other Secrets. No token bytes enter resource
JSON, logs or reports. Reconcile uncertain delivery by its original durable
identity; lost material requires closing that credential before replacement.

The gateway validates possession and resolves the original server-owned grant.
Each operation separately requires current IAM, root Work or preparation,
assignment, binding generations and finite lease authority. Caller-supplied
identity, Work or repository headers confer nothing. Missing, malformed,
duplicate, unknown, expired or revoked credentials deny locally.

A copied live bearer can use its original still-authorized grant from a reachable
location. It does not prove physical container origin. Protected-origin
SPIFFE/SPIRE authentication is a future profile; other OCC and Kubernetes
identity boundaries retain their own contracts.

Token rotation never widens authority, changes the original grant or reopens a
closed lease. Installation-token replacement may preserve the same eligible
Agent bearer. Access closure retires delivery and denies subsequent dispatch;
already accepted outcomes and cleanup remain independently owned.

### Trusted identity

The server-owned binding identifies the exact Agent, revision, execution,
original Work and selected repository. It cannot be reconstructed from caller
IDs or mutated to use later authority. Select one immutable root Work per
execution; mixed-authority persistent workers are outside this MVP. Helpers
require qualified shared scope, aggregate limits and stop ownership. Separate
read-only preparation cannot borrow an execution grant or token.

### Runtime boundary

Select Kubernetes/gVisor containment that permits only required DNS, the
credential gateway and explicit platform endpoints. Inspect all additive
NetworkPolicies: broad public-443 access must not coexist. Deny direct GitHub,
issuance endpoints, alternate credentials/brokers and tunnels through model or
control channels. Proxy settings alone do not establish containment. Network
containment does not make the bearer resistant to copying.

App signing keys, interception CA keys and installation tokens stay outside
Agent execution. The Agent receives only its opaque token and public CA.
Native delivery must reject mediated leases and be unreachable from this profile.

### Client transport

Scoped CoreDNS routes `github.com` and `api.github.com` to the standalone gateway.
DNS provides routing, not authentication. Use TLS with matching SNI, Host and
route over HTTP/1.1. Infrastructure provisions gateway leaf certificates; the
gateway independently resolves GitHub, validates public destinations, pins the
selected address and verifies upstream TLS with public trust. Never disable
certificate validation. Reject CONNECT, upgrades, redirects and arbitrary hosts.

The Git helper reads the bearer file and supplies Basic authentication with
username `x-access-token`; the PR helper uses Bearer authentication. Approved
unauthenticated discovery/probe routes return a local Basic `401` without mint
or upstream access. Strip incoming credentials/cookies/proxy headers and construct
fresh approved upstream headers/path. Insert the installation token only inside
protected upstream use; never send the Agent access token to GitHub.

## Mediated operation profile

### Request validation

The registered GitHub adapter validates bounded raw input, freezes canonical
facts/bytes and supplies a core-owned opaque operation handle. The broker checks
current authority and consumes a finite one-use permit for that exact operation.
Unsupported encodings, framing, fields or methods deny before provider effects.
Fully buffer, validate and hash bounded fetch bodies before dispatch; push uses
the [bounded command-prefix contract](github-publication.md#direct-push).

Initial limits require installed qualification:

| Bound                                 | Value                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Headers                               | 32 KiB and at most 64 pairs.                                                              |
| Fetch request / metadata response     | 1 MiB each, wire and decoded.                                                             |
| Push prefix / ref updates             | 256 KiB / 256.                                                                            |
| Push upload / Git response            | 256 MiB each, wire and decoded; stream PACK data.                                         |
| PR request / response / total request | 64 KiB / 1 MiB / 30 seconds.                                                              |
| Connect / full exchange               | 5 seconds / 5 minutes.                                                                    |
| Active requests                       | Four aggregate per lease, including retained exchanges; 32 in the active gateway process. |
| Access lease / authority observation  | At most five minutes / five seconds.                                                      |

Shorter authority deadlines govern. Renewal cannot extend an admitted exchange.
Active exchanges recheck within five seconds and stop on observation expiry or
database loss. Measure external-IAM propagation separately. Logs contain bounded
approved fields, never raw requests, credentials or provider objects. Metadata
projects only `id`, `full_name`, `private` and `default_branch`.

### Supported surfaces

| Host             | Exact route                                                            | Authority |
| ---------------- | ---------------------------------------------------------------------- | --------- |
| `api.github.com` | `GET /repos/{owner}/{repo}`, no query/body                             | Read      |
| `github.com`     | `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack`            | Read      |
| `github.com`     | `POST /{owner}/{repo}.git/git-upload-pack`, validated protocol-v2 body | Read      |
| `github.com`     | `GET /{owner}/{repo}.git/info/refs?service=git-receive-pack`           | Write     |
| `github.com`     | `POST /{owner}/{repo}.git/git-receive-pack`                            | Write     |
| `api.github.com` | `POST /repos/{owner}/{repo}/pulls`                                     | Write     |

Every route resolves to the admitted repository. The exact `0000` plus EOF
receive-pack probe is an authenticated, currently authorized local no-op with
its own probe receipt, no mint and no push receipt. An upload-pack `0000` probe
denies locally. Reject all other REST/GraphQL operations, forks, SSH, LFS,
submodules, PR list/update/close/merge, issues and generic `gh api` passthrough.

### Command qualification

Qualify clone/fetch, direct push, metadata and `oce-github pr-create` in the
regular Agent image. The PR helper reads admitted repository configuration and
the token file; it does not push, fork, change remotes, follow redirects or open
a browser. Accept head/base/title/body-file, optional draft and operation-ID
arguments. If omitted, generate and print a UUIDv4 before sending; reuse that
same ID and request to retrieve retained state. Neither helper nor gateway
automatically chooses a new ID or retries a possibly submitted provider POST.
General `gh pr create` compatibility remains outside this catalog.

Pin binaries, image digests, configuration and exact command variants. Prove
receive-pack framing and limits, partial/unknown outcomes, buffered fetch
requests and safe PR projections. These are qualification requirements, not
claims of implemented compatibility. Fetched history remains readable.

## Related specifications

- [Overview and contract](github-app-v1-spec.md)
- [GitHub Repository Scope and Publication](github-publication.md)
- [GitHub Issuer Policy and Token Lifecycle](github-issuer-policy.md)
