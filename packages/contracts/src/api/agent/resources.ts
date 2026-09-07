import { Type } from "typebox";
import {
  WorkloadProfileSelectionSchemaV1,
  WorkloadProfileUseSchemaV2,
} from "../../workload-profile-v1.ts";

import {
  AgentId,
  ConfigurationGeneration,
  ConfigurationId,
  ConfigurationKindSchema,
  ConfigurationValues,
  HarnessExecutionModeSchema,
  Meta,
  Name,
  NamespaceId,
  ProviderId,
  RevisionId,
  SecretBindings,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
  Timestamp,
} from "../common.ts";

export const CreateAgentBody = Type.Object(
  {
    name: Name,
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    serviceAccountId: Type.Optional(ServiceAccountId),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
  },
  { additionalProperties: false },
);

export const UpdateAgentBody = Type.Object(
  {
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    serviceAccountId: Type.Optional(Type.Union([ServiceAccountId, Type.Null()])),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    workloadProfileSelection: Type.Optional(WorkloadProfileSelectionSchemaV1),
  },
  { additionalProperties: false },
);

export const AgentSchema = Type.Object(
  {
    id: AgentId,
    namespaceId: NamespaceId,
    name: Name,
    configurationId: ConfigurationId,
    providerId: Type.Union([ProviderId, Type.Null()]),
    serviceAccountId: Type.Optional(ServiceAccountId),
    executionMode: HarnessExecutionModeSchema,
    activeRevisionId: Type.Optional(RevisionId),
    workloadProfileSelection: Type.Optional(WorkloadProfileSelectionSchemaV1),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentResponse = Type.Object(
  { data: AgentSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentListResponse = Type.Object(
  { data: Type.Array(AgentSchema), meta: Meta },
  { additionalProperties: false },
);

export const AgentRevisionSchema = Type.Object(
  {
    id: RevisionId,
    namespaceId: NamespaceId,
    agentId: AgentId,
    revision: Type.Integer({ minimum: 1 }),
    providerId: Type.Union([ProviderId, Type.Null()]),
    configurationId: ConfigurationId,
    configurationKind: ConfigurationKindSchema,
    configurationGeneration: ConfigurationGeneration,
    configuration: ConfigurationValues,
    harness: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        version: Type.String({ minLength: 1 }),
        mode: HarnessExecutionModeSchema,
      },
      { additionalProperties: false },
    ),
    compute: Type.Object(
      { id: Type.String({ minLength: 1 }), implementation: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    workloadProfileUse: Type.Optional(WorkloadProfileUseSchemaV2),
    secretDriverId: Type.Optional(Type.String({ minLength: 1 })),
    secretBindings: Type.Optional(SecretBindings),
    serviceAccount: Type.Optional(
      Type.Object(
        {
          id: ServiceAccountId,
          credential: Type.Object(
            {
              kind: Type.Union([Type.Literal("api_key"), Type.Literal("access_token")]),
              secretRef: ServiceAccountCredentialSchema.properties.secretRef,
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentRevisionResponse = Type.Object(
  { data: AgentRevisionSchema, meta: Meta },
  { additionalProperties: false },
);

export const AgentRevisionListResponse = Type.Object(
  { data: Type.Array(AgentRevisionSchema), meta: Meta },
  { additionalProperties: false },
);

export type CreateAgentBody = Type.Static<typeof CreateAgentBody>;
export type UpdateAgentBody = Type.Static<typeof UpdateAgentBody>;
export type AgentWire = Type.Static<typeof AgentSchema>;
export type AgentRevisionWire = Type.Static<typeof AgentRevisionSchema>;
export type AgentResponse = Type.Static<typeof AgentResponse>;
export type AgentListResponse = Type.Static<typeof AgentListResponse>;
export type AgentRevisionResponse = Type.Static<typeof AgentRevisionResponse>;
export type AgentRevisionListResponse = Type.Static<typeof AgentRevisionListResponse>;
