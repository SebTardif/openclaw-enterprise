import type {
  Configuration,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts/resources/configuration";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { ExactAuthorization } from "../../application/authorization.ts";
import type { SelectedDriver } from "../../application/driver-selection.ts";
import type { MutationRepositoryOperations } from "../../application/mutation-context.ts";

/** Only repositories and methods needed by Configuration commands and queries. */
export const CONFIGURATION_REPOSITORIES = {
  read: {
    namespaces: ["findNamespace"],
    configurations: ["findConfiguration"],
  },
  mutate: {
    namespaces: ["lockNamespace"],
    configurations: [
      "createConfiguration",
      "lockConfiguration",
      "advanceConfigurationGeneration",
      "deleteConfiguration",
    ],
    secrets: ["lockSecret"],
    agents: ["listAgents"],
  },
} as const;

export type ConfigurationRepositories = MutationRepositoryOperations<
  typeof CONFIGURATION_REPOSITORIES.read,
  typeof CONFIGURATION_REPOSITORIES.mutate
>;

export interface CreateConfigurationInput {
  readonly namespaceId: string;
  readonly kind: Configuration["kind"];
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
}

export interface UpdateConfigurationInput {
  readonly namespaceId: string;
  readonly configurationId: string;
  readonly values: Readonly<OpenClawConfigurationDocument>;
  readonly secretBindings?: SecretBindings;
  /** Reject a replacement when another writer has advanced the Configuration. */
  readonly expectedGeneration?: number;
}

export interface ConfigurationCommands {
  createConfiguration(
    principalId: string,
    input: CreateConfigurationInput,
  ): Promise<Readonly<Configuration>>;
  updateConfiguration(
    principalId: string,
    input: UpdateConfigurationInput,
  ): Promise<Readonly<Configuration>>;
  deleteConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<void>;
}

export interface ConfigurationQueries {
  getConfiguration(
    principalId: string,
    namespaceId: string,
    configurationId: string,
  ): Promise<Readonly<Configuration>>;
}

export interface ConfigurationServicePort extends ConfigurationCommands, ConfigurationQueries {}

export interface ConfigurationServiceOptions {
  readonly repositories: ConfigurationRepositories;
  readonly authorization: Pick<ExactAuthorization, "authorize">;
  readonly configurationDriver: SelectedDriver<"configuration">;
  readonly assertSecretDriverOwner: (expectedId: string) => void;
  readonly createId: () => string;
  readonly now: () => string;
}
