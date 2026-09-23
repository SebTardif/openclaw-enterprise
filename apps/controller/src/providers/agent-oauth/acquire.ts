import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  type OpenClawController,
  type AgentOAuthStatus,
} from "@openclaw-enterprise/occ";
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
  } catch (error) {
    let denied =
      error instanceof AuthorizationDeniedError && !(error instanceof DependencyUnavailableError)
        ? error
        : undefined;
    if (!denied) {
      try {
        handle.signal.throwIfAborted();
        await options.assertSession?.();
        await handle.assertCurrent();
        // A failed acknowledgement can follow a committed private write. Recover
        // only this live attempt; never repeat provider acquisition to find out.
        const recovered = await controller.agentOAuth.recover(
          actorId,
          namespaceId,
          agentId,
          selected.attemptId,
          selected.generation,
          handle.signal,
          options.assertSession,
        );
        await options.assertSession?.();
        await handle.assertCurrent();
        if (recovered.phase === "authenticated") {
          return recovered;
        }
      } catch (recoveryError) {
        // Preserve exact IAM evidence for the caller's audit after transactions
        // unwind. Provider/backend errors remain sanitized below.
        if (
          recoveryError instanceof AuthorizationDeniedError &&
          !(recoveryError instanceof DependencyUnavailableError)
        ) {
          denied = recoveryError;
        }
      }
    }
    await handle.fail().catch(() => undefined);
    if (denied) {
      throw denied;
    }
  }
  throw new Error("OAuth did not complete. Check the connection status before retrying.");
}
