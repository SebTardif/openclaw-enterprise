import { createNativeRootIamAdmissionV1 } from "@openclaw-enterprise/occ";
import {
  type SelectedRecipeOperationRowsV1,
  type SelectedRecipeOperationRowV1,
  type RegisteredSchemaCodec,
  type RetainedSchemaValue,
  type DefinitionRef,
  type ResourceIdentity,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";

type OriginalProjectionOwner = Parameters<
  typeof createNativeRootIamAdmissionV1
>[0]["grantOperations"];
type OriginalGrant = Parameters<OriginalProjectionOwner["projectRegisteredGrant"]>[0];
type OriginalProjection = ReturnType<OriginalProjectionOwner["projectRegisteredGrant"]>;

/** Original synchronous projector call site; this fixture does not implement its owner. */
export function originalGrantProjectorConsumer(
  owner: OriginalProjectionOwner,
  grant: OriginalGrant,
  rows: SelectedRecipeOperationRowsV1<"github" | "exampleArchive">,
): OriginalProjection {
  for (const row of [...rows.github, ...rows.exampleArchive]) {
    const originalDefinition: DefinitionRef = row.definition;
    const originalCodec: RegisteredSchemaCodec = row.operationCodec;
    const operations: RetainedSchemaValue = grant.operations;
    void originalDefinition;
    void originalCodec;
    void operations;
  }
  return owner.projectRegisteredGrant(grant);
}
/** The original owner supplies a row/resource pair with authenticated schema correspondence. */
export function registeredRowCorrespondence(
  row: SelectedRecipeOperationRowV1,
  resource: ResourceIdentity,
) {
  const binding = row.operationRegistration.binding;
  const profileBinding = row.profileRegistration.binding;
  const canonicalResource: string = row.canonicalResource(resource);
  return { binding, profileBinding, definition: row.definition, canonicalResource };
}
