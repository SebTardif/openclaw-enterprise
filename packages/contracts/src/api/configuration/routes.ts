import { Type } from "typebox";

import { ConfigurationParams, EmptyQuery, NamespaceParams } from "../common.ts";
import {
  ConfigurationResponse,
  CreateConfigurationBody,
  UpdateConfigurationBody,
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

export const configurationApiRoutes = [
  {
    operationId: "createConfiguration",
    method: "POST",
    path: "/namespaces/:namespaceId/configurations",
    action: "openclaw.configurations.create",
    iamAction: "create",
    resourceKind: "configuration",
    authorizationTarget: "namespace_collection",
    summary: "Create a native Namespace-owned Agent Configuration",
    tags: ["Configurations"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      body: CreateConfigurationBody,
      response: { 201: ConfigurationResponse, ...createErrors },
    },
  },
  {
    operationId: "getConfiguration",
    method: "GET",
    path: "/namespaces/:namespaceId/configurations/:configurationId",
    action: "openclaw.configurations.read",
    iamAction: "read",
    resourceKind: "configuration",
    authorizationTarget: "configuration",
    summary: "Get an exact Namespace-owned Configuration",
    tags: ["Configurations"],
    schema: {
      querystring: EmptyQuery,
      params: ConfigurationParams,
      response: { 200: ConfigurationResponse, ...readErrors },
    },
  },
  {
    operationId: "updateConfiguration",
    method: "PATCH",
    path: "/namespaces/:namespaceId/configurations/:configurationId",
    action: "openclaw.configurations.update",
    iamAction: "update",
    resourceKind: "configuration",
    authorizationTarget: "configuration",
    summary: "Replace values and increment an exact Namespace-owned Configuration generation",
    tags: ["Configurations"],
    schema: {
      querystring: EmptyQuery,
      params: ConfigurationParams,
      body: UpdateConfigurationBody,
      response: { 200: ConfigurationResponse, ...createErrors },
    },
  },
  {
    operationId: "deleteConfiguration",
    method: "DELETE",
    path: "/namespaces/:namespaceId/configurations/:configurationId",
    action: "openclaw.configurations.delete",
    iamAction: "delete",
    resourceKind: "configuration",
    authorizationTarget: "configuration",
    summary: "Delete an exact unreferenced Namespace-owned Configuration",
    tags: ["Configurations"],
    schema: {
      querystring: EmptyQuery,
      params: ConfigurationParams,
      response: { 204: Type.Null(), ...mutationErrors },
    },
  },
] as const;

export type ConfigurationApiRoute = (typeof configurationApiRoutes)[number];
