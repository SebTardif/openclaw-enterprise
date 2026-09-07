# OpenShell options ownership

Status: Complete. Current behavior is owned by the
[OpenShell SandboxDriver reference](../docs/reference/drivers/openshell-sandbox.md#configuration-ownership).

## Design basis

The authoritative [Driver contracts](../docs/design.md#drivers-and-providers)
keep configuration and admitted intent separate from effectful capabilities.
This change gives the existing OpenShell driver and native adapter explicit
ownership of their accepted plain configuration. It preserves the current
[implementation limits](../docs/ARCHITECTURE.md), including OpenShell's separate
upstream compatibility and enforcement requirements.

## Implementation

- The driver uses the existing `immutableCopy` utility before validating and
  retaining constructor options. Nested policies, gateway configuration, resource
  values, and Kubernetes manifests belong to that immutable snapshot.
- The native gateway adapter uses the same utility for its retained plain gateway
  configuration, including nested authentication options. Its validated executable
  path remains a scalar value.
- The injected gateway client remains an effectful capability with its original
  identity. Active native calls, closed state, and client caching retain their
  existing owners and lifecycles.

## Verification

The options ownership conformance suite captures actual `provisionHarness`
requests through the supported injected gateway client after caller mutations.
It checks launch values and cleanup identity, repeated provisioning, immutable
forwarded resource values, frozen caller inputs, and invalid configuration
rejection. Sandbox startup integration covers the existing composition path.

Native adapter execution is covered separately by the existing real Go process
integration; the conformance suite supplies no native protocol substitute.
Provider, cluster, and containment qualification remain separate requirements.
