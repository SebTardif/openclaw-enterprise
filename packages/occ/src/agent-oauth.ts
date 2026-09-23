import { randomUUID } from "node:crypto";
import { asRecord } from "@openclaw-enterprise/utils";
import type {
  Agent,
  AgentOAuthAttempt,
  AgentOAuthPhase,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import type { PlatformUnitOfWork } from "./state/platform-state.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";

export type AgentOAuthStatus = Readonly<
  Pick<
    AgentOAuthAttempt,
    | "connectionId"
    | "providerConnectionId"
    | "generation"
    | "attemptId"
    | "providerId"
    | "methodId"
    | "profileId"
    | "phase"
    | "deadlineAt"
    | "failureCode"
  >
>;

/** Selected by the server's qualified adapter, never by an HTTP payload. */
export interface AgentOAuthMethod {
  readonly providerId: string;
  readonly methodId: string;
  profileId(connectionId: string, generation: number): string;
}

interface CustodyOwner {
  transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T>;
  authorize(actorId: string, namespaceId: string, agentId: string): Promise<void>;
  lockAgent(
    state: PlatformUnitOfWork,
    namespaceId: string,
    agentId: string,
  ): Promise<Readonly<Agent>>;
  /** Resolve and authorize the draft selection while its Namespace and Agent are locked. */
  resolveSelection(
    state: PlatformUnitOfWork,
    actorId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<{ providerConnectionId: string; providerId: string; methodId: string }>;
  secretDriver(expectedId?: string): SecretDriver;
  now(): Date;
}

function status(attempt: AgentOAuthAttempt): AgentOAuthStatus {
  const {
    connectionId,
    providerConnectionId,
    generation,
    attemptId,
    providerId,
    methodId,
    profileId,
    phase,
    deadlineAt,
    failureCode,
  } = attempt;
  return Object.freeze({
    connectionId,
    providerConnectionId,
    generation,
    attemptId,
    providerId,
    methodId,
    profileId,
    phase,
    deadlineAt,
    failureCode,
  });
}

function stale(): never {
  throw new ResourceConflictError(
    "The OAuth attempt is no longer current. Start a new connection attempt.",
  );
}

/** Agent-owned custody. Native adapters own acquisition and credential validation. */
export class AgentOAuthCustody {
  private readonly owner: CustodyOwner;

  constructor(owner: CustodyOwner) {
    this.owner = owner;
  }

  async begin(
    actorId: string,
    namespaceId: string,
    agentId: string,
    method: AgentOAuthMethod,
    expectedGeneration: number,
    expectedProviderConnectionId: string,
  ): Promise<AgentOAuthStatus> {
    return this.owner.transact(async (state) => {
      await this.owner.lockAgent(state, namespaceId, agentId);
      await this.owner.authorize(actorId, namespaceId, agentId);
      const selection = await this.owner.resolveSelection(state, actorId, namespaceId, agentId);
      if (selection.providerConnectionId !== expectedProviderConnectionId) {
        throw new ScopeViolationError("The Agent's selected provider connection changed.");
      }
      if (selection.providerId !== method.providerId || selection.methodId !== method.methodId) {
        throw new ScopeViolationError(
          "The native OAuth method does not match the Agent's selected provider connection.",
        );
      }
      const driver = this.driver();
      const previous = await state.agentOAuth.latest(namespaceId, agentId);
      if ((previous?.generation ?? 0) !== expectedGeneration) {
        stale();
      }
      // Reconnect must terminate the old refresh owner before retiring its selection.
      // Custody alone cannot replace a live native profile.
      if (previous && ["handoff_pending", "ready"].includes(previous.phase)) {
        throw new ResourceConflictError("Retire the current OAuth runtime before reconnecting.");
      }
      if (previous && !["cancelled", "superseded"].includes(previous.phase)) {
        await this.transition(state, previous, "superseded");
      }
      const connectionId = previous?.connectionId ?? `aoc_${randomUUID()}`;
      const generation = expectedGeneration + 1;
      const now = this.owner.now();
      return status(
        await state.agentOAuth.create({
          namespaceId,
          agentId,
          providerConnectionId: selection.providerConnectionId,
          connectionId,
          generation,
          attemptId: randomUUID(),
          actorId,
          providerId: method.providerId,
          methodId: method.methodId,
          profileId: method.profileId(connectionId, generation),
          phase: "authorizing",
          deadlineAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
          secretIdentity: {
            id: `sec_${randomUUID()}`,
            namespaceId,
            name: `oauth-${connectionId}-${generation}`,
          },
          secretDriverId: driver.id,
          stagedSecret: null,
          storageUid: null,
          failureCode: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }),
      );
    });
  }

  async get(
    actorId: string,
    namespaceId: string,
    agentId: string,
  ): Promise<AgentOAuthStatus | undefined> {
    return this.owner.transact(async (state) => {
      await this.owner.lockAgent(state, namespaceId, agentId);
      await this.owner.authorize(actorId, namespaceId, agentId);
      const attempt = await state.agentOAuth.latest(namespaceId, agentId);
      if (
        attempt &&
        ["authorizing", "staging"].includes(attempt.phase) &&
        this.owner.now().getTime() >= Date.parse(attempt.deadlineAt)
      ) {
        // A controller restart can leave consent pending without a live timer.
        // Publish its durable expiry without interpreting native token lifetime.
        return status(
          await this.transition(state, attempt, "reconnect_required", {
            failureCode: "OAUTH_EXPIRED",
          }),
        );
      }
      return attempt === undefined ? undefined : status(attempt);
    });
  }

  async cancel(
    actorId: string,
    namespaceId: string,
    agentId: string,
    attemptId: string,
    generation: number,
  ): Promise<AgentOAuthStatus> {
    return this.owner.transact(async (state) => {
      const attempt = await this.exact(state, actorId, {
        namespaceId,
        agentId,
        attemptId,
        generation,
      });
      if (["handoff_pending", "ready"].includes(attempt.phase)) {
        throw new ResourceConflictError("Retire the OAuth runtime before deleting its connection.");
      }
      return status(
        attempt.phase === "cancelled"
          ? attempt
          : await this.transition(state, attempt, "cancelled"),
      );
    });
  }

  /** Private composition handle for a native adapter; never serialize this to clients. */
  async acquisition(
    actorId: string,
    namespaceId: string,
    agentId: string,
    selected: AgentOAuthStatus,
    signal?: AbortSignal,
    assertSession?: () => Promise<void>,
  ) {
    const expected = {
      namespaceId,
      agentId,
      attemptId: selected.attemptId,
      generation: selected.generation,
    };
    const bound = await this.owner.transact(async (state) => {
      const attempt = await this.current(state, actorId, expected);
      this.assertPending(attempt, ["authorizing", "staging"]);
      return attempt;
    });
    const deadline = AbortSignal.timeout(
      Math.max(0, Date.parse(bound.deadlineAt) - this.owner.now().getTime()),
    );
    const sessionClosed = new AbortController();
    const lifetime = AbortSignal.any([
      deadline,
      sessionClosed.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const assertLive = () => {
      if (lifetime.aborted) {
        stale();
      }
    };
    const assertCurrent = () =>
      this.owner.transact(async (state) => {
        this.assertPending(await this.current(state, actorId, expected), [
          "authorizing",
          "staging",
          "authenticated",
        ]);
        assertLive();
      });
    return Object.freeze({
      status: status(bound),
      signal: lifetime,
      assertCurrent,
      fail: async (): Promise<void> => {
        await this.owner.transact(async (state) => {
          const attempt = await this.exact(state, actorId, expected);
          // A staging failure may have committed bytes. Preserve its recovery
          // identity; do not turn an uncertain custody result into a new login.
          if (
            lifetime.aborted &&
            ["authorizing", "staging", "authenticated"].includes(attempt.phase)
          ) {
            await this.transition(state, attempt, "cancelled", { failureCode: "OAUTH_CANCELLED" });
          } else if (attempt.phase === "authorizing") {
            await this.transition(state, attempt, "reconnect_required", {
              failureCode: "OAUTH_FAILED",
            });
          }
        });
      },
      stage: async (value: string): Promise<AgentOAuthStatus> => {
        assertLive();
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          Buffer.byteLength(value, "utf8") > 65_536
        ) {
          throw new ScopeViolationError("The native OAuth credential envelope is invalid.");
        }
        let envelope;
        try {
          envelope = asRecord(JSON.parse(value));
        } catch {
          /* Reject without echoing input. */
        }
        const credential = asRecord(envelope?.credential);
        if (
          !envelope ||
          Object.keys(envelope).length !== 6 ||
          envelope.provider !== bound.providerId ||
          envelope.method !== bound.methodId ||
          envelope.connectionId !== bound.connectionId ||
          envelope.generation !== bound.generation ||
          envelope.profileId !== bound.profileId ||
          credential?.type !== "oauth" ||
          credential.provider !== bound.providerId
        ) {
          throw new ScopeViolationError(
            "The native OAuth credential envelope does not match its attempt.",
          );
        }
        // Commit the external identity before storing bytes. Unknown outcomes can
        // then be recovered without repeating consent or forgetting an orphan.
        await this.owner.transact(async (state) => {
          const attempt = await this.current(state, actorId, expected);
          this.assertPending(attempt, ["authorizing", "staging"]);
          assertLive();
          if (attempt.phase === "authorizing") {
            await this.transition(state, attempt, "staging");
          }
        });
        const backendRef = await this.owner.transact(async (state) => {
          const attempt = await this.current(state, actorId, expected);
          this.assertPending(attempt, ["staging"]);
          assertLive();
          const driver = this.driver(attempt.secretDriverId);
          // Cancellation/supersession shares this Agent lock through creation.
          const created = await this.backend(() => driver.stage!(attempt.secretIdentity, value));
          this.assertPending(await this.current(state, actorId, expected), ["staging"]);
          assertLive();
          return created;
        });
        // Session verification may need the same database pool. Release the Agent
        // transaction first, then reacquire its lock before admitting the stored bytes.
        try {
          await assertSession?.();
        } catch {
          sessionClosed.abort();
          stale();
        }
        return this.owner.transact(async (state) => {
          const attempt = await this.current(state, actorId, expected);
          this.assertPending(attempt, ["staging"]);
          assertLive();
          const driver = this.driver(attempt.secretDriverId);
          return status(
            await this.transition(state, attempt, "authenticated", {
              stagedSecret: {
                ...attempt.secretIdentity,
                driverId: driver.id,
                backendRef,
                createdAt: attempt.createdAt,
              },
            }),
          );
        });
      },
    });
  }

  /** Recover an unknown staging outcome without reacquiring or exposing bytes. */
  async recover(
    actorId: string,
    namespaceId: string,
    agentId: string,
    attemptId: string,
    generation: number,
  ): Promise<AgentOAuthStatus> {
    return this.owner.transact(async (state) => {
      const attempt = await this.exact(state, actorId, {
        namespaceId,
        agentId,
        attemptId,
        generation,
      });
      if (attempt.phase !== "staging") {
        return status(attempt);
      }
      if (this.owner.now().getTime() >= Date.parse(attempt.deadlineAt)) {
        return status(
          await this.transition(state, attempt, "reconnect_required", {
            failureCode: "OAUTH_EXPIRED",
          }),
        );
      }
      await this.assertSelection(state, actorId, attempt);
      const driver = this.driver(attempt.secretDriverId);
      const backendRef = await this.backend(() => driver.findStaged!(attempt.secretIdentity));
      await this.owner.authorize(actorId, namespaceId, agentId);
      await this.assertSelection(state, actorId, attempt);
      this.assertPending(attempt, ["staging"]);
      if (!backendRef) {
        return status(
          await this.transition(state, attempt, "reconnect_required", {
            failureCode: "CREDENTIAL_STAGING_FAILED",
          }),
        );
      }
      return status(
        await this.transition(state, attempt, "authenticated", {
          stagedSecret: {
            ...attempt.secretIdentity,
            driverId: driver.id,
            backendRef,
            createdAt: attempt.createdAt,
          },
        }),
      );
    });
  }

  /** Retry cleanup, including Secrets whose create acknowledgment was lost. */
  async cleanup(actorId: string, namespaceId: string, agentId: string): Promise<void> {
    await this.owner.transact(async (state) => {
      await this.owner.lockAgent(state, namespaceId, agentId);
      await this.owner.authorize(actorId, namespaceId, agentId);
      for (const attempt of await state.agentOAuth.list(namespaceId, agentId)) {
        if (!["cancelled", "superseded", "reconnect_required"].includes(attempt.phase)) {
          continue;
        }
        const driver = this.driver(attempt.secretDriverId);
        const backendRef =
          attempt.stagedSecret?.backendRef ??
          (await this.backend(() => driver.findStaged!(attempt.secretIdentity)));
        if (backendRef) {
          await this.backend(() =>
            driver.delete(
              attempt.stagedSecret ?? {
                ...attempt.secretIdentity,
                driverId: driver.id,
                backendRef,
                createdAt: attempt.createdAt,
              },
            ),
          );
        }
        await this.transition(state, attempt, attempt.phase, { stagedSecret: null });
      }
    });
  }

  private async exact(
    state: PlatformUnitOfWork,
    actorId: string,
    expected: Pick<AgentOAuthAttempt, "namespaceId" | "agentId" | "attemptId" | "generation">,
  ): Promise<AgentOAuthAttempt> {
    await this.owner.lockAgent(state, expected.namespaceId, expected.agentId);
    await this.owner.authorize(actorId, expected.namespaceId, expected.agentId);
    const attempt = await state.agentOAuth.latest(expected.namespaceId, expected.agentId);
    if (
      !attempt ||
      attempt.actorId !== actorId ||
      attempt.attemptId !== expected.attemptId ||
      attempt.generation !== expected.generation
    ) {
      stale();
    }
    return attempt;
  }

  private async current(
    state: PlatformUnitOfWork,
    actorId: string,
    expected: Pick<AgentOAuthAttempt, "namespaceId" | "agentId" | "attemptId" | "generation">,
  ): Promise<AgentOAuthAttempt> {
    const attempt = await this.exact(state, actorId, expected);
    await this.assertSelection(state, actorId, attempt);
    return attempt;
  }

  private async assertSelection(
    state: PlatformUnitOfWork,
    actorId: string,
    attempt: AgentOAuthAttempt,
  ): Promise<void> {
    const selection = await this.owner.resolveSelection(
      state,
      actorId,
      attempt.namespaceId,
      attempt.agentId,
    );
    if (
      selection.providerConnectionId !== attempt.providerConnectionId ||
      selection.providerId !== attempt.providerId ||
      selection.methodId !== attempt.methodId
    ) {
      stale();
    }
  }

  private assertPending(attempt: AgentOAuthAttempt, phases: readonly AgentOAuthPhase[]): void {
    if (
      !phases.includes(attempt.phase) ||
      this.owner.now().getTime() >= Date.parse(attempt.deadlineAt)
    ) {
      stale();
    }
  }

  private async transition(
    state: PlatformUnitOfWork,
    attempt: AgentOAuthAttempt,
    phase: AgentOAuthPhase,
    patch: Partial<Pick<AgentOAuthAttempt, "stagedSecret" | "failureCode">> = {},
  ): Promise<AgentOAuthAttempt> {
    const updated = await state.agentOAuth.update({
      namespaceId: attempt.namespaceId,
      agentId: attempt.agentId,
      generation: attempt.generation,
      expectedPhase: attempt.phase,
      phase,
      updatedAt: this.owner.now().toISOString(),
      ...patch,
    });
    if (!updated) {
      stale();
    }
    return updated;
  }

  private driver(expectedId?: string): SecretDriver {
    const driver = this.owner.secretDriver(expectedId);
    if (!driver.stage || !driver.findStaged) {
      throw new DependencyUnavailableError(
        "The selected Secret Driver does not support recoverable OAuth custody.",
      );
    }
    return driver;
  }

  private async backend<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new DependencyUnavailableError(
        "OAuth credential storage is unavailable or its outcome is unknown. Retry recovery.",
      );
    }
  }
}
