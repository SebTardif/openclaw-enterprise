import { Type } from "typebox";

import { KubernetesNamespaceName, Meta, Name, NamespaceId, Timestamp } from "../common.ts";

export const CreateNamespaceBody = Type.Object(
  { name: Name, existingNamespace: Type.Optional(KubernetesNamespaceName) },
  { additionalProperties: false },
);

export const NamespaceSchema = Type.Object(
  {
    id: NamespaceId,
    name: Name,
    existingNamespace: Type.Optional(KubernetesNamespaceName),
    status: Type.Union([
      Type.Literal("provisioning"),
      Type.Literal("ready"),
      Type.Literal("failed"),
      Type.Literal("deleting"),
    ]),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const NamespaceResponse = Type.Object(
  { data: NamespaceSchema, meta: Meta },
  { additionalProperties: false },
);

export const NamespaceListResponse = Type.Object(
  { data: Type.Array(NamespaceSchema), meta: Meta },
  { additionalProperties: false },
);

export type CreateNamespaceBody = Type.Static<typeof CreateNamespaceBody>;
export type NamespaceWire = Type.Static<typeof NamespaceSchema>;
export type NamespaceResponse = Type.Static<typeof NamespaceResponse>;
export type NamespaceListResponse = Type.Static<typeof NamespaceListResponse>;
