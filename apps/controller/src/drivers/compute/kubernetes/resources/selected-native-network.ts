import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import { decodeSelectedNativeDefinitionV1 } from "@openclaw-enterprise/occ/workload-profiles/selected-native-definition";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
} from "@openclaw-enterprise/occ/workload-profiles/canonical";
import { manifest, type DesiredKubernetesObject, type Ownership } from "./identity.ts";

export interface SelectedNativeNetworkTargetV1 {
  readonly namespace: string;
  readonly ownership: Required<Pick<Ownership, "namespaceId" | "agentId" | "revisionId">>;
}

/** An incomplete desired contribution, never an installable complete selection.
 * Native routing and identity protocols need their original supplier schemas.
 * Existing additive policies cannot be revoked by another default-deny policy.
 */
export function selectedNativeNetworkContributionV1(
  canonicalManifest: Uint8Array,
  canonicalDefinition: Uint8Array,
  supplied: SelectedNativeNetworkTargetV1,
): {
  readonly kind: "incomplete";
  readonly missing: readonly [
    "native-github-route",
    "identity-bootstrap",
    "harness-transport",
    "aggregate-policy-closure",
  ];
  readonly policies: readonly DesiredKubernetesObject<"NetworkPolicy">[];
} {
  const definition = decodeSelectedNativeDefinitionV1(canonicalDefinition, canonicalManifest).value;
  const target = decodeWorkloadProfileJson(canonicalizeWorkloadProfileJson(supplied))
    .value as unknown as SelectedNativeNetworkTargetV1;
  if (
    !target ||
    Object.keys(target).length !== 2 ||
    typeof target.namespace !== "string" ||
    target.namespace.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(target.namespace) ||
    !target.ownership ||
    Object.keys(target.ownership).length !== 3 ||
    ["namespaceId", "agentId", "revisionId"].some((key) => !Object.hasOwn(target.ownership, key)) ||
    Object.values(target.ownership).some(
      (value) =>
        typeof value !== "string" ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value),
    )
  )
    throw new Error("The selected native network target is invalid.");
  const ownership = target.ownership;
  const selector = {
    matchLabels: {
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": ownership.agentId,
      "openclaw.dev/revision": ownership.revisionId,
    },
  };
  const suffix = sha256Hex(`${ownership.agentId}:${ownership.revisionId}`, 12);
  const policies: DesiredKubernetesObject<"NetworkPolicy">[] = [
    {
      ...manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `native-deny-${suffix}`,
        ownership,
        target.namespace,
      ),
      spec: { podSelector: selector, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
    },
    {
      ...manifest(
        "networking.k8s.io/v1",
        "NetworkPolicy",
        `native-endpoints-${suffix}`,
        ownership,
        target.namespace,
      ),
      spec: {
        podSelector: selector,
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${definition.containment.resolver.address}/32` } }],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          ...[definition.modelMediator, definition.repositoryIssuer].map(({ destination }) => ({
            to: [{ ipBlock: { cidr: `${destination.address}/32` } }],
            ports: [{ protocol: "TCP", port: destination.port }],
          })),
        ],
      },
    },
  ];
  // TODO(selected network composition): receive the accepted native authority
  // route and identity/transport definitions, then inspect the actual aggregate
  // and outer fence before installing any complete selected workload policy.
  return immutableCopy({
    kind: "incomplete",
    missing: [
      "native-github-route",
      "identity-bootstrap",
      "harness-transport",
      "aggregate-policy-closure",
    ],
    policies,
  });
}
