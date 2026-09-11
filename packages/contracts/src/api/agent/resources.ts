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
  RuntimeCredentialValue,
  SecretBindings,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
  Timestamp,
} from "../common.ts";

export const MaximumExecutionMs = Type.Union([
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Null(),
]);

export const CreateAgentBody = Type.Object(
  {
    name: Name,
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    serviceAccountId: Type.Optional(ServiceAccountId),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    maximumExecutionMs: Type.Optional(MaximumExecutionMs),
  },
  { additionalProperties: false },
);

export const UpdateAgentBody = Type.Object(
  {
    configurationId: ConfigurationId,
    providerId: Type.Optional(Type.Union([ProviderId, Type.Null()])),
    serviceAccountId: Type.Optional(Type.Union([ServiceAccountId, Type.Null()])),
    executionMode: Type.Optional(HarnessExecutionModeSchema),
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    maximumExecutionMs: Type.Optional(MaximumExecutionMs),
    workloadProfileSelection: Type.Optional(WorkloadProfileSelectionSchemaV1),
  },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialsBody = Type.Object(
  {
    modelApiKey: Type.Optional(RuntimeCredentialValue),
    slack: Type.Optional(
      Type.Object(
        {
          appToken: RuntimeCredentialValue,
          botToken: RuntimeCredentialValue,
        },
        { additionalProperties: false },
      ),
    ),
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
    plugins: Type.Optional(Type.Ref("PluginDesiredState")),
    maximumExecutionMs: MaximumExecutionMs,
    activeRevisionId: Type.Optional(RevisionId),
    workloadProfileSelection: Type.Optional(WorkloadProfileSelectionSchemaV1),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialStatusSchema = Type.Object(
  {
    transportConfigured: Type.Boolean(),
    modelConfigured: Type.Boolean(),
    slackConfigured: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AgentRuntimeCredentialResponse = Type.Object(
  { data: AgentRuntimeCredentialStatusSchema, meta: Meta },
  { $id: "AgentRuntimeCredentialResponse", additionalProperties: false },
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
    maximumExecutionMs: Type.Optional(MaximumExecutionMs),
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
    plugins: Type.Optional(
      Type.Object(
        { driver: Type.Ref("PluginDriverIdentity"), plugins: Type.Ref("PluginDesiredState") },
        { additionalProperties: false },
      ),
    ),
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

export type AgentRuntimeCredentialsBody = Type.Static<typeof AgentRuntimeCredentialsBody>;
export type AgentRuntimeCredentialStatusWire = Type.Static<
  typeof AgentRuntimeCredentialStatusSchema
>;
export type AgentRuntimeCredentialResponse = Type.Static<typeof AgentRuntimeCredentialResponse>;
