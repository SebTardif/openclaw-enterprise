import type {
  ChannelInstallation,
  ChannelHumanBinding,
  ChannelAgentBinding,
  ChannelBindingStatus,
} from "@openclaw-enterprise/contracts/channel-bindings";

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
