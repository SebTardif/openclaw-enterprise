import type { LocalAccountSecurityRecordV1 } from "../account-authority/local-account-security.ts";
import type {
  GatewayStartupAcceptedOperationV1,
  GatewayStartupCommandBoundsV1,
  GatewayStartupOwnerUnitV1,
  GatewayStartupOwnerUnitV2,
} from "./owner.ts";

/** Current account attribution for the exact command's retained acceptance.
 * This is not native registration, delegation, process ownership or permission.
 * The original service authority must acquire every independent predicate. */
export interface GatewayStartupAccountBindingLeaseV1 {
  readonly account: Readonly<LocalAccountSecurityRecordV1>;
  readonly principalId: string;
  assertCurrent(): undefined;
  release(): void;
}

export interface GatewayStartupAccountBindingReaderV1 {
  /** The original state derives the startup locator from its current command.
   * There is no caller-supplied account ID or reusable observation handle. */
  lock(
    unit: GatewayStartupOwnerUnitV1 | GatewayStartupOwnerUnitV2,
    io: GatewayStartupAcceptedOperationV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayStartupAccountBindingLeaseV1 | undefined>;
}
