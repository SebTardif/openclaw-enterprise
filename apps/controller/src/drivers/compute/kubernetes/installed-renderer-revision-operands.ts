import { isDeepStrictEqual } from "node:util";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { WorkloadLaunchContext } from "@openclaw-enterprise/contracts";
import type { V1Deployment } from "@kubernetes/client-node";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import { workloadProfileDigest } from "@openclaw-enterprise/occ/workload-profiles/canonical";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import { selectedComputeRendererOwner } from "../../../composition/driver-factories/compute.ts";
import { KubernetesComputeDriver } from "./index.ts";
import { KubernetesRendererOwner } from "./renderer-owner.ts";
import { fixedWorkloadDeployment } from "./resources/fixed-workload-renderer.ts";
import { gatewayConfiguration, admittedGatewayDeployment } from "./resources/gateway.ts";
import type {
  InstalledArtifactDescriptor,
  InstalledArtifactLease,
} from "./installed-artifact-store.ts";
import type {
  InstalledRevisionOperandsLease,
  InstalledPreparedRevisionOperandsLease,
  RevisionArgs,
  TrustedInstalledRendererSuppliers,
} from "./installed-renderer-definition.ts";

type Input = Parameters<TrustedInstalledRendererSuppliers["acquireRevisionOperands"]>[0];
type TemplateInput = InstalledRevisionOperandsLease["inputs"]["harness"];
type GatewayPlan = InstalledPreparedRevisionOperandsLease["inputs"]["gateway"][1];
type Owned = Pick<InstalledRevisionOperandsLease, "assertCurrent" | "release">;

/** Issued only by the original State capture. The opaque source identity is
 * recognized by the original material owner, never registered by this supplier.
 * Its currentness is owner-lived and remains valid after acquisition IO closes. */
export interface CapturedInstalledRevisionLease extends Owned {
  readonly revision: Readonly<AgentRevision>;
  readonly sourceIdentity: object;
}

/** Exact missing State operation: resolve the original normalized candidate or
 * admitted revision from existing private unit membership. It must bind request,
 * retained Use and selected Driver, reject another operation/unit, and borrow
 * pre-head observations without opening a transaction or taking parent locks. */
export interface InstalledRevisionCaptureReader {
  readCapturedRevision(
    request: RevisionArgs[2],
    use: RevisionArgs[4],
    unit: RevisionArgs[5],
    io: RevisionArgs[6],
  ): Promise<CapturedInstalledRevisionLease>;
}

export interface InstalledStaticMaterialPlacementLease extends Owned {
  readonly namespace: string;
  /** Actual independently selected Gateway identity, not a generated Agent. */
  readonly gateway: Readonly<{
    name: string;
    serviceAccountName: string;
    servicePrincipalId: string;
    environment: TemplateInput["environment"];
    enabledChannels: NonNullable<TemplateInput["enabledChannels"]>;
    secretEnvironment: NonNullable<TemplateInput["secretEnvironment"]>;
  }>;
  readonly harness: Readonly<{ environment: TemplateInput["environment"] }>;
}

export interface InstalledContainerImageProjection {
  readonly schemaVersion: 1;
  readonly sourceDefinition: InstalledArtifactDescriptor;
  readonly containers: readonly Readonly<{
    component: "gateway" | "harness";
    phase: "application" | "init";
    name: string;
    reference: string;
    platformDigest: string;
  }>[];
}

export interface InstalledPreparedMaterialPlacementLease extends InstalledStaticMaterialPlacementLease {
  /** Actual protected create/target/material owner holds this plan for this
   * operation. Namespace UID/version are observations, not invented admission inputs. */
  readonly gatewayPlan: GatewayPlan;
  readonly imageSet: InstalledContainerImageProjection;
  readonly imageSetDigest: string;
}

type OriginalMaterialInput = Readonly<{
  original: Readonly<RevisionArgs>;
  candidate: Readonly<{
    revision: Readonly<AgentRevision>;
    sourceIdentity: object;
    /** Upstream State/revision/selection lifetime only. A material lease may
     * retain this fence in its own currentness without depending on itself. */
    assertCurrent(): undefined;
  }>;
}>;

/** Once-selected original producers, not caller callbacks. They recognize the
 * borrowed original State identity and retain their actual material/placement
 * owners. Neither method may invoke a launch hook or create a physical target.
 * TODO(CTL-14): compose these original State/material owners at the process root
 * after their paired implementations land; this interface alone grants no custody. */
export interface InstalledRevisionMaterialSources {
  acquireStaticMaterialPlacement(
    input: OriginalMaterialInput,
  ): Promise<InstalledStaticMaterialPlacementLease>;
  acquirePreparedMaterialPlacement?(
    input: OriginalMaterialInput & Readonly<{ launch: Readonly<WorkloadLaunchContext> }>,
  ): Promise<InstalledPreparedMaterialPlacementLease>;
}

const originalOwner = selectedComputeRendererOwner;
const originalDefinition = KubernetesRendererOwner.prototype.definition;
const originalGateway = KubernetesComputeDriver.prototype.renderAdmittedGatewayTemplate;
const originalLaunch = KubernetesComputeDriver.prototype.acquireCurrentLaunchOperands;
const originalConstruct = fixedWorkloadDeployment;
const originalDeployment = admittedGatewayDeployment;
const originalSignalAborted = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!,
) as (signal: AbortSignal) => boolean;
const digest = /^sha256:[a-f0-9]{64}$/;

function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function unsupported(): never {
  throw new WorkloadProfileSelectionError("unsupported-capability");
}

/** Full named container projection, including init and every additional helper
 * container. Names are unique within each component; unknown image contents
 * refuse instead of dropping a helper. This pure projection grants no authority.
 * Runtime must use this exact version and imageSetDigest domain before accepting
 * its result as the admitted image-set identity. */
export function installedRendererContainerImageSet(
  artifacts: InstalledArtifactLease,
  outputs: Readonly<Record<"gateway" | "harness", V1Deployment>>,
): InstalledContainerImageProjection {
  const containers: InstalledContainerImageProjection["containers"][number][] = [];
  if (!digest.test(artifacts.definition.digest)) unsupported();
  for (const component of ["gateway", "harness"] as const) {
    const pod = outputs[component].spec?.template.spec;
    if (!pod || !pod.containers.length || pod.ephemeralContainers?.length) unsupported();
    const names = new Set<string>();
    for (const phase of ["application", "init"] as const) {
      const group = phase === "application" ? pod.containers : (pod.initContainers ?? []);
      for (const container of group) {
        if (!container.name || names.has(container.name)) unsupported();
        names.add(container.name);
        const image = artifacts.images[component];
        if (container.image !== image.reference || !digest.test(image.descriptor.digest))
          unsupported();
        containers.push({
          component,
          phase,
          name: container.name,
          reference: image.reference,
          platformDigest: image.descriptor.digest,
        });
      }
    }
  }
  containers.sort((a, b) => {
    const left = `${a.component}/${a.phase}/${a.name}`;
    const right = `${b.component}/${b.phase}/${b.name}`;
    if (left < right) return -1;
    return left > right ? 1 : 0;
  });
  return immutableCopy({
    schemaVersion: 1 as const,
    sourceDefinition: artifacts.definition,
    containers,
  });
}

/** Constructed before Compute. The invocation resolves the original selected
 * renderer; the enclosing renderer-source already holds its DriverSelection.
 * No alternate renderer, DriverSelection, registry or approval hook is created. */
export class InstalledKubernetesRevisionOperandsSupplier {
  readonly #reader: InstalledRevisionCaptureReader;
  readonly #materials: InstalledRevisionMaterialSources;
  readonly #read: InstalledRevisionCaptureReader["readCapturedRevision"];
  readonly #static: InstalledRevisionMaterialSources["acquireStaticMaterialPlacement"];
  readonly #prepared: InstalledRevisionMaterialSources["acquirePreparedMaterialPlacement"];

  constructor(reader: InstalledRevisionCaptureReader, materials: InstalledRevisionMaterialSources) {
    this.#reader = reader;
    this.#materials = materials;
    this.#read = reader.readCapturedRevision;
    this.#static = materials.acquireStaticMaterialPlacement;
    this.#prepared = materials.acquirePreparedMaterialPlacement;
    Object.freeze(this);
  }

  acquireRevisionOperands(input: Input): Promise<InstalledRevisionOperandsLease> {
    return this.#acquire(input, false) as Promise<InstalledRevisionOperandsLease>;
  }

  acquirePreparedRevisionOperands(input: Input): Promise<InstalledPreparedRevisionOperandsLease> {
    return this.#acquire(input, true) as Promise<InstalledPreparedRevisionOperandsLease>;
  }

  async #acquire(
    input: Input,
    prepared: boolean,
  ): Promise<InstalledRevisionOperandsLease | InstalledPreparedRevisionOperandsLease> {
    const { original, artifacts, behavior } = input;
    const originalTuple = [...original];
    const [selected, definition, request, manifest, use, unit, io] = original;
    const signal = "signal" in unit ? unit.signal : undefined;
    const snapshot = immutableCopy({ request, manifest, use });
    const upstreamChecks: (() => unknown)[] = [];
    const checks: (() => unknown)[] = [];
    const disposers: (() => Promise<void>)[] = [];
    const pending = new Set<Promise<unknown>>();
    let closed = false;
    let checking = false;
    let checkingCandidate = false;
    let failed = false;
    let failure: unknown;
    let closing: Promise<void> | undefined;
    let owner: ReturnType<typeof originalOwner>;
    const fail = (error: unknown): never => {
      if (!failed) {
        failed = true;
        failure = error;
      }
      throw failure;
    };
    const synchronous = (work: () => unknown): void => {
      const result = work();
      if (result === undefined) return;
      const settlement = Promise.resolve().then(() => result);
      pending.add(settlement);
      void settlement.then(
        () => pending.delete(settlement),
        () => pending.delete(settlement),
      );
      unavailable();
    };
    const terminalCurrent = (): void => {
      // The captured native accessor reads the original signal's internal state,
      // bypassing source/unit/own-property getters. Nothing below opens a new
      // callback window after testing the sticky failure and closing state.
      const cancelled = signal !== undefined && originalSignalAborted(signal);
      if (failed) throw failure;
      if (closed || cancelled) unavailable();
    };
    const local = (): void => {
      terminalCurrent();
      if (
        ("signal" in unit ? unit.signal : undefined) !== signal ||
        this.#reader.readCapturedRevision !== this.#read ||
        this.#materials.acquireStaticMaterialPlacement !== this.#static ||
        this.#materials.acquirePreparedMaterialPlacement !== this.#prepared ||
        original.length !== 7 ||
        original.some((value, index) => value !== originalTuple[index]) ||
        !isDeepStrictEqual(immutableCopy({ request, manifest, use }), snapshot)
      )
        unavailable();
      if (owner !== undefined) {
        const current = originalDefinition.call(owner);
        if (
          originalOwner(selected) !== owner ||
          current.workload !== definition.workload ||
          current.admittedTemplate !== definition.admittedTemplate ||
          current.admittedDeployment !== originalDeployment ||
          current.normalizeResources !== definition.normalizeResources ||
          definition.admittedDeployment !== originalDeployment ||
          definition.workload.construct !== originalConstruct ||
          KubernetesComputeDriver.prototype.renderAdmittedGatewayTemplate !== originalGateway ||
          KubernetesComputeDriver.prototype.acquireCurrentLaunchOperands !== originalLaunch
        )
          unavailable();
      }
    };
    const assertCandidateCurrent = (): undefined => {
      if (checkingCandidate) return fail(new Error("Captured revision currentness reentered."));
      checkingCandidate = true;
      try {
        local();
        for (const check of upstreamChecks) synchronous(check);
        local();
        terminalCurrent();
        return undefined;
      } catch (error) {
        return fail(error);
      } finally {
        checkingCandidate = false;
      }
    };
    const assertCurrent = (): undefined => {
      if (checking) return fail(new Error("Revision operand currentness reentered."));
      checking = true;
      try {
        local();
        assertCandidateCurrent();
        for (const check of checks) synchronous(check);
        local();
        terminalCurrent();
        return undefined;
      } catch (error) {
        return fail(error);
      } finally {
        checking = false;
      }
    };
    const active = (): void => {
      assertCurrent();
      synchronous(io.assertActive.bind(io));
      assertCurrent();
    };
    const own = <T extends Owned>(lease: T, fences = checks): T => {
      const dispose = lease.release;
      if (typeof dispose !== "function") unavailable();
      disposers.push(dispose.bind(lease));
      const check = lease.assertCurrent;
      if (typeof check !== "function") unavailable();
      fences.push(check.bind(lease));
      return lease;
    };
    const release = (): Promise<void> => {
      if (closing !== undefined) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        const errors: unknown[] = [];
        for (const dispose of disposers.reverse()) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        while (pending.size) await Promise.allSettled([...pending]);
        if (errors.length) throw new AggregateError(errors, "Revision operand cleanup failed.");
      });
      return closing;
    };
    try {
      active();
      // State authentication and cleanup transfer precede renderer/material reads.
      const captured = own(
        await this.#read.call(this.#reader, request, use, unit, io),
        upstreamChecks,
      );
      active();
      owner = originalOwner(selected);
      if (owner === undefined) unavailable();
      active();
      const options = definition.workload.options;
      if (
        options.isolationProfile !== "gvisor-systrap" ||
        options.runtime !== undefined ||
        options.servicePrincipalCredentials.mode !== "disabled"
      )
        unsupported();
      const revision = captured.revision;
      const retainedRevision = immutableCopy(revision);
      const sourceIdentity = captured.sourceIdentity;
      if (!sourceIdentity || typeof sourceIdentity !== "object") unavailable();
      const currentRevision = (): undefined => {
        if (
          captured.revision !== revision ||
          captured.sourceIdentity !== sourceIdentity ||
          !isDeepStrictEqual(revision, retainedRevision) ||
          revision.id !== request.revisionId ||
          revision.agentId !== request.agentId ||
          revision.namespaceId !== request.namespaceId ||
          revision.configurationId !== request.configurationRef ||
          revision.configurationGeneration !== request.configurationVersion ||
          revision.compute.id !== selected.id ||
          revision.compute.implementation !== selected.implementation ||
          (revision.workloadProfileUse !== undefined &&
            !isDeepStrictEqual(revision.workloadProfileUse, use))
        )
          unavailable();
        return undefined;
      };
      upstreamChecks.push(currentRevision);
      checks.push(artifacts.assertCurrent.bind(artifacts), behavior.assertCurrent.bind(behavior));
      if (revision.harness.mode !== "dedicated" || revision.sandboxDriverId !== undefined)
        unsupported();
      active();
      const candidate = Object.freeze({
        revision,
        sourceIdentity,
        assertCurrent: assertCandidateCurrent,
      });
      const originalMaterial = Object.freeze({ original, candidate });
      let launch: ReturnType<typeof originalLaunch> | undefined;
      let material: InstalledStaticMaterialPlacementLease;
      if (prepared) {
        if (!this.#prepared) unavailable();
        launch = own(originalLaunch.call(selected as KubernetesComputeDriver, revision));
        active();
        material = own(
          await this.#prepared.call(
            this.#materials,
            Object.freeze({ ...originalMaterial, launch: launch.launch }),
          ),
        );
      } else {
        material = own(await this.#static.call(this.#materials, originalMaterial));
      }
      active();
      const materialValues = immutableCopy({
        namespace: material.namespace,
        gateway: material.gateway,
        harness: material.harness,
      });
      checks.push(() => {
        if (
          !isDeepStrictEqual(
            { namespace: material.namespace, gateway: material.gateway, harness: material.harness },
            materialValues,
          )
        )
          unavailable();
        return undefined;
      });
      if (
        !materialValues.namespace ||
        !materialValues.gateway.name ||
        !materialValues.gateway.serviceAccountName ||
        !materialValues.gateway.servicePrincipalId ||
        materialValues.gateway.servicePrincipalId === revision.servicePrincipalId
      )
        unavailable();
      const configuration = gatewayConfiguration(revision);
      const plans = definition.normalizeResources(
        manifest.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope,
        behavior.accounting,
      );
      const ownership = {
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        revisionId: revision.id,
        servicePrincipalId: revision.servicePrincipalId,
      };
      const gateway: TemplateInput = {
        name: materialValues.gateway.name,
        namespace: materialValues.namespace,
        ownership,
        serviceAccountName: materialValues.gateway.serviceAccountName,
        workloadServicePrincipalId: materialValues.gateway.servicePrincipalId,
        environment: materialValues.gateway.environment,
        enabledChannels: materialValues.gateway.enabledChannels,
        secretEnvironment: materialValues.gateway.secretEnvironment,
        loggingLevel: configuration.loggingLevel,
        configuration,
        resourcePlan: plans.gateway,
      };
      const harnessName = `agent-${sha256Hex(revision.agentId, 12)}`;
      if (
        materialValues.gateway.serviceAccountName === harnessName ||
        (launch !== undefined &&
          !isDeepStrictEqual(materialValues.harness.environment, launch.launch.environment))
      )
        unavailable();
      const harness: TemplateInput = {
        name: `${harnessName}-rev-${sha256Hex(revision.id, 12)}`,
        namespace: materialValues.namespace,
        ownership,
        serviceAccountName: harnessName,
        environment:
          launch === undefined ? materialValues.harness.environment : launch.launch.environment,
        loggingLevel: configuration.loggingLevel,
        ...(revision.serviceAccount === undefined
          ? {}
          : { serviceAccount: revision.serviceAccount }),
        resourcePlan: plans.harness,
      };
      const runtimeClass = manifest.launchConfiguration.gateway.runtimeClass;
      if (gateway.name === harness.name) unavailable();
      const gatewayTemplate = originalGateway.call(
        selected as KubernetesComputeDriver,
        { ...gateway, image: definition.workload.images.gateway },
        runtimeClass,
      );
      const harnessOutput = originalConstruct(
        { ...options, resourcePlan: plans.harness },
        harness.name,
        harness.ownership,
        harness.namespace,
        definition.workload.images.harness,
        harness.serviceAccountName,
        "agent",
        harness.environment,
        harness.loggingLevel,
        harness.configuration,
        false,
        harness.workloadServicePrincipalId,
        harness.serviceAccount,
        harness.enabledChannels,
        harness.secretEnvironment,
      );
      if (
        harnessOutput.spec?.template.spec?.runtimeClassName !==
        manifest.launchConfiguration.harness.runtimeClass
      )
        unsupported();
      active();
      if (!prepared) {
        const inputs = immutableCopy({
          gateway: [gateway, runtimeClass] as [TemplateInput, string],
          harness,
        });
        const outputs = immutableCopy({ gateway: gatewayTemplate, harness: harnessOutput });
        active();
        return Object.freeze({ revision, inputs, outputs, assertCurrent, release });
      }
      const preparedMaterial = material as InstalledPreparedMaterialPlacementLease;
      const plan = immutableCopy(preparedMaterial.gatewayPlan);
      const imageSet = immutableCopy(preparedMaterial.imageSet);
      const imageSetDigest = preparedMaterial.imageSetDigest;
      checks.push(() => {
        if (
          !isDeepStrictEqual(immutableCopy(preparedMaterial.gatewayPlan), plan) ||
          !isDeepStrictEqual(preparedMaterial.imageSet, imageSet) ||
          preparedMaterial.imageSetDigest !== imageSetDigest
        )
          unavailable();
        return undefined;
      });
      if (
        plan.runtimeClassName !== runtimeClass ||
        plan.target.namespace.name !== gateway.namespace ||
        plan.target.deploymentName !== gateway.name ||
        !plan.target.clusterRef ||
        !plan.target.namespace.uid ||
        !/^[1-9][0-9]*$/.test(plan.target.namespace.resourceVersion) ||
        !isDeepStrictEqual(plan.resources, immutableCopy(plans.gateway))
      )
        unavailable();
      const pod = gatewayTemplate.spec?.template.spec;
      if (!pod?.containers[0] || !pod.initContainers?.[0]) unavailable();
      const outputs = immutableCopy({
        gateway: originalDeployment({
          ...plan,
          template: gatewayTemplate,
          applicationName: pod.containers[0].name,
          privateStateInitName: pod.initContainers[0].name,
          image: definition.workload.images.gateway,
        }),
        harness: harnessOutput,
      });
      const actualImages = installedRendererContainerImageSet(artifacts, outputs);
      if (
        !isDeepStrictEqual(imageSet, actualImages) ||
        imageSetDigest !== workloadProfileDigest("imageSetDigest", actualImages)
      )
        unavailable();
      const inputs = immutableCopy({
        gateway: [gateway, plan] as [TemplateInput, GatewayPlan],
        harness,
      });
      const harnessOperands = Object.freeze({ launch: launch!.launch, imageSetDigest });
      active();
      return Object.freeze({ revision, inputs, outputs, harnessOperands, assertCurrent, release });
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
      try {
        await release();
      } catch (cleanup) {
        throw new AggregateError(
          [failure, cleanup],
          "Revision operand acquisition and cleanup failed.",
        );
      }
      throw failure;
    }
  }
}
