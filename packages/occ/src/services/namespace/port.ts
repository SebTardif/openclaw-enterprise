import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { SelectedDriver } from "../../application/driver-selection.ts";
import type {
  MutationRepositoryOperations,
  SelectedRepositories,
} from "../../application/mutation-context.ts";
import type { PlatformUnitOfWork } from "../../ports/platform-unit-of-work.ts";

/** Namespace policy uses the same unit as resource changes, work and audit. */
export const NAMESPACE_REPOSITORIES = {
  read: {
    namespaces: ["findNamespace", "listNamespaces"],
  },
  mutate: {
    namespaces: [
      "createNamespace",
      "lockNamespace",
      "hasAgents",
      "hasConfigurations",
      "hasSecrets",
      "hasServiceAccounts",
      "transitionNamespaceStatus",
      "markNamespaceDeleted",
    ],
    operations: ["append"],
    audit: ["append"],
  },
} as const;

export type NamespaceRepositories = MutationRepositoryOperations<
  typeof NAMESPACE_REPOSITORIES.read,
  typeof NAMESPACE_REPOSITORIES.mutate
>;

export type NamespaceMutationState = SelectedRepositories<
  PlatformUnitOfWork,
  typeof NAMESPACE_REPOSITORIES.mutate
>;

export interface CreateNamespaceInput {
  readonly name: string;
  readonly existingNamespace?: string;
}

export interface NamespaceCommands {
  createNamespace(principalId: string, input: CreateNamespaceInput): Promise<Readonly<Namespace>>;
  deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>>;
}

export interface NamespaceQueries {
  listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]>;
  getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>>;
}

/** Existing single-attempt conformance entrypoint; production workers own polling. */
export interface NamespaceLifecycle {
  handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined>;
}

export interface NamespaceServicePort
  extends NamespaceCommands, NamespaceQueries, NamespaceLifecycle {}

export interface NamespaceServiceOptions {
  readonly installationId: string;
  readonly repositories: NamespaceRepositories;
  readonly authorization: Pick<
    ExactAuthorization,
    "authorize" | "canRead" | "authorizationAuthority"
  >;
  readonly computeDriver: SelectedDriver<"compute">;
  readonly iamDriverId: () => string;
  readonly createId: () => string;
  readonly createAuditId: () => string;
  readonly now: () => string;
  readonly recordOperations: boolean;
}
