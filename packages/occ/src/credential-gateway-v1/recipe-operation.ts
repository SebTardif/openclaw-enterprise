import type { OperationCapability, MechanismContractRef, ResourceIdentity } from "./connection.ts";
import type { IssuedMechanismFactory } from "./issuance.ts";
import type {
  Bounds,
  LocalHandle,
  AuthenticatedAccess,
  AdmittedCredentialSelection,
  ValidatedSchemaValue,
  AdmittedServiceBinding,
  AdmittedReceiver,
  ValidatedAdapterOperation,
  CoreAuthenticationBinding,
  AdmittedConnection,
  RegisteredCredentialMechanism,
} from "./handles.ts";
import type {
  DefinitionRef,
  PrimitiveRef,
  JsonValue,
  SchemaRef,
  RegisteredSchemaCodec,
  RetainedSchemaValue,
} from "./schema.ts";
import type { CredentialSchemaRegistryV1 } from "../credential-broker-v1/schema-registry.ts";

export interface RecipePrimitiveSelection {
  readonly primitive: PrimitiveRef;
  readonly parameters: JsonValue;
}
export interface RecipeOperation {
  readonly operationId: string;
  readonly capability: OperationCapability;
  readonly inputSchema: SchemaRef;
  readonly outputSchema: SchemaRef;
  readonly execution: RecipePrimitiveSelection;
  readonly maxRequests: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly deadlineMs: number;
}
export interface InspectionSlot extends LocalHandle<"inspection-slot"> {
  readonly expiresAt: number;
}
/** Original broker ownership operands; these facts alone confer no authority. */
export interface OperationCapture {
  readonly definition: DefinitionRef;
  readonly primitive: PrimitiveRef;
  readonly executor: PrimitiveRef;
  readonly access: AuthenticatedAccess;
  readonly slot: InspectionSlot;
  readonly selection: AdmittedCredentialSelection;
  readonly operationFacts: ValidatedSchemaValue;
  readonly service: AdmittedServiceBinding;
  readonly receiver: AdmittedReceiver;
}
/** Implemented by the original capture owner, including authentication and immutable byte ownership. */
export interface OperationCaptureOwner {
  capture(
    input: OperationCapture,
    prefix: Uint8Array,
    remainder: AsyncIterable<Uint8Array> | undefined,
  ): ValidatedAdapterOperation;
  inspect(operation: ValidatedAdapterOperation): OperationCapture;
  openBodyOnce(operation: ValidatedAdapterOperation): AsyncIterable<Uint8Array>;
}
export interface SubmissionGate extends LocalHandle<"submission-gate"> {
  assertAndConsume(): void;
}
export interface OperationOutcome {
  readonly effect: "not-submitted" | "observed" | "unknown";
  readonly evidenceSchema: SchemaRef;
  readonly evidence: RetainedSchemaValue;
}
export type BrokerResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | {
      readonly kind: "error";
      readonly code: "denied" | "closed" | "unavailable" | "indeterminate";
      readonly receiptId?: string;
    };
export interface ResourceOperationAdapter {
  readonly definition: DefinitionRef;
  readonly operationSchemas: readonly SchemaRef[];
  validateAndOwn(input: unknown, bounds: Bounds): Promise<ValidatedAdapterOperation>;
  execute(
    operation: ValidatedAdapterOperation,
    authentication: CoreAuthenticationBinding,
    submission: SubmissionGate,
    bounds: Bounds,
  ): Promise<OperationOutcome>;
}
export interface RecipeJsonReadParametersV1 {
  readonly method: "GET";
  readonly path: readonly ({ readonly constant: string } | { readonly inputField: string })[];
  readonly projection: readonly { readonly from: readonly string[]; readonly to: string }[];
}
export interface PreparedRecipeReadV1 {
  readonly method: "GET";
  readonly path: string;
  readonly requestBytes: Uint8Array;
}
export interface CompiledRecipeReadV1 {
  prepare(input: RetainedSchemaValue): PreparedRecipeReadV1;
  project(response: Uint8Array): RetainedSchemaValue;
}
export interface RecipeReadTransportV1 {
  /** Original transport authenticates private material and consumes the gate synchronously at actual submission. */
  execute(
    operation: ValidatedAdapterOperation,
    authentication: CoreAuthenticationBinding,
    submission: SubmissionGate,
    bounds: Bounds,
  ): Promise<Uint8Array>;
}
export interface RecipeReadCompilationV1 {
  readonly definition: DefinitionRef;
  readonly operation: RecipeOperation;
  readonly inputCodec: RegisteredSchemaCodec;
  readonly outputCodec: RegisteredSchemaCodec;
  readonly schemas: CredentialSchemaRegistryV1;
}
export interface RegisteredMechanismBridge extends LocalHandle<"registered-mechanism-bridge"> {
  readonly contract: MechanismContractRef;
  register(factory: IssuedMechanismFactory): RegisteredCredentialMechanism;
}
export interface MechanismRegistrationOwner {
  require(contract: MechanismContractRef<"token-issuer-v1">): RegisteredMechanismBridge;
}
export interface GatewayRecipeOperationOwnersV1 {
  readonly operations: OperationCaptureOwner;
  readonly transport: RecipeReadTransportV1;
  /** Constructor-only original authenticated selection path. Never recipe data. */
  readonly captureFor: (
    candidate: unknown,
    bounds: Bounds,
  ) => Promise<{ readonly capture: OperationCapture; readonly input: RetainedSchemaValue }>;
  readonly lifecycle?: {
    readonly owner: MechanismRegistrationOwner;
    readonly factory: IssuedMechanismFactory;
    readonly capability: OperationCapability;
  };
}
export interface RecipeResourcePrimitivesV1 {
  verifyConnection(
    connection: AdmittedConnection,
    bounds: Bounds,
  ): Promise<{ readonly upstreamInstanceId: string }>;
  resolveResource(
    connection: AdmittedConnection,
    locator: RetainedSchemaValue,
    bounds: Bounds,
  ): Promise<BrokerResult<ResourceIdentity>>;
}
export interface GatewayRecipeOperationsV1 {
  readonly operationRuntime: PrimitiveRef;
  require(input: RecipeReadCompilationV1): ResourceOperationAdapter;
  requireResource(input: {
    readonly verifyConnection: RecipePrimitiveSelection;
    readonly resolveResource: RecipePrimitiveSelection;
  }): RecipeResourcePrimitivesV1;
}
