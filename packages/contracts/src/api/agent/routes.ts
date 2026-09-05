import { Type } from "typebox";

import { AgentParams, EmptyQuery, NamespaceParams, RevisionParams } from "../common.ts";
import {
  AgentListResponse,
  AgentResponse,
  AgentRevisionListResponse,
  AgentRevisionResponse,
  CreateAgentBody,
  UpdateAgentBody,
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

export const agentApiRoutes = [
  {
    operationId: "createAgent",
    method: "POST",
    path: "/namespaces/:namespaceId/agents",
    action: "openclaw.agents.create",
    iamAction: "create",
    resourceKind: "agent",
    authorizationTarget: "namespace_collection",
    summary: "Create a Namespace-owned Agent",
    tags: ["Agents"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      body: CreateAgentBody,
      response: { 201: AgentResponse, ...createErrors },
    },
  },
  {
    operationId: "updateAgent",
    method: "PATCH",
    path: "/namespaces/:namespaceId/agents/:agentId",
    action: "openclaw.agents.update",
    iamAction: "update",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Replace an exact Namespace-owned Agent's editable draft",
    tags: ["Agents"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      body: UpdateAgentBody,
      response: { 200: AgentResponse, ...createErrors },
    },
  },
  {
    operationId: "listAgents",
    method: "GET",
    path: "/namespaces/:namespaceId/agents",
    action: "openclaw.agents.list",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "namespace_and_agent_candidates",
    summary: "List authorized Agents in one exact Namespace",
    tags: ["Agents"],
    schema: {
      querystring: EmptyQuery,
      params: NamespaceParams,
      response: { 200: AgentListResponse, ...readErrors },
    },
  },
  {
    operationId: "getAgent",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId",
    action: "openclaw.agents.read",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Get an exact Namespace-owned Agent",
    tags: ["Agents"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      response: { 200: AgentResponse, ...readErrors },
    },
  },
  {
    operationId: "deployAgent",
    method: "POST",
    path: "/namespaces/:namespaceId/agents/:agentId/deploy",
    action: "openclaw.agents.deploy",
    iamAction: "deploy",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Admit an immutable revision from the Agent's saved draft",
    tags: ["Agents"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      response: { 202: AgentRevisionResponse, ...mutationErrors },
    },
  },
  {
    operationId: "listAgentRevisions",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/revisions",
    action: "openclaw.agent_revisions.list",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent_collection",
    summary: "List authorized immutable revisions for one exact Agent",
    tags: ["Agent revisions"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      response: { 200: AgentRevisionListResponse, ...readErrors },
    },
  },
  {
    operationId: "getAgentRevision",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/revisions/:revisionId",
    action: "openclaw.agent_revisions.read",
    iamAction: "read",
    resourceKind: "agent_revision",
    authorizationTarget: "requested_revision",
    summary: "Get an exact authorized immutable Agent revision",
    tags: ["Agent revisions"],
    schema: {
      querystring: EmptyQuery,
      params: RevisionParams,
      response: { 200: AgentRevisionResponse, ...readErrors },
    },
  },
] as const;

export type AgentApiRoute = (typeof agentApiRoutes)[number];
