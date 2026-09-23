# Provider setup and revision authentication

**Date:** 2026-09-23\
**Status:** Proposed implementation; reusable setup-time OAuth selected\
**Owner:** OCE Provider setup and selected inference integration\
**Tracking:** [Provider expansion #84](https://github.com/openclaw/openclaw-enterprise/issues/84)

## Product decision

OpenClaw Enterprise (OCE) lets operators configure providers in the Providers
page, complete authentication there, and reuse a saved connection from multiple
Agents. An Agent revision selects its provider, authentication method, connection,
and model. OAuth consent happens before deployment; deploying another Agent does
not require another login while the selected connection remains usable.

Mirror OpenClaw's native choices with a hardcoded OCE catalog tied to qualified
OpenClaw runtime versions and images. Add each method's mapping, runtime pin,
image, and integration proof together. Runtime discovery of authentication
methods is outside this first implementation.

This proposal records those selected product decisions and recommends the
ownership and runtime contracts below. It introduces no runtime behavior, API,
schema, credential store, or new supported authentication method. The
[platform design](../docs/design.md) remains authoritative; the explicit delegated
connection contract needs to be incorporated into its identity boundary before
implementation. Broader credential sharing is not implied by an Installation-wide
Providers page.

| Provider            | Planned authentication choices                               | Setup                                                                  |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| OpenAI              | API key; Codex OAuth; Sign in with ChatGPT (SIWC)            | Store a key or complete the selected native OAuth flow                 |
| Anthropic           | API key initially                                            | Store a key; qualify other native methods separately                   |
| Local / self-hosted | No upstream authentication or supported endpoint credentials | Select server kind, endpoint, model, and permitted network destination |

This is the product inventory, not an availability claim. Preserve existing
managed ChatGPT service-account and operator-managed runtime choices where
supported. Codex OAuth and SIWC are distinct methods under OpenAI; an auth method
never implicitly selects a Harness or changes the model.

## Current implementation and adjacent work

At OCE `43776d25c5007e017f7d0ffdca6b06f063afcd37`, the
[Provider contract](../docs/reference/providers.md) describes Installation-owned,
startup-loaded clients and a read-only inventory. `Agent.providerId` associates
managed ChatGPT service-account ownership, not a native model provider or a user
OAuth connection. API-key Agents may have no such association. Keep those meanings
and existing repository Provider semantics intact.

Current [harness bindings](../packages/contracts/src/harness-auth.ts) and
[Kubernetes admission](../apps/controller/src/drivers/compute/kubernetes/index.ts)
support supplied OpenAI API keys and dedicated Codex managed service accounts.
The [runtime image](../deploy/runtime/Dockerfile) defaults to OpenClaw and its
Codex plugin `2026.9.1`, with native Codex `0.156.0`. Those defaults do not prove
support for a new method or for reusable connections.

[Agent OAuth activation #252](https://github.com/openclaw/openclaw-enterprise/pull/252),
inspected at `6c9ec24bdf0639d31a3e7eed84a53bfb74e85cc3`, has a different scope:
OpenAI device consent during embedded Kubernetes activation, with tokens owned by
that Agent's native store. Its final compatible image and genuine provider
lifecycle proof remain pending. This proposal does not modify that PR or reuse
its Agent-scoped deployment attempts as shared connections. Its separate
[managed-login prerequisite #153046](https://github.com/openclaw/openclaw/pull/153046)
is candidate native-interface reuse; verify suitability for connection-owned
custody rather than assuming Agent-specific commit semantics transfer unchanged.

OpenClaw's separate SIWC work owns registration, consent, grant validation,
refresh, and native method naming. Consume its supported interface after the
selected image and remote consent path are qualified. An interactive CLI command
is mapping evidence, not a supported headless API: do not scrape terminals or
assume a browser-local callback reaches a remote server.

## Proposed ownership and persistence

Use an explicitly Namespace-scoped saved connection, created before any Agent.
Multiple authorized Agents in that Namespace may reference it. The operator who
connects the account remains attributable; using the connection requires explicit
permission and is not inheritance of that person's OCC roles or login session.
Cross-Namespace sharing is outside the initial proposal.

Require connection-use authorization for both the deploying actor and Agent
service principal, following the existing exact-resource `operate` pattern.
Metadata visibility alone grants no use; runtime requests recheck the Agent's
current authority.

Keep three concepts separate:

- The Installation Provider supplies trusted provider clients and related Driver
  configuration. It is not a human OAuth account.
- The saved connection records provider/method, display name, approved endpoint
  where relevant, owner Namespace, safe status, and private credential references.
- The immutable AgentRevision admits the exact connection, model, authentication
  method, and runtime compatibility selection. It contains no token bytes.

Review this connection's API, IAM actions, PostgreSQL representation, and revision
reference as an explicit extension of the platform before schema work. Do not
hide mutable shared login state in an Agent Configuration, service account, or
startup Provider array. OAuth connection creation is not service-account issuance.

A trusted provider connection service owns OAuth acquisition and refresh outside
Agent/tool execution and outside the dedicated gateway. It executes the qualified
OpenClaw auth implementation with isolated connection-owned native state. Protect
that durable state and its backups; OCC stores only references and safe metadata.
Do not duplicate refresh tokens into OCC rows, ordinary Secret environment
bindings, Agent homes, or revision snapshots. Static API keys retain the selected
Secret backend as their storage owner, with a separately reviewed trusted-consumer
access path.

A shared service process may host multiple isolated connections; this proposal
does not require a Pod per connection. Refresh and reconnect require exclusive
ownership and a connection generation. Before persisting after awaited provider
work, revalidate both so a superseded refresh cannot overwrite newer credentials.
Process restart reopens current state rather than reseeding old tokens. Define the
native-store access and fencing mechanism before implementing persistence; a
single replica alone does not establish safe ownership after failures.

## Setup and deployment flow

1. In **Providers**, select a Namespace, provider, authentication method, and name.
   Check the actor's connection-management authority and qualified runtime support
   before starting any provider operation.
2. For an API key, use the Secret workflow. For OAuth, create an attempt bound to
   the exact connection, actor, and generation. The connection service invokes
   the native method; OCE displays approved consent instructions. The user grants
   provider access explicitly for the connection's allowed Agent use.
3. The native owner exchanges the authorization result. Recheck actor authority,
   connection ownership, generation, and cancellation before committing credentials.
   The browser and ordinary OCC API responses receive safe status, never tokens.
4. Show authentication status separately from model availability. Run a bounded
   check for the selected model/protocol; valid login alone does not establish
   inference access. Keep identity-only SIWC grants unavailable for inference.
5. In the Agent editor, select provider → method → saved connection → model. Show
   only authorized, compatible connections; explain unavailable choices. Saving
   records draft intent and references, not another login.
6. Deployment snapshots the admitted selection, rechecks connection authority and
   compatibility, prepares the runtime, and requires model readiness before
   activation. The deployed Agent uses the saved connection through the selected
   inference path. An expired connection that cannot refresh produces an explicit
   reconnect requirement, never an automatic account or auth-method substitution.

The Providers empty state offers **Set up provider**. Setup exposes connection
status and reconnect/disconnect actions. Connection details identify affected
Agents before a change. Model selection and readiness remain distinct from
connection status; another successful Agent does not prove this Agent's selected
model and Harness work.

## Inference and credential delivery

Implement connection-based inference through the proposed
[InferenceDriver](../docs/design/drivers.md#drivers-and-providers). One
Installation-selected implementation resolves approved provider/local adapters
and exact connection references. The provider connection service supplies
credential use within that trusted boundary; it does not return a refresh token
to the Agent or dedicated gateway.

The runtime receives an approved inference endpoint and scoped workload authority.
The trusted service validates the exact Namespace, Agent, active revision, current
permission, connection generation, and admitted model before forwarding the native
protocol with owner-held authentication. Constrain destinations, model overrides,
and headers; handle streaming, cancellation, errors, and revocation. Agents cannot
bypass the selected path to obtain the connection's upstream bearer. The existing
SecretDriver's storage/reference interface does not already provide this broker
or a general OAuth read/refresh API.

Deployment readiness occurs before activation, so it needs a distinct,
controller-authorized bounded probe for the exact candidate and target. A probe
must not grant ordinary inference authority to a candidate. Runtime calls use
active-revision workload identity; a connection ID or reusable OCC service key
alone is insufficient. These are missing implementation contracts, not guarantees
provided by today's direct Secret projection.

Reuse OpenClaw's provider plugins and public transport interfaces. Preserve native
Responses, Anthropic Messages, and local protocols where supported; do not introduce
a universal prompt schema or Messages-to-Responses translation merely for the UI.
Qualify dedicated Codex's endpoint, authentication, model discovery, and protocol
against its pinned release before claiming support. Its upstream external-token
login is not a credential-hidden broker and must not cause model tokens to pass
through OCE's dedicated gateway.

Current direct API-key/account deployments remain governed by their existing
scoped exception. New shared OAuth connections require the trusted inference path;
token copying is not an interim substitute silently enabled by this proposal.

## Refresh, reconnect, and revocation

The connection owner serializes native refresh, persists rotation atomically, and
revalidates the upstream account and usable grant. All consuming Agents use that
one current credential state. Transient failure is visible; terminal rejection
marks the connection as needing reconnection without trying another account.

Same-account reconnect may renew credentials without rewriting revision settings.
Provider, auth method, upstream account, or endpoint replacement requires a new
connection identity so existing revisions cannot silently change targets. Revisions
retain references rather than historical credentials; current permission and
revocation apply immediately. A referenced connection cannot be deleted silently.

Disconnect first removes inference/refresh authority and invalidates the current
generation, including active streams and stale attempt completions. Then perform
supported upstream revocation and credential cleanup. Record local disconnection
and provider revocation separately; local deletion is not proof of remote
revocation. Retain protected cleanup state for retry if revocation fails while
keeping the connection unusable. Stopping one Agent does not disconnect a shared
connection used by others.

Audit the actor, connection, Namespace, Agent/revision where relevant, and safe
outcome. Exclude credentials, device codes, callback payloads, raw provider errors,
and prompt/response contents.

## Catalog and release contract

Keep one authored catalog in the OCE provider/runtime integration, consumed by
Console, API admission, and runtime preparation. Generic OCC code depends on its
contract rather than vendor branches. Each entry identifies:

- Stable provider/native method IDs, labels, and required setup inputs.
- Credential ownership and the supported structured auth adapter or fixed command.
- Qualified Harness/Compute/protocol combinations and model discovery/probe adapter.
- Exact runtime/plugin versions and approved immutable image identities.

Do not accept executable commands or credential paths from the browser. Catalog
metadata confers no authority and contains no secrets. Installation catalog access
does not authorize connection use.

Pin both the connection service's auth runtime and the Agent's inference runtime.
An upgrade of either must preserve existing stored grants or supply its reviewed
transition. Validate explicit image overrides against the same support table;
a newer version string alone is insufficient. Freeze deployment compatibility
selection through reviewed revision/Harness contracts: current image configuration
is not itself proof of a per-revision image pin. Existing revisions must not
silently gain methods or switch runtimes when the catalog changes.

## Focused implementation sequence

1. Review Namespace connection ownership, delegated-use permissions, persistence,
   trusted credential access, and runtime image pinning. Align the authoritative
   identity design with explicit shared-connection use. This draft proposes these
   details; no schema or service provisioning is implemented here.
2. Add the hardcoded catalog and a complete API-key setup → connection selection →
   mediated model turn through the regular Console/API/Agent workflow. Include
   candidate probe authority and active-workload enforcement in this first slice.
3. Add reusable OAuth setup through the native managed interface, first for a
   qualified method. Connect SIWC through its owning OpenClaw implementation.
   Prove consent before Agent creation and reuse by two authorized Agents.
4. Extend Anthropic and local endpoint support with native protocol adapters,
   explicit private networking, qualified images, and actual model/tool execution.
   Add dedicated Codex combinations only after their remote contract is proved.

Update the [Provider reference](../docs/reference/providers.md),
[Console workflow](../docs/reference/console/create-and-deploy.md),
[Harness reference](../docs/reference/harness-execution.md), and existing execution
and credential flows when implementation ships. Update matching Console Storybook
states alongside UI changes; simulated stories are not backend verification.

Acceptance requires actual setup and deployment integration, foreign-Namespace and
unauthorized-use denial, incompatible-image rejection before auth side effects,
stream/tool behavior, concurrent refresh, restart with rotated tokens, cancelled
consent, reconnect identity checks, and disconnect stopping both consuming Agents.
Extend existing Console browser and real Kubernetes topology/image suites. Missing
provider credentials or infrastructure is missing proof, not replaceable by a
mock login. No live inference, consent, refresh, or revocation was run for this
proposal.
