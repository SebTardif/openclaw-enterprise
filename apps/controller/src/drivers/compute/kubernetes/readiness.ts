import type { CoreV1Api, DiscoveryV1Api, KubernetesObjectApi } from "@kubernetes/client-node";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString, numericErrorStatus } from "@openclaw-enterprise/utils";
import { currentComputeAbortSignal } from "../operation-context.ts";
import type { KubernetesResourceReader, ManagedKubernetesObject } from "./ownership.ts";
import {
  ConfigurationFailure,
  GVISOR_RUNTIME_CLASS,
  required,
  type Ownership,
} from "./resources/identity.ts";

type KubernetesRecord = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 10_000;

export class IsolationFailure extends ConfigurationFailure {}

export interface KubernetesReadinessDependencies {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "listNamespacedPod">;
    readonly discovery: Pick<DiscoveryV1Api, "listNamespacedEndpointSlice">;
    readonly objects: Pick<KubernetesObjectApi, "read">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  getOwned: KubernetesResourceReader["getOwned"];
}

function labelsToSelector(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

export class KubernetesReadiness {
  private readonly dependencies: KubernetesReadinessDependencies;
  private readonly isolationProfile: "gvisor-systrap" | undefined;

  constructor(
    dependencies: KubernetesReadinessDependencies,
    isolationProfile: "gvisor-systrap" | undefined,
  ) {
    this.dependencies = dependencies;
    this.isolationProfile = isolationProfile;
  }

  async providerHarnessReady(
    revision: Pick<AgentRevision, "agentId" | "id">,
    namespace: string,
    labels: Readonly<Record<string, string>>,
    requiredRuntimeClass?: string,
  ): Promise<boolean> {
    const clients = await this.dependencies.clients();
    const pods = asRecord(
      await this.dependencies.request(() =>
        clients.core.listNamespacedPod({
          namespace,
          // Observe every Pod the active Agent Service could route to, even if an
          // additional provider requirement label is missing or contradictory.
          labelSelector: labelsToSelector({
            "openclaw.dev/agent": revision.agentId,
            "openclaw.dev/revision": revision.id,
            "openclaw.dev/workload-role": "agent",
          }),
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    currentComputeAbortSignal()?.throwIfAborted();
    const invalidObservation = () =>
      new Error(
        "The Kubernetes client returned an invalid or incomplete provider Harness Pod list.",
      );
    const listMetadata = asRecord(pods?.metadata);
    if (
      !Array.isArray(pods?.items) ||
      (pods.apiVersion !== undefined && pods.apiVersion !== "v1") ||
      (pods.kind !== undefined && pods.kind !== "PodList") ||
      (pods.metadata !== undefined && listMetadata === undefined) ||
      (listMetadata?.continue !== undefined && listMetadata.continue !== "") ||
      (listMetadata?._continue !== undefined && listMetadata._continue !== "") ||
      (listMetadata?.remainingItemCount !== undefined && listMetadata.remainingItemCount !== 0)
    ) {
      throw invalidObservation();
    }
    let candidates = 0;
    let candidateReady = false;
    let conflictingLabels = false;
    // Validate the whole observation before trusting uniqueness, including entries after a Ready Pod.
    for (const item of pods.items) {
      const pod = asRecord(item);
      const metadata = asRecord(pod?.metadata);
      const podLabels = asRecord(metadata?.labels);
      const status = asRecord(pod?.status);
      if (
        pod === undefined ||
        (pod.apiVersion !== undefined && pod.apiVersion !== "v1") ||
        (pod.kind !== undefined && pod.kind !== "Pod") ||
        metadata === undefined ||
        !isNonEmptyString(metadata.name) ||
        !isNonEmptyString(metadata.namespace) ||
        (metadata.labels !== undefined && podLabels === undefined) ||
        Object.values(podLabels ?? {}).some((value) => typeof value !== "string") ||
        (pod.status !== undefined && status === undefined) ||
        (status?.conditions !== undefined && !Array.isArray(status.conditions))
      ) {
        throw invalidObservation();
      }
      const deletedAt = metadata.deletionTimestamp;
      if (
        deletedAt !== undefined &&
        !(
          (deletedAt instanceof Date && Number.isFinite(deletedAt.getTime())) ||
          (typeof deletedAt === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
              deletedAt,
            ) &&
            Number.isFinite(Date.parse(deletedAt)))
        )
      ) {
        throw invalidObservation();
      }
      const conditionTypes = new Set<string>();
      let ready = false;
      for (const condition of (status?.conditions ?? []) as unknown[]) {
        const observed = asRecord(condition);
        if (
          observed === undefined ||
          !isNonEmptyString(observed.type) ||
          typeof observed.status !== "string" ||
          !["True", "False", "Unknown"].includes(observed.status) ||
          conditionTypes.has(observed.type)
        ) {
          throw invalidObservation();
        }
        conditionTypes.add(observed.type);
        if (observed.type === "Ready") ready = observed.status === "True";
      }
      if (
        metadata.namespace !== namespace ||
        podLabels?.["openclaw.dev/agent"] !== revision.agentId ||
        podLabels?.["openclaw.dev/revision"] !== revision.id ||
        podLabels?.["openclaw.dev/workload-role"] !== "agent"
      ) {
        continue;
      }
      if (
        deletedAt !== undefined &&
        (requiredRuntimeClass === undefined ||
          status?.phase === "Succeeded" ||
          status?.phase === "Failed")
      ) {
        continue;
      }
      if (requiredRuntimeClass !== undefined) {
        // A Pod selected by this revision's route must be contained on a runtime
        // violation even when its additional ownership labels also contradict expectations.
        if (asRecord(pod.spec)?.runtimeClassName !== requiredRuntimeClass) {
          throw new IsolationFailure(
            "gVisor Alpha Pod lost its required RuntimeClass; refusing fallback.",
          );
        }
        ready = ready && status?.phase === "Running";
      }
      // Deletion intent is not termination: verify a nonterminal Pod's runtime
      // above before excluding it from readiness, since it may still write shared data.
      if (deletedAt !== undefined) continue;
      if (Object.entries(labels).some(([key, value]) => podLabels?.[key] !== value)) {
        if (requiredRuntimeClass === undefined) throw invalidObservation();
        // Inspect the remaining candidates before reporting label drift so an
        // earlier conflict cannot mask a later Pod's explicit runtime violation.
        conflictingLabels = true;
      }
      candidates += 1;
      candidateReady = ready;
    }
    if (conflictingLabels) throw invalidObservation();
    return candidates === 1 && candidateReady;
  }

  async gatewayReady(
    ownership: Ownership,
    gatewayName: string,
    namespace: string,
  ): Promise<boolean> {
    const clients = await this.dependencies.clients();
    const deployment = await this.dependencies.getOwned(
      "Deployment",
      gatewayName,
      namespace,
      ownership,
    );
    if (deployment === undefined) return false;
    if (deployment.spec?.replicas !== 1) return false;
    if (!this.deploymentReady(deployment)) return false;
    const service = await this.dependencies.getOwned("Service", gatewayName, namespace, ownership);
    if (service === undefined) return false;
    const slices = asRecord(
      await this.dependencies.request(() =>
        clients.discovery.listNamespacedEndpointSlice({
          namespace,
          labelSelector: `kubernetes.io/service-name=${gatewayName}`,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    const items = Array.isArray(slices?.items) ? slices.items : [];
    return items.some((item) => {
      const slice = asRecord(item);
      const metadata = asRecord(slice?.metadata);
      if (asRecord(metadata?.labels)?.["kubernetes.io/service-name"] !== gatewayName) return false;
      if (service.metadata.uid !== undefined) {
        const references = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : [];
        if (
          !references.some((reference) => {
            const owner = asRecord(reference);
            return (
              owner?.kind === "Service" &&
              owner.name === gatewayName &&
              owner.uid === service.metadata.uid
            );
          })
        )
          return false;
      }
      return (
        Array.isArray(slice?.endpoints) &&
        slice.endpoints.some(
          (endpoint: unknown) => asRecord(asRecord(endpoint)?.conditions)?.ready === true,
        )
      );
    });
  }

  async verifyIsolationProfile(): Promise<void> {
    if (this.isolationProfile === undefined) return;
    const clients = await this.dependencies.clients();
    let runtimeClass: KubernetesRecord | undefined;
    try {
      runtimeClass = asRecord(
        await this.dependencies.request(() =>
          clients.objects.read({
            apiVersion: "node.k8s.io/v1",
            kind: "RuntimeClass",
            metadata: { name: GVISOR_RUNTIME_CLASS },
          }),
        ),
      );
    } catch (error) {
      if (numericErrorStatus(error) === 404) {
        throw new IsolationFailure("gVisor Alpha RuntimeClass is missing; refusing fallback.");
      }
      throw error;
    }
    const metadata = asRecord(runtimeClass?.metadata);
    if (
      runtimeClass?.apiVersion !== "node.k8s.io/v1" ||
      runtimeClass.kind !== "RuntimeClass" ||
      metadata?.name !== GVISOR_RUNTIME_CLASS ||
      metadata.namespace !== undefined ||
      metadata.deletionTimestamp !== undefined ||
      runtimeClass.handler !== GVISOR_RUNTIME_CLASS
    ) {
      throw new IsolationFailure(
        "gVisor Alpha requires the exact oce-gvisor-systrap RuntimeClass and handler; refusing fallback.",
      );
    }
  }

  async dedicatedDeploymentReady(
    deployment: ManagedKubernetesObject,
    namespace: string,
  ): Promise<boolean> {
    if (this.isolationProfile === undefined) return this.deploymentReady(deployment);
    await this.verifyIsolationProfile();
    const template = asRecord(deployment.spec?.template);
    const spec = asRecord(template?.spec);
    if (spec?.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
      throw new IsolationFailure("gVisor Alpha workload lost its required RuntimeClass.");
    }
    const labels: Record<string, string> = {
      ...deployment.metadata.labels,
      "app.kubernetes.io/name": deployment.metadata.name,
      "openclaw.dev/workload-role": "agent",
    };
    const templateLabels = asRecord(asRecord(template?.metadata)?.labels);
    if (Object.entries(labels).some(([key, value]) => templateLabels?.[key] !== value)) {
      throw new IsolationFailure("gVisor Alpha workload labels do not match its ownership.");
    }
    // Inspect placement even during a rollout: an unready Deployment can still have a live unsafe Pod.
    const podsReady = await this.providerHarnessReady(
      {
        agentId: required(labels["openclaw.dev/agent"], "gVisor workload Agent ID"),
        id: required(labels["openclaw.dev/revision"], "gVisor workload revision ID"),
      },
      namespace,
      labels,
      GVISOR_RUNTIME_CLASS,
    );
    return this.deploymentReady(deployment) && podsReady;
  }

  deploymentReady(deployment: ManagedKubernetesObject): boolean {
    const replicas = deployment.spec?.replicas;
    const generation = deployment.metadata.generation;
    const observed = deployment.status?.observedGeneration;
    const ready = deployment.status?.readyReplicas;
    return (
      typeof replicas === "number" &&
      replicas > 0 &&
      typeof generation === "number" &&
      typeof observed === "number" &&
      observed >= generation &&
      typeof ready === "number" &&
      ready >= replicas
    );
  }
}
