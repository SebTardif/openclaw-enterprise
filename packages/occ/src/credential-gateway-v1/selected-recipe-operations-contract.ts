/** Trusted-app DATA and declarations. This boundary supplies no dispatch authority. */
import type { ResourceIdentity } from "./connection.ts";
import type { RecipeOperation } from "./recipe-operation.ts";
import type { DefinitionRef, RegisteredSchemaCodec, SchemaRegistration } from "./schema.ts";
import type { CredentialSchemaRegistryV1 } from "../credential-broker-v1/schema-registry.ts";

export type {
  DefinitionRef,
  SchemaRef,
  SchemaRegistration,
  RegisteredSchemaCodec,
  RetainedSchemaValue,
} from "./schema.ts";
export type { ResourceIdentity } from "./connection.ts";
export type {
  RecipeOperation,
  OperationCaptureOwner,
  OperationOutcome,
  ResourceOperationAdapter,
} from "./recipe-operation.ts";
export type { CredentialSchemaRegistryV1 } from "../credential-broker-v1/schema-registry.ts";
export {
  githubOperationRegistrationsV1,
  githubResourcePolicyEncodingV1,
} from "./selected-github-operation-rows.ts";
/** Trusted startup chooses a finite set of names for independently admitted definitions. */
export type SelectedRecipeDefinitionsV1<Backend extends string> = Readonly<
  Record<Backend, DefinitionRef>
>;
export interface SelectedRecipeOperationRowV1 {
  readonly definition: DefinitionRef;
  readonly operation: RecipeOperation;
  readonly operationRegistration: SchemaRegistration;
  readonly profileRegistration: SchemaRegistration;
  readonly operationCodec: RegisteredSchemaCodec;
  readonly profileCodec: RegisteredSchemaCodec;
  readonly serviceId: string;
  readonly exactAction: string;
  /**
   * The original owner authenticates resourceSchema correspondence, then encodes
   * [prefix, upstreamInstanceId, resourceNamespace, resourceKind, canonicalResourceId]
   * using this backend's exported resource-policy DATA and JSON array encoding.
   * The projector must enforce 4096 UTF-8 bytes and UTF-16 code units for every
   * backend. Whole IAM facts retain their independent aggregate cap.
   * Opaque IDs remain case-sensitive and are neither parsed nor display names.
   * TODO: supply the callable projection with the original service-authority runtime.
   */
  canonicalResource(resource: ResourceIdentity): string;
}
/** Unregistered DATA carries no codec custody or callable resource projection. */
export type SelectedRecipeOperationRegistrationV1 = Omit<
  SelectedRecipeOperationRowV1,
  "operationCodec" | "profileCodec" | "canonicalResource"
>;
export type SelectedRecipeOperationRowsV1<Backend extends string> = Readonly<
  Record<Backend, readonly SelectedRecipeOperationRowV1[]>
>;
/**
 * Trusted startup supplies separately admitted exact original definitions matching
 * separately installed trusted owner catalogs. A selected name or definition alone
 * does not install a provider. Missing catalogs must refuse. The original owner
 * begins one scope per definition,
 * registers each distinct operation/profile binding once, commits each scope and
 * authenticates both codecs against the exact row bindings with assertCodec.
 * Pending/discarded, foreign-registry and same-kind mismatches must refuse.
 * No caller codec, action callback or resource projector is a constructor operand.
 * TODO: implement this original-owner factory in the service-authority runtime.
 * This declaration intentionally emits no callable runtime factory.
 */
export declare function registerSelectedRecipeOperationRowsV1<const Backend extends string>(
  schemas: CredentialSchemaRegistryV1,
  definitions: SelectedRecipeDefinitionsV1<Backend>,
): SelectedRecipeOperationRowsV1<Backend>;
