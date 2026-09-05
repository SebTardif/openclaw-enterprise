import { Type } from "typebox";
import { EmptyQuery, NamespaceParams, SecretParams } from "../common.ts";
import { CreateSecretBody, UpdateSecretBody } from "./resources.ts";

const ErrorResponseRef = Type.Ref("ErrorResponse");
const SecretResponseRef = Type.Ref("SecretResponse");

const readErrors = {
  400: ErrorResponseRef,
  401: ErrorResponseRef,
  403: ErrorResponseRef,
  404: ErrorResponseRef,
  500: ErrorResponseRef,
  503: ErrorResponseRef,
} as const;

const createErrors = {
  ...readErrors,
  409: ErrorResponseRef,
  413: ErrorResponseRef,
  415: ErrorResponseRef,
} as const;

const mutationErrors = {
  ...readErrors,
  409: ErrorResponseRef,
} as const;

export const secretApiRoutes = [
  {
    operationId: "createSecret",
    method: "POST",
    path: "/namespaces/:namespaceId/secrets",
    action: "openclaw.secrets.create",
    iamAction: "create",
    resourceKind: "secret",
    authorizationTarget: "namespace_collection",
    summary: "Create exact Namespace-owned Secret material and return metadata only",
    tags: ["Secrets"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      body: CreateSecretBody,
      response: { 201: SecretResponseRef, ...createErrors },
    },
  },
  {
    operationId: "getSecret",
    method: "GET",
    path: "/namespaces/:namespaceId/secrets/:secretId",
    action: "openclaw.secrets.read",
    iamAction: "read",
    resourceKind: "secret",
    authorizationTarget: "secret",
    summary: "Get exact Namespace-owned Secret metadata without revealing material",
    tags: ["Secrets"],
    schema: {
      querystring: EmptyQuery,
      params: SecretParams,
      response: { 200: SecretResponseRef, ...readErrors },
    },
  },
  {
    operationId: "updateSecret",
    method: "PATCH",
    path: "/namespaces/:namespaceId/secrets/:secretId",
    action: "openclaw.secrets.update",
    iamAction: "update",
    resourceKind: "secret",
    authorizationTarget: "secret",
    summary: "Replace exact Namespace-owned Secret material and return stable metadata",
    tags: ["Secrets"],
    schema: {
      querystring: EmptyQuery,
      params: SecretParams,
      body: UpdateSecretBody,
      response: { 200: SecretResponseRef, ...createErrors },
    },
  },
  {
    operationId: "deleteSecret",
    method: "DELETE",
    path: "/namespaces/:namespaceId/secrets/:secretId",
    action: "openclaw.secrets.delete",
    iamAction: "delete",
    resourceKind: "secret",
    authorizationTarget: "secret",
    summary: "Delete exact unbound Namespace-owned Secret material",
    tags: ["Secrets"],
    schema: {
      querystring: EmptyQuery,
      params: SecretParams,
      response: { 204: Type.Null(), ...mutationErrors },
    },
  },
] as const;

export type SecretApiRoute = (typeof secretApiRoutes)[number];
