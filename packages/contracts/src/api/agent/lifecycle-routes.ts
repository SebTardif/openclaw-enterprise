import { Type } from "typebox";

import { AgentParams, EmptyQuery, Meta } from "../common.ts";
import { LifecycleOperationReadRequestSchemaV1 } from "../../lifecycle-admission-v1.ts";
import {
  LifecycleCapabilitySchemaV1,
  LifecycleOperationPageSchemaV1,
  LifecycleOperationStatusSchemaV1,
  LifecycleStatusSchemaV1,
} from "../../lifecycle-observation-v1.ts";

const ErrorResponseRef = Type.Ref("ErrorResponse");
const readErrors = {
  400: ErrorResponseRef,
  401: ErrorResponseRef,
  403: ErrorResponseRef,
  404: ErrorResponseRef,
  409: ErrorResponseRef,
  500: ErrorResponseRef,
  503: ErrorResponseRef,
} as const;

const OperationParams = Type.Object(
  {
    ...AgentParams.properties,
    operationRef: LifecycleOperationReadRequestSchemaV1.properties.operationRef,
  },
  { additionalProperties: false },
);
const OperationsQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 3,
        pattern: "^(?:[1-9][0-9]?|100)(?![\\s\\S])",
        default: "20",
      }),
    ),
    // Transport coercion/default insertion is disabled. The handler validates
    // this decimal text as a safe integer and supplies numeric limit/defaults
    // and the absent cursor's null in the original canonical page request.
    afterGeneration: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 16,
        pattern: "^[1-9][0-9]{0,15}(?![\\s\\S])",
      }),
    ),
  },
  { additionalProperties: false },
);

/** HTTP envelopes reuse the canonical lifecycle values. Route metadata and
 * schema validation do not establish read authority or runtime observations. */
export const lifecycleApiRoutes = [
  {
    operationId: "getAgentLifecycleStatus",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/lifecycle",
    action: "openclaw.agents.lifecycle.read",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Read lifecycle status for an exact Agent",
    tags: ["Agent lifecycle"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      response: {
        200: Type.Object(
          { data: LifecycleStatusSchemaV1, meta: Meta },
          { additionalProperties: false },
        ),
        ...readErrors,
      },
    },
  },
  {
    operationId: "listAgentLifecycleOperations",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/lifecycle/operations",
    action: "openclaw.agents.lifecycle.operations.list",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "List lifecycle operations for an exact Agent",
    tags: ["Agent lifecycle"],
    schema: {
      querystring: OperationsQuery,
      params: AgentParams,
      response: {
        200: Type.Object(
          { data: LifecycleOperationPageSchemaV1, meta: Meta },
          { additionalProperties: false },
        ),
        ...readErrors,
      },
    },
  },
  {
    operationId: "getAgentLifecycleOperation",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/lifecycle/operations/:operationRef",
    action: "openclaw.agents.lifecycle.operations.read",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Read an exact historical Agent lifecycle operation",
    tags: ["Agent lifecycle"],
    schema: {
      querystring: EmptyQuery,
      params: OperationParams,
      response: {
        200: Type.Object(
          { data: LifecycleOperationStatusSchemaV1, meta: Meta },
          { additionalProperties: false },
        ),
        ...readErrors,
      },
    },
  },
  {
    operationId: "getAgentLifecycleCapability",
    method: "GET",
    path: "/namespaces/:namespaceId/agents/:agentId/lifecycle/capability",
    action: "openclaw.agents.lifecycle.capability.read",
    iamAction: "read",
    resourceKind: "agent",
    authorizationTarget: "agent",
    summary: "Read lifecycle compatibility for an exact Agent",
    tags: ["Agent lifecycle"],
    schema: {
      querystring: EmptyQuery,
      params: AgentParams,
      response: {
        200: Type.Object(
          { data: LifecycleCapabilitySchemaV1, meta: Meta },
          { additionalProperties: false },
        ),
        ...readErrors,
      },
    },
  },
] as const;

export type LifecycleApiRoute = (typeof lifecycleApiRoutes)[number];
