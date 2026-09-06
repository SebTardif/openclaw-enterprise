import { createPostgresRuntimePreparation } from "./postgres/runtime-preparation.ts";
import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import { bindRepository } from "../ports/repository-factory.ts";
import type { ProviderAccountLinks } from "../ports/provider-account-links.ts";
import { createPostgresProviderAccountLinks } from "./postgres/provider-account-links.ts";
import { createPostgresNamespaceRepository } from "./postgres/namespaces.ts";
import { createPostgresConfigurationRepository } from "./postgres/configurations.ts";
import { createPostgresSecretRepository } from "./postgres/secrets.ts";
import { createPostgresChannelBindingRepository } from "./postgres/channel-bindings.ts";
import { createPlatformReadView } from "../ports/platform-read-view.ts";
import { bindPlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import {
  createPostgresTurnJournal,
  type PostgresTurnJournalOptions,
} from "../turn-journal/postgres.ts";
import { TurnJournalTransactionGuard } from "../turn-journal/transaction-guard.ts";
import { createRuntimeServiceTrustRepository } from "../runtime-authority/service-trust.ts";
import { parseRuntimeServiceTrustRecord } from "../runtime-authority/service-trust-schema.ts";
import {
  createRuntimeAuthorityRepository,
  RuntimeAuthorityTransactionGuard,
  type StoredRuntimeAuthorityOperation,
} from "../runtime-authority/repository.ts";
import { parseRuntimeAuthorityV1 } from "@openclaw-enterprise/contracts";
import { randomUUID } from "node:crypto";
import type {
  AccessBinding,
  Agent,
  AgentRevision,
  AuditEvent,
  Group,
  GroupMembership,
  Identity,
  Installation,
  Permission,
  Principal,
  Restriction,
  Role,
  SecretBindings,
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts";
import {
  decodeChannelAdministrationMappingV1,
  normalizeSecretBindings,
  RESOURCE_KINDS as PLATFORM_RESOURCE_KINDS,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import {
  serializeChannelBindingMutations,
  serializeRuntimeAssignmentMutations,
  isRuntimeAdmissionAudit,
} from "./platform-state.ts";
import type {
  RuntimeAssignmentRepository,
  RuntimeAdmissionRepository,
  RevisionRuntimeAdmission,
  RuntimeIntent,
  RuntimeAllocation,
  RuntimeScope,
  RuntimeIntentAttribution,
  AgentRepository,
  AgentRevisionRepository,
  InstallationRepository,
  PlatformAuditSink,
  PlatformOperation,
  PlatformReadView,
  PlatformAuditRepository,
  PlatformStateStore,
  PlatformReadOptions,
  PlatformUnitOfWork,
  ServiceAccountRepository,
} from "./platform-state.ts";
import {
  PostgresWorkQueue,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
} from "./postgres-work-queue.ts";

type PostgresRow = Record<string, unknown>;

export interface PostgresClient extends PostgresQueryClient {
  on?(event: "error", listener: (error: Error) => void): unknown;
  removeListener?(event: "error", listener: (error: Error) => void): unknown;
  release(destroy?: boolean): void;
}

export interface PostgresPool {
  readonly options?: {
    readonly connectionTimeoutMillis?: number | undefined;
    readonly max?: number | undefined;
    readonly pipeline?: boolean;
    readonly onConnect?: unknown;
    readonly verify?: unknown;
    readonly Client?: unknown;
  };
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export interface PersistedNativeIAMState {
  readonly identities: readonly Identity[];
  readonly groups: readonly Group[];
  readonly memberships: readonly GroupMembership[];
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
  readonly restrictions: readonly Restriction[];
}

export interface PostgresPlatformStateOptions {
  readonly bootstrapNativeIAM?: PersistedNativeIAMState;
  readonly turnJournal?: PostgresTurnJournalOptions;
}

export interface PersistedNativeIAMPrincipalSeed {
  readonly principal: Principal;
  readonly roles: readonly Role[];
  readonly bindings: readonly AccessBinding[];
}

export { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";

interface TransactionContext {
  readView?: PlatformReadView;
  readonly lifetime: RepositoryTransactionLifetime;
  readonly authorityGuard: RuntimeAuthorityTransactionGuard;
  readonly journalGuard: TurnJournalTransactionGuard;
  readonly client: PostgresClient;
  installation: Readonly<Installation> | undefined;
  installationLoaded: boolean;
}

const PERMISSION_ACTIONS = new Set([
  "create",
  "read",
  "update",
  "delete",
  "deploy",
  "operate",
  "administer",
]);
const RESOURCE_KINDS = new Set<string>(PLATFORM_RESOURCE_KINDS);
const AUDIT_METADATA_KEY = "__occAuditMetadata";
const SECRET_IDENTIFIER =
  /^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE_IDENTIFIER =
  /^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runtimeGeneration(row: PostgresRow, key: string): number {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new DependencyUnavailableError("The stored runtime generation is invalid.");
  return value;
}
function runtimeIntentFromRow(row: PostgresRow): Readonly<RuntimeIntent> {
  const desiredMode = text(row, "desired_mode");
  if (desiredMode !== "running" && desiredMode !== "disabled" && desiredMode !== "stopped")
    throw new DependencyUnavailableError("The stored runtime intent mode is invalid.");
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    transitionRef: text(row, "transition_ref"),
    generation: runtimeGeneration(row, "generation"),
    desiredMode,
    revisionId: text(row, "revision_id"),
    actorId: text(row, "actor_id"),
    requestId: text(row, "request_id"),
    createdAt: timestamp(row, "created_at"),
  });
}
function revisionAdmissionFromRow(row: PostgresRow): Readonly<RevisionRuntimeAdmission> {
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revisionId: text(row, "revision_id"),
    runtimeTransitionRef: text(row, "runtime_transition_ref"),
    lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
    auditEventId: text(row, "audit_event_id"),
  });
}
function runtimeAllocationFromRow(row: PostgresRow): Readonly<RuntimeAllocation> {
  const component = text(row, "component");
  if (
    (component !== "gateway" && component !== "harness") ||
    text(row, "binding_condition") !== "unbound"
  )
    throw new DependencyUnavailableError("The stored runtime allocation is invalid.");
  return immutableCopy({
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    installationId: text(row, "installation_id"),
    assignmentRef: text(row, "assignment_ref"),
    createEffectRef: text(row, "create_effect_ref"),
    revisionId: text(row, "revision_id"),
    servicePrincipalId: text(row, "service_principal_id"),
    lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
    component,
    runtimeGeneration: runtimeGeneration(row, "runtime_generation"),
    providerProfileRef: text(row, "provider_profile_ref"),
    runtimeProfileRef: text(row, "runtime_profile_ref"),
    identityProfileRef: text(row, "identity_profile_ref"),
    bindingCondition: "unbound",
    createdAt: timestamp(row, "created_at"),
  });
}

function rows(value: unknown[]): PostgresRow[] {
  return value.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      throw new DependencyUnavailableError("The persistence repository returned invalid data.");
    return row as PostgresRow;
  });
}

function text(row: PostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0)
    throw new DependencyUnavailableError("Persisted platform state is invalid or incomplete.");
  return value;
}

function optionalText(row: PostgresRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return text(row, key);
}

function timestamp(row: PostgresRow, key: string): string {
  const value = row[key];
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime()))
    throw new DependencyUnavailableError("Persisted platform state has an invalid timestamp.");
  return date.toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DependencyUnavailableError("Persisted platform state contains invalid JSON.");
  return parsed as Record<string, unknown>;
}

function installationFromRow(row: PostgresRow): Readonly<Installation> {
  return immutableCopy({
    id: text(row, "id"),
    name: text(row, "name"),
    createdAt: timestamp(row, "created_at"),
  });
}

function agentFromRow(row: PostgresRow): Readonly<Agent> {
  const activeRevisionId = optionalText(row, "active_revision_id");
  const serviceAccountId = optionalText(row, "service_account_id");
  const providerId = row.provider_id === null ? null : text(row, "provider_id");
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    configurationId: text(row, "configuration_id"),
    providerId,
    executionMode: text(row, "execution_mode") as Agent["executionMode"],
    servicePrincipalId: text(row, "service_principal_id"),
    ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
    ...(activeRevisionId === undefined ? {} : { activeRevisionId }),
    createdAt: timestamp(row, "created_at"),
  });
}

function serviceAccountFromRow(row: PostgresRow): Readonly<ServiceAccount> {
  const credential = row.credential as ServiceAccountCredential | null;
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    name: text(row, "name"),
    ...(credential === null ? {} : { credential }),
  });
}

function revisionFromRow(row: PostgresRow): Readonly<AgentRevision> {
  const rawNumber = row.revision_number;
  const revision = typeof rawNumber === "string" ? Number(rawNumber) : rawNumber;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0)
    throw new DependencyUnavailableError("Persisted AgentRevision numbering is invalid.");
  const admitted = jsonObject(row.admitted_spec) as {
    configuration_id: AgentRevision["configurationId"];
    configuration_kind: AgentRevision["configurationKind"];
    configuration_generation: AgentRevision["configurationGeneration"];
    draft_spec: AgentRevision["configuration"];
    harness: AgentRevision["harness"];
    compute: AgentRevision["compute"];
    sandbox_driver_id?: AgentRevision["sandboxDriverId"];
    service_account?: AgentRevision["serviceAccount"];
    secret_driver_id?: AgentRevision["secretDriverId"];
    secret_bindings?: AgentRevision["secretBindings"];
  };
  const secretBindings =
    admitted.secret_bindings === undefined
      ? undefined
      : secretBindingsFromJson(admitted.secret_bindings, text(row, "namespace_id"));
  return immutableCopy({
    id: text(row, "id"),
    namespaceId: text(row, "namespace_id"),
    agentId: text(row, "agent_id"),
    revision,
    providerId: row.provider_id === null ? null : text(row, "provider_id"),
    configurationId: admitted.configuration_id,
    configurationKind: admitted.configuration_kind,
    configurationGeneration: admitted.configuration_generation,
    configuration: admitted.draft_spec,
    harness: admitted.harness,
    compute: admitted.compute,
    ...(admitted.sandbox_driver_id === undefined
      ? {}
      : { sandboxDriverId: admitted.sandbox_driver_id }),
    ...(admitted.secret_driver_id === undefined
      ? {}
      : { secretDriverId: admitted.secret_driver_id }),
    ...(secretBindings === undefined ? {} : { secretBindings }),
    ...(admitted.service_account === undefined ? {} : { serviceAccount: admitted.service_account }),
    servicePrincipalId: text(row, "service_principal_id"),
    createdAt: timestamp(row, "admitted_at"),
  });
}

function secretBindingsFromJson(value: unknown, namespaceId: string): SecretBindings | undefined {
  if (!NAMESPACE_IDENTIFIER.test(namespaceId))
    throw new DependencyUnavailableError("Persisted Secret bindings have an invalid Namespace.");
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  let normalized: SecretBindings;
  try {
    normalized = normalizeSecretBindings(parsed);
  } catch {
    throw new DependencyUnavailableError("Persisted Secret bindings are invalid.");
  }
  for (const { source } of Object.values(normalized)) {
    if (source.namespaceId !== namespaceId || !SECRET_IDENTIFIER.test(source.id))
      throw new DependencyUnavailableError("Persisted Secret bindings reference invalid Secrets.");
  }
  return Object.keys(normalized).length === 0 ? undefined : immutableCopy(normalized);
}

function secretBindingsFromState(
  value: SecretBindings,
  namespaceId: string,
): SecretBindings | undefined {
  try {
    return secretBindingsFromJson(value, namespaceId);
  } catch (error) {
    if (error instanceof DependencyUnavailableError)
      throw new ScopeViolationError("Secret bindings are invalid.");
    throw error;
  }
}

function serializeSecretBindings(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): string | null {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  return normalized === undefined ? null : JSON.stringify(normalized);
}

function referencedSecretIds(
  namespaceId: string,
  bindings: SecretBindings | undefined,
): readonly string[] {
  const normalized =
    bindings === undefined ? undefined : secretBindingsFromState(bindings, namespaceId);
  if (normalized === undefined) return Object.freeze([]);
  return Object.freeze(
    Array.from(new Set(Object.values(normalized).map(({ source }) => source.id))),
  );
}

function databaseError(error: unknown): Error {
  if (
    error instanceof ScopeViolationError ||
    error instanceof DependencyUnavailableError ||
    !(error instanceof Error)
  )
    return error instanceof Error
      ? error
      : new DependencyUnavailableError("The platform persistence repository is unavailable.");

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "23505")
    return new ResourceConflictError(
      "A platform resource with this identity or name already exists.",
    );
  if (
    code === "23001" ||
    code === "23503" ||
    code === "23514" ||
    code === "23502" ||
    code === "55000"
  )
    return new ScopeViolationError("The resource violates its exact platform ownership or state.");
  if (
    code?.startsWith("08") ||
    code?.startsWith("53") ||
    code?.startsWith("57") ||
    code === "3D000" ||
    code === "3F000" ||
    code === "42P01" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  )
    return new DependencyUnavailableError("The platform persistence repository is unavailable.");
  return error;
}

function commitOutcomeUnknown(error: unknown): boolean {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return (
    code === undefined ||
    !/^[0-9A-Z]{5}$/.test(code) ||
    code.startsWith("08") ||
    code.startsWith("57")
  );
}

function auditDetails(event: AuditEvent): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = { ...(event.details ?? {}) };
  if (AUDIT_METADATA_KEY in details)
    throw new ScopeViolationError("The audit details contain reserved persistence metadata.");

  const metadata: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion",
    "source",
    "requestId",
    "admissionDecisionId",
    "actor",
    "iamDriverId",
    "authorization",
    "decisionReason",
    "reasonCode",
  ] as const) {
    const value = event[key];
    if (value !== undefined) metadata[key] = value;
  }
  if (Object.keys(metadata).length > 0) details[AUDIT_METADATA_KEY] = metadata;
  return Object.keys(details).length > 0 ? details : undefined;
}

function auditFromRow(row: PostgresRow, installationId: string): Readonly<AuditEvent> {
  const namespaceId = optionalText(row, "namespace_id");
  const resourceKind = text(row, "resource_kind");
  const outcome = text(row, "outcome");
  const kind = text(row, "kind");
  if (
    !RESOURCE_KINDS.has(resourceKind) ||
    !["success", "denied", "failure"].includes(outcome) ||
    !["bootstrap", "mutation", "authorization_denial"].includes(kind)
  )
    throw new DependencyUnavailableError("Persisted audit evidence contains an invalid event.");

  const rawDetails = row.details === null ? undefined : jsonObject(row.details);
  const details = rawDetails === undefined ? undefined : { ...rawDetails };
  const rawMetadata = details?.[AUDIT_METADATA_KEY];
  if (details !== undefined) delete details[AUDIT_METADATA_KEY];
  const metadata = rawMetadata === undefined ? {} : jsonObject(rawMetadata);

  return immutableCopy({
    id: text(row, "id"),
    installationId,
    ...(namespaceId === undefined ? {} : { namespaceId }),
    occurredAt: timestamp(row, "occurred_at"),
    kind: kind as AuditEvent["kind"],
    actorId: text(row, "actor_id"),
    action: text(row, "action"),
    resource: {
      kind: resourceKind as AuditEvent["resource"]["kind"],
      id: text(row, "resource_id"),
      ...(namespaceId === undefined ? {} : { namespaceId }),
    },
    outcome: outcome as AuditEvent["outcome"],
    ...metadata,
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
  });
}

function permissions(value: unknown): readonly Permission[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed))
    throw new DependencyUnavailableError("Persisted IAM permissions must be an array.");
  return Object.freeze(
    parsed.map((permission): Permission => {
      if (
        permission === null ||
        typeof permission !== "object" ||
        typeof permission.action !== "string" ||
        !PERMISSION_ACTIONS.has(permission.action) ||
        typeof permission.resourceKind !== "string" ||
        !RESOURCE_KINDS.has(permission.resourceKind)
      )
        throw new DependencyUnavailableError("Persisted IAM permissions are invalid.");
      return immutableCopy({
        action: permission.action as Permission["action"],
        resourceKind: permission.resourceKind as Permission["resourceKind"],
      });
    }),
  );
}

export class PostgresPlatformState implements PlatformStateStore {
  readonly auditSink: PlatformAuditSink;
  private readonly pool: PostgresPool;
  private readonly turnJournal: PostgresTurnJournalOptions | undefined;
  private bootstrapNativeIAM: PersistedNativeIAMState | undefined;
  private readonly contexts = new WeakMap<PlatformReadView, TransactionContext>();

  constructor(pool: PostgresPool, options: PostgresPlatformStateOptions = {}) {
    this.pool = pool;
    this.turnJournal = options.turnJournal;
    this.bootstrapNativeIAM = options.bootstrapNativeIAM;
    this.auditSink = {
      append: async (event) => this.transact(async (state) => state.audit.append(event)),
    };
  }

  setBootstrapNativeIAM(state: PersistedNativeIAMState): void {
    this.bootstrapNativeIAM = state;
  }

  async loadInstallation(): Promise<Readonly<Installation> | undefined> {
    return this.read(async (state) => state.installations.getInstallation());
  }

  async loadNativeIAMState(installationId?: string): Promise<PersistedNativeIAMState> {
    return this.execute(true, async (_state, context) => {
      const installation = await this.currentInstallation(context);
      if (installation === undefined) {
        if (this.bootstrapNativeIAM !== undefined) return this.bootstrapNativeIAM;
        throw new DependencyUnavailableError("The platform Installation has not been initialized.");
      }
      if (installationId !== undefined && installation.id !== installationId)
        throw new ScopeViolationError("IAM state belongs to another Installation.");

      const identityRows = rows(
        (
          await context.client.query(
            "SELECT id, namespace_id, agent_id, kind, issuer, subject FROM occ.iam_identities ORDER BY id",
          )
        ).rows,
      );
      const roleRows = rows(
        (
          await context.client.query(
            "SELECT id, namespace_id, name, permissions FROM occ.iam_roles ORDER BY id",
          )
        ).rows,
      );
      const groupRows = rows(
        (
          await context.client.query(
            "SELECT id, namespace_id, name FROM occ.iam_groups ORDER BY id",
          )
        ).rows,
      );
      const membershipRows = rows(
        (
          await context.client.query(
            `SELECT namespace_id, group_id, principal_id
             FROM occ.iam_group_memberships ORDER BY group_id, principal_id`,
          )
        ).rows,
      );
      const bindingRows = rows(
        (
          await context.client.query(
            `SELECT id, namespace_id, identity_subject_id, group_subject_id, role_id,
                    resource_kind, resource_id, channel_administration
             FROM occ.iam_access_bindings ORDER BY id`,
          )
        ).rows,
      );
      const restrictionRows = rows(
        (
          await context.client.query(
            `SELECT id, namespace_id, action, resource_kind, resource_id, effect
             FROM occ.iam_restrictions ORDER BY id`,
          )
        ).rows,
      );

      const identities = identityRows.map((row): Identity => {
        const id = text(row, "id");
        const kind = text(row, "kind");
        const namespaceId = optionalText(row, "namespace_id");
        if (kind === "principal")
          return immutableCopy({
            id,
            kind,
            issuer: text(row, "issuer"),
            subject: text(row, "subject"),
          });
        if (kind === "service_principal") {
          const agentId = optionalText(row, "agent_id");
          if (agentId !== undefined && namespaceId === undefined)
            throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
          return immutableCopy({
            id,
            kind,
            ...(namespaceId === undefined ? {} : { namespaceId }),
            ...(agentId === undefined ? {} : { agentId }),
          });
        }
        throw new DependencyUnavailableError("Persisted IAM identity has an invalid owner.");
      });

      const roles = roleRows.map((row): Role => {
        const namespaceId = optionalText(row, "namespace_id");
        const name = optionalText(row, "name");
        return immutableCopy({
          id: text(row, "id"),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          ...(name === undefined ? {} : { name }),
          permissions: permissions(row.permissions),
        });
      });

      const groups = groupRows.map((row): Group => {
        const namespaceId = optionalText(row, "namespace_id");
        return immutableCopy({
          id: text(row, "id"),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          name: text(row, "name"),
        });
      });

      const memberships = membershipRows.map((row): GroupMembership => {
        const namespaceId = optionalText(row, "namespace_id");
        return immutableCopy({
          ...(namespaceId === undefined ? {} : { namespaceId }),
          groupId: text(row, "group_id"),
          principalId: text(row, "principal_id"),
        });
      });

      const bindings = bindingRows.map((row): AccessBinding => {
        const namespaceId = optionalText(row, "namespace_id");
        const resourceKind = optionalText(row, "resource_kind");
        const resourceId = optionalText(row, "resource_id");
        if (
          (resourceKind === undefined) !== (resourceId === undefined) ||
          (resourceKind !== undefined && !RESOURCE_KINDS.has(resourceKind))
        )
          throw new DependencyUnavailableError("Persisted IAM binding has an invalid resource.");
        const identitySubjectId = optionalText(row, "identity_subject_id");
        const groupSubjectId = optionalText(row, "group_subject_id");
        if ((identitySubjectId === undefined) === (groupSubjectId === undefined))
          throw new DependencyUnavailableError("Persisted IAM binding has an ambiguous subject.");
        const mapping =
          row.channel_administration === null || row.channel_administration === undefined
            ? undefined
            : decodeChannelAdministrationMappingV1(row.channel_administration);
        if (mapping?.kind === "invalid")
          throw new DependencyUnavailableError("Persisted IAM channel administration is invalid.");
        return immutableCopy({
          id: text(row, "id"),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          subjectKind: identitySubjectId === undefined ? "group" : "identity",
          subjectId: identitySubjectId ?? groupSubjectId!,
          roleId: text(row, "role_id"),
          ...(resourceKind === undefined
            ? {}
            : { resourceKind: resourceKind as NonNullable<AccessBinding["resourceKind"]> }),
          ...(resourceId === undefined ? {} : { resourceId }),
          ...(mapping === undefined ? {} : { channelAdministration: mapping.value }),
        });
      });

      const restrictions = restrictionRows.map((row): Restriction => {
        const namespaceId = optionalText(row, "namespace_id");
        const action = text(row, "action");
        const resourceKind = text(row, "resource_kind");
        const resourceId = optionalText(row, "resource_id");
        if (
          !PERMISSION_ACTIONS.has(action) ||
          !RESOURCE_KINDS.has(resourceKind) ||
          text(row, "effect") !== "deny"
        )
          throw new DependencyUnavailableError("Persisted IAM restriction is invalid.");
        return immutableCopy({
          id: text(row, "id"),
          ...(namespaceId === undefined ? {} : { namespaceId }),
          action: action as Restriction["action"],
          resourceKind: resourceKind as Restriction["resourceKind"],
          ...(resourceId === undefined ? {} : { resourceId }),
          effect: "deny",
        });
      });

      const state = { identities, groups, memberships, roles, bindings, restrictions };
      this.validateIAMState(state, true);
      return immutableCopy(state);
    });
  }

  async seedNativeIAM(state: PersistedNativeIAMState): Promise<void> {
    return this.transact(async (unit) => {
      const context = this.contexts.get(unit);
      if (context === undefined)
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      const installation = await this.currentInstallation(context);
      if (installation === undefined)
        throw new ScopeViolationError("IAM state requires an initialized Installation.");
      await this.insertIAMState(context, state);
    });
  }

  async appendNativeIAMPrincipal(
    seed: PersistedNativeIAMPrincipalSeed,
    auditEvent?: AuditEvent,
  ): Promise<PersistedNativeIAMState> {
    let installationId: string | undefined;
    await this.transact(async (unit) => {
      const context = this.contexts.get(unit);
      if (context === undefined)
        throw new DependencyUnavailableError("The platform transaction is unavailable.");
      const installation = await this.currentInstallation(context);
      if (installation === undefined)
        throw new ScopeViolationError("IAM state requires an initialized Installation.");
      installationId = installation.id;
      if (seed.roles.length > 0)
        throw new ScopeViolationError("Account provisioning must bind an existing IAM Role.");
      for (const binding of seed.bindings) {
        if (
          binding.subjectKind !== "identity" ||
          binding.subjectId !== seed.principal.id ||
          binding.resourceKind !== "installation" ||
          binding.resourceId !== installation.id ||
          binding.namespaceId !== undefined
        )
          throw new ScopeViolationError(
            "Account provisioning requires an exact Installation binding.",
          );
      }
      await context.client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          seed.principal.id,
          null,
          null,
          seed.principal.kind,
          seed.principal.issuer,
          seed.principal.subject,
        ],
      );
      for (const binding of seed.bindings) {
        const mapping =
          binding.channelAdministration === undefined
            ? undefined
            : decodeChannelAdministrationMappingV1(binding.channelAdministration);
        if (mapping?.kind === "invalid")
          throw new DependencyUnavailableError("IAM channel administration is invalid.");
        await context.client.query(
          `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, group_subject_id, role_id,
            resource_kind, resource_id, channel_administration)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            binding.id,
            null,
            binding.subjectId,
            null,
            binding.roleId,
            binding.resourceKind,
            binding.resourceId,
            mapping === undefined ? null : JSON.stringify(mapping.value),
          ],
        );
      }
      if (auditEvent !== undefined) await unit.audit.append(auditEvent);
    });
    return this.loadNativeIAMState(installationId);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async read<T>(
    work: (state: PlatformReadView) => Promise<T>,
    options?: PlatformReadOptions,
  ): Promise<T> {
    return this.execute(
      true,
      async (state, context) => {
        const view = createPlatformReadView(state, context.lifetime);
        context.readView = view;
        this.contexts.set(view, context);
        return work(view);
      },
      options,
    );
  }

  async transact<T>(work: (state: PlatformUnitOfWork) => Promise<T>): Promise<T> {
    return this.execute(false, async (state) => work(state));
  }

  queryInTransaction(
    unit: PlatformReadView,
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    const context = this.contexts.get(unit);
    if (context === undefined)
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    return context.lifetime.run(() => context.client.query(statement, parameters));
  }

  providerAccountLinksInTransaction(unit: PlatformReadView): ProviderAccountLinks {
    const context = this.contexts.get(unit);
    if (context === undefined)
      throw new DependencyUnavailableError("The platform transaction is unavailable.");
    const links = createPostgresProviderAccountLinks({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => context.client.query(statement, parameters) },
    });
    return bindRepository(links, context.lifetime, ["create", "find", "recordCredential"]);
  }

  async transactWithQueue<T>(
    work: (state: PlatformUnitOfWork, queue: PostgresWorkQueue) => Promise<T>,
    options: PostgresWorkQueueOptions = {},
  ): Promise<T> {
    return this.execute(false, async (state, context) =>
      work(
        state,
        new Proxy(new PostgresWorkQueue(context.client, options), {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function"
              ? (...args: unknown[]) =>
                  context.lifetime.run(async () => Reflect.apply(value, target, args))
              : value;
          },
        }),
      ),
    );
  }

  private async execute<T>(
    readOnly: boolean,
    work: (state: PlatformUnitOfWork, context: TransactionContext) => Promise<T>,
    options?: PlatformReadOptions,
  ): Promise<T> {
    // pg exposes no per-checkout cancellation. Its configured timeout actually removes
    // the waiter; join that bounded checkout before returning an interrupted read.
    const acquisitionTimeout = this.pool.options?.connectionTimeoutMillis;
    if (
      options !== undefined &&
      (options.signal.aborted ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 3000 ||
        acquisitionTimeout === undefined ||
        acquisitionTimeout <= 0 ||
        acquisitionTimeout > 250 ||
        !Number.isFinite(acquisitionTimeout) ||
        this.pool.options?.pipeline === true ||
        this.pool.options?.onConnect !== undefined ||
        this.pool.options?.verify !== undefined ||
        this.pool.options?.Client !== undefined)
    )
      throw new DependencyUnavailableError(
        "Bounded platform reads require a bounded PostgreSQL pool.",
      );
    const readBegan = performance.now();
    const lifetime = new RepositoryTransactionLifetime();
    let expired = false;
    let closed = false;
    let released = false;
    let raw: PostgresClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: ((error: Error) => void) | undefined;
    const pending = new Set<Promise<unknown>>();
    const abortFailure = () => new DependencyUnavailableError("The platform read expired.");
    const release = (destroy: boolean) => {
      if (raw !== undefined && !released) {
        released = true;
        raw.release(destroy);
      }
    };
    const abort = () => {
      lifetime.close();
      expired = true;
      closed = true;
      release(true);
      rejectAbort?.(abortFailure());
    };
    const cancelled =
      options === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          });
    // Rejection can precede acquisition settlement; attach a handler immediately.
    void cancelled?.catch(() => {});
    if (options !== undefined) {
      options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, Math.ceil(options.timeoutMs));
    }
    let client: PostgresClient | undefined;
    let started = false;
    let committing = false;
    let discardClient = false;
    let unit: PlatformUnitOfWork | undefined;
    let context: TransactionContext | undefined;
    const authorityGuard = new RuntimeAuthorityTransactionGuard();
    const journalGuard = new TurnJournalTransactionGuard();
    const onTransportError = () => {
      discardClient = true;
    };
    try {
      raw = await this.pool.connect();
      raw.on?.("error", onTransportError);
      if (expired || options?.signal.aborted) {
        release(true);
        throw abortFailure();
      }
      const underlying = raw;
      client = {
        query: async (statement, parameters) => {
          lifetime.assertActive();
          if (closed || options?.signal.aborted) throw abortFailure();
          const query = underlying.query(statement, parameters);
          pending.add(query);
          try {
            const result = await query;
            lifetime.assertActive();
            return result;
          } finally {
            pending.delete(query);
          }
        },
        release: (destroy) => release(destroy ?? false),
      };
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      started = true;
      if (options !== undefined) {
        // PostgreSQL also detects a disappeared client during a blocked query. The
        // server statement limit independently bounds resource lifetime on transport loss.
        const remaining = Math.max(
          1,
          Math.floor(options.timeoutMs - (performance.now() - readBegan)),
        );
        await client.query(
          "SELECT set_config('statement_timeout',$1,true), set_config('transaction_timeout',$1,true), set_config('idle_in_transaction_session_timeout',$1,true)",
          [`${remaining}ms`],
        );
        await client.query("SET LOCAL client_connection_check_interval = '100ms'");
      }
      context = {
        lifetime,
        authorityGuard,
        journalGuard,
        client,
        installation: undefined,
        installationLoaded: false,
      };
      unit = bindPlatformUnitOfWork(this.repositories(context), lifetime);
      journalGuard.bind(unit);
      this.contexts.set(unit, context);
      const activeContext = context;
      const running = Promise.resolve().then(() => work(unit!, activeContext));
      const result = await (cancelled === undefined ? running : Promise.race([running, cancelled]));
      await lifetime.finish();
      await authorityGuard.finish();
      await journalGuard.finish();
      if (expired || options?.signal.aborted) throw abortFailure();
      committing = true;
      const acknowledgement = await raw.query("COMMIT");
      committing = false;
      started = false;
      if (!("command" in acknowledgement) || acknowledgement.command !== "COMMIT")
        throw new DependencyUnavailableError("The database transaction did not commit.");
      // Claims stay provisional through every nested callback and uncertain COMMIT.
      // This marker performs no external work; initiation waits for the outer return.
      if (!readOnly) journalGuard.confirmCommitted();
      if (expired || options?.signal.aborted) throw abortFailure();
      return result;
    } catch (error) {
      await lifetime.finish();
      try {
        await authorityGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      try {
        await journalGuard.finish();
      } catch {
        /* Preserve the original failure. */
      }
      if (started && !released && raw !== undefined) {
        try {
          await raw.query("ROLLBACK");
        } catch {
          discardClient = true;
        }
      }
      const unknownCommit = committing && !readOnly && commitOutcomeUnknown(error);
      discardClient ||= unknownCommit || expired;
      throw unknownCommit ? new PostgresCommitOutcomeUnknownError() : databaseError(error);
    } finally {
      journalGuard.close();
      lifetime.close();
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      options?.signal.removeEventListener("abort", abort);
      if (unit !== undefined) this.contexts.delete(unit);
      if (context?.readView !== undefined) this.contexts.delete(context.readView);
      release(discardClient || expired);
      // Destroying an active pg client rejects active/queued queries. Join their rejection
      // before reporting cancellation, and forbid any later callback from reusing it.
      await Promise.allSettled([...pending]);
      raw?.removeListener?.("error", onTransportError);
    }
  }

  private async currentInstallation(
    context: TransactionContext,
  ): Promise<Readonly<Installation> | undefined> {
    if (!context.installationLoaded) {
      const candidates = rows(
        (
          await context.client.query(
            "SELECT id, name, created_at FROM occ.installation ORDER BY id LIMIT 2",
          )
        ).rows,
      );
      if (candidates.length > 1)
        throw new DependencyUnavailableError("The platform Installation is ambiguous.");
      context.installation =
        candidates[0] === undefined ? undefined : installationFromRow(candidates[0]);
      context.installationLoaded = true;
    }
    return context.installation;
  }

  private async requireInitialized(context: TransactionContext): Promise<Readonly<Installation>> {
    const installation = await this.currentInstallation(context);
    if (installation === undefined)
      throw new ScopeViolationError("The server-owned Installation has not been initialized.");
    return installation;
  }

  private async requireInstallation(
    context: TransactionContext,
    installationId: string,
  ): Promise<Readonly<Installation>> {
    const installation = await this.requireInitialized(context);
    if (installation.id !== installationId)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
    return installation;
  }

  private repositories(context: TransactionContext): PlatformUnitOfWork {
    const { client } = context;
    const queue = new PostgresWorkQueue(client);

    const installations: InstallationRepository = {
      findInstallation: async (installationId) => {
        const installation = await this.currentInstallation(context);
        return installation?.id === installationId ? immutableCopy(installation) : undefined;
      },
      getInstallation: async () => {
        const installation = await this.currentInstallation(context);
        return installation === undefined ? undefined : immutableCopy(installation);
      },
      createInstallation: async (installation) => {
        if ((await this.currentInstallation(context)) !== undefined)
          throw new ResourceConflictError("An Installation has already been bootstrapped.");
        await client.query(
          "INSERT INTO occ.installation (id, name, created_at) VALUES ($1, $2, $3)",
          [installation.id, installation.name, installation.createdAt],
        );
        context.installation = immutableCopy(installation);
        context.installationLoaded = true;
        if (this.bootstrapNativeIAM !== undefined)
          await this.insertIAMState(context, this.bootstrapNativeIAM);
        return immutableCopy(installation);
      },
    };

    const namespaces = createPostgresNamespaceRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
    });

    const validateSecretBindingsAvailable = async (
      namespaceId: string,
      bindings: SecretBindings | undefined,
    ): Promise<void> => {
      const secretIds = referencedSecretIds(namespaceId, bindings);
      if (secretIds.length === 0) return;
      const found = rows(
        (
          await client.query(
            `SELECT id FROM occ.secrets
             WHERE namespace_id = $1 AND id = ANY($2::text[])
             ORDER BY id`,
            [namespaceId, secretIds],
          )
        ).rows,
      );
      if (found.length !== secretIds.length)
        throw new ScopeViolationError("Secret bindings reference unavailable Secret metadata.");
    };

    const configurations = createPostgresConfigurationRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      namespaces,
      serializeSecretBindings,
      validateSecretBindingsAvailable,
      secretBindingsFromJson,
      rows,
      text,
      timestamp,
    });

    const secrets = createPostgresSecretRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      requireInitialized: () => this.requireInitialized(context),
      namespaces,
      rows,
      text,
      timestamp,
    });

    const findServiceAccount = async (
      namespaceId: string,
      serviceAccountId: string,
      lock = false,
    ): Promise<Readonly<ServiceAccount> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT s.id, s.namespace_id, s.name, s.credential
             FROM occ.service_accounts AS s
             JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
             WHERE s.namespace_id = $1 AND s.id = $2${lock ? " FOR UPDATE OF s" : ""}`,
            [namespaceId, serviceAccountId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : serviceAccountFromRow(found);
    };

    const serviceAccounts: ServiceAccountRepository = {
      findServiceAccount,
      listServiceAccounts: async (namespaceId) =>
        Object.freeze(
          rows(
            (
              await client.query(
                `SELECT s.id, s.namespace_id, s.name, s.credential
                 FROM occ.service_accounts AS s
                 JOIN occ.namespaces AS n ON n.id = s.namespace_id AND n.deleted_at IS NULL
                 WHERE s.namespace_id = $1
                 ORDER BY s.name, s.id`,
                [namespaceId],
              )
            ).rows,
          ).map(serviceAccountFromRow),
        ),
      findServiceAccountProviderBinding: async (namespaceId, serviceAccountId) => {
        const found = rows(
          (
            await client.query(
              `SELECT b.provider_id, b.driver_id, b.workspace_id,
                      b.external_credential_id IS NOT NULL AS credential_issued
               FROM occ.service_account_driver_bindings AS b
               JOIN occ.namespaces AS n ON n.id = b.namespace_id AND n.deleted_at IS NULL
               WHERE b.namespace_id = $1 AND b.service_account_id = $2`,
              [namespaceId, serviceAccountId],
            )
          ).rows,
        )[0];
        return found === undefined
          ? undefined
          : immutableCopy({
              providerId: text(found, "provider_id"),
              driverId: text(found, "driver_id"),
              workspaceId: text(found, "workspace_id"),
              credentialIssued: found.credential_issued === true,
            });
      },
      lockServiceAccount: async (namespaceId, serviceAccountId) =>
        findServiceAccount(namespaceId, serviceAccountId, true),
      createServiceAccount: async (account) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(account.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        )
          throw new ScopeViolationError("The ServiceAccount belongs to an unavailable Namespace.");
        await client.query(
          `INSERT INTO occ.service_accounts
           (id, namespace_id, name, credential)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            account.id,
            account.namespaceId,
            account.name,
            account.credential === undefined ? null : JSON.stringify(account.credential),
          ],
        );
        return immutableCopy(account);
      },
      updateCredential: async (namespaceId, serviceAccountId, credential) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.service_accounts AS s
               SET credential = $3::jsonb
               FROM occ.namespaces AS n
               WHERE s.namespace_id = $1 AND s.id = $2
                 AND n.id = s.namespace_id AND n.deleted_at IS NULL
               RETURNING s.id, s.namespace_id, s.name, s.credential`,
              [namespaceId, serviceAccountId, JSON.stringify(credential)],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : serviceAccountFromRow(updated);
      },
      deleteServiceAccount: async (namespaceId, serviceAccountId) => {
        const deleted = await client.query(
          `DELETE FROM occ.service_accounts AS s USING occ.namespaces AS n
           WHERE s.namespace_id = $1 AND s.id = $2
             AND n.id = s.namespace_id AND n.deleted_at IS NULL`,
          [namespaceId, serviceAccountId],
        );
        return deleted.rowCount === 1;
      },
    };

    const findAgent = async (
      namespaceId: string,
      agentId: string,
      lock = false,
    ): Promise<Readonly<Agent> | undefined> => {
      const found = rows(
        (
          await client.query(
            `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                    a.provider_id, a.service_principal_id, a.service_account_id,
                    a.active_revision_id, a.created_at
             FROM occ.agents AS a
             JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
             WHERE a.namespace_id = $1 AND a.id = $2${lock ? " FOR UPDATE OF a" : ""}`,
            [namespaceId, agentId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : agentFromRow(found);
    };

    const agents: AgentRepository = {
      findAgent,
      lockAgent: async (namespaceId, agentId) => findAgent(namespaceId, agentId, true),
      listAgents: async (namespaceId) => {
        const found = rows(
          (
            await client.query(
              `SELECT a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                      a.provider_id, a.service_principal_id, a.service_account_id,
                      a.active_revision_id, a.created_at
               FROM occ.agents AS a
               JOIN occ.namespaces AS n ON n.id = a.namespace_id AND n.deleted_at IS NULL
               WHERE a.namespace_id = $1 ORDER BY a.created_at, a.id`,
              [namespaceId],
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => agentFromRow(row)));
      },
      createAgent: async (agent) => {
        await this.requireInitialized(context);
        const namespace = await namespaces.lockNamespace(agent.namespaceId);
        if (
          namespace === undefined ||
          (namespace.status !== "provisioning" && namespace.status !== "ready")
        )
          throw new ScopeViolationError("The Agent belongs to an unavailable Namespace.");
        const configuration = await configurations.findConfiguration(
          agent.namespaceId,
          agent.configurationId,
        );
        if (configuration === undefined)
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        await validateSecretBindingsAvailable(agent.namespaceId, configuration.secretBindings);
        await client.query(
          `INSERT INTO occ.agents
           (id, namespace_id, name, configuration_id, provider_id, execution_mode,
             service_principal_id, service_account_id, active_revision_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            agent.id,
            agent.namespaceId,
            agent.name,
            agent.configurationId,
            agent.providerId,
            agent.executionMode,
            agent.servicePrincipalId,
            agent.serviceAccountId ?? null,
            agent.activeRevisionId ?? null,
            agent.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
           VALUES ($1, $2, $3, 'service_principal', NULL, NULL)`,
          [agent.servicePrincipalId, agent.namespaceId, agent.id],
        );
        return immutableCopy(agent);
      },
      updateConfiguration: async (
        namespaceId,
        agentId,
        configurationId,
        executionMode,
        serviceAccountId,
        providerId,
      ) => {
        const configuration = await configurations.findConfiguration(namespaceId, configurationId);
        if (configuration === undefined)
          throw new ScopeViolationError("The Agent references an unavailable Configuration.");
        await validateSecretBindingsAvailable(namespaceId, configuration.secretBindings);
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a
               SET configuration_id = $3, execution_mode = COALESCE($4::text, a.execution_mode),
                   service_account_id = CASE WHEN $5::boolean THEN $6::text ELSE a.service_account_id END,
                   provider_id = CASE WHEN $7::boolean THEN $8::text ELSE a.provider_id END
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.provider_id, a.service_principal_id, a.service_account_id,
                          a.active_revision_id, a.created_at`,
              [
                namespaceId,
                agentId,
                configurationId,
                executionMode ?? null,
                serviceAccountId !== undefined,
                serviceAccountId ?? null,
                providerId !== undefined,
                providerId ?? null,
              ],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
      compareAndSetActiveRevision: async (
        namespaceId,
        agentId,
        expectedRevisionId,
        candidateRevisionId,
      ) => {
        const updated = rows(
          (
            await client.query(
              `UPDATE occ.agents AS a SET active_revision_id = $4
               FROM occ.namespaces AS n
               WHERE a.namespace_id = $1 AND a.id = $2
                 AND a.active_revision_id IS NOT DISTINCT FROM $3::text
                 AND n.id = a.namespace_id AND n.deleted_at IS NULL
                RETURNING a.id, a.namespace_id, a.name, a.configuration_id, a.execution_mode,
                          a.provider_id, a.service_principal_id, a.service_account_id,
                          a.active_revision_id, a.created_at`,
              [namespaceId, agentId, expectedRevisionId ?? null, candidateRevisionId],
            )
          ).rows,
        )[0];
        return updated === undefined ? undefined : agentFromRow(updated);
      },
    };

    const revisions: AgentRevisionRepository = {
      findRevision: async (namespaceId, agentId, revisionId) => {
        const found = rows(
          (
            await client.query(
              `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.provider_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 AND r.id = $3`,
              [namespaceId, agentId, revisionId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : revisionFromRow(found);
      },
      listRevisions: async (namespaceId, agentId) => {
        const found = rows(
          (
            await client.query(
              `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.provider_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 ORDER BY r.revision_number`,
              [namespaceId, agentId],
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => revisionFromRow(row)));
      },
      createRevision: async (revision) => {
        await this.requireInitialized(context);
        const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
        if (
          owner === undefined ||
          owner.servicePrincipalId !== revision.servicePrincipalId ||
          owner.providerId !== revision.providerId ||
          revision.serviceAccount?.id !== owner.serviceAccountId
        )
          throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
        const secretBindings =
          revision.secretBindings === undefined
            ? undefined
            : secretBindingsFromState(revision.secretBindings, revision.namespaceId);
        await validateSecretBindingsAvailable(revision.namespaceId, secretBindings);
        await client.query(
          `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, provider_id, admitted_spec, admitted_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            revision.id,
            revision.namespaceId,
            revision.agentId,
            revision.revision,
            revision.providerId,
            JSON.stringify({
              configuration_id: revision.configurationId,
              configuration_kind: revision.configurationKind,
              configuration_generation: revision.configurationGeneration,
              draft_spec: revision.configuration,
              harness: revision.harness,
              compute: revision.compute,
              ...(revision.sandboxDriverId === undefined
                ? {}
                : { sandbox_driver_id: revision.sandboxDriverId }),
              ...(revision.secretDriverId === undefined
                ? {}
                : { secret_driver_id: revision.secretDriverId }),
              ...(secretBindings === undefined ? {} : { secret_bindings: secretBindings }),
              ...(revision.serviceAccount === undefined
                ? {}
                : { service_account: revision.serviceAccount }),
            }),
            revision.createdAt,
          ],
        );
        const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = revision;
        return immutableCopy({
          ...withoutSecretBindings,
          ...(secretBindings === undefined ? {} : { secretBindings }),
        });
      },
    };

    const runtimeOwner = async (scope: RuntimeScope, writing = false) => {
      const installation = await this.currentInstallation(context);
      const namespace = writing
        ? await namespaces.lockNamespace(scope.namespaceId)
        : await namespaces.findNamespace(scope.namespaceId);
      const agent = writing
        ? await agents.lockAgent(scope.namespaceId, scope.agentId)
        : await agents.findAgent(scope.namespaceId, scope.agentId);
      if (
        installation === undefined ||
        namespace === undefined ||
        agent === undefined ||
        (writing && namespace.status !== "ready")
      )
        return undefined;
      return { installation, agent };
    };
    const channelBindings = createPostgresChannelBindingRepository({
      get scope() {
        context.lifetime.assertActive();
        if (context.installation === undefined)
          throw new ScopeViolationError("The server-owned Installation has not been initialized.");
        return { installationId: context.installation.id };
      },
      transaction: { assertActive: () => context.lifetime.assertActive() },
      query: { query: (statement, parameters) => client.query(statement, parameters) },
      currentInstallation: () => this.currentInstallation(context),
    });

    const runtimeAssignments: RuntimeAssignmentRepository = {
      findRuntimeIntent: async (scope, transitionRef) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              "SELECT * FROM occ.agent_runtime_intents WHERE namespace_id = $1 AND agent_id = $2 AND transition_ref = $3",
              [scope.namespaceId, scope.agentId, transitionRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeIntentFromRow(found);
      },
      findRuntimeIntentHead: async (scope) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              "SELECT intent.* FROM occ.agent_runtime_intents intent JOIN occ.agent_runtime_intent_heads head USING (namespace_id, agent_id, generation, transition_ref) WHERE head.namespace_id = $1 AND head.agent_id = $2",
              [scope.namespaceId, scope.agentId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeIntentFromRow(found);
      },
      findRuntimeAllocation: async (scope, locator) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              `SELECT * FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND ${locator.assignmentRef !== undefined ? "assignment_ref" : "create_effect_ref"} = $3`,
              [scope.namespaceId, scope.agentId, locator.assignmentRef ?? locator.createEffectRef],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : runtimeAllocationFromRow(found);
      },
      initializeRuntimeIntent: async (scope, revisionId, transitionRef, attribution) =>
        saveRuntimeIntent(
          scope,
          0,
          { desiredMode: "running", revisionId },
          transitionRef,
          attribution,
        ),
      advanceRuntimeIntent: async (scope, expectedGeneration, next, transitionRef, attribution) => {
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
          throw new ResourceConflictError("The runtime intent generation is invalid.");
        return saveRuntimeIntent(scope, expectedGeneration, next, transitionRef, attribution);
      },
      allocateUnboundRuntime: async (
        scope,
        expectedLifecycleGeneration,
        component,
        expectedRuntimeGeneration,
        createEffectRef,
        profileRefs,
      ) => {
        if (
          profileRefs === null ||
          typeof profileRefs !== "object" ||
          Object.keys(profileRefs).sort().join(",") !==
            "identityProfileRef,providerProfileRef,runtimeProfileRef"
        )
          throw new ScopeViolationError("The runtime profile reference shape is invalid.");
        const owner = await runtimeOwner(scope, true);
        if (owner === undefined) throw new ScopeViolationError("The runtime owner is unavailable.");
        const existing = rows(
          (
            await client.query(
              "SELECT * FROM occ.runtime_assignment_allocations WHERE create_effect_ref = $1",
              [createEffectRef],
            )
          ).rows,
        )[0];
        if (existing !== undefined) {
          const saved = runtimeAllocationFromRow(existing);
          if (
            saved.namespaceId !== scope.namespaceId ||
            saved.agentId !== scope.agentId ||
            saved.lifecycleGeneration !== expectedLifecycleGeneration ||
            saved.component !== component ||
            saved.runtimeGeneration !== expectedRuntimeGeneration + 1 ||
            saved.providerProfileRef !== profileRefs.providerProfileRef ||
            saved.runtimeProfileRef !== profileRefs.runtimeProfileRef ||
            saved.identityProfileRef !== profileRefs.identityProfileRef
          )
            throw new ResourceConflictError(
              "The runtime create effect conflicts with its stored allocation.",
            );
          return saved;
        }
        const head = await runtimeAssignments.findRuntimeIntentHead(scope);
        if (
          head === undefined ||
          head.generation !== expectedLifecycleGeneration ||
          head.desiredMode !== "running"
        )
          throw new ResourceConflictError("The running runtime intent does not match.");
        // Every allocator holds the same Agent lock before reading its component sequence.
        const latest = rows(
          (
            await client.query(
              "SELECT runtime_generation FROM occ.runtime_assignment_allocations WHERE namespace_id = $1 AND agent_id = $2 AND component = $3 ORDER BY runtime_generation DESC LIMIT 1",
              [scope.namespaceId, scope.agentId, component],
            )
          ).rows,
        )[0];
        const prior = latest === undefined ? 0 : runtimeGeneration(latest, "runtime_generation");
        if (prior !== expectedRuntimeGeneration || !Number.isSafeInteger(prior + 1))
          throw new ResourceConflictError("The runtime allocation generation does not match.");
        const found = rows(
          (
            await client.query(
              `INSERT INTO occ.runtime_assignment_allocations
          (assignment_ref, create_effect_ref, installation_id, namespace_id, agent_id, revision_id, service_principal_id, lifecycle_generation, component, runtime_generation, provider_profile_ref, runtime_profile_ref, identity_profile_ref, binding_condition, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'unbound',clock_timestamp()) RETURNING *`,
              [
                randomUUID(),
                createEffectRef,
                owner.installation.id,
                scope.namespaceId,
                scope.agentId,
                head.revisionId,
                owner.agent.servicePrincipalId,
                head.generation,
                component,
                prior + 1,
                profileRefs.providerProfileRef,
                profileRefs.runtimeProfileRef,
                profileRefs.identityProfileRef,
              ],
            )
          ).rows,
        )[0];
        return runtimeAllocationFromRow(found!);
      },
    };
    async function saveRuntimeIntent(
      scope: RuntimeScope,
      expected: number,
      next: Pick<RuntimeIntent, "desiredMode" | "revisionId">,
      transitionRef: string,
      attribution: RuntimeIntentAttribution,
    ): Promise<Readonly<RuntimeIntent>> {
      const owner = await runtimeOwner(scope, true);
      if (
        owner === undefined ||
        !(await revisions.findRevision(scope.namespaceId, scope.agentId, next.revisionId))
      )
        throw new ScopeViolationError("The runtime owner or revision is unavailable.");
      const head = await runtimeAssignments.findRuntimeIntentHead(scope);
      if ((head?.generation ?? 0) !== expected || !Number.isSafeInteger(expected + 1))
        throw new ResourceConflictError("The runtime intent transition conflicts.");
      const found = rows(
        (
          await client.query(
            `INSERT INTO occ.agent_runtime_intents
        (transition_ref,installation_id,namespace_id,agent_id,generation,desired_mode,revision_id,actor_id,request_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) RETURNING *`,
            [
              transitionRef,
              owner.installation.id,
              scope.namespaceId,
              scope.agentId,
              expected + 1,
              next.desiredMode,
              next.revisionId,
              attribution.actorId,
              attribution.requestId,
            ],
          )
        ).rows,
      )[0];
      if (expected === 0) {
        await client.query(
          "INSERT INTO occ.agent_runtime_intent_heads (namespace_id,agent_id,generation,transition_ref) VALUES ($1,$2,1,$3)",
          [scope.namespaceId, scope.agentId, transitionRef],
        );
      } else {
        const updated = await client.query(
          "UPDATE occ.agent_runtime_intent_heads SET generation = $3, transition_ref = $4 WHERE namespace_id = $1 AND agent_id = $2 AND generation = $5 RETURNING agent_id",
          [scope.namespaceId, scope.agentId, expected + 1, transitionRef, expected],
        );
        if (updated.rows.length !== 1)
          throw new ResourceConflictError("The runtime intent transition conflicts.");
      }
      return runtimeIntentFromRow(found!);
    }

    const runtimeAdmissions: RuntimeAdmissionRepository = {
      findRevisionAdmission: async (scope, revisionId) => {
        if (!(await runtimeOwner(scope))) return undefined;
        const found = rows(
          (
            await client.query(
              `SELECT * FROM occ.agent_revision_runtime_admissions
           WHERE namespace_id = $1 AND agent_id = $2 AND revision_id = $3`,
              [scope.namespaceId, scope.agentId, revisionId],
            )
          ).rows,
        )[0];
        return found === undefined ? undefined : revisionAdmissionFromRow(found);
      },
      findCommittedAdmission: async (scope, transitionRef, attribution) => {
        if (!(await runtimeOwner(scope))) return undefined;
        // Exact immutable admission and original work, independent of head advancement,
        // lease ownership, completion, and permanently failed reconciliation.
        const found = rows(
          (
            await client.query(
              `SELECT to_jsonb(intent) AS intent,
             to_jsonb(revision) || jsonb_build_object('service_principal_id', agent.service_principal_id) AS revision,
             to_jsonb(audit) AS audit
           FROM occ.agent_revision_runtime_admissions admission
           JOIN occ.agent_runtime_intents intent
             ON intent.namespace_id = admission.namespace_id AND intent.agent_id = admission.agent_id
            AND intent.revision_id = admission.revision_id AND intent.transition_ref = admission.runtime_transition_ref
            AND intent.generation = admission.lifecycle_generation
           JOIN occ.agent_revisions revision
             ON revision.namespace_id = admission.namespace_id AND revision.agent_id = admission.agent_id
            AND revision.id = admission.revision_id
           JOIN occ.agents agent ON agent.namespace_id = revision.namespace_id AND agent.id = revision.agent_id
           JOIN occ.controller_work work
             ON work.idempotency_key = 'agent_revision:' || admission.revision_id || ':reconcile'
            AND work.namespace_id = admission.namespace_id AND work.agent_id = admission.agent_id
            AND work.revision_id = admission.revision_id AND work.runtime_transition_ref = admission.runtime_transition_ref
            AND work.lifecycle_generation = admission.lifecycle_generation AND work.actor_id = intent.actor_id
            AND work.namespace_target IS NULL
           JOIN occ.audit_events audit ON audit.id = admission.audit_event_id
           WHERE admission.namespace_id = $1 AND admission.agent_id = $2
             AND admission.runtime_transition_ref = $3 AND intent.actor_id = $4 AND intent.request_id = $5
             AND intent.desired_mode = 'running'`,
              [
                scope.namespaceId,
                scope.agentId,
                transitionRef,
                attribution.actorId,
                attribution.requestId,
              ],
            )
          ).rows,
        )[0];
        if (found === undefined) return undefined;
        const intent = runtimeIntentFromRow(jsonObject(found.intent));
        const installation = await this.requireInitialized(context);
        if (
          intent.installationId !== installation.id ||
          !isRuntimeAdmissionAudit(auditFromRow(jsonObject(found.audit), installation.id), intent)
        )
          return undefined;
        return revisionFromRow(jsonObject(found.revision));
      },
      recordAdmission: async (admission) => {
        await this.requireInitialized(context);
        await client.query(
          `INSERT INTO occ.agent_revision_runtime_admissions
           (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation, audit_event_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            admission.namespaceId,
            admission.agentId,
            admission.revisionId,
            admission.runtimeTransitionRef,
            admission.lifecycleGeneration,
            admission.auditEventId,
          ],
        );
      },
    };

    function authorityOperation(row: PostgresRow): StoredRuntimeAuthorityOperation {
      const result = parseRuntimeAuthorityV1("operationState", {
        schemaVersion: 1,
        result: "committed",
        receipt: row.receipt,
      });
      if (!("receipt" in result) || typeof row.canonical_payload !== "string")
        throw new DependencyUnavailableError("The runtime authority record is invalid.");
      return immutableCopy({ canonicalPayload: row.canonical_payload, receipt: result.receipt });
    }
    const audit: PlatformAuditRepository = {
      append: async (event) => {
        await this.requireInstallation(context, event.installationId);
        if (event.resource.namespaceId !== event.namespaceId)
          throw new ScopeViolationError("The audit event and resource scopes do not match.");
        const details = auditDetails(event);
        await client.query(
          `INSERT INTO occ.audit_events
             (id, occurred_at, kind, actor_id, action, namespace_id, resource_kind, resource_id,
              outcome, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            event.id,
            event.occurredAt,
            event.kind,
            event.actorId,
            event.action,
            event.namespaceId ?? null,
            event.resource.kind,
            event.resource.id,
            event.outcome,
            details === undefined ? null : JSON.stringify(details),
          ],
        );
      },
      list: async () => {
        const installation = await this.currentInstallation(context);
        if (installation === undefined) return Object.freeze([]);
        const found = rows(
          (
            await client.query(
              `SELECT id, occurred_at, kind, actor_id, action, namespace_id, resource_kind,
                        resource_id, outcome, details
                 FROM occ.audit_events ORDER BY occurred_at, id`,
            )
          ).rows,
        );
        return Object.freeze(found.map((row) => auditFromRow(row, installation.id)));
      },
    };
    const runtimeServiceTrust = createRuntimeServiceTrustRepository(
      {
        lockOperation: async (operationRef) => {
          await client.query("SET LOCAL lock_timeout = '3000ms'");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-operation:' || $1,0))",
            [operationRef],
          );
        },
        lockSubject: async (installationId, kind, subjectRef) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-service-trust-subject:' || $1 || ':' || $2 || ':' || $3,0))",
            [installationId, kind, subjectRef],
          );
        },
        operation: async (operationRef) => {
          const result = await client.query(
            "SELECT record FROM occ.runtime_service_trust_records WHERE operation_ref=$1",
            [operationRef],
          );
          const row = rows(result.rows)[0];
          return row === undefined ? undefined : parseRuntimeServiceTrustRecord(row.record);
        },
        latest: async (installationId, kind, subjectRef) => {
          const result = await client.query(
            "SELECT record FROM occ.runtime_service_trust_records WHERE installation_id=$1 AND subject_kind=$2 AND subject_ref=$3 ORDER BY record_version DESC LIMIT 1",
            [installationId, kind, subjectRef],
          );
          const row = rows(result.rows)[0];
          return row === undefined ? undefined : parseRuntimeServiceTrustRecord(row.record);
        },
        insert: async (record, event) => {
          await audit.append(event);
          await client.query(
            "INSERT INTO occ.runtime_service_trust_records (installation_id,subject_kind,subject_ref,record_version,operation_ref,actor_id,audit_id,canonical_request,request_digest,committed_at,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
            [
              record.installationId,
              record.subjectKind,
              record.subjectRef,
              record.recordVersion,
              record.operationRef,
              record.actorId,
              record.auditId,
              record.canonicalRequest,
              record.requestDigest,
              record.committedAt,
              JSON.stringify(record),
            ],
          );
        },
      },
      { installations, agents, namespaces },
      context.authorityGuard,
    );
    const runtimeAuthority = createRuntimeAuthorityRepository(
      {
        lockOperation: async (operationRef) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('runtime-authority-operation:' || $1, 0))",
            [operationRef],
          );
        },
        allocation: async (scope, assignmentRef, lock) => {
          const installation = await this.currentInstallation(context);
          if (installation?.id !== scope.installationId) return undefined;
          // Use the same Agent lock as intent/assignment writers before any head or version read.
          if (lock)
            await client.query(
              "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
              [scope.namespaceId, scope.agentId],
            );
          const found = rows(
            (
              await client.query(
                "SELECT * FROM occ.runtime_assignment_allocations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4",
                [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
              )
            ).rows,
          )[0];
          return found === undefined ? undefined : runtimeAllocationFromRow(found);
        },
        operations: async (scope, assignmentRef) =>
          rows(
            (
              await client.query(
                "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND assignment_ref=$4 ORDER BY assignment_record_version",
                [scope.installationId, scope.namespaceId, scope.agentId, assignmentRef],
              )
            ).rows,
          ).map(authorityOperation),
        operation: async (operationRef) => {
          const found = rows(
            (
              await client.query(
                "SELECT canonical_payload, receipt FROM occ.runtime_authority_operations WHERE operation_ref=$1",
                [operationRef],
              )
            ).rows,
          )[0];
          return found === undefined ? undefined : authorityOperation(found);
        },
        insert: async ({ canonicalPayload, receipt }) => {
          await client.query(
            `INSERT INTO occ.runtime_authority_operations
          (operation_ref, installation_id, namespace_id, agent_id, assignment_ref, assignment_record_version, operation_kind, canonical_payload, receipt)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              receipt.operationRef,
              receipt.installationId,
              receipt.namespaceId,
              receipt.agentId,
              receipt.assignmentRef.id,
              receipt.assignmentRecordVersion,
              receipt.operationKind,
              canonicalPayload,
              JSON.stringify(receipt),
            ],
          );
        },
      },
      runtimeAssignments,
      context.authorityGuard,
    );
    const runtimePreparation = createPostgresRuntimePreparation(
      {
        get scope() {
          context.lifetime.assertActive();
          if (context.installation === undefined)
            throw new ScopeViolationError(
              "The server-owned Installation has not been initialized.",
            );
          return { installationId: context.installation.id };
        },
        transaction: { assertActive: () => context.lifetime.assertActive() },
        query: { query: (statement, parameters) => client.query(statement, parameters) },
      },
      runtimeAssignments,
      runtimeAdmissions,
      runtimeAuthority,
      context.authorityGuard,
    );
    const turnJournal =
      this.turnJournal === undefined
        ? undefined
        : createPostgresTurnJournal(
            {
              get scope() {
                context.lifetime.assertActive();
                if (context.installation === undefined)
                  throw new ScopeViolationError(
                    "The server-owned Installation has not been initialized.",
                  );
                return { installationId: context.installation.id };
              },
              transaction: { assertActive: () => context.lifetime.assertActive() },
              query: { query: (statement, parameters) => client.query(statement, parameters) },
              currentInstallation: async () => {
                context.lifetime.assertActive();
                const installation = await this.currentInstallation(context);
                context.lifetime.assertActive();
                return installation;
              },
              guard: context.journalGuard,
            },
            this.turnJournal,
          );
    return {
      ...(turnJournal === undefined ? {} : { turnJournal }),
      runtimePreparation,
      runtimeAuthority,
      runtimeServiceTrust,
      channelBindings: serializeChannelBindingMutations(channelBindings),
      runtimeAssignments: serializeRuntimeAssignmentMutations(runtimeAssignments),
      runtimeAdmissions,
      installations,
      namespaces,
      configurations,
      secrets,
      serviceAccounts,
      agents,
      revisions,
      audit,
      operations: {
        append: async (operation) => {
          await this.requireInitialized(context);
          const namespaceId = operation.namespaceId;
          if (namespaceId === undefined)
            throw new ScopeViolationError("Controller work requires an exact Namespace owner.");

          let agentId: string | undefined;
          let revisionId: string | undefined;
          let namespaceTarget: "ready" | "deleted" | undefined;
          if (operation.kind === "namespace") {
            if (namespaceId !== operation.resourceId)
              throw new ScopeViolationError("Namespace work does not match its exact owner.");
            namespaceTarget = operation.target;
          } else if (operation.kind === "agent_revision") {
            revisionId = operation.resourceId;
            const owner = rows(
              (
                await client.query(
                  "SELECT agent_id FROM occ.agent_revisions WHERE namespace_id = $1 AND id = $2",
                  [namespaceId, revisionId],
                )
              ).rows,
            )[0];
            if (owner === undefined)
              throw new ScopeViolationError("AgentRevision work does not match its exact owner.");
            agentId = text(owner, "agent_id");
          } else {
            throw new ScopeViolationError("Unsupported controller work resource kind.");
          }

          await queue.enqueue({
            idempotencyKey: `${operation.kind}:${operation.resourceId}:${operation.action}${
              namespaceTarget === undefined ? "" : `:${namespaceTarget}`
            }`,
            namespaceId,
            ...(agentId === undefined ? {} : { agentId }),
            ...(revisionId === undefined ? {} : { revisionId }),
            ...(namespaceTarget === undefined ? {} : { namespaceTarget }),
            actorId: operation.actorId,
            ...(operation.runtimeTransitionRef === undefined
              ? {}
              : { runtimeTransitionRef: operation.runtimeTransitionRef }),
            ...(operation.lifecycleGeneration === undefined
              ? {}
              : { lifecycleGeneration: operation.lifecycleGeneration }),
          });
        },
        list: async () => {
          await this.requireInitialized(context);
          const found = rows(
            (
              await client.query(
                `SELECT namespace_id, agent_id, revision_id, actor_id, namespace_target,
                        runtime_transition_ref, lifecycle_generation
                 FROM occ.controller_work ORDER BY created_at, idempotency_key`,
              )
            ).rows,
          );
          return Object.freeze(
            found.map((row): Readonly<PlatformOperation> => {
              const namespaceId = text(row, "namespace_id");
              const revisionId = optionalText(row, "revision_id");
              const base = {
                action: "reconcile" as const,
                namespaceId,
                resourceId: revisionId ?? namespaceId,
                actorId: text(row, "actor_id"),
              };
              if (revisionId === undefined) {
                const target = text(row, "namespace_target");
                if (target !== "ready" && target !== "deleted")
                  throw new DependencyUnavailableError(
                    "Persisted Namespace work has an invalid target.",
                  );
                return immutableCopy({ ...base, kind: "namespace", target });
              }
              const runtimeTransitionRef = optionalText(row, "runtime_transition_ref");
              return immutableCopy({
                ...base,
                kind: "agent_revision",
                ...(runtimeTransitionRef === undefined
                  ? {}
                  : {
                      runtimeTransitionRef,
                      lifecycleGeneration: runtimeGeneration(row, "lifecycle_generation"),
                    }),
              });
            }),
          );
        },
      },
    };
  }

  private validateIAMState(state: PersistedNativeIAMState, requireComplete: boolean): void {
    const identities = new Map<string, Identity>();
    const groups = new Map<string, Group>();
    const roles = new Map<string, Role>();
    const membershipKeys = new Set<string>();
    const bindingIds = new Set<string>();
    const restrictionIds = new Set<string>();
    for (const identity of state.identities) {
      if (identities.has(identity.id))
        throw new DependencyUnavailableError("Persisted IAM identities are invalid or ambiguous.");
      identities.set(identity.id, identity);
    }
    for (const group of state.groups) {
      if (groups.has(group.id))
        throw new DependencyUnavailableError("Persisted IAM groups are invalid or ambiguous.");
      groups.set(group.id, group);
    }
    for (const membership of state.memberships) {
      const group = groups.get(membership.groupId);
      const principal = identities.get(membership.principalId);
      const key = `${membership.groupId}\u0000${membership.principalId}`;
      if (
        group === undefined ||
        principal?.kind !== "principal" ||
        group.namespaceId !== membership.namespaceId ||
        membershipKeys.has(key)
      )
        throw new DependencyUnavailableError("Persisted IAM group memberships violate scope.");
      membershipKeys.add(key);
    }
    for (const role of state.roles) {
      if (roles.has(role.id))
        throw new DependencyUnavailableError("Persisted IAM roles are invalid or ambiguous.");
      permissions(role.permissions);
      roles.set(role.id, role);
    }
    for (const binding of state.bindings) {
      const identity =
        binding.subjectKind === "identity" ? identities.get(binding.subjectId) : undefined;
      const group = binding.subjectKind === "group" ? groups.get(binding.subjectId) : undefined;
      const role = roles.get(binding.roleId);
      if (
        bindingIds.has(binding.id) ||
        (binding.subjectKind === "identity" && identity === undefined) ||
        (binding.subjectKind === "group" && group === undefined) ||
        (binding.subjectKind !== "identity" && binding.subjectKind !== "group") ||
        role === undefined ||
        (identity?.namespaceId !== undefined && identity.namespaceId !== binding.namespaceId) ||
        (binding.subjectKind === "group" && group?.namespaceId !== binding.namespaceId) ||
        (role.namespaceId !== undefined && role.namespaceId !== binding.namespaceId) ||
        (binding.resourceKind === undefined) !== (binding.resourceId === undefined) ||
        (binding.resourceKind !== undefined && !RESOURCE_KINDS.has(binding.resourceKind)) ||
        (binding.namespaceId !== undefined && binding.resourceKind === "installation") ||
        (binding.namespaceId !== undefined &&
          binding.resourceKind === "namespace" &&
          binding.resourceId !== undefined &&
          binding.resourceId !== binding.namespaceId)
      )
        throw new DependencyUnavailableError("Persisted IAM access bindings violate exact scope.");
      bindingIds.add(binding.id);
    }
    for (const restriction of state.restrictions) {
      if (
        restrictionIds.has(restriction.id) ||
        restriction.effect !== "deny" ||
        !PERMISSION_ACTIONS.has(restriction.action) ||
        !RESOURCE_KINDS.has(restriction.resourceKind) ||
        (restriction.namespaceId !== undefined &&
          restriction.resourceKind === "namespace" &&
          restriction.resourceId !== undefined &&
          restriction.resourceId !== restriction.namespaceId) ||
        (restriction.namespaceId !== undefined && restriction.resourceKind === "installation")
      )
        throw new DependencyUnavailableError("Persisted IAM restrictions violate exact scope.");
      restrictionIds.add(restriction.id);
    }
    if (
      requireComplete &&
      (!state.identities.some((identity) => identity.kind === "principal") ||
        state.roles.length === 0 ||
        state.bindings.length === 0)
    )
      throw new DependencyUnavailableError("Persisted native IAM state is incomplete.");
  }

  private async insertIAMState(
    context: TransactionContext,
    state: PersistedNativeIAMState,
  ): Promise<void> {
    this.validateIAMState(state, true);
    for (const identity of state.identities) {
      await context.client.query(
        `INSERT INTO occ.iam_identities (id, namespace_id, agent_id, kind, issuer, subject)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          identity.id,
          identity.namespaceId ?? null,
          identity.kind === "service_principal" ? (identity.agentId ?? null) : null,
          identity.kind,
          identity.kind === "principal" ? identity.issuer : null,
          identity.kind === "principal" ? identity.subject : null,
        ],
      );
    }
    for (const role of state.roles) {
      await context.client.query(
        "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
        [role.id, role.namespaceId ?? null, role.name ?? null, JSON.stringify(role.permissions)],
      );
    }
    for (const group of state.groups) {
      await context.client.query(
        "INSERT INTO occ.iam_groups (id, namespace_id, name) VALUES ($1, $2, $3)",
        [group.id, group.namespaceId ?? null, group.name],
      );
    }
    for (const membership of state.memberships) {
      await context.client.query(
        `INSERT INTO occ.iam_group_memberships (namespace_id, group_id, principal_id)
         VALUES ($1, $2, $3)`,
        [membership.namespaceId ?? null, membership.groupId, membership.principalId],
      );
    }
    for (const binding of state.bindings) {
      const mapping =
        binding.channelAdministration === undefined
          ? undefined
          : decodeChannelAdministrationMappingV1(binding.channelAdministration);
      if (mapping?.kind === "invalid")
        throw new DependencyUnavailableError("IAM channel administration is invalid.");
      await context.client.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id,
          resource_kind, resource_id, channel_administration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          binding.id,
          binding.namespaceId ?? null,
          binding.subjectKind === "identity" ? binding.subjectId : null,
          binding.subjectKind === "group" ? binding.subjectId : null,
          binding.roleId,
          binding.resourceKind ?? null,
          binding.resourceId ?? null,
          mapping === undefined ? null : JSON.stringify(mapping.value),
        ],
      );
    }
    for (const restriction of state.restrictions) {
      await context.client.query(
        `INSERT INTO occ.iam_restrictions
         (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          restriction.id,
          restriction.namespaceId ?? null,
          restriction.action,
          restriction.resourceKind,
          restriction.resourceId ?? null,
          restriction.effect,
        ],
      );
    }
  }
}

export { PostgresPlatformState as PostgresPlatformStateStore };
