import {
  createHttpTransport,
  createFetchAdapter,
  responseHeaders,
  type ControllerApp,
} from "./http/transport.ts";
import {
  failure,
  RequestFailure,
  requestFailure,
  canonicalFailure,
  validateConfiguration,
  type ErrorDetail,
} from "./http/errors.ts";
import {
  createHttpAdmission,
  validateTrustedDevelopmentCidrs,
  RESOURCE_ID,
  type DevelopmentAdmission,
} from "./http/admission.ts";
import { createIdentityResolver, type RequestContext } from "./http/identity.ts";
import {
  operationTarget,
  requiredPermissions,
  permissionDescription,
  bootstrapOperation,
  type DocumentedFastifySchema,
} from "./http/operation-registry.ts";
import { registerProtectedOperations, registerBootstrapOperation } from "./http/register.ts";
import { createConfigurationOperationHandlers } from "./routes/configuration.ts";
import { createAgentOperationHandlers } from "./routes/agent.ts";
import {
  createLifecycleStatusOperationHandlersV1,
  type LifecycleStatusHttpDependenciesV1,
} from "./routes/lifecycle-status.ts";
import { createLifecycleStatusServiceV1 } from "@openclaw-enterprise/occ/lifecycle/status-service-v1";
import { createNamespaceOperationHandlers } from "./routes/namespace.ts";
import { createSecretOperationHandlers } from "./routes/secret.ts";
import { createServiceAccountOperationHandlers } from "./routes/service-account.ts";
export type { DevelopmentAdmission } from "./http/admission.ts";
export type { ControllerApp } from "./http/transport.ts";
import {
  runtimeServiceTrustOperations,
  RuntimeServiceTrustRecordSchema,
  RuntimeServiceTrustRequestSchema,
  runtimeServiceTrustOperatorContext,
  parseRuntimeServiceTrustHttpBody,
} from "./admission/runtime-service-trust.ts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { randomUUID } from "node:crypto";
import {
  type FastifyInstance,
  type FastifyBaseLogger,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from "fastify";
import { AuditEventFactory, type AuditSink } from "@openclaw-enterprise/audit";
import { AuthAccountRoleNotFoundError, type AuthPrincipalSeed } from "@openclaw-enterprise/iam";
import {
  ErrorResponse,
  SecretResponse,
  occApiRoutes,
  type AgentRevision,
  type AuditEvent,
  type AuthorizationEvidence,
  type ConfigurationDriver,
  type ComputeDriver,
  type IAMDriver,
  type Installation,
  type OccApiRoute,
  type PermissionAction,
  type ProviderSummary,
  type ResourceKind,
  type ResourceRef,
  type SandboxDriver,
  type SecretDriver,
  type UpdateWorkspaceFileBody,
  type WorkspaceFileName,
} from "@openclaw-enterprise/contracts";
import {
  AuthorizationDeniedError,
  BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
  ChannelBindingInvalidError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  PostgresCommitOutcomeUnknownError,
  type RuntimeServiceTrustService,
  type HarnessResolver,
  type DeployAgentAdmissionContext,
  type OpenClawController,
} from "@openclaw-enterprise/occ";
import {
  isChannelBindingOperation,
  isHumanChannelAdministrationOperation,
  performChannelBindingOperation,
} from "./channels/channel-binding-routes.ts";
import type { AdmittedCaller } from "./admission/admission-verifier.ts";
import {
  OCC_AUTH_COOKIE_PREFIX,
  OCC_SERVICE_KEY_HEADER,
  type ControllerAuth,
} from "./auth/index.ts";
import { CONSOLE_CONTENT_SECURITY_POLICY, readConsoleAsset } from "./console-assets.ts";
import {
  ControllerWorkspaceFileUnknownOutcomeError,
  isAllowedWorkspaceFileName,
  type ControllerWorkspaceFilesAccess,
  type ControllerWorkspaceFileReadResult,
  type ControllerWorkspaceFileWriteResult,
} from "./gateway/contracts.ts";

export interface ControllerAppOptions {
  /** Optional qualified private-call and current lifecycle read producers.
   * Absent producers leave the read endpoints unavailable. */
  readonly lifecycleStatus?: LifecycleStatusHttpDependenciesV1;
  readonly runtimeServiceTrust?: RuntimeServiceTrustService;
  readonly controller?: OpenClawController;
  readonly createController?: (installation: Installation) => OpenClawController;
  readonly iamDriver: IAMDriver;
  readonly computeDriver?: ComputeDriver;
  readonly configurationDriver?: ConfigurationDriver;
  readonly secretDriver?: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly resolveHarness: HarnessResolver;
  readonly auditSink: AuditSink;
  readonly providerSummaries?: readonly ProviderSummary[];
  readonly development: DevelopmentAdmission;
  readonly maxBodyBytes?: number;
  readonly auth: ControllerAuth;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly workspaceFileRequestTimeoutMs?: number;
  readonly publicOrigin?: string;
  readonly provisionAuthAccount?: (
    seed: AuthPrincipalSeed,
    auditEvent: AuditEvent,
  ) => Promise<void>;
  readonly auditEventFactory?: AuditEventFactory;
  readonly logger?: FastifyBaseLogger;
}

const DEFAULT_BODY_LIMIT = 64 * 1024;
const WORKSPACE_FILE_CONTENT_LIMIT = 16 * 1024;
function validAuthorizationEvidence(value: unknown): value is AuthorizationEvidence {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthorizationEvidence>;
  if (candidate.identityId !== undefined && !isNonEmptyString(candidate.identityId)) return false;
  return [
    candidate.groupIds,
    candidate.bindingIds,
    candidate.roleIds,
    candidate.restrictionIds,
  ].every((entries) => Array.isArray(entries) && entries.every(isNonEmptyString));
}

export function createFastifyApp(options: ControllerAppOptions): FastifyInstance {
  const development = Object.freeze({ ...options.development });
  if (
    options.controller &&
    development.installationId !== undefined &&
    development.installationId !== options.controller.installation.id
  )
    throw new Error(
      "The configured Installation does not match the controller-owned Installation.",
    );
  const bodyLimit = options.maxBodyBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1)
    throw new Error("The controller request-body limit must be a positive integer.");
  const workspaceFileRequestTimeoutMs = options.workspaceFileRequestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(workspaceFileRequestTimeoutMs) || workspaceFileRequestTimeoutMs < 1)
    throw new Error("The workspace file request timeout must be a positive integer.");
  let publicOrigin: string | undefined;
  if (options.publicOrigin !== undefined) {
    try {
      const parsed = new URL(options.publicOrigin);
      publicOrigin = parsed.origin;
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("Invalid public origin.");
    } catch {
      throw new Error("The controller public origin must be an absolute origin URL.");
    }
  }
  validateTrustedDevelopmentCidrs(development);

  const app = createHttpTransport({
    bodyLimit,
    developmentEnabled: development.enabled,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  let controller = options.controller;
  let bootstrapping = false;
  const installationId =
    development.installationId ?? controller?.installation.id ?? `ins_${randomUUID()}`;
  const admissions = new WeakMap<FastifyRequest, AdmittedCaller>();
  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const identityAuthorities = new WeakMap<FastifyRequest, { driver: IAMDriver; id: string }>();
  const humanChannelInvocations = new WeakMap<
    object,
    {
      readonly request: FastifyRequest;
      readonly context: RequestContext;
      readonly service: OpenClawController["channelBindings"];
      used: boolean;
    }
  >();

  function installChannelHumanVerifier(target: OpenClawController): void {
    const service = target.channelBindings;
    service.installHumanAdministratorVerifier(async (candidate, protectedOperation) => {
      const invocation = candidate.humanInvocation;
      const owned = invocation && humanChannelInvocations.get(invocation);
      if (!owned || owned.used || owned.service !== service) return undefined;
      const { request, context } = owned;
      const admitted = admissions.get(request);
      const originalAuthority = identityAuthorities.get(request);
      if (
        !originalAuthority ||
        request.raw.aborted ||
        contexts.get(request) !== context ||
        admitted?.method !== "session" ||
        context.operation.operationId !== protectedOperation ||
        candidate.requestId !== request.id ||
        candidate.actorId !== context.actorId ||
        candidate.issuer !== context.issuer ||
        candidate.subject !== context.subject ||
        candidate.admissionDecisionId !== context.admissionDecisionId ||
        admitted.decisionId !== context.admissionDecisionId ||
        admitted.externalIdentity.issuer !== context.issuer ||
        admitted.externalIdentity.subject !== context.subject ||
        admitted.admittedScope.installationId !== target.installation.id
      )
        return undefined;
      owned.used = true;
      const selected = originalAuthority.driver;
      const selectedId = originalAuthority.id;
      if (selectedIAMDriver() !== selected || selected.id !== selectedId)
        throw dependencyUnavailable();
      const principal = await selected.lookupIdentity({
        issuer: context.issuer,
        subject: context.subject,
      });
      if (
        selectedIAMDriver() !== selected ||
        selected.id !== selectedId ||
        humanChannelInvocations.get(invocation!) !== owned ||
        request.raw.aborted ||
        contexts.get(request) !== context ||
        admissions.get(request) !== admitted ||
        identityAuthorities.get(request) !== originalAuthority
      )
        throw dependencyUnavailable();
      if (
        principal?.kind !== "principal" ||
        principal.namespaceId !== undefined ||
        principal.id !== context.actorId ||
        principal.issuer !== context.issuer ||
        principal.subject !== context.subject
      )
        return undefined;
      return Object.freeze({ ...principal });
    });
  }
  if (controller) installChannelHumanVerifier(controller);
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  const factory = options.auditEventFactory ?? new AuditEventFactory();
  const createAuthAccountOperation = {
    operationId: "createAuthAccount",
    method: "POST",
    path: "/api/auth/accounts",
    action: "openclaw.auth.accounts.create",
    iamAction: "administer",
    resourceKind: "installation",
    authorizationTarget: "installation",
    summary: "Create an administrator-controlled local auth account",
    tags: ["Authentication"],
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password", "roleId"],
        properties: {
          email: { type: "string", minLength: 3, maxLength: 320 },
          password: { type: "string", minLength: 12, maxLength: 128 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          roleId: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
    },
  } as unknown as OccApiRoute;
  const serviceKeyOperations = [
    {
      operationId: "createServiceKey",
      method: "POST",
      path: "/api/auth/service-keys",
      action: "openclaw.auth.service-keys.create",
      summary: "Issue a service API key",
    },
    {
      operationId: "revokeServiceKey",
      method: "DELETE",
      path: "/api/auth/service-keys/:keyId",
      action: "openclaw.auth.service-keys.revoke",
      summary: "Revoke a service API key",
    },
  ].map((operation) => ({
    ...operation,
    iamAction: "administer",
    resourceKind: "installation",
    authorizationTarget: "installation",
    tags: ["Authentication"],
    schema: {},
  })) as unknown as readonly OccApiRoute[];

  function event(
    operation: OccApiRoute,
    request: FastifyRequest,
    resource: ResourceRef,
    kind: "bootstrap" | "mutation" | "authorization_denial",
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    result?: {
      readonly outcome: "success" | "denied" | "failure";
      readonly reasonCode?: string;
    },
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
  ): AuditEvent {
    return factory.create({
      installationId,
      ...(resource.namespaceId === undefined ? {} : { namespaceId: resource.namespaceId }),
      kind,
      source: "occ",
      requestId: request.id,
      ...(context === undefined
        ? { actor: { unresolved: true } }
        : {
            actor: {
              principalId: context.actorId,
              issuer: context.issuer,
              subject: context.subject,
            },
            admissionDecisionId: context.admissionDecisionId,
            iamDriverId: selectedIAMDriver().id,
            authorization: {
              principalId: context.actorId,
              action: authorization?.action ?? operation.iamAction,
              resource:
                authorization?.resource ??
                operationTarget(
                  operation,
                  installationId,
                  request.params as Record<string, unknown>,
                ),
            },
            ...(evidence === undefined
              ? {}
              : {
                  ...(evidence.restrictionIds.length > 0
                    ? {
                        decisionReason: "A matching Restriction denied the operation.",
                      }
                    : {}),
                  details: {
                    iamEvidence: {
                      ...(evidence.identityId === undefined
                        ? {}
                        : { identityId: evidence.identityId }),
                      groupIds: evidence.groupIds,
                      bindingIds: evidence.bindingIds,
                      roleIds: evidence.roleIds,
                      restrictionIds: evidence.restrictionIds,
                    },
                  },
                }),
          }),
      action: operation.action,
      resource,
      outcome:
        result?.outcome ?? (kind === "bootstrap" || kind === "mutation" ? "success" : "denied"),
      ...(result?.reasonCode === undefined
        ? kind === "authorization_denial"
          ? { reasonCode: "AUTHORIZATION_DENIED" }
          : {}
        : { reasonCode: result.reasonCode }),
    });
  }

  function selectedIAMDriver(): IAMDriver {
    try {
      const selected =
        controller === undefined ? options.iamDriver : controller.selectedDriver("iam");
      if (selected.capability !== "iam") throw new Error("Invalid authorization authority.");
      return selected;
    } catch {
      throw dependencyUnavailable();
    }
  }

  function dependencyUnavailable(): RequestFailure {
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  }

  function workspaceFileRequestSignal(
    request: FastifyRequest,
    reply: FastifyReply,
    timeoutMs: number,
  ): { readonly signal: AbortSignal; readonly dispose: () => void } {
    const controller = new AbortController();
    const abort = (message: string) => {
      if (!controller.signal.aborted) controller.abort(new Error(message));
    };
    const timeout = setTimeout(
      () => abort(`The workspace file request exceeded its ${timeoutMs}ms deadline.`),
      timeoutMs,
    );
    timeout.unref?.();
    const onRequestAborted = () =>
      abort("The HTTP client disconnected before the workspace file request completed.");
    const onReplyClosed = () => {
      if (!reply.raw.writableEnded)
        abort("The HTTP client disconnected before the workspace file request completed.");
    };
    if (request.raw.aborted)
      abort("The HTTP client disconnected before the workspace file request.");
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onReplyClosed);
    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timeout);
        request.raw.off("aborted", onRequestAborted);
        reply.raw.off("close", onReplyClosed);
      },
    };
  }

  async function withWorkspaceFileRequestSignal<T>(
    signal: AbortSignal,
    operation: Promise<T>,
    abortError: () => Error = dependencyUnavailable,
  ): Promise<T> {
    if (signal.aborted) {
      // The operation has already started; observe any rejection after the HTTP deadline.
      void operation.catch(() => {});
      throw abortError();
    }
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(abortError());
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
  }

  function workspaceFileAuditEvent(
    operation: OccApiRoute,
    request: FastifyRequest,
    resource: ResourceRef,
    context: RequestContext,
    filename: WorkspaceFileName,
    result?: {
      readonly outcome: "success" | "failure";
      readonly reasonCode?: string;
    },
  ): AuditEvent {
    const base = event(operation, request, resource, "mutation", context, undefined, result);
    return {
      ...base,
      details: {
        ...base.details,
        workspaceFileName: filename,
      },
    };
  }

  function validateWorkspaceFileBody(body: UpdateWorkspaceFileBody): void {
    const details: ErrorDetail[] = [];
    if (Buffer.byteLength(body.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT)
      details.push({ path: "/content", code: "TOO_LONG" });
    const isWellFormed = (
      String.prototype as unknown as { isWellFormed: (this: string) => boolean }
    ).isWellFormed;
    if (body.content.includes("\u0000") || !isWellFormed.call(body.content))
      details.push({ path: "/content", code: "INVALID_VALUE" });
    if (details.length > 0)
      throw failure(
        400,
        "INVALID_REQUEST",
        "The request does not match the operation contract.",
        details,
      );
  }

  async function requireInstallationAdmin(
    request: FastifyRequest,
    operation: OccApiRoute,
    context: RequestContext,
  ) {
    const target: ResourceRef = { kind: "installation", id: installationId };
    let selected: IAMDriver;
    let decision;
    try {
      selected = selectedIAMDriver();
      decision = await selected.authorize({
        principalId: context.actorId,
        action: "administer",
        resource: target,
      });
    } catch {
      throw dependencyUnavailable();
    }
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      decision.driverId !== selected.id ||
      !validAuthorizationEvidence(decision.evidence)
    )
      throw dependencyUnavailable();
    if (!decision.allowed) {
      await denial(operation, request, "authorization_denial", context, decision.evidence);
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }
    return { selected, target, decision };
  }

  async function denial(
    operation: OccApiRoute,
    request: FastifyRequest,
    kind: "authorization_denial",
    context?: RequestContext,
    evidence?: AuthorizationEvidence,
    authorization?: NonNullable<AuthorizationDeniedError["authorization"]>,
  ): Promise<void> {
    try {
      await options.auditSink.append(
        event(
          operation,
          request,
          operationTarget(operation, installationId, request.params as Record<string, unknown>),
          kind,
          context,
          evidence,
          undefined,
          authorization,
        ),
      );
    } catch {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
  }

  async function rejectedMutation(
    operation: OccApiRoute,
    request: FastifyRequest,
    context: RequestContext,
    reasonCode: string,
  ): Promise<void> {
    try {
      await options.auditSink.append(
        event(
          operation,
          request,
          operationTarget(operation, installationId, request.params as Record<string, unknown>),
          "mutation",
          context,
          undefined,
          { outcome: "failure", reasonCode },
        ),
      );
    } catch {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    responseHeaders(reply, request.id);
    const contentLength = request.headers["content-length"];
    if (typeof contentLength === "string" && Number(contentLength) > bodyLimit)
      throw failure(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the permitted size.");
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationMs =
      startedAt === undefined ? undefined : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    app.log.info({
      event: "http.completed",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      status: reply.statusCode,
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs * 1000) / 1000 }),
    });
  });

  const { admit, requireBrowserIntent } = createHttpAdmission({
    development,
    installationId,
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    verifyAdmission: (request) => options.auth.admissionVerifier.verify(request),
    admissions,
    denial,
  });
  const resolveIdentity = createIdentityResolver({
    admissions,
    contexts,
    selectedIAMDriver,
    denial,
    recordIdentityAuthority: (request, authority) => identityAuthorities.set(request, authority),
  });

  async function perform(
    request: FastifyRequest,
    reply: FastifyReply,
    operation: OccApiRoute,
  ): Promise<void> {
    const context = contexts.get(request);
    if (!context)
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    const params = request.params as Record<string, string>;
    const body = request.body as Record<string, unknown> | undefined;
    if (body !== undefined) validateConfiguration(body);

    if (operation.operationId === "bootstrapInstallation") {
      if (controller || bootstrapping)
        throw failure(409, "INSTALLATION_EXISTS", "The deployment already owns an Installation.");
      bootstrapping = true;
      try {
        const { selected, target, decision } = await requireInstallationAdmin(
          request,
          operation,
          context,
        );
        if (!options.createController)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        const installation: Installation = {
          id: installationId,
          name: body?.name as string,
          createdAt: new Date().toISOString(),
        };
        const created = options.createController(installation);
        created.registerDriver(selected);
        created.selectDriver("iam", selected.id);
        if (options.computeDriver) {
          created.registerDriver(options.computeDriver);
          created.selectDriver("compute", options.computeDriver.id);
        }
        if (options.configurationDriver) {
          created.registerDriver(options.configurationDriver);
          created.selectDriver("configuration", options.configurationDriver.id);
        }
        if (options.secretDriver) {
          created.registerDriver(options.secretDriver);
          created.selectDriver("secret", options.secretDriver.id);
        }
        if (options.sandboxDriver) {
          created.registerDriver(options.sandboxDriver);
          created.selectDriver("sandbox", options.sandboxDriver.id);
        }
        await created.transact(async (unit) => {
          await created.createNamespace(context.actorId, {
            name: BOOTSTRAP_DEFAULT_NAMESPACE_NAME,
          });
          await unit.audit.append(
            event(operation, request, target, "bootstrap", context, decision.evidence),
          );
        });
        installChannelHumanVerifier(created);
        controller = created;
        reply.status(201).send({
          data: created.installation,
          meta: { requestId: request.id },
        });
        return;
      } finally {
        bootstrapping = false;
      }
    }

    if (!controller)
      throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");

    if (isChannelBindingOperation(operation.operationId)) {
      const humanInvocation = isHumanChannelAdministrationOperation(operation.operationId)
        ? Object.freeze({})
        : undefined;
      if (humanInvocation)
        humanChannelInvocations.set(humanInvocation, {
          request,
          context,
          service: controller.channelBindings,
          used: false,
        });
      try {
        const data = await performChannelBindingOperation(
          controller.channelBindings,
          operation.operationId,
          {
            ...context,
            requestId: request.id,
            ...(humanInvocation ? { humanInvocation } : {}),
          },
          { params: request.params, query: request.query, body: request.body },
        );
        reply.status(operation.method === "POST" ? 201 : 200).send({
          data,
          meta: { requestId: request.id },
        });
        return;
      } finally {
        if (humanInvocation) humanChannelInvocations.delete(humanInvocation);
      }
    }

    if (operation.operationId === "getInstallation") {
      reply.send({
        data: await controller.getInstallation(context.actorId),
        meta: { requestId: request.id },
      });
      return;
    }

    if (operation.operationId === "listProviders") {
      await requireInstallationAdmin(request, operation, context);
      const providers = options.providerSummaries;
      if (providers === undefined) throw dependencyUnavailable();
      reply.send({
        data: providers.map((provider) => ({
          id: provider.id,
          type: provider.type,
        })),
        meta: { requestId: request.id },
      });
      return;
    }

    const namespaceId = params.namespaceId;
    if (!namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    const agentId = params.agentId;
    if (!agentId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    if (
      operation.operationId === "getAgentWorkspaceFile" ||
      operation.operationId === "putAgentWorkspaceFile"
    ) {
      const deadlineMs = workspaceFileRequestTimeoutMs;
      const workspaceFileSignal = workspaceFileRequestSignal(request, reply, deadlineMs);
      const signal = workspaceFileSignal.signal;
      const deadline = new Date(Date.now() + deadlineMs);
      try {
        requireBrowserIntent(request, operation.operationId === "putAgentWorkspaceFile");
        if (options.workspaceFilesAccess === undefined) throw dependencyUnavailable();
        const filename = params.name;
        if (filename === undefined || !isAllowedWorkspaceFileName(filename))
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );
        if (signal.aborted) throw dependencyUnavailable();
        const { agent, revision } = await withWorkspaceFileRequestSignal(
          signal,
          operation.operationId === "getAgentWorkspaceFile"
            ? controller.getReadableActiveAgentRevision(context.actorId, namespaceId, agentId)
            : controller.getOperableActiveAgentRevision(context.actorId, namespaceId, agentId),
        );
        const target = {
          kind: "agent" as const,
          id: agent.id,
          namespaceId: agent.namespaceId,
        };
        if (signal.aborted) throw dependencyUnavailable();

        if (operation.operationId === "getAgentWorkspaceFile") {
          let result: ControllerWorkspaceFileReadResult;
          try {
            if (signal.aborted) throw dependencyUnavailable();
            result = await withWorkspaceFileRequestSignal(
              signal,
              options.workspaceFilesAccess.read({
                revision,
                filename,
                signal,
                deadline,
              }),
            );
          } catch {
            throw dependencyUnavailable();
          }
          if (result.status === "missing") {
            throw failure(404, "NOT_FOUND", "The requested workspace file was not found.");
          }
          if (result.status === "unavailable") {
            throw dependencyUnavailable();
          }
          const isWellFormed = (
            String.prototype as unknown as {
              isWellFormed: (this: string) => boolean;
            }
          ).isWellFormed;
          if (
            Buffer.byteLength(result.file.content, "utf8") > WORKSPACE_FILE_CONTENT_LIMIT ||
            result.file.content.includes("\u0000") ||
            !isWellFormed.call(result.file.content)
          )
            throw dependencyUnavailable();
          reply.send({
            data: { name: filename, content: result.file.content },
            meta: { requestId: request.id },
          });
          return;
        }

        const writeBody = body as unknown as UpdateWorkspaceFileBody;
        validateWorkspaceFileBody(writeBody);
        let result: ControllerWorkspaceFileWriteResult;
        try {
          if (signal.aborted) throw dependencyUnavailable();
          result = await withWorkspaceFileRequestSignal(
            signal,
            options.workspaceFilesAccess.write({
              revision,
              filename,
              content: writeBody.content,
              signal,
              deadline,
            }),
            () =>
              new ControllerWorkspaceFileUnknownOutcomeError(
                "The workspace file write reached the OCC request deadline before the controller observed its outcome.",
              ),
          );
        } catch (error) {
          if (error instanceof ControllerWorkspaceFileUnknownOutcomeError) {
            try {
              await withWorkspaceFileRequestSignal(
                signal,
                options.auditSink.append(
                  workspaceFileAuditEvent(operation, request, target, context, filename, {
                    outcome: "failure",
                    reasonCode: "UNKNOWN_OUTCOME",
                  }),
                ),
                () => new ControllerWorkspaceFileUnknownOutcomeError(error.message),
              );
            } catch {
              throw failure(503, "UNKNOWN_OUTCOME", error.message);
            }
            throw failure(503, "UNKNOWN_OUTCOME", error.message);
          }
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "DEPENDENCY_UNAVAILABLE",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw dependencyUnavailable();
        }
        if (result.status === "missing") {
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "FILE_MISSING",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw failure(404, "NOT_FOUND", "The requested workspace file was not found.");
        }
        if (result.status === "unavailable") {
          try {
            await withWorkspaceFileRequestSignal(
              signal,
              options.auditSink.append(
                workspaceFileAuditEvent(operation, request, target, context, filename, {
                  outcome: "failure",
                  reasonCode: "DEPENDENCY_UNAVAILABLE",
                }),
              ),
            );
          } catch {
            throw dependencyUnavailable();
          }
          throw dependencyUnavailable();
        }
        try {
          await withWorkspaceFileRequestSignal(
            signal,
            options.auditSink.append(
              workspaceFileAuditEvent(operation, request, target, context, filename, {
                outcome: "success",
              }),
            ),
            () =>
              new ControllerWorkspaceFileUnknownOutcomeError(
                "The workspace file was written, but its final audit outcome could not be persisted before the request ended.",
              ),
          );
        } catch {
          throw failure(
            503,
            "UNKNOWN_OUTCOME",
            "The workspace file was written, but its final audit outcome could not be persisted.",
          );
        }
        reply.send({
          data: {
            name: filename,
            size: Buffer.byteLength(writeBody.content, "utf8"),
          },
          meta: { requestId: request.id },
        });
        return;
      } finally {
        workspaceFileSignal.dispose();
      }
    }

    throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
  }

  void app.register(async (routes) => {
    const meta = {
      type: "object",
      additionalProperties: false,
      required: ["requestId"],
      properties: { requestId: { type: "string" } },
    };
    const envelope = (data: Record<string, unknown>) => ({
      type: "object",
      additionalProperties: false,
      required: ["data", "meta"],
      properties: { data, meta },
    });
    const error = {
      type: "object",
      additionalProperties: false,
      required: ["error", "meta"],
      properties: {
        error: {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: { code: { type: "string" }, message: { type: "string" } },
        },
        meta,
      },
    };
    const responses = (success: Record<string, unknown>, status = 200) => ({
      [status]: {
        description: status === 201 ? "Created" : "OK",
        ...envelope(success),
      },
      401: { description: "Unauthorized", ...error },
      503: { description: "Service Unavailable", ...error },
    });
    const accountBody = (
      createAuthAccountOperation.schema as {
        readonly body: { readonly properties: Record<string, unknown> };
      }
    ).body;
    const account = {
      type: "object",
      additionalProperties: true,
      required: ["id", "email", "name", "principalId"],
      properties: {
        id: { type: "string" },
        email: { type: "string", format: "email" },
        name: { type: "string" },
        principalId: { type: "string" },
      },
    };

    void routes.register(async (trustRoutes) => {
      // Encapsulated parser applies only to these closed counter-bearing operations.
      trustRoutes.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (_request, body, done) => {
          try {
            done(null, parseRuntimeServiceTrustHttpBody(String(body)));
          } catch {
            done(
              failure(400, "INVALID_REQUEST", "The request does not match the operation contract."),
            );
          }
        },
      );
      for (const operation of runtimeServiceTrustOperations) {
        const writing = operation.method === "POST";
        const recordSchema = { ...RuntimeServiceTrustRecordSchema };
        const writeSchema = {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["result", "record"],
              properties: {
                result: { enum: ["applied", "exact-replay"] },
                record: recordSchema,
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["result", "operationRef", "nextAction"],
              properties: {
                result: { const: "commit-unknown" },
                operationRef: { type: "string" },
                nextAction: { const: "exact-readback-only" },
              },
            },
          ],
        };
        trustRoutes.route({
          method: operation.method as HTTPMethods,
          url: operation.path,
          schema: {
            operationId: operation.operationId,
            summary: operation.summary,
            description:
              "Requires a current human session, a resolved human Principal and the selected IAM Driver's administer permission on the exact Installation. Service API keys are denied.",
            tags: operation.tags,
            security: [{ sessionCookie: [] }],
            "x-openclaw-permissions": [
              {
                action: "administer",
                resourceKind: "installation",
                scope: "installation",
              },
            ],
            ...(writing
              ? { body: RuntimeServiceTrustRequestSchema }
              : {
                  params: {
                    type: "object",
                    additionalProperties: false,
                    required: ["operationRef"],
                    properties: {
                      operationRef: {
                        type: "string",
                        pattern:
                          "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                      },
                    },
                  },
                }),
            response: {
              ...responses(writing ? writeSchema : recordSchema),
              400: { description: "Bad Request", ...error },
              403: { description: "Forbidden", ...error },
              404: { description: "Not Found", ...error },
              409: { description: "Conflict", ...error },
            },
          } as DocumentedFastifySchema,
          onRequest: async (request) => admit(request, operation, "runtime-service"),
          preValidation: async (request) => {
            await resolveIdentity(request, operation);
            const admitted = admissions.get(request);
            const context = contexts.get(request);
            if (admitted?.method !== "session" || !context) {
              await denial(operation, request, "authorization_denial", context);
              throw failure(403, "FORBIDDEN", "A current human administrator session is required.");
            }
          },
          handler: async (request, reply) => {
            const context = contexts.get(request);
            if (!context) throw dependencyUnavailable();
            await requireInstallationAdmin(request, operation, context);
            if (!options.runtimeServiceTrust) throw dependencyUnavailable();
            if (!writing && request.body !== undefined)
              throw failure(
                400,
                "INVALID_REQUEST",
                "The request does not match the operation contract.",
              );
            const bounded = workspaceFileRequestSignal(request, reply, 3000);
            try {
              const actor = runtimeServiceTrustOperatorContext(context, request.id);
              const data = writing
                ? await options.runtimeServiceTrust.apply(request.body, actor, bounded.signal)
                : await options.runtimeServiceTrust.recover(
                    (request.params as { operationRef: string }).operationRef,
                    actor,
                    bounded.signal,
                  );
              if (data === undefined)
                throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
              reply.send({ data, meta: { requestId: request.id } });
            } finally {
              bounded.dispose();
            }
          },
        });
      }
    });

    for (const operation of serviceKeyOperations) {
      const creating = operation.method === "POST";
      const serviceKey = {
        type: "object",
        additionalProperties: false,
        required: ["id", "servicePrincipalId", "name", "expiresAt", "key"],
        properties: {
          id: { type: "string" },
          servicePrincipalId: { type: "string" },
          namespaceId: { type: "string" },
          name: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          key: { type: "string" },
        },
      };
      routes.route({
        method: operation.method as HTTPMethods,
        url: operation.path,
        schema: {
          operationId: operation.operationId,
          summary: operation.summary,
          description: creating
            ? "Requires a session or Installation-scoped service key with administer on the Installation. Issues a Better Auth key for an existing non-Agent ServicePrincipal in its exact scope; creates no identity or IAM grant. The plaintext key is returned only here."
            : "Requires a session or Installation-scoped service key with administer on the Installation. Deletes the stored Better Auth key; subsequent requests cannot authenticate with it.",
          tags: [...operation.tags],
          security: [{ sessionCookie: [] }, { serviceApiKey: [] }],
          "x-openclaw-permissions": [
            {
              action: "administer",
              resourceKind: "installation",
              scope: "requested",
            },
          ],
          ...(creating
            ? {
                body: {
                  type: "object",
                  additionalProperties: false,
                  required: ["servicePrincipalId", "name"],
                  properties: {
                    servicePrincipalId: {
                      type: "string",
                      minLength: 1,
                      maxLength: 200,
                    },
                    namespaceId: {
                      type: "string",
                      pattern: RESOURCE_ID.namespaceId.source,
                    },
                    name: {
                      type: "string",
                      minLength: 1,
                      maxLength: 32,
                      pattern: "\\S",
                    },
                    expiresIn: {
                      type: "integer",
                      minimum: 86400,
                      maximum: 31536000,
                      description: "Lifetime in seconds; defaults to 30 days.",
                    },
                  },
                },
              }
            : {
                params: {
                  type: "object",
                  additionalProperties: false,
                  required: ["keyId"],
                  properties: {
                    keyId: { type: "string", minLength: 1, maxLength: 200 },
                  },
                },
              }),
          response: {
            ...responses(
              creating
                ? serviceKey
                : {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "revoked"],
                    properties: {
                      id: { type: "string" },
                      revoked: { type: "boolean", const: true },
                    },
                  },
              creating ? 201 : 200,
            ),
            400: { description: "Bad Request", ...error },
            403: { description: "Forbidden", ...error },
            404: { description: "Not Found", ...error },
            409: { description: "Conflict", ...error },
          },
        } as DocumentedFastifySchema,
        onRequest: async (request) => admit(request, operation, "auth"),
        preHandler: async (request) => resolveIdentity(request, operation),
        handler: async (request, reply) => {
          const context = contexts.get(request);
          if (!context) throw dependencyUnavailable();
          if (!controller)
            throw failure(409, "RESOURCE_CONFLICT", "Bootstrap the Installation first.");
          if (!creating && request.body !== undefined)
            throw failure(
              400,
              "INVALID_REQUEST",
              "The request does not match the operation contract.",
            );
          const { selected, target, decision } = await requireInstallationAdmin(
            request,
            operation,
            context,
          );
          const audit = (key: { id: string; servicePrincipalId: string }) => {
            const base = event(operation, request, target, "mutation", context, decision.evidence);
            return {
              ...base,
              details: {
                ...base.details,
                serviceKeyId: key.id,
                servicePrincipalId: key.servicePrincipalId,
              },
            };
          };
          if (creating) {
            const body = request.body as {
              servicePrincipalId: string;
              namespaceId?: string;
              name: string;
              expiresIn?: number;
            };
            let principal;
            try {
              principal = await selected.lookupIdentity({
                servicePrincipalId: body.servicePrincipalId,
                ...(body.namespaceId === undefined ? {} : { namespaceId: body.namespaceId }),
              });
            } catch {
              throw dependencyUnavailable();
            }
            if (
              !principal ||
              principal.kind !== "service_principal" ||
              principal.agentId !== undefined ||
              principal.id !== body.servicePrincipalId ||
              principal.namespaceId !== body.namespaceId
            )
              throw failure(
                400,
                "INVALID_REQUEST",
                "An existing non-Agent ServicePrincipal in the exact scope is required.",
              );
            let key;
            try {
              key = await options.auth.createServiceKey({
                principal,
                name: body.name,
                ...(body.expiresIn === undefined ? {} : { expiresIn: body.expiresIn }),
              });
              await options.auditSink.append(audit(key));
            } catch {
              // Never return an unaudited credential; remove it if audit persistence fails.
              if (key) await options.auth.revokeServiceKey(key).catch(() => {});
              throw dependencyUnavailable();
            }
            reply.status(201).send({ data: key, meta: { requestId: request.id } });
          } else {
            const { keyId } = request.params as { keyId: string };
            let key;
            try {
              key = await options.auth.getServiceKey(keyId);
            } catch {
              throw dependencyUnavailable();
            }
            if (!key) throw failure(404, "NOT_FOUND", "The service API key was not found.");
            try {
              await options.auth.revokeServiceKey(key);
              await options.auditSink.append(audit(key));
            } catch {
              throw dependencyUnavailable();
            }
            reply.send({
              data: { id: key.id, revoked: true },
              meta: { requestId: request.id },
            });
          }
        },
      });
    }

    routes.post(
      "/api/auth/sign-in/email",
      {
        schema: {
          operationId: "signInEmail",
          summary: "Sign in with email and password",
          description:
            "Reserves shared source and source/account quotas before authenticating a local account and issuing a session cookie. Exhaustion returns a generic 429 with Retry-After: 12; quota dependency failure returns 503 with Retry-After: 1. Forwarded headers do not select the quota source.",
          tags: ["Authentication"],
          security: [],
          body: {
            type: "object",
            additionalProperties: false,
            required: ["email", "password"],
            properties: {
              email: accountBody.properties.email,
              password: accountBody.properties.password,
            },
          },
          response: {
            ...responses({
              type: "object",
              additionalProperties: false,
              required: ["authenticated"],
              properties: { authenticated: { type: "boolean", const: true } },
            }),
            429: {
              description: "Too Many Requests; retry after 12 seconds",
              ...error,
            },
          },
        },
      },
      async (request, reply) => options.auth.signInEmail(request, reply),
    );
    routes.post(
      "/api/auth/sign-out",
      {
        schema: {
          operationId: "signOut",
          summary: "Sign out of the current session",
          description: "Revokes the current Better Auth session cookie.",
          tags: ["Authentication"],
          security: [{ sessionCookie: [] }],
          response: responses({ type: "object", additionalProperties: true }),
        },
      },
      async (request, reply) => options.auth.signOut(request, reply),
    );
    routes.get(
      "/api/auth/session",
      {
        schema: {
          operationId: "getAuthSession",
          summary: "Inspect authentication without revealing session tokens",
          description:
            "Returns only authenticated status and public account identity, or null without a valid session; session tokens and credentials are never returned.",
          tags: ["Authentication"],
          security: [],
          response: {
            200: {
              description: "OK",
              ...envelope({
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["authenticated", "user"],
                    properties: {
                      authenticated: { type: "boolean", const: true },
                      user: {
                        type: "object",
                        additionalProperties: false,
                        required: ["id", "email", "name"],
                        properties: {
                          id: { type: "string" },
                          email: { type: "string", format: "email" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                ],
              }),
            },
            503: { description: "Service Unavailable", ...error },
          },
        },
      },
      async (request, reply) => options.auth.session(request, reply),
    );
    routes.post(
      "/api/auth/accounts",
      {
        schema: {
          ...createAuthAccountOperation.schema,
          operationId: createAuthAccountOperation.operationId,
          summary: createAuthAccountOperation.summary,
          description:
            "Requires administer permission on the Installation. Creates a Better Auth account, an explicit IAM Principal, and a binding to the requested existing IAM Role; public signup remains disabled.",
          tags: [...createAuthAccountOperation.tags],
          security: [{ sessionCookie: [] }],
          "x-openclaw-permissions": [
            {
              action: "administer",
              resourceKind: "installation",
              scope: "requested",
            },
          ],
          response: {
            ...responses(account, 201),
            400: { description: "Bad Request", ...error },
            403: { description: "Forbidden", ...error },
            409: { description: "Conflict", ...error },
          },
        },
        onRequest: async (request) => admit(request, createAuthAccountOperation, "auth"),
        preValidation: async (request) => resolveIdentity(request, createAuthAccountOperation),
      },
      async (request, reply) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        if (options.provisionAuthAccount === undefined)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );

        const body = request.body as Record<string, unknown> | undefined;
        const email = body?.email;
        const password = body?.password;
        const name = body?.name;
        const roleId = body?.roleId;
        if (
          !isNonEmptyString(email) ||
          !isNonEmptyString(password) ||
          !isNonEmptyString(roleId) ||
          (name !== undefined && !isNonEmptyString(name))
        )
          throw failure(
            400,
            "INVALID_REQUEST",
            "The request does not match the operation contract.",
          );

        const { target, decision } = await requireInstallationAdmin(
          request,
          createAuthAccountOperation,
          context,
        );

        const account = await options.auth.createAccount({
          email,
          password,
          ...(name === undefined ? {} : { name }),
        });
        const seed = options.auth.principalSeed(account, { roleId });
        const auditEvent = event(
          createAuthAccountOperation,
          request,
          target,
          "mutation",
          context,
          decision.evidence,
        );
        try {
          await options.provisionAuthAccount(seed, auditEvent);
        } catch (error) {
          try {
            await options.auth.deleteAccount(account);
          } catch {
            // The failed provisioning path still returns the original dependency error.
          }
          throw error instanceof RequestFailure
            ? error
            : error instanceof AuthAccountRoleNotFoundError
              ? failure(
                  400,
                  "INVALID_REQUEST",
                  "The request does not match the operation contract.",
                )
              : new DependencyUnavailableError(
                  error instanceof Error ? error.message : "Auth account provisioning failed.",
                );
        }
        reply.status(201).send({
          data: {
            id: account.id,
            email: account.email,
            name: account.name,
            principalId: seed.principal.id,
          },
          meta: { requestId: request.id },
        });
      },
    );
  });

  void app.register(async (routes) => {
    routes.addSchema(ErrorResponse);
    routes.addSchema(SecretResponse);
    const configurationHandlers = createConfigurationOperationHandlers({
      resolveConfigurationService: () => {
        if (!controller)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return controller.configuration;
      },
      requestContext: (request) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        return context;
      },
      runConfigurationMutation: async (request, operation, context, mutate, resource) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return currentController.transact(async (unit) => {
          const result = await mutate();
          await unit.audit.append(event(operation, request, resource(result), "mutation", context));
          return result;
        });
      },
    });
    const secretHandlers = createSecretOperationHandlers({
      resolveSecretService: () => {
        if (!controller)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return controller.secret;
      },
      requestContext: (request) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        return context;
      },
      runSecretMutation: async (request, operation, context, mutate, resource) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return currentController.transact(async (unit) => {
          const result = await mutate();
          await unit.audit.append(event(operation, request, resource(result), "mutation", context));
          return result;
        });
      },
    });
    const serviceAccountHandlers = createServiceAccountOperationHandlers({
      resolveServiceAccountService: () => {
        if (!controller)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return controller.serviceAccount;
      },
      requestContext: (request) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        return context;
      },
      runServiceAccountMutation: async (request, operation, context, mutate, resource) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return currentController.transact(async (unit) => {
          const result = await mutate();
          await unit.audit.append(event(operation, request, resource(result), "mutation", context));
          return result;
        });
      },
    });
    const namespaceHandlers = createNamespaceOperationHandlers({
      resolveNamespaceService: () => {
        if (!controller)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return controller.namespace;
      },
      requestContext: (request) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        return context;
      },
      runNamespaceMutation: async (request, operation, context, mutate, resource) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return currentController.transact(async (unit) => {
          const result = await mutate();
          await unit.audit.append(event(operation, request, resource(result), "mutation", context));
          return result;
        });
      },
    });
    const agentHandlers = createAgentOperationHandlers({
      resolveAgentService: () => {
        if (!controller)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return controller.agent;
      },
      requestContext: (request) => {
        const context = contexts.get(request);
        if (!context)
          throw failure(
            503,
            "DEPENDENCY_UNAVAILABLE",
            "A required platform dependency is unavailable.",
          );
        return context;
      },
      runAgentMutation: async (request, operation, context, mutate, resource, project) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        return currentController.transact(async (unit) => {
          const result = await mutate();
          await unit.audit.append(event(operation, request, resource(result), "mutation", context));
          return project(result);
        });
      },
      runDeployment: async (request, operation, context, { namespaceId, agentId }) => {
        const currentController = controller;
        if (!currentController)
          throw failure(404, "NOT_FOUND", "The requested platform resource was not found.");
        // Retain trusted correlation before the transaction so an uncertain COMMIT
        // can recover this exact admission without admitting another revision.
        const admission: DeployAgentAdmissionContext = {
          transitionRef: randomUUID(),
          requestId: request.id,
          createAuditEvent: (admitted) =>
            event(
              operation,
              request,
              { kind: "agent_revision", id: admitted.id, namespaceId },
              "mutation",
              context,
            ),
        };
        let revision: Readonly<AgentRevision>;
        try {
          revision = await currentController.transact(() =>
            currentController.deployment.deployAgent(
              context.actorId,
              { namespaceId, agentId },
              options.resolveHarness,
              admission,
            ),
          );
        } catch (error) {
          if (error instanceof PostgresCommitOutcomeUnknownError) {
            revision = await currentController.deployment.recoverDeployAgent(
              context.actorId,
              { namespaceId, agentId },
              admission,
            );
          } else {
            if (error instanceof NamespaceNotReadyError)
              await rejectedMutation(operation, request, context, "NAMESPACE_NOT_READY");
            throw error;
          }
        }
        return revision;
      },
    });
    // TODO: Supply the qualified current-account request bridge and authorized
    // lifecycle repository/observation reader when those producers are available.
    const lifecycleStatusService = createLifecycleStatusServiceV1({
      resolveInstallationId: () => controller?.installation.id,
      resolveSource: () => options.lifecycleStatus?.source,
    });
    const lifecycleStatusHandlers = createLifecycleStatusOperationHandlersV1({
      resolveService: () => lifecycleStatusService,
      resolveReadCall: async (request) => options.lifecycleStatus?.resolveReadCall(request),
    });
    const handlers = {
      createChannelInstallation: perform,
      listChannelInstallations: perform,
      getChannelInstallation: perform,
      setChannelInstallationStatus: perform,
      createChannelHumanBinding: perform,
      listChannelHumanBindings: perform,
      getChannelHumanBinding: perform,
      setChannelHumanBindingStatus: perform,
      createChannelAgentBinding: perform,
      listChannelAgentBindings: perform,
      getChannelAgentBinding: perform,
      setChannelAgentBindingStatus: perform,
      getInstallation: perform,
      listProviders: perform,
      createNamespace: namespaceHandlers.createNamespace,
      listNamespaces: namespaceHandlers.listNamespaces,
      getNamespace: namespaceHandlers.getNamespace,
      deleteNamespace: namespaceHandlers.deleteNamespace,
      createConfiguration: configurationHandlers.createConfiguration,
      getConfiguration: configurationHandlers.getConfiguration,
      updateConfiguration: configurationHandlers.updateConfiguration,
      deleteConfiguration: configurationHandlers.deleteConfiguration,
      createSecret: secretHandlers.createSecret,
      getSecret: secretHandlers.getSecret,
      updateSecret: secretHandlers.updateSecret,
      deleteSecret: secretHandlers.deleteSecret,
      createServiceAccount: serviceAccountHandlers.createServiceAccount,
      listServiceAccounts: serviceAccountHandlers.listServiceAccounts,
      getServiceAccount: serviceAccountHandlers.getServiceAccount,
      createServiceAccountCredential: serviceAccountHandlers.createServiceAccountCredential,
      updateServiceAccountCredential: serviceAccountHandlers.updateServiceAccountCredential,
      deleteServiceAccount: serviceAccountHandlers.deleteServiceAccount,
      createAgent: agentHandlers.createAgent,
      updateAgent: agentHandlers.updateAgent,
      listAgents: agentHandlers.listAgents,
      getAgent: agentHandlers.getAgent,
      deployAgent: agentHandlers.deployAgent,
      getAgentWorkspaceFile: perform,
      putAgentWorkspaceFile: perform,
      listAgentRevisions: agentHandlers.listAgentRevisions,
      getAgentRevision: agentHandlers.getAgentRevision,
      getAgentLifecycleStatus: lifecycleStatusHandlers.getAgentLifecycleStatus,
      listAgentLifecycleOperations: lifecycleStatusHandlers.listAgentLifecycleOperations,
      getAgentLifecycleOperation: lifecycleStatusHandlers.getAgentLifecycleOperation,
      getAgentLifecycleCapability: lifecycleStatusHandlers.getAgentLifecycleCapability,
    };
    registerProtectedOperations(routes, handlers, { admit, resolveIdentity });
    registerBootstrapOperation(routes, bootstrapOperation, perform, {
      admit,
      resolveIdentity,
    });
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/console",
    handler: async (request, reply) => serveConsole(request, reply),
  });
  app.route({
    method: ["GET", "HEAD"],
    url: "/console/*",
    handler: async (request, reply) => serveConsole(request, reply),
  });

  async function serveConsole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const asset = await readConsoleAsset(pathname);
    reply.header("content-security-policy", CONSOLE_CONTENT_SECURITY_POLICY);
    reply.header("content-type", asset.contentType);
    reply.status(asset.statusCode).send(request.method === "HEAD" ? undefined : asset.body);
  }

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? "";
    const allowed = occApiRoutes
      .filter((operation) => {
        const pattern = operation.path.replace(/:[^/]+/g, "[^/]+");
        return new RegExp(`^${pattern}$`).test(pathname);
      })
      .map((operation) => operation.method);
    if (allowed.length > 0) {
      reply.header("allow", [...new Set(allowed)].join(", "));
      canonicalFailure(
        reply,
        failure(405, "METHOD_NOT_ALLOWED", "The requested HTTP method is not supported."),
      );
      return;
    }
    canonicalFailure(
      reply,
      failure(404, "NOT_FOUND", "The requested platform resource was not found."),
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    let mapped = requestFailure(error);
    if (
      error instanceof AuthorizationDeniedError &&
      !(error instanceof DependencyUnavailableError)
    ) {
      const context = contexts.get(request);
      if (context) {
        try {
          await denial(
            context.operation,
            request,
            "authorization_denial",
            context,
            error.evidence,
            error.authorization,
          );
        } catch (auditError) {
          mapped = requestFailure(auditError);
        }
      }
    }
    if (mapped.code === "INTERNAL_ERROR") {
      app.log.error({
        event: "http.unexpected_error",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: mapped.status,
        code: mapped.code,
      });
    }
    canonicalFailure(reply, mapped);
  });

  return app;
}

export function createControllerApp(options: ControllerAppOptions): ControllerApp {
  return createFetchAdapter(createFastifyApp(options));
}

export const createOccApi = createControllerApp;
