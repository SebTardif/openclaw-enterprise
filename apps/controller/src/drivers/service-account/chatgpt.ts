import type {
  ServiceAccount,
  ServiceAccountCredential,
  ServiceAccountDriver,
} from "@openclaw-enterprise/contracts";
import { ResourceConflictError, ScopeViolationError } from "@openclaw-enterprise/occ";
import type { Provider } from "@openclaw-enterprise/contracts";
import type {
  ProviderAccountLink,
  ProviderAccountLinkKey,
  ProviderAccountLinksAccess,
  ProviderAccountLinkCompensation,
} from "@openclaw-enterprise/occ/ports/provider-account-links";
import type { ChatGPTClient } from "../../providers/chatgpt.ts";

type SecretReference = ServiceAccountCredential["secretRef"];

interface CredentialStorage {
  storeServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly accessToken: string;
    readonly workspaceId: string;
  }): Promise<SecretReference>;
  deleteServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly secretRef: SecretReference;
  }): Promise<void>;
}

interface ServiceAccountDriverDependencies extends ProviderAccountLinkCompensation {
  readonly providerAccountLinks: ProviderAccountLinksAccess;
}

export class ChatGPTServiceAccountDriver implements ServiceAccountDriver {
  readonly capability = "service_account" as const;
  readonly implementation = "chatgpt";
  readonly id: string;
  private readonly providerId: string;
  private readonly client: ChatGPTClient;
  private readonly dependencies: ServiceAccountDriverDependencies;
  private readonly compute: CredentialStorage;

  constructor(
    provider: Provider<ChatGPTClient>,
    dependencies: ServiceAccountDriverDependencies,
    compute: CredentialStorage,
  ) {
    const id = provider.drivers.service_account;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("The ChatGPT Provider must declare its ServiceAccount Driver.");
    }
    this.client = provider.client;
    this.dependencies = dependencies;
    this.compute = compute;
    this.providerId = provider.id;
    this.id = id;
  }

  async create(account: ServiceAccount): Promise<void> {
    const suffix = `-${account.id}`;
    const external = await this.client.createServiceAccount({
      name: `${account.name.slice(0, 200 - suffix.length)}${suffix}`,
    });
    this.dependencies.registerRollback(() => this.client.deleteServiceAccount(external.id));
    await this.dependencies.providerAccountLinks.run((links) =>
      links.create(this.linkKey(account), external.id),
    );
  }

  async createCredential(account: ServiceAccount): Promise<ServiceAccountCredential> {
    const linked = await this.findBinding(account);
    if (linked === undefined) {
      throw new ScopeViolationError("The service account has no exact provider binding.");
    }
    if (linked.externalCredentialId !== null || account.credential !== undefined) {
      throw new ResourceConflictError("The service account already has a credential.");
    }

    const credential = await this.client.createCredential({
      accountId: linked.externalAccountId,
      name: `occ-${account.id}`,
    });
    this.dependencies.registerRollback(() =>
      this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: credential.id,
      }),
    );

    const secretRef = await this.compute.storeServiceAccountCredential({
      namespaceId: account.namespaceId,
      serviceAccountId: account.id,
      accessToken: credential.accessToken,
      workspaceId: linked.workspaceId,
    });
    this.dependencies.registerRollback(() =>
      this.compute.deleteServiceAccountCredential({
        namespaceId: account.namespaceId,
        serviceAccountId: account.id,
        secretRef,
      }),
    );

    await this.dependencies.providerAccountLinks.run((links) =>
      links.recordCredential(this.linkKey(account), credential.id),
    );
    return { kind: "access_token", secretRef };
  }

  async delete(account: ServiceAccount): Promise<void> {
    const linked = await this.findBinding(account);
    if (linked === undefined) return;
    if (linked.externalCredentialId !== null) {
      if (account.credential?.kind !== "access_token") {
        throw new ScopeViolationError("The exact service-account credential is missing.");
      }
      await this.client.deleteCredential({
        accountId: linked.externalAccountId,
        credentialId: linked.externalCredentialId,
      });
      await this.compute.deleteServiceAccountCredential({
        namespaceId: account.namespaceId,
        serviceAccountId: account.id,
        secretRef: account.credential.secretRef,
      });
    }
    await this.client.deleteServiceAccount(linked.externalAccountId);
  }

  private async findBinding(
    account: ServiceAccount,
  ): Promise<Readonly<ProviderAccountLink> | undefined> {
    return this.dependencies.providerAccountLinks.run((links) => links.find(this.linkKey(account)));
  }

  private linkKey(account: ServiceAccount): ProviderAccountLinkKey {
    return {
      namespaceId: account.namespaceId,
      serviceAccountId: account.id,
      providerId: this.providerId,
      driverId: this.id,
      workspaceId: this.client.workspaceId,
    };
  }
}

export function createChatGPTServiceAccountDriverFactory(
  provider: Provider<ChatGPTClient>,
  compute: CredentialStorage,
) {
  return (dependencies: ServiceAccountDriverDependencies): ServiceAccountDriver =>
    new ChatGPTServiceAccountDriver(provider, dependencies, compute);
}
