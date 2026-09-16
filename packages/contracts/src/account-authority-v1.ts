import { Type, type Static } from "typebox";
import { ConfigurationGeneration } from "./api/common.ts";

/** Original account and selected-IAM epochs. These observations grant no authority. */
export const AccountVersionVectorSchemaV1 = Type.Object(
  {
    installation: ConfigurationGeneration,
    account: ConfigurationGeneration,
    credential: ConfigurationGeneration,
    grants: ConfigurationGeneration,
    iamPolicy: ConfigurationGeneration,
    semanticMapping: ConfigurationGeneration,
    driverSelection: ConfigurationGeneration,
  },
  { additionalProperties: false },
);
export type AccountVersionVectorV1 = Readonly<Static<typeof AccountVersionVectorSchemaV1>>;
