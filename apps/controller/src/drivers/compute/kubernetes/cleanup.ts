import type { AppsV1Api, CoreV1Api, NetworkingV1Api } from "@kubernetes/client-node";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { numericErrorStatus, sha256Hex } from "@openclaw-enterprise/utils";
import { verifyPersistentVolumeClaim } from "./conditional-mutations.ts";
import type { KubernetesResourceReader, ManagedKubernetesObject } from "./ownership.ts";
import { AGENT_REVISION_ID_ANNOTATION, required, type Ownership } from "./resources/identity.ts";
import * as KubernetesStorage from "./resources/storage.ts";

export interface KubernetesCleanupOptions {
  readonly runtimeEnabled: boolean;
  readonly gatewayStorageClassName: string | undefined;
}

export interface KubernetesCleanupDependencies {
  clients(): Promise<{
    readonly core: Pick<
      CoreV1Api,
      | "deleteNamespacedService"
      | "deleteNamespacedServiceAccount"
      | "deleteNamespacedResourceQuota"
      | "deleteNamespacedLimitRange"
      | "deleteNamespacedPersistentVolumeClaim"
    >;
    readonly apps: Pick<AppsV1Api, "deleteNamespacedDeployment">;
    readonly networking: Pick<NetworkingV1Api, "deleteNamespacedNetworkPolicy">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  getOwned: KubernetesResourceReader["getOwned"];
  gatewayRouteForRevision(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<ManagedKubernetesObject<"HTTPRoute"> | undefined>;
  deleteGatewayRoute(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<void>;
}

export class KubernetesCleanup {
  private readonly dependencies: KubernetesCleanupDependencies;
  private readonly options: KubernetesCleanupOptions;

  constructor(dependencies: KubernetesCleanupDependencies, options: KubernetesCleanupOptions) {
    this.dependencies = dependencies;
    this.options = options;
  }

  async removeRetiredGateway(revision: AgentRevision, namespace: string): Promise<void> {
    const name = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const gateway = await this.dependencies.getOwned("Deployment", name, namespace, ownership);
    if (gateway === undefined) {
      const route = await this.dependencies.gatewayRouteForRevision(
        name,
        ownership,
        namespace,
        revision.id,
      );
      if (route === undefined) return;
      if (this.options.runtimeEnabled) {
        await this.deleteGatewayPrivateStateClaim(ownership, namespace);
      }
      if (revision.harness.mode === "dedicated") {
        await this.deleteSharedWorkspaceClaim(ownership, namespace);
      }
      await this.dependencies.deleteGatewayRoute(name, ownership, namespace, revision.id);
      await this.deleteGateway(name, ownership, namespace);
      return;
    }
    const annotations = gateway.metadata.annotations ?? {};
    if (annotations[AGENT_REVISION_ID_ANNOTATION] === revision.id) {
      if (this.options.runtimeEnabled) {
        await this.deleteGatewayPrivateStateClaim(ownership, namespace);
      }
      if (revision.harness.mode === "dedicated") {
        await this.deleteSharedWorkspaceClaim(ownership, namespace);
      }
      await this.dependencies.deleteGatewayRoute(name, ownership, namespace, revision.id);
      await this.deleteGateway(name, ownership, namespace);
    }
  }

  async deleteGateway(name: string, ownership: Ownership, namespace: string): Promise<void> {
    const clients = await this.dependencies.clients();
    for (const kind of ["Service", "ServiceAccount", "Deployment"] as const) {
      const existing = await this.dependencies.getOwned(kind, name, namespace, ownership);
      if (existing === undefined) continue;
      const request = {
        name,
        namespace,
        ...(existing.metadata.uid === undefined
          ? {}
          : { body: { preconditions: { uid: existing.metadata.uid } } }),
      };
      await this.dependencies.request(
        async () => {
          if (kind === "Deployment") {
            await clients.apps.deleteNamespacedDeployment(request);
          } else if (kind === "Service") {
            await clients.core.deleteNamespacedService(request);
          } else {
            await clients.core.deleteNamespacedServiceAccount(request);
          }
        },
        { mutating: true },
      );
    }
  }

  async deleteOwnedNamespaceResources(namespace: string, ownership: Ownership): Promise<boolean> {
    const clients = await this.dependencies.clients();
    const infrastructure = [
      ["ResourceQuota", "openclaw-quota"],
      ["LimitRange", "openclaw-limits"],
      ["NetworkPolicy", "allow-dns"],
      ["NetworkPolicy", "allow-gateway-ingress"],
      ["NetworkPolicy", "default-deny"],
    ] as const;
    const resources: ManagedKubernetesObject<"ResourceQuota" | "LimitRange" | "NetworkPolicy">[] =
      [];
    for (const [kind, name] of infrastructure) {
      const existing = await this.dependencies.getOwned(kind, name, namespace, ownership);
      if (existing !== undefined) resources.push(existing);
    }

    for (const resource of resources) {
      const request = {
        name: resource.metadata.name,
        namespace,
        ...(resource.metadata.uid === undefined
          ? {}
          : { body: { preconditions: { uid: resource.metadata.uid } } }),
      };
      try {
        await this.dependencies.request(
          async () => {
            if (resource.kind === "ResourceQuota") {
              await clients.core.deleteNamespacedResourceQuota(request);
            } else if (resource.kind === "LimitRange") {
              await clients.core.deleteNamespacedLimitRange(request);
            } else {
              await clients.networking.deleteNamespacedNetworkPolicy(request);
            }
          },
          { mutating: true },
        );
      } catch (error) {
        if (numericErrorStatus(error) !== 404) throw error;
      }
      const remaining = await this.dependencies.getOwned(
        resource.kind,
        resource.metadata.name,
        namespace,
        ownership,
      );
      if (remaining !== undefined) return false;
    }
    return true;
  }

  async deleteSharedWorkspaceClaim(ownership: Ownership, namespace: string): Promise<void> {
    const agentId = required(ownership.agentId, "Shared workspace Agent ID");
    await this.deletePersistentVolumeClaim(
      KubernetesStorage.sharedWorkspaceClaim(agentId, ownership, namespace),
      ownership,
      namespace,
    );
  }

  async deleteGatewayPrivateStateClaim(ownership: Ownership, namespace: string): Promise<void> {
    const agentId = required(ownership.agentId, "Gateway private state Agent ID");
    await this.deletePersistentVolumeClaim(
      KubernetesStorage.gatewayPrivateStateClaim(
        this.options.gatewayStorageClassName,
        agentId,
        ownership,
        namespace,
      ),
      ownership,
      namespace,
    );
  }

  async deletePersistentVolumeClaim(
    desired: ManagedKubernetesObject<"PersistentVolumeClaim">,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    const name = desired.metadata.name;
    const existing = await this.dependencies.getOwned(
      "PersistentVolumeClaim",
      name,
      namespace,
      ownership,
    );
    if (existing === undefined || existing.metadata.deletionTimestamp !== undefined) return;
    verifyPersistentVolumeClaim(existing, desired);
    const uid = required(existing.metadata.uid, "PersistentVolumeClaim UID");
    const clients = await this.dependencies.clients();
    await this.dependencies.request(
      () =>
        clients.core.deleteNamespacedPersistentVolumeClaim({
          name,
          namespace,
          body: { preconditions: { uid } },
        }),
      { mutating: true },
    );
  }
}
