import type { FastifyError, FastifyReply } from "fastify";
import {
  ConfigurationOwnershipError,
  ConfigurationValidationError,
} from "@openclaw-enterprise/contracts/configuration-errors";
import {
  AuthorizationDeniedError,
  ChannelBindingInvalidError,
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import { WorkloadProfilePrerequisiteErrorV2 } from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import { responseHeaders } from "./transport.ts";

export interface ErrorDetail {
  readonly path: string;
  readonly code:
    | "REQUIRED"
    | "UNKNOWN_FIELD"
    | "INVALID_TYPE"
    | "INVALID_FORMAT"
    | "INVALID_VALUE"
    | "TOO_LONG"
    | "TOO_DEEP";
}

export class RequestFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: readonly ErrorDetail[];

  constructor(status: number, code: string, message: string, details?: readonly ErrorDetail[]) {
    super(message);
    this.name = "RequestFailure";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function failure(
  status: number,
  code: string,
  message: string,
  details?: readonly ErrorDetail[],
): RequestFailure {
  return new RequestFailure(status, code, message, details);
}

export function jsonPointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function validateConfiguration(value: unknown, depth = 0, path = ""): void {
  if (depth > 24)
    throw failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
      { path, code: "TOO_DEEP" },
    ]);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries())
      validateConfiguration(entry, depth + 1, `${path}/${index}`);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      throw failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
        { path: `${path}/${jsonPointer(key)}`, code: "INVALID_VALUE" },
      ]);
    validateConfiguration(entry, depth + 1, `${path}/${jsonPointer(key)}`);
  }
}

export function canonicalFailure(reply: FastifyReply, error: RequestFailure): void {
  responseHeaders(reply, reply.request.id);
  reply.status(error.status).send({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
    meta: { requestId: reply.request.id },
  });
}

export function validationCode(keyword: string): ErrorDetail["code"] {
  switch (keyword) {
    case "required":
      return "REQUIRED";
    case "additionalProperties":
      return "UNKNOWN_FIELD";
    case "type":
      return "INVALID_TYPE";
    case "format":
    case "pattern":
      return "INVALID_FORMAT";
    case "maxLength":
      return "TOO_LONG";
    default:
      return "INVALID_VALUE";
  }
}

export function validationDetails(error: FastifyError): readonly ErrorDetail[] {
  if (!Array.isArray(error.validation)) return [];
  return error.validation.slice(0, 32).map((detail): ErrorDetail => {
    const parameters = detail.params as Record<string, unknown>;
    let path = typeof detail.instancePath === "string" ? detail.instancePath : "";
    if (detail.keyword === "required" && typeof parameters.missingProperty === "string")
      path += `/${jsonPointer(parameters.missingProperty)}`;
    if (
      detail.keyword === "additionalProperties" &&
      typeof parameters.additionalProperty === "string"
    )
      path += `/${jsonPointer(parameters.additionalProperty)}`;
    return { path, code: validationCode(detail.keyword) };
  });
}

export function requestFailure(error: unknown): RequestFailure {
  if (error instanceof RequestFailure) return error;
  if (error instanceof ChannelBindingInvalidError)
    return failure(400, "INVALID_REQUEST", "The channel binding request is invalid.");
  if (error instanceof ConfigurationValidationError)
    return failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.");
  if (error instanceof ConfigurationOwnershipError)
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  if (error instanceof NamespaceNotReadyError)
    return failure(
      409,
      "NAMESPACE_NOT_READY",
      "The requested Namespace is not ready for deployment.",
    );
  if (error instanceof NamespaceNotEmptyError)
    return failure(409, "NAMESPACE_NOT_EMPTY", "The requested Namespace is not empty.");
  if (
    error instanceof DependencyUnavailableError ||
    error instanceof WorkloadProfilePrerequisiteErrorV2
  )
    return failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  if (error instanceof ResourceConflictError)
    return failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.");
  if (error instanceof ScopeViolationError)
    return failure(404, "NOT_FOUND", "The requested platform resource was not found.");
  if (error instanceof AuthorizationDeniedError)
    return failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
  if (error instanceof Error) {
    const candidate = error as FastifyError;
    if (error.name === "APIError") {
      const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
      const status = typeof statusCode === "number" ? statusCode : 500;
      if (status === 409)
        return failure(409, "RESOURCE_CONFLICT", "The requested platform resource already exists.");
      if (status === 400)
        return failure(
          400,
          "INVALID_REQUEST",
          "The request does not match the operation contract.",
        );
      if (status === 401)
        return failure(401, "UNAUTHENTICATED", "The caller did not provide valid credentials.");
      if (status === 403)
        return failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
      return failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }
    if (candidate.code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return failure(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the permitted size.");
    if (candidate.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
      return failure(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.");
    if (
      candidate.code === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
      candidate.code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" ||
      candidate.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      candidate.statusCode === 400
    ) {
      const details = validationDetails(candidate);
      return failure(
        400,
        "INVALID_REQUEST",
        "The request does not match the operation contract.",
        details.length > 0 ? details : undefined,
      );
    }
    if (error.name === "AdmissionFailure") {
      const status =
        candidate.statusCode === 403 || (candidate as { status?: number }).status === 403
          ? 403
          : 401;
      return failure(
        status,
        status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        status === 403
          ? "The request did not satisfy the configured admission boundary."
          : "The caller did not provide valid admission evidence.",
      );
    }
  }
  return failure(500, "INTERNAL_ERROR", "The platform request could not be completed.");
}
