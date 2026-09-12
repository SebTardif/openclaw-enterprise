import type {
  Driver,
  DriverImplementation,
  ComputeDriver,
  ConfigurationDriver,
  SecretDriver,
  IAMDriver,
  SandboxDriver,
  ServiceAccountDriver,
  PluginDriver,
} from "@openclaw-enterprise/contracts";
import type { OCCPluginDriver } from "../../../../apps/controller/src/drivers/plugin/index.ts";
import type { NativeIAMDriver } from "../../../iam/src/index.ts";
import type { KubernetesComputeDriver } from "../../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import type { DockerComputeDriver } from "../../../../apps/controller/src/drivers/compute/docker/index.ts";
import type { KubernetesConfigurationDriver } from "../../../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import type { KubernetesSecretDriver } from "../../../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import type { OpenShellSandboxDriver } from "../../../../apps/controller/src/drivers/sandbox/openshell.ts";
import type { ChatGPTServiceAccountDriver } from "../../../../apps/controller/src/drivers/service-account/chatgpt.ts";

type Implements<Contract, Implementation extends Contract> = Implementation;

// These checks compile the real implementations; the fixture supplies no Driver.
export type ProductionDrivers = {
  readonly base: Implements<Driver, NativeIAMDriver>;
  readonly implementation: Implements<DriverImplementation, typeof NativeIAMDriver>;
  readonly iam: Implements<IAMDriver, NativeIAMDriver>;
  readonly kubernetes: Implements<ComputeDriver, KubernetesComputeDriver>;
  readonly docker: Implements<ComputeDriver, DockerComputeDriver>;
  readonly configuration: Implements<ConfigurationDriver, KubernetesConfigurationDriver>;
  readonly secret: Implements<SecretDriver, KubernetesSecretDriver>;
  readonly sandbox: Implements<SandboxDriver, OpenShellSandboxDriver>;
  readonly serviceAccount: Implements<ServiceAccountDriver, ChatGPTServiceAccountDriver>;
  readonly plugin: Implements<PluginDriver, OCCPluginDriver>;
};
