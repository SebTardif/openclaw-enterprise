import type {
  AuthorizationRequest,
  ComputeDriver,
  IAMDriver,
  Installation,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
} from "@openclaw-enterprise/contracts";
import type { NativeIAMState } from "@openclaw-enterprise/iam";
import { WorkClaimLostError } from "@openclaw-enterprise/occ";
import type { LeasedEffects, WorkerClaimContext } from "./leased-effect.ts";
import { workerIAMDecision } from "./revision-inputs.ts";
import type { DispatchResult, Outcome } from "./runner.ts";

export interface NamespaceReconcilerOptions {
  readonly readNamespace: (namespaceId: string) => Promise<Readonly<Namespace> | undefined>;
  readonly getInstallation: () => Readonly<Installation> | undefined;
  readonly loadIAMState: () => Promise<NativeIAMState>;
  readonly iam: Pick<IAMDriver, "id" | "authorize">;
  readonly compute: Pick<ComputeDriver, "ensureNamespace" | "deleteNamespace">;
  readonly effects: LeasedEffects;
  readonly finalize: (
    execution: WorkerClaimContext,
    namespace: Readonly<Namespace> | undefined,
    result: DispatchResult,
  ) => Promise<void>;
}

function validObservation(value: unknown, namespaceId: string, target: "ready" | "deleted") {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId"))
    return false;
  const observation = value as Partial<NamespaceEnsureResult & NamespaceDeleteResult>;
  if (
    observation.namespaceId !== namespaceId ||
    (observation.failure !== undefined &&
      observation.failure !== "retryable" &&
      observation.failure !== "permanent")
  )
    return false;
  return target === "ready"
    ? typeof observation.namespaceReady === "boolean"
    : typeof observation.namespaceDeleted === "boolean";
}

/** Reconciles Namespace targets through the worker's sole finalization authority. */
export class NamespaceReconciler {
  private readonly options: NamespaceReconcilerOptions;

  constructor(options: NamespaceReconcilerOptions) {
    this.options = options;
  }

  async reconcile(execution: WorkerClaimContext): Promise<void> {
    const { claim } = execution;
    if (
      claim.agentId !== undefined ||
      claim.namespaceTarget === undefined ||
      claim.runtimeTransitionRef !== undefined ||
      claim.lifecycleGeneration !== undefined
    ) {
      await this.options.finalize(execution, undefined, {
        outcome: "permanent",
        code: "INVALID_TARGET",
      });
      return;
    }
    let namespace: Readonly<Namespace> | undefined;
    let result: DispatchResult;
    try {
      namespace = await this.options.readNamespace(claim.namespaceId);
      const expected = claim.namespaceTarget === "ready" ? "provisioning" : "deleting";
      if (namespace === undefined || namespace.status !== expected) {
        await this.options.finalize(execution, namespace, {
          outcome: "success",
          code: "SUPERSEDED_TARGET",
        });
        return;
      }
      const denied = await this.authorize(claim, namespace);
      if (denied !== undefined) {
        await this.options.finalize(execution, namespace, denied);
        return;
      }
      await this.options.effects.renew(execution);
      result = await this.observe(execution, namespace);
    } catch (error) {
      if (error instanceof WorkClaimLostError) throw error;
      result = { outcome: "retry", code: "DEPENDENCY_UNAVAILABLE" };
    }
    await this.options.finalize(execution, namespace, result);
  }

  private async authorize(
    claim: WorkerClaimContext["claim"],
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult | undefined> {
    const installation = this.options.getInstallation();
    if (installation === undefined) throw new Error("The worker Installation is unavailable.");
    const state = await this.options.loadIAMState();
    const driver = this.options.iam;
    const exact: AuthorizationRequest = {
      principalId: claim.actorId,
      action: claim.namespaceTarget === "ready" ? "create" : "delete",
      resource: { kind: "namespace", id: namespace.id, namespaceId: namespace.id },
    };
    const request: AuthorizationRequest =
      claim.namespaceTarget === "ready"
        ? {
            principalId: claim.actorId,
            action: "create",
            resource: { kind: "namespace", id: installation.id },
          }
        : exact;
    if (!state.identities.some((identity) => identity.id === claim.actorId)) {
      const decision = await workerIAMDecision(driver, request);
      return { outcome: "permanent", code: "ACTOR_REVOKED", decision, authorization: request };
    }
    const decision = await workerIAMDecision(driver, request);
    if (!decision.allowed)
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        decision,
        authorization: request,
      };
    if (claim.namespaceTarget === "ready") {
      if (namespace.existingNamespace !== undefined) {
        const adminRequest: AuthorizationRequest = {
          principalId: claim.actorId,
          action: "administer",
          resource: { kind: "installation", id: installation.id },
        };
        const adminDecision = await workerIAMDecision(driver, adminRequest);
        if (!adminDecision.allowed)
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            decision: adminDecision,
            authorization: adminRequest,
          };
      }
      const exactDecision = await workerIAMDecision(driver, exact);
      if (exactDecision.evidence.restrictionIds.length > 0)
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          decision: exactDecision,
          authorization: exact,
        };
    }
    return undefined;
  }

  private async observe(
    execution: WorkerClaimContext,
    namespace: Readonly<Namespace>,
  ): Promise<DispatchResult> {
    const { claim } = execution;
    return this.options.effects.run(execution, async () => {
      const observation =
        claim.namespaceTarget === "ready"
          ? await this.options.compute.ensureNamespace(namespace)
          : await this.options.compute.deleteNamespace(namespace);
      if (!validObservation(observation, namespace.id, claim.namespaceTarget ?? "ready"))
        return { outcome: "permanent", code: "INVALID_DRIVER_OBSERVATION" };
      const complete =
        "namespaceReady" in observation ? observation.namespaceReady : observation.namespaceDeleted;
      let outcome: Outcome;
      if (observation.failure === "permanent") outcome = "permanent";
      else if (complete && observation.failure === undefined) outcome = "success";
      else if (observation.failure === "retryable") outcome = "retry";
      else outcome = "pending";
      return {
        outcome,
        code: complete ? "NAMESPACE_RECONCILED" : "NAMESPACE_INCOMPLETE",
        observation,
      };
    });
  }
}
