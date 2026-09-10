import type { GatewayProcessTargetV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type { GatewayLaunchResourceAllocationV2 } from "@openclaw-enterprise/contracts/gateway-launch-resource-v2";
import type {
  GatewayStartupMutationEventV2,
  GatewayStartupAcceptedOperationV1,
  GatewayStartupSelectionUnitV2,
} from "./owner.ts";

/** Original selected launch owner, captured by the protected Controller factory.
 * The source must own the actual selected definitions, namespace and canonical
 * nonsecret installed document. Neither JSON nor this type supplies that lease. */
export interface GatewayLaunchResourceSourceV2 {
  prepareLocked(
    acceptance: GatewayStartupMutationEventV2,
    allocation: Pick<
      GatewayLaunchResourceAllocationV2,
      "recordRef" | "recordVersion" | "effectRef"
    >,
    unit: GatewayStartupSelectionUnitV2,
    io: GatewayStartupAcceptedOperationV1,
  ): Promise<{
    readonly signal: AbortSignal;
    readonly processTarget: GatewayProcessTargetV1;
    readonly configMapName: string;
    readonly canonicalDocument: string;
    assertCurrent(): undefined;
    release(): Promise<void>;
  }>;
}
