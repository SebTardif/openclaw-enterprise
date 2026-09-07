import { isDeepStrictEqual } from "node:util";
import type { V1Deployment, V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type {
  GatewayProcessCreateInputV2,
  GatewayProcessCallV2,
  GatewayProcessObjectV2,
  GatewayStartupModuleSelectionV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  WorkloadProfileSelectionRequestV2,
  WorkloadProfileUseV2,
} from "@openclaw-enterprise/occ/workload-profiles/selection";
import {
  deriveWorkloadProfileManifestV2,
  type WorkloadProfilePairLaunchV2,
} from "@openclaw-enterprise/occ/workload-profiles/projections";
import {
  normalizeKubernetesResourcePlan,
  type KubernetesResourceContributionMap,
} from "./resources/revision-resource-plan.ts";
import { admittedGatewayDeployment } from "./resources/gateway.ts";

type Definition = WorkloadProfilePairLaunchV2["runtime"]["implementation"];
type ArgumentName = "configuration-path" | "state-path" | "bootstrap-socket";

/** Nonsecret immutable values returned by the original qualified renderer,
 * environment, module and physical-store participants. This record is not a
 * currentness proof and must never be constructed from a public request body. */
export interface AdmittedGatewayLaunchRecord {
  readonly input: GatewayProcessCreateInputV2;
  readonly request: WorkloadProfileSelectionRequestV2;
  readonly use: WorkloadProfileUseV2;
  readonly canonicalManifest: string;
  readonly placement: {
    readonly cluster: Definition;
    readonly namespaceAllocation: Definition;
    readonly target: GatewayProcessCreateInputV2["target"];
  };
  readonly renderer: {
    readonly definition: Definition;
    readonly template: V1Deployment;
    readonly applicationName: string;
    readonly privateStateInitName: string;
    readonly accounting: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>;
  };
  readonly environment: {
    readonly definition: Definition;
    readonly variables: readonly V1EnvVar[];
  };
  readonly modules: readonly {
    readonly definition: WorkloadProfilePairLaunchV2["modules"][number];
    readonly selection: GatewayStartupModuleSelectionV1;
  }[];
  readonly arguments: Readonly<Partial<Record<ArgumentName, string>>>;
  readonly storage: Readonly<
    Record<
      "runtimeHome" | "temporary",
      {
        readonly accountingId: string;
        readonly volumeName: string;
      }
    >
  >;
  readonly mounts: readonly {
    readonly definition: WorkloadProfilePairLaunchV2["gateway"]["mounts"][number];
    readonly volume: V1Volume;
    readonly mount: V1VolumeMount;
  }[];
}

/** Independently reacquired for the exact provider call; never a borrowed SQL
 * selector lease. The selected owner authenticates every resolved definition and
 * the original admission/configuration/target/create-effect association. */
export interface AdmittedGatewayLaunchSource {
  read(
    original: GatewayProcessCreateInputV2 | GatewayProcessObjectV2,
    call: GatewayProcessCallV2,
  ): Promise<
    | {
        readonly record: AdmittedGatewayLaunchRecord;
        recheckCurrent(): Promise<void>;
        assertCurrent(): undefined;
      }
    | undefined
  >;
}

function requireLaunch(value: unknown): asserts value {
  if (!value) throw new Error("The immutable admitted Gateway launch is unavailable.");
}

/** Render only after authentic original-owner lookup. Pure reconstruction still
 * refuses mismatched definitions and unsupported selected resource topology. */
export function renderAdmittedGatewayLaunch(
  expected: GatewayProcessCreateInputV2 | GatewayProcessObjectV2,
  supplied: AdmittedGatewayLaunchRecord,
): { readonly input: GatewayProcessCreateInputV2; readonly deployment: V1Deployment } {
  const record = immutableCopy(supplied);
  requireLaunch(
    isDeepStrictEqual(record.input.binding, expected.binding) &&
      isDeepStrictEqual(record.input.target, expected.target) &&
      (!("launchPlan" in expected) || isDeepStrictEqual(record.input, expected)),
  );
  assertAdmittedGatewayAssociation(record.input, record.request, record.use);
  const derived = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(record.canonicalManifest),
  );
  requireLaunch(
    new TextDecoder().decode(derived.canonicalBytes) === record.canonicalManifest &&
      derived.digests.manifestDigest === record.use.manifestDigest,
  );
  for (const role of ["provider", "runtime", "identity", "containment", "storage"] as const)
    requireLaunch(derived.roleDigests[role] === record.use.profileRefs[role].contentDigest);
  // The canonical decoder uses null-prototype dictionaries. Compare its values
  // through the same immutable snapshot representation as the protected record;
  // prototype differences are not a change to the canonical bytes checked above.
  const launch = immutableCopy(derived.content.launchConfiguration);
  requireLaunch(
    isDeepStrictEqual(record.placement.cluster, launch.placement.cluster) &&
      isDeepStrictEqual(
        record.placement.namespaceAllocation,
        launch.placement.namespaceAllocation,
      ) &&
      isDeepStrictEqual(record.placement.target, record.input.target) &&
      isDeepStrictEqual(record.renderer.definition, launch.runtime.implementation) &&
      isDeepStrictEqual(record.environment.definition, launch.gateway.environmentDefinition) &&
      isDeepStrictEqual(
        record.modules.map((item) => item.definition),
        launch.modules,
      ) &&
      isDeepStrictEqual(
        record.modules.map((item) => item.selection),
        expected.binding.modules,
      ) &&
      isDeepStrictEqual(
        record.mounts.map((item) => item.definition),
        launch.gateway.mounts,
      ) &&
      expected.binding.protocolVersion === launch.gateway.protocolVersion &&
      expected.binding.stateSchemaVersion === launch.gateway.stateSchemaVersion &&
      expected.binding.agentSchemaVersion === launch.gateway.agentSchemaVersion,
  );
  const argumentNames = new Set<string>();
  const argv = launch.gateway.argv.map((item) => {
    if (item.kind === "literal") return item.value;
    argumentNames.add(item.name);
    const value = record.arguments[item.name];
    requireLaunch(typeof value === "string" && value.startsWith("/") && !value.includes("\0"));
    return value;
  });
  requireLaunch(
    Object.keys(record.arguments).length === argumentNames.size &&
      Object.keys(record.arguments).every((name) => argumentNames.has(name)),
  );
  const volumes: V1Volume[] = [];
  const mounts: V1VolumeMount[] = [];
  for (const resolved of record.mounts) {
    requireLaunch(
      resolved.volume.name === resolved.definition.name &&
        resolved.mount.name === resolved.volume.name &&
        resolved.mount.mountPath === resolved.definition.path &&
        (resolved.mount.readOnly === true) === (resolved.definition.access === "read-only") &&
        resolved.volume.hostPath === undefined &&
        resolved.mount.subPathExpr === undefined,
    );
    volumes.push(resolved.volume);
    mounts.push(resolved.mount);
  }
  const resources = normalizeKubernetesResourcePlan(
    launch.resourceEnvelope.podAndRuntimeAccounting.envelope,
    record.renderer.accounting,
  ).gateway;
  const deployment = admittedGatewayDeployment({
    target: expected.target,
    template: record.renderer.template,
    applicationName: record.renderer.applicationName,
    privateStateInitName: record.renderer.privateStateInitName,
    image: derived.content.artifactSet.gateway.reference,
    argv,
    runtimeClassName: launch.gateway.runtimeClass,
    environment: record.environment.variables,
    volumes,
    mounts,
    resources,
    storage: record.storage,
  });
  return immutableCopy({ input: record.input, deployment });
}

/** Immutable correspondence only. The original owner supplies current authority
 * separately for the exact process call; matching these values never issues it. */
export function assertAdmittedGatewayAssociation(
  input: GatewayProcessCreateInputV2,
  request: WorkloadProfileSelectionRequestV2,
  use: WorkloadProfileUseV2,
): void {
  const binding = input.binding;
  const subject = binding.startup.subject;
  const selection = {
    manifestRef: use.manifestRef,
    manifestDigest: use.manifestDigest,
    admissionRef: use.admissionRef,
    admissionVersion: use.admissionVersion,
  };
  if (
    binding.schemaVersion !== 2 ||
    binding.startup.schemaVersion !== 2 ||
    subject.kind !== "agent-gateway" ||
    request.schemaVersion !== 2 ||
    use.schemaVersion !== 2 ||
    use.component !== "gateway-harness-pair" ||
    subject.installationId !== request.installationId ||
    subject.namespaceRef !== request.namespaceId ||
    subject.agentRef !== request.agentId ||
    binding.namespaceRef !== subject.namespaceRef ||
    binding.agentRef !== subject.agentRef ||
    binding.admittedRevisionRef !== request.revisionId ||
    binding.configurationRef !== request.configurationRef ||
    binding.configurationVersion !== request.configurationVersion ||
    use.installationId !== request.installationId ||
    use.namespaceId !== request.namespaceId ||
    binding.admittedConfigurationDigest !== use.admittedConfigurationDigest ||
    !isDeepStrictEqual(binding.selection, request.selection) ||
    !isDeepStrictEqual(binding.selection, selection) ||
    !isDeepStrictEqual(binding.profileRefs, use.profileRefs)
  ) {
    throw new Error("The admitted Gateway launch association does not match.");
  }
}
