import { isDeepStrictEqual } from "node:util";
import type { Agent, AgentOAuthAttempt } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { AgentOAuthRepository } from "../ports/agent-oauth.ts";
import { agentOAuthTransitions, validAgentOAuthAttempt } from "./agent-oauth-state.ts";

export function memoryAgentOAuth(
  attempts: Map<string, Readonly<AgentOAuthAttempt>>,
  findAgent: (namespaceId: string, agentId: string) => Readonly<Agent> | undefined,
): AgentOAuthRepository {
  const key = (namespaceId: string, agentId: string, generation: number) =>
    `${namespaceId}\0${agentId}\0${generation}`;
  const list = (namespaceId: string, agentId: string) =>
    Array.from(attempts.values())
      .filter((attempt) => attempt.namespaceId === namespaceId && attempt.agentId === agentId)
      .sort((a, b) => a.generation - b.generation);
  return {
    latest: async (namespaceId, agentId) => {
      const attempt = list(namespaceId, agentId).at(-1);
      return attempt === undefined ? undefined : immutableCopy(attempt);
    },
    find: async (namespaceId, agentId, generation) => {
      const attempt = attempts.get(key(namespaceId, agentId, generation));
      return attempt === undefined ? undefined : immutableCopy(attempt);
    },
    list: async (namespaceId, agentId) =>
      Object.freeze(list(namespaceId, agentId).map(immutableCopy)),
    create: async (input) => {
      if (
        !validAgentOAuthAttempt(input) ||
        input.phase !== "authorizing" ||
        input.stagedSecret !== null ||
        input.storageUid !== null ||
        input.failureCode !== null ||
        input.updatedAt !== input.createdAt ||
        findAgent(input.namespaceId, input.agentId)?.status !== "active"
      ) {
        throw new ScopeViolationError("The Agent OAuth attempt is invalid.");
      }
      const previous = list(input.namespaceId, input.agentId).at(-1);
      if (
        input.generation !== (previous?.generation ?? 0) + 1 ||
        (previous !== undefined && previous.connectionId !== input.connectionId) ||
        Array.from(attempts.values()).some(
          (attempt) =>
            attempt.attemptId === input.attemptId ||
            attempt.secretIdentity.id === input.secretIdentity.id ||
            (attempt.connectionId === input.connectionId &&
              (attempt.namespaceId !== input.namespaceId || attempt.agentId !== input.agentId)),
        )
      ) {
        throw new ResourceConflictError("The Agent OAuth generation or identity conflicts.");
      }
      const saved = immutableCopy(input);
      attempts.set(key(input.namespaceId, input.agentId, input.generation), saved);
      return immutableCopy(saved);
    },
    update: async (input) => {
      const id = key(input.namespaceId, input.agentId, input.generation);
      const current = attempts.get(id);
      if (current === undefined || current.phase !== input.expectedPhase) {
        return undefined;
      }
      const updated = {
        ...current,
        phase: input.phase,
        updatedAt: input.updatedAt,
        ...(input.stagedSecret === undefined ? {} : { stagedSecret: input.stagedSecret }),
        ...(input.storageUid === undefined ? {} : { storageUid: input.storageUid }),
        ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      };
      if (
        !validAgentOAuthAttempt(updated) ||
        (current.phase !== input.phase &&
          !agentOAuthTransitions[current.phase].includes(input.phase)) ||
        Date.parse(input.updatedAt) < Date.parse(current.updatedAt) ||
        (current.storageUid !== null && current.storageUid !== updated.storageUid) ||
        (current.stagedSecret === null &&
          updated.stagedSecret !== null &&
          !(current.phase === "staging" && input.phase === "authenticated")) ||
        (current.stagedSecret !== null &&
          updated.stagedSecret !== null &&
          !isDeepStrictEqual(current.stagedSecret, updated.stagedSecret))
      ) {
        throw new ScopeViolationError("The Agent OAuth transition is invalid.");
      }
      const saved = immutableCopy(updated);
      attempts.set(id, saved);
      return immutableCopy(saved);
    },
    delete: async (namespaceId, agentId) => {
      const owned = list(namespaceId, agentId);
      if (owned.length === 0) {
        return;
      }
      if (
        !["deleting", "deleted"].includes(findAgent(namespaceId, agentId)?.status ?? "") ||
        owned.some(
          (attempt) =>
            attempt.stagedSecret !== null || ["authorizing", "staging"].includes(attempt.phase),
        )
      ) {
        throw new ScopeViolationError("Agent OAuth custody must be cleaned before final deletion.");
      }
      for (const attempt of owned) {
        attempts.delete(key(namespaceId, agentId, attempt.generation));
      }
    },
  };
}
