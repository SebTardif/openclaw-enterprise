import type {
  ChannelBindingMetadata,
  ChannelBindingStatus,
} from "@openclaw-enterprise/contracts/channel-bindings";
import { isChannelBindingReference } from "@openclaw-enterprise/contracts/channel-bindings";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type {
  ChannelBindingListOptions,
  ChannelBindingRepository,
} from "../../ports/repositories/channel-bindings.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import { validateChannelBindingList } from "../channel-binding-validation.ts";
import {
  channelInstallationFromRow,
  channelHumanFromRow,
  channelAgentFromRow,
  rows,
  type PostgresChannelBindingRow,
} from "./channel-binding-rows.ts";

export interface PostgresChannelBindingRepositoryContext extends QueryRepositoryFactoryContext {
  currentInstallation(): Promise<Readonly<Installation> | undefined>;
}

/** Borrows the owner's guarded query and live Installation lookup without opening a transaction. */
export function createPostgresChannelBindingRepository(
  context: PostgresChannelBindingRepositoryContext,
): ChannelBindingRepository {
  async function withinTransaction<T>(work: () => Promise<T>): Promise<T> {
    context.transaction.assertActive();
    const result = await work();
    context.transaction.assertActive();
    return result;
  }

  async function currentInstallation(): Promise<Readonly<Installation> | undefined> {
    context.transaction.assertActive();
    const installation = await context.currentInstallation();
    context.transaction.assertActive();
    // Scope stays lazy so an empty store can be bootstrapped in this same unit of work.
    if (installation !== undefined && context.scope.installationId !== installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    return installation;
  }

  type ChannelTable = "channel_installations" | "channel_human_bindings" | "channel_agent_bindings";
  const channelConflict = (): never => {
    throw new ResourceConflictError(
      "The channel binding conflicts with retained identity, ownership or state.",
    );
  };
  const channelQuery = async (sql: string, values: unknown[]) => {
    try {
      return await context.query.query(sql, values);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (
        typeof code === "string" &&
        (code.startsWith("23") || code === "55000" || code.startsWith("22"))
      )
        channelConflict();
      throw error;
    }
  };
  const channelFind = <T>(
    table: ChannelTable,
    decode: (row: PostgresChannelBindingRow) => Readonly<T>,
    key: "id" | "provider_subject_ref" | "channel_ref",
    value: string,
    parentId?: string,
    lock = false,
  ): Promise<Readonly<T> | undefined> =>
    withinTransaction(async () => {
      const installation = await currentInstallation();
      if (
        !installation ||
        !isChannelBindingReference(value) ||
        (parentId !== undefined && !isChannelBindingReference(parentId))
      )
        return undefined;
      const result = await context.query.query(
        `SELECT * FROM occ.${table} WHERE installation_id = $1 AND ${key} = $2${parentId === undefined ? "" : " AND channel_installation_id = $3"}${lock ? " FOR UPDATE" : ""}`,
        parentId === undefined ? [installation.id, value] : [installation.id, value, parentId],
      );
      const row = rows(result.rows)[0];
      return row && decode(row);
    });
  const channelList = <T>(
    table: ChannelTable,
    decode: (row: PostgresChannelBindingRow) => Readonly<T>,
    options: ChannelBindingListOptions,
    parentId?: string,
  ): Promise<readonly Readonly<T>[]> =>
    withinTransaction(async () => {
      validateChannelBindingList(options);
      const installation = await currentInstallation();
      if (!installation) return Object.freeze([]);
      const result = await context.query.query(
        `SELECT * FROM occ.${table} WHERE installation_id = $1 AND ($2::text IS NULL OR id COLLATE "C" > $2 COLLATE "C")${parentId === undefined ? "" : " AND channel_installation_id = $4"} ORDER BY id COLLATE "C" LIMIT $3`,
        parentId === undefined
          ? [installation.id, options.afterId ?? null, options.limit]
          : [installation.id, options.afterId ?? null, options.limit, parentId],
      );
      return Object.freeze(rows(result.rows).map(decode));
    });
  const lockChannelParent = async (id: string) =>
    channelFind("channel_installations", channelInstallationFromRow, "id", id, undefined, true);
  const channelCreate = <T extends ChannelBindingMetadata>(
    table: ChannelTable,
    decode: (row: PostgresChannelBindingRow) => Readonly<T>,
    record: T,
    additional: readonly [string, unknown][],
  ): Promise<Readonly<T>> =>
    withinTransaction(async () => {
      const installation = await currentInstallation();
      if (!installation || record.installationId !== installation.id) channelConflict();
      // Reject malformed Unicode before the PostgreSQL client can replace its bytes.
      if (
        ![record.createdBy, record.updatedBy, ...additional.map(([, value]) => value)].every(
          isChannelBindingReference,
        )
      )
        channelConflict();
      if ("channelInstallationId" in record) {
        const parent = await lockChannelParent(String(record.channelInstallationId));
        if (!parent || parent.status !== "enabled") channelConflict();
      }
      const fields: readonly [string, unknown][] = [
        ["id", record.id],
        ["installation_id", record.installationId],
        ["version", record.version],
        ["status", record.status],
        ["created_at", record.createdAt],
        ["updated_at", record.updatedAt],
        ["created_by", record.createdBy],
        ["updated_by", record.updatedBy],
        ...additional,
      ];
      const result = await channelQuery(
        `INSERT INTO occ.${table} (${fields.map(([name]) => name).join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING RETURNING *`,
        fields.map(([, value]) => value),
      );
      const row = rows(result.rows)[0];
      if (!row) channelConflict();
      return decode(row!);
    });
  const channelStatus = <T extends ChannelBindingMetadata>(
    table: ChannelTable,
    decode: (row: PostgresChannelBindingRow) => Readonly<T>,
    id: string,
    expectedVersion: number,
    status: ChannelBindingStatus,
    actorId: string,
    updatedAt: string,
    parentId?: string,
  ): Promise<Readonly<T> | undefined> =>
    withinTransaction(async () => {
      // All adapter mutations lock parent before child, including disabling a child.
      const parent = parentId === undefined ? undefined : await lockChannelParent(parentId);
      if (parentId !== undefined && !parent) return undefined;
      const record = await channelFind(table, decode, "id", id, parentId, true);
      if (!record) return undefined;
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        record.version !== expectedVersion ||
        (status !== "enabled" && status !== "disabled") ||
        !isChannelBindingReference(actorId) ||
        !Number.isFinite(Date.parse(updatedAt))
      )
        channelConflict();
      if (record.status === status) return record;
      if (
        record.version === Number.MAX_SAFE_INTEGER ||
        (parent && status === "enabled" && parent.status !== "enabled")
      )
        channelConflict();
      const result = await channelQuery(
        `UPDATE occ.${table} SET status=$1,version=version+1,updated_by=$2,updated_at=$3 WHERE installation_id=$4 AND id=$5 AND version=$6 RETURNING *`,
        [status, actorId, updatedAt, record.installationId, id, expectedVersion],
      );
      const row = rows(result.rows)[0];
      if (!row) channelConflict();
      return decode(row!);
    });
  return {
    findChannelInstallation: (id) =>
      channelFind("channel_installations", channelInstallationFromRow, "id", id),
    listChannelInstallations: (options) =>
      channelList("channel_installations", channelInstallationFromRow, options),
    findHumanBinding: (parentId, id) =>
      channelFind("channel_human_bindings", channelHumanFromRow, "id", id, parentId),
    findHumanBindingBySubject: (parentId, subject) =>
      channelFind(
        "channel_human_bindings",
        channelHumanFromRow,
        "provider_subject_ref",
        subject,
        parentId,
      ),
    listHumanBindings: (parentId, options) =>
      channelList("channel_human_bindings", channelHumanFromRow, options, parentId),
    findAgentBinding: (parentId, id) =>
      channelFind("channel_agent_bindings", channelAgentFromRow, "id", id, parentId),
    findAgentBindingByChannel: (parentId, channelRef) =>
      channelFind(
        "channel_agent_bindings",
        channelAgentFromRow,
        "channel_ref",
        channelRef,
        parentId,
      ),
    listAgentBindings: (parentId, options) =>
      channelList("channel_agent_bindings", channelAgentFromRow, options, parentId),
    createChannelInstallation: (record) =>
      channelCreate("channel_installations", channelInstallationFromRow, record, [
        ["platform", record.platform],
        ["provider_tenant_ref", record.providerTenantRef],
        ["recipient_app_ref", record.recipientAppRef],
      ]),
    createHumanBinding: (record) =>
      channelCreate("channel_human_bindings", channelHumanFromRow, record, [
        ["channel_installation_id", record.channelInstallationId],
        ["provider_subject_ref", record.providerSubjectRef],
        ["iam_driver_id", record.iamDriverId],
        ["principal_id", record.principalId],
        ["principal_issuer", record.principalIssuer],
        ["principal_subject", record.principalSubject],
      ]),
    createAgentBinding: (record) =>
      channelCreate("channel_agent_bindings", channelAgentFromRow, record, [
        ["channel_installation_id", record.channelInstallationId],
        ["channel_ref", record.channelRef],
        ["scope_kind", record.scopeKind],
        ["namespace_id", record.namespaceId],
        ["agent_id", record.agentId],
      ]),
    setChannelInstallationStatus: (id, version, status, actor, at) =>
      channelStatus(
        "channel_installations",
        channelInstallationFromRow,
        id,
        version,
        status,
        actor,
        at,
      ),
    setHumanBindingStatus: (parentId, id, version, status, actor, at) =>
      channelStatus(
        "channel_human_bindings",
        channelHumanFromRow,
        id,
        version,
        status,
        actor,
        at,
        parentId,
      ),
    setAgentBindingStatus: (parentId, id, version, status, actor, at) =>
      channelStatus(
        "channel_agent_bindings",
        channelAgentFromRow,
        id,
        version,
        status,
        actor,
        at,
        parentId,
      ),
  };
}
