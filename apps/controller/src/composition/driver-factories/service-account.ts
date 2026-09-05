import type { ProviderDefinition, ProviderSummary } from "@openclaw-enterprise/contracts";
import {
  validateProviderDefinitions,
  type OpenClawController,
  type PostgresPlatformState,
} from "@openclaw-enterprise/occ";
import {
  object,
  closed,
  nonempty,
  type InstallationStartupConfiguration,
} from "../startup-config/schema.ts";

export type ServiceAccountDriverFactory = (
  controller: OpenClawController,
  state: PostgresPlatformState,
) => void;

export function selectedServiceAccountConfiguration(
  value: unknown,
): InstallationStartupConfiguration["drivers"]["service_account"] {
  let serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"];
  if (value !== undefined) {
    const selection = object(value, "drivers.service_account");
    closed(selection, ["id", "configuration"], "drivers.service_account");
    const driverConfiguration = object(
      selection.configuration,
      "drivers.service_account.configuration",
    );
    closed(driverConfiguration, [], "drivers.service_account.configuration");
    serviceAccount = Object.freeze({ id: nonempty(selection.id, "drivers.service_account.id") });
  }
  return serviceAccount;
}

export function providerConfiguration(
  value: unknown,
  serviceAccount: InstallationStartupConfiguration["drivers"]["service_account"],
): readonly ProviderDefinition[] {
  const providers = validateProviderDefinitions(value ?? []);
  if (serviceAccount !== undefined && providers.length === 0) {
    throw new Error("drivers.service_account requires an owning provider entry with type chatgpt.");
  }
  for (const provider of providers) {
    if (serviceAccount === undefined) {
      throw new Error(
        `provider[${provider.id}].drivers.service_account requires drivers.service_account.`,
      );
    }
    if (provider.drivers.service_account !== serviceAccount.id) {
      throw new Error(
        `provider[${provider.id}].drivers.service_account must match the selected drivers.service_account.id.`,
      );
    }
  }
  return providers;
}

export function providerSummariesFromDefinitions(
  providers: readonly ProviderDefinition[],
): readonly ProviderSummary[] {
  return Object.freeze(
    providers.map((provider) =>
      Object.freeze({
        id: provider.id,
        type: provider.type,
      }),
    ),
  );
}
