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

import type { GatewayMaterialDeliveryRequestV2 } from "@openclaw-enterprise/contracts/gateway-material-delivery-v2";
import {
  createGatewayMaterialDeliveryV2,
  parseGatewayMaterialDeliveryRequestV2,
  type GatewayMaterialDeliveryCurrentOwnerV2,
  type GatewayMaterialNativeSourceV2,
  type GatewayMaterialSelectedSourceV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import type { GatewayStartupServiceSourceV2 } from "../../../apps/gateway/src/startup-agent-service-source.ts";
import {
  createGatewayChannelMaterialClientV2,
  type GatewayChannelMaterialClientOptionsV2,
} from "../../../apps/gateway/src/channel-material-client.ts";
import {
  createChannelMaterialNativeServiceV2,
  type ChannelMaterialNativeServiceOptionsV2,
} from "../../../apps/controller/src/admission/channel-material-service-context.ts";

declare const agentNative: GatewayMaterialNativeSourceV2;
declare const agentCurrent: GatewayMaterialDeliveryCurrentOwnerV2<{ selectedVersion: number }>;
declare const agentSelected: GatewayMaterialSelectedSourceV2<{ selectedVersion: number }>;
declare const agentSource: GatewayStartupServiceSourceV2;
declare const agentOptions: GatewayChannelMaterialClientOptionsV2;
declare const agentServiceOptions: ChannelMaterialNativeServiceOptionsV2;
const agentMaterial = createGatewayMaterialDeliveryV2({
  native: agentNative,
  current: agentCurrent,
  source: agentSelected,
});
const agentRequest: GatewayMaterialDeliveryRequestV2 = parseGatewayMaterialDeliveryRequestV2({});
void createGatewayChannelMaterialClientV2(agentSource, agentOptions);
void createChannelMaterialNativeServiceV2(agentServiceOptions);
// @ts-expect-error Agent request does not project into the historical request.
const wrongRequest: GatewayMaterialDeliveryRequestV1 = agentRequest;
// @ts-expect-error Native association retains the full Agent startup locator.
const wrongNative: GatewayMaterialNativeSourceV2 = native;
// @ts-expect-error A historical current-state owner cannot supply the Agent current scope.
createGatewayMaterialDeliveryV2({ native: agentNative, current, source: agentSelected });
// @ts-expect-error A historical selected-source scope cannot replace an Agent source scope.
createGatewayMaterialDeliveryV2({ native: agentNative, current: agentCurrent, source });
void [agentMaterial, wrongRequest, wrongNative];
