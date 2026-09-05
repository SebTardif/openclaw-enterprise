import type { SecretMetadata } from "@openclaw-enterprise/contracts/resources/secret";
import type { SecretDriver } from "@openclaw-enterprise/contracts/drivers/secret";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { MutationRepositoryOperations } from "../../application/mutation-context.ts";

/** Only repositories and methods needed by Secret commands and queries. */
export const SECRET_REPOSITORIES = {
  read: {
    namespaces: ["findNamespace"],
    secrets: ["findSecret"],
  },
  mutate: {
    namespaces: ["lockNamespace"],
    secrets: ["createSecret", "lockSecret", "deleteSecret", "hasReferences"],
  },
} as const;

export type SecretRepositories = MutationRepositoryOperations<
  typeof SECRET_REPOSITORIES.read,
  typeof SECRET_REPOSITORIES.mutate
>;

export interface CreateSecretInput {
  readonly namespaceId: string;
  readonly name: string;
  readonly value: string;
}

export interface UpdateSecretInput {
  readonly namespaceId: string;
  readonly secretId: string;
  readonly value: string;
}

export interface SecretCommands {
  createSecret(principalId: string, input: CreateSecretInput): Promise<Readonly<SecretMetadata>>;
  updateSecret(principalId: string, input: UpdateSecretInput): Promise<Readonly<SecretMetadata>>;
  deleteSecret(principalId: string, namespaceId: string, secretId: string): Promise<void>;
}

export interface SecretQueries {
  readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretMetadata>>;
}

export interface SecretServicePort extends SecretCommands, SecretQueries {}

export interface SecretServiceOptions {
  readonly repositories: SecretRepositories;
  readonly authorization: Pick<ExactAuthorization, "authorize">;
  readonly secretOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly secretDriver: (expectedId?: string) => SecretDriver;
  readonly createId: () => string;
  readonly now: () => string;
}
