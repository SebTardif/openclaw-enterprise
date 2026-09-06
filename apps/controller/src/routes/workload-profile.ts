import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import {
  decodeWorkloadProfilePrepareEnvelopeV1,
  decodeWorkloadProfileWithdrawV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import { decodeWorkloadProfileJson } from "@openclaw-enterprise/occ/workload-profiles/canonical";
import {
  WorkloadProfileAcknowledgementSchema,
  WorkloadProfileUnknownOutcomeSchema,
  WorkloadProfilePreparationProjectionSchema,
  WorkloadProfileAdmissionProjectionSchema,
} from "@openclaw-enterprise/contracts/api/workload-profile/resources";
import type {
  WorkloadProfileServicePort,
  ProfileMutationResponse,
} from "@openclaw-enterprise/occ/services/workload-profile/port";
import { failure } from "../http/errors.ts";

export interface WorkloadProfileHandlerOptions {
  readonly service: WorkloadProfileServicePort;
  /** Owned by actual authentication middleware, never reconstructed from the body. */
  readonly invocation: (request: FastifyRequest) => Promise<AuthenticatedRequestHandleV1>;
  readonly signal: (request: FastifyRequest) => AbortSignal;
}
/** Install only on the operator's encapsulated Fastify child. Raw UTF-8 is
 * decoded before ordinary JSON parsing can discard duplicate operator keys. */
export function installWorkloadProfileJsonParser(routes: FastifyInstance): void {
  routes.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    try {
      if (!(body instanceof Uint8Array)) throw new TypeError("Expected request bytes.");
      done(null, decodeWorkloadProfileJson(body, "operator-envelope").value);
    } catch {
      done(failure(400, "INVALID_REQUEST", "The request does not match the operation contract."));
    }
  });
}
function exactResponse(schema: TSchema, data: unknown): unknown {
  if (!Check(schema, data))
    throw failure(500, "INTERNAL_ERROR", "The operation response is unavailable.");
  return data;
}
function mutationResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  data: ProfileMutationResponse,
) {
  const unknown = data.kind === "commit-unknown";
  const exact = exactResponse(
    unknown ? WorkloadProfileUnknownOutcomeSchema : WorkloadProfileAcknowledgementSchema,
    data,
  );
  return reply.status(unknown ? 202 : 200).send({ data: exact, meta: { requestId: request.id } });
}
function reference(request: FastifyRequest, field: "operationRef" | "admissionRef"): string {
  const value = (request.params as Record<string, unknown>)[field];
  if (typeof value !== "string")
    throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
  return value;
}
/** Unregistered handlers for the closed operator routes. Protected registration
 * must validate schemas and real custody; the current service is unavailable. */
export function createWorkloadProfileOperationHandlers(options: WorkloadProfileHandlerOptions) {
  return Object.freeze({
    prepareWorkloadProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      const input = decodeWorkloadProfilePrepareEnvelopeV1(request.body);
      if (input.kind !== "valid")
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      return mutationResponse(
        request,
        reply,
        await options.service.prepare(
          await options.invocation(request),
          input.value,
          options.signal(request),
        ),
      );
    },
    acceptWorkloadProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.body !== undefined)
        throw failure(400, "INVALID_REQUEST", "This operation has no request body.");
      return mutationResponse(
        request,
        reply,
        await options.service.accept(
          await options.invocation(request),
          reference(request, "operationRef"),
          options.signal(request),
        ),
      );
    },
    withdrawWorkloadProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      const input = decodeWorkloadProfileWithdrawV1(request.body);
      if (input.kind !== "valid")
        throw failure(400, "INVALID_REQUEST", "The request does not match the operation contract.");
      return mutationResponse(
        request,
        reply,
        await options.service.withdraw(
          await options.invocation(request),
          reference(request, "admissionRef"),
          input.value,
          options.signal(request),
        ),
      );
    },
    getWorkloadProfileOperation: async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await options.service.readOperation(
        await options.invocation(request),
        reference(request, "operationRef"),
        options.signal(request),
      );
      return reply.send({
        data: exactResponse(WorkloadProfilePreparationProjectionSchema, data),
        meta: { requestId: request.id },
      });
    },
    getWorkloadProfile: async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await options.service.readProfile(
        await options.invocation(request),
        reference(request, "admissionRef"),
        options.signal(request),
      );
      return reply.send({
        data: exactResponse(WorkloadProfileAdmissionProjectionSchema, data),
        meta: { requestId: request.id },
      });
    },
  });
}
