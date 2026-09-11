import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ComputeDriver,
  ConfigurationDriver,
  IAMDriver,
  SandboxDriver,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import type { WorkloadProfileRendererContributionV2 } from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import type { KubernetesRendererSource } from "../drivers/compute/kubernetes/workload-profile-capability.ts";
import type { NativeIAMStateStore } from "@openclaw-enterprise/iam";
import {
  parseInstallationConfiguration,
  runtimeAuthoritySourcesConfiguration,
  selectedDriverConfigurations,
  type InstallationStartupConfiguration,
  type SelectedDriverConfiguration,
  type StartupConfigurationSnapshot,
} from "./startup-config/schema.ts";
import { loadStartupConfigurationSnapshot } from "./startup-config/read.ts";
import { loadDriverPackage } from "./driver-packages/loader.ts";
import {
  createConfigurationDriver,
  selectConfigurationDriver,
} from "./driver-factories/configuration.ts";
import { createIAMDriverFactory, selectIAMDriver } from "./driver-factories/iam.ts";
import {
  createComputeDriver,
  selectedComputeWorkloadProfileCapability,
  selectComputeDriver,
  validateProductionComputeConfiguration,
} from "./driver-factories/compute.ts";
import { createSecretDriver, selectSecretDriver } from "./driver-factories/secret.ts";
import {
  createSandboxDriver,
  loadBundledOpenShellSandboxDriver,
  selectSandboxDriver,
} from "./driver-factories/sandbox.ts";
import {
  providerConfiguration,
  selectedServiceAccountConfiguration,
} from "./driver-factories/service-account.ts";

export type {
  InstallationStartupConfiguration,
  SelectedDriverConfiguration,
  StartupConfigurationSnapshot,
} from "./startup-config/schema.ts";
export {
  loadStartupConfigurationSnapshot,
  loadOperationalLoggingConfiguration,
} from "./startup-config/read.ts";
export {
  providerSummariesFromDefinitions,
  type ServiceAccountDriverFactory,
} from "./driver-factories/service-account.ts";

export interface InstallationRuntimeDrivers {
  readonly installation: InstallationStartupConfiguration;
  readonly computeDriver: ComputeDriver;
  readonly workloadProfileRendererContribution?: WorkloadProfileRendererContributionV2;
  readonly configurationDriver: ConfigurationDriver;
  readonly secretDriver: SecretDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly createIAMDriver: (state: NativeIAMStateStore) => IAMDriver;
}

export async function loadInstallationConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly packageRoot?: string;
  readonly startupConfiguration?: StartupConfigurationSnapshot;
  readonly workloadProfileRendererSource?: KubernetesRendererSource;
  readonly createSandboxDriver?: (selection: SelectedDriverConfiguration) => SandboxDriver;
}): Promise<InstallationRuntimeDrivers | undefined> {
  const environment = options.environment ?? process.env;
  if (environment.OCC_INSTALLATION_ID !== undefined) {
    throw new Error("OCC_INSTALLATION_ID is unsupported; the Installation is a singleton.");
  }
  for (const name of [
    "OCC_COMPUTE_DRIVER",
    "OCC_KUBERNETES_CONFIG_PATH",
    "OCC_NATIVE_IAM_DRIVER_ID",
  ]) {
    if (environment[name] !== undefined) {
      throw new Error(`${name} is unsupported; select Drivers in the Installation startup YAML.`);
    }
  }
  const startup = options.startupConfiguration ?? (await loadStartupConfigurationSnapshot(options));
  const { configuration, logging } = startup;
  if (configuration === undefined && options.mode === "production") {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (configuration === undefined) return undefined;
  if (
    options.mode === "development" &&
    configuration.occ === undefined &&
    configuration.drivers === undefined &&
    configuration.provider === undefined &&
    configuration.runtimeAuthoritySources === undefined
  ) {
    return undefined;
  }
  const { cluster, drivers } = parseInstallationConfiguration(configuration);
  const serviceAccount = selectedServiceAccountConfiguration(drivers.service_account);
  const providers = providerConfiguration(configuration.provider, serviceAccount);
  const runtimeAuthoritySources = runtimeAuthoritySourcesConfiguration(
    configuration.runtimeAuthoritySources,
  );
  const {
    configurationSelection,
    iamSelection,
    computeSelection,
    secretSelection,
    sandboxSelection,
  } = selectedDriverConfigurations(drivers);
  const packageRoot = options.packageRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  if (!isAbsolute(packageRoot)) {
    throw new Error("The trusted controller package root must be absolute.");
  }
  const configurationPackage = await loadDriverPackage(
    configurationSelection,
    "configuration",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const iamPackage = await loadDriverPackage(
    iamSelection,
    "iam",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const computePackage = await loadDriverPackage(
    computeSelection,
    "compute",
    packageRoot,
    options.packageRoot !== undefined,
  );
  const sshCompute = computePackage === undefined && computeSelection.id === "compute-ssh";
  const kubernetesCompute = computePackage === undefined && !sshCompute;
  if (sshCompute && sandboxSelection !== undefined) {
    throw new Error(
      "drivers.sandbox is unsupported with compute-ssh; it requires the bundled Kubernetes Compute Driver.",
    );
  }
  const sandboxPackage =
    sandboxSelection === undefined
      ? undefined
      : await loadDriverPackage(
          sandboxSelection,
          "sandbox",
          packageRoot,
          options.packageRoot !== undefined,
        );
  const bundledSandboxPackage =
    sandboxSelection !== undefined && sandboxPackage === undefined
      ? await loadBundledOpenShellSandboxDriver()
      : undefined;

  const configured = selectConfigurationDriver(configurationSelection, configurationPackage);
  const iam = selectIAMDriver(iamSelection, iamPackage);
  const compute = selectComputeDriver(computeSelection, computePackage);
  const secret = selectSecretDriver(secretSelection);
  const sandbox =
    sandboxSelection === undefined
      ? undefined
      : selectSandboxDriver(sandboxSelection, bundledSandboxPackage, sandboxPackage);
  if (sandbox !== undefined && computePackage !== undefined) {
    throw new Error("drivers.sandbox requires the bundled Kubernetes Compute Driver.");
  }
  if (kubernetesCompute && compute.configuration.isolationProfile !== undefined) {
    if (sandbox !== undefined)
      throw new Error("gVisor Alpha cannot be combined with drivers.sandbox.");
  }
  if (options.mode === "production" && kubernetesCompute) {
    validateProductionComputeConfiguration(compute);
  }
  const installation = Object.freeze({
    occ: Object.freeze({ cluster }),
    logging,
    provider: providers,
    runtimeAuthoritySources,
    drivers: Object.freeze({
      configuration: configured,
      iam,
      compute,
      secret,
      ...(sandbox === undefined ? {} : { sandbox }),
      ...(serviceAccount === undefined ? {} : { service_account: serviceAccount }),
    }),
  });
  const configurationDriver = createConfigurationDriver(configured, configurationPackage);
  const sandboxDriver =
    sandbox === undefined
      ? undefined
      : createSandboxDriver(
          sandbox,
          bundledSandboxPackage,
          sandboxPackage,
          options.createSandboxDriver,
        );
  const computeDriver = createComputeDriver(
    compute,
    configurationDriver,
    sandboxDriver,
    computePackage,
    options.workloadProfileRendererSource,
  );
  const workloadProfileRendererContribution =
    selectedComputeWorkloadProfileCapability(computeDriver);
  const secretDriver = createSecretDriver(secret);
  const createIAMDriver = createIAMDriverFactory(iam, iamPackage);
  if (
    options.mode === "production" &&
    (typeof computeDriver.activateRevision !== "function" ||
      typeof computeDriver.deactivateRevision !== "function")
  ) {
    throw new Error(
      "Production Compute Drivers must implement activateRevision and deactivateRevision.",
    );
  }
  return Object.freeze({
    installation,
    computeDriver,
    ...(workloadProfileRendererContribution === undefined
      ? {}
      : { workloadProfileRendererContribution }),
    configurationDriver,
    secretDriver,
    ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
    createIAMDriver,
  });
}
