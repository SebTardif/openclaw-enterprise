import type { GatewayStartupOperationLocatorV2 } from "./gateway-startup-v1.ts";
import type { GatewayMaterialDeliveryRequestV1 } from "./gateway-material-delivery-v1.ts";
import type { WorkloadProfileSelectionV1 } from "./workload-profile-v1.ts";

/** Exact Agent metadata from the original confirmed startup. Neither these
 * serialized operands nor a decoded request authenticates a material recipient. */
export type GatewayMaterialDeliveryRequestV2 = Readonly<
  Omit<GatewayMaterialDeliveryRequestV1, "schemaVersion" | "startup" | "selection"> & {
    schemaVersion: 2;
    startup: GatewayStartupOperationLocatorV2;
    selection: WorkloadProfileSelectionV1;
  }
>;
