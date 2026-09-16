import type { JSONSchema } from "@openclaw-enterprise/contracts";
import type {
  Bounds,
  ValidatedSchemaValue,
  DefinitionRef,
  PrimitiveRef,
  SchemaRef,
  RetainedSchemaValue,
  SchemaRole,
  SchemaBinding,
  SchemaRegistration,
  RegisteredSchemaCodec,
  SchemaRegistrationOwner,
} from "@openclaw-enterprise/occ";
import type { JsonValue } from "../../src/credential-gateway-v1/schema.ts";
import type {
  LocalHandle,
  AuthenticatedAccess,
  RetainedCredential,
  CoreAuthenticationBinding,
  AdmittedServiceBinding,
  AdmittedReceiver,
  ProtectedDerivedCapability,
  DerivedRequest,
  ProtectedUpstreamResponse,
  DispatchPermit,
  ReceiptFinalization,
  BoundCredentialOperation,
  ValidatedAdapterOperation,
  AdmissionCondition,
  AdmittedRootContext,
  AuthorizedClosure,
  AdmittedConnection,
  AdmittedCredentialSelection,
  ProtectedCredentialSource,
  RegisteredCredentialMechanism,
} from "../../src/credential-gateway-v1/handles.ts";
// @ts-expect-error Generic handles remain internal to their authority owners.
import type { LocalHandle as PublicLocalHandle } from "@openclaw-enterprise/occ";
// @ts-expect-error Authentication handles are not package-root contracts.
import type { AuthenticatedAccess as PublicAuthenticatedAccess } from "@openclaw-enterprise/occ";
// @ts-expect-error JSON implementation data is not part of the registry signature surface.
import type { JsonValue as PublicJsonValue } from "@openclaw-enterprise/occ";
// @ts-expect-error The owner brand is private and has no public runtime export.
import type { owner } from "@openclaw-enterprise/occ";

// Inert compile fixtures do not establish valid installed identities or digests.
const definition: DefinitionRef = {
  backendId: "example-backend",
  recipeId: "example-credential-recipe",
  recipeVersion: 1,
  recipeDigest: "illustrative-recipe-digest",
  contractVersion: "credential-backend-recipe-v1",
  interpreter: {
    name: "oce-closed-schema-interpreter",
    version: 1,
    digest: "illustrative-interpreter-digest",
  },
};
const schema: SchemaRef = {
  namespace: "example",
  name: "configuration",
  version: 1,
  digest: "illustrative-schema-digest",
};
const roles = [
  "configuration",
  "resource",
  "operation",
  "credential-profile",
  "observation",
  "evidence",
  "locator",
  "cursor",
] as const satisfies readonly SchemaRole[];
const binding: SchemaBinding = { definition, role: roles[0], schema };
const retained: RetainedSchemaValue = {
  ...binding,
  canonicalJson: '{"enabled":true}',
  digest: "illustrative-value-digest",
};
const jsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { enabled: { type: "boolean" } },
  required: ["enabled"],
} satisfies JSONSchema;
const scalarCandidates: readonly JsonValue[] = [null, true, 1, "example"];
const arrayCandidate: JsonValue = scalarCandidates;
const candidate: JsonValue = {
  enabled: true,
  nested: { values: arrayCandidate },
};
const registration: SchemaRegistration = {
  binding,
  jsonSchema,
  maxBytes: 1024,
  maxDepth: 8,
  canonicalization: {
    name: "oce-canonical-json",
    version: 1,
    digest: "illustrative-canonicalization-digest",
  },
};

// An external package consumes injected owners; no fake owner or handle is minted.
function consume(owner: SchemaRegistrationOwner, bounds: Bounds): void {
  const codec: RegisteredSchemaCodec = owner.register(registration);
  const validated: ValidatedSchemaValue = codec.validate(candidate);
  const saved: RetainedSchemaValue = codec.retain(validated);
  const restored: ValidatedSchemaValue = codec.restore(saved);
  codec.retain(restored);
  const signal: AbortSignal = bounds.signal;
  const deadline: number = bounds.deadline;
  void signal;
  void deadline;

  // @ts-expect-error Retained data does not authenticate a validated handle.
  codec.retain(retained);
  // @ts-expect-error Ordinary JSON data does not authenticate a validated handle.
  codec.retain(candidate);
  // @ts-expect-error Codec bindings are readonly.
  codec.binding = binding;
  // @ts-expect-error Bounds cannot be reassigned by consumers.
  bounds.deadline = deadline;
  // @ts-expect-error Cancellation ownership is readonly.
  bounds.signal = signal;
}
void consume;

const unsupportedContract: DefinitionRef = {
  ...definition,
  // @ts-expect-error Only the selected backend contract is admitted by this declaration.
  contractVersion: "credential-backend-v2",
};
// @ts-expect-error Schema roles form a closed set.
const unsupportedRole: SchemaRole = "secret";
// @ts-expect-error Definition identity fields are required.
const incompleteDefinition: DefinitionRef = { backendId: "example-backend" };
// @ts-expect-error Schema versions are required.
const missingVersion: SchemaRef = { namespace: "example", name: "configuration", digest: "digest" };
// @ts-expect-error Schema digests are required.
const missingDigest: SchemaRef = { namespace: "example", name: "configuration", version: 1 };
// @ts-expect-error Schema versions use numbers.
const stringVersion: SchemaRef = { ...schema, version: "1" };
// @ts-expect-error Schema digests use strings.
const numericDigest: SchemaRef = { ...schema, digest: 1 };
// @ts-expect-error Every binding includes a definition.
const missingDefinition: SchemaBinding = { role: "configuration", schema };
// @ts-expect-error Every binding includes a role.
const missingRole: SchemaBinding = { definition, schema };
// @ts-expect-error Every binding includes a schema.
const missingSchema: SchemaBinding = { definition, role: "configuration" };
// @ts-expect-error Registration uses the existing object-shaped JSONSchema contract.
const primitiveSchema: SchemaRegistration = { ...registration, jsonSchema: "object" };
const executableRegistration: SchemaRegistration = {
  ...registration,
  // @ts-expect-error Even a JSON-returning callback is not registration data.
  validateAndCanonicalize: (value: JsonValue): JsonValue => value,
};
const executableCanonicalization: SchemaRegistration = {
  ...registration,
  // @ts-expect-error Canonicalization names an installed primitive, never a callback.
  canonicalization: (value: JsonValue): JsonValue => value,
};
// @ts-expect-error Undefined is not an ordinary JSON leaf.
const undefinedCandidate: JsonValue = undefined;
// @ts-expect-error Bigints are not ordinary JSON leaves.
const bigintCandidate: JsonValue = 1n;
// @ts-expect-error Functions are not ordinary JSON leaves.
const functionCandidate: JsonValue = () => null;
// @ts-expect-error Nested unsupported leaves are rejected too.
const nestedUndefined: JsonValue = { nested: [undefined] };

// Exercise required and readonly fields without claiming runtime validity.
function readonlyFields(value: RetainedSchemaValue): void {
  // @ts-expect-error Recipe identity is readonly.
  definition.recipeVersion = 2;
  // @ts-expect-error Backend contract version is readonly.
  definition.contractVersion = "credential-backend-recipe-v1";
  // @ts-expect-error Schema versions are readonly.
  schema.version = 2;
  // @ts-expect-error Schema digests are readonly.
  schema.digest = "replacement";
  // @ts-expect-error Definition bindings are readonly.
  binding.definition = definition;
  // @ts-expect-error Role bindings are readonly.
  binding.role = "evidence";
  // @ts-expect-error Schema bindings are readonly.
  binding.schema = schema;
  // @ts-expect-error Retained encoding is readonly.
  value.canonicalJson = "{}";
  // @ts-expect-error Retained digests are readonly.
  value.digest = "replacement";
  // @ts-expect-error Registration limits are readonly.
  registration.maxBytes = 2048;
}
void readonlyFields;

// Symbol-only objects can satisfy structural JSON types; owners enforce runtime closure.
// All fixed handles resist ordinary empty-object/string assignment.
type Handles = {
  AuthenticatedAccess: AuthenticatedAccess;
  RetainedCredential: RetainedCredential;
  CoreAuthenticationBinding: CoreAuthenticationBinding;
  AdmittedServiceBinding: AdmittedServiceBinding;
  AdmittedReceiver: AdmittedReceiver;
  ProtectedDerivedCapability: ProtectedDerivedCapability;
  DerivedRequest: DerivedRequest;
  ProtectedUpstreamResponse: ProtectedUpstreamResponse;
  DispatchPermit: DispatchPermit;
  ReceiptFinalization: ReceiptFinalization;
  BoundCredentialOperation: BoundCredentialOperation;
  ValidatedAdapterOperation: ValidatedAdapterOperation;
  ValidatedSchemaValue: ValidatedSchemaValue;
  AdmissionCondition: AdmissionCondition;
  AdmittedRootContext: AdmittedRootContext;
  AuthorizedClosure: AuthorizedClosure;
  AdmittedConnection: AdmittedConnection;
  AdmittedCredentialSelection: AdmittedCredentialSelection;
  ProtectedCredentialSource: ProtectedCredentialSource;
  RegisteredCredentialMechanism: RegisteredCredentialMechanism;
};
type AssertNever<T extends never> = T;
type RequiredFields<T, Fields extends keyof T> = {
  [K in Fields]-?: {} extends Pick<T, K> ? K : never;
}[Fields];
type RequiredDefinitionFields = AssertNever<
  RequiredFields<
    DefinitionRef,
    "backendId" | "recipeId" | "recipeVersion" | "recipeDigest" | "contractVersion" | "interpreter"
  >
>;
type RequiredPrimitiveFields = AssertNever<
  RequiredFields<PrimitiveRef, "name" | "version" | "digest">
>;
type RequiredRegistrationFields = AssertNever<
  RequiredFields<
    SchemaRegistration,
    "binding" | "jsonSchema" | "maxBytes" | "maxDepth" | "canonicalization"
  >
>;
type RequiredSchemaFields = AssertNever<
  RequiredFields<SchemaRef, "namespace" | "name" | "version" | "digest">
>;
type RequiredBindingFields = AssertNever<
  RequiredFields<SchemaBinding, "definition" | "role" | "schema">
>;
type RequiredRetainedFields = AssertNever<
  RequiredFields<RetainedSchemaValue, "definition" | "role" | "schema" | "canonicalJson" | "digest">
>;

type EmptyObjectAssignments = {
  [K in keyof Handles]: {} extends Handles[K] ? K : never;
}[keyof Handles];
type StringAssignments = {
  [K in keyof Handles]: string extends Handles[K] ? K : never;
}[keyof Handles];
type CrossKindAssignments = {
  [K in keyof Handles]: {
    [J in Exclude<keyof Handles, K>]: Handles[K] extends Handles[J] ? J : never;
  }[Exclude<keyof Handles, K>];
}[keyof Handles];
type NoEmptyObjectHandles = AssertNever<EmptyObjectAssignments>;
type NoStringHandles = AssertNever<StringAssignments>;
type NoCrossKindHandles = AssertNever<CrossKindAssignments>;
type GenericHandleIsOpaque = AssertNever<{} extends LocalHandle<"example"> ? "forgeable" : never>;

function opaqueConsumers(
  access: AuthenticatedAccess,
  credential: RetainedCredential,
  validated: ValidatedSchemaValue,
): void {
  // @ts-expect-error Ordinary objects cannot supply the private owner brand.
  const fabricated: AuthenticatedAccess = {};
  // @ts-expect-error Strings do not authenticate opaque handles.
  const stringHandle: RetainedCredential = "credential";
  // @ts-expect-error Different owner handle kinds are incompatible.
  const wrongKind: AuthenticatedAccess = credential;
  // @ts-expect-error A validated-value kind cannot stand in for authenticated access.
  const wrongValueKind: AuthenticatedAccess = validated;
  // @ts-expect-error A complete port object still lacks the private codec brand.
  const fabricatedCodec: RegisteredSchemaCodec = {
    binding,
    validate: () => validated,
    retain: () => retained,
    restore: () => validated,
  };
  const nominal: LocalHandle<"authenticated-access"> = access;
  void nominal;
}
void opaqueConsumers;

// Exact recipe and primitive identities are data, never package or executable inputs.
const legacyPackageIdentity = {
  backendId: definition.backendId,
  packageName: "example-credential-package",
  packageVersion: "1.0.0",
  packageIntegrity: "illustrative-package-integrity",
  contractVersion: definition.contractVersion,
};
// @ts-expect-error Package identity cannot substitute for the exact recipe and interpreter.
const packageDefinition: DefinitionRef = legacyPackageIdentity;
// @ts-expect-error Recipe versions use numbers.
const wrongRecipeVersion: DefinitionRef = { ...definition, recipeVersion: "1" };
// @ts-expect-error Primitive versions use numbers.
const wrongPrimitive: PrimitiveRef = { name: "example", version: "1", digest: "digest" };
// @ts-expect-error Primitive digest is required.
const missingPrimitiveDigest: PrimitiveRef = { name: "example", version: 1 };
const { interpreter: omittedInterpreter, ...withoutInterpreter } = definition;
// @ts-expect-error Definition identity requires the exact installed interpreter.
const missingInterpreter: DefinitionRef = withoutInterpreter;
const { canonicalization: omittedCanonicalization, ...withoutCanonicalization } = registration;
// @ts-expect-error Registration requires the exact installed canonicalization primitive.
const missingCanonicalization: SchemaRegistration = withoutCanonicalization;
function readonlyPrimitive(): void {
  // @ts-expect-error Exact interpreter identity is readonly.
  definition.interpreter = registration.canonicalization;
  // @ts-expect-error Primitive digests are readonly.
  definition.interpreter.digest = "changed";
  // @ts-expect-error Registration canonicalization is readonly.
  registration.canonicalization = definition.interpreter;
}
void readonlyPrimitive;
