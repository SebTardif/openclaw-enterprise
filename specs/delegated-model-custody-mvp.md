# Delegated model custody MVP

Status: Implementing. This specification records the selected implementation
within the [platform design](../docs/design.md); it does not replace the resource
model or establish supported runtime behavior. The current
[delegation reference](../docs/reference/delegation.md) describes the implemented
library boundary, and the [build reference](../docs/reference/build.md) owns the
source and image build contract.

## Intended behavior

An Agent makes a model request without receiving the provider credential. A
trusted service outside the Agent guest validates its actual authenticated
workload, current assignment, original admitted turn, and exact delegated model
operation. It selects the credential from server-owned configuration, consumes
dispatch permission once, and sends the captured request to the fixed permitted
recipient. Current authorization and network policy can terminate a stream while
the Agent continues running.

This first tier supports root delegation to an existing Agent. Child issuance,
delegation chains, a new identity provider, and additional scheduling are outside
this implementation. Native repository credentials retain their separately
selected [repository access mode](20-repository-access-modes.md).

## Implementation selection

Reuse the reviewed Dream Serpent DNS resolution, address admission, policy, TLS
verification, and nftables components. Give OCE narrow entrypoints and explicit
dependencies. The original transparent proxy and host orchestration startup are
not selected runtime entrypoints. Source intake must preserve provenance,
applicable licenses, necessary tests, and exact dependency identities.

Use maintained Hyper HTTP/1 connection handling with rustls on the exact socket
opened to an admitted address. Avoid a second resolver, connection pooling,
automatic retries, redirects, and unsupported protocol upgrades. OCE owns the
operation policy, credential selection, immutable request binding, first-dispatch
transition, and cancellation. HTTP parsing and framing remain library behavior.

Pingora remains a technically viable alternative. Its proxy framework provides
connection management, streaming, and operational machinery, but this profile
deliberately excludes connection reuse, retries, caching, and protocol upgrades.
Hyper's connection API accepts the already authenticated socket directly, leaving
fewer framework behaviors to reconcile with the one-dispatch authority contract.
This choice still requires OCE to maintain structured connection lifetimes,
backpressure, deadlines, and receipts. A short handwritten HTTP parser is not the
selected replacement. Revisit the framework choice if the supported profile
expands to generic proxying, pooling, or multiple HTTP protocols.

One accepted request per incoming connection is supported. A valid first request
may execute when another request is pipelined behind it; subsequent requests are
never authorized or forwarded on that connection. Application security headers
and JSON fields must remain unambiguous after the selected library's parsing.

The first request profile is ordinary Responses HTTP/SSE with bounded captured
content and qualified client-executed tools. Detached work, provider tools,
cross-context stored-response references, compaction, WebSockets, and unknown
operation profiles refuse until their own authority and lifecycle are implemented.
Provider authentication profiles select exact recipients and credential/account
bindings. An identity assertion is exchanged only through its selected federation
flow; it is not treated as an API key.

## Authority and effect ordering

The grant store binds one immutable holder, human, turn, attempt, common resource
grant, audience, and finite set of paired provider/model operations. Actual
selected IAM and current actor, common-grant, Agent, and operator ceilings must
all permit the operation. Allocation storage and parsed receipts are insufficient.

Create a stable reservation reference before admission. Persist its exact request
digest and finite budget charge atomically with attributable audit. Resolve an
ambiguous admission only under that same reference. A separate durable dispatch
transition consumes the reservation once before the immutable dispatch deadline.
An uncertain dispatch acknowledgment permits no send or retry. Stream renewal
cannot rearm dispatch or extend the overall operation expiry. Unknown remote
effects retain their explicit ownership and concurrency state until reconciled;
completion never refunds the total request charge.

A clean HTTP EOF alone does not prove that provider execution ended. The selected
SSE profile must observe and validate a complete provider terminal event before
reporting ended execution. A terminal failure or incomplete response can establish
that execution ended without establishing model success. A missing, truncated,
or conflicting terminal event leaves the remote effect unknown.

Currentness includes the actual protected workload peer, bound runtime assignment,
canonical admitted turn, and selected policies with their original observation
and expiry evidence. New RPC timestamps cannot freshen old evidence. Immutable
assignment policy, operator policy, root version, and live applied network epoch
remain distinct. The identity and runtime owners must accept their mapping before
an external service may report the operation current.

## DNS and network ownership

A pending DNS admission permits one connection to one exact address, hostname,
port, and protocol before the original DNS and authority deadlines. After TLS
authenticates that same socket, the trusted socket owner consumes the admission
into one established-flow lease. Exact control replay returns the same flow;
neither reference permits another connection. Current authority may renew that
already authenticated flow beyond DNS TTL, bounded by immutable operation expiry.

The trusted service uses separate containers for DNS enforcement, credential
transport, and authority. The Agent guest receives none of their provider Secrets
or control sockets. Each Unix-socket producer owns its protected directory;
consumers cannot replace endpoints and authenticate the actual peer in both
directions.

The selected DNS process runs as UID 0 with only `NET_ADMIN`, no privilege
escalation, a read-only root filesystem, separate process and mount namespaces,
and no provider Secret or host access. TLS and authority run as distinct nonroot
UIDs with capabilities dropped. This deliberately scoped service requires the
corresponding Kubernetes admission exception. A compromised DNS process controls
its whole service network namespace; the capability is not limited to one table.

The namespace's permitted UID/address/port set is a union of active admissions and
flows. It cannot distinguish two operations using the same provider IP. The TLS
owner enforces exact-operation cancellation on its actual socket; removal of one
owner preserves another owner's valid endpoint. New admissions and established
upstream packets both pass the endpoint rule. Cleanup failures remove readiness.
Restart does not infer enforced state from a sequence number or retained table.

Kubernetes NetworkPolicies independently constrain the Agent's reachable
destinations and the trusted service's dependencies. The complete effective
policy must deny direct and alternate egress around mediation. A service chart
alone cannot establish the selected Agent SandboxDriver's containment.

## Build and local development

Cargo and pnpm retain their language manifests and lockfiles. The explicit local
build graph connects TypeScript checks, selected Rust binaries, prepared runtime
packages, and image assembly. Ordinary source builds use prepared offline inputs;
dependency preparation and images are separate requested operations. Remote
execution and a shared action cache are not required for this tier.

Local execution must use the actual authority, DNS, and TLS processes, protected
socket paths, explicit credential references, and an isolated network namespace.
The helper must fail when required authority or enforcement is unavailable.
Infrastructure preparation cannot replace real authorization with a permissive
fixture. Source builds must be followed by actual image startup to verify ABI and
capability delivery.

## Acceptance

Completion requires all of the following evidence against the integrated source:

- Real DNS/admission and TLS receiver tests for canonical revocation, rebinding,
  shared-address ownership, late results, exact recipient binding, framing,
  replay, expiry, and cancellation.
- Actual nftables and conntrack execution with independent allowed and denied
  receivers in an explicitly disposable namespace.
- Canonical PostgreSQL grant/dispatch ownership, budgets, replay/readback,
  unknown outcomes, and transactional audit under the limited application role.
- Actual protected workload identity, current assignment, canonical turn, and
  selected IAM/provider integrations; unavailable dependencies deny.
- Actual image and selected Kubernetes verification of UID/capability/mount
  boundaries, complete NetworkPolicy enforcement, restart failure, live policy
  tightening, and an unaffected second Agent.
- A genuine native Codex provider-backed turn through external credential custody,
  including a stream longer than DNS TTL and proof that the provider credential
  did not enter the Agent guest.

Each test report must distinguish adapter fixtures, actual kernel behavior,
canonical authority, Kubernetes enforcement, and real provider execution. A
successful compile or fixture model response cannot establish the latter gates.
