import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type {
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts/resources/service-account";
import type { ServiceAccountDriver } from "@openclaw-enterprise/contracts/drivers/service-account";
import type { ServiceAccountReadRepository } from "../../ports/repositories/service-account.ts";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { MutationRepositoryOperations } from "../../application/mutation-context.ts";

/** Only repositories and methods needed by ServiceAccount commands and queries. */
export const SERVICE_ACCOUNT_REPOSITORIES = {
  read: {
    namespaces: ["findNamespace"],
    serviceAccounts: ["findServiceAccount", "listServiceAccounts"],
  },
  mutate: {
    namespaces: ["findNamespace"],
    serviceAccounts: [
      "createServiceAccount",
      "lockServiceAccount",
      "updateCredential",
      "deleteServiceAccount",
    ],
    agents: ["listAgents"],
  },
} as const;

export type ServiceAccountRepositories = MutationRepositoryOperations<
  typeof SERVICE_ACCOUNT_REPOSITORIES.read,
  typeof SERVICE_ACCOUNT_REPOSITORIES.mutate
>;

export interface CreateServiceAccountInput {
  readonly namespaceId: string;
  readonly name: string;
}

export interface ServiceAccountCommands {
  createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>>;
  createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>>;
  updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>>;
  deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<void>;
}

export interface ServiceAccountQueries {
  getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>>;
  listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]>;
}

export interface ServiceAccountServicePort extends ServiceAccountCommands, ServiceAccountQueries {}

export interface ServiceAccountServiceOptions {
  readonly repositories: ServiceAccountRepositories;
  readonly authorization: Pick<ExactAuthorization, "authorize" | "canRead">;
  readonly exactServiceAccount: (
    state: { readonly serviceAccounts: Pick<ServiceAccountReadRepository, "findServiceAccount"> },
    namespaceId: string,
    serviceAccountId: string,
  ) => Promise<Readonly<ServiceAccount>>;
  readonly driverOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly serviceAccountDriver: () => ServiceAccountDriver | undefined;
  readonly getNamespace: (principalId: string, namespaceId: string) => Promise<Readonly<Namespace>>;
  readonly createId: () => string;
}
