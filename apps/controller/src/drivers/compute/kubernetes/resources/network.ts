import type { V1NetworkPolicyPeer } from "@kubernetes/client-node";
import {
  manifest,
  AGENT_TRANSPORT_PORT,
  type Ownership,
  type DesiredNetworkPolicySpec,
  type DesiredKubernetesObject,
} from "./identity.ts";
import type { KubernetesGatewayRoutingOptions } from "./gateway.ts";
export interface NetworkPolicyOptions {
  readonly network: {
    readonly dns: KubernetesWorkloadPeer;
    readonly gatewayPort: number;
    readonly gatewayClients?: readonly KubernetesWorkloadPeer[];
  };
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
}
export interface ServiceOptions {
  readonly gatewayPort: number;
  readonly runtimeEnabled: boolean;
}

export interface KubernetesWorkloadPeer {
  readonly namespace: string;
  readonly podLabels: Readonly<Record<string, string>>;
}

export function peer(peer: KubernetesWorkloadPeer): V1NetworkPolicyPeer {
  return {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": peer.namespace } },
    podSelector: { matchLabels: { ...peer.podLabels } },
  };
}

export function networkPolicies(
  options: NetworkPolicyOptions,
  ownership: Ownership,
  namespace: string,
): DesiredKubernetesObject<"NetworkPolicy">[] {
  const network = options.network;
  const routing = options.gatewayRouting;
  const gatewayIngressPeers =
    routing === undefined
      ? (network.gatewayClients ?? [])
      : [
          {
            namespace: routing.envoyNamespace,
            podLabels: {
              "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
              "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
            },
          },
        ];
  const policy = (
    name: string,
    spec: DesiredNetworkPolicySpec,
  ): DesiredKubernetesObject<"NetworkPolicy"> => ({
    ...manifest("networking.k8s.io/v1", "NetworkPolicy", name, ownership, namespace),
    spec,
  });
  return [
    policy("default-deny", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
    policy("allow-dns", {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [peer(network.dns)],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
      ],
    }),
    policy("allow-gateway-ingress", {
      podSelector: { matchLabels: { "openclaw.dev/workload-role": "gateway" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: gatewayIngressPeers.map((candidate) => peer(candidate)),
          ports: [{ protocol: "TCP", port: network.gatewayPort }],
        },
      ],
    }),
  ];
}

export function service(
  options: ServiceOptions,
  name: string,
  ownership: Ownership,
  namespace: string,
  selector: Readonly<Record<string, string>>,
): DesiredKubernetesObject<"Service"> {
  return {
    ...manifest("v1", "Service", name, ownership, namespace),
    spec: {
      type: "ClusterIP",
      selector,
      ports: [
        {
          name:
            ownership.servicePrincipalId !== undefined && options.runtimeEnabled
              ? "websocket"
              : "http",
          port:
            ownership.servicePrincipalId !== undefined && options.runtimeEnabled
              ? AGENT_TRANSPORT_PORT
              : options.gatewayPort,
          targetPort:
            ownership.servicePrincipalId !== undefined && options.runtimeEnabled
              ? AGENT_TRANSPORT_PORT
              : options.gatewayPort,
        },
      ],
    },
  };
}
