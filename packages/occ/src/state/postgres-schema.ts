import { createAgentTables } from "./schema/agent.ts";
import { createIamTables } from "./schema/iam.ts";
import { createControllerWorkTable } from "./schema/work-queue.ts";
import { serviceAccountDriverBindings } from "./schema/provider-account-bindings.ts";
import { auditEvents } from "./schema/audit.ts";
import { createChannelTables } from "./schema/channel.ts";
import { occSchema, collatedText, identifierPatterns } from "./schema/shared.ts";
import { installation } from "./schema/installation.ts";
import { namespaces } from "./schema/namespace.ts";
import { configurations } from "./schema/configuration.ts";
import { secrets } from "./schema/secret.ts";
import { serviceAccounts } from "./schema/service-account.ts";
export { occSchema, installation, namespaces, configurations, secrets, serviceAccounts };
import { createWorkloadProfileTables } from "./postgres/workload-profile-schema.ts";
import { createLifecycleAdmissionTables } from "./postgres/lifecycle-admission-schema.ts";
import { createCredentialInventoryTablesV1 } from "./postgres/credential-inventory-schema.ts";
import { createGatewayStartupTablesV2 } from "./postgres/gateway-startup-schema.ts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { createTurnJournalTables } from "./postgres/turn-journal-schema.ts";

export { serviceAccountDriverBindings };

export const { agents, agentRevisions } = createAgentTables(
  occSchema,
  { namespaces, configurations, serviceAccounts },
  () => iamIdentities,
);

export const {
  iamIdentities,
  iamRoles,
  iamGroups,
  iamGroupMemberships,
  iamAccessBindings,
  iamRestrictions,
} = createIamTables(occSchema, { namespaces, agents });

export { auditEvents };

export const controllerWork = createControllerWorkTable(
  occSchema,
  { namespaces, agents, agentRevisions },
  () => ({ agentRevisionRuntimeAdmissions, runtimeReferencePattern }),
  () => agentLifecycleAdmissions,
);

export const user = occSchema.table(
  "user",
  {
    id: text("id").primaryKey(),
    name: collatedText("name").notNull(),
    email: collatedText("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("auth_user_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_user_name_length", sql`char_length(${table.name}) BETWEEN 1 AND 200`),
    check("auth_user_email_length", sql`char_length(${table.email}) BETWEEN 3 AND 320`),
    check(
      "auth_user_email_normalized",
      sql`${table.email} = lower(btrim(${table.email})) AND ${table.email} LIKE '%@%'`,
    ),
    check("auth_user_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const session = occSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    check("auth_session_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_session_token_length", sql`char_length(${table.token}) BETWEEN 1 AND 512`),
    check("auth_session_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const account = occSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade", onUpdate: "restrict" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
    check("auth_account_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check("auth_account_provider_length", sql`char_length(${table.providerId}) BETWEEN 1 AND 200`),
    check(
      "auth_account_external_id_length",
      sql`char_length(${table.accountId}) BETWEEN 1 AND 512`,
    ),
    check("auth_account_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const verification = occSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("verification_identifier_idx").on(table.identifier),
    check("auth_verification_id_length", sql`char_length(${table.id}) BETWEEN 1 AND 200`),
    check(
      "auth_verification_identifier_length",
      sql`char_length(${table.identifier}) BETWEEN 1 AND 512`,
    ),
    check("auth_verification_value_length", sql`char_length(${table.value}) BETWEEN 1 AND 4096`),
    check("auth_verification_timestamp_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

// Better Auth owns this schema and hashed key lifecycle. referenceId resolves
// through the selected IAM Driver, which need not store identities in OCC.
export const apikey = occSchema.table(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id").notNull(),
    prefix: text("prefix"),
    key: text("key").notNull().unique(),
    refillInterval: bigint("refill_interval", { mode: "number" }),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(false),
    rateLimitTimeWindow: bigint("rate_limit_time_window", { mode: "number" }),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
  ],
);

const runtimeReferencePattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const agentRuntimeIntents = occSchema.table(
  "agent_runtime_intents",
  {
    transitionRef: text("transition_ref").primaryKey(),
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onDelete: "restrict", onUpdate: "restrict" }),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    desiredMode: text("desired_mode").$type<"running" | "disabled" | "stopped">().notNull(),
    revisionId: text("revision_id"),
    admissionVersion: smallint("admission_version").$type<0 | 1>().notNull().default(0),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_intents_agent_generation_unique").on(
      table.namespaceId,
      table.agentId,
      table.generation,
    ),
    unique("runtime_intents_head_identity_unique").on(
      table.namespaceId,
      table.agentId,
      table.generation,
      table.transitionRef,
    ),
    unique("runtime_intents_allocation_identity_unique").on(
      table.installationId,
      table.namespaceId,
      table.agentId,
      table.generation,
      table.revisionId,
    ),
    unique("runtime_intents_admission_identity_unique").on(
      table.namespaceId,
      table.agentId,
      table.revisionId,
      table.transitionRef,
      table.generation,
    ),
    foreignKey({
      name: "runtime_intents_agent_owner",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "runtime_intents_revision_owner",
      columns: [table.namespaceId, table.agentId, table.revisionId],
      foreignColumns: [agentRevisions.namespaceId, agentRevisions.agentId, agentRevisions.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_intents_transition_ref_format",
      sql`${table.transitionRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_intents_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "runtime_intents_mode_valid",
      sql`${table.desiredMode} IN ('running', 'disabled', 'stopped')`,
    ),
    check(
      "runtime_intents_admission_version_valid",
      sql`(${table.admissionVersion} = 0 AND ${table.revisionId} IS NOT NULL)
        OR (${table.admissionVersion} = 1 AND ${table.desiredMode} IN ('disabled', 'stopped'))`,
    ),
    check(
      "runtime_intents_actor_id_valid",
      sql`char_length(${table.actorId}) BETWEEN 1 AND 200 AND ${table.actorId} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_intents_request_id_valid",
      sql`char_length(${table.requestId}) BETWEEN 1 AND 200 AND ${table.requestId} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check("runtime_intents_created_at_finite", sql`isfinite(${table.createdAt})`),
  ],
);

// Migration triggers bind the exact success audit and original work at commit,
// and preserve both admission and work identity independently of queue state.
export const agentRevisionRuntimeAdmissions = occSchema.table(
  "agent_revision_runtime_admissions",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").primaryKey(),
    runtimeTransitionRef: text("runtime_transition_ref")
      .notNull()
      .unique("agent_revision_runtime_admissions_runtime_transition_ref_key"),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull(),
    auditEventId: text("audit_event_id")
      .notNull()
      .unique("agent_revision_runtime_admissions_audit_event_id_key"),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: "agent_revision_runtime_admissions_audit_event_id_fkey",
      columns: [table.auditEventId],
      foreignColumns: [auditEvents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    unique("revision_runtime_admissions_work_identity_unique").on(
      table.namespaceId,
      table.agentId,
      table.revisionId,
      table.runtimeTransitionRef,
      table.lifecycleGeneration,
    ),
    foreignKey({
      name: "revision_runtime_admissions_intent_owner",
      columns: [
        table.namespaceId,
        table.agentId,
        table.revisionId,
        table.runtimeTransitionRef,
        table.lifecycleGeneration,
      ],
      foreignColumns: [
        agentRuntimeIntents.namespaceId,
        agentRuntimeIntents.agentId,
        agentRuntimeIntents.revisionId,
        agentRuntimeIntents.transitionRef,
        agentRuntimeIntents.generation,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
  ],
);

// Migration triggers additionally enforce initial generation one and exact head increments.
export const agentRuntimeIntentHeads = occSchema.table(
  "agent_runtime_intent_heads",
  {
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    transitionRef: text("transition_ref").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_intent_heads_agent_unique").on(table.namespaceId, table.agentId),
    foreignKey({
      name: "runtime_intent_heads_history_owner",
      columns: [table.namespaceId, table.agentId, table.generation, table.transitionRef],
      foreignColumns: [
        agentRuntimeIntents.namespaceId,
        agentRuntimeIntents.agentId,
        agentRuntimeIntents.generation,
        agentRuntimeIntents.transitionRef,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_intent_heads_generation_valid",
      sql`${table.generation} BETWEEN 1 AND 9007199254740991`,
    ),
  ],
);

// Migration triggers lock the owner and head, require the current running intent,
// and enforce exact component increments; immutable rows retain historical identity.
export const runtimeAssignmentAllocations = occSchema.table(
  "runtime_assignment_allocations",
  {
    assignmentRef: text("assignment_ref").primaryKey(),
    createEffectRef: text("create_effect_ref").notNull(),
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    revisionId: text("revision_id").notNull(),
    servicePrincipalId: text("service_principal_id").notNull(),
    lifecycleGeneration: bigint("lifecycle_generation", { mode: "number" }).notNull(),
    component: text("component").$type<"gateway" | "harness">().notNull(),
    runtimeGeneration: bigint("runtime_generation", { mode: "number" }).notNull(),
    providerProfileRef: text("provider_profile_ref").notNull(),
    runtimeProfileRef: text("runtime_profile_ref").notNull(),
    identityProfileRef: text("identity_profile_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    bindingCondition: text("binding_condition").$type<"unbound">().notNull().default("unbound"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_allocations_create_effect_unique").on(table.createEffectRef),
    unique("runtime_allocations_authority_owner").on(
      table.installationId,
      table.namespaceId,
      table.agentId,
      table.assignmentRef,
    ),
    unique("runtime_allocations_component_generation_unique").on(
      table.namespaceId,
      table.agentId,
      table.component,
      table.runtimeGeneration,
    ),
    foreignKey({
      name: "runtime_allocations_intent_owner",
      columns: [
        table.installationId,
        table.namespaceId,
        table.agentId,
        table.lifecycleGeneration,
        table.revisionId,
      ],
      foreignColumns: [
        agentRuntimeIntents.installationId,
        agentRuntimeIntents.namespaceId,
        agentRuntimeIntents.agentId,
        agentRuntimeIntents.generation,
        agentRuntimeIntents.revisionId,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "runtime_allocations_agent_principal_owner",
      columns: [table.namespaceId, table.agentId, table.servicePrincipalId],
      foreignColumns: [agents.namespaceId, agents.id, agents.servicePrincipalId],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_allocations_assignment_ref_format",
      sql`${table.assignmentRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_allocations_create_effect_ref_format",
      sql`${table.createEffectRef} ~ ${runtimeReferencePattern}`,
    ),
    check(
      "runtime_allocations_lifecycle_generation_valid",
      sql`${table.lifecycleGeneration} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "runtime_allocations_runtime_generation_valid",
      sql`${table.runtimeGeneration} BETWEEN 1 AND 9007199254740991`,
    ),
    check("runtime_allocations_component_valid", sql`${table.component} IN ('gateway', 'harness')`),
    check(
      "runtime_allocations_binding_condition_valid",
      sql`${table.bindingCondition} = 'unbound'`,
    ),
    check(
      "runtime_allocations_provider_profile_ref_valid",
      sql`char_length(${table.providerProfileRef}) BETWEEN 1 AND 200 AND ${table.providerProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_allocations_runtime_profile_ref_valid",
      sql`char_length(${table.runtimeProfileRef}) BETWEEN 1 AND 200 AND ${table.runtimeProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check(
      "runtime_allocations_identity_profile_ref_valid",
      sql`char_length(${table.identityProfileRef}) BETWEEN 1 AND 200 AND ${table.identityProfileRef} ~ '^[A-Za-z0-9._:/-]+$'`,
    ),
    check("runtime_allocations_created_at_finite", sql`isfinite(${table.createdAt})`),
  ],
);

// Migration triggers preserve binding identities and enforce status versions and parent locking.
export const { channelInstallations, channelHumanBindings, channelAgentBindings } =
  createChannelTables(occSchema, { installation, agents });

export const signInQuotaSlots = occSchema.table(
  "sign_in_quota_slots",
  {
    slot: integer("slot").primaryKey(),
    nextAtMs: bigint("next_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    check("sign_in_quota_slot_bounded", sql`${table.slot} >= 0 AND ${table.slot} < 20480`),
    check("sign_in_quota_timestamp_valid", sql`${table.nextAtMs} BETWEEN 0 AND 9007199254740991`),
  ],
);

/** Append-only binding/evidence/retirement records; SQL triggers enforce the transition,
 * immutable receipt and payload association under the existing Agent owner lock. */
export const runtimeAuthorityOperations = occSchema.table(
  "runtime_authority_operations",
  {
    operationRef: text("operation_ref").primaryKey(),
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    assignmentRef: text("assignment_ref").notNull(),
    assignmentRecordVersion: bigint("assignment_record_version", { mode: "number" }).notNull(),
    operationKind: text("operation_kind").notNull(),
    canonicalPayload: text("canonical_payload").notNull(),
    receipt: jsonb("receipt").notNull(),
  },
  (table) => [
    foreignKey({
      name: "runtime_authority_allocation_owner",
      columns: [table.installationId, table.namespaceId, table.agentId, table.assignmentRef],
      foreignColumns: [
        runtimeAssignmentAllocations.installationId,
        runtimeAssignmentAllocations.namespaceId,
        runtimeAssignmentAllocations.agentId,
        runtimeAssignmentAllocations.assignmentRef,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    unique("runtime_authority_assignment_version").on(
      table.assignmentRef,
      table.assignmentRecordVersion,
    ),
    check(
      "runtime_authority_operation_ref",
      sql`${table.operationRef} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      "runtime_authority_version",
      sql`${table.assignmentRecordVersion} BETWEEN 2 AND 9007199254740991`,
    ),
    check(
      "runtime_authority_kind",
      sql`${table.operationKind} IN ('bind', 'record-evidence', 'retire')`,
    ),
    check(
      "runtime_authority_payload_size",
      sql`octet_length(${table.canonicalPayload}) BETWEEN 1 AND 262144`,
    ),
    check("runtime_authority_receipt_object", sql`jsonb_typeof(${table.receipt}) = 'object'`),
  ],
);

export const runtimeServiceTrustRecords = occSchema.table(
  "runtime_service_trust_records",
  {
    installationId: text("installation_id")
      .notNull()
      .references(() => installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
    subjectKind: text("subject_kind").notNull(),
    subjectRef: text("subject_ref").notNull(),
    recordVersion: bigint("record_version", { mode: "number" }).notNull(),
    operationRef: text("operation_ref").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => iamIdentities.id, { onUpdate: "restrict", onDelete: "restrict" }),
    auditId: text("audit_id")
      .notNull()
      .unique()
      .references(() => auditEvents.id, { onUpdate: "restrict", onDelete: "restrict" }),
    canonicalRequest: text("canonical_request").notNull(),
    requestDigest: text("request_digest").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    record: jsonb("record")
      .$type<import("../runtime-authority/service-trust-schema.ts").RuntimeServiceTrustRecord>()
      .notNull(),
    sourceOperationRef: text("source_operation_ref").generatedAlwaysAs(
      sql`record->>'sourceOperationRef'`,
    ),
    namespaceId: text("namespace_id").generatedAlwaysAs(
      sql`record#>>'{configuration,allowedScope,namespaceId}'`,
    ),
    agentId: text("agent_id").generatedAlwaysAs(
      sql`record#>>'{configuration,allowedScope,agentId}'`,
    ),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("runtime_service_trust_version").on(
      table.installationId,
      table.subjectKind,
      table.subjectRef,
      table.recordVersion,
    ),
    uniqueIndex("runtime_service_trust_profile_identity")
      .on(sql`${table.record}#>>'{configuration,serviceTrustProfileRef}'`)
      .where(sql`${table.record}->>'kind'='service-admit'`),
    foreignKey({
      name: "runtime_service_trust_source",
      columns: [table.sourceOperationRef],
      foreignColumns: [runtimeServiceTrustRecords.operationRef],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    foreignKey({
      name: "runtime_service_trust_agent",
      columns: [table.namespaceId, table.agentId],
      foreignColumns: [agents.namespaceId, agents.id],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "runtime_service_trust_records_subject_kind_check",
      sql`${table.subjectKind} IN ('source','service')`,
    ),
    check(
      "runtime_service_trust_records_record_version_check",
      sql`${table.recordVersion} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "runtime_service_trust_records_canonical_request_check",
      sql`octet_length(${table.canonicalRequest}) BETWEEN 1 AND 8192`,
    ),
    check(
      "runtime_service_trust_records_record_check",
      sql`jsonb_typeof(${table.record})='object'`,
    ),
  ],
);

export const {
  turnJournalOwners,
  turnJournalKeys,
  turnJournalIncomingLinks,
  turnJournalAttempts,
  turnJournalReservations,
  turnJournalHeads,
  turnJournalOperations,
  turnJournalDeliveries,
  turnJournalDeliveryAttempts,
} = createTurnJournalTables(occSchema, { installation, agents, channelInstallations });

/** Internal immutable preparation history; retention never grants provider admission. */
export const runtimePreparationOperations = occSchema.table(
  "runtime_preparation_operations",
  {
    operationRef: text("operation_ref").primaryKey(),
    preparationRef: text("preparation_ref").notNull(),
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    assignmentRef: text("assignment_ref").notNull(),
    localVersion: bigint("local_version", { mode: "number" }).notNull(),
    operationKind: text("operation_kind").notNull(),
    childEffectRef: text("child_effect_ref").unique("runtime_preparation_child_effect_unique"),
    bindingOperationRef: text("binding_operation_ref").unique(
      "runtime_preparation_binding_operation_unique",
    ),
    canonicalRequest: text("canonical_request").notNull(),
    record: jsonb("record").notNull(),
  },
  (table) => [
    foreignKey({
      name: "runtime_preparation_allocation_owner",
      columns: [table.installationId, table.namespaceId, table.agentId, table.assignmentRef],
      foreignColumns: [
        runtimeAssignmentAllocations.installationId,
        runtimeAssignmentAllocations.namespaceId,
        runtimeAssignmentAllocations.agentId,
        runtimeAssignmentAllocations.assignmentRef,
      ],
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    unique("runtime_preparation_version_unique").on(table.preparationRef, table.localVersion),
    check("runtime_preparation_version", sql`${table.localVersion} BETWEEN 1 AND 9007199254740991`),
    check(
      "runtime_preparation_kind",
      sql`${table.operationKind} IN ('retain-plan','retain-child','retain-binding','supersede-plan','close')`,
    ),
    check(
      "runtime_preparation_request_size",
      sql`octet_length(${table.canonicalRequest}) BETWEEN 1 AND 1048576`,
    ),
    check("runtime_preparation_record_object", sql`jsonb_typeof(${table.record})='object'`),
  ],
);

/** Inert preparation history; these records never confer admission authority. */
export const { workloadProfileCapacity, workloadProfileOperations } = createWorkloadProfileTables(
  occSchema,
  { installation, namespaces },
);

export const {
  agentLifecycleAdmissions,
  runtimeCleanupResponsibilities,
  runtimeCleanupResponsibilityAllocations,
  auditExportOutbox,
  lifecycleCapabilities,
} = createLifecycleAdmissionTables(occSchema, {
  installation,
  namespaces,
  agents,
  agentRuntimeIntents,
  controllerWork,
  auditEvents,
  runtimeAssignmentAllocations,
});

export const {
  credentialInventoryRecords,
  credentialInventoryOperations,
  credentialInventoryMintClaims,
  credentialInventoryRevocationClaims,
  credentialInventorySnapshots,
} = createCredentialInventoryTablesV1(occSchema, { installation, agents });

/** Exact original parents; the matching subject-partition guards are required before use. */
export const { gatewayStartupHeads, gatewayStartupOperations } = createGatewayStartupTablesV2(
  occSchema,
  { installation, auditEvents, agents },
);
