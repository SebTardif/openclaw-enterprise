import type {
  KubernetesRendererSource,
  KubernetesWorkloadProfileCapability,
} from "../../drivers/compute/kubernetes/workload-profile-capability.ts";

import { asRecord } from "@openclaw-enterprise/utils";
import type {
  ComputeDriver,
  ConfigurationDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import {
  KubernetesComputeDriver,
  GVISOR_IMPLEMENTATION,
  type KubernetesComputeDriverOptions,
} from "../../drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../drivers/compute/operation-context.ts";
import { createExternalDriver, type LoadedDriverPackage } from "../driver-packages/loader.ts";
import {
  selected,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

const selectedRendererContributions = new WeakMap<
  ComputeDriver,
  KubernetesWorkloadProfileCapability
>();

/** Exact object association from the original factory. External packages and
 * separately constructed lookalikes have no built-in renderer contribution. */
export function selectedComputeWorkloadProfileCapability(
  driver: ComputeDriver,
): KubernetesWorkloadProfileCapability | undefined {
  return selectedRendererContributions.get(driver);
}

export function selectComputeDriver(
  selection: ConfigurationRecord,
  driverPackage?: LoadedDriverPackage,
): SelectedDriverConfiguration {
  return selected(
    selection,
    "compute",
    driverPackage?.implementation ??
      (asRecord(selection.configuration)?.isolationProfile === "gvisor-systrap"
        ? GVISOR_IMPLEMENTATION
        : "occ/kubernetes"),
    driverPackage?.module ?? KubernetesComputeDriver,
  );
}

export function validateProductionComputeConfiguration(
  selection: SelectedDriverConfiguration,
): void {
  const kubernetes = selection.configuration as unknown as KubernetesComputeDriverOptions;
  if (kubernetes.images.requireImmutableDigest !== true) {
    throw new Error("Production Kubernetes workloads require immutable image digests.");
  }
  if (kubernetes.runtime === undefined) {
    throw new Error(
      "Production Kubernetes workloads require the explicitly configured Codex runtime.",
    );
  }
  if (kubernetes.servicePrincipalCredentials.mode !== "projectedServiceAccountToken") {
    throw new Error("Production Codex Agents require projected ServicePrincipal credentials.");
  }
}

export function createComputeDriver(
  selection: SelectedDriverConfiguration,
  configurationDriver: ConfigurationDriver,
  sandboxDriver?: SandboxDriver,
  driverPackage?: LoadedDriverPackage,
  workloadProfileRendererSource?: KubernetesRendererSource,
): ComputeDriver {
  if (driverPackage !== undefined) {
    return createExternalDriver(
      driverPackage.module,
      selection,
      "compute",
      undefined,
      currentComputeAbortSignal,
    ) as ComputeDriver;
  }
  const driver = new KubernetesComputeDriver(
    selection.configuration as unknown as KubernetesComputeDriverOptions,
    {
      id: selection.id,
      implementation: selection.implementation,
      lifecycleDrivers: [configurationDriver],
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      ...(workloadProfileRendererSource === undefined ? {} : { workloadProfileRendererSource }),
    },
  );
  selectedRendererContributions.set(driver, driver.getWorkloadProfileCapability());
  return driver;
}
