import {
  normalizeSecretBindings,
  type AgentRevision,
  type SecretEnvironmentProjection,
} from "@openclaw-enterprise/contracts";
import { ConfigurationFailure } from "./identity.ts";
export type SecretProjectionRevision = Pick<
  AgentRevision,
  "secretBindings" | "secretDriverId" | "harness" | "namespaceId" | "agentId"
>;
export interface SecretProjectionContext {
  readonly secretEnvironment?: readonly SecretEnvironmentProjection[];
}

export const AGENT_TRANSPORT_TOKEN_KEY = "app-server-token";

export const GATEWAY_TOKEN_KEY = "gateway-token";

export const GATEWAY_PASSWORD_KEY = "gateway-password";

export const OPENCLAW_GATEWAY_PASSWORD = "OPENCLAW_GATEWAY_PASSWORD";

export const MODEL_API_KEY = "OPENAI_API_KEY";

export const SERVICE_ACCOUNT_TOKEN_KEY = "token";

export const SERVICE_ACCOUNT_WORKSPACE_KEY = "workspace-id";

export const CODEX_ACCESS_TOKEN = "CODEX_ACCESS_TOKEN";

export const CODEX_CHATGPT_WORKSPACE_ID = "CODEX_CHATGPT_WORKSPACE_ID";

export function secretEnvironmentForRevision(
  revision: SecretProjectionRevision,
  context: SecretProjectionContext | undefined,
  namespace: string,
): readonly SecretEnvironmentProjection[] {
  let bindings: ReturnType<typeof normalizeSecretBindings>;
  try {
    bindings = normalizeSecretBindings(revision.secretBindings);
  } catch {
    throw new ConfigurationFailure("AgentRevision Secret bindings are invalid.");
  }
  const destinations = new Set(Object.keys(bindings));
  const projected = context?.secretEnvironment ?? [];
  if (destinations.size === 0) {
    if (projected.length > 0) {
      throw new ConfigurationFailure(
        "Secret delivery context has no matching AgentRevision binding.",
      );
    }
    return [];
  }
  if (typeof revision.secretDriverId !== "string" || revision.secretDriverId.trim().length === 0) {
    throw new ConfigurationFailure("AgentRevision Secret Driver selection is missing.");
  }
  if (revision.harness.mode !== "embedded" && destinations.has(MODEL_API_KEY)) {
    throw new ConfigurationFailure(
      "Dedicated Codex runtimes cannot bind gateway model credentials.",
    );
  }
  if (projected.length !== destinations.size) {
    throw new ConfigurationFailure(
      "Secret delivery context does not match AgentRevision bindings.",
    );
  }
  const seen = new Set<string>();
  for (const projection of projected) {
    const binding = bindings[projection.name];
    if (
      binding === undefined ||
      seen.has(projection.name) ||
      projection.secretId !== binding.source.id ||
      projection.namespaceId !== binding.source.namespaceId ||
      projection.namespaceId !== revision.namespaceId ||
      projection.agentId !== revision.agentId ||
      projection.backendRef.namespaceName !== namespace ||
      projection.backendRef.name.trim().length === 0 ||
      projection.backendRef.key.trim().length === 0 ||
      projection.backendRef.uid.trim().length === 0
    ) {
      throw new ConfigurationFailure(
        "Secret delivery context does not match AgentRevision bindings.",
      );
    }
    seen.add(projection.name);
  }
  return Object.freeze([...projected]);
}
