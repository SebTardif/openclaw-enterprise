import type { Agent, SecretDriver } from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork } from "./state/platform-state.ts";
import { DependencyUnavailableError, ResourceConflictError } from "./errors.ts";
import { validAgentOAuthAttempt } from "./state/agent-oauth-state.ts";

/** Final teardown holds the Agent lock until every retained staging identity is resolved. */
export async function cleanupAgentOAuthForDeletion(options: {
  readonly state: PlatformUnitOfWork;
  readonly agent: Readonly<Agent>;
  readonly secretDriver: SecretDriver | undefined;
  readonly assertAuthority: () => Promise<void>;
}): Promise<void> {
  const { state, agent, secretDriver, assertAuthority } = options;
  const current = await state.agents.lockAgent(agent.namespaceId, agent.id);
  if (
    current?.servicePrincipalId !== agent.servicePrincipalId ||
    current.status !== "deleting" ||
    current.desiredRuntimeState !== "stopped"
  ) {
    throw new ResourceConflictError("The Agent deletion is no longer current.");
  }
  const attempts = await state.agentOAuth.list(agent.namespaceId, agent.id);
  if (attempts.length === 0) {
    return;
  }
  for (let attempt of attempts) {
    await assertAuthority();
    if (!secretDriver?.findStaged || secretDriver.id !== attempt.secretDriverId) {
      throw new DependencyUnavailableError("The OAuth custody Secret Driver is unavailable.");
    }
    if (!["cancelled", "superseded"].includes(attempt.phase)) {
      const cancelled = await state.agentOAuth.update({
        namespaceId: agent.namespaceId,
        agentId: agent.id,
        generation: attempt.generation,
        expectedPhase: attempt.phase,
        phase: "cancelled",
        updatedAt: new Date().toISOString(),
      });
      if (!cancelled) {
        throw new ResourceConflictError("The OAuth attempt changed during deletion.");
      }
      attempt = cancelled;
    }
    // A stage may commit before its acknowledgment. The preallocated identity is
    // retained even when no backend reference was ever committed to PostgreSQL.
    const backendRef =
      attempt.stagedSecret?.backendRef ??
      (await storage(() => secretDriver.findStaged!(attempt.secretIdentity)));
    await assertAuthority();
    if (backendRef) {
      const secret = attempt.stagedSecret ?? {
        ...attempt.secretIdentity,
        driverId: secretDriver.id,
        backendRef,
        createdAt: attempt.createdAt,
      };
      if (!validAgentOAuthAttempt({ ...attempt, stagedSecret: secret })) {
        throw new DependencyUnavailableError("The OAuth custody identity is invalid.");
      }
      await storage(() => secretDriver.delete(secret));
      await assertAuthority();
    }
    await state.agentOAuth.update({
      namespaceId: agent.namespaceId,
      agentId: agent.id,
      generation: attempt.generation,
      expectedPhase: attempt.phase,
      phase: attempt.phase,
      stagedSecret: null,
      updatedAt: new Date().toISOString(),
    });
  }
  await assertAuthority();
  await state.agentOAuth.delete(agent.namespaceId, agent.id);
}

async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new DependencyUnavailableError(
      "OAuth credential cleanup is unavailable. Retry deletion.",
    );
  }
}
