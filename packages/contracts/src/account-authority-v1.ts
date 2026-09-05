import { Type } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { AuthorizationRequest, PermissionAction } from "./identity/authorization.ts";
import type { Identity } from "./identity/identity.ts";
import type { ResourceRef } from "./resources/scope.ts";
import {
  AgentId,
  ConfigurationId,
  ConfigurationGeneration,
  InstallationId,
  NamespaceId,
  ProviderId,
  RequestId,
  RevisionId,
  SecretId,
  ServiceAccountId,
  Timestamp,
} from "./api/common.ts";

/**
 * Account/selected-IAM observations, not authentication or an effect permit.
 * Implementations must use the currently selected provider on every invocation;
 * no native-driver fallback, positive cache, serialized proof or account store is
 * supplied here. Final effects still require authoritative compare-and-consume at
 * the actual acceptor, current scope/audience/runtime and durable audit acceptance.
 */
export const ACCOUNT_CURRENTNESS_PROFILE_V1 = "account-currentness-v1" as const;
export const ACCOUNT_AUTHORITY_LIMITS_V1 = Object.freeze({
  maxRequestBytes: 16 * 1024,
  maxObservationBytes: 32 * 1024,
  maxDependencyCallMs: 5000,
  maxOperationStartMs: 5000,
  modelRecheckMs: 5000,
  modelCloseMs: 5000,
  maxReferences: 64,
});

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

const Ref = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const Version = ConfigurationGeneration;
const Profile = Type.Literal(ACCOUNT_CURRENTNESS_PROFILE_V1);
const Closed = { additionalProperties: false } as const;
const AgentTarget = Type.Object({ namespaceId: NamespaceId, agentId: AgentId }, Closed);
const NamespaceTarget = Type.Object({ namespaceId: NamespaceId }, Closed);
const ConversationTarget = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    conversationRef: Ref,
    commonGrantRef: Ref,
  },
  Closed,
);
const DeploymentFields = {
  namespaceId: NamespaceId,
  agentId: AgentId,
  configurationId: ConfigurationId,
  serviceAccountId: Type.Optional(ServiceAccountId),
  secretIds: Type.Array(SecretId, { maxItems: 64, uniqueItems: true }),
};

/** Server-resolved targets. Client locators must never be passed through unverified. */
export const AccountOperationSchemaV1 = Type.Union([
  Type.Object(
    {
      kind: Type.Enum(["installation.read", "installation.administer", "namespace.create"]),
      target: Type.Object({}, Closed),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["namespace.read", "namespace.delete", "namespace.administer"]),
      target: NamespaceTarget,
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum([
        "agent.disable",
        "agent.stop",
        "agent.status",
        "agent.administer",
        "agent.purge",
        "audit.read",
      ]),
      target: AgentTarget,
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("agent.revision.read"),
      target: Type.Object(
        { namespaceId: NamespaceId, agentId: AgentId, revisionId: RevisionId },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    { kind: Type.Literal("agent.deploy"), target: Type.Object(DeploymentFields, Closed) },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("agent.resume"),
      target: Type.Union([
        Type.Object(
          { ...DeploymentFields, revisionSource: Type.Literal("retained"), revisionId: RevisionId },
          Closed,
        ),
        Type.Object({ ...DeploymentFields, revisionSource: Type.Literal("saved-draft") }, Closed),
      ]),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("agent.create"),
      target: Type.Object(
        {
          namespaceId: NamespaceId,
          configurationId: ConfigurationId,
          serviceAccountId: Type.Optional(ServiceAccountId),
          secretIds: DeploymentFields.secretIds,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("agent.update"),
      target: Type.Object(
        {
          ...DeploymentFields,
          previousServiceAccountId: Type.Optional(ServiceAccountId),
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("configuration.create"),
      target: Type.Object(
        { namespaceId: NamespaceId, secretIds: DeploymentFields.secretIds },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["configuration.read", "configuration.delete"]),
      target: Type.Object({ namespaceId: NamespaceId, configurationId: ConfigurationId }, Closed),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("configuration.update"),
      target: Type.Object(
        {
          namespaceId: NamespaceId,
          configurationId: ConfigurationId,
          secretIds: DeploymentFields.secretIds,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    { kind: Type.Enum(["secret.create", "service-account.create"]), target: NamespaceTarget },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["secret.read", "secret.update", "secret.delete", "secret.use"]),
      target: Type.Object({ namespaceId: NamespaceId, secretId: SecretId }, Closed),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["service-account.read", "service-account.update", "service-account.delete"]),
      target: Type.Object({ namespaceId: NamespaceId, serviceAccountId: ServiceAccountId }, Closed),
    },
    Closed,
  ),
  Type.Object(
    { kind: Type.Enum(["conversation.read", "turn.admit"]), target: ConversationTarget },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("turn.dispatch"),
      target: Type.Object(
        { ...ConversationTarget.properties, turnRef: Ref, attemptRef: Ref },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("grant.use"),
      target: Type.Object(
        {
          ...ConversationTarget.properties,
          turnRef: Ref,
          attemptRef: Ref,
          resourceProfileRef: Ref,
          operationResourceRef: Ref,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("reply.deliver"),
      target: Type.Object(
        {
          ...ConversationTarget.properties,
          outputRef: Ref,
          replyDestinationRef: Ref,
          replyBindingVersion: Version,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("restore.read"),
      target: Type.Object(
        {
          ...AgentTarget.properties,
          conversationRef: Ref,
          responsibilityRef: Ref,
          checkpointRef: Ref,
          storeRef: Ref,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Literal("runtime.cleanup"),
      target: Type.Object({ ...AgentTarget.properties, responsibilityRef: Ref }, Closed),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["turn.cancel.own", "turn.cancel.shared"]),
      target: Type.Object(
        {
          ...ConversationTarget.properties,
          turnRef: Ref,
        },
        Closed,
      ),
    },
    Closed,
  ),
  Type.Object(
    {
      kind: Type.Enum(["model.generate", "repository.token.issue"]),
      target: Type.Object(
        {
          ...ConversationTarget.properties,
          credentialSecretId: SecretId,
          resourceProfileRef: Ref,
          operationResourceRef: Ref,
          turnRef: Ref,
          attemptRef: Ref,
        },
        Closed,
      ),
    },
    Closed,
  ),
]);
export type AccountOperationV1 = DeepReadonly<Type.Static<typeof AccountOperationSchemaV1>>;
export type AccountIAMCheckV1 = Readonly<Omit<AuthorizationRequest, "principalId">>;

/**
 * Pure schema-level composition, NOT authorization. Every returned check is
 * conjunctive and must use the actual authenticated subject and selected driver.
 * The accepting adapter additionally evaluates current semantic Role/Binding-ID
 * grants: operate Agent for collaboration never grants lifecycle management.
 * Ownership, common grants, actor equality/shared cancel, full audiences, runtime,
 * canonical attempts, restore/cleanup responsibilities and audit remain mandatory.
 */
export function accountIAMChecksV1(
  installationId: string,
  operation: AccountOperationV1,
): readonly AccountIAMCheckV1[] {
  const parsed = decode(
    AccountOperationSchemaV1,
    operation,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxRequestBytes,
  );
  if (!Check(InstallationId, installationId) || parsed.kind !== "valid")
    throw new TypeError("Invalid exact account operation.");
  operation = parsed.value;
  const check = (action: PermissionAction, resource: ResourceRef): AccountIAMCheckV1 => ({
    action,
    resource,
  });
  const target = operation.target;
  const namespaceId = "namespaceId" in target ? target.namespaceId : undefined;
  const scoped = (
    action: PermissionAction,
    kind: ResourceRef["kind"],
    id: string,
  ): AccountIAMCheckV1 => {
    if (namespaceId === undefined) throw new TypeError("Missing exact Namespace.");
    return check(action, { kind, id, namespaceId });
  };
  const agent = (action: PermissionAction): AccountIAMCheckV1 => {
    if (!("agentId" in target)) throw new TypeError("Missing exact Agent.");
    return scoped(action, "agent", target.agentId);
  };
  const deployment = (action: "create" | "update" | "deploy"): AccountIAMCheckV1[] => {
    if (!("configurationId" in target) || !("secretIds" in target) || namespaceId === undefined)
      throw new TypeError("Missing exact deployment references.");
    const result = [
      action === "create" ? scoped("create", "agent", namespaceId) : agent(action),
      scoped("read", "configuration", target.configurationId),
    ];
    if ("serviceAccountId" in target && target.serviceAccountId !== undefined)
      result.push(scoped("read", "service_account", target.serviceAccountId));
    if (
      "previousServiceAccountId" in target &&
      target.previousServiceAccountId !== undefined &&
      target.previousServiceAccountId !== target.serviceAccountId
    )
      result.push(scoped("read", "service_account", target.previousServiceAccountId));
    for (const id of target.secretIds) result.push(scoped("operate", "secret", id));
    return result;
  };
  let checks: AccountIAMCheckV1[];
  switch (operation.kind) {
    case "installation.read":
      checks = [check("read", { kind: "installation", id: installationId })];
      break;
    case "installation.administer":
      checks = [check("administer", { kind: "installation", id: installationId })];
      break;
    case "namespace.create":
      checks = [
        check("create", { kind: "namespace", id: installationId }),
        check("administer", { kind: "installation", id: installationId }),
      ];
      break;
    case "namespace.read":
      checks = [scoped("read", "namespace", operation.target.namespaceId)];
      break;
    case "namespace.delete":
      checks = [scoped("delete", "namespace", operation.target.namespaceId)];
      break;
    case "namespace.administer":
      checks = [scoped("administer", "namespace", operation.target.namespaceId)];
      break;
    case "agent.create":
      checks = deployment("create");
      break;
    case "agent.update":
      checks = deployment("update");
      break;
    case "agent.deploy":
      checks = deployment("deploy");
      break;
    case "agent.resume":
      checks = [agent("operate"), ...deployment("deploy")];
      break;
    case "agent.disable":
    case "agent.stop":
    case "runtime.cleanup":
      checks = [agent("operate")];
      break;
    case "agent.status":
    case "conversation.read":
    case "reply.deliver":
    case "restore.read":
      checks = [agent("read")];
      break;
    case "agent.administer":
    case "audit.read":
      checks = [agent("administer")];
      break;
    case "agent.purge":
      checks = [agent("administer"), agent("operate")];
      break;
    case "agent.revision.read":
      checks = [agent("read"), scoped("read", "agent_revision", operation.target.revisionId)];
      break;
    case "configuration.create":
      checks = [
        scoped("create", "configuration", operation.target.namespaceId),
        ...operation.target.secretIds.map((id) => scoped("operate", "secret", id)),
      ];
      break;
    case "configuration.update":
      checks = [
        scoped("update", "configuration", operation.target.configurationId),
        ...operation.target.secretIds.map((id) => scoped("operate", "secret", id)),
      ];
      break;
    case "configuration.read":
      checks = [scoped("read", "configuration", operation.target.configurationId)];
      break;
    case "configuration.delete":
      checks = [scoped("delete", "configuration", operation.target.configurationId)];
      break;
    case "secret.create":
      checks = [scoped("create", "secret", operation.target.namespaceId)];
      break;
    case "service-account.create":
      checks = [scoped("create", "service_account", operation.target.namespaceId)];
      break;
    case "secret.read":
      checks = [scoped("read", "secret", operation.target.secretId)];
      break;
    case "secret.update":
      checks = [scoped("update", "secret", operation.target.secretId)];
      break;
    case "secret.delete":
      checks = [scoped("delete", "secret", operation.target.secretId)];
      break;
    case "secret.use":
      checks = [scoped("operate", "secret", operation.target.secretId)];
      break;
    case "service-account.read":
      checks = [scoped("read", "service_account", operation.target.serviceAccountId)];
      break;
    case "service-account.update":
      checks = [scoped("update", "service_account", operation.target.serviceAccountId)];
      break;
    case "service-account.delete":
      checks = [scoped("delete", "service_account", operation.target.serviceAccountId)];
      break;
    case "turn.admit":
    case "turn.dispatch":
    case "grant.use":
    case "turn.cancel.own":
    case "turn.cancel.shared":
      checks = [agent("operate"), agent("read")];
      break;
    case "model.generate":
    case "repository.token.issue":
      checks = [
        agent("operate"),
        agent("read"),
        scoped("operate", "secret", operation.target.credentialSecretId),
      ];
      break;
    default: {
      const neverOperation: never = operation;
      throw new TypeError(`Unsupported operation: ${String(neverOperation)}`);
    }
  }
  return immutableCopy(checks);
}

/** Required semantic operands in addition to every exact selected-IAM check. */
export type AccountSemanticRequirementV1 =
  | "installation-administrator"
  | "namespace-administrator"
  | "agent-administrator"
  | "lifecycle-manager"
  | "credential-manager"
  | "human-collaborator"
  | "conversation-read"
  | "conversation-append"
  | "common-grant-use"
  | "own-turn-actor"
  | "explicit-own-cancel"
  | "explicit-shared-cancel"
  | "explicit-audit-read"
  | "restore-service-responsibility"
  | "cleanup-service-responsibility"
  | "agent-executor-secret-use"
  | "separate-purge-authorization";
const SemanticRequirements: Readonly<
  Record<AccountOperationV1["kind"], readonly AccountSemanticRequirementV1[]>
> = {
  "installation.read": [],
  "installation.administer": ["installation-administrator"],
  "namespace.create": ["installation-administrator"],
  "namespace.read": [],
  "namespace.delete": ["namespace-administrator"],
  "namespace.administer": ["namespace-administrator"],
  "agent.create": ["lifecycle-manager"],
  "agent.update": ["lifecycle-manager"],
  "agent.deploy": ["lifecycle-manager", "agent-executor-secret-use"],
  "agent.resume": ["lifecycle-manager", "agent-executor-secret-use"],
  "agent.disable": ["lifecycle-manager"],
  "agent.stop": ["lifecycle-manager"],
  "agent.status": [],
  "agent.revision.read": [],
  "agent.administer": ["agent-administrator"],
  "agent.purge": ["agent-administrator", "separate-purge-authorization"],
  "audit.read": ["agent-administrator", "explicit-audit-read"],
  "configuration.create": ["lifecycle-manager"],
  "configuration.read": [],
  "configuration.update": ["lifecycle-manager"],
  "configuration.delete": ["lifecycle-manager"],
  "secret.create": ["credential-manager"],
  "secret.read": ["credential-manager"],
  "secret.update": ["credential-manager"],
  "secret.delete": ["credential-manager"],
  "secret.use": [],
  "service-account.create": ["credential-manager"],
  "service-account.read": ["credential-manager"],
  "service-account.update": ["credential-manager"],
  "service-account.delete": ["credential-manager"],
  "conversation.read": ["human-collaborator", "conversation-read"],
  "turn.admit": [
    "human-collaborator",
    "conversation-read",
    "conversation-append",
    "common-grant-use",
  ],
  "turn.dispatch": [
    "human-collaborator",
    "conversation-read",
    "conversation-append",
    "common-grant-use",
  ],
  "grant.use": ["human-collaborator", "conversation-read", "common-grant-use"],
  "model.generate": ["human-collaborator", "conversation-read", "common-grant-use"],
  "repository.token.issue": ["human-collaborator", "conversation-read", "common-grant-use"],
  "reply.deliver": ["human-collaborator", "conversation-read"],
  "turn.cancel.own": [
    "human-collaborator",
    "conversation-read",
    "own-turn-actor",
    "explicit-own-cancel",
  ],
  "turn.cancel.shared": ["human-collaborator", "conversation-read", "explicit-shared-cancel"],
  "restore.read": ["restore-service-responsibility"],
  "runtime.cleanup": ["cleanup-service-responsibility"],
};
/**
 * Pure requirements, never policy decisions. Registered current Role/Binding-ID
 * evidence, current account/credential/grant versions and exact object ownership
 * apply to all operations. An empty extra list does not bypass those checks.
 * Read-only conversation membership satisfies human-collaborator for reads;
 * lifecycle/operator status cannot satisfy it. Cleanup and restore use independent
 * service responsibilities, never historical human grants or serving authority.
 */
export function accountSemanticRequirementsV1(
  operation: AccountOperationV1,
): readonly AccountSemanticRequirementV1[] {
  const parsed = decode(
    AccountOperationSchemaV1,
    operation,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxRequestBytes,
  );
  if (parsed.kind !== "valid") throw new TypeError("Invalid exact account operation.");
  return immutableCopy(SemanticRequirements[parsed.value.kind]);
}

export const AccountVersionVectorSchemaV1 = Type.Object(
  {
    installation: Version,
    account: Version,
    credential: Version,
    grants: Version,
    iamPolicy: Version,
    semanticMapping: Version,
    driverSelection: Version,
  },
  Closed,
);
export type AccountVersionVectorV1 = DeepReadonly<Type.Static<typeof AccountVersionVectorSchemaV1>>;

/** Protected diagnostic facts from the owning invalidation writer, not a permit. */
export const AccountInvalidationObservationSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    installationId: InstallationId,
    principalId: Ref,
    principalKind: Type.Enum(["principal", "service_principal"]),
    currentnessProfile: Profile,
    eventRef: Ref,
    observedAt: Timestamp,
    change: Type.Enum([
      "account-disabled",
      "account-recovered",
      "session-revoked",
      "key-revoked",
      "grants-changed",
      "driver-changed",
    ]),
    previousVersions: AccountVersionVectorSchemaV1,
    currentVersions: AccountVersionVectorSchemaV1,
  },
  Closed,
);
export type AccountInvalidationObservationV1 = DeepReadonly<
  Type.Static<typeof AccountInvalidationObservationSchemaV1>
>;

const RequestFields = {
  schemaVersion: Type.Literal(1),
  installationId: InstallationId,
  requestId: RequestId,
  currentnessProfile: Profile,
  createdAt: Timestamp,
  deadline: Timestamp,
};
export const ResolveAccountRequestSchemaV1 = Type.Object(RequestFields, Closed);
export type ResolveAccountRequestV1 = DeepReadonly<
  Type.Static<typeof ResolveAccountRequestSchemaV1>
>;
export const ExactAccountActionRequestSchemaV1 = Type.Object(
  {
    ...RequestFields,
    operation: AccountOperationSchemaV1,
    expectedVersions: Type.Optional(AccountVersionVectorSchemaV1),
  },
  Closed,
);
export type ExactAccountActionRequestV1 = DeepReadonly<
  Type.Static<typeof ExactAccountActionRequestSchemaV1>
>;

const SubjectCommon = {
  principalId: Ref,
  accountState: Type.Literal("active"),
  selectedIAM: Type.Object({ driverId: ProviderId, revision: Version }, Closed),
};
export const AccountSubjectSchemaV1 = Type.Union([
  Type.Object(
    {
      ...SubjectCommon,
      principalKind: Type.Literal("principal"),
      credentialMode: Type.Literal("session"),
      accountId: Ref,
      session: Type.Object({ sessionId: Ref, version: Version, expiresAt: Timestamp }, Closed),
    },
    Closed,
  ),
  Type.Object(
    {
      ...SubjectCommon,
      principalKind: Type.Literal("service_principal"),
      credentialMode: Type.Literal("service-key"),
      serviceClass: Type.Literal("independent"),
      namespaceId: Type.Optional(NamespaceId),
      key: Type.Object({ keyId: Ref, version: Version, expiresAt: Timestamp }, Closed),
    },
    Closed,
  ),
]);
export type AccountSubjectV1 = DeepReadonly<Type.Static<typeof AccountSubjectSchemaV1>>;
// Compile-time drift checks retain the existing IAM identity/action/resource types.
type IdentityKindsMatch = AccountSubjectV1["principalKind"] extends Identity["kind"] ? true : false;
const identityKindsMatch: IdentityKindsMatch = true;
void identityKindsMatch;

const ObservationFields = {
  schemaVersion: Type.Literal(1),
  requestId: RequestId,
  installationId: InstallationId,
  currentnessProfile: Profile,
  scope: Type.Literal("account-and-selected-iam-only"),
  evaluatedAt: Timestamp,
  validUntil: Timestamp,
  subject: AccountSubjectSchemaV1,
  versions: AccountVersionVectorSchemaV1,
};
export const CurrentAccountObservationSchemaV1 = Type.Object(ObservationFields, Closed);
export type CurrentAccountObservationV1 = DeepReadonly<
  Type.Static<typeof CurrentAccountObservationSchemaV1>
>;
export const ExactAccountActionObservationSchemaV1 = Type.Object(
  {
    ...ObservationFields,
    operation: AccountOperationSchemaV1,
    decisionRef: Ref,
    evidence: Type.Object(
      {
        evidenceRef: Ref,
        roleIds: Type.Array(Ref, { minItems: 1, maxItems: 64, uniqueItems: true }),
        bindingIds: Type.Array(Ref, { minItems: 1, maxItems: 64, uniqueItems: true }),
        semanticGrantRef: Ref,
      },
      Closed,
    ),
  },
  Closed,
);
export type ExactAccountActionObservationV1 = DeepReadonly<
  Type.Static<typeof ExactAccountActionObservationSchemaV1>
>;

/** The three denial shapes contain no account, resource, timing or provider detail. */
export const AccountAuthorityFailureSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Literal("denied") }, Closed),
  Type.Object({ kind: Type.Literal("not-visible") }, Closed),
  Type.Object({ kind: Type.Literal("unavailable") }, Closed),
]);
export type AccountAuthorityFailureV1 = DeepReadonly<
  Type.Static<typeof AccountAuthorityFailureSchemaV1>
>;
export const AccountAuthorityInternalReasonSchemaV1 = Type.Enum([
  "invalid-input",
  "credential-invalid",
  "session-expired",
  "account-disabled",
  "subject-mismatch",
  "driver-changed",
  "scope-denied",
  "version-conflict",
  "authority-unavailable",
]);
export type AccountAuthorityInternalReasonV1 = Type.Static<
  typeof AccountAuthorityInternalReasonSchemaV1
>;

/** Diagnostic schemas deliberately exclude every trusted handle. */
export const CurrentAccountResultSchemaV1 = Type.Union([
  Type.Object(
    { kind: Type.Literal("current"), observation: CurrentAccountObservationSchemaV1 },
    Closed,
  ),
  AccountAuthorityFailureSchemaV1,
]);
export type CurrentAccountDiagnosticV1 = DeepReadonly<
  Type.Static<typeof CurrentAccountResultSchemaV1>
>;
export const ExactAccountActionResultSchemaV1 = Type.Union([
  Type.Object(
    { kind: Type.Literal("allowed"), observation: ExactAccountActionObservationSchemaV1 },
    Closed,
  ),
  AccountAuthorityFailureSchemaV1,
]);
export type ExactAccountActionDiagnosticV1 = DeepReadonly<
  Type.Static<typeof ExactAccountActionResultSchemaV1>
>;

declare const authenticatedRequestBrand: unique symbol;
declare const accountObservationBrand: unique symbol;
/** Process-local, receiver-produced, invocation-bound; no public minting/decoder. */
export interface AuthenticatedRequestHandleV1 {
  readonly [authenticatedRequestBrand]: true;
}
/** Observation provenance only. Final effects must recheck; this is not an effect permit. */
export interface AccountAuthorityObservationHandleV1 {
  readonly [accountObservationBrand]: true;
}
export type CurrentAccountResultV1 =
  | {
      readonly kind: "current";
      readonly observation: CurrentAccountObservationV1;
      readonly authority: AccountAuthorityObservationHandleV1;
    }
  | AccountAuthorityFailureV1;
export type ExactAccountActionResultV1 =
  | {
      readonly kind: "allowed";
      readonly observation: ExactAccountActionObservationV1;
      readonly authority: AccountAuthorityObservationHandleV1;
    }
  | AccountAuthorityFailureV1;

/**
 * Dependency implemented only by the real accepting-service authentication layer.
 * It verifies the current request, selects session versus explicitly supplied key
 * without fallback, and binds an opaque handle to this invocation and recipient.
 * Implementations reject foreign/replayed handles; TypeScript branding is not proof.
 * No implementation, raw-header constructor or remote transport is supplied here.
 */
export interface AuthenticatedRequestHandleSourceV1 {
  forCurrentInvocation(): Promise<AuthenticatedRequestHandleV1>;
}

/**
 * resolveSubjectV1 loads current account/session/key, selected IAM and all versions.
 * authorizeExactV1 repeats that resolution and every composed IAM check, current
 * semantic role/grant predicates and expected-version comparison. Never accept
 * a caller principal/driver, use Agent-owned service keys, or reuse resolve allow.
 * Disabled/recovered/expired credentials deny; foreign/unknown share not-visible.
 * Changed selected driver does not reinterpret identities or fall back to native.
 * Clock/dependency/deadline failure is unavailable. Handle provenance and immutable
 * request/observation equality must be verified inside the real adapter.
 */
export interface CurrentAccountAuthorityPortV1 {
  resolveSubjectV1(
    authenticated: AuthenticatedRequestHandleV1,
    input: ResolveAccountRequestV1,
  ): Promise<CurrentAccountResultV1>;
  authorizeExactV1(
    authenticated: AuthenticatedRequestHandleV1,
    input: ExactAccountActionRequestV1,
  ): Promise<ExactAccountActionResultV1>;
}

export type AccountDecodeResultV1<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };

/** Reject non-JSON/accessor/prototype/cyclic objects before TypeBox validation. */
function jsonValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > 12 || ++budget.nodes > 2048) return false;
  if (typeof value === "string" && value.length > 1024) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const array = Array.isArray(value);
  if (
    array
      ? Object.getPrototypeOf(value) !== Array.prototype
      : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
  )
    return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || (array && (value.length > 64 || keys.length !== value.length + 1)))
    return false;
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array) {
      if (key === "length") continue;
      const index = Number(key);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= value.length ||
        String(index) !== key
      )
        return false;
    }
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable || !jsonValue(d.value, seen, depth + 1, budget))
      return false;
  }
  seen.delete(value);
  return true;
}
function timestamps(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  for (const [key, item] of Object.entries(value)) {
    if (
      ["createdAt", "deadline", "evaluatedAt", "validUntil", "expiresAt", "observedAt"].includes(
        key,
      )
    ) {
      if (
        typeof item !== "string" ||
        !Number.isFinite(Date.parse(item)) ||
        new Date(item).toISOString() !== item
      )
        return false;
    } else if (!timestamps(item)) return false;
  }
  return true;
}
function decode<T extends Type.TSchema>(
  schema: T,
  input: unknown,
  maxBytes: number,
): AccountDecodeResultV1<DeepReadonly<Type.Static<T>>> {
  try {
    if (
      !jsonValue(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes ||
      !Check(schema, input) ||
      !timestamps(input)
    )
      return { kind: "invalid" };
    return { kind: "valid", value: immutableCopy(input) as DeepReadonly<Type.Static<T>> };
  } catch {
    return { kind: "invalid" };
  }
}
function requestTimes(input: ResolveAccountRequestV1): boolean {
  const duration = Date.parse(input.deadline) - Date.parse(input.createdAt);
  return duration > 0 && duration <= ACCOUNT_AUTHORITY_LIMITS_V1.maxDependencyCallMs;
}
function observationTimes(input: CurrentAccountObservationV1): boolean {
  const duration = Date.parse(input.validUntil) - Date.parse(input.evaluatedAt);
  const credential =
    input.subject.credentialMode === "session" ? input.subject.session : input.subject.key;
  return (
    duration > 0 &&
    duration <= ACCOUNT_AUTHORITY_LIMITS_V1.maxOperationStartMs &&
    Date.parse(input.validUntil) <= Date.parse(credential.expiresAt) &&
    credential.version === input.versions.credential
  );
}
export function decodeResolveAccountRequestV1(
  input: unknown,
): AccountDecodeResultV1<ResolveAccountRequestV1> {
  const r = decode(
    ResolveAccountRequestSchemaV1,
    input,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxRequestBytes,
  );
  return r.kind === "valid" && !requestTimes(r.value) ? { kind: "invalid" } : r;
}
export function decodeExactAccountActionRequestV1(
  input: unknown,
): AccountDecodeResultV1<ExactAccountActionRequestV1> {
  const r = decode(
    ExactAccountActionRequestSchemaV1,
    input,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxRequestBytes,
  );
  return r.kind === "valid" && !requestTimes(r.value) ? { kind: "invalid" } : r;
}
export function decodeCurrentAccountDiagnosticV1(
  input: unknown,
): AccountDecodeResultV1<CurrentAccountDiagnosticV1> {
  const r = decode(
    CurrentAccountResultSchemaV1,
    input,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxObservationBytes,
  );
  return r.kind === "valid" && r.value.kind === "current" && !observationTimes(r.value.observation)
    ? { kind: "invalid" }
    : r;
}
export function decodeExactAccountActionDiagnosticV1(
  input: unknown,
): AccountDecodeResultV1<ExactAccountActionDiagnosticV1> {
  const r = decode(
    ExactAccountActionResultSchemaV1,
    input,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxObservationBytes,
  );
  if (r.kind === "invalid" || r.value.kind !== "allowed") return r;
  const observation = r.value.observation;
  if (!observationTimes(observation)) return { kind: "invalid" };
  const requirements = accountSemanticRequirementsV1(observation.operation);
  const service = observation.subject.credentialMode === "service-key";
  if (
    (service && requirements.includes("human-collaborator")) ||
    (!service &&
      (requirements.includes("restore-service-responsibility") ||
        requirements.includes("cleanup-service-responsibility")))
  )
    return { kind: "invalid" };
  if (
    service &&
    observation.subject.namespaceId !== undefined &&
    (!("namespaceId" in observation.operation.target) ||
      observation.subject.namespaceId !== observation.operation.target.namespaceId)
  )
    return { kind: "invalid" };
  return r;
}

/** This decoder verifies representation/version relations, not writer authenticity. */
export function decodeAccountInvalidationObservationV1(
  input: unknown,
): AccountDecodeResultV1<AccountInvalidationObservationV1> {
  const r = decode(
    AccountInvalidationObservationSchemaV1,
    input,
    ACCOUNT_AUTHORITY_LIMITS_V1.maxObservationBytes,
  );
  if (r.kind === "invalid") return r;
  const value = r.value;
  const before = value.previousVersions;
  const after = value.currentVersions;
  if (
    Object.keys(before).some(
      (key) =>
        after[key as keyof AccountVersionVectorV1] < before[key as keyof AccountVersionVectorV1],
    )
  )
    return { kind: "invalid" };
  const field = {
    "account-disabled": "account",
    "account-recovered": "account",
    "session-revoked": "credential",
    "key-revoked": "credential",
    "grants-changed": "grants",
    "driver-changed": "driverSelection",
  } as const;
  if (after[field[value.change]] <= before[field[value.change]]) return { kind: "invalid" };
  if (
    (value.change === "session-revoked" && value.principalKind !== "principal") ||
    (value.change === "key-revoked" && value.principalKind !== "service_principal")
  )
    return { kind: "invalid" };
  if (
    (value.change === "account-disabled" || value.change === "account-recovered") &&
    after.credential <= before.credential
  )
    return { kind: "invalid" };
  return r;
}
