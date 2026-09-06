import type { GatewayStartupEnrollmentV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";

/** Only the protected bootstrap owner may supply the original local enrollment. */
export function requireAdmittedGatewayConfiguration(): GatewayStartupEnrollmentV1 {
  // TODO: Connect the genuine authenticated startup bootstrap and its prebound
  // configuration/material owners. Parsed JSON, argv, environment variables and
  // caller-provided objects cannot enroll a recipient or manufacture its handles.
  throw new Error("Hosted gateway admitted startup is unavailable");
}
