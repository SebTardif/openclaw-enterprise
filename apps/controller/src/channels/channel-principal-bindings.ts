import type {
  ChannelAgentBinding,
  ChannelHumanBinding,
  ChannelInstallation,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  assertChannelIAM,
  AuthorizationDeniedError,
  ChannelBindingInvalidError,
  DependencyUnavailableError,
  lookupChannelHuman,
  requireChannelPermission,
  selectedChannelIAM,
  type ChannelBindingServiceOptions,
} from "@openclaw-enterprise/occ";
import { parseReceiptIdentityV1, type ReceiptIdentityV1 } from "./shared-turn-receipt.ts";

type UnmappedReason =
  | "unmapped"
  | "disabled"
  | "target-unavailable"
  | "identity-changed"
  | "permission-denied"
  | "dependency-unavailable"
  | "changed-during-resolution";
export type ChannelCandidateBindingResult =
  | Readonly<{ kind: UnmappedReason }>
  | Readonly<{
      kind: "candidate-mapped";
      authority: "mapping-only";
      identity: ReceiptIdentityV1;
      principalId: string;
      namespaceId: string;
      agentId: string;
      channelInstallationId: string;
      humanBindingId: string;
      agentBindingId: string;
      versions: Readonly<{ installation: number; human: number; agent: number }>;
      missingAuthority: readonly string[];
    }>;
interface BindingSnapshot {
  readonly installation: Readonly<ChannelInstallation>;
  readonly human: Readonly<ChannelHumanBinding>;
  readonly agent: Readonly<ChannelAgentBinding>;
}
const missingAuthority = Object.freeze([
  "verified-delivery",
  "common-workspace-repository-grants",
  "complete-live-audience",
  "conversation-checkpoint",
  "durable-admission",
  "runtime-authority",
  "agent-mutation-fence",
]);

/** A normalized schema is not authenticated delivery. This returns no admission capability. */
export async function resolveChannelCandidateBindingsV1(
  options: ChannelBindingServiceOptions,
  identity: ReceiptIdentityV1,
): Promise<ChannelCandidateBindingResult> {
  if (!identity || typeof identity !== "object") return { kind: "unmapped" };
  const { eventKey, logicalMessageKey, ...input } = identity;
  const parsed = parseReceiptIdentityV1(input);
  if (
    "kind" in parsed ||
    parsed.eventKey !== eventKey ||
    parsed.logicalMessageKey !== logicalMessageKey ||
    parsed.installationRef !== options.installationId
  )
    return { kind: "unmapped" };
  const receipt: ReceiptIdentityV1 = parsed;
  async function snapshot(): Promise<BindingSnapshot | { kind: UnmappedReason }> {
    return options.state.read(async (state) => {
      if ((await state.installations.getInstallation())?.id !== options.installationId)
        return { kind: "unmapped" };
      const installation = await state.channelBindings.findChannelInstallation(
        receipt.channelInstallationRef,
      );
      if (
        !installation ||
        installation.installationId !== receipt.installationRef ||
        installation.platform !== receipt.platform ||
        installation.providerTenantRef !== receipt.providerTenantRef ||
        installation.recipientAppRef !== receipt.recipientAppRef
      )
        return { kind: "unmapped" };
      const human = await state.channelBindings.findHumanBindingBySubject(
        installation.id,
        receipt.providerSubjectRef,
      );
      const agent = await state.channelBindings.findAgentBindingByChannel(
        installation.id,
        receipt.channelRef,
      );
      if (!human || !agent) return { kind: "unmapped" };
      if ([installation.status, human.status, agent.status].some((status) => status !== "enabled"))
        return { kind: "disabled" };
      const namespace = await state.namespaces.findNamespace(agent.namespaceId);
      const owner = await state.agents.findAgent(agent.namespaceId, agent.agentId);
      if (
        !namespace ||
        namespace.status !== "ready" ||
        !owner ||
        agent.scopeKind !==
          (installation.platform === "slack" ? "slack-private-channel" : "msteams-standard-channel")
      )
        return { kind: "target-unavailable" };
      return { installation, human, agent };
    });
  }
  try {
    const first = await snapshot();
    if ("kind" in first) return immutableCopy(first);
    const driver = selectedChannelIAM(options);
    const driverId = driver.id;
    if (first.human.iamDriverId !== driverId) return { kind: "identity-changed" };
    const human = await lookupChannelHuman(options, driver, {
      issuer: first.human.principalIssuer,
      subject: first.human.principalSubject,
    });
    if (human.id !== first.human.principalId) return { kind: "identity-changed" };
    const target = {
      kind: "agent" as const,
      id: first.agent.agentId,
      namespaceId: first.agent.namespaceId,
    };
    await requireChannelPermission(options, driver, human.id, "read", target);
    await requireChannelPermission(options, driver, human.id, "operate", target);
    // Observe drift after asynchronous IAM work. This is not a revocation lease;
    // later admission and dispatch must establish and check their own authority.
    const latest = await snapshot();
    assertChannelIAM(options, driver, driverId);
    if (
      "kind" in latest ||
      first.installation.id !== latest.installation.id ||
      first.installation.version !== latest.installation.version ||
      first.human.id !== latest.human.id ||
      first.human.version !== latest.human.version ||
      first.agent.id !== latest.agent.id ||
      first.agent.version !== latest.agent.version
    )
      return { kind: "changed-during-resolution" };
    return immutableCopy({
      kind: "candidate-mapped",
      authority: "mapping-only" as const,
      identity: parsed,
      principalId: human.id,
      namespaceId: first.agent.namespaceId,
      agentId: first.agent.agentId,
      channelInstallationId: first.installation.id,
      humanBindingId: first.human.id,
      agentBindingId: first.agent.id,
      versions: {
        installation: first.installation.version,
        human: first.human.version,
        agent: first.agent.version,
      },
      missingAuthority,
    });
  } catch (error) {
    if (error instanceof DependencyUnavailableError) return { kind: "dependency-unavailable" };
    if (error instanceof ChannelBindingInvalidError) return { kind: "identity-changed" };
    if (error instanceof AuthorizationDeniedError) return { kind: "permission-denied" };
    return { kind: "dependency-unavailable" };
  }
}
