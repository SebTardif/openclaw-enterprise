import { createCredentialSchemaRegistryV1 } from "@openclaw-enterprise/occ";
import {
  registerSelectedRecipeOperationRowsV1,
  githubOperationRegistrationsV1,
  type CredentialSchemaRegistryV1,
  type SelectedRecipeDefinitionsV1,
  type SelectedRecipeOperationRowsV1,
  type DefinitionRef,
  type RecipeOperation,
  type SchemaRegistration,
  type SelectedRecipeOperationRegistrationV1,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";

import { syntheticArchiveOperationRegistrationsV1 } from "./synthetic-provider.ts";

/** Declaration call site only. Trusted startup must provide actual admitted operands. */
export function gatewayRegistrationProducer(
  definitions: SelectedRecipeDefinitionsV1<"github" | "exampleArchive">,
  options: Parameters<typeof createCredentialSchemaRegistryV1>[1],
): SelectedRecipeOperationRowsV1<"github" | "exampleArchive"> {
  const originalGithub: DefinitionRef = definitions.github;
  const originalExample: DefinitionRef = definitions.exampleArchive;
  const schemas: CredentialSchemaRegistryV1 = createCredentialSchemaRegistryV1(
    [originalGithub, originalExample],
    options,
  );
  const selected: SelectedRecipeOperationRowsV1<"github" | "exampleArchive"> =
    registerSelectedRecipeOperationRowsV1(schemas, definitions);
  return selected;
}
export function registrationDataCorrespondence(): void {
  const rows: readonly SelectedRecipeOperationRegistrationV1[] = [
    ...githubOperationRegistrationsV1,
    ...syntheticArchiveOperationRegistrationsV1,
  ];
  for (const row of rows) {
    const originalOperation: RecipeOperation = row.operation;
    const originalRegistration: SchemaRegistration = row.operationRegistration;
    const originalDefinition: DefinitionRef = row.definition;
    void originalOperation;
    void originalRegistration;
    void originalDefinition;
  }
}
