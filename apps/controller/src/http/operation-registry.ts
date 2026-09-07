import { occApiRoutes, type OccApiRoute } from "@openclaw-enterprise/contracts/api/routes";
import type { PermissionAction, ResourceKind, ResourceRef } from "@openclaw-enterprise/contracts";
import type { FastifyReply, FastifyRequest, FastifySchema } from "fastify";

export interface RequiredPermission {
  readonly action: PermissionAction;
  readonly resourceKind: ResourceKind;
  readonly scope: "requested" | "installation" | "namespace" | "each_returned" | "request_body";
  readonly condition?: "associated_service_account" | "existing_namespace" | "bound_secret";
}

export interface DocumentedFastifySchema extends FastifySchema {
  readonly "x-openclaw-permissions": readonly RequiredPermission[];
}

export function operationTarget(
  operation: OccApiRoute,
  installationId: string,
  params: Readonly<Record<string, unknown>>,
): ResourceRef {
  const namespaceId = typeof params.namespaceId === "string" ? params.namespaceId : undefined;
  const configurationId =
    typeof params.configurationId === "string" ? params.configurationId : undefined;
  const serviceAccountId =
    typeof params.serviceAccountId === "string" ? params.serviceAccountId : undefined;
  const secretId = typeof params.secretId === "string" ? params.secretId : undefined;
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  const revisionId = typeof params.revisionId === "string" ? params.revisionId : undefined;
  if (operation.operationId === "createNamespace") return { kind: "namespace", id: installationId };
  if (operation.operationId === "createConfiguration" && namespaceId)
    return { kind: "configuration", id: namespaceId, namespaceId };
  if (configurationId && namespaceId)
    return { kind: "configuration", id: configurationId, namespaceId };
  if (operation.operationId === "createServiceAccount" && namespaceId)
    return { kind: "service_account", id: namespaceId, namespaceId };
  if (serviceAccountId && namespaceId)
    return { kind: "service_account", id: serviceAccountId, namespaceId };
  if (operation.operationId === "createSecret" && namespaceId)
    return { kind: "secret", id: namespaceId, namespaceId };
  if (secretId && namespaceId) return { kind: "secret", id: secretId, namespaceId };
  if (operation.operationId === "createAgent" && namespaceId)
    return { kind: "agent", id: namespaceId, namespaceId };
  if (operation.operationId === "getAgentRevision" && namespaceId && revisionId)
    return { kind: "agent_revision", id: revisionId, namespaceId };
  if (agentId && namespaceId) return { kind: "agent", id: agentId, namespaceId };
  if (namespaceId) return { kind: "namespace", id: namespaceId, namespaceId };
  return { kind: "installation", id: installationId };
}

export function requiredPermissions(operation: OccApiRoute): readonly RequiredPermission[] {
  const permission = {
    action: operation.iamAction,
    resourceKind: operation.resourceKind,
  };

  if (operation.operationId === "getAgentRevision") {
    return [
      { action: "read", resourceKind: "agent", scope: "requested" },
      { action: "read", resourceKind: "agent_revision", scope: "requested" },
    ];
  }

  if (operation.operationId === "createNamespace") {
    return [
      { ...permission, scope: "installation" },
      {
        action: "administer",
        resourceKind: "installation",
        scope: "requested",
        condition: "existing_namespace",
      },
    ];
  }

  if (
    operation.operationId === "createConfiguration" ||
    operation.operationId === "updateConfiguration"
  ) {
    return [
      {
        ...permission,
        scope: operation.operationId === "createConfiguration" ? "namespace" : "requested",
      },
      {
        action: "operate",
        resourceKind: "secret",
        scope: operation.operationId === "createConfiguration" ? "request_body" : "requested",
        condition: "bound_secret",
      },
    ];
  }

  if (operation.operationId === "createSecret") {
    return [{ ...permission, scope: "namespace" }];
  }

  if (
    operation.operationId === "createAgent" ||
    operation.operationId === "updateAgent" ||
    operation.operationId === "deployAgent"
  ) {
    return [
      { ...permission, scope: operation.operationId === "createAgent" ? "namespace" : "requested" },
      { action: "read", resourceKind: "configuration", scope: "requested" },
      {
        action: "read",
        resourceKind: "service_account",
        scope: "requested",
        condition: "associated_service_account",
      },
      {
        action: "operate",
        resourceKind: "secret",
        scope: "requested",
        condition: "bound_secret",
      },
    ];
  }

  switch (operation.authorizationTarget) {
    case "namespace_collection":
      return [{ ...permission, scope: "namespace" }];
    case "namespace_candidates":
      return [{ ...permission, scope: "each_returned" }];
    case "namespace_and_agent_candidates":
      return [
        { action: "read", resourceKind: "namespace", scope: "requested" },
        { ...permission, scope: "each_returned" },
      ];
    case "namespace_and_service_account_candidates":
      return [
        { action: "read", resourceKind: "namespace", scope: "requested" },
        { ...permission, scope: "each_returned" },
      ];
    case "agent_collection":
      return [
        { ...permission, scope: "requested" },
        { action: "read", resourceKind: "agent_revision", scope: "each_returned" },
      ];
    default:
      return [{ ...permission, scope: "requested" }];
  }
}

export function permissionDescription(
  permissions: readonly RequiredPermission[],
  operation?: OccApiRoute,
): string {
  const names: Record<ResourceKind, string> = {
    installation: "Installation",
    namespace: "Namespace",
    configuration: "Configuration",
    service_account: "ServiceAccount",
    secret: "Secret",
    agent: "Agent",
    agent_revision: "AgentRevision",
  };

  const description = permissions
    .map(({ action, resourceKind, scope, condition }) => {
      const name = names[resourceKind];
      if (condition === "associated_service_account")
        return `Requires ${action} permission on each currently associated or newly associated ${name} when present.`;
      if (condition === "existing_namespace")
        return `Requires ${action} permission on the ${name} when selecting an existing Kubernetes namespace.`;
      if (condition === "bound_secret") {
        if (operation?.operationId === "createConfiguration")
          return `Requires ${action} permission on each ${name} supplied in request body Secret bindings.`;
        if (operation?.operationId === "updateConfiguration")
          return `Requires ${action} permission on each ${name} bound by the resulting Configuration.`;
        return `Requires ${action} permission on each bound ${name} when Secret bindings are present or selected.`;
      }
      switch (scope) {
        case "installation":
          return `Requires ${action} permission for ${name} resources in the Installation.`;
        case "namespace":
          return `Requires ${action} permission for ${name} resources in the requested Namespace.`;
        case "each_returned":
          return `Only ${name} resources with individual ${action} permission are returned.`;
        default:
          return `Requires ${action} permission on the requested ${name}.`;
      }
    })
    .join(" ");

  if (operation?.operationId === "deployAgent") {
    return `${description} Deployment also requires the owning Agent service principal to have operate permission on each bound Secret.`;
  }
  return description;
}

export type OrdinaryOperation = Exclude<
  OccApiRoute,
  { readonly operationId: "bootstrapInstallation" }
>;
export type BootstrapOperation = Extract<
  OccApiRoute,
  { readonly operationId: "bootstrapInstallation" }
>;
export const ordinaryOperations = Object.freeze(
  occApiRoutes.filter(
    (operation): operation is OrdinaryOperation =>
      operation.operationId !== "bootstrapInstallation",
  ),
);
export const bootstrapOperation = occApiRoutes.find(
  (operation): operation is BootstrapOperation => operation.operationId === "bootstrapInstallation",
)!;

export type OperationHandler<Operation extends OccApiRoute = OccApiRoute> = (
  request: FastifyRequest,
  reply: FastifyReply,
  operation: Operation,
) => Promise<void>;
export type OperationHandlers<Operations extends readonly OccApiRoute[]> = {
  readonly [
    Operation in Operations[number] as Operation["operationId"]
  ]: OperationHandler<Operation>;
};
export interface RegisteredOperation<Operation extends OccApiRoute = OccApiRoute> {
  readonly operation: Operation;
  readonly schema: DocumentedFastifySchema;
  readonly handler: OperationHandler<Operation>;
}

// Every catalog operation declares whether it accepts a body. This independent
// expectation prevents schema removal from silently turning a write into a bodyless route.
const operationBodyExpectations = {
  createChannelInstallation: "required",
  listChannelInstallations: "none",
  getChannelInstallation: "none",
  setChannelInstallationStatus: "required",
  createChannelHumanBinding: "required",
  listChannelHumanBindings: "none",
  getChannelHumanBinding: "none",
  setChannelHumanBindingStatus: "required",
  createChannelAgentBinding: "required",
  listChannelAgentBindings: "none",
  getChannelAgentBinding: "none",
  setChannelAgentBindingStatus: "required",
  bootstrapInstallation: "required",
  getInstallation: "none",
  listProviders: "none",
  createNamespace: "required",
  listNamespaces: "none",
  getNamespace: "none",
  deleteNamespace: "none",
  createConfiguration: "required",
  getConfiguration: "none",
  updateConfiguration: "required",
  deleteConfiguration: "none",
  createSecret: "required",
  getSecret: "none",
  updateSecret: "required",
  deleteSecret: "none",
  createServiceAccount: "required",
  listServiceAccounts: "none",
  getServiceAccount: "none",
  createServiceAccountCredential: "required",
  updateServiceAccountCredential: "required",
  deleteServiceAccount: "none",
  createAgent: "required",
  updateAgent: "required",
  listAgents: "none",
  getAgent: "none",
  deployAgent: "required",
  getAgentWorkspaceFile: "none",
  putAgentWorkspaceFile: "required",
  listAgentRevisions: "none",
  getAgentRevision: "none",
  getAgentLifecycleStatus: "none",
  listAgentLifecycleOperations: "none",
  getAgentLifecycleOperation: "none",
  getAgentLifecycleCapability: "none",
} satisfies {
  [Operation in OccApiRoute as Operation["operationId"]]: "body" extends keyof Operation["schema"]
    ? "required"
    : "none";
};

/** Fail at composition time if the catalog and concrete handlers disagree. */
export function createOperationRegistry<const Operations extends readonly OccApiRoute[]>(
  operations: Operations,
  handlers: OperationHandlers<Operations>,
): readonly RegisteredOperation<Operations[number]>[] {
  const ids = new Set<string>();
  const routes = new Set<string>();
  const registry: RegisteredOperation<Operations[number]>[] = [];
  for (const operation of operations) {
    const route = `${operation.method} ${operation.path}`;
    if (ids.has(operation.operationId) || routes.has(route))
      throw new Error("HTTP operation IDs and method/path registrations must be unique.");
    ids.add(operation.operationId);
    routes.add(route);
    const handler = (handlers as Readonly<Record<string, unknown>>)[operation.operationId];
    if (typeof handler !== "function")
      throw new Error(`Missing HTTP handler for ${operation.operationId}.`);
    const permissions = requiredPermissions(operation);
    if (
      !operation.summary ||
      !operation.tags.length ||
      !operation.action ||
      !operation.iamAction ||
      !operation.resourceKind ||
      permissions.length === 0 ||
      permissions.some(
        (permission) => !permission.action || !permission.resourceKind || !permission.scope,
      )
    )
      throw new Error(
        `Missing HTTP permission or documentation metadata for ${operation.operationId}.`,
      );
    const pathParameters = [...operation.path.matchAll(/:([^/]+)/g)].map((match) => match[1]!);
    const params =
      operation.schema && "params" in operation.schema ? operation.schema.params : undefined;
    if (
      !operation.schema ||
      !Object.hasOwn(operation.schema, "querystring") ||
      !Object.hasOwn(operation.schema, "response") ||
      pathParameters.some(
        (name) =>
          !params ||
          !Object.hasOwn(params.properties, name) ||
          !params.required?.some((required) => required === name),
      ) ||
      Object.hasOwn(operation.schema, "body") !==
        (operationBodyExpectations[operation.operationId] === "required") ||
      !Object.keys(operation.schema.response).some((status) => /^2\d\d$/.test(status))
    )
      throw new Error(`Missing HTTP request or response schema for ${operation.operationId}.`);
    registry.push(
      Object.freeze({
        operation,
        // The exact catalog key selects its typed handler; the closure retains
        // that operation rather than accepting a later replacement from a caller.
        handler: async (request: FastifyRequest, reply: FastifyReply) => {
          await handler(request, reply, operation);
        },
        schema: {
          ...operation.schema,
          operationId: operation.operationId,
          summary: operation.summary,
          description: permissionDescription(permissions, operation),
          tags: [...operation.tags],
          "x-openclaw-permissions": permissions,
        } as DocumentedFastifySchema,
      }),
    );
  }
  if (Object.keys(handlers).some((id) => !ids.has(id)))
    throw new Error("HTTP handlers must match the operation catalog exactly.");
  return Object.freeze(registry);
}
