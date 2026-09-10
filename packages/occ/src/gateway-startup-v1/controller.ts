import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import type { DriverSelection } from "../application/driver-selection.ts";
import type {
  GatewayStartupOwnerParticipantsV1,
  GatewayStartupOwnerParticipantsV2,
  createGatewayStartupOwnerV1,
  createGatewayStartupOwnerV2,
} from "./owner.ts";
import type { RuntimeCredentialSelectionResolverV2 } from "../workload-profiles/credential-record.ts";
import type { GatewayLaunchResourceSourceV2 } from "./launch-resource.ts";

/** Borrowed only in the original account callback. This supplies the same-client
 * policy view, never a caller, account, registration or purpose grant. */
export interface GatewayStartupControllerPolicyV1 {
  lockPolicy(): Promise<void>;
  readonly iam: NativeIAMTransactionView;
}

/** Trusted Controller composition supplies original producers. Request JSON
 * cannot install one, and this port has no authority-handle constructor. */
export interface GatewayStartupControllerParticipantsV1 extends Omit<
  GatewayStartupOwnerParticipantsV1,
  "authority" | "audit" | "allocate"
> {
  readonly driverSelection: DriverSelection;
  readonly authority: {
    consume(
      ...args: [
        ...Parameters<GatewayStartupOwnerParticipantsV1["authority"]["consume"]>,
        policy: GatewayStartupControllerPolicyV1,
      ]
    ): ReturnType<GatewayStartupOwnerParticipantsV1["authority"]["consume"]>;
  };
}

export type GatewayStartupControllerOwnerV1 = ReturnType<typeof createGatewayStartupOwnerV1>;

/** Agent startup retains exact V2 subject, selected credential owner and original
 * launch source. The same private account/IAM unit remains mandatory. */
export interface GatewayStartupControllerParticipantsV2 extends Omit<
  GatewayStartupOwnerParticipantsV2,
  "authority" | "selection" | "audit" | "allocate"
> {
  readonly driverSelection: DriverSelection;
  readonly selection: RuntimeCredentialSelectionResolverV2;
  readonly launchResource: GatewayLaunchResourceSourceV2;
  readonly authority: {
    consume(
      ...args: [
        ...Parameters<GatewayStartupOwnerParticipantsV2["authority"]["consume"]>,
        policy: GatewayStartupControllerPolicyV1,
      ]
    ): ReturnType<GatewayStartupOwnerParticipantsV2["authority"]["consume"]>;
  };
}
export type GatewayStartupControllerOwnerV2 = ReturnType<typeof createGatewayStartupOwnerV2>;
