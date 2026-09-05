import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type {
  KubernetesObject,
  V1ConfigMap,
  V1ObjectMeta,
  V1ServiceAccount,
  V1DeploymentSpec,
  V1NetworkPolicySpec,
  V1NetworkPolicyIngressRule,
  V1NetworkPolicyPeer,
  V1PersistentVolumeClaimSpec,
  V1ServiceSpec,
  V1ResourceQuotaSpec,
  V1LimitRangeSpec,
} from "@kubernetes/client-node";

// Desired metadata is a rendering input; only the Driver verifies observed ownership and UIDs.
export type KubernetesRecord = Record<string, unknown>;
export type DesiredResourceKind =
  | "Namespace"
  | "ConfigMap"
  | "ServiceAccount"
  | "Service"
  | "ResourceQuota"
  | "LimitRange"
  | "PersistentVolumeClaim"
  | "Deployment"
  | "NetworkPolicy"
  | "HTTPRoute";
export type ManifestKind = DesiredResourceKind | "Pod" | "Secret";
// ObjectApi receives Kubernetes wire values; the generated typed SDK calls this field _from.
export type DesiredNetworkPolicySpec = Omit<V1NetworkPolicySpec, "ingress"> & {
  ingress?: (Omit<V1NetworkPolicyIngressRule, "_from"> & { from?: V1NetworkPolicyPeer[] })[];
} & KubernetesRecord;
export interface GatewayRouteSpec {
  readonly hostnames: string[];
  readonly parentRefs: {
    group: string;
    kind: string;
    namespace: string;
    name: string;
    sectionName: string;
  }[];
  readonly rules: {
    matches: { path: { type: "Exact"; value: string } }[];
    filters: (
      | {
          type: "URLRewrite";
          urlRewrite: { path: { type: "ReplaceFullPath"; replaceFullPath: string } };
        }
      | {
          type: "RequestHeaderModifier";
          requestHeaderModifier: { set: { name: string; value: string }[]; remove: string[] };
        }
    )[];
    backendRefs: { group: string; kind: "Service"; name: string; port: number }[];
  }[];
}
interface DesiredResourceSpecs {
  Deployment: V1DeploymentSpec;
  NetworkPolicy: DesiredNetworkPolicySpec;
  PersistentVolumeClaim: V1PersistentVolumeClaimSpec;
  Service: V1ServiceSpec;
  ResourceQuota: V1ResourceQuotaSpec;
  LimitRange: V1LimitRangeSpec;
  HTTPRoute: GatewayRouteSpec;
}
export interface DesiredKubernetesObject<Kind extends ManifestKind = DesiredResourceKind>
  extends
    KubernetesObject,
    Pick<V1ConfigMap, "binaryData" | "data" | "immutable">,
    Pick<V1ServiceAccount, "automountServiceAccountToken"> {
  readonly apiVersion: string;
  readonly kind: Kind;
  readonly metadata: V1ObjectMeta & { readonly name: string };
  readonly spec?: Kind extends keyof DesiredResourceSpecs
    ? DesiredResourceSpecs[Kind] & KubernetesRecord
    : KubernetesRecord;
}

export interface Ownership {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly serviceAccountId?: string;
  readonly servicePrincipalId?: string;
  readonly revisionId?: string;
}

export class ConfigurationFailure extends Error {}

export const MANAGER = "openclaw-enterprise";

export const TOKEN_PATH = "/var/run/secrets/openclaw/service-principal";

export const AGENT_REVISION_ANNOTATION = "openclaw.dev/agent-revision";

export const AGENT_REVISION_ID_ANNOTATION = "openclaw.dev/agent-revision-id";

export const AGENT_TRANSPORT_PORT = 18_790;

export const GVISOR_RUNTIME_CLASS = "oce-gvisor-systrap";

export function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} must be explicitly configured.`);
  }
  return value;
}

export function ownershipMetadata(ownership: Ownership): {
  labels: Record<string, string>;
  annotations: Record<string, string>;
} {
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": MANAGER,
    "openclaw.dev/namespace": ownership.namespaceId,
  };
  const annotations: Record<string, string> = {
    "openclaw.dev/namespace-id": ownership.namespaceId,
  };
  if (ownership.agentId !== undefined) {
    labels["openclaw.dev/agent"] = ownership.agentId;
    annotations["openclaw.dev/agent-id"] = ownership.agentId;
  }
  if (ownership.serviceAccountId !== undefined) {
    labels["openclaw.dev/service-account"] = ownership.serviceAccountId;
    annotations["openclaw.dev/service-account-id"] = ownership.serviceAccountId;
  }
  if (ownership.servicePrincipalId !== undefined) {
    labels["openclaw.dev/service-principal"] = ownership.servicePrincipalId;
    annotations["openclaw.dev/service-principal-id"] = ownership.servicePrincipalId;
  }
  if (ownership.revisionId !== undefined) {
    labels["openclaw.dev/revision"] = ownership.revisionId;
    annotations["openclaw.dev/revision-id"] = ownership.revisionId;
  }
  return { labels, annotations };
}

export function manifest<Kind extends ManifestKind>(
  apiVersion: string,
  kind: Kind,
  name: string,
  ownership: Ownership,
  namespace?: string,
): DesiredKubernetesObject<Kind> {
  return {
    apiVersion,
    kind,
    metadata: {
      name,
      ...(namespace === undefined ? {} : { namespace }),
      ...ownershipMetadata(ownership),
    },
  };
}
