import type { RuntimeGateGuardV1, RuntimePreparedChildV1 } from "@openclaw-enterprise/contracts";
import type {
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileOwnedLeaseV2,
} from "../workload-profiles/admitted-use.ts";
import type {
  WorkloadProfileAdmissionRecordV2,
  WorkloadProfileSelectionRequestV2,
} from "../workload-profiles/selection.ts";

/** Expected locators only. The original state owner resolves all retained data
 * on its authenticated current account/IAM transaction. */
export interface RuntimePreparationCurrentUseRequestV1 {
  readonly selection: WorkloadProfileSelectionRequestV2;
  readonly preparationRef: string;
  readonly preparationVersion: number;
  readonly effectRef: string;
  readonly guard: RuntimeGateGuardV1;
}

/** A necessary same-transaction observation, never an effect permit. In
 * particular neither this lease nor its copied records survive COMMIT as
 * authority to submit. The accepting invocation must reacquire current use. */
export interface RuntimePreparationCurrentUseLeaseV1 extends WorkloadProfileOwnedLeaseV2 {
  /** Original transaction's terminal ownership, never a caller-local grant. */
  retain(lease: WorkloadProfileOwnedLeaseV2): undefined;
  readonly request: RuntimePreparationCurrentUseRequestV1;
  readonly profile: WorkloadProfileAdmissionRecordV2;
  readonly revision: Readonly<import("@openclaw-enterprise/contracts").AgentRevision>;
  readonly unit: WorkloadProfileDeploymentUnitV2;
  readonly child: RuntimePreparedChildV1;
  readonly providerWireUtf8: string;
}
