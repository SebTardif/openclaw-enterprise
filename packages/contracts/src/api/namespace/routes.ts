import { Type } from "typebox";

import { EmptyQuery, NamespaceParams } from "../common.ts";
import { CreateNamespaceBody, NamespaceListResponse, NamespaceResponse } from "./resources.ts";

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

export const namespaceApiRoutes = [
  {
    operationId: "createNamespace",
    method: "POST",
    path: "/namespaces",
    action: "openclaw.namespaces.create",
    iamAction: "create",
    resourceKind: "namespace",
    authorizationTarget: "installation_collection",
    summary: "Create an Installation-owned Namespace",
    tags: ["Namespaces"],
    schema: {
      querystring: EmptyQuery,
      body: CreateNamespaceBody,
      response: { 201: NamespaceResponse, ...createErrors },
    },
  },
  {
    operationId: "listNamespaces",
    method: "GET",
    path: "/namespaces",
    action: "openclaw.namespaces.list",
    iamAction: "read",
    resourceKind: "namespace",
    authorizationTarget: "namespace_candidates",
    summary: "List authorized Namespaces",
    tags: ["Namespaces"],
    schema: {
      querystring: EmptyQuery,
      response: { 200: NamespaceListResponse, ...readErrors },
    },
  },
  {
    operationId: "getNamespace",
    method: "GET",
    path: "/namespaces/:namespaceId",
    action: "openclaw.namespaces.read",
    iamAction: "read",
    resourceKind: "namespace",
    authorizationTarget: "namespace",
    summary: "Get an exact Installation-owned Namespace",
    tags: ["Namespaces"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      response: { 200: NamespaceResponse, ...readErrors },
    },
  },
  {
    operationId: "deleteNamespace",
    method: "DELETE",
    path: "/namespaces/:namespaceId",
    action: "openclaw.namespaces.delete",
    iamAction: "delete",
    resourceKind: "namespace",
    authorizationTarget: "namespace",
    summary: "Begin deletion of an empty Installation-owned Namespace",
    tags: ["Namespaces"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      response: { 202: NamespaceResponse, ...mutationErrors },
    },
  },
] as const;

export type NamespaceApiRoute = (typeof namespaceApiRoutes)[number];
