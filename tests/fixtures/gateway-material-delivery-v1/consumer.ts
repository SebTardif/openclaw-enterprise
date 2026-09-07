import type {
  GatewayMaterialDeliveryRequestV1,
  GatewayMaterialDeliveryHeaderV1,
  GatewayMaterialDisclosurePermitV1,
} from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import {
  createGatewayMaterialDeliveryV1,
  parseGatewayMaterialDeliveryRequestV1,
  type GatewayMaterialDeliveryCurrentOwnerV1,
  type GatewayMaterialNativeSourceV1,
  type GatewayMaterialSelectedSourceV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import type { GatewayStartupCommandV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/owner";

declare const native: GatewayMaterialNativeSourceV1;
declare const current: GatewayMaterialDeliveryCurrentOwnerV1<{ selectedVersion: number }>;
declare const source: GatewayMaterialSelectedSourceV1<{ selectedVersion: number }>;
const material = createGatewayMaterialDeliveryV1({ native, current, source });
const parsed: GatewayMaterialDeliveryRequestV1 = parseGatewayMaterialDeliveryRequestV1({});
void material;
void parsed;
// @ts-expect-error material purpose is not a fourth startup command
const oldCommand: GatewayStartupCommandV1 = parsed;
// @ts-expect-error private disclosure permit cannot be constructed from metadata
const permit: GatewayMaterialDisclosurePermitV1 = {};
// @ts-expect-error closed purpose use prevents arbitrary credential reads
const invalidUse: GatewayMaterialDeliveryRequestV1["use"] = "read-any-secret";
const secretHeader: GatewayMaterialDeliveryHeaderV1 = {
  schemaVersion: 1,
  purpose: "read-selected-channel-material",
  use: "startup-slack-pair",
  requestRef: "r",
  kind: "selected-bundle",
  // @ts-expect-error response metadata has no secret payload slot
  secret: "forbidden",
};
declare const unrelated: GatewayMaterialSelectedSourceV1<{ unrelated: string }>;
// @ts-expect-error current selected source must match the exact original source type
createGatewayMaterialDeliveryV1({ native, current, source: unrelated });
const oldProfile: Awaited<ReturnType<GatewayMaterialNativeSourceV1["inspect"]>> = {
  // @ts-expect-error old profile cannot enroll as material transport
  profile: "installation-startup-v1",
};
void oldCommand;
void permit;
void invalidUse;
void secretHeader;
void oldProfile;
