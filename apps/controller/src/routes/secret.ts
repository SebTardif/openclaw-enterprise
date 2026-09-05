import type { FastifyRequest } from "fastify";
import type { NamespaceParams, SecretParams } from "@openclaw-enterprise/contracts/api/common";
import type {
  CreateSecretBody,
  UpdateSecretBody,
} from "@openclaw-enterprise/contracts/api/resources";
import type { SecretApiRoute, secretApiRoutes } from "@openclaw-enterprise/contracts/api/routes";
import type { SecretMetadata } from "@openclaw-enterprise/contracts/resources/secret";
import type { SecretServicePort } from "@openclaw-enterprise/occ";
import { failure, validateConfiguration } from "../http/errors.ts";
import type { RequestContext } from "../http/identity.ts";
import type { OperationHandlers } from "../http/operation-registry.ts";

export type SecretMutationOperation = Exclude<
  SecretApiRoute,
  { readonly operationId: "getSecret" }
>;

export interface SecretMutationResource {
  readonly kind: "secret";
  readonly id: string;
  readonly namespaceId: string;
}

export interface SecretOperationHandlerOptions {
  readonly resolveSecretService: () => SecretServicePort;
  readonly requestContext: (request: FastifyRequest) => RequestContext;
  readonly runSecretMutation: <T>(
    request: FastifyRequest,
    operation: SecretMutationOperation,
    context: RequestContext,
    mutate: () => Promise<T>,
    resource: (result: T) => SecretMutationResource,
  ) => Promise<T>;
}

function clientSecret(secret: Readonly<SecretMetadata>): Record<string, unknown> {
  return { id: secret.id, namespaceId: secret.namespaceId, name: secret.name, ref: secret.ref };
}

/** Protected registration owns admission and schema validation before these handlers run. */
export function createSecretOperationHandlers(
  options: SecretOperationHandlerOptions,
): OperationHandlers<typeof secretApiRoutes> {
  function resolve(request: FastifyRequest) {
    const context = options.requestContext(request);
    if (request.body !== undefined) validateConfiguration(request.body);
    const service = options.resolveSecretService();
    const params = request.params as NamespaceParams;
    if (!params.namespaceId)
      throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
    return { context, service, namespaceId: params.namespaceId };
  }

  return {
    createSecret: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const body = request.body as CreateSecretBody;
      const secret = await options.runSecretMutation(
        request,
        operation,
        context,
        async () =>
          clientSecret(
            await service.createSecret(context.actorId, {
              namespaceId,
              name: body.name,
              value: body.value,
            }),
          ),
        (created) => ({ kind: "secret", id: created.id as string, namespaceId }),
      );
      reply.status(201).send({ data: secret, meta: { requestId: request.id } });
    },
    getSecret: async (request, reply) => {
      const { context, service, namespaceId } = resolve(request);
      const { secretId } = request.params as SecretParams;
      const secret = await service.readSecret(context.actorId, namespaceId, secretId);
      reply.send({ data: clientSecret(secret), meta: { requestId: request.id } });
    },
    updateSecret: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { secretId } = request.params as SecretParams;
      const body = request.body as UpdateSecretBody;
      const secret = await options.runSecretMutation(
        request,
        operation,
        context,
        async () =>
          clientSecret(
            await service.updateSecret(context.actorId, {
              namespaceId,
              secretId,
              value: body.value,
            }),
          ),
        (updated) => ({ kind: "secret", id: updated.id as string, namespaceId }),
      );
      reply.send({ data: secret, meta: { requestId: request.id } });
    },
    deleteSecret: async (request, reply, operation) => {
      const { context, service, namespaceId } = resolve(request);
      const { secretId } = request.params as SecretParams;
      await options.runSecretMutation(
        request,
        operation,
        context,
        () => service.deleteSecret(context.actorId, namespaceId, secretId),
        () => ({ kind: "secret", id: secretId, namespaceId }),
      );
      reply.status(204).send();
    },
  };
}
