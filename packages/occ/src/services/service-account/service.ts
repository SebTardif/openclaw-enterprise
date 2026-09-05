import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type {
  ServiceAccount,
  ServiceAccountCredential,
} from "@openclaw-enterprise/contracts/resources/service-account";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import type { NamespaceReadRepository } from "../../ports/repositories/namespace.ts";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type {
  CreateServiceAccountInput,
  ServiceAccountServiceOptions,
  ServiceAccountServicePort,
} from "./port.ts";

/** ServiceAccount policy shares the composition owner's transaction and selected authority. */
export class ServiceAccountService implements ServiceAccountServicePort {
  private readonly options: ServiceAccountServiceOptions;

  constructor(options: ServiceAccountServiceOptions) {
    this.options = options;
  }

  async getServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    await this.options.authorization.authorize(principalId, "read", {
      kind: "service_account",
      id: serviceAccountId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      return this.options.exactServiceAccount(state, namespace.id, serviceAccountId);
    });
  }

  async listServiceAccounts(
    principalId: string,
    namespaceId: string,
  ): Promise<readonly Readonly<ServiceAccount>[]> {
    const namespace = await this.options.getNamespace(principalId, namespaceId);
    return this.options.repositories.read(async (state) => {
      const readable: Readonly<ServiceAccount>[] = [];
      for (const account of await state.serviceAccounts.listServiceAccounts(namespace.id)) {
        if (
          await this.options.authorization.canRead(principalId, {
            kind: "service_account",
            id: account.id,
            namespaceId: namespace.id,
          })
        )
          readable.push(account);
      }
      return Object.freeze(readable);
    });
  }

  async createServiceAccount(
    principalId: string,
    input: CreateServiceAccountInput,
  ): Promise<Readonly<ServiceAccount>> {
    if (!isNonEmptyString(input.name) || input.name.length > 200)
      throw new ScopeViolationError("The ServiceAccount name is invalid.");
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, input.namespaceId);
      if (namespace.status !== "provisioning" && namespace.status !== "ready")
        throw new ResourceConflictError("The Namespace does not accept new ServiceAccounts.");
      await this.options.authorization.authorize(principalId, "create", {
        kind: "service_account",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.createServiceAccount({
        id: this.options.createId(),
        namespaceId: namespace.id,
        name: input.name,
      });
      const driver = this.options.serviceAccountDriver();
      if (driver !== undefined) await this.options.driverOperation(() => driver.create(account));
      return account;
    });
  }

  async createServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      await this.options.authorization.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      if (account.credential !== undefined)
        throw new ResourceConflictError("The ServiceAccount already has a credential.");
      const driver = this.options.serviceAccountDriver();
      if (driver === undefined)
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
      const credential = await this.options.driverOperation(() => driver.createCredential(account));
      if (credential?.kind !== "access_token")
        throw new DependencyUnavailableError(
          "The ServiceAccount Driver returned an unsupported credential.",
        );
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined)
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
      return updated;
    });
  }

  async updateServiceAccountCredential(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
    credential: ServiceAccountCredential,
  ): Promise<Readonly<ServiceAccount>> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      await this.options.authorization.authorize(principalId, "update", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      if (account.credential?.kind === "access_token" || credential.kind === "access_token")
        throw new ResourceConflictError(
          "A managed ServiceAccount credential cannot be manually updated.",
        );
      const updated = await state.serviceAccounts.updateCredential(
        namespace.id,
        account.id,
        credential,
      );
      if (updated === undefined)
        throw new ResourceConflictError("The ServiceAccount credential changed during its update.");
      return updated;
    });
  }

  async deleteServiceAccount(
    principalId: string,
    namespaceId: string,
    serviceAccountId: string,
  ): Promise<void> {
    this.serviceAccountIdentity(namespaceId, serviceAccountId);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.exactNamespace(state, namespaceId);
      await this.options.authorization.authorize(principalId, "delete", {
        kind: "service_account",
        id: serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        serviceAccountId,
      );
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      const agents = await state.agents.listAgents(namespace.id);
      if (agents.some((agent) => agent.serviceAccountId === account.id))
        throw new ResourceConflictError("An Agent still references the exact ServiceAccount.");
      const driver = this.options.serviceAccountDriver();
      if (account.credential?.kind === "access_token" && driver === undefined)
        throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
      if (driver !== undefined) await this.options.driverOperation(() => driver.delete(account));
      if (!(await state.serviceAccounts.deleteServiceAccount(namespace.id, account.id)))
        throw new ResourceConflictError("The ServiceAccount changed during deletion.");
    });
  }

  private serviceAccountIdentity(namespaceId: string, serviceAccountId: string): void {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (!isNonEmptyString(serviceAccountId))
      throw new ScopeViolationError("The exact ServiceAccount identity is missing.");
  }

  private async exactNamespace(
    state: { readonly namespaces: Pick<NamespaceReadRepository, "findNamespace"> },
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.findNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }
}
