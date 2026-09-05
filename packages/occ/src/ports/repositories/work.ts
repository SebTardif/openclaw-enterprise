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
