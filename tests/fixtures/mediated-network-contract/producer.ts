import {
  MEDIATED_NETWORK_PROFILE,
  decodeMediatedNetworkPacketV1,
  type MediatedNetworkPacketV1,
  type MediatedNetworkPeerV1,
} from "@openclaw-enterprise/occ";

/** Controlled deployment DATA producer, not an authenticated controller writer. */
export function produceNetworkData(): MediatedNetworkPacketV1 {
  const owned = (role: "agent" | "gateway"): MediatedNetworkPeerV1 => ({
    namespace: "tenant",
    podLabels: {
      "openclaw.dev/namespace-id": "ns-example",
      "openclaw.dev/agent": "agt-example",
      "openclaw.dev/revision": "rev-example",
      "openclaw.dev/network-profile": MEDIATED_NETWORK_PROFILE,
      "openclaw.dev/workload-role": role,
    },
  });
  const packet: MediatedNetworkPacketV1 = {
    kind: "credential-gateway-network-v1",
    profile: MEDIATED_NETWORK_PROFILE,
    binding: { namespaceId: "ns-example", agentId: "agt-example", revisionId: "rev-example" },
    agent: owned("agent"),
    agentGateway: owned("gateway"),
    credentialGateway: {
      namespace: "control-plane",
      podLabels: {
        "openclaw.dev/workload-role": "credential-gateway",
        "openclaw.dev/network-profile": MEDIATED_NETWORK_PROFILE,
      },
    },
    gatewayService: { clusterIP: "10.43.0.10", port: 443, targetPort: 8443 },
    scopedDns: {
      image: "registry.example/dns@sha256:" + "a".repeat(64),
      clusterIP: "10.43.0.11",
      servicePort: 53,
      targetPort: 1053,
      peer: { namespace: "tenant", podLabels: { app: "scoped-dns" } },
      platformHosts: [{ hostname: "model.example.com", address: "10.43.0.14" }],
    },
    gatewayResolvers: [
      {
        peer: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
        address: "10.43.0.12",
        port: 53,
      },
    ],
    database: { address: "10.43.0.13", port: 5432 },
    upstreamHttpsCidrs: ["1.1.1.1/32", "2606:4700:4700::1111/128"],
    platformFlows: [
      {
        caller: "agent",
        purpose: "model",
        peer: { namespace: "control-plane", podLabels: { app: "model" } },
        address: "10.43.0.14",
        port: 443,
      },
    ],
    harness: { protocol: "TCP", port: 18790 },
    publicCa: { configMapName: "gateway-ca", key: "ca.crt", sha256: "b".repeat(64) },
  };
  return decodeMediatedNetworkPacketV1(packet);
}

// These declarations protect the selected DATA ABI during independent compilation.
function invalidProducer(packet: MediatedNetworkPacketV1): void {
  // @ts-expect-error profile is the selected literal, never ordinary fallback
  const profile: MediatedNetworkPacketV1["profile"] = "broad-egress-v1";
  const gateway: MediatedNetworkPacketV1["gatewayService"] = {
    clusterIP: "10.0.0.1",
    // @ts-expect-error fixed gateway port cannot widen to arbitrary TCP
    port: 80,
    targetPort: 8443,
  };
  // @ts-expect-error decoder requires an explicit unknown input
  decodeMediatedNetworkPacketV1();
  // @ts-expect-error immutable snapshots cannot change binding in place
  packet.binding.revisionId = "replacement";
  void profile;
  void gateway;
}
void invalidProducer;
