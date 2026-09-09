import type { GatewayStartupEnrollmentV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  GatewayStartupEnrollmentV2,
  GatewayStartupStartResultV2,
} from "@openclaw-enterprise/contracts/gateway-startup-local-v2";
import type { GatewayStartupConfirmedMaterialFactoryV1 } from "../../../apps/gateway/src/startup-bootstrap.ts";
import type { GatewayStartupConfirmedMaterialFactoryV2 } from "../../../apps/gateway/src/startup-agent-bootstrap.ts";
import type { GatewayStartupServiceSourceV1 } from "../../../apps/gateway/src/startup-service-source.ts";
import type { GatewayMaterialRuntimeOwnerV1 } from "../../../apps/gateway/src/startup-material.ts";
import type { GatewayStartupServiceHandleV2 } from "../../../apps/gateway/src/startup-agent-service-source.ts";
import type { GatewayStartupServiceSourceV2 } from "../../../apps/gateway/src/startup-agent-service-source.ts";

declare const historical: GatewayStartupEnrollmentV1;
declare const agent: GatewayStartupEnrollmentV2;
declare const historicalMaterial: GatewayStartupConfirmedMaterialFactoryV1;
declare const agentMaterial: GatewayStartupConfirmedMaterialFactoryV2;
declare const historicalSource: GatewayStartupServiceSourceV1;
declare const agentSource: GatewayStartupServiceSourceV2;
declare const agentParent: GatewayStartupServiceHandleV2;
declare const runtimeParent: GatewayMaterialRuntimeOwnerV1;
void agentMaterial.bind(agentSource, agentParent, runtimeParent);
// @ts-expect-error The original consumer parent is required for material binding.
void agentMaterial.bind(agentSource, agentParent);

const started: Promise<GatewayStartupStartResultV2> = agent.usePort.start(
  agent.recipient,
  agent.startup,
);
// @ts-expect-error Historical recipient membership cannot enroll an Agent startup.
void agent.usePort.start(historical.recipient, agent.startup);
// @ts-expect-error Agent startup membership cannot be projected into the historical port.
void historical.usePort.start(agent.recipient, agent.startup);
// @ts-expect-error Public metadata cannot create the original Agent handles.
void agent.usePort.start({}, {});
// @ts-expect-error The historical material factory does not consume Agent source/handle authority.
const wrongFactory: GatewayStartupConfirmedMaterialFactoryV2 = historicalMaterial;
// @ts-expect-error The material request retains the original Agent subject and four-field selection.
const wrongSource: GatewayStartupServiceSourceV1 = agentSource;
void [started, agentMaterial, historicalSource, wrongFactory, wrongSource];
