import type {
  ContainmentControlCursorV1,
  ContainmentControlInputV1,
  ContainmentControlObserverV1,
  ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";
import type {
  AuthorityCallV1,
  AuthorityOperationStateV1,
  ResolveAssignmentRequestV1,
  RetireAssignmentV1,
  RetirementResultV1,
  RuntimeAssignmentAuthorityV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  ConditionalRouteV1,
  ExactCleanupV1,
  ExactHandoffV1,
  ExactRuntimeFaultV1,
  ExactStoreBindingV1,
  RuntimeEffectsV1,
  RuntimeEffectStateV1,
  RuntimeFaultSinkV1,
  WorkspaceHandoffEvidenceV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type {
  ContainmentEvidenceEvaluationV1,
  ContainmentEvidenceStateV1,
} from "../containment/evidence-evaluator-v1.ts";
import type {
  ContainmentFaultAttemptV1,
  ContainmentFaultClockV1,
  ContainmentFaultContinuationV1,
  ContainmentFaultExpectedV1,
} from "../containment/fault-request-adapter-v1.ts";

export type ImmutableActivationV1<T> = ImmutableContainmentControlV1<T>;
export type ActivationReadinessRequestV1 = Extract<
  ResolveAssignmentRequestV1,
  { purpose: "readiness-probe" }
>;
export type ActivationCleanupRequestV1 = Extract<
  ResolveAssignmentRequestV1,
  { purpose: "cleanup" }
>;

/** Explicit admitted selections from the original profile owner, never defaults.
 * Serialized fields are not proof of that ownership. All eight controls are required. */
export interface RuntimeActivationSelectionV1 {
  readonly runtimeProfile: ContainmentControlInputV1["containmentProfile"];
  readonly containmentProfile: ContainmentControlInputV1["containmentProfile"];
  readonly controls: ContainmentControlInputV1["requiredControls"];
}

interface OperationBase {
  readonly originalRequestRef: string;
  readonly phase: "readback-only" | "resolved";
}
export type RuntimeActivationOperationV1 =
  | (OperationBase & {
      readonly kind: "effect";
      readonly request: ConditionalRouteV1 | ExactCleanupV1;
      readonly result: RuntimeEffectStateV1 | null;
    })
  | (OperationBase & {
      readonly kind: "authority-retirement";
      readonly request: RetireAssignmentV1;
      readonly result: RetirementResultV1 | AuthorityOperationStateV1 | null;
    })
  | (OperationBase & {
      readonly kind: "fault";
      readonly continuation: ContainmentFaultContinuationV1;
      readonly result: ContainmentFaultAttemptV1 | null;
    });

/** Owned protected continuation, not a second store or an authorization token.
 * The original owner serializes access and retains every accepted transition.
 * No initial-state/reset constructor is supplied by this module. */
export interface RuntimeActivationStateV1 {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly evidence: ImmutableActivationV1<ContainmentEvidenceStateV1>;
  readonly cursor: ContainmentControlCursorV1 | null;
  readonly activationClosed: boolean;
  readonly operations: readonly RuntimeActivationOperationV1[];
}

/** Proposed immutable transitions go to the existing original protected owner.
 * It checks exact previous state/version, serializes mutations and retains state
 * before replying retained. Unknown/unavailable must never permit an effect.
 * This does not replace the original worker claim or any accepting authority guard. */
export interface RuntimeActivationOwnerV1 {
  checkpoint(
    previous: ImmutableActivationV1<RuntimeActivationStateV1>,
    proposed: ImmutableActivationV1<RuntimeActivationStateV1>,
    call: AuthorityCallV1,
  ): Promise<"retained" | "conflict" | "unavailable">;
}

export interface RuntimeActivationOptionsV1 {
  readonly authority: RuntimeAssignmentAuthorityV1;
  readonly effects: RuntimeEffectsV1;
  readonly controls: ContainmentControlObserverV1;
  readonly workspace: WorkspaceHandoffEvidenceV1;
  readonly faults: RuntimeFaultSinkV1;
  readonly owner: RuntimeActivationOwnerV1;
  readonly clock: ContainmentFaultClockV1;
}
export interface RuntimeActivationInputV1 {
  readonly state: ImmutableActivationV1<RuntimeActivationStateV1>;
  readonly selection: ImmutableActivationV1<RuntimeActivationSelectionV1> | null;
  readonly expected: ImmutableActivationV1<ContainmentControlInputV1>;
  readonly authority: ActivationReadinessRequestV1;
  readonly handoff: ExactHandoffV1;
  readonly stores: readonly ExactStoreBindingV1[];
  readonly route: ConditionalRouteV1;
}
export interface RuntimeRetirementInputV1 {
  readonly state: ImmutableActivationV1<RuntimeActivationStateV1>;
  readonly retirement: RetireAssignmentV1;
  readonly routeAuthority: ActivationCleanupRequestV1;
  readonly cleanupAuthority: ActivationCleanupRequestV1;
  readonly route: ConditionalRouteV1;
  readonly cleanup: ExactCleanupV1;
}
export interface RuntimeActivationFaultInputV1 {
  readonly state: ImmutableActivationV1<RuntimeActivationStateV1>;
  readonly fault: ExactRuntimeFaultV1;
  readonly expected: ContainmentFaultExpectedV1;
}

export interface RuntimeActivationResultV1 {
  readonly status:
    "blocked" | "route-observed" | "retirement-observed" | "readback" | "fault-request";
  readonly reason: string;
  /** TODO(serving owner): integrate original atomic current-version publication;
   * comparison and route observations cannot substitute for that unavailable CAS. */
  readonly serving: "publication-unavailable";
  readonly termination: "not-proved" | "observed";
  readonly state: ImmutableActivationV1<RuntimeActivationStateV1> | null;
  readonly stateRetention: "unchanged" | "retained" | "unknown";
  readonly proposedState: ImmutableActivationV1<RuntimeActivationStateV1> | null;
  readonly evaluation: ContainmentEvidenceEvaluationV1 | null;
  readonly operation: ImmutableActivationV1<RuntimeActivationOperationV1> | null;
}
