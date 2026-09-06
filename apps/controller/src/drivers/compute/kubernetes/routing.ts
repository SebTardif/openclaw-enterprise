import type { KubernetesObjectApi, V1DeleteOptions } from "@kubernetes/client-node";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  OwnershipFailure,
  type KubernetesResourceReader,
  type ManagedKubernetesObject,
} from "./ownership.ts";
import * as KubernetesGateway from "./resources/gateway.ts";
import { GATEWAY_API_VERSION, type KubernetesGatewayRoutingOptions } from "./resources/gateway.ts";
import {
  AGENT_REVISION_ID_ANNOTATION,
  ConfigurationFailure,
  type Ownership,
} from "./resources/identity.ts";

export interface KubernetesRoutingOptions {
  readonly gatewayRouting: KubernetesGatewayRoutingOptions | undefined;
  readonly gatewayPort: number;
}

export interface KubernetesRoutingDependencies {
  clients(): Promise<{ readonly objects: Pick<KubernetesObjectApi, "delete"> }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  getOwned: KubernetesResourceReader["getOwned"];
  reconcile(
    desired: ManagedKubernetesObject,
    ownership: Ownership,
    namespace?: string,
  ): Promise<void>;
}

export class KubernetesRouting {
  private readonly dependencies: KubernetesRoutingDependencies;
  private readonly options: KubernetesRoutingOptions;

  constructor(dependencies: KubernetesRoutingDependencies, options: KubernetesRoutingOptions) {
    this.dependencies = dependencies;
    this.options = options;
  }

  verifyGatewayRoutingConfiguration(revision: AgentRevision): void {
    if (this.options.gatewayRouting === undefined) return;
    const gateway = asRecord(revision.configuration.gateway);
    const auth = asRecord(gateway?.auth);
    const trustedProxy = asRecord(auth?.trustedProxy);
    const trustedProxies = gateway?.trustedProxies;
    if (auth?.mode !== "trusted-proxy") {
      throw new ConfigurationFailure(
        "Gateway routing requires native trusted-proxy authentication.",
      );
    }
    if ("token" in (auth ?? {})) {
      throw new ConfigurationFailure("Gateway routing native configuration must omit auth.token.");
    }
    if (trustedProxy?.userHeader !== "x-occ-identity") {
      throw new ConfigurationFailure(
        "Gateway routing requires native trustedProxy.userHeader x-occ-identity.",
      );
    }
    if (
      !Array.isArray(trustedProxy.allowUsers) ||
      !trustedProxy.allowUsers.includes("occ-workspace-files")
    ) {
      throw new ConfigurationFailure(
        "Gateway routing requires native trustedProxy.allowUsers to include occ-workspace-files.",
      );
    }
    const identityScopes = asRecord(auth?.identityScopes);
    const workspaceFileScopes = identityScopes?.["occ-workspace-files"];
    if (!Array.isArray(workspaceFileScopes) || !workspaceFileScopes.includes("operator.admin")) {
      throw new ConfigurationFailure(
        "Gateway routing requires native identityScopes to grant operator.admin.",
      );
    }
    if (gateway?.allowRealIpFallback !== true) {
      throw new ConfigurationFailure(
        "Gateway routing requires native allowRealIpFallback to be enabled.",
      );
    }
    if (
      !Array.isArray(trustedProxies) ||
      !trustedProxies.some((proxy) => typeof proxy === "string" && proxy.trim().length > 0)
    ) {
      throw new ConfigurationFailure(
        "Gateway routing requires explicitly configured native trustedProxies.",
      );
    }
  }

  gatewayRouteName(agentId: string): string {
    return KubernetesGateway.gatewayRouteName(agentId);
  }

  gatewayRoutePath(revision: AgentRevision): string {
    return KubernetesGateway.gatewayRoutePath(revision);
  }

  gatewayRoutingHostname(routing: KubernetesGatewayRoutingOptions): string {
    return KubernetesGateway.gatewayRoutingHostname(routing);
  }

  gatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
    service: ManagedKubernetesObject<"Service">,
  ): ManagedKubernetesObject<"HTTPRoute"> | undefined {
    return KubernetesGateway.gatewayRoute(
      {
        ...(this.options.gatewayRouting === undefined
          ? {}
          : { gatewayRouting: this.options.gatewayRouting }),
        gatewayPort: this.options.gatewayPort,
      },
      revision,
      ownership,
      namespace,
      service,
    );
  }

  async reconcileGatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    if (this.options.gatewayRouting === undefined) return;
    const name = this.gatewayRouteName(revision.agentId);
    const service = await this.dependencies.getOwned("Service", name, namespace, ownership);
    if (service === undefined) return;
    const route = this.gatewayRoute(revision, ownership, namespace, service);
    if (route !== undefined) await this.dependencies.reconcile(route, ownership, namespace);
  }

  async deleteGatewayRoute(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<void> {
    const existing = await this.gatewayRouteForRevision(name, ownership, namespace, revisionId);
    if (existing === undefined) return;
    if (existing.metadata.uid === undefined) {
      throw new OwnershipFailure(
        `HTTPRoute ${name} UID must be explicitly observed before delete.`,
      );
    }
    const clients = await this.dependencies.clients();
    await this.dependencies.request(
      () =>
        clients.objects.delete(
          {
            apiVersion: GATEWAY_API_VERSION,
            kind: "HTTPRoute",
            metadata: { name, namespace },
          },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { preconditions: { uid: existing.metadata.uid } } as V1DeleteOptions,
        ),
      { mutating: true },
    );
  }

  async gatewayRouteForRevision(
    name: string,
    ownership: Ownership,
    namespace: string,
    revisionId: string,
  ): Promise<ManagedKubernetesObject<"HTTPRoute"> | undefined> {
    if (this.options.gatewayRouting === undefined) return undefined;
    const existing = await this.dependencies.getOwned("HTTPRoute", name, namespace, ownership);
    if (existing === undefined) return undefined;
    return existing.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revisionId
      ? existing
      : undefined;
  }
}
