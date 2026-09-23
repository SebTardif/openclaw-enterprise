import type { OpenClawController, AgentOAuthStatus } from "@openclaw-enterprise/occ";
import type {
  createNativeOAuthAcquisition,
  NativeOAuthInstructions,
} from "./native-acquisition.mjs";

/**
 * Internal composition entry point. Catalog/API owners supply a qualified adapter
 * and deliver its challenge only to the authenticated initiating actor.
 * The caller owns one freshly begun attempt and invokes acquisition once; this
 * entry point does not resume or attach another process to an existing attempt.
 */
export async function acquireAgentOAuth(options: {
  readonly controller: OpenClawController;
  readonly actorId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly selected: AgentOAuthStatus;
  readonly acquire: ReturnType<typeof createNativeOAuthAcquisition>;
  readonly signal: AbortSignal;
  readonly onInstructions: (instructions: NativeOAuthInstructions) => Promise<void>;
  readonly requestRedirect?: () => Promise<string>;
  readonly assertSession?: () => Promise<void>;
}): Promise<AgentOAuthStatus> {
  const { controller, actorId, namespaceId, agentId } = options;
  const handle = await controller.agentOAuth.acquisition(
    actorId,
    namespaceId,
    agentId,
    options.selected,
    options.signal,
    options.assertSession,
  );
  const selected = handle.status;
  let result: AgentOAuthStatus | undefined;
  try {
    await options.acquire({
      binding: {
        provider: selected.providerId,
        method: selected.methodId,
        connectionId: selected.connectionId,
        generation: selected.generation,
      },
      signal: handle.signal,
      assertCurrent: handle.assertCurrent,
      onInstructions: options.onInstructions,
      ...(options.requestRedirect ? { requestRedirect: options.requestRedirect } : {}),
      stage: async (envelope) => {
        if (envelope.profileId !== selected.profileId) {
          throw new Error("OAuth profile mismatch.");
        }
        result = await handle.stage(JSON.stringify(envelope));
      },
    });
    if (!result) {
      throw new Error("OAuth custody was not confirmed.");
    }
    return result;
  } catch {
    await handle.fail().catch(() => undefined);
    throw new Error("OAuth did not complete. Check the connection status before retrying.");
  }
}
