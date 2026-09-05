import type { DriverCapability } from "./base.ts";

export type ProviderType = "chatgpt";

export type ProviderRef = string | null;

export interface ProviderConfiguration {
  readonly workspaceId: string;
  readonly apiKeyPath: string;
  readonly credentialTtlSeconds?: number;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly type: ProviderType;
  readonly configuration: ProviderConfiguration;
  readonly drivers: Readonly<Record<"service_account", string>>;
}

export interface ProviderSummary {
  readonly id: string;
  readonly type: ProviderType;
}

export interface Provider<Client = unknown> {
  readonly id: string;
  readonly client: Client;
  readonly drivers: Readonly<Partial<Record<DriverCapability, string>>>;
}
