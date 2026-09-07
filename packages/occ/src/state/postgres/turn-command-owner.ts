import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import { isChannelBindingReference } from "@openclaw-enterprise/contracts/channel-bindings";
import { DependencyUnavailableError } from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import { createPostgresChannelBindingRepository } from "./channel-bindings.ts";
import type {
  TurnCommandBoundsV1,
  TurnCommandIdentityV1,
  TurnCommandOwnedUnitV1,
  TurnCommandTerminalV1,
} from "../../ports/turn-command.ts";

import type {
  TurnCommandChannelLocatorV1,
  TurnCommandChannelSnapshotV1,
  TurnCommandAccountUnitV1,
  TurnCommandAccountLeaseV1,
  TurnCommandAccountSourceV1,
} from "../../ports/turn-command.ts";
export type {
  TurnCommandChannelLocatorV1,
  TurnCommandChannelSnapshotV1,
  TurnCommandAccountUnitV1,
  TurnCommandAccountLeaseV1,
  TurnCommandAccountSourceV1,
} from "../../ports/turn-command.ts";

export interface TurnCommandAccountContextV1 extends QueryRepositoryFactoryContext {
  readonly token: TurnCommandOwnedUnitV1;
  readonly identity: TurnCommandIdentityV1;
  readonly bounds: TurnCommandBoundsV1;
  readonly iam: NativeIAMTransactionView;
  currentInstallation(): Promise<Readonly<Installation> | undefined>;
  retainSecurityCleanup: TurnCommandAccountUnitV1["retainSecurityCleanup"];
  recordParentsLocked(): void;
  lockPolicy(): Promise<void>;
}

/** Borrows only an exact active enrollment/currentness callback's tracked IO.
 * The central owner owns token recognition, selection, poison and terminal drain.
 * TODO(turn account composition): connect the original native-channel producer
 * and its real account/security writer guards. These reads supply no such grant.
 */
export function createTurnCommandAccountUnitV1(
  context: TurnCommandAccountContextV1,
): TurnCommandAccountUnitV1 {
  const repository = createPostgresChannelBindingRepository(context);
  let locator: Readonly<TurnCommandChannelLocatorV1> | undefined;
  let policyStarted = false;
  let policyLocked = false;
  let parentsStarted = false;
  let parentsLocked = false;
  const unavailable = () => new DependencyUnavailableError("The turn account unit is unavailable.");
  const assertActive = () => context.transaction.assertActive();
  const read = async (): Promise<TurnCommandChannelSnapshotV1> => {
    assertActive();
    if (locator === undefined) throw unavailable();
    const parent = await repository.findChannelInstallation(locator.parentId);
    const human = await repository.findHumanBindingBySubject(
      locator.parentId,
      locator.providerSubjectRef,
    );
    const agent = await repository.findAgentBindingByChannel(locator.parentId, locator.channelRef);
    assertActive();
    return Object.freeze({ parent, human, agent });
  };
  return Object.freeze({
    token: context.token,
    identity: context.identity,
    bounds: context.bounds,
    iam: context.iam,
    assertActive,
    retainSecurityCleanup: context.retainSecurityCleanup,
    locateChannel: async (input: TurnCommandChannelLocatorV1) => {
      assertActive();
      if (locator !== undefined || policyStarted || parentsStarted) throw unavailable();
      const captured = Object.freeze({
        parentId: input.parentId,
        providerSubjectRef: input.providerSubjectRef,
        channelRef: input.channelRef,
      });
      if (!Object.values(captured).every(isChannelBindingReference)) throw unavailable();
      locator = captured;
      return read();
    },
    lockPolicy: async () => {
      assertActive();
      if (locator === undefined || policyStarted || parentsStarted) throw unavailable();
      policyStarted = true;
      await context.lockPolicy();
      assertActive();
      policyLocked = true;
    },
    lockParentsAndReload: async () => {
      assertActive();
      if (locator === undefined || !policyLocked || parentsStarted) throw unavailable();
      parentsStarted = true;
      const { installationId, namespaceId, agentId } = context.identity;
      // One original Installation journal lock, then the exact channel parent,
      // Namespace and Agent. Existing binding writers lock the same parent.
      await context.query.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `turn-journal-admission:${installationId}`,
      ]);
      const parent = await context.query.query(
        "SELECT id FROM occ.channel_installations WHERE installation_id=$1 AND id=$2 FOR UPDATE",
        [installationId, locator.parentId],
      );
      if (parent.rowCount !== 1) throw unavailable();
      const namespace = await context.query.query(
        "SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE",
        [namespaceId],
      );
      if (namespace.rowCount !== 1) throw unavailable();
      const agent = await context.query.query(
        "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
        [namespaceId, agentId],
      );
      if (agent.rowCount !== 1) throw unavailable();
      const result = await read();
      if (
        result.parent?.status !== "enabled" ||
        result.human?.status !== "enabled" ||
        result.agent?.status !== "enabled" ||
        result.agent.namespaceId !== namespaceId ||
        result.agent.agentId !== agentId
      )
        throw unavailable();
      assertActive();
      parentsLocked = true;
      context.recordParentsLocked();
      return result;
    },
    readLockedChannel: async () => {
      assertActive();
      if (!parentsLocked) throw unavailable();
      return read();
    },
  });
}
