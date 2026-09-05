import type { Agent } from "@openclaw-enterprise/contracts/resources/agent";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type {
  ChannelInstallation,
  ChannelHumanBinding,
  ChannelAgentBinding,
  ChannelBindingMetadata,
  ChannelBindingStatus,
} from "@openclaw-enterprise/contracts/channel-bindings";
import { isChannelBindingReference } from "@openclaw-enterprise/contracts/channel-bindings";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type {
  MemoryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type {
  ChannelBindingListOptions,
  ChannelBindingRepository,
} from "../../ports/repositories/channel-bindings.ts";
import type { PersistedNamespace } from "../../ports/repositories/namespace.ts";
import { validateChannelBindingList } from "../channel-binding-validation.ts";

/** Live projection of the transaction owner's working snapshot, without copying its maps. */
export interface MemoryChannelBindingSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly channelInstallations: Map<string, Readonly<ChannelInstallation>>;
  readonly channelHumans: Map<string, Readonly<ChannelHumanBinding>>;
  readonly channelAgents: Map<string, Readonly<ChannelAgentBinding>>;
  readonly namespaces: ReadonlyMap<string, Readonly<PersistedNamespace>>;
  readonly agents: ReadonlyMap<string, Readonly<Agent>>;
}

export type MemoryChannelBindingRepositoryContext =
  MemoryRepositoryFactoryContext<MemoryChannelBindingSnapshot>;

/** The owner supplies serialization and the outward transaction lifetime projection. */
export const createMemoryChannelBindingRepository: RepositoryFactory<
  MemoryChannelBindingRepositoryContext,
  ChannelBindingRepository
> = (context) => {
  const { snapshot, transaction } = context;
  const agentKey = (namespaceId: string, agentId: string) => `${namespaceId}\u0000${agentId}`;
  function channelConflict(): never {
    throw new ResourceConflictError(
      "The channel binding conflicts with retained identity, ownership or state.",
    );
  }
  function validateChannelMetadata(record: ChannelBindingMetadata, prefix: string): void {
    const pattern = new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    );
    if (
      !snapshot.installation ||
      record.installationId !== snapshot.installation.id ||
      !pattern.test(record.id) ||
      record.version !== 1 ||
      record.status !== "enabled" ||
      !isChannelBindingReference(record.createdBy) ||
      !isChannelBindingReference(record.updatedBy) ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      record.updatedAt !== record.createdAt ||
      record.updatedBy !== record.createdBy
    )
      channelConflict();
  }
  function channelParent(parentId: string): Readonly<ChannelInstallation> | undefined {
    const parent = snapshot.channelInstallations.get(parentId);
    return parent?.installationId === snapshot.installation?.id ? parent : undefined;
  }
  function childFind<T extends ChannelBindingMetadata & { channelInstallationId: string }>(
    map: Map<string, Readonly<T>>,
    parentId: string,
    id: string,
  ): Readonly<T> | undefined {
    const record = map.get(id);
    return channelParent(parentId) && record?.channelInstallationId === parentId
      ? immutableCopy(record)
      : undefined;
  }
  function channelList<T extends ChannelBindingMetadata>(
    values: Iterable<Readonly<T>>,
    options: ChannelBindingListOptions,
  ): readonly Readonly<T>[] {
    validateChannelBindingList(options);
    return Object.freeze(
      [...values]
        .filter(
          (r) =>
            r.installationId === snapshot.installation?.id &&
            (options.afterId === undefined || r.id > options.afterId),
        )
        .sort((a, b) => {
          if (a.id === b.id) return 0;
          return a.id < b.id ? -1 : 1;
        })
        .slice(0, options.limit)
        .map((r) => immutableCopy(r)),
    );
  }
  function requireChannelParent(
    record: ChannelHumanBinding | ChannelAgentBinding,
  ): Readonly<ChannelInstallation> {
    const parent = channelParent(record.channelInstallationId);
    if (!parent || parent.status !== "enabled" || parent.installationId !== record.installationId)
      channelConflict();
    return parent;
  }
  function requireChannelAgent(record: ChannelAgentBinding, parent: ChannelInstallation): void {
    const namespace = snapshot.namespaces.get(record.namespaceId);
    const agent = snapshot.agents.get(agentKey(record.namespaceId, record.agentId));
    if (
      !namespace ||
      namespace.status !== "ready" ||
      namespace.deletedAt !== undefined ||
      !agent ||
      (parent.platform === "slack"
        ? record.scopeKind !== "slack-private-channel"
        : record.scopeKind !== "msteams-standard-channel")
    )
      channelConflict();
  }
  function changeChannelStatus<T extends ChannelBindingMetadata>(
    map: Map<string, Readonly<T>>,
    record: Readonly<T> | undefined,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
  ): Readonly<T> | undefined {
    if (!record) return undefined;
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 ||
      record.version !== expectedVersion ||
      (status !== "enabled" && status !== "disabled") ||
      !isChannelBindingReference(actorId) ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      Date.parse(updatedAt) < Date.parse(record.createdAt)
    )
      channelConflict();
    if (record.status === status) return immutableCopy(record);
    if (record.version === Number.MAX_SAFE_INTEGER) channelConflict();
    const updated = immutableCopy({
      ...record,
      status,
      version: record.version + 1,
      updatedBy: actorId,
      updatedAt,
    });
    map.set(record.id, updated);
    return immutableCopy(updated);
  }
  const channelBindings: ChannelBindingRepository = {
    findChannelInstallation: async (id) => {
      const parent = channelParent(id);
      return parent && immutableCopy(parent);
    },
    listChannelInstallations: async (options) =>
      channelList(snapshot.channelInstallations.values(), options),
    findHumanBinding: async (parentId, id) => childFind(snapshot.channelHumans, parentId, id),
    findHumanBindingBySubject: async (parentId, subject) => {
      const found = [...snapshot.channelHumans.values()].find(
        (r) => r.channelInstallationId === parentId && r.providerSubjectRef === subject,
      );
      return found && childFind(snapshot.channelHumans, parentId, found.id);
    },
    listHumanBindings: async (parentId, options) =>
      channelList(
        [...snapshot.channelHumans.values()].filter(
          (r) => !!channelParent(parentId) && r.channelInstallationId === parentId,
        ),
        options,
      ),
    findAgentBinding: async (parentId, id) => childFind(snapshot.channelAgents, parentId, id),
    findAgentBindingByChannel: async (parentId, channelRef) => {
      const found = [...snapshot.channelAgents.values()].find(
        (r) => r.channelInstallationId === parentId && r.channelRef === channelRef,
      );
      return found && childFind(snapshot.channelAgents, parentId, found.id);
    },
    listAgentBindings: async (parentId, options) =>
      channelList(
        [...snapshot.channelAgents.values()].filter(
          (r) => !!channelParent(parentId) && r.channelInstallationId === parentId,
        ),
        options,
      ),
    createChannelInstallation: async (record) => {
      validateChannelMetadata(record, "chi");
      if (
        (record.platform !== "slack" && record.platform !== "msteams") ||
        !isChannelBindingReference(record.providerTenantRef) ||
        !isChannelBindingReference(record.recipientAppRef) ||
        snapshot.channelInstallations.has(record.id) ||
        [...snapshot.channelInstallations.values()].some(
          (r) =>
            r.installationId === record.installationId &&
            r.platform === record.platform &&
            r.providerTenantRef === record.providerTenantRef &&
            r.recipientAppRef === record.recipientAppRef,
        )
      )
        channelConflict();
      snapshot.channelInstallations.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    createHumanBinding: async (record) => {
      validateChannelMetadata(record, "chh");
      requireChannelParent(record);
      if (
        ![
          record.providerSubjectRef,
          record.iamDriverId,
          record.principalId,
          record.principalIssuer,
          record.principalSubject,
        ].every(isChannelBindingReference) ||
        snapshot.channelHumans.has(record.id) ||
        [...snapshot.channelHumans.values()].some(
          (r) =>
            r.channelInstallationId === record.channelInstallationId &&
            r.providerSubjectRef === record.providerSubjectRef,
        )
      )
        channelConflict();
      snapshot.channelHumans.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    createAgentBinding: async (record) => {
      validateChannelMetadata(record, "cha");
      const parent = requireChannelParent(record);
      requireChannelAgent(record, parent);
      if (
        !isChannelBindingReference(record.channelRef) ||
        snapshot.channelAgents.has(record.id) ||
        [...snapshot.channelAgents.values()].some(
          (r) =>
            r.channelInstallationId === record.channelInstallationId &&
            r.channelRef === record.channelRef,
        )
      )
        channelConflict();
      snapshot.channelAgents.set(record.id, immutableCopy(record));
      return immutableCopy(record);
    },
    setChannelInstallationStatus: async (id, version, status, actor, at) =>
      changeChannelStatus(
        snapshot.channelInstallations,
        channelParent(id),
        version,
        status,
        actor,
        at,
      ),
    setHumanBindingStatus: async (parentId, id, version, status, actor, at) => {
      const record = childFind(snapshot.channelHumans, parentId, id);
      if (record && status === "enabled" && record.status !== status) requireChannelParent(record);
      return changeChannelStatus(snapshot.channelHumans, record, version, status, actor, at);
    },
    setAgentBindingStatus: async (parentId, id, version, status, actor, at) => {
      const record = childFind(snapshot.channelAgents, parentId, id);
      if (record && status === "enabled" && record.status !== status)
        requireChannelAgent(record, requireChannelParent(record));
      return changeChannelStatus(snapshot.channelAgents, record, version, status, actor, at);
    },
  };

  for (const key of Object.keys(channelBindings) as (keyof ChannelBindingRepository)[]) {
    const method = channelBindings[key];
    Object.defineProperty(channelBindings, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        // The getter stays live across same-unit Installation bootstrap.
        const installation = snapshot.installation;
        if (installation && context.scope.installationId !== installation.id)
          throw new ScopeViolationError(
            "The resource does not belong to the server-owned Installation.",
          );
        const result = await Reflect.apply(method, channelBindings, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(channelBindings);
};
