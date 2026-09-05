import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { sha256Hex } from "@openclaw-enterprise/utils";
import type { DockerContainerInspect, DockerRequest } from "./client.ts";

export interface Ownership {
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
}

export class OwnershipFailure extends Error {}

export const MANAGED_VALUE = "true";
export const MANAGED_LABEL = "org.openclaw.enterprise.managed";
export const COMPUTE_DRIVER_LABEL = "org.openclaw.enterprise.compute-driver";
export const NAMESPACE_LABEL = "org.openclaw.enterprise.namespace-id";
export const AGENT_LABEL = "org.openclaw.enterprise.agent-id";
export const REVISION_LABEL = "org.openclaw.enterprise.revision-id";

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "namespace"
  );
}

export function ownershipMetadata(ownership: Ownership): Record<string, string> {
  const labels: Record<string, string> = {
    [MANAGED_LABEL]: MANAGED_VALUE,
    [COMPUTE_DRIVER_LABEL]: "docker",
    [NAMESPACE_LABEL]: ownership.namespaceId,
  };
  if (ownership.agentId !== undefined) {
    labels[AGENT_LABEL] = ownership.agentId;
  }
  if (ownership.revisionId !== undefined) {
    labels[REVISION_LABEL] = ownership.revisionId;
  }
  return labels;
}

export function gatewayOwnership(revision: Readonly<AgentRevision>): Ownership {
  return { namespaceId: revision.namespaceId, agentId: revision.agentId };
}

export function agentOwnership(revision: Readonly<AgentRevision>): Ownership {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
  };
}

export function verifyOwnership(
  labels: Readonly<Record<string, string>> | undefined,
  ownership: Ownership,
  description: string,
): void {
  const expected = ownershipMetadata(ownership);
  for (const [key, value] of Object.entries(expected)) {
    if (labels?.[key] !== value) {
      throw new OwnershipFailure(`Refusing unowned Docker ${description}.`);
    }
  }
}

export function networkName(namespaceId: string): string {
  return `oce-${slug(namespaceId)}-${sha256Hex(namespaceId, 12)}`;
}

export function gatewayContainerName(namespaceId: string, agentId: string): string {
  return `oce-${sha256Hex(namespaceId, 12)}-gateway-${sha256Hex(agentId, 12)}`;
}

export function agentContainerName(
  namespaceId: string,
  agentId: string,
  revisionId: string,
): string {
  return `oce-${sha256Hex(namespaceId, 12)}-agent-${sha256Hex(agentId, 12)}-rev-${sha256Hex(revisionId, 12)}`;
}

export async function containerIdsForNamespace(
  request: DockerRequest,
  inspectContainer: (name: string) => Promise<DockerContainerInspect | undefined>,
  namespaceId: string,
): Promise<readonly string[]> {
  const filters = encodeURIComponent(
    JSON.stringify({
      label: [
        `${MANAGED_LABEL}=${MANAGED_VALUE}`,
        `${COMPUTE_DRIVER_LABEL}=docker`,
        `${NAMESPACE_LABEL}=${namespaceId}`,
      ],
    }),
  );
  const listed = (await request(
    "GET",
    `/containers/json?all=true&filters=${filters}`,
    undefined,
    [200],
  )) as readonly { readonly Id?: string }[];
  const containerIds: string[] = [];
  for (const container of listed) {
    if (container.Id === undefined) continue;
    const current = await inspectContainer(container.Id);
    if (current === undefined) continue;
    verifyOwnership(current.Config?.Labels, { namespaceId }, `container ${container.Id}`);
    containerIds.push(container.Id);
  }
  return containerIds;
}
