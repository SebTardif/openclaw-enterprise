import {
  decodeManualPolicyRegistrationV1,
  decodeManualPolicyTemplateV1,
  isManualPolicyInstallationIdV1,
  type ManualPolicyGrantDescriptorV1,
  type ManualPolicyOperationV1,
  type ManualPolicyRegistrationV1,
  type ManualPolicyTemplateSpecV1,
} from "@openclaw-enterprise/contracts/manual-native-policy-v1";
import type {
  AccessBinding,
  AuthorizationRequest,
  Permission,
  Role,
} from "@openclaw-enterprise/contracts/identity/authorization";
import type { ResourceRef } from "@openclaw-enterprise/contracts/resources/scope";
import type { AccountSemanticRequirementV1 } from "@openclaw-enterprise/contracts/account-authority-v1";

export interface ManualPolicyExpansionV1 {
  readonly kind: "expanded";
  readonly grants: readonly ManualPolicyGrantDescriptorV1[];
  readonly rolePermissions: readonly Permission[];
  readonly specification: ManualPolicyTemplateSpecV1;
}
const invalid = Object.freeze({ kind: "invalid" as const });
const permissionKey = (permission: Permission): string =>
  `${permission.resourceKind}:${permission.action}`;
const resourceKey = (resource: ResourceRef): string =>
  `${resource.namespaceId ?? ""}:${resource.kind}:${resource.id}`;

/** A finite proposal for the original writer. No IDs, records or authority are minted. */
export function expandManualPolicyTemplateV1(
  input: unknown,
  installationId: string,
): ManualPolicyExpansionV1 | Readonly<{ kind: "invalid" }> {
  const parsed = decodeManualPolicyTemplateV1(input);
  if (parsed.kind !== "valid" || !isManualPolicyInstallationIdV1(installationId)) return invalid;
  const spec = parsed.value;
  const grants = new Map<string, { resource: ResourceRef; permissions: Map<string, Permission> }>();
  const add = (resource: ResourceRef, action: Permission["action"]): void => {
    const key = resourceKey(resource);
    let grant = grants.get(key);
    if (!grant) {
      grant = { resource, permissions: new Map() };
      grants.set(key, grant);
    }
    const permission: Permission = { action, resourceKind: resource.kind };
    grant.permissions.set(permissionKey(permission), Object.freeze(permission));
  };
  if (spec.target.kind === "installation") {
    add({ kind: "installation", id: installationId }, "read");
  } else {
    const namespaceId = spec.target.namespaceId;
    const agent: ResourceRef = { kind: "agent", id: spec.target.agentId, namespaceId };
    // Read is always needed for the template's exact management or conversation projection.
    add(agent, "read");
    for (const operation of spec.operationCeiling) {
      switch (operation) {
        case "agent.deploy":
          add(agent, "deploy");
          break;
        case "agent.resume":
          add(agent, "deploy");
          add(agent, "operate");
          break;
        case "agent.administer":
          add(agent, "administer");
          break;
        case "context.recover-pristine":
        case "context.accept-residual-workspace":
          add(agent, "administer");
          add(agent, "operate");
          break;
        case "agent.disable":
        case "agent.stop":
        case "agent.reconcile-observation":
        case "turn.admit":
        case "turn.dispatch":
        case "grant.use":
        case "model.generate":
        case "repository.token.issue":
        case "turn.cancel.own":
          add(agent, "operate");
          break;
        case "agent.status":
        case "conversation.read":
        case "reply.deliver":
          break;
        case "installation.read":
          return invalid;
        default: {
          const unsupported: never = operation;
          throw new TypeError(`Unsupported manual policy operation: ${String(unsupported)}`);
        }
      }
    }
    for (const id of spec.references.configurationIds)
      add({ kind: "configuration", id, namespaceId }, "read");
    for (const id of spec.references.serviceAccountIds)
      add({ kind: "service_account", id, namespaceId }, "read");
    for (const id of spec.references.secretIds) add({ kind: "secret", id, namespaceId }, "operate");
  }
  const rolePermissions = new Map<string, Permission>();
  const result = [...grants.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, grant]) => {
      const permissions = [...grant.permissions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value);
      for (const permission of permissions)
        rolePermissions.set(permissionKey(permission), permission);
      return Object.freeze({
        resource: Object.freeze(grant.resource),
        permissions: Object.freeze(permissions),
      });
    });
  return Object.freeze({
    kind: "expanded",
    grants: Object.freeze(result),
    rolePermissions: Object.freeze(
      [...rolePermissions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    ),
    specification: spec,
  });
}

const requirements: Readonly<
  Record<ManualPolicyOperationV1, readonly AccountSemanticRequirementV1[]>
> = {
  "installation.read": [],
  "agent.status": [],
  "agent.deploy": ["lifecycle-manager", "agent-executor-secret-use"],
  "agent.resume": ["lifecycle-manager", "agent-executor-secret-use"],
  "agent.disable": ["lifecycle-manager"],
  "agent.stop": ["lifecycle-manager"],
  "agent.reconcile-observation": ["lifecycle-manager"],
  "agent.administer": ["agent-administrator"],
  "context.recover-pristine": ["agent-administrator"],
  "context.accept-residual-workspace": ["agent-administrator"],
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
};

/** Required operands, not proof of current membership, lifecycle, executor or actor equality. */
export function manualPolicyRequiredSemanticsV1(
  operation: ManualPolicyOperationV1,
): readonly AccountSemanticRequirementV1[] {
  if (!Object.hasOwn(requirements, operation))
    throw new TypeError("Unsupported manual policy operation.");
  return Object.freeze([...requirements[operation]]);
}

export type ManualPolicyBindingEvaluationV1 =
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "eligible";
      scope: "binding-contribution-only";
      bindingId: string;
      roleId: string;
      registrationVersion: number;
      operationCeiling: readonly ManualPolicyOperationV1[];
    }>;
const denied = Object.freeze({ kind: "denied" as const });
const unavailable = Object.freeze({ kind: "unavailable" as const });

function samePermissions(actual: readonly Permission[], expected: readonly Permission[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const expectedKeys = new Set(expected.map(permissionKey));
  const seen = new Set<string>();
  for (const permission of actual) {
    if (!permission || Object.keys(permission).sort().join() !== "action,resourceKind")
      return false;
    const key = permissionKey(permission);
    if (!expectedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Evaluate a single registration against actual canonical Role/Binding values.
 * The native evaluator must still validate its complete snapshot, honor every
 * Restriction and aggregate actual grants. This contribution grants no operation.
 * TODO: the original native IAM/state owners must integrate this hook and durable
 * registration/version/invalidation before any registered template is usable.
 */
export function evaluateManualPolicyBindingV1(input: {
  readonly installationId: string;
  readonly registration: unknown;
  readonly role: Role;
  readonly binding: AccessBinding;
  readonly request: AuthorizationRequest;
  readonly principalKind: "principal" | "service_principal";
}): ManualPolicyBindingEvaluationV1 {
  try {
    const parsed = decodeManualPolicyRegistrationV1(input.registration);
    if (parsed.kind !== "valid" || parsed.value.installationId !== input.installationId)
      return unavailable;
    const registration = parsed.value;
    const expansion = expandManualPolicyTemplateV1(
      registration.specification,
      input.installationId,
    );
    const { role, binding, request } = input;
    if (
      expansion.kind !== "expanded" ||
      !role ||
      !binding ||
      !request ||
      !request.resource ||
      role.id !== registration.roleId ||
      binding.roleId !== role.id ||
      binding.channelAdministration !== undefined ||
      !samePermissions(role.permissions, expansion.rolePermissions)
    )
      return unavailable;
    const scope = registration.specification.target;
    const namespaceId = scope.kind === "agent" ? scope.namespaceId : undefined;
    if (
      role.namespaceId !== namespaceId ||
      binding.namespaceId !== namespaceId ||
      binding.resourceKind === undefined ||
      binding.resourceId === undefined
    )
      return unavailable;
    const grant = expansion.grants.find(
      (candidate) =>
        candidate.resource.kind === binding.resourceKind &&
        candidate.resource.id === binding.resourceId &&
        candidate.resource.namespaceId === binding.namespaceId,
    );
    if (!grant || binding.subjectKind !== "identity") return unavailable;
    // Withdrawal stops the generic grant contribution as well as all semantics.
    if (registration.status !== "enabled") return denied;
    if (
      input.principalKind !== "principal" ||
      binding.subjectId !== request.principalId ||
      request.resource.kind !== grant.resource.kind ||
      request.resource.id !== grant.resource.id ||
      request.resource.namespaceId !== grant.resource.namespaceId ||
      !grant.permissions.some((permission) => permission.action === request.action)
    )
      return denied;
    return Object.freeze({
      kind: "eligible",
      scope: "binding-contribution-only",
      bindingId: binding.id,
      roleId: role.id,
      registrationVersion: registration.version,
      operationCeiling: registration.specification.operationCeiling,
    });
  } catch {
    return unavailable;
  }
}

/** Classify an update before the actual writer's CAS; this does not commit one. */
export function classifyManualPolicyRegistrationChangeV1(
  before: unknown,
  after: unknown,
): "unchanged" | "withdraw" | "narrow" | "replacement-required" | "invalid" {
  const old = decodeManualPolicyRegistrationV1(before);
  const next = decodeManualPolicyRegistrationV1(after);
  if (old.kind !== "valid" || next.kind !== "valid") return "invalid";
  const left = old.value;
  const right = next.value;
  const identity = (value: ManualPolicyRegistrationV1): string =>
    JSON.stringify({
      installationId: value.installationId,
      roleId: value.roleId,
      template: value.specification.template,
      target: value.specification.target,
      references: value.specification.references,
    });
  if (identity(left) !== identity(right)) return "invalid";
  if (JSON.stringify(left) === JSON.stringify(right)) return "unchanged";
  if (
    left.status !== "enabled" ||
    left.version === Number.MAX_SAFE_INTEGER ||
    right.version !== left.version + 1
  )
    return "invalid";
  const oldOperations = new Set(left.specification.operationCeiling);
  if (right.specification.operationCeiling.some((operation) => !oldOperations.has(operation)))
    return "invalid";
  const unchangedCeiling = right.specification.operationCeiling.length === oldOperations.size;
  if (right.status === "disabled") return unchangedCeiling ? "withdraw" : "invalid";
  if (unchangedCeiling) return "invalid";
  const oldExpansion = expandManualPolicyTemplateV1(left.specification, left.installationId);
  const newExpansion = expandManualPolicyTemplateV1(right.specification, right.installationId);
  if (oldExpansion.kind !== "expanded" || newExpansion.kind !== "expanded") return "invalid";
  return samePermissions(oldExpansion.rolePermissions, newExpansion.rolePermissions)
    ? "narrow"
    : "replacement-required";
}
