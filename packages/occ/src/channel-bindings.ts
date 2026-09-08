import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  AuthorizationDecision,
  AuthorizationRequest,
  ChannelAgentBinding,
  ChannelBindingMetadata,
  ChannelBindingPage,
  ChannelHumanBinding,
  ChannelInstallation,
  ChangeChannelBindingStatus,
  CreateChannelAgentBinding,
  CreateChannelHumanBinding,
  CreateChannelInstallation,
  IAMDriver,
  Principal,
  ResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  accountIAMChecksV1,
  accountSemanticRequirementsV1,
  decodeChannelAdministrationEvidenceV1,
  isChannelBindingReference,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "./errors.ts";
import type {
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "./state/platform-state.ts";

import type {
  PreparedReservedChannelInstallationV1,
  ReservedChannelInstallationCurrentnessV1,
  ReservedChannelInstallationProvisionalV1,
} from "./ports/repositories/channel-bindings.ts";

export class ChannelBindingInvalidError extends ScopeViolationError {
  constructor(message = "The channel binding request is invalid.") {
    super(message);
    this.name = "ChannelBindingInvalidError";
  }
}
export class ChannelBindingNotFoundError extends ScopeViolationError {
  constructor() {
    super("The requested channel binding record was not found.");
    this.name = "ChannelBindingNotFoundError";
  }
}
export interface ChannelBindingContext {
  readonly actorId: string;
  readonly requestId: string;
  readonly admissionDecisionId?: string;
  readonly issuer?: string;
  readonly subject?: string;
  /** Opaque one-request object owned by the actual controller admission adapter. */
  readonly humanInvocation?: object;
}
export type HumanChannelAdministrationOperation =
  | "createChannelInstallation"
  | "getChannelInstallation"
  | "listChannelInstallations"
  | "setChannelInstallationStatus"
  | "createChannelHumanBinding"
  | "getChannelHumanBinding"
  | "listChannelHumanBindings"
  | "setChannelHumanBindingStatus";
/** Fixed startup collaborator; completion includes the original state's outer transaction. */
export interface ReservedChannelInstallationCreateV1 {
  readonly state: PlatformStateStore;
  readonly create: (
    prepared: PreparedReservedChannelInstallationV1,
    currentness: ReservedChannelInstallationCurrentnessV1,
  ) => Promise<ReservedChannelInstallationProvisionalV1>;
}
const reservedChannelInstallationAttemptsV1 = new WeakMap<
  PreparedReservedChannelInstallationV1,
  {
    readonly state: PlatformStateStore;
    readonly currentness: ReservedChannelInstallationCurrentnessV1;
    active: boolean;
    consumed: boolean;
  }
>();

/** Reject-only observation of one original service attempt; it cannot issue an attempt. */
export function consumeReservedChannelInstallationAttemptV1(
  prepared: PreparedReservedChannelInstallationV1,
  state: PlatformStateStore,
  currentness: ReservedChannelInstallationCurrentnessV1,
): boolean {
  const attempt = reservedChannelInstallationAttemptsV1.get(prepared);
  if (
    attempt === undefined ||
    !attempt.active ||
    attempt.consumed ||
    attempt.state !== state ||
    attempt.currentness !== currentness
  )
    return false;
  attempt.consumed = true;
  return true;
}

export interface ChannelBindingServiceOptions {
  readonly reservedChannelInstallationCreate?: ReservedChannelInstallationCreateV1;
  readonly installationId: string;
  readonly state: PlatformStateStore;
  readonly iam: () => IAMDriver;
}
export interface ChannelBindingListQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

type Check = { readonly request: AuthorizationRequest; readonly decision: AuthorizationDecision };
const uuidSuffix = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
function recordId(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_${uuidSuffix}$`).test(value)) throw new ChannelBindingInvalidError();
}
function references(...values: unknown[]): void {
  if (!values.every(isChannelBindingReference)) throw new ChannelBindingInvalidError();
}
function closed(value: object, keys: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  )
    throw new ChannelBindingInvalidError();
}
export function selectedChannelIAM(options: ChannelBindingServiceOptions): IAMDriver {
  try {
    const driver = options.iam();
    if (driver.capability !== "iam" || !isChannelBindingReference(driver.id)) throw new Error();
    return driver;
  } catch {
    throw new DependencyUnavailableError();
  }
}
export function assertChannelIAM(
  options: ChannelBindingServiceOptions,
  driver: IAMDriver,
  id: string,
): void {
  if (selectedChannelIAM(options) !== driver || driver.id !== id)
    throw new DependencyUnavailableError();
}
export async function requireChannelPermission(
  options: ChannelBindingServiceOptions,
  driver: IAMDriver,
  principalId: string,
  action: AuthorizationRequest["action"],
  resource: ResourceRef,
): Promise<Check> {
  const id = driver.id;
  const request = immutableCopy({ principalId, action, resource });
  let decision: AuthorizationDecision;
  try {
    decision = await driver.authorize(request);
  } catch {
    throw new DependencyUnavailableError();
  }
  assertChannelIAM(options, driver, id);
  if (
    !decision ||
    typeof decision.allowed !== "boolean" ||
    decision.driverId !== id ||
    !decision.evidence ||
    (decision.evidence.identityId !== undefined && decision.evidence.identityId !== principalId) ||
    !["groupIds", "bindingIds", "roleIds", "restrictionIds"].every((key) => {
      const refs = decision.evidence[key as keyof typeof decision.evidence];
      return Array.isArray(refs) && refs.length <= 256 && refs.every(isChannelBindingReference);
    })
  )
    throw new DependencyUnavailableError();
  const semantic =
    decision.evidence.channelAdministration === undefined
      ? undefined
      : decodeChannelAdministrationEvidenceV1(decision.evidence.channelAdministration);
  if (semantic?.kind === "invalid") throw new DependencyUnavailableError();
  const evidence = immutableCopy({
    ...(decision.evidence.identityId === undefined
      ? {}
      : { identityId: decision.evidence.identityId }),
    groupIds: decision.evidence.groupIds,
    bindingIds: decision.evidence.bindingIds,
    roleIds: decision.evidence.roleIds,
    restrictionIds: decision.evidence.restrictionIds,
    ...(semantic?.kind === "valid" ? { channelAdministration: semantic.value } : {}),
  });
  if (!decision.allowed)
    throw new AuthorizationDeniedError(undefined, evidence, {
      action,
      resource,
    });
  // Driver free-text reasons are deliberately not copied into persisted evidence.
  return immutableCopy({
    request,
    decision: { allowed: true, driverId: id, reason: "authorized", evidence },
  });
}
export async function lookupChannelHuman(
  options: ChannelBindingServiceOptions,
  driver: IAMDriver,
  principal: { readonly issuer: string; readonly subject: string },
): Promise<Readonly<Principal>> {
  references(principal.issuer, principal.subject);
  const id = driver.id;
  let identity;
  try {
    identity = await driver.lookupIdentity(principal);
  } catch {
    throw new DependencyUnavailableError();
  }
  assertChannelIAM(options, driver, id);
  if (
    !identity ||
    identity.kind !== "principal" ||
    identity.issuer !== principal.issuer ||
    identity.subject !== principal.subject ||
    !isChannelBindingReference(identity.id)
  )
    throw new ChannelBindingInvalidError("An existing exact human Principal is required.");
  return immutableCopy(identity);
}

/** Builds the existing server audit from captured values without effects. */
function channelBindingAudit(
  installationId: string,
  context: ChannelBindingContext,
  kind: string,
  saved: ChannelBindingMetadata,
  before: ChannelBindingMetadata | undefined,
  checks: readonly Check[],
  id: string,
  occurredAt: string,
): Readonly<AuditEvent> {
  return immutableCopy({
    id,
    installationId,
    occurredAt,
    kind: "mutation",
    actorId: context.actorId,
    source: "occ",
    schemaVersion: 1,
    requestId: context.requestId,
    ...(context.admissionDecisionId === undefined
      ? {}
      : { admissionDecisionId: context.admissionDecisionId }),
    actor: {
      principalId: context.actorId,
      ...(context.issuer === undefined ? {} : { issuer: context.issuer }),
      ...(context.subject === undefined ? {} : { subject: context.subject }),
    },
    action: `openclaw.channel-bindings.${kind}.${before === undefined ? "create" : "status"}`,
    resource: { kind: "installation", id: installationId },
    outcome: "success",
    iamDriverId: checks[0]!.decision.driverId,
    authorization: checks[0]!.request,
    details: {
      recordKind: kind,
      recordId: saved.id,
      previous: before === undefined ? null : { status: before.status, version: before.version },
      current: { status: saved.status, version: saved.version },
      ...(kind === "agent"
        ? {
            namespaceId: (saved as ChannelAgentBinding).namespaceId,
            agentId: (saved as ChannelAgentBinding).agentId,
          }
        : {}),
      checks: checks.map(({ request, decision }) => ({
        ...request,
        evidence: decision.evidence,
      })),
    },
  });
}

/** Authenticated callers use the selected IAM authority; repositories remain internal. */
export class ChannelBindingService {
  private readonly options: ChannelBindingServiceOptions;
  private readonly reservedCreate: ReservedChannelInstallationCreateV1["create"] | undefined;
  private humanAdministratorVerifier?: (
    context: ChannelBindingContext,
    operation: HumanChannelAdministrationOperation,
  ) => Promise<Readonly<Principal> | undefined>;
  private humanAdministrationStarted = false;

  constructor(options: ChannelBindingServiceOptions) {
    const { installationId, state, iam, reservedChannelInstallationCreate: reserved } = options;
    this.options = Object.freeze({ installationId, state, iam });
    if (reserved !== undefined) {
      const owner = reserved.state;
      const create = reserved.create;
      if (owner !== state || typeof create !== "function")
        throw new TypeError("The reserved channel command requires the original service state.");
      this.reservedCreate = (prepared, currentness) => create.call(reserved, prepared, currentness);
    }
  }

  /** Trusted startup wiring only; the verifier must own and consume original request custody. */
  installHumanAdministratorVerifier(
    verifier: (
      context: ChannelBindingContext,
      operation: HumanChannelAdministrationOperation,
    ) => Promise<Readonly<Principal> | undefined>,
  ): void {
    if (
      typeof verifier !== "function" ||
      this.humanAdministratorVerifier !== undefined ||
      this.humanAdministrationStarted
    )
      throw new Error("The channel administrator admission verifier is already sealed.");
    this.humanAdministratorVerifier = verifier;
  }

  private async humanAdmin(
    context: ChannelBindingContext,
    protectedOperation: HumanChannelAdministrationOperation,
  ): Promise<{ driver: IAMDriver; checks: Check[] }> {
    this.humanAdministrationStarted = true;
    const operation = { kind: "installation.administer" as const, target: {} };
    const [required] = accountIAMChecksV1(this.options.installationId, operation);
    if (
      required === undefined ||
      !accountSemanticRequirementsV1(operation).includes("installation-administrator")
    )
      throw new DependencyUnavailableError();
    const deny = () => new AuthorizationDeniedError(undefined, undefined, required);
    if (
      !context.humanInvocation ||
      typeof context.humanInvocation !== "object" ||
      !isChannelBindingReference(context.issuer) ||
      !isChannelBindingReference(context.subject)
    )
      throw deny();
    const verifier = this.humanAdministratorVerifier;
    if (verifier === undefined) throw new DependencyUnavailableError();
    const selected = selectedChannelIAM(this.options);
    const selectedId = selected.id;
    let principal: Readonly<Principal> | undefined;
    try {
      principal = await verifier(context, protectedOperation);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) throw error;
      throw new DependencyUnavailableError();
    }
    assertChannelIAM(this.options, selected, selectedId);
    if (
      principal?.kind !== "principal" ||
      principal.namespaceId !== undefined ||
      principal.id !== context.actorId ||
      principal.issuer !== context.issuer ||
      principal.subject !== context.subject
    )
      throw deny();
    const result = await this.admin(context);
    if (result.driver !== selected) throw new DependencyUnavailableError();
    const check = result.checks[0]!;
    if (check.decision.evidence.identityId !== context.actorId)
      throw new DependencyUnavailableError();
    if (check.decision.evidence.restrictionIds.length !== 0)
      throw new AuthorizationDeniedError(undefined, check.decision.evidence, required);
    const semantic = check.decision.evidence.channelAdministration;
    if (!semantic || semantic.installationId !== this.options.installationId)
      throw new DependencyUnavailableError();
    if (
      semantic.mappings.some(
        (mapping) =>
          !check.decision.evidence.bindingIds.includes(mapping.bindingId) ||
          !check.decision.evidence.roleIds.includes(mapping.roleId),
      )
    )
      throw new DependencyUnavailableError();
    if (semantic.mappings.length === 0)
      throw new AuthorizationDeniedError(undefined, check.decision.evidence, required);
    return result;
  }

  private async admin(
    context: ChannelBindingContext,
  ): Promise<{ driver: IAMDriver; checks: Check[] }> {
    references(context.actorId, context.requestId);
    const driver = selectedChannelIAM(this.options);
    const check = await requireChannelPermission(
      this.options,
      driver,
      context.actorId,
      "administer",
      { kind: "installation", id: this.options.installationId },
    );
    return { driver, checks: [check] };
  }
  private async initialized(state: PlatformReadView): Promise<void> {
    if ((await state.installations.getInstallation())?.id !== this.options.installationId)
      throw new DependencyUnavailableError();
  }
  private async parent(
    state: PlatformReadView,
    id: string,
  ): Promise<Readonly<ChannelInstallation>> {
    await this.initialized(state);
    recordId(id, "chi");
    const parent = await state.channelBindings.findChannelInstallation(id);
    if (!parent || parent.installationId !== this.options.installationId)
      throw new ChannelBindingNotFoundError();
    return parent;
  }
  private metadata(prefix: string, context: ChannelBindingContext): ChannelBindingMetadata {
    const timestamp = new Date().toISOString();
    return {
      id: `${prefix}_${randomUUID()}`,
      installationId: this.options.installationId,
      version: 1,
      status: "enabled",
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: context.actorId,
      updatedBy: context.actorId,
    };
  }
  private async audit(
    state: PlatformUnitOfWork,
    context: ChannelBindingContext,
    kind: string,
    saved: ChannelBindingMetadata,
    before: ChannelBindingMetadata | undefined,
    checks: readonly Check[],
  ): Promise<void> {
    if (before?.version === saved.version) return;
    await state.audit.append(
      channelBindingAudit(
        this.options.installationId,
        context,
        kind,
        saved,
        before,
        checks,
        `aud_${randomUUID()}`,
        new Date().toISOString(),
      ),
    );
  }
  private version(input: ChangeChannelBindingStatus): void {
    closed(input, ["expectedVersion", "status"]);
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      (input.status !== "enabled" && input.status !== "disabled")
    )
      throw new ChannelBindingInvalidError();
  }
  private async agentPermissions(
    state: PlatformReadView,
    context: ChannelBindingContext,
    driver: IAMDriver,
    input: Pick<ChannelAgentBinding, "namespaceId" | "agentId">,
  ): Promise<Check[]> {
    recordId(input.namespaceId, "ns");
    recordId(input.agentId, "agt");
    const namespace = await state.namespaces.findNamespace(input.namespaceId);
    const agent = await state.agents.findAgent(input.namespaceId, input.agentId);
    if (!namespace || namespace.status !== "ready" || !agent)
      throw new ChannelBindingNotFoundError();
    const target: ResourceRef = { kind: "agent", id: agent.id, namespaceId: namespace.id };
    return [
      await requireChannelPermission(this.options, driver, context.actorId, "read", target),
      await requireChannelPermission(this.options, driver, context.actorId, "operate", target),
    ];
  }
  async createInstallation(
    context: ChannelBindingContext,
    input: CreateChannelInstallation,
  ): Promise<Readonly<ChannelInstallation>> {
    const { driver, checks } = await this.humanAdmin(context, "createChannelInstallation");
    closed(input, ["platform", "providerTenantRef", "recipientAppRef"]);
    references(input.providerTenantRef, input.recipientAppRef);
    if (input.platform !== "slack" && input.platform !== "msteams")
      throw new ChannelBindingInvalidError();
    const reservedCreate = this.reservedCreate;
    if (reservedCreate !== undefined) {
      const record = immutableCopy({ ...this.metadata("chi", context), ...input });
      const prepared = immutableCopy({
        record,
        creationOperationRef: `channel-create:${randomUUID()}`,
        reservationRef: `channel-reservation:${randomUUID()}`,
        audit: channelBindingAudit(
          this.options.installationId,
          context,
          "installation",
          record,
          undefined,
          checks,
          `aud_${randomUUID()}`,
          new Date().toISOString(),
        ),
      });
      const selectedId = checks[0]!.decision.driverId;
      const currentness = Object.freeze({
        assertSelectedIAM: () => {
          assertChannelIAM(this.options, driver, selectedId);
          return undefined;
        },
      });
      const attempt = {
        state: this.options.state,
        currentness,
        active: true,
        consumed: false,
      };
      reservedChannelInstallationAttemptsV1.set(prepared, attempt);
      let provisional: ReservedChannelInstallationProvisionalV1;
      try {
        provisional = await reservedCreate(prepared, currentness);
      } finally {
        attempt.active = false;
      }
      if (provisional.kind === "created-provisional") return provisional.record;
      if (provisional.kind === "conflict")
        throw new ResourceConflictError(
          "The channel binding conflicts with retained identity, ownership or state.",
        );
      throw new DependencyUnavailableError();
    }
    return this.options.state.transact(async (state) => {
      await this.initialized(state);
      assertChannelIAM(this.options, driver, checks[0]!.decision.driverId);
      const saved = await state.channelBindings.createChannelInstallation({
        ...this.metadata("chi", context),
        ...input,
      });
      await this.audit(state, context, "installation", saved, undefined, checks);
      return saved;
    });
  }
  async getInstallation(
    context: ChannelBindingContext,
    id: string,
  ): Promise<Readonly<ChannelInstallation>> {
    await this.humanAdmin(context, "getChannelInstallation");
    return this.options.state.read((state) => this.parent(state, id));
  }
  async setInstallationStatus(
    context: ChannelBindingContext,
    id: string,
    input: ChangeChannelBindingStatus,
  ): Promise<Readonly<ChannelInstallation>> {
    const { driver, checks } = await this.humanAdmin(context, "setChannelInstallationStatus");
    this.version(input);
    return this.options.state.transact(async (state) => {
      const before = await this.parent(state, id);
      if (before.version !== input.expectedVersion)
        throw new ResourceConflictError("The channel binding version changed.");
      assertChannelIAM(this.options, driver, checks[0]!.decision.driverId);
      const saved = await state.channelBindings.setChannelInstallationStatus(
        id,
        input.expectedVersion,
        input.status,
        context.actorId,
        new Date().toISOString(),
      );
      if (!saved) throw new ChannelBindingNotFoundError();
      await this.audit(state, context, "installation", saved, before, checks);
      return saved;
    });
  }
  async createHumanBinding(
    context: ChannelBindingContext,
    parentId: string,
    input: CreateChannelHumanBinding,
  ): Promise<Readonly<ChannelHumanBinding>> {
    const { driver, checks } = await this.humanAdmin(context, "createChannelHumanBinding");
    closed(input, ["providerSubjectRef", "principal"]);
    closed(input.principal, ["issuer", "subject"]);
    references(input.providerSubjectRef);
    return this.options.state.transact(async (state) => {
      await this.parent(state, parentId);
      const identity = await lookupChannelHuman(this.options, driver, input.principal);
      const saved = await state.channelBindings.createHumanBinding({
        ...this.metadata("chh", context),
        channelInstallationId: parentId,
        providerSubjectRef: input.providerSubjectRef,
        iamDriverId: driver.id,
        principalId: identity.id,
        principalIssuer: identity.issuer,
        principalSubject: identity.subject,
      });
      await this.audit(state, context, "human", saved, undefined, checks);
      return saved;
    });
  }
  async getHumanBinding(
    context: ChannelBindingContext,
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelHumanBinding>> {
    await this.humanAdmin(context, "getChannelHumanBinding");
    recordId(id, "chh");
    return this.options.state.read(async (state) => {
      await this.parent(state, parentId);
      const saved = await state.channelBindings.findHumanBinding(parentId, id);
      if (!saved) throw new ChannelBindingNotFoundError();
      return saved;
    });
  }
  async setHumanBindingStatus(
    context: ChannelBindingContext,
    parentId: string,
    id: string,
    input: ChangeChannelBindingStatus,
  ): Promise<Readonly<ChannelHumanBinding>> {
    const { driver, checks } = await this.humanAdmin(context, "setChannelHumanBindingStatus");
    this.version(input);
    recordId(id, "chh");
    return this.options.state.transact(async (state) => {
      await this.parent(state, parentId);
      const before = await state.channelBindings.findHumanBinding(parentId, id);
      if (!before) throw new ChannelBindingNotFoundError();
      if (before.version !== input.expectedVersion)
        throw new ResourceConflictError("The channel binding version changed.");
      if (input.status === "enabled") {
        if (before.iamDriverId !== driver.id)
          throw new ChannelBindingInvalidError("The binding belongs to another IAM authority.");
        const human = await lookupChannelHuman(this.options, driver, {
          issuer: before.principalIssuer,
          subject: before.principalSubject,
        });
        if (human.id !== before.principalId)
          throw new ChannelBindingInvalidError("The original human identity changed.");
      }
      assertChannelIAM(this.options, driver, checks[0]!.decision.driverId);
      const saved = await state.channelBindings.setHumanBindingStatus(
        parentId,
        id,
        input.expectedVersion,
        input.status,
        context.actorId,
        new Date().toISOString(),
      );
      if (!saved) throw new ChannelBindingNotFoundError();
      await this.audit(state, context, "human", saved, before, checks);
      return saved;
    });
  }
  async createAgentBinding(
    context: ChannelBindingContext,
    parentId: string,
    input: CreateChannelAgentBinding,
  ): Promise<Readonly<ChannelAgentBinding>> {
    const { driver, checks } = await this.admin(context);
    closed(input, ["channelRef", "scopeKind", "namespaceId", "agentId"]);
    references(input.channelRef);
    return this.options.state.transact(async (state) => {
      const parent = await this.parent(state, parentId);
      if (
        input.scopeKind !==
        (parent.platform === "slack" ? "slack-private-channel" : "msteams-standard-channel")
      )
        throw new ChannelBindingInvalidError();
      checks.push(...(await this.agentPermissions(state, context, driver, input)));
      const saved = await state.channelBindings.createAgentBinding({
        ...this.metadata("cha", context),
        ...input,
        channelInstallationId: parentId,
      });
      await this.audit(state, context, "agent", saved, undefined, checks);
      return saved;
    });
  }
  async getAgentBinding(
    context: ChannelBindingContext,
    parentId: string,
    id: string,
  ): Promise<Readonly<ChannelAgentBinding>> {
    await this.admin(context);
    recordId(id, "cha");
    return this.options.state.read(async (state) => {
      await this.parent(state, parentId);
      const saved = await state.channelBindings.findAgentBinding(parentId, id);
      if (!saved) throw new ChannelBindingNotFoundError();
      return saved;
    });
  }
  async setAgentBindingStatus(
    context: ChannelBindingContext,
    parentId: string,
    id: string,
    input: ChangeChannelBindingStatus,
  ): Promise<Readonly<ChannelAgentBinding>> {
    const { driver, checks } = await this.admin(context);
    this.version(input);
    recordId(id, "cha");
    return this.options.state.transact(async (state) => {
      await this.parent(state, parentId);
      const before = await state.channelBindings.findAgentBinding(parentId, id);
      if (!before) throw new ChannelBindingNotFoundError();
      if (before.version !== input.expectedVersion)
        throw new ResourceConflictError("The channel binding version changed.");
      if (input.status === "enabled")
        checks.push(...(await this.agentPermissions(state, context, driver, before)));
      assertChannelIAM(this.options, driver, checks[0]!.decision.driverId);
      const saved = await state.channelBindings.setAgentBindingStatus(
        parentId,
        id,
        input.expectedVersion,
        input.status,
        context.actorId,
        new Date().toISOString(),
      );
      if (!saved) throw new ChannelBindingNotFoundError();
      await this.audit(state, context, "agent", saved, before, checks);
      return saved;
    });
  }
  private pageQuery(kind: string, parent: string, query: ChannelBindingListQuery) {
    if (Object.keys(query).some((key) => key !== "limit" && key !== "cursor"))
      throw new ChannelBindingInvalidError();
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new ChannelBindingInvalidError();
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      try {
        if (
          query.cursor.length > 2048 ||
          Buffer.from(query.cursor, "base64url").toString("base64url") !== query.cursor
        )
          throw new Error();
        const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        closed(value, ["v", "kind", "parent", "limit", "afterId"]);
        if (
          value.v !== 1 ||
          value.kind !== kind ||
          value.parent !== parent ||
          value.limit !== limit
        )
          throw new Error();
        recordId(value.afterId, kind === "installation" ? "chi" : kind === "human" ? "chh" : "cha");
        afterId = value.afterId;
      } catch {
        throw new ChannelBindingInvalidError("The continuation cursor does not match this query.");
      }
    }
    return { limit, ...(afterId === undefined ? {} : { afterId }) };
  }
  private page<T extends ChannelBindingMetadata>(
    kind: string,
    parent: string,
    limit: number,
    rows: readonly Readonly<T>[],
  ): ChannelBindingPage<T> {
    const items = rows.slice(0, limit);
    return immutableCopy({
      items,
      ...(rows.length <= limit
        ? {}
        : {
            nextCursor: Buffer.from(
              JSON.stringify({ v: 1, kind, parent, limit, afterId: items.at(-1)!.id }),
            ).toString("base64url"),
          }),
    });
  }
  async listInstallations(
    context: ChannelBindingContext,
    query: ChannelBindingListQuery = {},
  ): Promise<ChannelBindingPage<ChannelInstallation>> {
    await this.humanAdmin(context, "listChannelInstallations");
    const page = this.pageQuery("installation", this.options.installationId, query);
    return this.options.state.read(async (state) => {
      await this.initialized(state);
      return this.page(
        "installation",
        this.options.installationId,
        page.limit,
        await state.channelBindings.listChannelInstallations({ ...page, limit: page.limit + 1 }),
      );
    });
  }
  async listHumanBindings(
    context: ChannelBindingContext,
    parentId: string,
    query: ChannelBindingListQuery = {},
  ): Promise<ChannelBindingPage<ChannelHumanBinding>> {
    await this.humanAdmin(context, "listChannelHumanBindings");
    const page = this.pageQuery("human", parentId, query);
    return this.options.state.read(async (state) => {
      await this.parent(state, parentId);
      return this.page(
        "human",
        parentId,
        page.limit,
        await state.channelBindings.listHumanBindings(parentId, { ...page, limit: page.limit + 1 }),
      );
    });
  }
  async listAgentBindings(
    context: ChannelBindingContext,
    parentId: string,
    query: ChannelBindingListQuery = {},
  ): Promise<ChannelBindingPage<ChannelAgentBinding>> {
    await this.admin(context);
    const page = this.pageQuery("agent", parentId, query);
    return this.options.state.read(async (state) => {
      await this.parent(state, parentId);
      return this.page(
        "agent",
        parentId,
        page.limit,
        await state.channelBindings.listAgentBindings(parentId, { ...page, limit: page.limit + 1 }),
      );
    });
  }
}
