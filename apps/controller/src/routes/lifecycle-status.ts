import type { FastifyReply, FastifyRequest } from "fastify";
import { Check } from "typebox/value";
import { lifecycleApiRoutes } from "@openclaw-enterprise/contracts/api/agent/lifecycle-routes";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import {
  parseLifecycleStatusReadRequestV1,
  projectLifecycleStatusReadV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadRequestV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";

export interface LifecycleStatusHttpDependenciesV1 {
  /** A qualified reader enforces current account/session/selected IAM and exact
   * Agent read at disclosure. Supplying an interface does not qualify a reader. */
  readonly source: LifecycleStatusReadPortV1;
  /** Resolve the original private authenticated invocation from server-owned
   * verified request custody. Header/body/actor identifiers are not handles.
   * The original signal must cover request cancellation and bounded cleanup. */
  readonly resolveReadCall: (request: FastifyRequest) => Promise<LifecycleReadCallV1 | undefined>;
}

export interface LifecycleStatusOperationHandlerOptionsV1 {
  readonly resolveService: () => LifecycleStatusReadPortV1 | undefined;
  readonly resolveReadCall: (request: FastifyRequest) => Promise<LifecycleReadCallV1 | undefined>;
}

const failures = {
  INVALID_REQUEST: [400, "The request does not match the operation contract."],
  UNAUTHENTICATED: [401, "Authentication is required."],
  FORBIDDEN: [403, "The requested operation is not permitted."],
  NOT_FOUND: [404, "The requested platform resource was not found."],
  NAMESPACE_NOT_READY: [409, "The Namespace is not ready for this operation."],
  INTERNAL_ERROR: [500, "The platform could not complete the operation."],
  DEPENDENCY_UNAVAILABLE: [503, "A required platform dependency is unavailable."],
} as const;

function sendFailure(request: FastifyRequest, reply: FastifyReply, code: keyof typeof failures) {
  const [status, message] = failures[code];
  return reply.status(status).send({ error: { code, message }, meta: { requestId: request.id } });
}

function httpInput(method: LifecycleStatusReadMethodV1, request: FastifyRequest): unknown {
  const operationId = {
    readStatus: "getAgentLifecycleStatus",
    readOperation: "getAgentLifecycleOperation",
    listOperations: "listAgentLifecycleOperations",
    readCapability: "getAgentLifecycleCapability",
  } as const;
  const route = lifecycleApiRoutes.find((entry) => entry.operationId === operationId[method])!;
  if (
    request.body !== undefined ||
    Number(request.headers["content-length"] ?? 0) > 0 ||
    request.headers["transfer-encoding"] !== undefined ||
    !Check(route.schema.params, request.params) ||
    !Check(route.schema.querystring, request.query)
  )
    throw new Error("Invalid lifecycle read request.");
  const params = request.params as { namespaceId: string; agentId: string; operationRef?: string };
  const scope = { namespaceId: params.namespaceId, agentId: params.agentId };
  if (method === "readOperation")
    return { schemaVersion: 1, ...scope, operationRef: params.operationRef };
  if (method === "listOperations") {
    const query = request.query as { limit?: string; afterGeneration?: string };
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    const afterGeneration =
      query.afterGeneration === undefined ? null : Number(query.afterGeneration);
    // URL text remains distinct from the canonical numeric/null request. The
    // original parser below additionally enforces safe integers and all bounds.
    return { schemaVersion: 1, ...scope, limit, afterGeneration };
  }
  return scope;
}

/** Protected registration still owns HTTP admission and identity resolution.
 * These handlers consume an independently qualified private call and reader;
 * they never construct either from the earlier admission/identity projection.
 * Each request/page invokes one method and returns only the original sanitizer's
 * closed result. There is no page walk, provider request or mutation retry. */
export function createLifecycleStatusOperationHandlersV1(
  options: LifecycleStatusOperationHandlerOptionsV1,
) {
  async function read<K extends LifecycleStatusReadMethodV1>(
    method: K,
    request: FastifyRequest,
    reply: FastifyReply,
    invoke: (
      service: LifecycleStatusReadPortV1,
      input: LifecycleStatusReadRequestV1<K>,
      call: LifecycleReadCallV1,
    ) => Promise<unknown>,
  ) {
    reply.header("cache-control", "no-store");
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
    let input: LifecycleStatusReadRequestV1<K>;
    try {
      input = parseLifecycleStatusReadRequestV1(method, httpInput(method, request));
    } catch {
      return sendFailure(request, reply, "INVALID_REQUEST");
    }
    try {
      const service = options.resolveService();
      if (!service) return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
      const call = await options.resolveReadCall(request);
      if (!call) return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
      const signal = call.signal;
      if (signal.aborted || options.resolveService() !== service)
        return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
      const result = projectLifecycleStatusReadV1(
        method,
        input,
        await invoke(service, input, call),
      );
      if (signal.aborted || call.signal !== signal || options.resolveService() !== service)
        return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
      if (result.kind === "unavailable")
        return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
      if (result.kind === "rejected") return sendFailure(request, reply, result.code);
      return reply.send({ data: result.value, meta: { requestId: request.id } });
    } catch {
      return sendFailure(request, reply, "DEPENDENCY_UNAVAILABLE");
    }
  }

  return Object.freeze({
    getAgentLifecycleStatus: (request: FastifyRequest, reply: FastifyReply) =>
      read("readStatus", request, reply, (service, input, call) => service.readStatus(input, call)),
    getAgentLifecycleOperation: (request: FastifyRequest, reply: FastifyReply) =>
      read("readOperation", request, reply, (service, input, call) =>
        service.readOperation(input, call),
      ),
    listAgentLifecycleOperations: (request: FastifyRequest, reply: FastifyReply) =>
      read("listOperations", request, reply, (service, input, call) =>
        service.listOperations(input, call),
      ),
    getAgentLifecycleCapability: (request: FastifyRequest, reply: FastifyReply) =>
      read("readCapability", request, reply, (service, input, call) =>
        service.readCapability(input, call),
      ),
  });
}
