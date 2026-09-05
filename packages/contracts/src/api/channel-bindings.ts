import { Type } from "typebox";
import {
  AgentId,
  ChannelAgentBindingId,
  ChannelHumanBindingId,
  ChannelInstallationId,
  InstallationId,
  Meta,
  NamespaceId,
  Timestamp,
} from "./common.ts";

export const ChannelReference = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
  description:
    "Opaque reference, preserved exactly; at most 1024 UTF-8 bytes, without controls or malformed Unicode.",
});
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Status = Type.Union([Type.Literal("enabled"), Type.Literal("disabled")]);
const Platform = Type.Union([Type.Literal("slack"), Type.Literal("msteams")]);
const ScopeKind = Type.Union([
  Type.Literal("slack-private-channel"),
  Type.Literal("msteams-standard-channel"),
]);
export const ChannelInstallationParams = Type.Object(
  { channelInstallationId: ChannelInstallationId },
  { additionalProperties: false },
);
export const ChannelHumanBindingParams = Type.Object(
  { channelInstallationId: ChannelInstallationId, bindingId: ChannelHumanBindingId },
  { additionalProperties: false },
);
export const ChannelAgentBindingParams = Type.Object(
  { channelInstallationId: ChannelInstallationId, bindingId: ChannelAgentBindingId },
  { additionalProperties: false },
);
export const ChannelBindingListQuery = Type.Object(
  {
    limit: Type.Optional(
      Type.String({
        pattern: "^(?:[1-9]|[1-9][0-9]|100)$",
        description: "Page size, default and maximum 100.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2048,
        pattern: "^[A-Za-z0-9_-]+$",
        description: "Opaque continuation cursor from the same parent-scoped query.",
      }),
    ),
  },
  { additionalProperties: false },
);
export const CreateChannelInstallationBody = Type.Object(
  { platform: Platform, providerTenantRef: ChannelReference, recipientAppRef: ChannelReference },
  { additionalProperties: false },
);
export const CreateChannelHumanBindingBody = Type.Object(
  {
    providerSubjectRef: ChannelReference,
    principal: Type.Object(
      { issuer: ChannelReference, subject: ChannelReference },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const CreateChannelAgentBindingBody = Type.Object(
  {
    channelRef: ChannelReference,
    scopeKind: ScopeKind,
    namespaceId: NamespaceId,
    agentId: AgentId,
  },
  { additionalProperties: false },
);
export const ChangeChannelBindingStatusBody = Type.Object(
  { expectedVersion: Version, status: Status },
  { additionalProperties: false },
);
const metadata = {
  installationId: InstallationId,
  version: Version,
  status: Status,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  createdBy: ChannelReference,
  updatedBy: ChannelReference,
};
export const ChannelInstallationSchema = Type.Object(
  {
    ...metadata,
    id: ChannelInstallationId,
    platform: Platform,
    providerTenantRef: ChannelReference,
    recipientAppRef: ChannelReference,
  },
  { additionalProperties: false },
);
export const ChannelHumanBindingSchema = Type.Object(
  {
    ...metadata,
    id: ChannelHumanBindingId,
    channelInstallationId: ChannelInstallationId,
    providerSubjectRef: ChannelReference,
    iamDriverId: ChannelReference,
    principalId: ChannelReference,
    principalIssuer: ChannelReference,
    principalSubject: ChannelReference,
  },
  { additionalProperties: false },
);
export const ChannelAgentBindingSchema = Type.Object(
  {
    ...metadata,
    id: ChannelAgentBindingId,
    channelInstallationId: ChannelInstallationId,
    channelRef: ChannelReference,
    scopeKind: ScopeKind,
    namespaceId: NamespaceId,
    agentId: AgentId,
  },
  { additionalProperties: false },
);
function response<T extends Type.TSchema>(schema: T) {
  return Type.Object({ data: schema, meta: Meta }, { additionalProperties: false });
}
function page<T extends Type.TSchema>(schema: T) {
  return response(
    Type.Object(
      {
        items: Type.Array(schema, { maxItems: 100 }),
        nextCursor: Type.Optional(
          Type.String({ minLength: 1, maxLength: 2048, pattern: "^[A-Za-z0-9_-]+$" }),
        ),
      },
      { additionalProperties: false },
    ),
  );
}
export const ChannelInstallationResponse = response(ChannelInstallationSchema);
export const ChannelHumanBindingResponse = response(ChannelHumanBindingSchema);
export const ChannelAgentBindingResponse = response(ChannelAgentBindingSchema);
export const ChannelInstallationListResponse = page(ChannelInstallationSchema);
export const ChannelHumanBindingListResponse = page(ChannelHumanBindingSchema);
export const ChannelAgentBindingListResponse = page(ChannelAgentBindingSchema);
