import { isDriverCapability } from "@openclaw-enterprise/contracts/drivers/base";
import type { Driver, DriverCapability } from "@openclaw-enterprise/contracts/drivers/base";
import type {
  ComputeDriver,
  ComputeLifecycleHooks,
} from "@openclaw-enterprise/contracts/drivers/compute";
import type { ConfigurationDriver } from "@openclaw-enterprise/contracts/drivers/configuration";
import type { IAMDriver } from "@openclaw-enterprise/contracts/drivers/iam";
import type { ProviderDefinition } from "@openclaw-enterprise/contracts/drivers/provider";
import {
  SANDBOX_FACETS,
  type SandboxDriver,
  type SandboxFacet,
} from "@openclaw-enterprise/contracts/drivers/sandbox";
import type { SecretDriver } from "@openclaw-enterprise/contracts/drivers/secret";
import type { ServiceAccountDriver } from "@openclaw-enterprise/contracts/drivers/service-account";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, DriverSelectionError } from "../errors.ts";
import { validateSelectedProviderDrivers } from "../providers.ts";

interface RegisteredDriver {
  readonly driver: Driver;
  readonly capability: DriverCapability;
  readonly id: string;
  readonly implementation: string;
}

type DriverByCapability = {
  iam: IAMDriver;
  configuration: ConfigurationDriver;
  service_account: ServiceAccountDriver;
  secret: SecretDriver;
  sandbox: SandboxDriver;
  compute: ComputeDriver;
};
export type DriverFor<Capability extends DriverCapability> = DriverByCapability[Capability];

/** A consumer receives only its required selected capability. */
export type SelectedDriver<Capability extends DriverCapability> = () => DriverFor<Capability>;

const COMPUTE_LIFECYCLE_PHASES = [
  "afterNamespacePrepared",
  "beforeWorkloadStart",
  "beforeWorkloadStop",
  "beforeNamespaceDelete",
] as const satisfies readonly (keyof ComputeLifecycleHooks)[];

function driverHasCapabilityContract(driver: Driver): boolean {
  const candidate = driver as unknown as Record<string, unknown>;
  if (driver.capability === "iam")
    return (
      typeof candidate.lookupIdentity === "function" && typeof candidate.authorize === "function"
    );
  if (driver.capability === "configuration")
    return ["create", "read", "update", "delete", "validate"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "secret")
    return ["create", "update", "delete", "resolve"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "service_account")
    return ["create", "createCredential", "delete"].every(
      (operation) => typeof candidate[operation] === "function",
    );
  if (driver.capability === "sandbox")
    return (
      sandboxFacets(candidate.facets) &&
      (candidate.configureAgent === undefined || typeof candidate.configureAgent === "function") &&
      (candidate.ensureNamespace === undefined ||
        typeof candidate.ensureNamespace === "function") &&
      (candidate.provisionHarness === undefined ||
        typeof candidate.provisionHarness === "function") &&
      typeof candidate.cleanup === "function"
    );
  return (
    typeof candidate.ensureNamespace === "function" &&
    typeof candidate.deleteNamespace === "function" &&
    typeof candidate.prepareRevision === "function" &&
    typeof candidate.retireRevision === "function"
  );
}

function sandboxFacets(value: unknown): value is readonly SandboxFacet[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  const allowed = new Set<string>(SANDBOX_FACETS);
  for (const facet of value) {
    if (typeof facet !== "string" || !allowed.has(facet) || seen.has(facet)) return false;
    seen.add(facet);
  }
  return true;
}

function driverHasValidLifecycleHooks(driver: Driver): boolean {
  const hooks: unknown = driver.computeLifecycleHooks;
  if (hooks === undefined) return true;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;

  const candidate = hooks as Record<string, unknown>;
  const phases: readonly string[] = COMPUTE_LIFECYCLE_PHASES;
  const keys = Object.keys(candidate);
  return (
    keys.length > 0 &&
    keys.every((key) => phases.includes(key) && typeof candidate[key] === "function")
  );
}

/** Registration and selection belong to startup composition, not resource consumers. */
export class DriverSelection {
  private readonly registry = new Map<string, RegisteredDriver>();
  private readonly selections = new Map<DriverCapability, RegisteredDriver>();

  registerDriver(driver: Driver): Driver {
    if (
      !driver ||
      !isNonEmptyString(driver.id) ||
      !isNonEmptyString(driver.implementation) ||
      !isDriverCapability(driver.capability) ||
      !driverHasCapabilityContract(driver) ||
      !driverHasValidLifecycleHooks(driver)
    )
      throw new DriverSelectionError("The Driver does not satisfy its exact capability contract.");
    const key = this.driverKey(driver.capability, driver.id);
    if (this.registry.has(key))
      throw new DriverSelectionError(
        "A Driver is already registered for this exact capability and identity.",
      );
    this.registry.set(
      key,
      Object.freeze({
        driver,
        capability: driver.capability,
        id: driver.id,
        implementation: driver.implementation,
      }),
    );
    return driver;
  }

  selectDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
    driverId: string,
  ): DriverFor<Capability> {
    if (!isDriverCapability(selectedCapability) || !isNonEmptyString(driverId))
      throw new DriverSelectionError(
        "The Driver capability or implementation identity is invalid.",
      );
    const selected = this.registry.get(this.driverKey(selectedCapability, driverId));
    if (!selected || !this.unchangedDriver(selected))
      throw new DriverSelectionError(
        "No registered Driver matches the exact selected capability and identity.",
      );
    return this.applyDriverSelection(selectedCapability, selected);
  }

  selectedDriver<Capability extends DriverCapability>(
    selectedCapability: Capability,
  ): DriverFor<Capability> {
    if (!isDriverCapability(selectedCapability))
      throw new DriverSelectionError("The requested Driver capability is invalid.");
    const selected = this.selections.get(selectedCapability);
    if (!selected || !this.unchangedDriver(selected))
      throw new DriverSelectionError(
        "The selected Driver is unavailable or no longer matches its capability.",
      );
    return selected.driver as DriverFor<Capability>;
  }

  async validateProviderConfiguration(providers: readonly ProviderDefinition[]): Promise<void> {
    validateSelectedProviderDrivers(providers, this.selections.get("service_account")?.driver);
  }

  secretDriver(expectedId?: string): SecretDriver {
    try {
      const driver = this.selectedDriver("secret");
      if (expectedId !== undefined && driver.id !== expectedId)
        throw new Error("Driver identity mismatch.");
      return driver;
    } catch {
      throw new DependencyUnavailableError(
        "The selected Secret Driver is unavailable or does not own this Secret.",
      );
    }
  }

  configurationDriver(): ConfigurationDriver {
    try {
      return this.selectedDriver("configuration");
    } catch {
      throw new DependencyUnavailableError("The selected Configuration Driver is unavailable.");
    }
  }

  serviceAccountDriver(): ServiceAccountDriver | undefined {
    if (!this.selections.has("service_account")) return undefined;
    try {
      return this.selectedDriver("service_account");
    } catch {
      throw new DependencyUnavailableError("The selected ServiceAccount Driver is unavailable.");
    }
  }

  sandboxDriver(): SandboxDriver | undefined {
    if (!this.selections.has("sandbox")) return undefined;
    try {
      return this.selectedDriver("sandbox");
    } catch {
      throw new DependencyUnavailableError("The selected Sandbox Driver is unavailable.");
    }
  }

  private driverKey(selectedCapability: DriverCapability, driverId: string): string {
    return `${selectedCapability}\u0000${driverId}`;
  }

  private applyDriverSelection<Capability extends DriverCapability>(
    selectedCapability: Capability,
    selected: RegisteredDriver,
  ): DriverFor<Capability> {
    const proposed = new Map(this.selections);
    proposed.set(selectedCapability, selected);
    const lifecycleDrivers = this.lifecycleDrivers(proposed);
    const compute = proposed.get("compute");
    if (compute !== undefined) {
      if (!this.unchangedDriver(compute))
        throw new DriverSelectionError("The selected compute Driver identity has changed.");
      const selectedCompute = compute.driver as ComputeDriver;
      if (typeof selectedCompute.setLifecycleDrivers === "function") {
        selectedCompute.setLifecycleDrivers(lifecycleDrivers);
      } else if (lifecycleDrivers.length > 0) {
        throw new DriverSelectionError(
          "The selected compute Driver cannot accept selected lifecycle Drivers.",
        );
      }
    }

    this.selections.set(selectedCapability, selected);
    return selected.driver as DriverFor<Capability>;
  }

  private lifecycleDrivers(
    selections: ReadonlyMap<DriverCapability, RegisteredDriver>,
  ): readonly Driver[] {
    const drivers: Driver[] = [];
    for (const [selectedCapability, selected] of selections) {
      if (selectedCapability === "compute") continue;
      if (!this.unchangedDriver(selected))
        throw new DriverSelectionError(
          "A selected lifecycle Driver no longer matches its registered identity.",
        );
      if (selected.driver.computeLifecycleHooks !== undefined) drivers.push(selected.driver);
    }
    return Object.freeze(drivers);
  }

  private unchangedDriver(selected: RegisteredDriver): boolean {
    return (
      selected.driver.id === selected.id &&
      selected.driver.capability === selected.capability &&
      selected.driver.implementation === selected.implementation &&
      driverHasCapabilityContract(selected.driver)
    );
  }
}
