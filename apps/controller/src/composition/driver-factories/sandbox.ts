import type { DriverImplementation, SandboxDriver } from "@openclaw-enterprise/contracts";
import { createExternalDriver, type LoadedDriverPackage } from "../driver-packages/loader.ts";
import {
  object,
  selected,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

export interface BundledOpenShellSandboxDriverModule extends DriverImplementation {
  readonly OpenShellSandboxDriver: new (
    configuration: ConfigurationRecord,
    selection: { readonly id: string; readonly implementation: string },
  ) => SandboxDriver;
}

export async function loadBundledOpenShellSandboxDriver(): Promise<BundledOpenShellSandboxDriverModule> {
  const modulePath = "../../drivers/sandbox/openshell.ts";
  let imported: unknown;
  try {
    imported = await import(modulePath);
  } catch {
    throw new Error("drivers.sandbox selects unavailable bundled OpenShell Sandbox Driver.");
  }
  const module = object(imported, "drivers.sandbox bundled OpenShell exports");
  if (
    typeof module.OpenShellSandboxDriver !== "function" ||
    typeof module.validateConfiguration !== "function" ||
    typeof module.configurationSchema !== "object" ||
    module.configurationSchema === null
  ) {
    throw new Error("drivers.sandbox bundled OpenShell module is not a valid Driver package.");
  }
  return module as unknown as BundledOpenShellSandboxDriverModule;
}

function validateCreatedSandboxDriver(
  driver: SandboxDriver,
  selection: SelectedDriverConfiguration,
): SandboxDriver {
  const created = object(driver, "drivers.sandbox factory result");
  if (
    created.capability !== "sandbox" ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation ||
    !Array.isArray(created.facets) ||
    created.facets.length === 0 ||
    (created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
    (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function") ||
    typeof created.cleanup !== "function"
  ) {
    throw new Error("drivers.sandbox factory returned an invalid Driver contract.");
  }
  return driver;
}

export function selectSandboxDriver(
  selection: ConfigurationRecord,
  bundledPackage: BundledOpenShellSandboxDriverModule | undefined,
  driverPackage?: LoadedDriverPackage,
): SelectedDriverConfiguration {
  return selected(
    selection,
    "sandbox",
    driverPackage?.implementation ?? "openshell",
    driverPackage?.module ?? bundledPackage!,
  );
}

export function createSandboxDriver(
  selection: SelectedDriverConfiguration,
  bundledPackage: BundledOpenShellSandboxDriverModule | undefined,
  driverPackage?: LoadedDriverPackage,
  factory?: (selection: SelectedDriverConfiguration) => SandboxDriver,
): SandboxDriver {
  if (factory !== undefined) return validateCreatedSandboxDriver(factory(selection), selection);
  if (driverPackage !== undefined)
    return createExternalDriver(driverPackage.module, selection, "sandbox") as SandboxDriver;
  return new bundledPackage!.OpenShellSandboxDriver(selection.configuration, {
    id: selection.id,
    implementation: selection.implementation,
  });
}
