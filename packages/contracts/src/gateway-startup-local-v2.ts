import type {
  GatewayStartupLifetimeV1,
  GatewayStartupOperationLocatorV2,
} from "./gateway-startup-v1.ts";

/** Distinct private local membership for the original Agent/V2 bootstrap. The
 * brands and serialized locators never authenticate or enroll a recipient. */
declare const recipientBrandV2: unique symbol;
declare const startupBrandV2: unique symbol;
export interface GatewayStartupRecipientV2 {
  readonly [recipientBrandV2]: true;
}
export interface GatewayStartupHandleV2 {
  readonly [startupBrandV2]: true;
}
export type GatewayStartupStartResultV2 =
  | Readonly<{ kind: "started"; lifetime: GatewayStartupLifetimeV1 }>
  | Readonly<{ kind: "denied" | "unavailable" }>
  | Readonly<{ kind: "recovery-required"; operation: GatewayStartupOperationLocatorV2 }>;
export interface GatewayStartupUsePortV2 {
  start(
    recipient: GatewayStartupRecipientV2,
    startup: GatewayStartupHandleV2,
  ): Promise<GatewayStartupStartResultV2>;
}
export type GatewayStartupEnrollmentV2 = Readonly<{
  usePort: GatewayStartupUsePortV2;
  recipient: GatewayStartupRecipientV2;
  startup: GatewayStartupHandleV2;
}>;
