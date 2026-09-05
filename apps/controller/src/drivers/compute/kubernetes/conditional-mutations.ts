import type {
  AppsV1Api,
  CoreV1Api,
  KubernetesObjectApi,
  NetworkingV1Api,
} from "@kubernetes/client-node";
import { asRecord } from "@openclaw-enterprise/utils";
import { ConfigurationFailure, required } from "./resources/identity.ts";
import type { Ownership } from "./resources/identity.ts";
import { CONFIGURATION_DOCUMENT } from "./resources/gateway.ts";
import { OwnershipFailure } from "./ownership.ts";
import type { KubernetesResourceReader, ManagedKubernetesObject } from "./ownership.ts";

export interface KubernetesMutationDependencies {
  clients(): Promise<{
    readonly core: Pick<
      CoreV1Api,
      | "patchNamespace"
      | "patchNamespacedConfigMap"
      | "patchNamespacedServiceAccount"
      | "patchNamespacedService"
      | "patchNamespacedResourceQuota"
      | "patchNamespacedLimitRange"
      | "patchNamespacedPersistentVolumeClaim"
    >;
    readonly apps: Pick<AppsV1Api, "patchNamespacedDeployment">;
    readonly networking: Pick<NetworkingV1Api, "patchNamespacedNetworkPolicy">;
    readonly objects: Pick<KubernetesObjectApi, "patch">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  getOwned: KubernetesResourceReader["getOwned"];
  patchOptions(): ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;
}

const FIELD_MANAGER = "openclaw-enterprise-compute";
const APPLY_CONTENT_TYPE = "application/apply-patch+yaml";

export function verifyPersistentVolumeClaim(
  claim: ManagedKubernetesObject,
  desired: ManagedKubernetesObject,
): void {
  const accessModes = Array.isArray(claim.spec?.accessModes) ? claim.spec.accessModes : [];
  const expectedModes = Array.isArray(desired.spec?.accessModes) ? desired.spec.accessModes : [];
  const requests = asRecord(asRecord(claim.spec?.resources)?.requests);
  const expectedRequests = asRecord(asRecord(desired.spec?.resources)?.requests);
  if (
    claim.metadata.deletionTimestamp !== undefined ||
    accessModes.length !== expectedModes.length ||
    accessModes.some((mode, index) => mode !== expectedModes[index]) ||
    requests?.storage !== expectedRequests?.storage ||
    (claim.spec?.volumeMode ?? "Filesystem") !== (desired.spec?.volumeMode ?? "Filesystem") ||
    (desired.spec?.storageClassName !== undefined &&
      claim.spec?.storageClassName !== desired.spec.storageClassName)
  ) {
    throw new OwnershipFailure(`Refusing invalid PersistentVolumeClaim ${claim.metadata.name}.`);
  }
}

export class KubernetesConditionalMutations {
  private readonly dependencies: KubernetesMutationDependencies;

  constructor(dependencies: KubernetesMutationDependencies) {
    this.dependencies = dependencies;
  }

  async reconcile(
    desired: ManagedKubernetesObject,
    ownership: Ownership,
    namespace?: string,
  ): Promise<void> {
    const clients = await this.dependencies.clients();
    const existing = await this.dependencies.getOwned(
      desired.kind,
      desired.metadata.name,
      namespace,
      ownership,
    );
    await this.reconcileObserved(desired, existing, namespace, clients);
  }

  async reconcileServiceForSelector(
    desired: ManagedKubernetesObject<"Service">,
    ownership: Ownership,
    namespace: string,
    serviceSelector: Readonly<Record<string, string>>,
  ): Promise<void> {
    const clients = await this.dependencies.clients();
    const existing = await this.dependencies.getOwned(
      desired.kind,
      desired.metadata.name,
      namespace,
      ownership,
    );
    if (desired.kind !== "Service") {
      throw new ConfigurationFailure(
        `Unsupported Kubernetes reconcile precondition for ${desired.kind}.`,
      );
    }
    if (existing === undefined) return;
    const selector = asRecord(existing.spec?.selector);
    if (Object.entries(serviceSelector).some(([name, value]) => selector?.[name] !== value)) return;
    await this.reconcileObserved(desired, existing, namespace, clients);
  }

  private async reconcileObserved(
    desired: ManagedKubernetesObject,
    existing: ManagedKubernetesObject | undefined,
    namespace: string | undefined,
    clients: Awaited<ReturnType<KubernetesMutationDependencies["clients"]>>,
  ): Promise<void> {
    if (existing !== undefined) {
      if (desired.kind === "ConfigMap") {
        const annotations = desired.metadata.annotations ?? {};
        if (
          existing.immutable !== true ||
          Object.entries(annotations).some(
            ([name, value]) => existing.metadata.annotations?.[name] !== value,
          ) ||
          existing.data?.[CONFIGURATION_DOCUMENT] !== desired.data?.[CONFIGURATION_DOCUMENT] ||
          Object.keys(existing.data ?? {}).length !== 1 ||
          Object.keys(existing.binaryData ?? {}).length !== 0
        ) {
          throw new OwnershipFailure(
            `Refusing invalid immutable Kubernetes ConfigMap ${desired.metadata.name}.`,
          );
        }
        return;
      }
      if (desired.kind === "PersistentVolumeClaim") {
        verifyPersistentVolumeClaim(existing, desired);
        return;
      }
    }
    const request = {
      name: desired.metadata.name,
      body: desired,
      fieldManager: FIELD_MANAGER,
      force: false,
    };
    await this.dependencies.request(
      async () => {
        switch (desired.kind) {
          case "Namespace":
            await clients.core.patchNamespace(request, this.dependencies.patchOptions());
            return;
          case "ConfigMap":
            await clients.core.patchNamespacedConfigMap(
              { ...request, namespace: required(namespace, "ConfigMap namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "ServiceAccount":
            await clients.core.patchNamespacedServiceAccount(
              { ...request, namespace: required(namespace, "ServiceAccount namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "Service":
            await clients.core.patchNamespacedService(
              { ...request, namespace: required(namespace, "Service namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "ResourceQuota":
            await clients.core.patchNamespacedResourceQuota(
              { ...request, namespace: required(namespace, "ResourceQuota namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "LimitRange":
            await clients.core.patchNamespacedLimitRange(
              { ...request, namespace: required(namespace, "LimitRange namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "PersistentVolumeClaim":
            await clients.core.patchNamespacedPersistentVolumeClaim(
              { ...request, namespace: required(namespace, "PersistentVolumeClaim namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "Deployment":
            await clients.apps.patchNamespacedDeployment(
              { ...request, namespace: required(namespace, "Deployment namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "NetworkPolicy":
            await clients.networking.patchNamespacedNetworkPolicy(
              { ...request, namespace: required(namespace, "NetworkPolicy namespace") },
              this.dependencies.patchOptions(),
            );
            return;
          case "HTTPRoute":
            await clients.objects.patch(
              desired,
              undefined,
              undefined,
              FIELD_MANAGER,
              false,
              APPLY_CONTENT_TYPE,
            );
            return;
          default: {
            const unsupported: never = desired.kind;
            throw new ConfigurationFailure(
              `Unsupported managed Kubernetes resource ${unsupported}.`,
            );
          }
        }
      },
      { mutating: true },
    );
  }
}
