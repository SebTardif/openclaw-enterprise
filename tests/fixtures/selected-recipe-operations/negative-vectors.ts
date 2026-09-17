import { createNativeRootIamAdmissionV1 } from "@openclaw-enterprise/occ";
import {
  registerSelectedRecipeOperationRowsV1,
  type CredentialSchemaRegistryV1,
  type SelectedRecipeDefinitionsV1,
  type SelectedRecipeOperationRowsV1,
  type SelectedRecipeOperationRowV1,
  type RegisteredSchemaCodec,
  type RetainedSchemaValue,
  type ResourceIdentity,
  type OperationCaptureOwner,
  type OperationOutcome,
  type ResourceOperationAdapter,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";

export function rejectedConstructorAndDataShapes(
  registry: CredentialSchemaRegistryV1,
  definitions: SelectedRecipeDefinitionsV1<"github" | "exampleArchive">,
  row: SelectedRecipeOperationRowV1,
  rows: SelectedRecipeOperationRowsV1<"github" | "exampleArchive">,
  codec: RegisteredSchemaCodec,
  retained: RetainedSchemaValue,
  resource: ResourceIdentity,
  captureOwner: OperationCaptureOwner,
  adapter: ResourceOperationAdapter,
): void {
  // @ts-expect-error The original admitted definitions operand is required.
  registerSelectedRecipeOperationRowsV1(registry);
  // @ts-expect-error Both explicitly selected admitted definitions are required.
  registerSelectedRecipeOperationRowsV1<"github" | "exampleArchive">(registry, {
    github: definitions.github,
  });
  // @ts-expect-error A codec is not the original schema registry.
  registerSelectedRecipeOperationRowsV1(codec, definitions);
  // @ts-expect-error Caller policy callbacks are not constructor operands.
  registerSelectedRecipeOperationRowsV1(registry, definitions, () => "allow");
  // @ts-expect-error The result preserves exactly the selected backend keys.
  rows.gitlab;
  const inferred = registerSelectedRecipeOperationRowsV1(registry, definitions);
  const selectedExternal: readonly SelectedRecipeOperationRowV1[] = inferred.exampleArchive;
  // @ts-expect-error The inferred result cannot add an unselected backend.
  inferred.unselectedBackend;
  const githubOnly = registerSelectedRecipeOperationRowsV1(registry, {
    github: definitions.github,
  });
  // @ts-expect-error An external backend is absent from a GitHub-only selection.
  githubOnly.exampleArchive;
  void selectedExternal;
  // @ts-expect-error Caller code cannot change an admitted definition slot.
  definitions.exampleArchive = definitions.github;
  // @ts-expect-error Published groups are readonly.
  rows.github.push(row);
  // @ts-expect-error Resource projection requires original upstream/schema/opaque ID DATA.
  row.canonicalResource({ displayName: "owner/repository" });
  // @ts-expect-error Codec binding facts cannot fabricate original LocalHandle custody.
  const copiedCodec: RegisteredSchemaCodec = {
    ...codec.binding,
    binding: codec.binding,
    validate: codec.validate,
    retain: codec.retain,
    restore: codec.restore,
  };
  // @ts-expect-error Retained nonsecret DATA is not a registered codec.
  const dataCodec: RegisteredSchemaCodec = retained;
  // @ts-expect-error A registered codec is not a validated value handle.
  codec.retain(codec);
  // @ts-expect-error Resource adapters have their own original interface and custody operands.
  const codecAdapter: ResourceOperationAdapter = codec;
  const outcome: OperationOutcome = {
    effect: "observed",
    evidenceSchema: resource.resourceSchema,
    // @ts-expect-error Outcome evidence requires retained schema DATA.
    evidence: codec,
  };
  // @ts-expect-error Capture inspection requires original validated-adapter-operation custody.
  captureOwner.inspect(codec.validate({}));
  // @ts-expect-error Resource execution requires original operation/authentication/gate/bounds operands.
  adapter.execute(codec.validate({}));
  // Same-kind codecs remain assignable by design; registry.assertCodec must reject
  // foreign operation/profile/backend bindings at runtime. The conformance suite
  // exercises that accepted custody guard against the production DATA rows.
  const sameKind: RegisteredSchemaCodec = row.profileCodec;
  void copiedCodec;
  void dataCodec;
  void codecAdapter;
  void outcome;
  void sameKind;
}
export function rejectedIamDependencies(
  dependencies: Parameters<typeof createNativeRootIamAdmissionV1>[0],
): void {
  const { grantOperations: _grant, ...missingOriginalProjection } = dependencies;
  // @ts-expect-error Actual IAM construction requires the original synchronous projection owner.
  createNativeRootIamAdmissionV1(missingOriginalProjection);
  const { core: _core, ...missingOriginalCore } = dependencies;
  // @ts-expect-error Actual IAM construction requires authentic original Work recognition.
  createNativeRootIamAdmissionV1(missingOriginalCore);
}
