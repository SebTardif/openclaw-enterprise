import { sha256Hex } from "@openclaw-enterprise/utils";
import type { V1VolumeMount, V1Container } from "@kubernetes/client-node";
import {
  manifest,
  required,
  type Ownership,
  type KubernetesRecord,
  type DesiredKubernetesObject,
} from "./identity.ts";

export const RUNTIME_STATE_VOLUME_SIZE = "1Gi";

export const GATEWAY_PRIVATE_STATE_VOLUME = "openclaw-gateway-state";

export const GATEWAY_PRIVATE_STATE_SIZE = "10Gi";

export const GATEWAY_PRIVATE_STATE_CATEGORIES = Object.freeze([
  ["state", "/home/node/.openclaw/state"],
  ["agent", "/home/node/.openclaw/agents/main/agent"],
  ["media", "/home/node/.openclaw/media"],
] as const);

export const SHARED_WORKSPACE_VOLUME = "openclaw-workspace";

export const SHARED_WORKSPACE_SIZE = "40Gi";

export type SharedWorkspaceRole = "agent" | "gateway";

export const SHARED_WORKSPACE_CATEGORIES = Object.freeze([
  ["workspace", "/home/node/workspace", false, "/home/node/workspace", false],
  [
    "sessions",
    "/home/node/.openclaw/agents/main/sessions",
    false,
    "/home/node/.openclaw/agents/main/sessions",
    true,
  ],
  [
    "generated-images",
    "/home/node/.openclaw/codex-artifacts/generated_images",
    true,
    "/home/node/.codex/generated_images",
    false,
  ],
  [
    "bundled-skills",
    "/home/node/openclaw-runtime-assets/bundled-skills",
    false,
    "/home/node/openclaw-runtime-assets/bundled-skills",
    true,
  ],
  [
    "plugin-skills",
    "/home/node/openclaw-runtime-assets/plugin-skills",
    false,
    "/home/node/openclaw-runtime-assets/plugin-skills",
    true,
  ],
] as const);

export function sharedWorkspaceClaimName(agentId: string): string {
  return `workspace-${sha256Hex(agentId, 12)}`;
}

export function gatewayPrivateStateClaimName(agentId: string): string {
  return `gateway-state-${sha256Hex(agentId, 12)}`;
}

export function sharedWorkspaceVolumeMounts(role: SharedWorkspaceRole): V1VolumeMount[] {
  const isGateway = role === "gateway";
  return SHARED_WORKSPACE_CATEGORIES.map(
    ([subPath, gatewayMountPath, gatewayReadOnly, agentMountPath, agentReadOnly]) => ({
      name: SHARED_WORKSPACE_VOLUME,
      mountPath: isGateway ? gatewayMountPath : agentMountPath,
      subPath,
      readOnly: isGateway ? gatewayReadOnly : agentReadOnly,
    }),
  );
}

export function gatewayPrivateStateVolumeMounts(embedded: boolean): V1VolumeMount[] {
  const mounts: V1VolumeMount[] = GATEWAY_PRIVATE_STATE_CATEGORIES.map(([subPath, mountPath]) => ({
    name: GATEWAY_PRIVATE_STATE_VOLUME,
    mountPath,
    subPath,
    readOnly: false,
  }));
  if (embedded) {
    // Retain the workspace attested by gateway SQLite so continued turns do not fail as vanished.
    mounts.push({
      name: GATEWAY_PRIVATE_STATE_VOLUME,
      mountPath: "/home/node/.openclaw/workspace",
      subPath: "workspace",
      readOnly: false,
    });
  }
  return mounts;
}

export function privateStateDirectories(role: SharedWorkspaceRole): string[] {
  const isGateway = role === "gateway";
  const directories = new Set(isGateway ? ["/home/node/.openclaw"] : []);
  for (const [, gatewayMountPath, , agentMountPath] of SHARED_WORKSPACE_CATEGORIES) {
    const path = isGateway ? gatewayMountPath : agentMountPath;
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent !== "/home/node") directories.add(parent);
  }
  return [...directories];
}

export function sharedWorkspaceClaim(
  agentId: string,
  ownership: Ownership,
  namespace: string,
): DesiredKubernetesObject<"PersistentVolumeClaim"> {
  return {
    ...manifest(
      "v1",
      "PersistentVolumeClaim",
      sharedWorkspaceClaimName(agentId),
      ownership,
      namespace,
    ),
    spec: {
      accessModes: ["ReadWriteMany"],
      resources: { requests: { storage: SHARED_WORKSPACE_SIZE } },
    },
  };
}

export function gatewayPrivateStateClaim(
  storageClassName: string | undefined,
  agentId: string,
  ownership: Ownership,
  namespace: string,
): DesiredKubernetesObject<"PersistentVolumeClaim"> {
  return {
    ...manifest(
      "v1",
      "PersistentVolumeClaim",
      gatewayPrivateStateClaimName(agentId),
      ownership,
      namespace,
    ),
    spec: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      storageClassName: required(storageClassName, "SQLite-compatible gateway storage class"),
      resources: { requests: { storage: GATEWAY_PRIVATE_STATE_SIZE } },
    },
  };
}

export function privateStateInitContainer(
  runtimeEnabled: boolean,
  role: SharedWorkspaceRole,
  image: string,
  embedded: boolean,
): V1Container & KubernetesRecord {
  const directories = privateStateDirectories(role);
  const volumeMounts: V1VolumeMount[] = [{ name: "runtime-state", mountPath: "/home/node" }];
  if (role === "gateway" && runtimeEnabled) {
    // Initialize whole directories as uid 1000 before mounting SQLite and its WAL files.
    volumeMounts.push({ name: GATEWAY_PRIVATE_STATE_VOLUME, mountPath: "/gateway-state" });
    directories.push(
      ...GATEWAY_PRIVATE_STATE_CATEGORIES.map(([subPath]) => `/gateway-state/${subPath}`),
      "/home/node/gateway-codex-home",
    );
    if (embedded) directories.push("/gateway-state/workspace");
  }
  const script = [
    'const { mkdirSync } = require("node:fs");',
    `for (const path of ${JSON.stringify(directories)}) {`,
    "  mkdirSync(path, { recursive: true });",
    "}",
  ].join("\n");
  return {
    name: "prepare-private-state",
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["node", "-e"],
    args: [script],
    volumeMounts,
    securityContext: {
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    },
  };
}
