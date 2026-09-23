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

## Implemented contracts

The [provider reference](../docs/reference/providers.md#model-authentication-catalog-and-saved-connections)
owns API routes, permissions, immutable connection fields, Secret ownership,
endpoint validation, and deletion guards. The
[Console workflow](../docs/reference/console.md#save-a-provider-connection)
owns credential entry, uncertain-save recovery, and Agent selection.

Key design decisions remain:

- `Agent.harnessAuth` stores `{method: "provider_connection", connectionId}`;
  the connection is reusable metadata, while Secret bytes stay with its Driver.
- Admission snapshots safe connection metadata; dispatch rechecks actor, Agent,
  connection, and Secret authority before Compute projects credentials.
- Compute owns native configuration and credential delivery. The deployed
  OpenClaw process probes the selected model. No inference broker is introduced.
- Local endpoints require separately configured network access. Saving setup
  neither contacts the endpoint nor grants egress.
- Drafts, active revisions, and pending deployments protect connection references.
  Historical snapshots do not retain old credential values; changing a Secret
  uses the existing explicit redeployment workflow.

## Remaining integration and proof

OAuth acquisition and runtime custody remain with the separate login owner;
OpenClaw SIWC retains its native implementation owner. Reusable connection
metadata is distinct from one OAuth credential profile per Agent across revisions.
Cross-Agent OAuth sharing and a credential broker are outside this implementation.
The Console consumes an authenticated, exact-Agent socket for login and private
redirect input, with HTTP status and cancellation. Acquisition/custody endpoints
are integrated, but production acquisition composition remains unqualified.
Runtime enablement requires qualified generation, PVC, execution ownership, and refresh behavior.
SIWC additionally requires a qualified native image pin. Pending catalog methods
must become functional before the completion target is met.

Validation must exercise catalog and connection API permissions, foreign-Namespace
denial, immutable storage, source deletion guards, unavailable-method admission,
connection-backed Agent deployment snapshots, and worker reauthorization. Console
coverage must distinguish saved setup from authenticated or deployable state.
PostgreSQL and HTTP integration establish their respective persistence and API
behavior; source mappings and browser fixtures do not prove live provider login
or model execution. Record actual checks and remaining runtime proof at handoff.
