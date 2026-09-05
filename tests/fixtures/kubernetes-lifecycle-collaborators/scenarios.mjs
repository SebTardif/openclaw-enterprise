import { readFileSync } from "node:fs";
import { KubernetesComputeDriver } from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../../apps/controller/src/drivers/compute/operation-context.ts";
import { apiError, clone, controlledClient, resourceKey } from "./client.mjs";

export const inputs = JSON.parse(readFileSync(new URL("./inputs.json", import.meta.url), "utf8"));
const observations = JSON.parse(
  readFileSync(new URL("./observations.json", import.meta.url), "utf8"),
);

export const scenarioNames = [
  "namespace-ensure-ready",
  "adoption",
  "adoption-same-tenant-conflict",
  "adoption-competing-tenant-conflict",
  "adoption-foreign-policy",
  "adoption-missing-resource-version",
  "external-delete",
  "external-delete-foreign-policy",
  "namespace-delete-pending",
  "namespace-delete-complete",
  "prepare-ready",
  "prepare-stale-gateway-generation",
  "prepare-endpoints-for-another-service-uid",
  "prepare-stale-agent-generation",
  "prepare-changed-immutable-document",
  "prepare-mutable-configuration",
  "prepare-extra-binary-configuration",
  "prepare-incompatible-claim",
  "activate-unready-revision",
  "activate-ready-revision",
  "deactivate-current-revision",
  "deactivate-successor-revision",
  "deactivate-missing-service",
  "retire-current-revision",
  "retire-predecessor-revision",
  "retire-route-successor-without-gateway",
  "retire-route-missing-uid",
  "retire-claim-missing-uid",
  "retire-service-delete-failure",
  "prepare-unknown-mutation-effect",
  "prepare-cleanup-failure",
  "prepare-owner-cancellation",
  "prepare-already-cancelled",
  "prepare-transient-read",
];

function errorObservation(error) {
  return {
    name: error.name,
    message: error.message,
    ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
    ...(error.errors === undefined ? {} : { errors: error.errors.map(errorObservation) }),
  };
}

export async function runScenario(name) {
  if (!scenarioNames.includes(name)) throw new Error(`Unknown lifecycle scenario ${name}`);
  const successor = [
    "retire-predecessor-revision",
    "retire-route-successor-without-gateway",
    "deactivate-successor-revision",
  ].includes(name);
  let resources = successor ? observations.successorResources : observations.resources;
  if (name.startsWith("adoption")) {
    resources = observations.namespaceResources.filter(({ kind }) => kind === "Namespace");
  } else if (name.startsWith("namespace-") || name.startsWith("external-delete")) {
    resources = observations.namespaceResources;
  }
  const client = controlledClient(resources, observations.endpointSlices);
  const events = [];
  const owner = new AbortController();
  const cancellation = new Error("controlled revision owner cancelled");
  const mutationError = apiError(503);
  const participants = ["first", "second"].map((id) => ({
    id,
    capability: "configuration",
    implementation: "controlled-lifecycle-observer",
    computeLifecycleHooks: Object.fromEntries(
      [
        "afterNamespacePrepared",
        "beforeNamespaceDelete",
        "beforeWorkloadStart",
        "beforeWorkloadStop",
      ].map((phase) => [
        phase,
        async (resource, launchOrSignal, startSignal) => {
          const signal = startSignal ?? launchOrSignal;
          client.order.push(`${phase}:${id}`);
          events.push({
            phase,
            owner: id,
            resourceId: resource.id,
            frozen: Object.isFrozen(resource),
            signalAborted: signal.aborted,
          });
          if (
            name === "prepare-cleanup-failure" &&
            phase === "beforeWorkloadStop" &&
            id === "second"
          ) {
            throw new Error("controlled cleanup failure");
          }
        },
      ]),
    ),
  }));
  const driver = new KubernetesComputeDriver(clone(inputs.options), {
    id: inputs.revision.compute.id,
    lifecycleDrivers: participants,
  });
  driver.apiClients = Promise.resolve(client.clients);
  const revision = clone(inputs.revision);
  const tenant = clone(inputs.tenant);
  const all = [...client.objects.values()];
  const resource = (kind, predicate = () => true) =>
    all.find((object) => object.kind === kind && predicate(object));
  const namespace = resource("Namespace");
  const gateway = resource("Deployment", (object) => object.metadata.name.startsWith("gateway-"));
  const agent = resource("Deployment", (object) => object.metadata.name.startsWith("agent-"));
  const service = resource("Service", (object) => object.metadata.name.startsWith("agent-"));
  const route = resource("HTTPRoute");
  const configuration = resource("ConfigMap");
  const claim = resource("PersistentVolumeClaim", (object) =>
    object.metadata.name.startsWith("gateway-state-"),
  );
  let operation = () => driver.prepareRevision(revision);
  let unknownMutationObserved = false;
  let requestSignalAborted;

  if (name.startsWith("adoption") || name.startsWith("external-delete")) {
    const originalName = namespace.metadata.name;
    namespace.metadata.name = "customer-lifecycle";
    namespace.metadata.labels["app.kubernetes.io/managed-by"] = "helm";
    namespace.metadata.annotations["openclaw.dev/namespace-lifecycle"] = "external";
    namespace.metadata.annotations["example.dev/preserved"] = "operator-owned";
    client.objects.delete(resourceKey("Namespace", originalName));
    client.objects.set(resourceKey("Namespace", namespace.metadata.name), namespace);
    for (const object of all) {
      if (object.metadata.namespace !== undefined)
        object.metadata.namespace = namespace.metadata.name;
    }
    tenant.existingNamespace = namespace.metadata.name;
    if (name.startsWith("adoption")) {
      tenant.status = "provisioning";
      delete namespace.metadata.labels["openclaw.dev/namespace"];
      delete namespace.metadata.annotations["openclaw.dev/namespace-id"];
      if (name === "adoption-missing-resource-version") delete namespace.metadata.resourceVersion;
      client.interceptors.set("readNamespacedResourceQuota", () => {
        throw apiError(403);
      });
      if (name.endsWith("conflict")) {
        client.interceptors.set("patchNamespace", (request, apply) => {
          apply();
          if (name === "adoption-competing-tenant-conflict") {
            const observed = client.objects.get(resourceKey("Namespace", namespace.metadata.name));
            observed.metadata.labels["openclaw.dev/namespace"] = "another-tenant";
            observed.metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant";
          }
          throw apiError(409);
        });
      }
      if (name === "adoption-foreign-policy") {
        client.lists.listNamespacedNetworkPolicy = {
          items: [
            {
              apiVersion: "networking.k8s.io/v1",
              kind: "NetworkPolicy",
              metadata: { name: "foreign", namespace: namespace.metadata.name },
            },
          ],
        };
      }
      operation = () => driver.ensureNamespace(tenant);
    } else {
      tenant.status = "deleting";
      if (name === "external-delete-foreign-policy") {
        resource(
          "NetworkPolicy",
          (object) => object.metadata.name === "default-deny",
        ).metadata.annotations["openclaw.dev/namespace-id"] = "another-tenant";
      }
      operation = () => driver.deleteNamespace(tenant);
    }
  } else if (name === "namespace-ensure-ready") {
    tenant.status = "provisioning";
    operation = () => driver.ensureNamespace(tenant);
  } else if (name.startsWith("namespace-delete")) {
    tenant.status = "deleting";
    if (name === "namespace-delete-pending")
      client.interceptors.set("deleteNamespace", () => undefined);
    operation = () => driver.deleteNamespace(tenant);
  } else if (name.startsWith("activate")) {
    if (name === "activate-unready-revision") agent.status.observedGeneration = 1;
    operation = () => driver.activateRevision(revision);
  } else if (name.startsWith("deactivate")) {
    if (name === "deactivate-missing-service")
      client.objects.delete(resourceKey("Service", service.metadata.name));
    operation = () => driver.deactivateRevision(revision);
  } else if (name.startsWith("retire")) {
    if (name === "retire-route-successor-without-gateway") {
      client.objects.delete(resourceKey("Deployment", gateway.metadata.name));
    }
    if (name === "retire-route-missing-uid") delete route.metadata.uid;
    if (name === "retire-claim-missing-uid") delete claim.metadata.uid;
    if (name === "retire-service-delete-failure")
      client.interceptors.set("deleteNamespacedService", () => {
        throw mutationError;
      });
    operation = () => driver.retireRevision(revision);
  } else {
    if (name === "prepare-stale-gateway-generation") gateway.status.observedGeneration = 1;
    if (name === "prepare-endpoints-for-another-service-uid")
      client.lists.listNamespacedEndpointSlice.items[0].metadata.ownerReferences[0].uid =
        "replaced-service-uid";
    if (name === "prepare-stale-agent-generation") agent.status.observedGeneration = 1;
    if (name === "prepare-changed-immutable-document")
      configuration.data[Object.keys(configuration.data)[0]] = "{}";
    if (name === "prepare-mutable-configuration") configuration.immutable = false;
    if (name === "prepare-extra-binary-configuration")
      configuration.binaryData = { unexpected: "YQ==" };
    if (name === "prepare-incompatible-claim")
      resource("PersistentVolumeClaim", (object) => object !== claim).spec.accessModes = [
        "ReadWriteOnce",
      ];
    if (
      [
        "prepare-unknown-mutation-effect",
        "prepare-cleanup-failure",
        "prepare-owner-cancellation",
      ].includes(name)
    ) {
      client.interceptors.set("patchNamespacedDeployment", async (request, apply) => {
        apply();
        if (request.name !== agent.metadata.name) return;
        // The transport models an accepted write followed by a lost response. The
        // Driver must not blindly retry it, and must unwind completed launch hooks.
        unknownMutationObserved = true;
        if (name === "prepare-owner-cancellation") {
          const signal = currentComputeAbortSignal();
          owner.abort(cancellation);
          requestSignalAborted = signal.aborted;
          throw signal.reason;
        }
        throw mutationError;
      });
    }
    if (name === "prepare-transient-read") {
      let reads = 0;
      client.interceptors.set("listNamespace", (request, read) => {
        if (++reads < 3) throw apiError(503);
        return read();
      });
    }
    if (name === "prepare-already-cancelled") owner.abort(cancellation);
  }
  let outcome;
  try {
    const value = await withComputeAbortSignal(owner.signal, operation);
    outcome = { value: value ?? null };
  } catch (error) {
    outcome = {
      error: errorObservation(error),
      ...(name.includes("cancellation") || name === "prepare-already-cancelled"
        ? { originalCancellation: error === cancellation }
        : {}),
      ...(name === "prepare-unknown-mutation-effect" || name === "retire-service-delete-failure"
        ? { originalMutationError: error === mutationError }
        : {}),
    };
  }
  return {
    outcome,
    calls: client.calls,
    order: client.order,
    events,
    ...(unknownMutationObserved ? { unknownMutationObserved } : {}),
    ...(requestSignalAborted === undefined ? {} : { requestSignalAborted }),
  };
}
