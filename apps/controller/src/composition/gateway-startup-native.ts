import type { PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { GatewayStartupControllerParticipantsV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/controller";
import { createGatewayInstallationServiceAuthorityV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/agent-service";
import { parseGatewayInstallationServiceAssociationV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import {
  createGatewayStartupNativeServiceV2,
  type GatewayStartupNativeServiceOptionsV2,
} from "../admission/gateway-startup-service-context.ts";
import {
  createInstallationServiceRegistrationReaderV2,
  type InstallationServiceRegistrationParticipantsV2,
} from "../admission/installation-service-registration.ts";
import { createControllerGatewayStartupServiceCurrentnessV2 } from "../admission/gateway-startup-service-account.ts";

/** Captures original production owners once. No request or launch descriptor can
 * supply these objects. The actual native service enrolls each original call;
 * the original State independently holds the account, selected IAM, registration,
 * selection and physical process through its transaction and terminal cleanup. */
export function createControllerGatewayStartupNativeServiceV2(
  options: Readonly<{
    state: PostgresPlatformState;
    native: Omit<GatewayStartupNativeServiceOptionsV2, "compose">;
    participants: GatewayStartupControllerParticipantsV2;
    registration: Omit<InstallationServiceRegistrationParticipantsV2, "native">;
  }>,
) {
  const state = options.state;
  const association = parseGatewayInstallationServiceAssociationV2(options.native.association);
  const driverSelection = options.participants.driverSelection;
  const account = options.participants.authority;
  const selection = options.participants.selection;
  const process = options.participants.process;
  const launchResource = options.participants.launchResource;
  const registration = options.registration;
  return createGatewayStartupNativeServiceV2({
    ...options.native,
    association,
    compose(native, registrationNative) {
      const reader = createInstallationServiceRegistrationReaderV2(
        {
          native: registrationNative,
          registry: registration.registry,
          registrar: registration.registrar,
          process: registration.process,
        },
        association,
      );
      const currentness = createControllerGatewayStartupServiceCurrentnessV2({
        account: state.gatewayStartupAccountBindingV1(),
        driverSelection,
        native: registrationNative,
        registration: reader,
      });
      const service = createGatewayInstallationServiceAuthorityV2({ account, native, currentness });
      const owner = state.gatewayStartupControllerOwnerV2({
        driverSelection,
        authority: service.authority,
        selection,
        process,
        launchResource,
      });
      return { service, owner };
    },
  });
}
