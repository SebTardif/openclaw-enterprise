import type { FastifyRequest } from "fastify";
import type {
  NamespaceParams,
  ServiceAccountParams,
} from "@openclaw-enterprise/contracts/api/common";
import type {
  CreateServiceAccountBody,
  UpdateServiceAccountCredentialBody,
  ServiceAccountWire,
} from "@openclaw-enterprise/contracts/api/resources";
import type {
  ServiceAccountApiRoute,
  serviceAccountApiRoutes,
} from "@openclaw-enterprise/contracts/api/routes";
import type { ServiceAccount } from "@openclaw-enterprise/contracts/resources/service-account";
import type { ServiceAccountServicePort } from "@openclaw-enterprise/occ";
import { failure, validateConfiguration } from "../http/errors.ts";
import type { RequestContext } from "../http/identity.ts";
import type { OperationHandlers } from "../http/operation-registry.ts";

export type ServiceAccountMutationOperation = Exclude<
  ServiceAccountApiRoute,
  { readonly operationId: "getServiceAccount" | "listServiceAccounts" }
>;

export interface ServiceAccountMutationResource {
  readonly kind: "service_account";
  readonly id: string;
  readonly namespaceId: string;
}

export interface ServiceAccountOperationHandlerOptions {
  readonly resolveServiceAccountService: () => ServiceAccountServicePort;
  readonly requestContext: (request: FastifyRequest) => RequestContext;
  readonly runServiceAccountMutation: <T>(
    request: FastifyRequest,
    operation: ServiceAccountMutationOperation,
    context: RequestContext,
    mutate: () => Promise<T>,
    resource: (result: T) => ServiceAccountMutationResource,
  ) => Promise<T>;
}

function clientServiceAccount(account: Readonly<ServiceAccount>): ServiceAccountWire {
  return {
    id: account.id,
    namespaceId: account.namespaceId,
    name: account.name,
    ...(account.credential === undefined ? {} : { credential: account.credential }),
  };
}

/** Protected registration owns admission and schema validation before these handlers run. */
export function createServiceAccountOperationHandlers(
  options: ServiceAccountOperationHandlerOptions,
): OperationHandlers<typeof serviceAccountApiRoutes> {
  function resolve(request: FastifyRequest) {
    const context = options.requestContext(request);
    if (request.body !== undefined) validateConfiguration(request.body);
    const service = options.resolveServiceAccountService();
    const params = request.params as NamespaceParams;
    if (!params.namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return { context, service, namespaceId: params.namespaceId };
  }

  return {
    createServiceAccount: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const body = request.body as CreateServiceAccountBody;
      const account = await options.runServiceAccountMutation(
        request,
        operation,
        context,
        async () =>
          clientServiceAccount(
            await service.createServiceAccount(context.actorId, {
              namespaceId,
              name: body.name,
            }),
          ),
        (created) => ({ kind: "service_account", id: created.id, namespaceId }),
      );
      reply.status(201).send({ data: account, meta: { requestId: request.id } });
    },
    listServiceAccounts: async (request, reply) => {
      const { context, service, namespaceId } = resolve(request);
      const accounts = await service.listServiceAccounts(context.actorId, namespaceId);
      reply.send({ data: accounts.map(clientServiceAccount), meta: { requestId: request.id } });
    },
    getServiceAccount: async (request, reply) => {
      const { context, service, namespaceId } = resolve(request);
      const { serviceAccountId } = request.params as ServiceAccountParams;
      const account = await service.getServiceAccount(
        context.actorId,
        namespaceId,
        serviceAccountId,
      );
      reply.send({ data: clientServiceAccount(account), meta: { requestId: request.id } });
    },
    createServiceAccountCredential: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { serviceAccountId } = request.params as ServiceAccountParams;
      const account = await options.runServiceAccountMutation(
        request,
        operation,
        context,
        async () =>
          clientServiceAccount(
            await service.createServiceAccountCredential(
              context.actorId,
              namespaceId,
              serviceAccountId,
            ),
          ),
        (updated) => ({ kind: "service_account", id: updated.id, namespaceId }),
      );
      reply.status(201).send({ data: account, meta: { requestId: request.id } });
    },
    updateServiceAccountCredential: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { serviceAccountId } = request.params as ServiceAccountParams;
      const body = request.body as UpdateServiceAccountCredentialBody;
      const account = await options.runServiceAccountMutation(
        request,
        operation,
        context,
        async () =>
          clientServiceAccount(
            await service.updateServiceAccountCredential(
              context.actorId,
              namespaceId,
              serviceAccountId,
              body,
            ),
          ),
        (updated) => ({ kind: "service_account", id: updated.id, namespaceId }),
      );
      reply.send({ data: account, meta: { requestId: request.id } });
    },
    deleteServiceAccount: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { serviceAccountId } = request.params as ServiceAccountParams;
      await options.runServiceAccountMutation(
        request,
        operation,
        context,
        () => service.deleteServiceAccount(context.actorId, namespaceId, serviceAccountId),
        () => ({ kind: "service_account", id: serviceAccountId, namespaceId }),
      );
      reply.status(204).send();
    },
  };
}
