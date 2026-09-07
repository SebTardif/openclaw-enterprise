import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import type {
  ChannelAgentBinding,
  ChannelHumanBinding,
  ChannelInstallation,
} from "@openclaw-enterprise/contracts/channel-bindings";
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
} from "./turn-command-scope.ts";

export interface TurnCommandChannelLocatorV1 {
  readonly parentId: string;
  readonly providerSubjectRef: string;
  readonly channelRef: string;
}

/** Locator observations are not current authority. The genuine participant must
 * compare its original source, account and binding identities after locking. */
export interface TurnCommandChannelSnapshotV1 {
  readonly parent: Readonly<ChannelInstallation> | undefined;
  readonly human: Readonly<ChannelHumanBinding> | undefined;
  readonly agent: Readonly<ChannelAgentBinding> | undefined;
}

/** Private same-client participant IO. This is not a caller-supplied unit, an
 * account-state producer, a raw query capability or the journal claim identity. */
export interface TurnCommandAccountUnitV1 {
  readonly token: TurnCommandOwnedUnitV1;
  readonly identity: TurnCommandIdentityV1;
  readonly bounds: TurnCommandBoundsV1;
  readonly iam: NativeIAMTransactionView;
  assertActive(): void;
  /** Single original account/security writer cleanup, retained before acquisition
   * resolves. The central terminal owner invokes it once; callers never release it. */
  retainSecurityCleanup(release: (outcome: TurnCommandTerminalV1) => Promise<void>): void;
  locateChannel(input: TurnCommandChannelLocatorV1): Promise<TurnCommandChannelSnapshotV1>;
  /** The genuine source must already hold account/security/registration guards. */
  lockPolicy(): Promise<void>;
  lockParentsAndReload(): Promise<TurnCommandChannelSnapshotV1>;
  readLockedChannel(): Promise<TurnCommandChannelSnapshotV1>;
}

export interface TurnCommandAccountLeaseV1 {
  prepareCommit(unit: TurnCommandAccountUnitV1): Promise<void>;
  /** Retained writer/selection guards; must not use expired acquisition IO. */
  assertCurrent(): undefined;
  release(outcome: TurnCommandTerminalV1): Promise<void>;
}

export interface TurnCommandAccountSourceV1 {
  consume(unit: TurnCommandAccountUnitV1): Promise<TurnCommandAccountLeaseV1 | undefined>;
}

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
