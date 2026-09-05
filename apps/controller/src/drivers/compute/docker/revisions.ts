import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { DockerContainerInspect } from "./client.ts";
import { ConfigurationFailure } from "./container-plan.ts";
import { OwnershipFailure, REVISION_LABEL } from "./ownership.ts";

export const REVISION_NUMBER_LABEL = "org.openclaw.enterprise.revision-number";
export const CONFIGURATION_HASH_LABEL = "org.openclaw.enterprise.configuration-hash";
export const HARNESS_VERSION_LABEL = "org.openclaw.enterprise.harness-version";

export function healthy(inspect: DockerContainerInspect): boolean {
  return inspect.State?.Running === true && inspect.State.Health?.Status === "healthy";
}

export function validTopology(revision: AgentRevision): boolean {
  return (
    (revision.harness.id === "openclaw" && revision.harness.mode === "embedded") ||
    (revision.harness.id === "codex" && revision.harness.mode === "dedicated")
  );
}

// The lifecycle owner verifies observed ownership before making this bounded decision.
export function gatewayRevisionDisposition(
  existing: DockerContainerInspect,
  revision: Readonly<AgentRevision>,
  configurationHash: string,
  containerName: string,
): "stale" | "ready" | "replace" {
  const currentRevision = Number(existing.Config?.Labels?.[REVISION_NUMBER_LABEL]);
  const currentRevisionId = existing.Config?.Labels?.[REVISION_LABEL];
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1 || !currentRevisionId) {
    throw new OwnershipFailure(`Refusing invalid Agent gateway ${containerName}.`);
  }
  if (currentRevision > revision.revision) return "stale";
  if (currentRevision === revision.revision && currentRevisionId === revision.id) {
    if (existing.Config?.Labels?.[CONFIGURATION_HASH_LABEL] !== configurationHash) {
      throw new ConfigurationFailure(
        "Immutable AgentRevision gateway configuration cannot change.",
      );
    }
    if (healthy(existing)) return "ready";
  }
  return "replace";
}
