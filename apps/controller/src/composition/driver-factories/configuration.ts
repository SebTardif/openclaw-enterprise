import type { ConfigurationDriver } from "@openclaw-enterprise/contracts";
import {
  KubernetesConfigurationDriver,
  type KubernetesConfigurationDriverOptions,
} from "../../drivers/configuration/kubernetes/index.ts";
import { createExternalDriver, type LoadedDriverPackage } from "../driver-packages/loader.ts";
import {
  selected,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

export function selectConfigurationDriver(
  selection: ConfigurationRecord,
  driverPackage?: LoadedDriverPackage,
): SelectedDriverConfiguration {
  return selected(
    selection,
    "configuration",
    driverPackage?.implementation ?? "occ/kubernetes-configmap",
    driverPackage?.module ?? KubernetesConfigurationDriver,
  );
}

export function createConfigurationDriver(
  selection: SelectedDriverConfiguration,
  driverPackage?: LoadedDriverPackage,
): ConfigurationDriver {
  return driverPackage === undefined
    ? new KubernetesConfigurationDriver(
        selection.configuration as unknown as KubernetesConfigurationDriverOptions,
        { id: selection.id, implementation: selection.implementation },
      )
    : (createExternalDriver(
        driverPackage.module,
        selection,
        "configuration",
      ) as ConfigurationDriver);
}
