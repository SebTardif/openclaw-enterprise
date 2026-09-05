import type {
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts/resources/service-account";

export interface ServiceAccountReadRepository {
  findServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  listServiceAccounts(namespaceId: string): Promise<readonly Readonly<ServiceAccount>[]>;
  findServiceAccountProviderBinding(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<
    | Readonly<{
        readonly providerId: string;
        readonly driverId: string;
        readonly workspaceId: string;
        readonly credentialIssued: boolean;
      }>
    | undefined
  >;
}

export interface ServiceAccountRepository extends ServiceAccountReadRepository {
  createServiceAccount(account: ServiceAccount): Promise<Readonly<ServiceAccount>>;
  lockServiceAccount(
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  updateCredential(
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount> | undefined>;
  deleteServiceAccount(namespaceId: string, serviceAccountId: string): Promise<boolean>;
}
