import type {
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecordRefV1,
} from "./gateway-startup-v1.ts";

/** Metadata identifies original selected state; it cannot authenticate a recipient. */
export type GatewayMaterialDeliveryRequestV1 = Readonly<{
  schemaVersion: 1;
  purpose: "read-selected-channel-material";
  use: "startup-slack-pair" | "teams-invocation-token";
  startup: GatewayStartupOperationLocatorV1;
  selection: GatewayStartupRecordRefV1;
  consumedClaim: Readonly<{
    operationRef: string;
    operationDigest: string;
    afterRecordVersion: number;
  }>;
  recipient: GatewayStartupRecordRefV1;
}>;

/** The dedicated binary wire carries selected bytes separately from this header. */
export type GatewayMaterialDeliveryHeaderV1 = Readonly<{
  schemaVersion: 1;
  purpose: "read-selected-channel-material";
  use: GatewayMaterialDeliveryRequestV1["use"];
  requestRef: string;
  kind: "selected-bundle" | "denied" | "unavailable" | "recovery-required";
}>;

/** Delivered means the original bounded write settled, not provider use or physical termination. */
export type GatewayMaterialDeliveryOutcomeV1 = Readonly<{
  kind: "delivered" | "denied" | "unavailable" | "recovery-required";
}>;

/** Only the original local coordinator registers and consumes an exact disclosure. */
declare const disclosureBrand: unique symbol;
export interface GatewayMaterialDisclosurePermitV1 {
  readonly [disclosureBrand]: true;
}
