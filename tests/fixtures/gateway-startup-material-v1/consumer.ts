import type { GatewayCompositionInput } from "../../../apps/gateway/src/composition.ts";
import {
  createGatewayStartupMaterialBorrowerV1,
  type GatewayMaterialRuntimeOwnerV1,
  type GatewayMaterialSelectionV1,
  type GatewayMaterialSourceV1,
} from "../../../apps/gateway/src/startup-material.ts";

/** Original Runtime owns the confirmed claim and this consumer-settlement join.
 * This compile-only example cannot create either from a serialized selection. */
export function attachAfterOriginalClaim(
  owner: GatewayMaterialRuntimeOwnerV1,
  selected: GatewayMaterialSelectionV1,
  protectedSource: GatewayMaterialSourceV1,
): Readonly<{
  borrowMaterial(): Promise<
    Readonly<{
      input: GatewayCompositionInput;
      assertCurrent(): undefined;
      close(): Promise<"finished" | "failed" | "unknown">;
    }>
  >;
  close(): Promise<"finished" | "failed" | "unknown">;
}> {
  return createGatewayStartupMaterialBorrowerV1(owner, selected, protectedSource);
}

// @ts-expect-error An asynchronous currentness result cannot replace the original fence.
const asyncFence: GatewayMaterialRuntimeOwnerV1["assertCurrent"] = async () => undefined;
void asyncFence;
// @ts-expect-error A caller readiness flag is not actual consumer settlement.
const readyFlag: GatewayMaterialRuntimeOwnerV1["joinConsumers"] = async () => true;
void readyFlag;
