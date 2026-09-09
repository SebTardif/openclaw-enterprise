import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";

/** The forward migration supplies immutable-field, transition, clock and mandatory-history guards. */
export function createDelegationTables(
  schema: PgSchema,
  parents: {
    installation: { id: AnyPgColumn };
    agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
  },
) {
  const scope = () => ({
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    grantRef: text("grant_ref").notNull(),
  });
  const version = () => bigint("version", { mode: "number" }).notNull();
  const roots = schema.table(
    "delegation_roots",
    {
      ...scope(),
      mediationContextRef: text("mediation_context_ref").notNull(),
      grant: jsonb("root_grant").notNull(),
      status: text("status").notNull(),
      version: version(),
    },
    (t) => [
      primaryKey({ columns: [t.installationId, t.namespaceId, t.agentId, t.grantRef] }),
      unique().on(t.installationId, t.namespaceId, t.agentId, t.mediationContextRef),
      foreignKey({ columns: [t.installationId], foreignColumns: [parents.installation.id] })
        .onDelete("restrict")
        .onUpdate("restrict"),
      foreignKey({
        columns: [t.namespaceId, t.agentId],
        foreignColumns: [parents.agents.namespaceId, parents.agents.id],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      check("delegation_roots_status_check", sql`${t.status} IN ('active','closed','revoked')`),
      check("delegation_roots_version_check", sql`${t.version} BETWEEN 1 AND 9007199254740991`),
    ],
  );
  const operations = schema.table(
    "delegation_operations",
    {
      ...scope(),
      operationRef: text("operation_ref").notNull(),
      admission: jsonb("admission").notNull(),
      status: text("status").notNull(),
      outcome: text("outcome"),
      dispatchedAt: text("dispatched_at"),
      rootVersion: bigint("root_version", { mode: "number" }).notNull(),
      version: version(),
    },
    (t) => [
      primaryKey({ columns: [t.installationId, t.namespaceId, t.agentId, t.operationRef] }),
      unique().on(t.installationId, t.namespaceId, t.agentId, t.grantRef, t.operationRef),
      foreignKey({
        columns: [t.installationId, t.namespaceId, t.agentId, t.grantRef],
        foreignColumns: [roots.installationId, roots.namespaceId, roots.agentId, roots.grantRef],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      check(
        "delegation_operations_status_check",
        sql`${t.status} IN ('accepted','dispatched','unknown','completed','cancelled')`,
      ),
      check(
        "delegation_operations_root_version_check",
        sql`${t.rootVersion} BETWEEN 1 AND 9007199254740991`,
      ),
      check(
        "delegation_operations_version_check",
        sql`${t.version} BETWEEN 1 AND 9007199254740991`,
      ),
    ],
  );
  const rootHistory = schema.table(
    "delegation_root_history",
    {
      ...scope(),
      version: version(),
      record: jsonb("record").notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.installationId, t.namespaceId, t.agentId, t.grantRef, t.version] }),
      foreignKey({
        columns: [t.installationId, t.namespaceId, t.agentId, t.grantRef],
        foreignColumns: [roots.installationId, roots.namespaceId, roots.agentId, roots.grantRef],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
    ],
  );
  const operationHistory = schema.table(
    "delegation_operation_history",
    {
      ...scope(),
      operationRef: text("operation_ref").notNull(),
      version: version(),
      record: jsonb("record").notNull(),
    },
    (t) => [
      primaryKey({
        columns: [t.installationId, t.namespaceId, t.agentId, t.operationRef, t.version],
      }),
      foreignKey({
        columns: [t.installationId, t.namespaceId, t.agentId, t.grantRef, t.operationRef],
        foreignColumns: [
          operations.installationId,
          operations.namespaceId,
          operations.agentId,
          operations.grantRef,
          operations.operationRef,
        ],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
    ],
  );
  return {
    delegationRoots: roots,
    delegationOperations: operations,
    delegationRootHistory: rootHistory,
    delegationOperationHistory: operationHistory,
  };
}
