import type { FastifyRequest } from "fastify";
import type {
  ConfigurationParams,
  NamespaceParams,
} from "@openclaw-enterprise/contracts/api/common";
import type {
  CreateConfigurationBody,
  UpdateConfigurationBody,
} from "@openclaw-enterprise/contracts/api/resources";
import type {
  ConfigurationApiRoute,
  configurationApiRoutes,
} from "@openclaw-enterprise/contracts/api/routes";
import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts/resources/configuration";
import type { ConfigurationServicePort } from "@openclaw-enterprise/occ";
import { failure, validateConfiguration } from "../http/errors.ts";
import type { RequestContext } from "../http/identity.ts";
import type { OperationHandlers } from "../http/operation-registry.ts";

export type ConfigurationMutationOperation = Exclude<
  ConfigurationApiRoute,
  { readonly operationId: "getConfiguration" }
>;

export interface ConfigurationMutationResource {
  readonly kind: "configuration";
  readonly id: string;
  readonly namespaceId: string;
}

export interface ConfigurationOperationHandlerOptions {
  readonly resolveConfigurationService: () => ConfigurationServicePort;
  readonly requestContext: (request: FastifyRequest) => RequestContext;
  readonly runConfigurationMutation: <T>(
    request: FastifyRequest,
    operation: ConfigurationMutationOperation,
    context: RequestContext,
    mutate: () => Promise<T>,
    resource: (result: T) => ConfigurationMutationResource,
  ) => Promise<T>;
}

/** Protected registration owns admission and schema validation before these handlers run. */
export function createConfigurationOperationHandlers(
  options: ConfigurationOperationHandlerOptions,
): OperationHandlers<typeof configurationApiRoutes> {
  function resolve(request: FastifyRequest) {
    const context = options.requestContext(request);
    if (request.body !== undefined) validateConfiguration(request.body);
    const service = options.resolveConfigurationService();
    const params = request.params as NamespaceParams;
    if (!params.namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return { context, service, namespaceId: params.namespaceId };
  }

  return {
    createConfiguration: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const body = request.body as CreateConfigurationBody;
      const configuration = await options.runConfigurationMutation(
        request,
        operation,
        context,
        () =>
          service.createConfiguration(context.actorId, {
            namespaceId,
            kind: body.kind,
            values: body.values as OpenClawConfigurationDocument,
            ...(body.secretBindings === undefined ? {} : { secretBindings: body.secretBindings }),
          }),
        (created) => ({ kind: "configuration", id: created.id, namespaceId }),
      );
      reply.status(201).send({ data: configuration, meta: { requestId: request.id } });
    },
    getConfiguration: async (request, reply) => {
      const { context, service, namespaceId } = resolve(request);
      const { configurationId } = request.params as ConfigurationParams;
      const configuration = await service.getConfiguration(
        context.actorId,
        namespaceId,
        configurationId,
      );
      reply.send({ data: configuration, meta: { requestId: request.id } });
    },
    updateConfiguration: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { configurationId } = request.params as ConfigurationParams;
      const body = request.body as UpdateConfigurationBody;
      const configuration = await options.runConfigurationMutation(
        request,
        operation,
        context,
        () =>
          service.updateConfiguration(context.actorId, {
            namespaceId,
            configurationId,
            values: body.values as OpenClawConfigurationDocument,
            ...(body.secretBindings === undefined ? {} : { secretBindings: body.secretBindings }),
            ...(body.expectedGeneration === undefined
              ? {}
              : { expectedGeneration: body.expectedGeneration }),
          }),
        (updated) => ({ kind: "configuration", id: updated.id, namespaceId }),
      );
      reply.send({ data: configuration, meta: { requestId: request.id } });
    },
    deleteConfiguration: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { configurationId } = request.params as ConfigurationParams;
      await options.runConfigurationMutation(
        request,
        operation,
        context,
        () => service.deleteConfiguration(context.actorId, namespaceId, configurationId),
        () => ({ kind: "configuration", id: configurationId, namespaceId }),
      );
      reply.status(204).send();
    },
  };
}
