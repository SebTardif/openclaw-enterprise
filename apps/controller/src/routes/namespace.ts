import type { FastifyRequest } from "fastify";
import type { NamespaceParams } from "@openclaw-enterprise/contracts/api/common";
import type { CreateNamespaceBody } from "@openclaw-enterprise/contracts/api/resources";
import type {
  NamespaceApiRoute,
  namespaceApiRoutes,
} from "@openclaw-enterprise/contracts/api/routes";
import type { NamespaceServicePort } from "@openclaw-enterprise/occ";
import { failure, validateConfiguration } from "../http/errors.ts";
import type { RequestContext } from "../http/identity.ts";
import type { OperationHandlers } from "../http/operation-registry.ts";

export type NamespaceMutationOperation = Extract<
  NamespaceApiRoute,
  { readonly operationId: "createNamespace" | "deleteNamespace" }
>;

export interface NamespaceMutationResource {
  readonly kind: "namespace";
  readonly id: string;
  readonly namespaceId: string;
}

export interface NamespaceOperationHandlerOptions {
  readonly resolveNamespaceService: () => NamespaceServicePort;
  readonly requestContext: (request: FastifyRequest) => RequestContext;
  readonly runNamespaceMutation: <T>(
    request: FastifyRequest,
    operation: NamespaceMutationOperation,
    context: RequestContext,
    mutate: () => Promise<T>,
    resource: (result: T) => NamespaceMutationResource,
  ) => Promise<T>;
}

/** Protected registration owns admission and schema validation before these handlers run. */
export function createNamespaceOperationHandlers(
  options: NamespaceOperationHandlerOptions,
): OperationHandlers<typeof namespaceApiRoutes> {
  function resolve(request: FastifyRequest) {
    const context = options.requestContext(request);
    if (request.body !== undefined) validateConfiguration(request.body);
    const service = options.resolveNamespaceService();
    return { context, service };
  }

  function exactNamespaceId(request: FastifyRequest): string {
    const { namespaceId } = request.params as NamespaceParams;
    if (!namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return namespaceId;
  }

  return {
    createNamespace: async (request, reply, operation) => {
      const { context, service } = resolve(request);
      const body = request.body as CreateNamespaceBody;
      const namespace = await options.runNamespaceMutation(
        request,
        operation,
        context,
        () =>
          service.createNamespace(context.actorId, {
            name: body.name,
            ...(body.existingNamespace === undefined
              ? {}
              : { existingNamespace: body.existingNamespace }),
          }),
        (created) => ({ kind: "namespace", id: created.id, namespaceId: created.id }),
      );
      reply.status(201).send({ data: namespace, meta: { requestId: request.id } });
    },
    listNamespaces: async (request, reply) => {
      const { context, service } = resolve(request);
      reply.send({
        data: await service.listNamespaces(context.actorId),
        meta: { requestId: request.id },
      });
    },
    getNamespace: async (request, reply) => {
      const { context, service } = resolve(request);
      const namespaceId = exactNamespaceId(request);
      reply.send({
        data: await service.getNamespace(context.actorId, namespaceId),
        meta: { requestId: request.id },
      });
    },
    deleteNamespace: async (request, reply, operation) => {
      const { context, service } = resolve(request);
      const namespaceId = exactNamespaceId(request);
      const namespace = await options.runNamespaceMutation(
        request,
        operation,
        context,
        () => service.deleteNamespace(context.actorId, namespaceId),
        (deleting) => ({ kind: "namespace", id: deleting.id, namespaceId: deleting.id }),
      );
      reply.status(202).send({ data: namespace, meta: { requestId: request.id } });
    },
  };
}
