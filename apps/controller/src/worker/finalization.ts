import { randomUUID } from "node:crypto";
import type {
  AgentRevision,
  AuditEvent,
  Installation,
  Namespace,
} from "@openclaw-enterprise/contracts";
import {
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PostgresWorkQueue,
} from "@openclaw-enterprise/occ";
import type { WorkerRevisionCleanup } from "./cleanup.ts";
import type { WorkerClaimContext } from "./leased-effect.ts";
import type { DispatchResult, RevisionDispatchResult } from "./runner.ts";

export interface WorkerFinalizationUnit {
  readonly agents: Pick<PlatformUnitOfWork["agents"], "lockAgent" | "compareAndSetActiveRevision">;
  readonly namespaces: Pick<
    PlatformUnitOfWork["namespaces"],
    "lockNamespace" | "transitionNamespaceStatus" | "markNamespaceDeleted"
  >;
  readonly audit: Pick<PlatformUnitOfWork["audit"], "append">;
}

export type WorkerFinalizationQueue = Pick<
  PostgresWorkQueue,
  "heartbeat" | "complete" | "defer" | "retry" | "fail" | "enqueue"
>;

export interface WorkerFinalizationOptions {
  readonly transact: (
    action: (unit: WorkerFinalizationUnit, queue: WorkerFinalizationQueue) => Promise<void>,
  ) => Promise<void>;
  readonly installation: () => Readonly<Installation> | undefined;
  readonly iamDriverId: string;
  readonly computeDriverId: string;
  readonly convergenceTimeoutMs: number;
  readonly maxAttempts: number;
  readonly maintenanceIntervalMs: number | undefined;
  readonly cleanup: Pick<WorkerRevisionCleanup, "afterActivation">;
  readonly emit: (event: Readonly<Record<string, unknown>>) => void;
}

function workOperation(claim: ClaimedWork): string {
  if (claim.revisionId !== undefined) return "agent_revision.reconcile";
  if (claim.namespaceTarget === "deleted") return "namespace.delete";
  if (claim.namespaceTarget === "ready") return "namespace.ensure";
  return "work.reconcile";
}

function workLogFields(claim: ClaimedWork): {
  readonly workId: string;
  readonly attempt: number;
  readonly operation: string;
} {
  return {
    workId: claim.idempotencyKey,
    attempt: claim.attemptCount,
    operation: workOperation(claim),
  };
}

/** Owns the existing queue-bound transitions, audits, and staged revision completion. */
export class WorkerFinalization {
  private readonly options: WorkerFinalizationOptions;

  constructor(options: WorkerFinalizationOptions) {
    this.options = options;
  }

  async finalizeRevision(
    execution: WorkerClaimContext,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const { claim } = execution;
    const expired =
      result.outcome === "pending" &&
      Date.now() - claim.createdAt.getTime() >= this.options.convergenceTimeoutMs;
    const resolved: RevisionDispatchResult = expired
      ? { ...result, outcome: "permanent", code: "CONVERGENCE_DEADLINE_EXCEEDED" }
      : result;
    let activated: Readonly<AgentRevision> | undefined;
    await this.options.transact(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      if (resolved.supersededBy !== undefined && resolved.outcome === "success") {
        await this.appendRevisionSuperseded(unit, claim, resolved.supersededBy);
      } else if (resolved.revision !== undefined && resolved.outcome === "success") {
        const current = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
        if (
          current === undefined ||
          current.servicePrincipalId !== resolved.revision.servicePrincipalId ||
          current.activeRevisionId !== resolved.expectedActiveRevisionId
        ) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          return;
        }
        const activeAgent = await unit.agents.compareAndSetActiveRevision(
          claim.namespaceId,
          current.id,
          resolved.expectedActiveRevisionId,
          resolved.revision.id,
        );
        if (activeAgent === undefined) {
          await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
          return;
        }
        activated = resolved.revision;
        return;
      } else if (resolved.decision !== undefined) {
        await this.appendRevisionDenial(unit, claim, resolved);
      }

      if (resolved.outcome === "success") await queue.complete(claim);
      else if (resolved.outcome === "pending") await queue.defer(claim, { code: resolved.code });
      else if (resolved.outcome === "permanent" || claim.attemptCount >= this.options.maxAttempts)
        await queue.fail(claim, { code: resolved.code });
      else await queue.retry(claim, { code: resolved.code });
    });
    if (activated !== undefined) {
      try {
        await this.options.cleanup.afterActivation(execution, activated, resolved);
      } catch (error) {
        if (error instanceof WorkClaimLostError) throw error;
        await this.finalizeRevision(execution, {
          outcome: "pending",
          code: "REVISION_FINALIZATION_INCOMPLETE",
        });
        return;
      }
      await this.completeActivatedRevision(execution, resolved);
      return;
    }
    this.options.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: resolved.outcome,
      outcome: resolved.outcome,
      code: resolved.code,
    });
  }

  async completeActivatedRevision(
    execution: WorkerClaimContext,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const { claim } = execution;
    const revision = result.revision;
    if (revision === undefined) throw new Error("The activated Agent revision is unavailable.");
    let completed = false;
    await this.options.transact(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
      if (
        agent === undefined ||
        agent.id !== revision.agentId ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id
      ) {
        await queue.retry(claim, { code: "ACTIVE_REVISION_CHANGED" });
        return;
      }
      await this.appendRevisionObservation(unit, claim, result);
      await queue.complete(claim);
      if (this.options.maintenanceIntervalMs !== undefined)
        await this.enqueueMaintenance(queue, claim, revision);
      completed = true;
    });
    if (!completed) return;
    this.options.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: result.outcome,
      outcome: result.outcome,
      code: result.code,
    });
  }

  async finalizeActiveRevision(
    execution: WorkerClaimContext,
    revision: Readonly<AgentRevision>,
    code: string,
  ): Promise<void> {
    const { claim } = execution;
    if (
      this.options.maintenanceIntervalMs === undefined ||
      !claim.idempotencyKey.startsWith(`agent_revision:${revision.id}:maintenance:`)
    ) {
      await this.finalizeRevision(execution, { outcome: "pending", code });
      return;
    }
    await this.options.transact(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      const agent = await unit.agents.lockAgent(claim.namespaceId, claim.agentId!);
      if (
        agent === undefined ||
        agent.servicePrincipalId !== revision.servicePrincipalId ||
        agent.activeRevisionId !== revision.id
      ) {
        await queue.complete(claim);
        return;
      }
      // Keep each failed observation bounded without permanently abandoning
      // an authorized active runtime after one prolonged provider outage.
      await queue.fail(claim, { code });
      await this.enqueueMaintenance(queue, claim, revision);
    });
    this.options.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      agentId: claim.agentId,
      revisionId: claim.revisionId,
      result: "pending",
      outcome: "pending",
      code,
    });
  }

  private async enqueueMaintenance(
    queue: WorkerFinalizationQueue,
    claim: ClaimedWork,
    revision: Readonly<AgentRevision>,
  ): Promise<void> {
    const interval = this.options.maintenanceIntervalMs!;
    const availableAt = new Date(Date.now() + interval);
    const maintenanceBucket = Math.floor(availableAt.getTime() / interval);
    await queue.enqueue({
      idempotencyKey: `agent_revision:${revision.id}:maintenance:${maintenanceBucket}`,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      actorId: claim.actorId,
      availableAt,
      ...(claim.runtimeTransitionRef === undefined
        ? {}
        : { runtimeTransitionRef: claim.runtimeTransitionRef }),
      ...(claim.lifecycleGeneration === undefined
        ? {}
        : { lifecycleGeneration: claim.lifecycleGeneration }),
    });
  }

  private async appendRevisionObservation(
    unit: WorkerFinalizationUnit,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.options.installation();
    const revision = result.revision;
    if (installation === undefined || revision === undefined)
      throw new Error("The worker revision activation is unavailable.");
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: revision.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.activate",
      resource: { kind: "agent_revision", id: revision.id, namespaceId: revision.namespaceId },
      iamDriverId: this.options.iamDriverId,
      outcome: "success",
      details: {
        computeDriverId: this.options.computeDriverId,
        ...(result.previous === undefined ? {} : { previousRevisionId: result.previous.id }),
      },
    });
  }

  private async appendRevisionSuperseded(
    unit: WorkerFinalizationUnit,
    claim: ClaimedWork,
    active: Readonly<AgentRevision>,
  ): Promise<void> {
    const installation = this.options.installation();
    if (installation === undefined || claim.revisionId === undefined)
      throw new Error("The worker superseded revision is unavailable.");
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.lifecycle.supersede",
      resource: {
        kind: "agent_revision",
        id: claim.revisionId,
        namespaceId: claim.namespaceId,
      },
      iamDriverId: this.options.iamDriverId,
      outcome: "success",
      details: {
        activeRevisionId: active.id,
        reasonCode: "REVISION_SUPERSEDED",
      },
    });
  }

  private async appendRevisionDenial(
    unit: WorkerFinalizationUnit,
    claim: ClaimedWork,
    result: RevisionDispatchResult,
  ): Promise<void> {
    const installation = this.options.installation();
    if (installation === undefined || claim.agentId === undefined)
      throw new Error("The worker revision authorization is unavailable.");
    await unit.audit.append({
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: claim.namespaceId,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action: "openclaw.agents.deploy",
      resource: { kind: "agent", id: claim.agentId, namespaceId: claim.namespaceId },
      iamDriverId: this.options.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    });
  }

  async finalize(
    execution: WorkerClaimContext,
    namespace: Readonly<Namespace> | undefined,
    result: DispatchResult,
  ): Promise<void> {
    const { claim } = execution;
    const expired =
      result.outcome === "pending" &&
      Date.now() - claim.createdAt.getTime() >= this.options.convergenceTimeoutMs;
    const resolved: DispatchResult = expired
      ? { ...result, outcome: "permanent", code: "CONVERGENCE_DEADLINE_EXCEEDED" }
      : result;
    await this.options.transact(async (unit, queue) => {
      if ((await queue.heartbeat(claim)) === undefined) throw new WorkClaimLostError();
      const current =
        namespace === undefined
          ? undefined
          : await unit.namespaces.lockNamespace(namespace.id, { includeDeleted: true });
      if (
        current !== undefined &&
        current.deletedAt === undefined &&
        ((claim.namespaceTarget === "ready" && current.status === "provisioning") ||
          (claim.namespaceTarget === "deleted" && current.status === "deleting"))
      ) {
        const exhausted =
          resolved.outcome === "retry" && claim.attemptCount >= this.options.maxAttempts;
        if (claim.namespaceTarget === "ready" && resolved.outcome === "success")
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "ready");
        else if (
          claim.namespaceTarget === "ready" &&
          (resolved.outcome === "permanent" || exhausted)
        )
          await unit.namespaces.transitionNamespaceStatus(current.id, "provisioning", "failed");
        else if (claim.namespaceTarget === "deleted" && resolved.outcome === "success")
          await unit.namespaces.markNamespaceDeleted(current.id, new Date().toISOString());

        if (resolved.decision !== undefined)
          await this.appendDenial(unit, claim, current, resolved);
        else if (resolved.observation !== undefined)
          await this.appendObservation(unit, claim, current, resolved);
      }

      if (resolved.outcome === "success") await queue.complete(claim);
      else if (resolved.outcome === "pending") await queue.defer(claim, { code: resolved.code });
      else if (resolved.outcome === "permanent" || claim.attemptCount >= this.options.maxAttempts)
        await queue.fail(claim, { code: resolved.code });
      else await queue.retry(claim, { code: resolved.code });
    });
    this.options.emit({
      event: "worker.completed",
      ...workLogFields(claim),
      namespaceId: claim.namespaceId,
      result: resolved.outcome,
      outcome: resolved.outcome,
      code: resolved.code,
    });
  }

  private async appendObservation(
    unit: WorkerFinalizationUnit,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
  ): Promise<void> {
    const installation = this.options.installation();
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
    const observation = result.observation;
    if (observation === undefined) return;
    const details = {
      computeDriverId: this.options.computeDriverId,
      ...("namespaceReady" in observation
        ? { namespaceReady: observation.namespaceReady }
        : { namespaceDeleted: observation.namespaceDeleted }),
      ...(observation.failure === undefined ? {} : { failure: observation.failure }),
      ...(result.outcome === "pending" ? { convergencePending: true } : {}),
    };
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.options.iamDriverId,
      outcome: result.outcome === "success" || result.outcome === "pending" ? "success" : "failure",
      details,
    };
    await unit.audit.append(event);
  }

  private async appendDenial(
    unit: WorkerFinalizationUnit,
    claim: ClaimedWork,
    namespace: Readonly<Namespace>,
    result: DispatchResult,
  ): Promise<void> {
    const installation = this.options.installation();
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
    const event: AuditEvent = {
      id: `aud_${randomUUID()}`,
      installationId: installation.id,
      namespaceId: namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "authorization_denial",
      actorId: claim.actorId,
      source: "occ",
      action:
        claim.namespaceTarget === "deleted"
          ? "openclaw.namespaces.delete"
          : "openclaw.namespaces.create",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
      iamDriverId: this.options.iamDriverId,
      ...(result.authorization === undefined ? {} : { authorization: result.authorization }),
      ...(result.decision === undefined ? {} : { decisionReason: result.decision.reason }),
      reasonCode: result.code,
      outcome: "denied",
    };
    await unit.audit.append(event);
  }
}
