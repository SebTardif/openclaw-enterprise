import {
  PostgresPlatformState,
  type PostgresPool,
} from "../../../packages/occ/src/state/postgres-state.ts";
import {
  GatewayStartupOwnerPhaseV1,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupCommandV1,
  type GatewayStartupCompletionV1,
  type GatewayStartupOwnerUnitV1,
  type GatewayStartupTransactionOwnerV1,
  type GatewayStartupTransactionResultV1,
} from "../../../packages/occ/src/gateway-startup-v1/owner.ts";
import { RepositoryTransactionLifetime } from "../../../packages/occ/src/ports/transaction.ts";
import {
  gatewayStartupHeads,
  gatewayStartupOperations,
  installation,
  auditEvents,
} from "../../../packages/occ/src/state/postgres-schema.ts";

/** Type correspondence only. This fixture constructs no accepting producer. */
export function consume(
  pool: PostgresPool,
  transaction: GatewayStartupTransactionOwnerV1,
  command: GatewayStartupCommandV1,
  bounds: GatewayStartupCommandBoundsV1,
  work: (unit: GatewayStartupOwnerUnitV1) => Promise<GatewayStartupCompletionV1>,
): Promise<GatewayStartupTransactionResultV1> {
  const state = new PostgresPlatformState(pool);
  // @ts-expect-error The private producer join is not public configuration.
  state.bindGatewayStartupOwnersV1();
  // @ts-expect-error A public token map or caller-set currentness is not exposed.
  state.gatewayContexts;
  return transaction.run(command, bounds, work);
}

export function inspectUnit(unit: GatewayStartupOwnerUnitV1): void {
  // @ts-expect-error The public opaque identity is not a lock or authority facade.
  unit.policy.lockPolicy();
  // @ts-expect-error A caller cannot replace the original transaction phase.
  unit.phase = new GatewayStartupOwnerPhaseV1(new RepositoryTransactionLifetime(), async () => ({
    rows: [],
    rowCount: 0,
  }));
}

export const registeredTables = {
  installation,
  auditEvents,
  gatewayStartupHeads,
  gatewayStartupOperations,
};

// The Agent native receiver/authority requires the original Controller policy
// argument and cannot be installed as a standalone five-argument Runtime port.
import {
  createGatewayInstallationServiceAuthorityV2,
  type GatewayInstallationNativeSourceV2,
} from "../../../packages/occ/src/gateway-startup-v1/agent-service.ts";
import type { GatewayStartupControllerParticipantsV2 } from "../../../packages/occ/src/gateway-startup-v1/controller.ts";
import type { GatewayStartupOwnerParticipantsV2 } from "../../../packages/occ/src/gateway-startup-v1/owner.ts";
declare const agentAccount: GatewayStartupControllerParticipantsV2["authority"];
declare const agentNative: GatewayInstallationNativeSourceV2;
const agentService = createGatewayInstallationServiceAuthorityV2({
  account: agentAccount,
  native: agentNative,
});
const controllerAgentAuthority: GatewayStartupControllerParticipantsV2["authority"] =
  agentService.authority;
// @ts-expect-error The original Controller policy view cannot be omitted.
const standaloneAgentAuthority: GatewayStartupOwnerParticipantsV2["authority"] =
  agentService.authority;
void [controllerAgentAuthority, standaloneAgentAuthority];
