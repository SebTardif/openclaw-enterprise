import type {
  RuntimeScope,
  RuntimeIntentAttribution,
  RuntimeIntent,
  RuntimeProfileRefs,
  RuntimeAllocation,
  RuntimeAllocationLocator,
} from "@openclaw-enterprise/contracts/runtime-assignment";

export interface RuntimeAssignmentReadRepository {
  findRuntimeIntent(
    scope: RuntimeScope,
    transitionRef: string,
  ): Promise<Readonly<RuntimeIntent> | undefined>;
  findRuntimeIntentHead(scope: RuntimeScope): Promise<Readonly<RuntimeIntent> | undefined>;
  findRuntimeAllocation(
    scope: RuntimeScope,
    locator: RuntimeAllocationLocator,
  ): Promise<Readonly<RuntimeAllocation> | undefined>;
}

export interface RuntimeAssignmentRepository extends RuntimeAssignmentReadRepository {
  initializeRuntimeIntent(
    scope: RuntimeScope,
    revisionId: string,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>>;
  advanceRuntimeIntent(
    scope: RuntimeScope,
    expectedGeneration: number,
    next: Pick<RuntimeIntent, "desiredMode" | "revisionId">,
    transitionRef: string,
    attribution: RuntimeIntentAttribution,
  ): Promise<Readonly<RuntimeIntent>>;
  allocateUnboundRuntime(
    scope: RuntimeScope,
    expectedLifecycleGeneration: number,
    component: RuntimeAllocation["component"],
    expectedRuntimeGeneration: number,
    createEffectRef: string,
    profileRefs: RuntimeProfileRefs,
  ): Promise<Readonly<RuntimeAllocation>>;
}
