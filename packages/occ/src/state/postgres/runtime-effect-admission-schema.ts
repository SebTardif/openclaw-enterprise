import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  index,
  primaryKey,
  text,
  unique,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import type { StoredRuntimeEffectGateV1 } from "../../ports/repositories/runtime-effect-admission.ts";

export function createRuntimeEffectAdmissionTables(
  schema: PgSchema,
  parents: {
    installation: { id: AnyPgColumn };
    agents: { namespaceId: AnyPgColumn; id: AnyPgColumn };
    agentRevisions: { namespaceId: AnyPgColumn; agentId: AnyPgColumn; id: AnyPgColumn };
    runtimePreparationOperations: { operationRef: AnyPgColumn };
  },
) {
  const runtimeEffectGates = schema.table(
    "runtime_effect_gates",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
      namespaceId: text("namespace_id").notNull(),
      agentId: text("agent_id").notNull(),
      preparationRef: text("preparation_ref").notNull(),
      preparationOperationRef: text("preparation_operation_ref")
        .notNull()
        .references(() => parents.runtimePreparationOperations.operationRef, {
          onDelete: "restrict",
          onUpdate: "restrict",
        }),
      revisionId: text("revision_id").generatedAlwaysAs(sql`target->>'revisionId'`),
      target: jsonb("target").$type<StoredRuntimeEffectGateV1["target"]>().notNull(),
      gateGuard: jsonb("gate_guard").$type<StoredRuntimeEffectGateV1["guard"]>().notNull(),
      plan: jsonb("plan").$type<StoredRuntimeEffectGateV1["plan"]>().notNull(),
      ordinaryAdmission: text("ordinary_admission").$type<"closed">().notNull().default("closed"),
      sealerAdmission: text("sealer_admission").$type<"closed">().notNull().default("closed"),
      lastClosureOperationRef: text("last_closure_operation_ref"),
    },
    (table) => [
      primaryKey({
        name: "runtime_effect_gates_pk",
        columns: [table.installationId, table.namespaceId, table.agentId],
      }),
      foreignKey({
        name: "runtime_effect_gates_agent_owner",
        columns: [table.namespaceId, table.agentId],
        foreignColumns: [parents.agents.namespaceId, parents.agents.id],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      foreignKey({
        name: "runtime_effect_gates_revision_owner",
        columns: [table.namespaceId, table.agentId, table.revisionId],
        foreignColumns: [
          parents.agentRevisions.namespaceId,
          parents.agentRevisions.agentId,
          parents.agentRevisions.id,
        ],
      })
        .onDelete("restrict")
        .onUpdate("restrict"),
      index("runtime_gate_original_revision").on(
        table.namespaceId,
        table.agentId,
        table.revisionId,
      ),
      unique("runtime_effect_gates_preparation_unique").on(table.preparationOperationRef),
      check(
        "runtime_effect_gates_admission_closed",
        sql`${table.ordinaryAdmission}='closed' AND ${table.sealerAdmission}='closed'`,
      ),
      check(
        "runtime_effect_gates_size",
        sql`octet_length(${table.gateGuard}::text)<=65536 AND octet_length(${table.plan}::text)<=65536`,
      ),
    ],
  );
  return { runtimeEffectGates };
}
