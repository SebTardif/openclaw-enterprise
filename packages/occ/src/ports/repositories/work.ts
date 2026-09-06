interface PlatformOperationBase {
  readonly action: "reconcile";
  readonly namespaceId: string;
  readonly resourceId: string;
  readonly actorId: string;
  readonly runtimeTransitionRef?: string;
  readonly lifecycleGeneration?: number;
}

export type PlatformOperation =
  | (PlatformOperationBase & {
      readonly kind: "namespace";
      readonly target: "ready" | "deleted";
    })
  | (PlatformOperationBase & {
      readonly kind: "agent_revision";
      readonly target?: never;
    });

export interface PlatformOperationReadRepository {
  list(): Promise<readonly Readonly<PlatformOperation>[]>;
}

export interface PlatformOperationRepository extends PlatformOperationReadRepository {
  append(operation: PlatformOperation): Promise<void>;
}

export type ControllerWorkState = "queued" | "claimed" | "succeeded" | "failed_permanent";

export interface ControllerWork {
  readonly idempotencyKey: string;
  readonly namespaceId: string;
  readonly agentId?: string;
  readonly revisionId?: string;
  readonly runtimeTransitionRef?: string;
  readonly lifecycleGeneration?: number;
  readonly actorId: string;
  readonly namespaceTarget?: "ready" | "deleted";
  readonly state: ControllerWorkState;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly completedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClaimedWork extends ControllerWork {
  readonly state: "claimed";
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
}

export interface WorkClaim {
  readonly idempotencyKey: string;
  readonly claimToken: string;
}
