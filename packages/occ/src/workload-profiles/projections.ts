import { workloadProfileDigest } from "./canonical.ts";
import {
  decodeWorkloadProfileManifest,
  decodeWorkloadProfileManifestV2,
  WorkloadProfileManifestError,
  type DecodedWorkloadProfileManifestV1,
  type WorkloadProfileManifestArtifactV1,
  type WorkloadProfileManifestClaimV1,
  type WorkloadProfileManifestContentV1,
  type WorkloadProfileManifestProducerV1,
  type WorkloadProfileManifestContentV2,
} from "./manifest.ts";

type Content = WorkloadProfileManifestContentV1;
type Launch = Content["launchConfiguration"];
export type WorkloadProfileResourceAccountingSelectionV1 =
  Launch["resourceEnvelope"]["podAndRuntimeAccounting"];

/** Exact static selection from a fully decoded candidate, including its original
 * envelope ref/version and all supplied or missing inputs. This adds no digest
 * domain, accounting result, admitted-profile association or runtime authority. */
export function projectWorkloadProfileResourceAccountingV1(
  input: Uint8Array,
): WorkloadProfileResourceAccountingSelectionV1 {
  return decodeWorkloadProfileManifest(input).content.launchConfiguration.resourceEnvelope
    .podAndRuntimeAccounting;
}

/** The successor keeps the existing domain names. Its complete pair content,
 * including the original accounting seed, selects the bytes inside each domain. */
export function deriveWorkloadProfileManifestV2(input: Uint8Array) {
  const decoded = decodeWorkloadProfileManifestV2(input);
  const manifest = decoded.content;
  const launch = manifest.launchConfiguration;
  const mountPolicy = Object.freeze({
    gateway: launch.gateway.mounts,
    harness: launch.harness.mounts,
  });
  const runtimeFlags = Object.freeze({
    gateway: launch.gateway.runtimeClass,
    harness: launch.harness.runtimeClass,
    runtime: launch.runtime,
  });
  const projections = Object.freeze({
    manifest,
    artifactSet: manifest.artifactSet,
    launchConfiguration: launch,
    providerProfile: Object.freeze({
      target: manifest.target,
      placement: launch.placement,
      physicalCreator: manifest.evidenceRequirements.physicalCreator,
    }),
    runtimeProfile: Object.freeze({
      artifactSet: manifest.artifactSet,
      launchConfiguration: launch,
    }),
    identityProfile: Object.freeze({
      identity: manifest.endpoints.identity,
      bootstrap: manifest.evidenceRequirements.bootstrap,
      credentials: launch.credentials,
    }),
    containment: manifest.containment,
    storageProfile: Object.freeze({
      mountPolicy,
      context: manifest.evidenceRequirements.context,
      replacement: manifest.evidenceRequirements.replacement,
    }),
    endpoints: manifest.endpoints,
    evidenceRequirements: manifest.evidenceRequirements,
    mountPolicy,
    resourceEnvelope: launch.resourceEnvelope,
    runtimeFlags,
  });
  const digests = Object.freeze({
    manifestDigest: workloadProfileDigest("manifestDigest", manifest),
    artifactSetDigest: workloadProfileDigest("artifactSetDigest", projections.artifactSet),
    launchConfigurationDigest: workloadProfileDigest("launchConfigurationDigest", launch),
    providerProfileDigest: workloadProfileDigest(
      "providerProfileDigest",
      projections.providerProfile,
    ),
    runtimeProfileDigest: workloadProfileDigest("runtimeProfileDigest", projections.runtimeProfile),
    identityProfileDigest: workloadProfileDigest(
      "identityProfileDigest",
      projections.identityProfile,
    ),
    containmentDigest: workloadProfileDigest("containmentDigest", projections.containment),
    storageProfileDigest: workloadProfileDigest("storageProfileDigest", projections.storageProfile),
    endpointsDigest: workloadProfileDigest("endpointsDigest", projections.endpoints),
    evidenceRequirementsDigest: workloadProfileDigest(
      "evidenceRequirementsDigest",
      projections.evidenceRequirements,
    ),
    mountPolicyDigest: workloadProfileDigest("mountPolicyDigest", mountPolicy),
    resourceEnvelopeDigest: workloadProfileDigest(
      "resourceEnvelopeDigest",
      projections.resourceEnvelope,
    ),
    runtimeFlagsDigest: workloadProfileDigest("runtimeFlagsDigest", runtimeFlags),
  });
  return Object.freeze({
    ...decoded,
    projections,
    digests,
    // The two application images are not the original component-only image-set
    // projection, which also includes every init/helper container in its actual
    // qualified renderer. Never hash the pair artifact set into that domain.
    unavailableDigests: Object.freeze({
      imageSetDigest: "renderer-container-projection-required" as const,
      admittedConfigurationDigest: "deployment-inputs-required" as const,
    }),
    roleDigests: Object.freeze({
      provider: digests.providerProfileDigest,
      runtime: digests.runtimeProfileDigest,
      identity: digests.identityProfileDigest,
      containment: digests.containmentDigest,
      storage: digests.storageProfileDigest,
    }),
  });
}

export type DerivedWorkloadProfileManifestV2 = ReturnType<typeof deriveWorkloadProfileManifestV2>;
export type WorkloadProfilePairLaunchV2 = WorkloadProfileManifestContentV2["launchConfiguration"];

type Artifact<R extends WorkloadProfileManifestArtifactV1["role"]> = Extract<
  WorkloadProfileManifestArtifactV1,
  { readonly role: R }
>;
type Producer<C extends WorkloadProfileManifestClaimV1> = Extract<
  WorkloadProfileManifestProducerV1,
  { readonly claim: C }
>;

export interface WorkloadProfileManifestProjectionsV1 {
  readonly manifest: Content;
  readonly artifactSet: Content["artifactSet"];
  readonly launchConfiguration: Launch;
  readonly providerProfile: {
    readonly target: Content["target"];
    readonly runtimeApplicability: Pick<
      Launch["runtime"],
      "runtimeClass" | "handler" | "type" | "platform" | "sidecarUsagePolicy"
    >;
    readonly effectRequirements: readonly Producer<
      "closed-provider-effects" | "protected-service-and-preparation"
    >[];
    readonly beforeAnyWrite: Launch["beforeAnyWrite"];
  };
  readonly runtimeProfile: {
    readonly artifacts: readonly Artifact<
      "gvisor-node-distribution" | "harness-native" | "kubernetes-node" | "pod-sandbox-image"
    >[];
    readonly launchConfiguration: Launch;
    readonly instanceRequirement: Producer<"exact-instance-and-restart">;
  };
  readonly identityProfile: {
    readonly wholeHarnessIdentity: Content["containment"]["wholeHarnessIdentity"];
    readonly mechanismSelection: Content["evidenceRequirements"]["mechanismSelection"];
    readonly identityAndAuthority: Content["endpoints"]["identityAndAuthority"];
    readonly applicationToken: Launch["mountPolicy"]["applicationToken"];
    readonly claims: readonly Producer<
      "authenticated-peer" | "exact-instance-and-restart" | "identity-verification"
    >[];
  };
  readonly containment: Content["containment"];
  readonly storageProfile: {
    readonly mountPolicy: Launch["mountPolicy"];
    readonly storeBinding: Launch["serverBindingParameters"]["stores"];
    readonly beforeAnyWrite: Launch["beforeAnyWrite"];
  };
  readonly endpoints: Content["endpoints"];
  readonly evidenceRequirements: Content["evidenceRequirements"];
  readonly mountPolicy: Launch["mountPolicy"];
  readonly resourceEnvelope: Launch["resourceEnvelope"];
  readonly runtimeFlags: Launch["runtime"];
}

export interface WorkloadProfileManifestDigestsV1 {
  readonly manifestDigest: string;
  readonly artifactSetDigest: string;
  readonly launchConfigurationDigest: string;
  readonly providerProfileDigest: string;
  readonly runtimeProfileDigest: string;
  readonly identityProfileDigest: string;
  readonly containmentDigest: string;
  readonly storageProfileDigest: string;
  readonly endpointsDigest: string;
  readonly evidenceRequirementsDigest: string;
  readonly mountPolicyDigest: string;
  readonly resourceEnvelopeDigest: string;
  readonly runtimeFlagsDigest: string;
}

export interface DerivedWorkloadProfileManifestV1 extends DecodedWorkloadProfileManifestV1 {
  readonly projections: WorkloadProfileManifestProjectionsV1;
  readonly digests: WorkloadProfileManifestDigestsV1;
  readonly roleDigests: {
    readonly provider: string;
    readonly runtime: string;
    readonly identity: string;
    readonly containment: string;
    readonly storage: string;
  };
  readonly unavailableDigests: {
    readonly imageSetDigest: "unresolved-platform-images";
    readonly admittedConfigurationDigest: "deployment-inputs-required";
  };
}

function artifact<R extends WorkloadProfileManifestArtifactV1["role"]>(
  content: Content,
  role: R,
): Artifact<R> {
  const matches = content.artifactSet.filter((entry) => entry.role === role);
  if (matches.length !== 1) throw new WorkloadProfileManifestError("invalid-reference");
  return matches[0] as Artifact<R>;
}

function producer<C extends WorkloadProfileManifestClaimV1>(
  content: Content,
  claim: C,
): Producer<C> {
  const matches = content.evidenceRequirements.requiredProducers.filter(
    (entry) => entry.claim === claim,
  );
  if (matches.length !== 1) throw new WorkloadProfileManifestError("invalid-reference");
  return matches[0] as Producer<C>;
}

/** Derive only defined candidate byte identities from a freshly decoded closed
 * definition. This allocates no roles, verifies no source provenance, and grants
 * no profile admission or runtime capability. Callers cannot inject a projection
 * or substitute an unchecked typed object for the byte-input validation boundary. */
export function deriveWorkloadProfileManifest(input: Uint8Array): DerivedWorkloadProfileManifestV1 {
  const decoded = decodeWorkloadProfileManifest(input);
  const content = decoded.content;
  const launch = content.launchConfiguration;
  // Each constructed object has exactly the keys belonging to its own domain.
  // Selectors are in ASCII order; source set order was already normalized.
  const projections: WorkloadProfileManifestProjectionsV1 = Object.freeze({
    manifest: content,
    artifactSet: content.artifactSet,
    launchConfiguration: launch,
    providerProfile: Object.freeze({
      target: content.target,
      runtimeApplicability: Object.freeze({
        runtimeClass: launch.runtime.runtimeClass,
        handler: launch.runtime.handler,
        type: launch.runtime.type,
        platform: launch.runtime.platform,
        sidecarUsagePolicy: launch.runtime.sidecarUsagePolicy,
      }),
      effectRequirements: Object.freeze([
        producer(content, "closed-provider-effects"),
        producer(content, "protected-service-and-preparation"),
      ]),
      beforeAnyWrite: launch.beforeAnyWrite,
    }),
    runtimeProfile: Object.freeze({
      artifacts: Object.freeze([
        artifact(content, "gvisor-node-distribution"),
        artifact(content, "harness-native"),
        artifact(content, "kubernetes-node"),
        artifact(content, "pod-sandbox-image"),
      ]),
      launchConfiguration: launch,
      instanceRequirement: producer(content, "exact-instance-and-restart"),
    }),
    identityProfile: Object.freeze({
      wholeHarnessIdentity: content.containment.wholeHarnessIdentity,
      mechanismSelection: content.evidenceRequirements.mechanismSelection,
      identityAndAuthority: content.endpoints.identityAndAuthority,
      applicationToken: launch.mountPolicy.applicationToken,
      claims: Object.freeze([
        producer(content, "authenticated-peer"),
        producer(content, "exact-instance-and-restart"),
        producer(content, "identity-verification"),
      ]),
    }),
    containment: content.containment,
    storageProfile: Object.freeze({
      mountPolicy: launch.mountPolicy,
      storeBinding: launch.serverBindingParameters.stores,
      beforeAnyWrite: launch.beforeAnyWrite,
    }),
    endpoints: content.endpoints,
    evidenceRequirements: content.evidenceRequirements,
    mountPolicy: launch.mountPolicy,
    resourceEnvelope: launch.resourceEnvelope,
    runtimeFlags: launch.runtime,
  });
  const digests: WorkloadProfileManifestDigestsV1 = Object.freeze({
    manifestDigest: workloadProfileDigest("manifestDigest", projections.manifest),
    artifactSetDigest: workloadProfileDigest("artifactSetDigest", projections.artifactSet),
    launchConfigurationDigest: workloadProfileDigest(
      "launchConfigurationDigest",
      projections.launchConfiguration,
    ),
    providerProfileDigest: workloadProfileDigest(
      "providerProfileDigest",
      projections.providerProfile,
    ),
    runtimeProfileDigest: workloadProfileDigest("runtimeProfileDigest", projections.runtimeProfile),
    identityProfileDigest: workloadProfileDigest(
      "identityProfileDigest",
      projections.identityProfile,
    ),
    containmentDigest: workloadProfileDigest("containmentDigest", projections.containment),
    storageProfileDigest: workloadProfileDigest("storageProfileDigest", projections.storageProfile),
    endpointsDigest: workloadProfileDigest("endpointsDigest", projections.endpoints),
    evidenceRequirementsDigest: workloadProfileDigest(
      "evidenceRequirementsDigest",
      projections.evidenceRequirements,
    ),
    mountPolicyDigest: workloadProfileDigest("mountPolicyDigest", projections.mountPolicy),
    resourceEnvelopeDigest: workloadProfileDigest(
      "resourceEnvelopeDigest",
      projections.resourceEnvelope,
    ),
    runtimeFlagsDigest: workloadProfileDigest("runtimeFlagsDigest", projections.runtimeFlags),
  });
  return Object.freeze({
    content,
    canonicalBytes: decoded.canonicalBytes,
    projections,
    digests,
    roleDigests: Object.freeze({
      provider: digests.providerProfileDigest,
      runtime: digests.runtimeProfileDigest,
      identity: digests.identityProfileDigest,
      containment: digests.containmentDigest,
      storage: digests.storageProfileDigest,
    }),
    // No image-set hash of unresolved objects and no revision hash of server
    // descriptors. Actual resolved variants/Configuration inputs need their
    // owning accepted codecs before these domains can become available.
    unavailableDigests: Object.freeze({
      imageSetDigest: "unresolved-platform-images" as const,
      admittedConfigurationDigest: "deployment-inputs-required" as const,
    }),
  });
}
