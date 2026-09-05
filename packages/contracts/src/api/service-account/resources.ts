import { Type } from "typebox";
import {
  Meta,
  Name,
  NamespaceId,
  ServiceAccountCredentialSchema,
  ServiceAccountId,
} from "../common.ts";

export const CreateServiceAccountBody = Type.Object(
  { name: Name },
  { additionalProperties: false },
);

export const CreateServiceAccountCredentialBody = Type.Object({}, { additionalProperties: false });

export const UpdateServiceAccountCredentialBody = Type.Object(
  {
    kind: Type.Union([Type.Literal("api_key"), Type.Literal("oauth_access_token")]),
    secretRef: ServiceAccountCredentialSchema.properties.secretRef,
  },
  { additionalProperties: false },
);

export const ServiceAccountSchema = Type.Object(
  {
    id: ServiceAccountId,
    namespaceId: NamespaceId,
    name: Name,
    credential: Type.Optional(ServiceAccountCredentialSchema),
  },
  { additionalProperties: false },
);

export const ServiceAccountResponse = Type.Object(
  { data: ServiceAccountSchema, meta: Meta },
  { additionalProperties: false },
);

export const ServiceAccountListResponse = Type.Object(
  { data: Type.Array(ServiceAccountSchema), meta: Meta },
  { additionalProperties: false },
);

export type ServiceAccountWire = Type.Static<typeof ServiceAccountSchema>;
export type ServiceAccountResponse = Type.Static<typeof ServiceAccountResponse>;
export type ServiceAccountListResponse = Type.Static<typeof ServiceAccountListResponse>;

export type CreateServiceAccountBody = Type.Static<typeof CreateServiceAccountBody>;
export type CreateServiceAccountCredentialBody = Type.Static<
  typeof CreateServiceAccountCredentialBody
>;
export type UpdateServiceAccountCredentialBody = Type.Static<
  typeof UpdateServiceAccountCredentialBody
>;
