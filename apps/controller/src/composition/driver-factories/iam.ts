import type { IAMDriver } from "@openclaw-enterprise/contracts";
import { NativeIAMDriver, type NativeIAMStateStore } from "@openclaw-enterprise/iam";
import { createExternalDriver, type LoadedDriverPackage } from "../driver-packages/loader.ts";
import {
  selected,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

export function selectIAMDriver(
  selection: ConfigurationRecord,
  driverPackage?: LoadedDriverPackage,
): SelectedDriverConfiguration {
  return selected(
    selection,
    "iam",
    driverPackage?.implementation ?? "occ/native-iam",
    driverPackage?.module ?? NativeIAMDriver,
  );
}

export function createIAMDriverFactory(
  selection: SelectedDriverConfiguration,
  driverPackage?: LoadedDriverPackage,
): (state: NativeIAMStateStore) => IAMDriver {
  return (state) =>
    driverPackage === undefined
      ? new NativeIAMDriver(state, { id: selection.id, implementation: selection.implementation })
      : (createExternalDriver(driverPackage.module, selection, "iam", state) as IAMDriver);
}
