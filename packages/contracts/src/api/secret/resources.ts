import { Type } from "typebox";
import { Meta, Name, NamespaceId, SecretId, SecretReference, SecretValue } from "../common.ts";

export const CreateSecretBody = Type.Object(
  { name: Name, value: SecretValue },
  { additionalProperties: false },
);

export const UpdateSecretBody = Type.Object(
  { value: SecretValue },
  { additionalProperties: false },
);

export const SecretSchema = Type.Object(
  {
    id: SecretId,
    namespaceId: NamespaceId,
    name: Name,
    ref: SecretReference,
  },
  { additionalProperties: false },
);

export const SecretResponse = Type.Object(
  { data: SecretSchema, meta: Meta },
  {
    $id: "SecretResponse",
    additionalProperties: false,
  },
);

export type CreateSecretBody = Type.Static<typeof CreateSecretBody>;
export type UpdateSecretBody = Type.Static<typeof UpdateSecretBody>;
export type SecretWire = Type.Static<typeof SecretSchema>;
export type SecretResponse = Type.Static<typeof SecretResponse>;
