# Provider authentication setup

**Date:** 2026-09-23\
**Status:** Implementation in progress; non-OAuth delivery implemented, OAuth integration pending\
**Owner:** OCE provider integration and Agent authentication\
**Tracking:** [Provider expansion #84](https://github.com/openclaw/openclaw-enterprise/issues/84)

## Scope

OpenClaw Enterprise (OCE) lets operators save a model provider and authentication
method before creating an Agent, then reuse that connection within its Namespace.
The completion target includes working setup and deployment for every offered
provider/auth method. The current checkpoint implements credential entry and
native OpenAI API-key, Anthropic, and local-provider delivery. OAuth acquisition
and runtime ownership have a separate implementation owner; their integration
is required before this work is complete. No new inference transport is needed.

An Installation [Provider](../docs/reference/providers.md) remains startup-loaded
configuration for related Drivers. `Agent.providerId` retains its existing
managed-service-account meaning. A new **ProviderConnection** records model setup
for one Namespace; it neither creates an Installation Provider nor changes model
or Harness selection. Existing direct Secret, managed ChatGPT account, and
operator-managed runtime bindings remain available where supported.

## Catalog and availability

The bundled [catalog](../apps/controller/src/providers/model-auth-catalog.ts)
uses native OpenClaw provider and method IDs:

| Provider    | Methods                                            | Deployable through a connection |
| ----------- | -------------------------------------------------- | ------------------------------- |
| `openai`    | `api-key`, `oauth`, `device-code`, `token-sharing` | `api-key`                       |
| `anthropic` | `api-key`, `setup-token`                           | Both, embedded OpenClaw         |
| `ollama`    | `local`                                            | Embedded OpenClaw               |
| `vllm`      | `custom`                                           | Embedded OpenClaw               |

Mappings are source-checked against OpenClaw `2026.9.1`. The pending SIWC
`token-sharing` connection method maps to native `siwc` in the pending provider
implementation. It has no recorded native release; its version is null.
`nativeVersion` is evidence of the inspected mapping, not a minimum version,
compatible-image guarantee, or live verification. `deploymentAuthMethod` and
`unavailableReason` separately describe OCE availability.

Anthropic setup tokens are static credentials, not browser OAuth. Ollama setup
records an endpoint without a credential. vLLM's pinned native setup requires a
nonempty API key, represented by a Secret reference. Neither local choice
provisions a server, changes egress, or adds an inference adapter.

## API, ownership, and persistence

`GET /provider-catalog` requires Installation `read`. Connection operations are:

- `GET` and `POST /namespaces/:namespaceId/provider-connections`.
- `GET` and `DELETE /namespaces/:namespaceId/provider-connections/:connectionId`.

Creation requires a ready Namespace and collection `provider_connection:create`.
List and detail reads require exact connection `read`; list results are filtered
per row. Deletion requires exact connection `delete`. Connection names are unique
within a Namespace.

A connection contains its ID, Namespace, name, provider, authentication method,
creation time, optional same-Namespace Secret reference, and optional endpoint.
These fields are immutable; a changed setup gets a new connection. Credential
values stay in the selected Secret Driver. OAuth records contain no token bytes,
refresh state, or authentication success claim. Endpoint input is restricted to
HTTP or HTTPS without embedded credentials, query, or fragment. Creation checks
catalog-required inputs and source permissions but contacts no upstream provider.

The PostgreSQL `provider_connections` table stores this metadata. Source ownership
and Agent references retain the existing Namespace boundaries. A referenced
connection blocks Namespace deletion; a connection referencing a Secret protects
that source from deletion. Removing a connection does not delete its Secret or
revoke an upstream credential.

## Agent and console workflow

In **Providers**, the operator selects the Namespace, connection name, provider,
and authentication method. Secret-backed choices accept a credential value or
an existing Secret ID; local choices require a base URL. Entering a credential
creates its Secret and connection atomically with separate permissions and audit.
Credential inputs are cleared after submission, and uncertain outcomes require
refresh before another creation. Pending methods retain explicit limits. Saving an OAuth selection starts no consent flow. Installation Providers
remain a separate read-only inventory on the same page.

An Agent selects `{ "method": "provider_connection", "connectionId": "..." }`
through `harnessAuth`. Binding requires the actor's exact connection `operate`
and source Secret `operate`. Deployment checks both grants for the actor and the
Agent service principal, then checks the catalog's deployment capability.
Unavailable methods fail admission with an explicit reason.

Admission preserves a `provider_connection` snapshot with the connection ID,
provider, method, optional endpoint, and optional Secret reference/Driver identity.
The worker repeats authorization and ownership checks before Compute effects.
Compute owns native provider configuration and Secret projection; the deployed
OpenClaw process performs the model probe. Local connections require separately
configured network access and do not create egress grants. This work adds no
inference broker or InferenceDriver requirement.

Draft Agents, active revisions, and pending deployments block connection deletion.
Inactive historical revisions retain their snapshots after an unused connection
is removed. Updating a source Secret follows the existing explicit redeployment
workflow and cannot restore historical key values.

## Remaining integration and proof

OAuth acquisition and runtime custody remain with the separate login owner;
OpenClaw SIWC retains its native implementation owner. Reusable connection
metadata is distinct from one OAuth credential profile per Agent across revisions.
Cross-Agent OAuth sharing and a credential broker are outside this implementation.
The Console consumes an authenticated, exact-Agent socket for login and private
redirect input, with HTTP status and cancellation. Acquisition/custody endpoints
are integrated, but production acquisition composition remains unqualified.
Runtime enablement
requires qualified generation, PVC, execution ownership, and refresh behavior.
SIWC additionally requires a qualified native image pin. Pending catalog methods
must become functional before the completion target is met.

Validation must exercise catalog and connection API permissions, foreign-Namespace
denial, immutable storage, source deletion guards, unavailable-method admission,
connection-backed Agent deployment snapshots, and worker reauthorization. Console
coverage must distinguish saved setup from authenticated or deployable state.
PostgreSQL and HTTP integration establish their respective persistence and API
behavior; source mappings and browser fixtures do not prove live provider login
or model execution. Record actual checks and remaining runtime proof at handoff.
