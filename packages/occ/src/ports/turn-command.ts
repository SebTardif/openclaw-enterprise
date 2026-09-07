import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import type {
  ChannelAgentBinding,
  ChannelHumanBinding,
  ChannelInstallation,
} from "@openclaw-enterprise/contracts/channel-bindings";

export interface TurnCommandIdentityV1 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly operationRef: string;
}

export interface TurnCommandBoundsV1 {
  readonly signal: AbortSignal;
  readonly deadline: string;
}

export type TurnCommandTerminalV1 =
  "rolled-back" | "commit-rejected" | "commit-unknown" | "committed";

export type TurnCommandOperationV1 =
  "currentness-read" | "journal-read" | "journal-mutation" | "mutation-audit";

declare const ownedUnit: unique symbol;
/** A private owner association, never a transferable authority or SQL capability. */
export interface TurnCommandOwnedUnitV1 extends TurnCommandIdentityV1 {
  readonly [ownedUnit]: true;
}

/** Supplied only by the selected original account/enrollment owner. Structural
 * conformity does not authenticate a participant or its returned lease. */
export interface TurnCommandEnrollmentSourceV1 {
  consume(unit: TurnCommandOwnedUnitV1): Promise<TurnCommandEnrollmentLeaseV1 | undefined>;
}

export interface TurnCommandEnrollmentLeaseV1 {
  prepareCommit(): Promise<void>;
  assertCurrent(): undefined;
  release(outcome: TurnCommandTerminalV1): Promise<void>;
}

export interface TurnCommandAcceptedOperationV1 {
  readonly unit: TurnCommandOwnedUnitV1;
  assertActive(): void;
  /** Tracks a trusted owner's accepted child operation, including unawaited SQL.
   * No connection, query string, transaction control or public repository escapes. */
  track<T>(work: () => Promise<T>): Promise<T>;
}

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
