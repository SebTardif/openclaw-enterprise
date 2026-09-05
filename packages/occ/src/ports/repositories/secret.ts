import type { Secret } from "@openclaw-enterprise/contracts/resources/secret";

export interface SecretReadRepository {
  findSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
}

export interface SecretRepository extends SecretReadRepository {
  lockSecret(namespaceId: string, secretId: string): Promise<Readonly<Secret> | undefined>;
  createSecret(secret: Secret): Promise<Readonly<Secret>>;
  deleteSecret(namespaceId: string, secretId: string): Promise<boolean>;
  hasReferences(namespaceId: string, secretId: string): Promise<boolean>;
}
