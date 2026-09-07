import type { FastifyRequest } from "fastify";
import type {
  AgentParams,
  NamespaceParams,
  RevisionParams,
} from "@openclaw-enterprise/contracts/api/common";
import type {
  CreateAgentBody,
  UpdateAgentBody,
} from "@openclaw-enterprise/contracts/api/resources";
import type { AgentApiRoute, agentApiRoutes } from "@openclaw-enterprise/contracts/api/routes";
import type { Agent, AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import {
  decodeLifecycleDeployV2,
  type LifecycleDeployCommandV2,
} from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import {
  decodeLifecycleAdmissionV1,
  type LifecycleAcceptedReceiptV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type { AgentServicePort } from "@openclaw-enterprise/occ";
import { failure, validateConfiguration } from "../http/errors.ts";
import type { RequestContext } from "../http/identity.ts";
import type { OperationHandlers } from "../http/operation-registry.ts";

export type AgentMutationOperation = Extract<
  AgentApiRoute,
  { readonly operationId: "createAgent" | "updateAgent" }
>;

export type AgentDeploymentOperation = Extract<
  AgentApiRoute,
  { readonly operationId: "deployAgent" }
>;

export interface AgentMutationResource {
  readonly kind: "agent";
  readonly id: string;
  readonly namespaceId: string;
}

export interface AgentOperationHandlerOptions {
  readonly resolveAgentService: () => AgentServicePort;
  readonly requestContext: (request: FastifyRequest) => RequestContext;
  readonly runAgentMutation: <T, Result>(
    request: FastifyRequest,
    operation: AgentMutationOperation,
    context: RequestContext,
    mutate: () => Promise<T>,
    resource: (result: T) => AgentMutationResource,
    project: (result: T) => Result,
  ) => Promise<Result>;
  /** Composition retains admission correlation, transaction ownership, and COMMIT recovery. */
  readonly runDeployment: (
    request: FastifyRequest,
    operation: AgentDeploymentOperation,
    context: RequestContext,
    input: {
      readonly namespaceId: string;
      readonly agentId: string;
      readonly command: LifecycleDeployCommandV2;
    },
  ) => Promise<LifecycleAcceptedReceiptV1>;
}

function clientAgent(agent: Readonly<Agent>): Record<string, unknown> {
  return {
    id: agent.id,
    namespaceId: agent.namespaceId,
    name: agent.name,
    configurationId: agent.configurationId,
    providerId: agent.providerId,
    executionMode: agent.executionMode,
    ...(agent.serviceAccountId === undefined ? {} : { serviceAccountId: agent.serviceAccountId }),
    ...(agent.activeRevisionId === undefined ? {} : { activeRevisionId: agent.activeRevisionId }),
    ...(agent.workloadProfileSelection === undefined
      ? {}
      : { workloadProfileSelection: agent.workloadProfileSelection }),
    createdAt: agent.createdAt,
  };
}

function clientRevision(revision: Readonly<AgentRevision>): Record<string, unknown> {
  return {
    id: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revision: revision.revision,
    configurationId: revision.configurationId,
    configurationKind: revision.configurationKind,
    configurationGeneration: revision.configurationGeneration,
    providerId: revision.providerId,
    configuration: revision.configuration,
    harness: revision.harness,
    compute: revision.compute,
    ...(revision.secretDriverId === undefined ? {} : { secretDriverId: revision.secretDriverId }),
    ...(revision.secretBindings === undefined ? {} : { secretBindings: revision.secretBindings }),
    ...(revision.serviceAccount === undefined ? {} : { serviceAccount: revision.serviceAccount }),
    ...(revision.workloadProfileUse === undefined
      ? {}
      : { workloadProfileUse: revision.workloadProfileUse }),
    createdAt: revision.createdAt,
  };
}

/** Protected registration owns admission and schema validation before these handlers run. */
export function createAgentOperationHandlers(
  options: AgentOperationHandlerOptions,
): OperationHandlers<typeof agentApiRoutes> {
  function resolve(request: FastifyRequest) {
    const context = options.requestContext(request);
    if (request.body !== undefined) validateConfiguration(request.body);
    const service = options.resolveAgentService();
    const params = request.params as NamespaceParams;
    if (!params.namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return { context, service, namespaceId: params.namespaceId };
  }

  function resolveAgent(request: FastifyRequest) {
    const resolved = resolve(request);
    const { agentId } = request.params as AgentParams;
    if (!agentId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return { ...resolved, agentId };
  }

  return {
    createAgent: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const body = request.body as CreateAgentBody;
      const agent = await options.runAgentMutation(
        request,
        operation,
        context,
        () =>
          service.createAgent(context.actorId, {
            namespaceId,
            name: body.name,
            configurationId: body.configurationId,
            ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
            ...(body.executionMode === undefined ? {} : { executionMode: body.executionMode }),
            ...(body.serviceAccountId === undefined
              ? {}
              : { serviceAccountId: body.serviceAccountId }),
          }),
        (created) => ({ kind: "agent", id: created.id, namespaceId }),
        clientAgent,
      );
      reply.status(201).send({ data: agent, meta: { requestId: request.id } });
    },
    updateAgent: async (request, reply, operation) => {
      const { context, service, namespaceId, agentId } = resolveAgent(request);
      const body = request.body as UpdateAgentBody;
      const agent = await options.runAgentMutation(
        request,
        operation,
        context,
        () =>
          service.updateAgent(context.actorId, {
            namespaceId,
            agentId,
            configurationId: body.configurationId,
            ...(body.providerId === undefined ? {} : { providerId: body.providerId }),
            ...(body.executionMode === undefined ? {} : { executionMode: body.executionMode }),
            ...(body.serviceAccountId === undefined
              ? {}
              : { serviceAccountId: body.serviceAccountId }),
            ...(body.workloadProfileSelection === undefined
              ? {}
              : { workloadProfileSelection: body.workloadProfileSelection }),
          }),
        (updated) => ({ kind: "agent", id: updated.id, namespaceId }),
        clientAgent,
      );
      reply.send({ data: agent, meta: { requestId: request.id } });
    },
    listAgents: async (request, reply) => {
      const { context, service, namespaceId } = resolve(request);
      const agents = await service.listAgents(context.actorId, namespaceId);
      reply.send({ data: agents.map(clientAgent), meta: { requestId: request.id } });
    },
    getAgent: async (request, reply) => {
      const { context, service, namespaceId, agentId } = resolveAgent(request);
      reply.send({
        data: clientAgent(await service.getAgent(context.actorId, namespaceId, agentId)),
        meta: { requestId: request.id },
      });
    },
    deployAgent: async (request, reply, operation) => {
      const { context, namespaceId, agentId } = resolveAgent(request);
      const command = decodeLifecycleDeployV2("command", request.body);
      if (command.kind !== "valid")
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      const result = await options.runDeployment(request, operation, context, {
        namespaceId,
        agentId,
        command: command.value,
      });
      const receipt = decodeLifecycleAdmissionV1("mutationReceipt", result);
      if (
        receipt.kind !== "valid" ||
        receipt.value.disposition !== "accepted" ||
        receipt.value.operation.kind !== "deploy" ||
        receipt.value.operation.operationRef !== command.value.operationRef
      )
        throw failure(503, "DEPENDENCY_UNAVAILABLE", "The deployment receipt is unavailable.");
      reply.status(202).send({ data: receipt.value, meta: { requestId: request.id } });
    },
    listAgentRevisions: async (request, reply) => {
      const { context, service, namespaceId, agentId } = resolveAgent(request);
      const revisions = await service.listRevisions(context.actorId, namespaceId, agentId);
      reply.send({ data: revisions.map(clientRevision), meta: { requestId: request.id } });
    },
    getAgentRevision: async (request, reply) => {
      const { context, service, namespaceId, agentId } = resolveAgent(request);
      const { revisionId } = request.params as RevisionParams;
      const revision = await service.getRevision(context.actorId, namespaceId, agentId, revisionId);
      reply.send({ data: clientRevision(revision), meta: { requestId: request.id } });
    },
  };
}
