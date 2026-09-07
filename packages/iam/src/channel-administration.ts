import {
  accountSemanticRequirementsV1,
  decodeChannelAdministrationMappingV1,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type ChannelAdministrationEvidenceV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { NativeIAMState } from "./state.ts";

/** Corrupt semantic registration is an unavailable producer, not an ordinary denied grant. */
export class ChannelAdministrationStateError extends TypeError {}

/** Validate registration against its actual containing IAM grant, including withdrawals. */
export function validateChannelAdministrationMappings(state: NativeIAMState): void {
  for (const binding of state.bindings) {
    if (binding.channelAdministration === undefined) continue;
    const parsed = decodeChannelAdministrationMappingV1(binding.channelAdministration);
    const role = state.roles.find((candidate) => candidate.id === binding.roleId);
    if (
      parsed.kind !== "valid" ||
      parsed.value.roleId !== binding.roleId ||
      binding.namespaceId !== undefined ||
      role === undefined ||
      role.namespaceId !== undefined ||
      (binding.resourceKind !== undefined &&
        (binding.resourceKind !== "installation" ||
          binding.resourceId !== parsed.value.installationId))
    )
      throw new ChannelAdministrationStateError(
        "Invalid native IAM channel administration mapping.",
      );
  }
}

/**
 * Called only with the same validated snapshot used for the native IAM decision.
 * This extends diagnostic grant evidence; it creates no authenticated invocation.
 */
export function withChannelAdministrationEvidence(
  state: NativeIAMState,
  request: AuthorizationRequest,
  decision: AuthorizationDecision,
): AuthorizationDecision {
  if (request.action !== "administer" || request.resource.kind !== "installation") return decision;
  const operation = { kind: "installation.administer" as const, target: {} };
  if (
    request.resource.namespaceId !== undefined ||
    !accountSemanticRequirementsV1(operation).includes("installation-administrator")
  )
    throw new TypeError("Invalid exact channel administration operation.");

  const identity = state.identities.find((candidate) => candidate.id === request.principalId);
  const mappings: ChannelAdministrationEvidenceV1["mappings"][number][] = [];
  if (decision.allowed && identity?.kind === "principal") {
    for (const binding of state.bindings) {
      if (
        binding.channelAdministration === undefined ||
        !decision.evidence.bindingIds.includes(binding.id) ||
        !decision.evidence.roleIds.includes(binding.roleId)
      )
        continue;
      const parsed = decodeChannelAdministrationMappingV1(binding.channelAdministration);
      if (parsed.kind !== "valid")
        throw new ChannelAdministrationStateError(
          "Invalid native IAM channel administration mapping.",
        );
      const mapping = parsed.value;
      if (
        mapping.status !== "enabled" ||
        mapping.installationId !== request.resource.id ||
        mapping.roleId !== binding.roleId
      )
        continue;
      mappings.push({ bindingId: binding.id, roleId: binding.roleId, version: mapping.version });
      if (mappings.length > 64)
        throw new TypeError("Native IAM channel administration evidence exceeds its bound.");
    }
  }
  return immutableCopy({
    ...decision,
    evidence: {
      ...decision.evidence,
      channelAdministration: {
        schemaVersion: 1,
        installationId: request.resource.id,
        mappings,
      },
    },
  });
}
