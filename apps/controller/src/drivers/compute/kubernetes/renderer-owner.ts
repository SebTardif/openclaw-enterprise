import { selectedHostedLaunchDocument } from "./hosted-launch-document.ts";
import type { GatewayProcessCreateInputV2 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { isDeepStrictEqual } from "node:util";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { V1ConfigMap } from "@kubernetes/client-node";
import {
  gatewayLaunchMaxBytes,
  gatewayLaunchPath,
  gatewayMainPath,
  gatewayReadinessPath,
} from "@openclaw-enterprise/contracts/hosted-gateway-launch-v1";
import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import {
  FixedWorkloadRenderer,
  type FixedWorkloadInput,
} from "./resources/fixed-workload-renderer.ts";
import { admittedGatewayDeployment, fixedAdmittedGatewayTemplate } from "./resources/gateway.ts";
import { normalizeKubernetesResourcePlan } from "./resources/revision-resource-plan.ts";
import type { SelectedKubernetesRendererDefinition } from "./workload-profile-capability.ts";

type TemplateInput = Omit<FixedWorkloadInput, "component" | "embedded" | "image">;
type GatewayPlan = Omit<
  Parameters<typeof admittedGatewayDeployment>[0],
  "template" | "applicationName" | "privateStateInitName" | "image"
>;
type HostedTemplateInput = Omit<
  TemplateInput,
  "environment" | "configuration" | "enabledChannels" | "secretEnvironment" | "serviceAccount"
>;
type HostedGatewayPlan = Pick<
  GatewayPlan,
  "target" | "runtimeClassName" | "resources" | "storage"
> & { readonly original?: GatewayProcessCreateInputV2 };
const hostedLaunchVolume = "hosted-gateway-launch";

/** Values from the original immutable ConfigMap selection, never an enrollment.
 * The independent launch owner must hold and recheck this exact UID/version
 * through its later provider call; shape/correspondence grants no such hold. */
function selectedLaunchFile(
  supplied: V1ConfigMap,
  namespace: string,
  original?: GatewayProcessCreateInputV2,
) {
  const file = immutableCopy(supplied);
  const metadata = file.metadata;
  const document = file.data?.["launch.json"];
  if (
    file.kind !== "ConfigMap" ||
    file.apiVersion !== "v1" ||
    file.immutable !== true ||
    metadata?.namespace !== namespace ||
    !metadata.name ||
    metadata.name.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(metadata.name) ||
    typeof metadata.uid !== "string" ||
    !metadata.uid ||
    metadata.uid.length > 128 ||
    /[\s\x00-\x1f]/.test(metadata.uid) ||
    typeof metadata.resourceVersion !== "string" ||
    metadata.resourceVersion.length > 64 ||
    !/^[1-9][0-9]*$/.test(metadata.resourceVersion) ||
    metadata.deletionTimestamp !== undefined ||
    file.binaryData !== undefined ||
    !file.data ||
    Object.keys(file.data).length !== 1 ||
    typeof document !== "string" ||
    Buffer.byteLength(document) > gatewayLaunchMaxBytes
  )
    unavailable();
  selectedHostedLaunchDocument(document, original);
  return Object.freeze({
    namespace,
    name: metadata.name,
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
  });
}

const originalDefinition = FixedWorkloadRenderer.prototype.definition;
const originalDeployment = FixedWorkloadRenderer.prototype.deployment;
const originalSelection = DriverSelection.prototype.acquireGuardedSelection;

function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}

/** Original selected construction only. The construction lease accepts neither
 * a Pod template nor a replacement currentness callback. Revision/material/target operands still need
 * their own authority; rendering never grants a provider call or a complete
 * KubernetesRendererSource lease. */
export class KubernetesRendererOwner {
  readonly #driver: ComputeDriver;
  readonly #renderer: FixedWorkloadRenderer;
  readonly #assertSelectedDefinition: () => void;
  readonly #identity: Readonly<{ id: string; implementation: string }>;
  readonly #definition: SelectedKubernetesRendererDefinition;
  readonly #mounts: Readonly<{
    gateway: ReturnType<SelectedKubernetesRendererDefinition["workload"]["sharedMounts"]>;
    harness: ReturnType<SelectedKubernetesRendererDefinition["workload"]["sharedMounts"]>;
    privateState: ReturnType<
      SelectedKubernetesRendererDefinition["workload"]["privateStateMounts"]
    >;
  }>;

  constructor(
    driver: ComputeDriver,
    renderer: FixedWorkloadRenderer,
    assertSelectedDefinition: () => void,
  ) {
    this.#driver = driver;
    this.#renderer = renderer;
    this.#assertSelectedDefinition = assertSelectedDefinition;
    this.#identity = Object.freeze({ id: driver.id, implementation: driver.implementation });
    // The real private-field implementation rejects structural renderer copies.
    const workload = originalDefinition.call(renderer);
    if (!Object.isFrozen(renderer) || !Object.isFrozen(workload)) unavailable();
    this.#definition = Object.freeze({
      workload,
      admittedTemplate: fixedAdmittedGatewayTemplate,
      admittedDeployment: admittedGatewayDeployment,
      normalizeResources: normalizeKubernetesResourcePlan,
    });
    this.#mounts = immutableCopy(this.#observeMounts());
    this.#assertInstalled();
    Object.freeze(this);
  }

  #observeMounts() {
    const workload = this.#definition.workload;
    return {
      gateway: workload.sharedMounts("gateway"),
      harness: workload.sharedMounts("agent"),
      privateState: workload.privateStateMounts(false),
    };
  }

  #assertInstalled(): void {
    this.#assertSelectedDefinition();
    if (
      this.#driver.id !== this.#identity.id ||
      this.#driver.implementation !== this.#identity.implementation ||
      FixedWorkloadRenderer.prototype.definition !== originalDefinition ||
      FixedWorkloadRenderer.prototype.deployment !== originalDeployment ||
      originalDefinition.call(this.#renderer) !== this.#definition.workload ||
      !isDeepStrictEqual(this.#mounts, this.#observeMounts())
    )
      unavailable();
  }

  /** Installed function identities and operands, never an executable/image fit. */
  definition(): SelectedKubernetesRendererDefinition {
    this.#assertInstalled();
    return this.#definition;
  }

  /** Hold the actual selected Driver while invoking its original constructors.
   * The protected Runtime/transaction owners must retain their independent
   * leases; this partial hold is not an admission or SQL-unit enrollment. */
  acquire(selection: DriverSelection) {
    this.#assertInstalled();
    const options = this.#definition.workload.options;
    if (options.isolationProfile !== "gvisor-systrap")
      throw new WorkloadProfileSelectionError("unsupported-capability");
    // Generic construction observes the actual selected runtime. It does not
    // qualify that runtime as the protected V2 launcher. Keep that distinction
    // at every method that overlays an admitted Gateway on the fixed template.
    const assertProtectedGateway = (): void => {
      if (options.runtime !== undefined || options.servicePrincipalCredentials.mode !== "disabled")
        throw new WorkloadProfileSelectionError("unsupported-capability");
    };
    const held = originalSelection.call(selection, "compute", this.#driver);
    let released = false;
    let failed = false;
    const assertCurrent = (): undefined => {
      if (released || failed) unavailable();
      try {
        held.assertCurrent();
        this.#assertInstalled();
        return undefined;
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    const release = (): void => {
      if (released) return;
      released = true;
      held.release();
    };
    const construct = <T>(work: () => T): T => {
      assertCurrent();
      try {
        return work();
      } finally {
        assertCurrent();
      }
    };
    const gatewayTemplate = (input: TemplateInput, runtimeClassName: string) => {
      assertProtectedGateway();
      return fixedAdmittedGatewayTemplate(
        this.#renderer,
        { ...immutableCopy(input), image: this.#definition.workload.images.gateway },
        runtimeClassName,
      );
    };
    try {
      assertCurrent();
      return Object.freeze({
        definition: this.#definition,
        assertCurrent,
        release,
        gatewayTemplate: (input: TemplateInput, runtimeClassName: string) =>
          construct(() => gatewayTemplate(input, runtimeClassName)),
        harnessTemplate: (input: TemplateInput) =>
          construct(() =>
            originalDeployment.call(this.#renderer, {
              ...immutableCopy(input),
              image: this.#definition.workload.images.harness,
              component: "agent",
              embedded: false,
            }),
          ),
        gatewayDeployment: (input: TemplateInput, suppliedPlan: GatewayPlan) =>
          construct(() => {
            const plan = immutableCopy(suppliedPlan);
            const template = gatewayTemplate(input, plan.runtimeClassName);
            const pod = template.spec?.template.spec;
            if (!pod?.containers[0] || !pod.initContainers?.[0]) unavailable();
            return admittedGatewayDeployment({
              ...plan,
              template,
              applicationName: pod.containers[0].name,
              privateStateInitName: pod.initContainers[0].name,
              image: this.#definition.workload.images.gateway,
            });
          }),
        /** Execute the actual fixed hosted construction under this same original
         * selected Driver hold. No legacy tokens, direct keys, caller argv/env,
         * HTTP readiness guess or extra init container are admitted here. */
        hostedGatewayDeployment: (
          input: HostedTemplateInput,
          suppliedPlan: HostedGatewayPlan,
          suppliedLaunchFile: V1ConfigMap,
        ) =>
          construct(() => {
            const plan = immutableCopy(suppliedPlan);
            const launchFile = selectedLaunchFile(
              suppliedLaunchFile,
              input.namespace,
              plan.original,
            );
            if (
              plan.original !== undefined &&
              (!isDeepStrictEqual(plan.original.target, plan.target) ||
                plan.original.binding.namespaceRef !== input.ownership.namespaceId ||
                plan.original.binding.agentRef !== input.ownership.agentId ||
                plan.original.binding.admittedRevisionRef !== input.ownership.revisionId)
            )
              unavailable();
            const {
              configuration: _configuration,
              serviceAccount: _serviceAccount,
              ...fixedInput
            } = immutableCopy(input) as TemplateInput;
            const template = gatewayTemplate(
              {
                ...fixedInput,
                environment: {},
                enabledChannels: [],
                secretEnvironment: [],
              },
              plan.runtimeClassName,
            );
            const pod = template.spec?.template.spec;
            const app = pod?.containers[0],
              init = pod?.initContainers?.[0];
            if (!pod || !app || !init || pod.volumes?.some((v) => v.name === hostedLaunchVolume))
              unavailable();
            const deployment = admittedGatewayDeployment({
              target: plan.target,
              template,
              applicationName: app.name,
              privateStateInitName: init.name,
              image: this.#definition.workload.images.gateway,
              argv: ["/usr/local/bin/node", gatewayMainPath],
              runtimeClassName: plan.runtimeClassName,
              environment: app.env ?? [],
              volumes: [
                ...(pod.volumes ?? []),
                {
                  name: hostedLaunchVolume,
                  configMap: {
                    name: launchFile.name,
                    optional: false,
                    defaultMode: 0o440,
                    items: [{ key: "launch.json", path: "launch.json", mode: 0o440 }],
                  },
                },
              ],
              mounts: [
                ...(app.volumeMounts ?? []),
                {
                  name: hostedLaunchVolume,
                  mountPath: gatewayLaunchPath,
                  subPath: "launch.json",
                  readOnly: true,
                },
              ],
              resources: plan.resources,
              storage: plan.storage,
            });
            const actual = deployment.spec!.template.spec!.containers[0]!;
            // The fixed CLI asks the original main's loopback listener; the main
            // owns started/current/closed state. Probe success grants no admission.
            const withProbe = immutableCopy({
              ...deployment,
              spec: {
                ...deployment.spec!,
                template: {
                  ...deployment.spec!.template,
                  spec: {
                    ...deployment.spec!.template.spec!,
                    containers: [
                      {
                        ...actual,
                        readinessProbe: {
                          exec: { command: ["node", gatewayReadinessPath] },
                          timeoutSeconds: 1,
                          periodSeconds: 2,
                          failureThreshold: 1,
                        },
                      },
                    ],
                  },
                },
              },
            });
            return Object.freeze({ deployment: withProbe, launchFile });
          }),
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}
