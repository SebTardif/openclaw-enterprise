import { prepareGatewayComposition } from "./composition.ts";
import {
  createGatewayStartupBootstrapV2,
  type GatewayStartupConfirmedMaterialFactoryV2,
} from "./startup-agent-bootstrap.ts";
import { createGatewayStartupServiceSourceV2 } from "./startup-agent-service-source.ts";
import {
  createGatewayStartupNativeClientV2,
  type GatewayStartupNativeClientOptionsV2,
} from "./startup-native-client.ts";

/** Trusted fixed composition: the actual native client owns the connection,
 * the Agent Source requires its confirmed durable consume, and the original
 * material factory retains configuration/module/path/currentness ownership.
 * Mounted expectations alone cannot supply that factory or a local enrollment. */
export function createAdmittedGatewayConfigurationV2(
  native: GatewayStartupNativeClientOptionsV2,
  material: GatewayStartupConfirmedMaterialFactoryV2,
) {
  const service = createGatewayStartupServiceSourceV2(createGatewayStartupNativeClientV2(native));
  return createGatewayStartupBootstrapV2(
    service,
    material,
    Object.freeze({ prepare: prepareGatewayComposition }),
  );
}
