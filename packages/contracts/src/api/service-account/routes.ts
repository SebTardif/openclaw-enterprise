import { Type } from "typebox";
import { EmptyQuery, NamespaceParams, ServiceAccountParams } from "../common.ts";
import {
  CreateServiceAccountBody,
  CreateServiceAccountCredentialBody,
  UpdateServiceAccountCredentialBody,
  ServiceAccountListResponse,
  ServiceAccountResponse,
} from "./resources.ts";

const ErrorResponseRef = Type.Ref("ErrorResponse");

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

export const serviceAccountApiRoutes = [
  {
    operationId: "createServiceAccount",
    method: "POST",
    path: "/namespaces/:namespaceId/service-accounts",
    action: "openclaw.service_accounts.create",
    iamAction: "create",
    resourceKind: "service_account",
    authorizationTarget: "namespace_collection",
    summary: "Create a native Namespace-owned ServiceAccount",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      body: CreateServiceAccountBody,
      response: { 201: ServiceAccountResponse, ...createErrors },
    },
  },
  {
    operationId: "listServiceAccounts",
    method: "GET",
    path: "/namespaces/:namespaceId/service-accounts",
    action: "openclaw.service_accounts.list",
    iamAction: "read",
    resourceKind: "service_account",
    authorizationTarget: "namespace_and_service_account_candidates",
    summary: "List authorized Namespace-owned ServiceAccounts in one exact Namespace",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      response: { 200: ServiceAccountListResponse, ...readErrors },
    },
  },
  {
    operationId: "getServiceAccount",
    method: "GET",
    path: "/namespaces/:namespaceId/service-accounts/:serviceAccountId",
    action: "openclaw.service_accounts.read",
    iamAction: "read",
    resourceKind: "service_account",
    authorizationTarget: "service_account",
    summary: "Get an exact Namespace-owned ServiceAccount",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: ServiceAccountParams,
      response: { 200: ServiceAccountResponse, ...readErrors },
    },
  },
  {
    operationId: "createServiceAccountCredential",
    method: "POST",
    path: "/namespaces/:namespaceId/service-accounts/:serviceAccountId/credentials",
    action: "openclaw.service_accounts.credentials.create",
    iamAction: "update",
    resourceKind: "service_account",
    authorizationTarget: "service_account",
    summary: "Issue a managed credential for an exact Namespace-owned ServiceAccount",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: ServiceAccountParams,
      body: CreateServiceAccountCredentialBody,
      response: { 201: ServiceAccountResponse, ...createErrors },
    },
  },
  {
    operationId: "updateServiceAccountCredential",
    method: "PATCH",
    path: "/namespaces/:namespaceId/service-accounts/:serviceAccountId/credential",
    action: "openclaw.service_accounts.update",
    iamAction: "update",
    resourceKind: "service_account",
    authorizationTarget: "service_account",
    summary: "Associate an exact Namespace-local credential reference with a ServiceAccount",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: ServiceAccountParams,
      body: UpdateServiceAccountCredentialBody,
      response: { 200: ServiceAccountResponse, ...createErrors },
    },
  },
  {
    operationId: "deleteServiceAccount",
    method: "DELETE",
    path: "/namespaces/:namespaceId/service-accounts/:serviceAccountId",
    action: "openclaw.service_accounts.delete",
    iamAction: "delete",
    resourceKind: "service_account",
    authorizationTarget: "service_account",
    summary: "Delete an exact unreferenced Namespace-owned ServiceAccount",
    tags: ["Service accounts"],
    schema: {
      querystring: EmptyQuery,
      params: ServiceAccountParams,
      response: { 204: Type.Null(), ...mutationErrors },
    },
  },
] as const;

export type ServiceAccountApiRoute = (typeof serviceAccountApiRoutes)[number];
