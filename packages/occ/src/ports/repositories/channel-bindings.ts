import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type {
  ChannelInstallation,
  ChannelHumanBinding,
  ChannelAgentBinding,
  ChannelBindingStatus,
} from "@openclaw-enterprise/contracts/channel-bindings";

/** One prepared first-create attempt; these references are retained through uncertainty. */
export interface PreparedReservedChannelInstallationV1 {
  readonly record: Readonly<ChannelInstallation>;
  readonly creationOperationRef: string;
  readonly reservationRef: string;
  readonly audit: Readonly<AuditEvent>;
}
export interface ReservedChannelInstallationCurrentnessV1 {
  assertSelectedIAM(): undefined;
}
export interface ReservedChannelInstallationLocatorV1 {
  readonly channelInstallationRef: string;
  readonly creationOperationRef: string;
  readonly reservationRef: string;
  readonly originalTransactionRef: string;
}
export type ReservedChannelInstallationProvisionalV1 =
  | Readonly<{
      kind: "created-provisional";
      record: Readonly<ChannelInstallation>;
      locator: ReservedChannelInstallationLocatorV1;
    }>
  | Readonly<{
      kind: "recovery-required";
      reason:
        "original-association-unavailable" | "existing-reservation" | "reservation-unavailable";
    }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "capacity-exhausted" }>;

export interface ChannelBindingListOptions {
  readonly afterId?: string;
  readonly limit: number;
}

export interface ChannelBindingReadRepository {
  findChannelInstallation(id: string): Promise<Readonly<ChannelInstallation> | undefined>;
  listChannelInstallations(
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelInstallation>[]>;
  findHumanBinding(
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  findHumanBindingBySubject(
    parentId: string,
    subject: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  listHumanBindings(
    parentId: string,
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelHumanBinding>[]>;
  findAgentBinding(
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
  findAgentBindingByChannel(
    parentId: string,
    channelRef: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
  listAgentBindings(
    parentId: string,
    options: ChannelBindingListOptions,
  ): Promise<readonly Readonly<ChannelAgentBinding>[]>;
}

export interface ChannelBindingRepository extends ChannelBindingReadRepository {
  /** Provisional until the original enclosing transaction commits. */
  createReservedChannelInstallation(
    prepared: PreparedReservedChannelInstallationV1,
    currentness: ReservedChannelInstallationCurrentnessV1,
  ): Promise<ReservedChannelInstallationProvisionalV1>;
  createChannelInstallation(record: ChannelInstallation): Promise<Readonly<ChannelInstallation>>;
  createHumanBinding(record: ChannelHumanBinding): Promise<Readonly<ChannelHumanBinding>>;
  createAgentBinding(record: ChannelAgentBinding): Promise<Readonly<ChannelAgentBinding>>;
  setChannelInstallationStatus(
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelInstallation> | undefined>;
  setHumanBindingStatus(
    parentId: string,
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelHumanBinding> | undefined>;
  setAgentBindingStatus(
    parentId: string,
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Promise<Readonly<ChannelAgentBinding> | undefined>;
}
