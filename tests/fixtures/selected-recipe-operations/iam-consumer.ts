import { createNativeRootIamAdmissionV1, type PlatformUnitOfWork } from "@openclaw-enterprise/occ";
import {
  registerSelectedRecipeOperationRowsV1,
  type CredentialSchemaRegistryV1,
  type SelectedRecipeDefinitionsV1,
  type SelectedRecipeOperationRowsV1,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";

type Dependencies = Parameters<typeof createNativeRootIamAdmissionV1>[0];
type OriginalIamOwner = ReturnType<typeof createNativeRootIamAdmissionV1>;
type OriginalBinding = Parameters<OriginalIamOwner["prepare"]>[0];

/** Every actual IAM constructor operand participates; no fixture creates authority. */
export function actualIamConstructorConsumer(
  dependencies: Dependencies,
  schemas: CredentialSchemaRegistryV1,
  definitions: SelectedRecipeDefinitionsV1<"github" | "exampleArchive">,
): {
  readonly iam: OriginalIamOwner;
  readonly rows: SelectedRecipeOperationRowsV1<"github" | "exampleArchive">;
} {
  const rows = registerSelectedRecipeOperationRowsV1(schemas, definitions);
  const iam = createNativeRootIamAdmissionV1({
    selectedNativeDriver: dependencies.selectedNativeDriver,
    selection: dependencies.selection,
    core: dependencies.core,
    state: dependencies.state,
    effects: dependencies.effects,
    grantOperations: dependencies.grantOperations,
    now: dependencies.now,
    maximumPrepareMs: dependencies.maximumPrepareMs,
    maximumEvidenceLifetimeMs: dependencies.maximumEvidenceLifetimeMs,
    maximumActiveEvidence: dependencies.maximumActiveEvidence,
    adoptedEnvelope: dependencies.adoptedEnvelope,
  });
  return { iam, rows };
}
export async function originalIamEvidenceConsumer(
  iam: OriginalIamOwner,
  binding: OriginalBinding,
  originalUow: PlatformUnitOfWork,
  prepareDeadlineAt: number,
): Promise<void> {
  const evidence = await iam.prepare(binding, prepareDeadlineAt);
  await iam.consumeIn(originalUow, evidence, binding);
}
