---
rfc: index.md
---

# Token Service FAQ: OpenShell overlap and composition

This FAQ accompanies [RFC-0056](index.md). The decision is to keep one OCC Token
Service implementation with pluggable TokenDrivers. OpenShell is not a
replaceable backend for that service. OpenShell users can manage credentials
entirely through OpenShell, or use OCC as a credential supplier to OpenShell.
The latter is an integration direction, not a delivered feature of this RFC.

## What overlaps with OpenShell?

Both systems keep real credentials away from Agent processes and manage their
lifetime. OpenShell providers associate credentials with Sandbox access policy;
its proxy resolves credential placeholders for allowed requests. OpenShell also
supports provider refresh, including storing OAuth refresh material at its
gateway and replacing access tokens before expiry. See its
[provider documentation](https://github.com/NVIDIA/OpenShell/blob/ec49209da25be39840742df29b64ec694d159c2f/docs/how-it-works/providers/overview.mdx)
and [OAuth refresh example](https://github.com/NVIDIA/OpenShell/blob/ec49209da25be39840742df29b64ec694d159c2f/docs/tutorials/microsoft-graph-provider-refresh.mdx).

The proposed OCC Token Service owns issuance through TokenDrivers, lease and
cleanup accounting, and authorization against OCC Agent lifecycle and admitted
grants. Its first caller is the repository gateway serving Git and `gh`.
OpenShell owns Sandbox-side credential injection and egress enforcement. Similar
credential-lifetime mechanisms do not make their authorization or lifecycle
contracts interchangeable.

## Can OpenShell replace the OCC token broker backend?

No. This RFC does not introduce a selectable broker backend or an OpenShell
implementation of the OCC lease engine. TokenDrivers extend upstream issuance
and retirement; they do not replace OCC admission checks, bearer verification,
lease state, or recovery accounting.

A backend abstraction would need to translate those contracts into OpenShell
provider, Workspace, and Sandbox lifecycles and reconcile two systems' failures.
We do not need that complexity for the selected integration choices. The
existing OCC OpenShell Backend, which groups Sandbox and Credential Gateway
Drivers, is a separate platform concept; this decision does not remove it.

## How can an OpenShell deployment manage credentials?

Choose one of these paths for the credentials in question:

| Path                                   | OCC responsibility                                                                                             | OpenShell responsibility                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| OpenShell manages credentials directly | Do not use the OCC token broker for these credentials. Other OCC platform capabilities can still be used.      | Configure providers and their credential sources, own refresh where configured, and enforce Sandbox access and injection. |
| OCC supplies credentials to OpenShell  | Issue or obtain the scoped credential and deliver it through an authenticated integration to OpenShell itself. | Receive the credential as a trusted service, expose placeholders to the Agent, and enforce provider policy at egress.     |

In the second path, OpenShell is a trusted credential recipient. The Agent does
not receive a raw token from OCC. This expands custody to OpenShell, so OCC's
memory-only storage and broker revocation guarantees cannot automatically be
claimed for the copy OpenShell holds. Revoking an OCC bearer alone does not
invalidate a credential already supplied to OpenShell.

The handoff must define recipient authentication, Namespace/Workspace ownership,
allowed credential scope, replacement, expiry, and withdrawal. It is separate
from the Agent bearer interface and does not create a general raw-token API.
First delivery keeps upstream tokens within the OCC service; the trusted-service
handoff requires a follow-up contract and implementation.

## Which system refreshes the token when both are used?

Assign one refresh owner per credential. When OCC supplies short-lived tokens,
OCC owns obtaining replacements and the integration updates OpenShell before
expiry; OpenShell uses the supplied credential for injection. It must not also
run an independent refresh loop for that same credential.

When OpenShell owns an OAuth refresh grant, OpenShell owns its access-token
refresh and recovery. Supplying bootstrap material is a separate role from
leasing each resulting access token through OCC. The current RFC neither adds
persistent OAuth refresh-token custody nor implements that bootstrap handoff.

## Does OCC already supply secrets to OpenShell?

The existing [OpenShell Credential Gateway](../../../docs/reference/drivers/openshell-credential-gateway.md)
registers and updates credential sources as OpenShell providers; its supported
catalog currently contains OpenAI API keys. This demonstrates the direction of
composition. It does not implement generic Token Service leases or their
renewal and withdrawal through OpenShell, and it does not establish production
support for the OpenShell execution path. The reference owns those limits.

Keep this integration with the existing CredentialGatewayDriver and OpenShell
Backend owners. Extend their contracts where needed for a concrete consumer;
do not add a parallel broker-backend plugin framework.
