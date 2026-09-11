import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import type { WorkloadProfileSourceEnrollmentV2 } from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import {
  createSelectedKubernetesRendererSource,
  type KubernetesInstalledRendererDefinitionOwner,
} from "../../drivers/compute/kubernetes/renderer-source.ts";
import type { KubernetesRendererOwner } from "../../drivers/compute/kubernetes/renderer-owner.ts";
import {
  type KubernetesRendererSource,
  KubernetesWorkloadProfileCapability,
} from "../../drivers/compute/kubernetes/workload-profile-capability.ts";
import type {
  KubernetesCreateCorrelationObservationOwnerV1,
  KubernetesNodeNetworkConfiguration,
  KubernetesRuntimeObservationAdmission,
  KubernetesRuntimeObservationDependencies,
} from "../../drivers/compute/kubernetes/runtime-observations.ts";

import { asRecord } from "@openclaw-enterprise/utils";
import type {
  ComputeDriver,
  ConfigurationDriver,
  SandboxDriver,
  RuntimeEffectsV1,
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

const selectedComputeContributions = new WeakMap<
  ComputeDriver,
  {
    readonly renderer: KubernetesWorkloadProfileCapability;
    readonly bindRendererSource: (source: KubernetesRendererSource) => void;
    readonly observations: Pick<RuntimeEffectsV1, "discover" | "observe">;
    readonly bindAdmission: (admission: KubernetesRuntimeObservationAdmission) => () => void;
    readonly createCorrelationObservationOwner: (
      selection: DriverSelection,
    ) => KubernetesCreateCorrelationObservationOwnerV1;
  }
>();

const selectedRendererOwners = new WeakMap<ComputeDriver, KubernetesRendererOwner>();

/** Only this factory's original Driver owns the captured installed constructors. */
export function selectedComputeRendererOwner(
  driver: ComputeDriver,
): KubernetesRendererOwner | undefined {
  return selectedRendererOwners.get(driver);
}

/** Exact object association from the original factory. External packages and
 * separately constructed lookalikes have no built-in renderer contribution. */
export function selectedComputeWorkloadProfileCapability(
  driver: ComputeDriver,
): KubernetesWorkloadProfileCapability | undefined {
  return selectedComputeContributions.get(driver)?.renderer;
}

/** Reuses the exact observer created by this factory. A second Driver or an
 * external package cannot acquire the bundled native observation listener. */
export function connectSelectedComputeRuntimeObservations(
  driver: ComputeDriver,
  admission: KubernetesRuntimeObservationAdmission,
) {
  const selected = selectedComputeContributions.get(driver);
  if (!selected || driver.implementation !== GVISOR_IMPLEMENTATION)
    throw new Error("The selected Compute has no bundled gVisor runtime observer.");
  const close = selected.bindAdmission(admission);
  return Object.freeze({ effects: selected.observations, close });
}

/** Original native construction captures this same factory-owned physical reader.
 * The held Driver selection supplies no native read-purpose or writer custody. */
export function createSelectedComputeCorrelationObservationOwner(
  driver: ComputeDriver,
  selection: DriverSelection,
): KubernetesCreateCorrelationObservationOwnerV1 {
  const contribution = selectedComputeContributions.get(driver);
  if (!contribution || driver.implementation !== GVISOR_IMPLEMENTATION)
    throw new Error("The selected Compute has no bundled gVisor runtime observer.");
  return contribution.createCorrelationObservationOwner(selection);
}

/** Bind source receiving to this factory's actual constructor and selected
 * Driver. External packages and copied instances do not enroll by shape. */
export function composeSelectedComputeRendererContribution(
  driver: ComputeDriver,
  selection: DriverSelection,
  units: WorkloadProfileSourceEnrollmentV2,
  installed?: KubernetesInstalledRendererDefinitionOwner,
): KubernetesWorkloadProfileCapability | undefined {
  const owner = selectedRendererOwners.get(driver);
  const contribution = selectedComputeContributions.get(driver);
  if (!owner || !contribution) return undefined;
  const source = createSelectedKubernetesRendererSource(driver, owner, selection, units, installed);
  contribution.bindRendererSource(source);
  return contribution.renderer;
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
  runtimeObservationDependencies?: KubernetesRuntimeObservationDependencies,
  nodeNetworkObservation?: KubernetesNodeNetworkConfiguration,
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
  // The original capability captures this receiver at construction. Only this
  // factory retains its one-time binder; composition cannot replace a Driver's
  // capability or rebind its trusted source after admission has begun.
  let rendererSource: KubernetesRendererSource | undefined;
  const bindRendererSource = (source: KubernetesRendererSource): void => {
    if (rendererSource !== undefined) throw new WorkloadProfileSelectionError("unavailable");
    const acquireDefinition = source.acquireDefinition.bind(source);
    const acquireRevision = source.acquireRevision.bind(source);
    const preparedRevisionMethod = source.acquirePreparedRevision;
    const acquirePreparedRevision =
      typeof preparedRevisionMethod === "function"
        ? preparedRevisionMethod.bind(source)
        : undefined;
    rendererSource = Object.freeze({
      acquireDefinition,
      acquireRevision,
      ...(acquirePreparedRevision === undefined ? {} : { acquirePreparedRevision }),
    });
  };
  if (workloadProfileRendererSource !== undefined)
    bindRendererSource(workloadProfileRendererSource);
  const sourceReceiver: KubernetesRendererSource = Object.freeze({
    acquireDefinition(...args: Parameters<KubernetesRendererSource["acquireDefinition"]>) {
      if (!rendererSource) throw new WorkloadProfileSelectionError("unavailable");
      return rendererSource.acquireDefinition(...args);
    },
    acquireRevision(...args: Parameters<KubernetesRendererSource["acquireRevision"]>) {
      if (!rendererSource) throw new WorkloadProfileSelectionError("unavailable");
      return rendererSource.acquireRevision(...args);
    },
    acquirePreparedRevision(
      ...args: Parameters<NonNullable<KubernetesRendererSource["acquirePreparedRevision"]>>
    ) {
      const acquire = rendererSource?.acquirePreparedRevision;
      if (!acquire) throw new WorkloadProfileSelectionError("unavailable");
      return acquire(...args);
    },
  });
  const driver = new KubernetesComputeDriver(
    selection.configuration as unknown as KubernetesComputeDriverOptions,
    {
      id: selection.id,
      implementation: selection.implementation,
      lifecycleDrivers: [configurationDriver],
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      workloadProfileRendererSource: sourceReceiver,
      ...(runtimeObservationDependencies === undefined ? {} : { runtimeObservationDependencies }),
      ...(nodeNetworkObservation === undefined ? {} : { nodeNetworkObservation }),
    },
  );
  selectedComputeContributions.set(driver, {
    renderer: driver.getWorkloadProfileCapability(),
    bindRendererSource,
    observations: Object.freeze({
      discover: driver.discover.bind(driver),
      observe: driver.observe.bind(driver),
    }),
    bindAdmission: driver.bindRuntimeObservationAdmission.bind(driver),
    createCorrelationObservationOwner: driver.createCorrelationObservationOwner.bind(driver),
  });
  selectedRendererOwners.set(driver, driver.getRendererOwner());
  return driver;
}
