import type {
  Principal,
  ResourceRef,
  AgentRevision,
  SecretReference,
  ComputeDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";

export function rejectInvalidTypes(
  principal: Principal,
  revision: AgentRevision,
  secret: SecretReference,
  compute: ComputeDriver,
  sandbox: SandboxDriver,
): void {
  // @ts-expect-error Principals remain Installation-scoped, with no Namespace selector.
  const namespacedPrincipal: Principal = { ...principal, namespaceId: "namespace" };
  // @ts-expect-error A Secret reference requires its exact Namespace.
  const unscopedSecret: SecretReference = { kind: "secret", id: secret.id };
  // @ts-expect-error Provider is not an OCC resource kind.
  const provider: ResourceRef = { kind: "provider", id: "provider" };
  // @ts-expect-error Revision snapshots remain immutable.
  revision.configurationGeneration = 2;
  // @ts-expect-error Each selected Driver retains its exact capability.
  const wrongDriver: ComputeDriver = sandbox;
  // @ts-expect-error Namespace lifecycle results retain a required readiness result.
  const readiness: Awaited<ReturnType<typeof compute.ensureNamespace>> = { namespaceId: "ns" };
  void [namespacedPrincipal, unscopedSecret, provider, wrongDriver, readiness];
}
