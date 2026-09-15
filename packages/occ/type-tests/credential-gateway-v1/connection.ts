import type {
  Scope,
  ResourceRef,
  SecretReference,
  SecretBackendRef,
} from "@openclaw-enterprise/contracts";
import type {
  DefinitionRef,
  SchemaRef,
  RetainedSchemaValue,
  AuthenticatedAccess,
  CredentialConnection,
  ResourceIdentity,
  CanonicalCredentialTargetIdentity,
  CredentialTarget,
  CredentialProfileRef,
  CredentialAccessGrant,
  ServiceBindingView,
  OperationCapability,
  BackendCapabilities,
  AuthenticationMode,
  AcquisitionMode,
  MechanismContractRef,
  CredentialObservation,
} from "@openclaw-enterprise/occ";

// Inert public-package consumers: illustrative identities/digests are not admitted
// implementations, endpoint trust, canonical encoding or provider observations.
const definition: DefinitionRef = {
  backendId: "example-repository-backend",
  packageName: "example-credential-package",
  packageVersion: "1.0.0",
  packageIntegrity: "illustrative-package-integrity",
  contractVersion: "credential-backend-v1",
};
const configurationSchema: SchemaRef = {
  namespace: "example",
  name: "configuration",
  version: 1,
  digest: "illustrative-configuration-schema-digest",
};
const resourceSchema: SchemaRef = {
  ...configurationSchema,
  name: "repository",
  digest: "illustrative-resource-schema-digest",
};
const operationSchema: SchemaRef = {
  ...configurationSchema,
  name: "fetch",
  digest: "illustrative-operation-schema-digest",
};
const profileSchema: SchemaRef = {
  ...configurationSchema,
  name: "read-write-profile",
  digest: "illustrative-profile-schema-digest",
};
const configuration: RetainedSchemaValue = {
  definition,
  role: "configuration",
  schema: configurationSchema,
  canonicalJson: '{"region":"example-region"}',
  digest: "illustrative-configuration-digest",
};
const profile: CredentialProfileRef = {
  schema: profileSchema,
  selection: {
    definition,
    role: "credential-profile",
    schema: profileSchema,
    canonicalJson: '{"access":"write"}',
    digest: "illustrative-profile-value-digest",
  },
  selectionDigest: "illustrative-profile-selection-digest",
};
const service: ServiceBindingView = {
  serviceId: "example-git-service",
  destinationPolicyId: "example-git-destination-policy",
  audience: "example-git-audience",
  authenticationCapability: "example-repository-bearer",
  authenticationMode: "protected-material",
  resourceMappingId: "example-git-repository-mapping",
  resourceMappingGeneration: "mapping-generation-1",
};
const firstConnection: CredentialConnection = {
  connectionId: "connection-primary",
  namespaceId: "namespace-example",
  generation: "configuration-generation-1",
  definition,
  upstreamInstanceId: "upstream-instance-east",
  endpointPolicyId: "example-endpoint-policy",
  services: [service],
  configuration,
};
// Connections share one installed definition and independently version config.
const aliasConnection: CredentialConnection = {
  ...firstConnection,
  connectionId: "connection-alias",
  generation: "configuration-generation-7",
  configuration: {
    ...configuration,
    schema: { ...configurationSchema, version: 2, digest: "configuration-schema-v2" },
    canonicalJson: '{"region":"example-region","label":"alias"}',
    digest: "illustrative-alias-configuration-digest",
  },
};
const resource: ResourceIdentity = {
  upstreamInstanceId: firstConnection.upstreamInstanceId,
  resourceSchema,
  canonicalResourceId: "Team/SubGroup/Repo:Opaque-ABC",
};
const holdIdentity: CanonicalCredentialTargetIdentity = {
  upstreamInstanceId: resource.upstreamInstanceId,
  resourceNamespace: "example-repositories",
  resourceKind: "repository",
  canonicalResourceId: resource.canonicalResourceId,
  credentialAuthorityId: "example-installation-authority",
};
const primaryTarget: CredentialTarget = { resource, holdIdentity };
// Only runtime admission can establish this alias/schema-upgrade equivalence.
// Its original stable hold identity survives versioned resource/config changes.
const aliasTarget: CredentialTarget = {
  resource: {
    ...resource,
    resourceSchema: { ...resourceSchema, version: 2, digest: "resource-schema-v2" },
  },
  holdIdentity,
};
const otherInstanceTarget: CredentialTarget = {
  resource: { ...resource, upstreamInstanceId: "upstream-instance-west" },
  holdIdentity: { ...holdIdentity, upstreamInstanceId: "upstream-instance-west" },
};
const caseDistinctTarget: CredentialTarget = {
  resource: { ...resource, canonicalResourceId: "Team/SubGroup/repo:Opaque-ABC" },
  holdIdentity: { ...holdIdentity, canonicalResourceId: "Team/SubGroup/repo:Opaque-ABC" },
};
const otherKindIdentity: CanonicalCredentialTargetIdentity = {
  ...holdIdentity,
  resourceKind: "artifact",
};
const mechanism: MechanismContractRef<"token-issuer-v1"> = {
  name: "token-issuer-v1",
  version: 1,
  digest: "illustrative-mechanism-digest",
};
const issuedFetch: OperationCapability = {
  serviceId: service.serviceId,
  operationSchema,
  profileSchema,
  authenticationCapability: service.authenticationCapability,
  authenticationMode: "protected-material",
  mechanism,
  acquisitionMode: "issued",
  invalidation: "per-credential",
};
// Future fictional descriptors exercise the data shape, not bridge availability.
const standingFetch: OperationCapability = {
  ...issuedFetch,
  serviceId: "example-standing-service",
  authenticationCapability: "example-standing-bearer",
  mechanism: { name: "example-standing-bridge", version: 1, digest: "standing-bridge-digest" },
  acquisitionMode: "standing",
  invalidation: "source-managed",
};
const workloadFetch: OperationCapability = {
  ...issuedFetch,
  serviceId: "example-workload-service",
  authenticationCapability: "example-workload-identity",
  authenticationMode: "workload-transport",
  mechanism: { name: "example-workload-bridge", version: 1, digest: "workload-bridge-digest" },
  acquisitionMode: "workload",
  invalidation: "source-managed",
};
const authenticationModes = [
  "protected-material",
  "workload-transport",
] as const satisfies readonly AuthenticationMode[];
const acquisitionModes = [
  "issued",
  "standing",
  "exchange",
  "refresh",
  "workload",
] as const satisfies readonly AcquisitionMode[];
const capabilities: BackendCapabilities = {
  operationCapabilities: [issuedFetch, standingFetch, workloadFetch],
  resourceSchemas: [resourceSchema],
  operationSchemas: [operationSchema],
  credentialProfiles: [profileSchema],
  authenticationModes,
  mechanisms: [mechanism, standingFetch.mechanism, workloadFetch.mechanism],
  derivedRequests: "unsupported",
  acquisitionModes,
  listResources: false,
  invalidation: "per-credential",
  reconciliation: "provider-evidence",
};
const grant: CredentialAccessGrant = {
  grantId: "grant-example",
  connectionId: firstConnection.connectionId,
  connectionGeneration: firstConnection.generation,
  resource,
  services: [service],
  operations: {
    definition,
    role: "operation",
    schema: operationSchema,
    canonicalJson: '{"operation":"fetch"}',
    digest: "illustrative-operation-digest",
  },
  credentialProfile: profile,
  authorityBindingId: "example-work-revision-execution-binding",
  expiresAt: 1_800_000_000_000,
};
// Existing platform metadata stays separate from the payload and opaque access.
// No backend descriptor extends the platform's closed IAM resource-kind union.
const scope: Scope = { namespaceId: firstConnection.namespaceId };
const resourceEnvelope: ResourceRef = {
  ...scope,
  kind: "repository_binding",
  id: "existing-repository-binding",
};
const protectedSource: SecretReference = {
  kind: "secret",
  id: "example-source-reference",
  namespaceId: firstConnection.namespaceId,
};
const protectedBackend: SecretBackendRef = {
  namespaceName: "example-namespace",
  name: "example-protected-source",
  key: "example-key",
  uid: "example-source-uid",
};
const issuedObservation: CredentialObservation = {
  mode: "issued",
  actualScope: profile.selection,
  upstreamExpiry: { kind: "known", expiresAt: grant.expiresAt + 60_000 },
  invalidation: "per-credential",
  upstreamState: "live",
};
const standingObservation: CredentialObservation = {
  ...issuedObservation,
  mode: "standing",
  upstreamExpiry: { kind: "not-established" },
  invalidation: "source-managed",
  upstreamState: "unknown",
};
const revokedObservation: CredentialObservation = {
  ...issuedObservation,
  upstreamState: "revoked",
};
const expiredObservation: CredentialObservation = {
  ...issuedObservation,
  upstreamState: "expired",
};
const unknownIssuedObservation: CredentialObservation = {
  ...issuedObservation,
  upstreamState: "unknown",
};

function consume(access: AuthenticatedAccess, observation: CredentialObservation): void {
  const authenticated: AuthenticatedAccess = access;
  // Provider state is independent of expiry knowledge and the OCE grant deadline.
  const upstreamState: "live" | "revoked" | "expired" | "unknown" = observation.upstreamState;
  if (observation.upstreamExpiry.kind === "known") {
    const providerExpiry: number = observation.upstreamExpiry.expiresAt;
    void providerExpiry;
  } else {
    // @ts-expect-error Unknown expiry provides no finite provider deadline.
    observation.upstreamExpiry.expiresAt;
  }
  // @ts-expect-error Connection possession does not authenticate access.
  const connectionAccess: AuthenticatedAccess = firstConnection;
  // @ts-expect-error Resource discovery does not authenticate access.
  const resourceAccess: AuthenticatedAccess = resource;
  // @ts-expect-error A listing result does not authenticate access.
  const listingAccess: AuthenticatedAccess = { resources: [resource] };
  // @ts-expect-error Profile/schema data does not authenticate access.
  const profileAccess: AuthenticatedAccess = profile.selection;
  // @ts-expect-error A grant payload needs its genuine authority owner.
  const grantAccess: AuthenticatedAccess = grant;
  // @ts-expect-error Capability descriptors do not authenticate access.
  const descriptorAccess: AuthenticatedAccess = capabilities;
  // @ts-expect-error Observations do not authenticate access.
  const observationAccess: AuthenticatedAccess = observation;
  void [
    authenticated,
    upstreamState,
    connectionAccess,
    resourceAccess,
    listingAccess,
    profileAccess,
    grantAccess,
    descriptorAccess,
    observationAccess,
  ];
}
void consume;

// @ts-expect-error Every stable hold identity includes its credential authority.
const missingAuthority: CanonicalCredentialTargetIdentity = {
  upstreamInstanceId: "east",
  resourceNamespace: "repositories",
  resourceKind: "repository",
  canonicalResourceId: "nested/Opaque",
};
// @ts-expect-error Stable resource namespace is required independently of schema.
const missingNamespace: CanonicalCredentialTargetIdentity = {
  upstreamInstanceId: "east",
  resourceKind: "repository",
  canonicalResourceId: "nested/Opaque",
  credentialAuthorityId: "authority",
};
// @ts-expect-error Stable resource kind is required independently of schema.
const missingKind: CanonicalCredentialTargetIdentity = {
  upstreamInstanceId: "east",
  resourceNamespace: "repositories",
  canonicalResourceId: "nested/Opaque",
  credentialAuthorityId: "authority",
};
// @ts-expect-error An upstream instance is required in the canonical key.
const missingInstance: CanonicalCredentialTargetIdentity = {
  resourceNamespace: "repositories",
  resourceKind: "repository",
  canonicalResourceId: "nested/Opaque",
  credentialAuthorityId: "authority",
};
// @ts-expect-error The opaque canonical resource ID is required.
const missingResourceId: CanonicalCredentialTargetIdentity = {
  upstreamInstanceId: "east",
  resourceNamespace: "repositories",
  resourceKind: "repository",
  credentialAuthorityId: "authority",
};
const versionedHold: CanonicalCredentialTargetIdentity = {
  ...holdIdentity,
  // @ts-expect-error Resource schema versions are excluded from the stable key.
  resourceSchema,
};
const generatedHold: CanonicalCredentialTargetIdentity = {
  ...holdIdentity,
  // @ts-expect-error Connection generations are excluded from the stable key.
  connectionGeneration: aliasConnection.generation,
};
// @ts-expect-error Connection generation is required.
const missingGeneration: CredentialConnection = {
  connectionId: "connection",
  namespaceId: "namespace",
  definition,
  upstreamInstanceId: "east",
  endpointPolicyId: "policy",
  services: [service],
  configuration,
};
// @ts-expect-error A resource requires its separate versioned schema.
const missingResourceSchema: ResourceIdentity = {
  upstreamInstanceId: "east",
  canonicalResourceId: "nested/Opaque",
};
// @ts-expect-error Mechanism version is required.
const missingMechanismVersion: MechanismContractRef = { name: "example-bridge", digest: "digest" };
// @ts-expect-error Mechanism digest is required.
const missingMechanismDigest: MechanismContractRef = { name: "example-bridge", version: 1 };
const wrongMechanismName: MechanismContractRef<"token-issuer-v1"> = {
  ...mechanism,
  // @ts-expect-error Generic contract names preserve the exact selected bridge.
  name: "example-standing-bridge",
};
// @ts-expect-error Authentication modes form a closed set.
const invalidAuthentication: AuthenticationMode = "plaintext";
// @ts-expect-error Acquisition modes form a closed set.
const invalidAcquisition: AcquisitionMode = "borrow";
const invalidInvalidation: OperationCapability = {
  ...issuedFetch,
  // @ts-expect-error Invalidation is explicit; unsupported revoke is not success.
  invalidation: "successful-cleanup",
};
// @ts-expect-error Workload identity is observed by its transport owner, not material observations.
const invalidObservationMode: CredentialObservation = { ...issuedObservation, mode: "workload" };
// @ts-expect-error Provider state does not include OCE authority closure.
const closedObservation: CredentialObservation = { ...issuedObservation, upstreamState: "closed" };
const missingExpiry: CredentialObservation = {
  ...issuedObservation,
  // @ts-expect-error Known expiry requires a deadline.
  upstreamExpiry: { kind: "known" },
};
const inventedExpiry: CredentialObservation = {
  ...issuedObservation,
  // @ts-expect-error Expiry observations have a closed discriminator.
  upstreamExpiry: { kind: "infinite" },
};
// @ts-expect-error Grant generation is required.
const missingGrantGeneration: CredentialAccessGrant = {
  grantId: "grant",
  connectionId: "connection",
  resource,
  services: [service],
  operations: grant.operations,
  credentialProfile: profile,
  authorityBindingId: "binding",
  expiresAt: grant.expiresAt,
};
// @ts-expect-error Service resource mapping generation is required.
const missingMappingGeneration: ServiceBindingView = {
  serviceId: "service",
  destinationPolicyId: "policy",
  audience: "audience",
  authenticationCapability: "bearer",
  authenticationMode: "protected-material",
  resourceMappingId: "mapping",
};
// @ts-expect-error Profile selections require their digest.
const missingSelectionDigest: CredentialProfileRef = {
  schema: profileSchema,
  selection: profile.selection,
};
// @ts-expect-error Capabilities are explicit complete tuples.
const missingTupleService: OperationCapability = {
  operationSchema,
  profileSchema,
  authenticationCapability: "bearer",
  authenticationMode: "protected-material",
  mechanism,
  acquisitionMode: "issued",
  invalidation: "per-credential",
};
// @ts-expect-error Connection generations cannot be reassigned by consumers.
firstConnection.generation = aliasConnection.generation;
// @ts-expect-error Service lists are readonly.
firstConnection.services.push(service);
// @ts-expect-error Canonical hold IDs cannot be reassigned.
holdIdentity.canonicalResourceId = caseDistinctTarget.resource.canonicalResourceId;
// @ts-expect-error Versioned resource schema identity is readonly.
resource.resourceSchema = configurationSchema;
// @ts-expect-error Grant profile selection cannot be reassigned.
grant.credentialProfile = profile;
// @ts-expect-error Explicit capability tuples cannot be appended by consumers.
capabilities.operationCapabilities.push(standingFetch);
// @ts-expect-error Observation expiry is readonly.
issuedObservation.upstreamExpiry = standingObservation.upstreamExpiry;
if (issuedObservation.upstreamExpiry.kind === "known") {
  // @ts-expect-error Known expiry deadlines are also readonly.
  issuedObservation.upstreamExpiry.expiresAt = grant.expiresAt;
}

void [
  primaryTarget,
  aliasTarget,
  otherInstanceTarget,
  caseDistinctTarget,
  otherKindIdentity,
  resourceEnvelope,
  protectedSource,
  protectedBackend,
  revokedObservation,
  expiredObservation,
  unknownIssuedObservation,
  missingAuthority,
  missingNamespace,
  missingKind,
  missingInstance,
  missingResourceId,
  versionedHold,
  generatedHold,
  missingGeneration,
  missingResourceSchema,
  missingMechanismVersion,
  missingMechanismDigest,
  wrongMechanismName,
  invalidAuthentication,
  invalidAcquisition,
  invalidInvalidation,
  invalidObservationMode,
  closedObservation,
  missingExpiry,
  inventedExpiry,
  missingGrantGeneration,
  missingMappingGeneration,
  missingSelectionDigest,
  missingTupleService,
];
