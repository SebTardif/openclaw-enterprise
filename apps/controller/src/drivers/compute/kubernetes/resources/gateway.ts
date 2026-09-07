import { asRecord, immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import type { V1Deployment, V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import type { GatewayProcessTargetV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { normalizeResourceQuantity } from "./resource-normalization.ts";
import {
  snapshotKubernetesWorkloadResourcePlan,
  type KubernetesWorkloadResourcePlan,
} from "./revision-resource-plan.ts";
import {
  admittedLoggingLevel,
  type AgentRevision,
  type LoggingLevel,
} from "@openclaw-enterprise/contracts";
import {
  manifest,
  required,
  AGENT_REVISION_ANNOTATION,
  AGENT_REVISION_ID_ANNOTATION,
  type Ownership,
  type DesiredKubernetesObject,
} from "./identity.ts";
export type GatewayRevision = Pick<
  AgentRevision,
  | "id"
  | "agentId"
  | "namespaceId"
  | "revision"
  | "configuration"
  | "configurationId"
  | "configurationKind"
  | "configurationGeneration"
>;
export interface GatewayRouteOptions {
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
  readonly gatewayPort: number;
}

export interface KubernetesGatewayRoutingOptions {
  readonly hostname?: string;
  readonly gatewayName: string;
  readonly gatewayNamespace: string;
  readonly envoyNamespace: string;
}

export interface GatewayConfigurationSnapshot {
  readonly name: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly usesTrustedProxyAuth: boolean;
  readonly annotations: Readonly<Record<string, string>>;
  readonly loggingLevel: LoggingLevel;
}

export const CONFIGURATION_DIRECTORY = "/etc/openclaw";

export const CONFIGURATION_DOCUMENT = "openclaw.json";

export const CONFIGURATION_VOLUME = "openclaw-configuration";

export const GATEWAY_API_VERSION = "gateway.networking.k8s.io/v1";

export const GATEWAY_LISTENER_SECTION = "https";

export const GATEWAY_MEMBERSHIP_LABEL = "openclaw-enterprise.io/gateway";

export function gatewayConfiguration(revision: GatewayRevision): GatewayConfigurationSnapshot {
  return {
    name: `gateway-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`,
    revision: revision.revision,
    revisionId: revision.id,
    usesTrustedProxyAuth:
      asRecord(asRecord(revision.configuration.gateway)?.auth)?.mode === "trusted-proxy",
    annotations: {
      "openclaw.dev/configuration-id": revision.configurationId,
      "openclaw.dev/configuration-kind": revision.configurationKind,
      "openclaw.dev/configuration-generation": String(revision.configurationGeneration),
    },
    loggingLevel: admittedLoggingLevel(revision.configuration),
  };
}

export function gatewayMembershipLabels(
  routing: KubernetesGatewayRoutingOptions | undefined,
): Record<string, string> {
  if (routing === undefined) return {};
  return {
    [GATEWAY_MEMBERSHIP_LABEL]: sha256Hex(`${routing.gatewayNamespace}/${routing.gatewayName}`, 12),
  };
}

export function gatewayRouteName(agentId: string): string {
  return `gateway-${sha256Hex(agentId, 12)}`;
}

export function gatewayRoutePath(revision: Pick<AgentRevision, "namespaceId" | "agentId">): string {
  return `/namespaces/${required(revision.namespaceId, "AgentRevision Namespace ID")}/agents/${required(
    revision.agentId,
    "Agent ID",
  )}`;
}

export function gatewayRoutingHostname(routing: KubernetesGatewayRoutingOptions): string {
  if (routing.hostname !== undefined && routing.hostname.length > 0) return routing.hostname;
  return `occ-gateway-${sha256Hex(
    `${routing.gatewayNamespace}/${routing.gatewayName}`,
    12,
  )}.${routing.envoyNamespace}.svc`;
}

export function gatewayRoute(
  options: GatewayRouteOptions,
  revision: Pick<AgentRevision, "id" | "agentId" | "namespaceId" | "revision">,
  ownership: Ownership,
  namespace: string,
  service: { readonly metadata: { readonly name: string; readonly uid?: string } },
): DesiredKubernetesObject<"HTTPRoute"> | undefined {
  const routing = options.gatewayRouting;
  if (routing === undefined) return undefined;
  const name = gatewayRouteName(revision.agentId);
  const route = manifest(GATEWAY_API_VERSION, "HTTPRoute", name, ownership, namespace);
  return {
    ...route,
    metadata: {
      ...route.metadata,
      annotations: {
        ...route.metadata.annotations,
        [AGENT_REVISION_ANNOTATION]: String(revision.revision),
        [AGENT_REVISION_ID_ANNOTATION]: revision.id,
      },
      ...(service.metadata.uid === undefined
        ? {}
        : {
            ownerReferences: [
              {
                apiVersion: "v1",
                kind: "Service",
                name: service.metadata.name,
                uid: service.metadata.uid,
                controller: false,
                blockOwnerDeletion: false,
              },
            ],
          }),
    },
    spec: {
      hostnames: [gatewayRoutingHostname(routing)],
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          namespace: routing.gatewayNamespace,
          name: routing.gatewayName,
          sectionName: GATEWAY_LISTENER_SECTION,
        },
      ],
      rules: [
        {
          matches: [{ path: { type: "Exact", value: gatewayRoutePath(revision) } }],
          filters: [
            {
              type: "URLRewrite",
              urlRewrite: { path: { type: "ReplaceFullPath", replaceFullPath: "/" } },
            },
            {
              type: "RequestHeaderModifier",
              requestHeaderModifier: {
                set: [
                  { name: "x-occ-identity", value: "occ-workspace-files" },
                  {
                    name: "x-real-ip",
                    value: "%DOWNSTREAM_DIRECT_REMOTE_ADDRESS_WITHOUT_PORT%",
                  },
                ],
                remove: ["x-forwarded-for", "forwarded", "x-openclaw-scopes"],
              },
            },
          ],
          backendRefs: [
            {
              group: "",
              kind: "Service",
              name: service.metadata.name,
              port: options.gatewayPort,
            },
          ],
        },
      ],
    },
  };
}

export function gatewayConfigurationMap(
  configuration: GatewayConfigurationSnapshot,
  document: string,
  ownership: Ownership,
  namespace: string,
): DesiredKubernetesObject<"ConfigMap"> {
  const snapshot = manifest("v1", "ConfigMap", configuration.name, ownership, namespace);
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      annotations: { ...snapshot.metadata.annotations, ...configuration.annotations },
    },
    immutable: true,
    data: { [CONFIGURATION_DOCUMENT]: document },
  };
}

/** Pure rendering from the original qualified immutable renderer definition.
 * Admission, current authority and physical placement are checked by its caller. */
export function admittedGatewayDeployment(input: {
  readonly target: GatewayProcessTargetV1;
  readonly template: V1Deployment;
  readonly applicationName: string;
  readonly privateStateInitName: string;
  readonly image: string;
  readonly argv: readonly string[];
  readonly runtimeClassName: string;
  readonly environment: readonly V1EnvVar[];
  readonly volumes: readonly V1Volume[];
  readonly mounts: readonly V1VolumeMount[];
  readonly resources: KubernetesWorkloadResourcePlan;
  readonly storage: Readonly<
    Record<
      "runtimeHome" | "temporary",
      {
        readonly accountingId: string;
        readonly volumeName: string;
      }
    >
  >;
}): V1Deployment {
  const template = immutableCopy(input.template);
  const pod = template.spec?.template.spec;
  const application = pod?.containers[0];
  const init = pod?.initContainers?.[0];
  const resources = snapshotKubernetesWorkloadResourcePlan(input.resources);
  if (
    resources.component !== "gateway" ||
    !pod ||
    !application ||
    !init ||
    template.kind !== "Deployment" ||
    template.apiVersion !== "apps/v1" ||
    template.metadata?.name !== input.target.deploymentName ||
    template.metadata.namespace !== input.target.namespace.name ||
    template.metadata.uid !== undefined ||
    template.metadata.resourceVersion !== undefined ||
    template.metadata.generateName !== undefined ||
    template.metadata.deletionTimestamp !== undefined ||
    template.spec?.replicas !== 1 ||
    pod.containers.length !== 1 ||
    pod.initContainers?.length !== 1 ||
    application.name !== input.applicationName ||
    init.name !== input.privateStateInitName ||
    application.name === init.name ||
    typeof init.image !== "string" ||
    !/@sha256:[0-9a-f]{64}$/.test(init.image) ||
    init.restartPolicy !== undefined ||
    pod.automountServiceAccountToken !== false ||
    pod.hostNetwork === true ||
    pod.hostPID === true ||
    pod.hostIPC === true ||
    (pod.ephemeralContainers?.length ?? 0) !== 0 ||
    application.securityContext?.privileged === true ||
    init.securityContext?.privileged === true ||
    input.argv.length === 0 ||
    !input.argv[0]?.startsWith("/") ||
    input.argv.some((value) => typeof value !== "string" || value.includes("\0")) ||
    !input.runtimeClassName ||
    input.runtimeClassName.trim() !== input.runtimeClassName ||
    !input.image.includes("@sha256:")
  )
    throw new Error("The admitted Gateway renderer does not support this plan.");
  const volumeNames = new Set(input.volumes.map(({ name }) => name));
  const workload = resources.values.envelope.gateway;
  if (
    volumeNames.size !== input.volumes.length ||
    workload.status !== "supplied" ||
    workload.value.storage.status !== "supplied" ||
    input.storage.runtimeHome.volumeName === input.storage.temporary.volumeName ||
    [...input.mounts, ...(init.volumeMounts ?? [])].some(
      (mount) => !volumeNames.has(mount.name) || mount.subPathExpr !== undefined,
    )
  )
    throw new Error("The admitted Gateway volume correspondence is unavailable.");
  for (const [key, kind, capacity] of [
    ["runtimeHome", "runtime-home", resources.runtimeHomeBytes],
    ["temporary", "temporary", resources.temporaryBytes],
  ] as const) {
    const selected = input.storage[key];
    const store = workload.value.storage.value.find(
      (entry) => entry.accountingId === selected.accountingId,
    );
    const volume = input.volumes.find(({ name }) => name === selected.volumeName);
    if (
      !store ||
      store.kind !== kind ||
      store.medium !== "disk-ephemeral" ||
      store.capacityBytes !== capacity ||
      !volume?.emptyDir ||
      Object.keys(volume).some((name) => name !== "name" && name !== "emptyDir") ||
      (volume.emptyDir.medium !== undefined && volume.emptyDir.medium !== "") ||
      normalizeResourceQuantity("ephemeral-storage", volume.emptyDir.sizeLimit) !== capacity
    )
      throw new Error("The admitted Gateway storage capacity does not match.");
  }
  return immutableCopy({
    ...template,
    spec: {
      ...template.spec,
      template: {
        ...template.spec.template,
        spec: {
          ...pod,
          runtimeClassName: input.runtimeClassName,
          volumes: [...input.volumes],
          initContainers: [{ ...init, resources: resources.privateStateInit }],
          containers: [
            {
              ...application,
              image: input.image,
              command: [input.argv[0]],
              args: input.argv.slice(1),
              env: [...input.environment],
              volumeMounts: [...input.mounts],
              resources: resources.application,
            },
          ],
        },
      },
    },
  });
}
