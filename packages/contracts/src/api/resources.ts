import { Type } from "typebox";
export {
  CreateAgentBody,
  AgentRuntimeCredentialsBody,
  AgentRuntimeCredentialStatusSchema,
  AgentRuntimeCredentialResponse,
  type AgentRuntimeCredentialStatusWire,
  UpdateAgentBody,
  AgentSchema,
  AgentResponse,
  AgentListResponse,
  AgentRevisionSchema,
  AgentRevisionResponse,
  AgentRevisionListResponse,
  type AgentWire,
  type AgentRevisionWire,
} from "./agent/resources.ts";
export {
  CreateNamespaceBody,
  NamespaceSchema,
  NamespaceResponse,
  NamespaceListResponse,
  type NamespaceWire,
} from "./namespace/resources.ts";
export {
  SecretSchema,
  SecretResponse,
  CreateSecretBody,
  UpdateSecretBody,
  type SecretWire,
} from "./secret/resources.ts";
export {
  ServiceAccountSchema,
  ServiceAccountResponse,
  ServiceAccountListResponse,
  CreateServiceAccountBody,
  CreateServiceAccountCredentialBody,
  UpdateServiceAccountCredentialBody,
  type ServiceAccountWire,
} from "./service-account/resources.ts";
export {
  ConfigurationSchema,
  ConfigurationResponse,
  CreateConfigurationBody,
  UpdateConfigurationBody,
  type ConfigurationWire,
} from "./configuration/resources.ts";

import {
  InstallationId,
  Meta,
  Name,
  NamespaceId,
  ProviderId,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
  Timestamp,
  WorkspaceFileName,
  PluginApprovalModeSchema,
  PluginApprovalsReviewerSchema,
} from "./common.ts";

export const InstallationSchema = Type.Object(
  { id: InstallationId, name: Name, createdAt: Timestamp },
  { additionalProperties: false },
);

export const ProviderSummarySchema = Type.Object(
  { id: ProviderId, type: Type.Literal("chatgpt") },
  { additionalProperties: false },
);

export const InstallationResponse = Type.Object(
  { data: InstallationSchema, meta: Meta },
  { additionalProperties: false },
);

export const ProviderListResponse = Type.Object(
  { data: Type.Array(ProviderSummarySchema), meta: Meta },
  { additionalProperties: false },
);

export const WorkspaceFileResponse = Type.Object(
  {
    data: Type.Object(
      {
        name: WorkspaceFileName,
        content: Type.String({ maxLength: 16 * 1024, pattern: "^[^\\u0000]*$" }),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const WorkspaceFileUpdateResponse = Type.Object(
  {
    data: Type.Object(
      {
        name: WorkspaceFileName,
        size: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 * 1024 })),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export type InstallationWire = Type.Static<typeof InstallationSchema>;
export type ProviderSummaryWire = Type.Static<typeof ProviderSummarySchema>;
export type InstallationResponse = Type.Static<typeof InstallationResponse>;
export type ProviderListResponse = Type.Static<typeof ProviderListResponse>;
export type WorkspaceFileResponse = Type.Static<typeof WorkspaceFileResponse>;
export type WorkspaceFileUpdateResponse = Type.Static<typeof WorkspaceFileUpdateResponse>;

export const PluginDriverIdentitySchema = Type.Object(
  { id: Type.String({ minLength: 1 }), implementation: Type.String({ minLength: 1 }) },
  { additionalProperties: false, $id: "PluginDriverIdentity" },
);

export const PluginToolPolicySchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    approvalMode: Type.Optional(PluginApprovalModeSchema),
  },
  { additionalProperties: false, minProperties: 1, $id: "PluginToolPolicy" },
);

const PluginIdPattern = "^[A-Za-z0-9._~:@-]{1,253}$";
const PluginToolPolicyMapSchema = Type.Unsafe({
  type: "object",
  description:
    "Plugin tool policy map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$.",
  propertyNames: { pattern: PluginIdPattern },
  additionalProperties: false,
  patternProperties: {
    [PluginIdPattern]: Type.Ref("PluginToolPolicy"),
  },
});

export const PluginDesiredSelectionSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    approvalMode: PluginApprovalModeSchema,
    approvalsReviewer: Type.Optional(PluginApprovalsReviewerSchema),
    destructiveActions: Type.Optional(PluginApprovalModeSchema),
    writes: Type.Optional(PluginApprovalModeSchema),
    tools: Type.Optional(PluginToolPolicyMapSchema),
  },
  { additionalProperties: false, $id: "PluginDesiredSelection" },
);

export const PluginDesiredStateSchema = Type.Unsafe({
  $id: "PluginDesiredState",
  type: "object",
  description:
    "Agent plugin selection map. Keys must be 1-253 characters matching ^[A-Za-z0-9._~:@-]{1,253}$.",
  propertyNames: { pattern: PluginIdPattern },
  additionalProperties: false,
  patternProperties: {
    [PluginIdPattern]: Type.Ref("PluginDesiredSelection"),
  },
});
