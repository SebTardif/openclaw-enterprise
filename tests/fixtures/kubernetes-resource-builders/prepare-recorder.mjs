// A transport-only SDK stand-in: it stores request bodies and supplies an unready workload.
// The production Driver owns configuration validation, resource decisions, and lifecycle order.
export function prepareRecorder(scenario) {
  const { driver, revision, namespace } = scenario;
  const ownership = { namespaceId: revision.namespaceId };
  const namespaceObject = driver.manifest("v1", "Namespace", namespace, ownership);
  const objects = new Map([
    [
      `Namespace/${namespace}`,
      {
        ...namespaceObject,
        metadata: {
          ...namespaceObject.metadata,
          uid: "namespace-observed-uid",
          labels: {
            ...namespaceObject.metadata.labels,
            "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/audit": "restricted",
            "pod-security.kubernetes.io/warn": "restricted",
          },
        },
        status: { phase: "Active" },
      },
    ],
    ...driver
      .networkPolicies(ownership, namespace)
      .map((policy) => [`NetworkPolicy/${policy.metadata.name}`, policy]),
  ]);
  const events = [];
  const writes = [];
  const read =
    (kind) =>
    async ({ name }) => {
      const value = objects.get(`${kind}/${name}`);
      if (value === undefined)
        throw Object.assign(new Error("fixture missing resource"), { code: 404 });
      return structuredClone(value);
    };
  const patch =
    (kind) =>
    async ({ body, force, fieldManager }) => {
      if (force !== false || fieldManager !== "openclaw-enterprise-compute")
        throw new Error("unexpected apply options");
      events.push(`apply:${kind}`);
      writes.push(structuredClone(body));
      objects.set(`${kind}/${body.metadata.name}`, {
        ...structuredClone(body),
        metadata: { ...body.metadata, uid: `observed-${kind}-uid` },
      });
    };
  driver.apiClients = Promise.resolve({
    core: {
      listNamespace: async () => ({ items: [objects.get(`Namespace/${namespace}`)] }),
      readNamespace: read("Namespace"),
      readNamespacedConfigMap: read("ConfigMap"),
      patchNamespacedConfigMap: patch("ConfigMap"),
      readNamespacedServiceAccount: read("ServiceAccount"),
      patchNamespacedServiceAccount: patch("ServiceAccount"),
      readNamespacedService: read("Service"),
      patchNamespacedService: patch("Service"),
    },
    networking: {
      readNamespacedNetworkPolicy: read("NetworkPolicy"),
      patchNamespacedNetworkPolicy: patch("NetworkPolicy"),
    },
    apps: {
      readNamespacedDeployment: read("Deployment"),
      patchNamespacedDeployment: patch("Deployment"),
    },
  });
  driver.setLifecycleDrivers([
    {
      id: "configuration-builders",
      capability: "configuration",
      implementation: "fixture-recorder",
      computeLifecycleHooks: {
        async beforeWorkloadStart(observedRevision) {
          events.push("hook:beforeWorkloadStart");
          if (!Object.isFrozen(observedRevision.configuration))
            throw new Error("revision is mutable");
        },
      },
    },
  ]);
  return { objects, events, writes };
}
