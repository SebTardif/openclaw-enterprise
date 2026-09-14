export interface RuntimeScope {
  readonly namespaceId: string;
  readonly agentId: string;
}
export interface RuntimeIntentAttribution {
  readonly actorId: string;
  readonly requestId: string;
}
interface RuntimeIntentBase extends RuntimeScope, RuntimeIntentAttribution {
  readonly installationId: string;
  readonly transitionRef: string;
  readonly generation: number;
  readonly createdAt: string;
}
export type RuntimeIntent = RuntimeIntentBase &
  (
    | { readonly desiredMode: "running"; readonly revisionId: string }
    | { readonly desiredMode: "disabled" | "stopped"; readonly revisionId: string | null }
  );
export interface RuntimeProfileRefs {
  readonly providerProfileRef: string;
  readonly runtimeProfileRef: string;
  readonly identityProfileRef: string;
}
export interface RuntimeAllocation extends RuntimeScope, RuntimeProfileRefs {
  readonly assignmentRef: string;
  readonly createEffectRef: string;
  readonly installationId: string;
  readonly revisionId: string;
  readonly servicePrincipalId: string;
  readonly lifecycleGeneration: number;
  readonly component: "gateway" | "harness";
  readonly runtimeGeneration: number;
  readonly bindingCondition: "unbound";
  readonly createdAt: string;
}
export type RuntimeAllocationLocator =
  | { readonly assignmentRef: string; readonly createEffectRef?: never }
  | { readonly createEffectRef: string; readonly assignmentRef?: never };
