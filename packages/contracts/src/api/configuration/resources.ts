import { Type } from "typebox";

import {
  ConfigurationGeneration,
  ConfigurationId,
  ConfigurationKindSchema,
  ConfigurationValues,
  Meta,
  NamespaceId,
  SecretBindings,
  Timestamp,
} from "../common.ts";

export const CreateConfigurationBody = Type.Object(
  {
    kind: ConfigurationKindSchema,
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
  },
  { additionalProperties: false },
);

export const UpdateConfigurationBody = Type.Object(
  {
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
    expectedGeneration: Type.Optional(ConfigurationGeneration),
  },
  { additionalProperties: false },
);

export const ConfigurationSchema = Type.Object(
  {
    id: ConfigurationId,
    namespaceId: NamespaceId,
    kind: ConfigurationKindSchema,
    generation: ConfigurationGeneration,
    values: ConfigurationValues,
    secretBindings: Type.Optional(SecretBindings),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

export const ConfigurationResponse = Type.Object(
  { data: ConfigurationSchema, meta: Meta },
  { additionalProperties: false },
);

export type CreateConfigurationBody = Type.Static<typeof CreateConfigurationBody>;
export type UpdateConfigurationBody = Type.Static<typeof UpdateConfigurationBody>;
export type ConfigurationWire = Type.Static<typeof ConfigurationSchema>;
export type ConfigurationResponse = Type.Static<typeof ConfigurationResponse>;
