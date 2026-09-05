import { sha256Hex } from "@openclaw-enterprise/utils";
import type {
  AgentRevision,
  LoggingLevel,
  SecretEnvironmentProjection,
} from "@openclaw-enterprise/contracts";
import type { V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
  GATEWAY_RUNTIME_ENTRYPOINT,
  GATEWAY_READINESS_ENTRYPOINT,
} from "../../runtime/runtime-entrypoints.ts";
import {
  manifest,
  ownershipMetadata,
  required,
  ConfigurationFailure,
  TOKEN_PATH,
  AGENT_REVISION_ANNOTATION,
  AGENT_REVISION_ID_ANNOTATION,
  AGENT_TRANSPORT_PORT,
  GVISOR_RUNTIME_CLASS,
  type Ownership,
  type DesiredKubernetesObject,
} from "./identity.ts";
import {
  CONFIGURATION_DIRECTORY,
  CONFIGURATION_DOCUMENT,
  CONFIGURATION_VOLUME,
  type GatewayConfigurationSnapshot,
} from "./gateway.ts";
import {
  privateStateInitContainer,
  sharedWorkspaceClaimName,
  sharedWorkspaceVolumeMounts,
  gatewayPrivateStateClaimName,
  gatewayPrivateStateVolumeMounts,
  RUNTIME_STATE_VOLUME_SIZE,
  SHARED_WORKSPACE_VOLUME,
  GATEWAY_PRIVATE_STATE_VOLUME,
} from "./storage.ts";
import type { ChannelRequirements } from "./channel-policy.ts";
import {
  AGENT_TRANSPORT_TOKEN_KEY,
  GATEWAY_TOKEN_KEY,
  MODEL_API_KEY,
  SERVICE_ACCOUNT_WORKSPACE_KEY,
  CODEX_ACCESS_TOKEN,
  CODEX_CHATGPT_WORKSPACE_ID,
} from "./secret-projection.ts";

export interface WorkloadResources {
  readonly requests?: Readonly<Record<string, string>>;
  readonly limits?: Readonly<Record<string, string>>;
}
export interface WorkloadOptions {
  readonly isolationProfile?: "gvisor-systrap";
  readonly resources: { readonly gateway: WorkloadResources; readonly agent: WorkloadResources };
  readonly network: { readonly gatewayPort: number };
  readonly servicePrincipalCredentials:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "projectedServiceAccountToken";
        readonly audience: string;
        readonly expirationSeconds: number;
      };
  readonly runtime?: {
    readonly transportSecretPrefix: string;
    readonly modelSecretPrefix: string;
    readonly channels?: { readonly secretPrefix: string; readonly proxyUrl: string };
  };
}

export function deployment(
  options: WorkloadOptions,
  name: string,
  ownership: Ownership,
  namespace: string,
  image: string,
  serviceAccountName: string,
  role: "gateway" | "agent",
  environment: Readonly<Record<string, string>>,
  loggingLevel: LoggingLevel,
  configuration?: GatewayConfigurationSnapshot,
  embedded = false,
  workloadServicePrincipalId?: string,
  serviceAccount?: AgentRevision["serviceAccount"],
  enabledChannels: readonly ChannelRequirements[] = [],
  secretEnvironment: readonly SecretEnvironmentProjection[] = [],
): DesiredKubernetesObject<"Deployment"> {
  const metadata = ownershipMetadata(ownership);
  const workloadMetadata =
    workloadServicePrincipalId === undefined
      ? metadata
      : ownershipMetadata({ ...ownership, servicePrincipalId: workloadServicePrincipalId });
  const configurationAnnotations =
    role === "gateway" && configuration !== undefined
      ? {
          ...configuration.annotations,
          [AGENT_REVISION_ANNOTATION]: String(configuration.revision),
          [AGENT_REVISION_ID_ANNOTATION]: configuration.revisionId,
        }
      : {};
  const revisionLabels =
    role === "gateway" && configuration !== undefined
      ? { "openclaw.dev/revision": configuration.revisionId }
      : {};
  const deployment = manifest("apps/v1", "Deployment", name, ownership, namespace);
  const selector = { "app.kubernetes.io/name": name };
  const projected =
    (role === "agent" || embedded) &&
    options.servicePrincipalCredentials.mode === "projectedServiceAccountToken"
      ? options.servicePrincipalCredentials
      : undefined;
  const runtime = options.runtime;
  const dedicated = !embedded;
  const privateHome = runtime !== undefined || dedicated;
  const volumes: V1Volume[] = [];
  const volumeMounts: V1VolumeMount[] = [];
  const variables: V1EnvVar[] = [];
  const initContainers = privateHome
    ? [privateStateInitContainer(options.runtime !== undefined, role, image, embedded)]
    : [];
  if (configuration !== undefined) {
    volumes.push({
      name: CONFIGURATION_VOLUME,
      configMap: {
        name: configuration.name,
        items: [{ key: CONFIGURATION_DOCUMENT, path: CONFIGURATION_DOCUMENT }],
        optional: false,
      },
    });
    volumeMounts.push({
      name: CONFIGURATION_VOLUME,
      mountPath: CONFIGURATION_DIRECTORY,
      readOnly: true,
    });
    variables.push({
      name: "OPENCLAW_CONFIG_PATH",
      value: `${CONFIGURATION_DIRECTORY}/${CONFIGURATION_DOCUMENT}`,
    });
  }
  if (projected !== undefined) {
    volumes.push({
      name: "openclaw-service-principal",
      projected: {
        sources: [
          {
            serviceAccountToken: {
              audience: projected.audience,
              expirationSeconds: projected.expirationSeconds,
              path: "token",
            },
          },
        ],
      },
    });
    volumeMounts.push({
      name: "openclaw-service-principal",
      mountPath: TOKEN_PATH,
      readOnly: true,
    });
  }
  if (role === "agent" || embedded) {
    variables.push(...Object.entries(environment).map(([name, value]) => ({ name, value })));
  }
  if (role === "agent") {
    variables.push(
      { name: "LOG_FORMAT", value: "json" },
      { name: "RUST_LOG", value: `${loggingLevel},codex_otel=off` },
    );
  }
  if (secretEnvironment.length > 0) {
    if (role !== "gateway") {
      throw new ConfigurationFailure("Secret bindings can only be delivered to Agent gateways.");
    }
    variables.push(
      ...secretEnvironment.map(({ name, backendRef }) => ({
        name,
        valueFrom: {
          secretKeyRef: { name: backendRef.name, key: backendRef.key, optional: false },
        },
      })),
    );
  }
  if (privateHome) {
    volumes.push(
      { name: "runtime-state", emptyDir: { sizeLimit: RUNTIME_STATE_VOLUME_SIZE } },
      { name: "runtime-temporary", emptyDir: { sizeLimit: "64Mi" } },
    );
    volumeMounts.push(
      { name: "runtime-state", mountPath: "/home/node" },
      { name: "runtime-temporary", mountPath: "/tmp" },
    );
  }
  if (dedicated) {
    const agentId = required(ownership.agentId, "Shared workspace Agent ID");
    volumes.push({
      name: SHARED_WORKSPACE_VOLUME,
      persistentVolumeClaim: { claimName: sharedWorkspaceClaimName(agentId) },
    });
    volumeMounts.push(...sharedWorkspaceVolumeMounts(role));
    if (role === "gateway") {
      variables.push({ name: "OPENCLAW_WORKSPACE_DIR", value: "/home/node/workspace" });
    }
  }
  if (role === "gateway" && runtime !== undefined) {
    const agentId = required(ownership.agentId, "Gateway private state Agent ID");
    volumes.push({
      name: GATEWAY_PRIVATE_STATE_VOLUME,
      persistentVolumeClaim: { claimName: gatewayPrivateStateClaimName(agentId) },
    });
    volumeMounts.push(...gatewayPrivateStateVolumeMounts(embedded), {
      name: "runtime-state",
      mountPath: "/home/node/.openclaw/agents/main/agent/codex-home",
      subPath: "gateway-codex-home",
    });
  }
  if (runtime !== undefined) {
    const agentId = required(ownership.agentId, "Runtime Agent ID");
    const suffix = sha256Hex(agentId, 12);
    const secret = (variable: string, prefix: string, key: string): V1EnvVar => ({
      name: variable,
      valueFrom: { secretKeyRef: { name: `${prefix}-${suffix}`, key } },
    });
    if (!embedded) {
      variables.push(
        secret("APP_SERVER_TOKEN", runtime.transportSecretPrefix, AGENT_TRANSPORT_TOKEN_KEY),
      );
    }
    if (role === "gateway") {
      if (embedded) {
        // TODO(model-credential-broker): Replace direct per-Agent API keys with brokered credentials.
        if (!secretEnvironment.some(({ name }) => name === MODEL_API_KEY)) {
          variables.push(secret(MODEL_API_KEY, runtime.modelSecretPrefix, MODEL_API_KEY));
        }
        variables.push({
          name: "HOME",
          value: "/home/node",
        });
      } else {
        // TODO(workload-transport-mtls): Replace per-Agent capability-token ws:// with mTLS.
        variables.push({
          name: "APP_SERVER_URL",
          value: `ws://agent-${suffix}:${AGENT_TRANSPORT_PORT}`,
        });
      }
      // Native trusted-proxy authentication rejects a simultaneously configured shared token.
      if (configuration?.usesTrustedProxyAuth !== true) {
        variables.push(
          secret("OPENCLAW_GATEWAY_TOKEN", runtime.transportSecretPrefix, GATEWAY_TOKEN_KEY),
        );
      }
      variables.push(
        { name: "OPENCLAW_STATE_DIR", value: "/home/node/.openclaw" },
        { name: "OPENCLAW_GATEWAY_PORT", value: String(options.network.gatewayPort) },
      );
      if (enabledChannels.length > 0) {
        const channels = runtime.channels;
        if (channels === undefined) {
          throw new ConfigurationFailure("Gateway channel credentials are not configured.");
        }
        variables.push(
          ...Array.from(
            new Set(enabledChannels.flatMap(({ secrets }): readonly string[] => secrets)),
            (key) => secret(key, channels.secretPrefix, key),
          ),
          { name: "HTTPS_PROXY", value: channels.proxyUrl },
        );
      }
    } else {
      if (serviceAccount?.credential.kind === "access_token") {
        const reference = serviceAccount.credential.secretRef;
        variables.push(
          {
            name: CODEX_ACCESS_TOKEN,
            valueFrom: { secretKeyRef: { name: reference.name, key: reference.key } },
          },
          {
            name: CODEX_CHATGPT_WORKSPACE_ID,
            valueFrom: {
              secretKeyRef: { name: reference.name, key: SERVICE_ACCOUNT_WORKSPACE_KEY },
            },
          },
        );
      } else {
        // TODO(model-credential-broker): Replace direct per-Agent API keys with brokered credentials.
        variables.push(secret(MODEL_API_KEY, runtime.modelSecretPrefix, MODEL_API_KEY));
      }
      variables.push(
        { name: "CODEX_HOME", value: "/home/node/.codex" },
        { name: "HOME", value: "/home/node" },
        {
          name: "PATH",
          value:
            "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
        { name: "APP_SERVER_PORT", value: String(AGENT_TRANSPORT_PORT) },
      );
    }
  }
  const names = new Set<string>();
  for (const variable of variables) {
    if (names.has(variable.name)) {
      throw new ConfigurationFailure(
        `Workload environment variable ${variable.name} is duplicated.`,
      );
    }
    names.add(variable.name);
  }
  const port =
    role === "agent" && runtime !== undefined ? AGENT_TRANSPORT_PORT : options.network.gatewayPort;
  return {
    ...deployment,
    metadata: {
      ...deployment.metadata,
      annotations: {
        ...metadata.annotations,
        ...configurationAnnotations,
      },
    },
    spec: {
      replicas: 1,
      ...(role === "gateway" ? { strategy: { type: "Recreate" } } : {}),
      selector: { matchLabels: selector },
      template: {
        metadata: {
          ...workloadMetadata,
          annotations: { ...workloadMetadata.annotations, ...configurationAnnotations },
          labels: {
            ...workloadMetadata.labels,
            ...revisionLabels,
            ...selector,
            "openclaw.dev/workload-role": role,
          },
        },
        spec: {
          ...(role === "agent" && options.isolationProfile !== undefined
            ? { runtimeClassName: GVISOR_RUNTIME_CLASS }
            : {}),
          serviceAccountName,
          automountServiceAccountToken: false,
          ...(volumes.length === 0 ? {} : { volumes }),
          ...(initContainers.length === 0 ? {} : { initContainers }),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            ...(privateHome ? { fsGroup: 1000 } : {}),
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: role,
              image,
              imagePullPolicy: "IfNotPresent",
              ...(variables.length === 0 ? {} : { env: variables }),
              ports: [
                { containerPort: port, name: role === "agent" && runtime ? "websocket" : "http" },
              ],
              readinessProbe: {
                ...(runtime !== undefined
                  ? {
                      exec: {
                        command: [
                          "node",
                          "-e",
                          role === "gateway"
                            ? GATEWAY_READINESS_ENTRYPOINT
                            : AGENT_READINESS_ENTRYPOINT,
                        ],
                      },
                    }
                  : { httpGet: { path: "/readyz", port } }),
                periodSeconds: 2,
              },
              resources: role === "gateway" ? options.resources.gateway : options.resources.agent,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              ...(volumeMounts.length === 0 ? {} : { volumeMounts }),
              ...(runtime === undefined
                ? {}
                : {
                    command: ["node", "-e"],
                    args: [
                      role === "gateway" ? GATEWAY_RUNTIME_ENTRYPOINT : AGENT_RUNTIME_ENTRYPOINT,
                    ],
                  }),
            },
          ],
        },
      },
    },
  };
}
