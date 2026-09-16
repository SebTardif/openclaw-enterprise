import {
  MEDIATED_NETWORK_PROFILE,
  type MediatedNetworkPacketV1,
  type MediatedNetworkPeerV1,
  type RootDeploymentAdmissionV1,
} from "@openclaw-enterprise/occ";
/** Compile-only Compute-policy consumer of the public deployment DATA. Runtime
 * policy installation and authenticated owning-revision checks remain with Compute. */
export function describeSelectedData(packet: MediatedNetworkPacketV1): Readonly<{
  selectedProfile: typeof MEDIATED_NETWORK_PROFILE;
  agentPeer: MediatedNetworkPeerV1;
  transportPort: 18790;
  resolverPorts: readonly number[];
}> {
  return {
    selectedProfile: packet.profile,
    agentPeer: packet.agent,
    transportPort: packet.harness.port,
    resolverPorts: packet.gatewayResolvers.map((resolver) => resolver.port),
  };
}
function invalidConsumer(packet: MediatedNetworkPacketV1): void {
  // @ts-expect-error Agent gateway is a flow caller, credential gateway is not
  const caller: MediatedNetworkPacketV1["platformFlows"][number]["caller"] = "credential-gateway";
  // @ts-expect-error a platform flow must declare one of the selected purposes
  const purpose: MediatedNetworkPacketV1["platformFlows"][number]["purpose"] = "database";
  // @ts-expect-error Harness port preserves 18790
  const harness: MediatedNetworkPacketV1["harness"] = { protocol: "TCP", port: 18791 };
  // @ts-expect-error deeply readonly selector must not be mutated
  packet.agent.podLabels["openclaw.dev/network-profile"] = "broad-egress-v1";
  // @ts-expect-error ordered endpoint arrays cannot be expanded in place
  packet.gatewayResolvers.push(packet.gatewayResolvers[0]);
  // @ts-expect-error serialized deployment DATA cannot manufacture Work admission authority
  const admission: RootDeploymentAdmissionV1 = packet;
  void admission;
  void caller;
  void purpose;
  void harness;
}
void invalidConsumer;
