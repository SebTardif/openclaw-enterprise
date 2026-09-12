export { DRIVER_CAPABILITIES, isDriverCapability } from "./drivers/base.ts";
export type { DriverCapability, Driver, JSONSchema, DriverImplementation } from "./drivers/base.ts";
export type {
  ComputeRevisionContext,
  WorkloadLaunchContext,
  ComputeLifecycleHooks,
  NamespaceLifecycleFailure,
  NamespaceEnsureResult,
  NamespaceDeleteResult,
  ComputeReadiness,
  ComputeAgentBinding,
  ComputeDriver,
  AgentRuntimeCredentialsInput,
  AgentRuntimeCredentialStatus,
} from "./drivers/compute.ts";
export type { ConfigurationDriver } from "./drivers/configuration.ts";
export type { IAMDriver } from "./drivers/iam.ts";
export type {
  ProviderType,
  ProviderRef,
  ProviderConfiguration,
  ProviderDefinition,
  ProviderSummary,
  Provider,
} from "./drivers/provider.ts";
export { SANDBOX_FACETS, isSandboxFacet } from "./drivers/sandbox.ts";
export type {
  SandboxFacet,
  KubernetesNamespacedResource,
  SandboxWorkspaceMount,
  SandboxEnvironmentVariable,
  HarnessWorkloadRequirements,
  SandboxResourceRef,
  SandboxNamespaceContext,
  SandboxHarnessContext,
  SandboxDriver,
} from "./drivers/sandbox.ts";
export type { SecretDriver } from "./drivers/secret.ts";
export type { ServiceAccountDriver } from "./drivers/service-account.ts";
export type { AuditEventKind, AuditOutcome, AuditEvent } from "./identity/audit.ts";
export type {
  PermissionAction,
  Permission,
  Role,
  AccessBindingSubjectKind,
  AccessBinding,
  Restriction,
  AuthorizationRequest,
  AuthorizationDecision,
  AuthorizationEvidence,
} from "./identity/authorization.ts";
export type {
  IdentityKind,
  Principal,
  ServicePrincipal,
  Identity,
  Group,
  GroupMembership,
  IdentityLookup,
} from "./identity/identity.ts";
export { HARNESS_EXECUTION_MODES, freezeAgentRevision } from "./resources/agent.ts";
export type {
  HarnessExecutionMode,
  Agent,
  HarnessDescriptor,
  RevisionHarnessDescriptor,
  AgentRevision,
} from "./resources/agent.ts";
export { CONFIGURATION_KINDS } from "./resources/configuration.ts";
export type {
  ConfigurationKind,
  OpenClawConfigurationValue,
  OpenClawConfigurationDocument,
  Configuration,
  ConfigurationReference,
} from "./resources/configuration.ts";
export type { Installation } from "./resources/installation.ts";
export type { NamespaceStatus, Namespace } from "./resources/namespace.ts";
export { RESOURCE_KINDS, isResourceKind } from "./resources/scope.ts";
export type { ResourceKind, Scope, ResourceRef } from "./resources/scope.ts";
export { SecretReference, SecretBinding, SecretBindings } from "./resources/secret.ts";
export type {
  SecretIdentity,
  SecretBackendRef,
  Secret,
  SecretMetadata,
  SecretEnvironmentProjection,
} from "./resources/secret.ts";
export type {
  ServiceAccountCredential,
  ServiceAccount,
  ServiceAccountRevision,
} from "./resources/service-account.ts";
export { normalizePluginDesiredState, validPluginRevisionState } from "./resources/plugin.ts";
export type {
  PluginApprovalMode,
  PluginApprovalsReviewer,
  PluginDriverIdentity,
  PluginToolPolicy,
  PluginDesiredSelection,
  PluginDesiredState,
  PluginToolCatalogEntry,
  PluginCatalogEntry,
  PluginRevisionState,
  PluginValidationFailure,
} from "./resources/plugin.ts";
export type { PluginDriverContext, PluginDriver } from "./drivers/plugin.ts";

export {
  LOGGING_LEVELS,
  admitLoggingConfiguration,
  admittedLoggingLevel,
  normalizeLoggingLevel,
  type LoggingLevel,
} from "./logging.ts";

export { normalizeSecretBindings } from "./secret-bindings.ts";

export * from "./api/common.ts";
export * from "./api/resources.ts";
export * from "./api/routes.ts";
