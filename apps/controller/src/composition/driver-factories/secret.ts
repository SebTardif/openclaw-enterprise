import type { SecretDriver } from "@openclaw-enterprise/contracts";
import {
  KubernetesSecretDriver,
  type KubernetesSecretDriverOptions,
} from "../../drivers/secret/kubernetes/index.ts";
import {
  selected,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

export function selectSecretDriver(selection: ConfigurationRecord): SelectedDriverConfiguration {
  return selected(selection, "secret", "occ/kubernetes-secret", KubernetesSecretDriver);
}

export function createSecretDriver(selection: SelectedDriverConfiguration): SecretDriver {
  return new KubernetesSecretDriver(
    selection.configuration as unknown as KubernetesSecretDriverOptions,
    { id: selection.id, implementation: selection.implementation },
  );
}
