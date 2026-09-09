import {
  parseRuntimeResourceAccountingV1,
  type RuntimeResourceAccountingEnvelopeV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
  type WorkloadProfileJsonValue,
} from "./canonical.ts";

export const WORKLOAD_PROFILE_MANIFEST_LIMITS_V1 = Object.freeze({
  documentaryTextBytes: 2_048,
  artifactNameBytes: 255,
});

export type WorkloadProfileManifestErrorCode =
  "invalid-shape" | "invalid-value" | "duplicate-identity" | "invalid-reference";

export class WorkloadProfileManifestError extends Error {
  readonly code: WorkloadProfileManifestErrorCode;

  constructor(code: WorkloadProfileManifestErrorCode) {
    super(`Invalid workload profile manifest: ${code}`);
    this.name = "WorkloadProfileManifestError";
    this.code = code;
  }
}

function reject(code: WorkloadProfileManifestErrorCode): never {
  throw new WorkloadProfileManifestError(code);
}

type Json = WorkloadProfileJsonValue;
type Rule<T extends Json = Json> = (input: Json) => T;
type Value<R> = R extends Rule<infer T> ? T : never;
type JsonObject = { readonly [key: string]: Json };

function asObject(input: Json): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    reject("invalid-shape");
  }
  return input as JsonObject;
}

function literal<const T extends string | number | boolean>(expected: T): Rule<T> {
  return (input) => {
    if (input !== expected) reject("invalid-value");
    return expected;
  };
}

function object<const S extends { readonly [key: string]: Rule }>(
  fields: S,
): Rule<{ readonly [K in keyof S]: Value<S[K]> }> {
  const names = Object.keys(fields);
  return (input) => {
    const original = asObject(input);
    if (
      Object.keys(original).length !== names.length ||
      names.some((name) => !Object.hasOwn(original, name))
    ) {
      reject("invalid-shape");
    }
    const result: { [key: string]: Json } = Object.create(null);
    for (const name of names) result[name] = fields[name]!(original[name]!);
    return Object.freeze(result) as { readonly [K in keyof S]: Value<S[K]> };
  };
}

function text(pattern: RegExp, maxBytes: number): Rule<string> {
  return (input) => {
    if (
      typeof input !== "string" ||
      input.length === 0 ||
      input.length > maxBytes ||
      Buffer.byteLength(input, "utf8") > maxBytes ||
      !pattern.test(input)
    ) {
      reject("invalid-value");
    }
    return input;
  };
}

// Variable documentary leaves remain hashed exactly, but are never interpreted
// as authority, qualification, selected behavior or resolution of a missing input.
const documentary = text(
  /^[^\u0000-\u001f\u007f-\u009f]+$/u,
  WORKLOAD_PROFILE_MANIFEST_LIMITS_V1.documentaryTextBytes,
);
const gitObjectId = text(/^[0-9a-f]{40}$/, 40);
const rawSha256 = text(/^[0-9a-f]{64}$/, 64);
const sha256Digest = text(/^sha256:[0-9a-f]{64}$/, 71);
const artifactName = text(
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  WORKLOAD_PROFILE_MANIFEST_LIMITS_V1.artifactNameBytes,
);

function sequence<const T extends readonly (string | number | boolean)[]>(expected: T): Rule<T> {
  return (input) => {
    if (!Array.isArray(input) || input.length !== expected.length) reject("invalid-shape");
    if (expected.some((value, index) => input[index] !== value)) reject("invalid-value");
    return Object.freeze([...expected]) as unknown as T;
  };
}

function stringSet<const T extends readonly string[]>(expected: T): Rule<readonly T[number][]> {
  const allowed = new Set<string>(expected);
  return (input) => {
    if (!Array.isArray(input) || input.length !== expected.length) reject("invalid-shape");
    const found = new Set<string>();
    for (const value of input) {
      if (typeof value !== "string" || !allowed.has(value)) reject("invalid-reference");
      if (found.has(value)) reject("duplicate-identity");
      found.add(value);
    }
    return Object.freeze([...found].sort()) as readonly T[number][];
  };
}

/** Each named variant has its own closed field dictionary. An unknown name,
 * duplicate identity or omitted variant cannot produce a partial normalized set. */
function namedSet<const S extends { readonly [key: string]: Rule }>(
  identity: string,
  variants: S,
): Rule<readonly Value<S[keyof S]>[]> {
  const count = Object.keys(variants).length;
  return (input) => {
    if (!Array.isArray(input) || input.length !== count) reject("invalid-shape");
    const found = new Set<string>();
    const entries: Array<readonly [string, Json]> = [];
    for (const entry of input) {
      const name = asObject(entry)[identity];
      if (typeof name !== "string" || !Object.hasOwn(variants, name)) {
        reject("invalid-reference");
      }
      if (found.has(name)) reject("duplicate-identity");
      found.add(name);
      entries.push([name, variants[name]!(entry)]);
    }
    entries.sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    return Object.freeze(entries.map(([, value]) => value)) as readonly Value<S[keyof S]>[];
  };
}

function unresolved<const C extends string>(code: C) {
  return object({
    status: literal("unresolved"),
    code: literal(code),
    owner: documentary,
    required: documentary,
  });
}

// A static selection retains original accounting inputs, never an observation or
// the accounting validator's result. Feasibility and current admission are separate.
const staticAccountingEnvelope: Rule<RuntimeResourceAccountingEnvelopeV1> = (input) => {
  let envelope: RuntimeResourceAccountingEnvelopeV1;
  try {
    envelope = parseRuntimeResourceAccountingV1(input);
  } catch {
    return reject("invalid-value");
  }
  for (const component of ["gateway", "harness"] as const) {
    const observation = envelope.observations[component];
    if (observation.status !== "unavailable" || observation.reason !== "producer-port-unavailable")
      reject("invalid-value");
  }
  return envelope;
};
const unresolvedAccounting = unresolved("L10");
const selectedAccounting = object({
  status: literal("selected"),
  envelope: staticAccountingEnvelope,
});
const podAndRuntimeAccounting: Rule<
  Value<typeof unresolvedAccounting> | Value<typeof selectedAccounting>
> = (input) =>
  asObject(input).status === "unresolved" ? unresolvedAccounting(input) : selectedAccounting(input);

function serverBound<const A extends string, const S extends string, const V extends string>(
  authority: A,
  stage: S,
  valueType: V,
) {
  return object({
    status: literal("server-bound"),
    authority: literal(authority),
    stage: literal(stage),
    valueType: literal(valueType),
  });
}

function role<const R extends string>(name: R) {
  return serverBound(
    "same canonical operator manifest/admission unit",
    "preallocated-once-before-final-admission; actual IDs live in envelope",
    `immutable role ref/version/contentDigest for ${name} projection; no independent role registry`,
  );
}

function resources<const C extends number, const M extends number, const E extends number>(
  cpuMilli: C,
  memoryBytes: M,
  ephemeralStorageBytes: E,
) {
  return object({
    cpuMilli: literal(cpuMilli),
    memoryBytes: literal(memoryBytes),
    ephemeralStorageBytes: literal(ephemeralStorageBytes),
  });
}

const source = object({
  commit: gitObjectId,
  tree: gitObjectId,
  receiptSha256: rawSha256,
  availability: literal("accepted-local-source"),
  qualification: literal("no-image-or-execution-claim"),
});
const archive = object({ name: artifactName, sha256: rawSha256 });
const distributionMember = <const N extends string>(name: N) =>
  object({ name: literal(name), sha256: rawSha256 });

const artifacts = namedSet("role", {
  "enterprise-controller": object({
    role: literal("enterprise-controller"),
    source,
    image: unresolved("A01"),
  }),
  gateway: object({
    role: literal("gateway"),
    source,
    packageArchive: object({
      name: artifactName,
      sha256: rawSha256,
      sourceUnion: gitObjectId,
      correspondence: documentary,
    }),
    image: unresolved("A02"),
    selectedExternalResourceEnvelope: object({
      requests: resources(250, 536_870_912, 268_435_456),
      limits: resources(1_000, 1_073_741_824, 1_073_741_824),
      scope: literal("separate trusted gateway; excluded from Harness image/resource projection"),
    }),
  }),
  "gateway-msteams-package": object({
    role: literal("gateway-msteams-package"),
    archive,
    provenance: documentary,
  }),
  "gateway-slack-package": object({
    role: literal("gateway-slack-package"),
    archive,
    provenance: documentary,
  }),
  "gvisor-node-distribution": object({
    role: literal("gvisor-node-distribution"),
    sourceCommit: gitObjectId,
    version: literal("release-20260831.0"),
    archiveSha256: rawSha256,
    members: namedSet("name", {
      "containerd-shim-runsc-v1": distributionMember("containerd-shim-runsc-v1"),
      "gvisor-bin/checkpointgofer": distributionMember("gvisor-bin/checkpointgofer"),
      "gvisor-bin/gvisor-sentry-prewarmer": distributionMember(
        "gvisor-bin/gvisor-sentry-prewarmer",
      ),
      "gvisor-bin/gvisor_sentry": distributionMember("gvisor-bin/gvisor_sentry"),
      "gvisor-bin/runsc-metric-server": distributionMember("gvisor-bin/runsc-metric-server"),
      runsc: distributionMember("runsc"),
    }),
    runscVersion: literal("release-20260831.0"),
    shimVersion: literal("2.1.5+unknown"),
    provenance: documentary,
    installedConfiguration: unresolved("A03"),
  }),
  "harness-native": object({
    role: literal("harness-native"),
    source,
    officialBaseline: object({
      version: literal("0.153.0"),
      sourceCommit: gitObjectId,
      archiveDigest: sha256Digest,
      executableSha256: rawSha256,
      correspondence: documentary,
    }),
    executable: unresolved("A04"),
    image: unresolved("A05"),
  }),
  "kubernetes-node": object({
    role: literal("kubernetes-node"),
    version: literal("v1.34.11+k3s1"),
    sourceCommit: gitObjectId,
    ociIndexDigest: sha256Digest,
    linuxAmd64ManifestDigest: sha256Digest,
    kubernetes: literal("1.34.11"),
    containerd: literal("2.2.7-k3s1"),
    runc: literal("1.4.2"),
    flannel: literal("0.28.4"),
    provenance: documentary,
    hostAndAddonClosure: unresolved("A06"),
  }),
  "model-mediator": object({
    role: literal("model-mediator"),
    imageAndConfiguration: unresolved("A07"),
  }),
  "pod-sandbox-image": object({
    role: literal("pod-sandbox-image"),
    selectedName: literal("rancher/mirrored-pause:3.10.2"),
    platformDigest: unresolved("A08"),
  }),
  "repository-issuer": object({
    role: literal("repository-issuer"),
    imageAndConfiguration: unresolved("A09"),
  }),
  spire: object({
    role: literal("spire"),
    selectedVersion: literal("1.15.3"),
    selectedSourceCommit: gitObjectId,
    releaseMetadataDigest: sha256Digest,
    provenance: documentary,
    imageAndConfiguration: unresolved("A10"),
  }),
});

const containerSecurity = object({
  runAsUser: literal(1_000),
  runAsGroup: literal(1_000),
  runAsNonRoot: literal(true),
  readOnlyRootFilesystem: literal(true),
  allowPrivilegeEscalation: literal(false),
  capabilitiesDrop: sequence(["ALL"]),
  capabilitiesAdd: sequence([]),
  seccompProfile: literal("RuntimeDefault"),
});

function absolutePath<const P extends string>(expected: P): Rule<P> {
  return (input) => {
    if (
      typeof input !== "string" ||
      !input.startsWith("/") ||
      input.includes("\0") ||
      input.endsWith("/") ||
      input
        .split("/")
        .slice(1)
        .some((part) => part === "" || part === "." || part === "..")
    )
      reject("invalid-value");
    return literal(expected)(input);
  };
}

function relativePath<const P extends string>(expected: P): Rule<P> {
  return (input) => {
    if (
      typeof input !== "string" ||
      input.includes("\0") ||
      input.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      reject("invalid-value");
    return literal(expected)(input);
  };
}

function sharedMount<const N extends string, const P extends string, const R extends boolean>(
  name: N,
  path: P,
  readOnly: R,
) {
  return object({
    name: literal(name),
    container: literal("agent"),
    source: literal("shared-retained-store"),
    subpath: relativePath(name),
    path: absolutePath(path),
    readOnly: literal(readOnly),
  });
}

function localMount<
  const N extends string,
  const C extends string,
  const S extends string,
  const P extends string,
  const R extends boolean,
>(name: N, container: C, source: S, path: P, readOnly: R) {
  return object({
    name: literal(name),
    container: literal(container),
    source: literal(source),
    path: absolutePath(path),
    readOnly: literal(readOnly),
  });
}

const launchConfiguration = object({
  topology: object({
    kind: literal("Deployment"),
    replicas: literal(1),
    strategy: literal("Recreate"),
    restartPolicy: literal("Always"),
    terminationGracePeriodSeconds: literal(30),
    containerOrder: sequence(["prepare-private-state", "agent"]),
    selection: documentary,
  }),
  runtime: object({
    runtimeClass: literal("oce-gvisor-systrap"),
    handler: literal("oce-gvisor-systrap"),
    type: literal("io.containerd.runsc.v1"),
    platform: literal("systrap"),
    sidecarUsagePolicy: literal("STRICT"),
    sidecarReleaseEnforcementPolicy: literal("ALWAYS"),
    artifactRole: literal("gvisor-node-distribution"),
    installedPrefix: absolutePath("/opt/openclaw-enterprise/runtime/gvisor/release-20260831.0"),
    effectiveConfiguration: unresolved("L01"),
  }),
  pod: object({
    fsGroup: literal(1_000),
    hostNetwork: literal(false),
    hostPID: literal(false),
    hostIPC: literal(false),
    automountServiceAccountToken: literal(false),
    ephemeralContainers: literal("denied"),
    additionalContainers: literal("denied"),
    namespacePolicy: literal("Restricted; no exception"),
    supplementalGroups: unresolved("L02"),
  }),
  containers: namedSet("name", {
    agent: object({
      name: literal("agent"),
      kind: literal("main"),
      imageRole: literal("harness-native"),
      imagePlatformDigest: unresolved("L03"),
      argv: unresolved("L04"),
      environment: unresolved("L05"),
      security: containerSecurity,
    }),
    "prepare-private-state": object({
      name: literal("prepare-private-state"),
      kind: literal("init"),
      imageRole: literal("harness-native"),
      imagePlatformDigest: unresolved("L06"),
      argv: unresolved("L07"),
      environment: unresolved("L09"),
      security: containerSecurity,
      allowedWork: literal(
        "mkdir-only on owned runtime home; no shared store, network, package, identity, login, hook, restore or user work",
      ),
    }),
  }),
  mountPolicy: object({
    entries: namedSet("name", {
      "bundled-skills": sharedMount(
        "bundled-skills",
        "/home/node/openclaw-runtime-assets/bundled-skills",
        true,
      ),
      "generated-images": sharedMount(
        "generated-images",
        "/home/node/.codex/generated_images",
        false,
      ),
      "home-agent": localMount("home-agent", "agent", "runtime-home-emptydir", "/home/node", false),
      "home-init": localMount(
        "home-init",
        "prepare-private-state",
        "runtime-home-emptydir",
        "/home/node",
        false,
      ),
      "plugin-skills": sharedMount(
        "plugin-skills",
        "/home/node/openclaw-runtime-assets/plugin-skills",
        true,
      ),
      "service-principal": localMount(
        "service-principal",
        "agent",
        "application-token-projection",
        "/var/run/secrets/openclaw/service-principal",
        true,
      ),
      sessions: sharedMount("sessions", "/home/node/.openclaw/agents/main/sessions", true),
      tmp: localMount("tmp", "agent", "tmp-emptydir", "/tmp", false),
      workspace: sharedMount("workspace", "/home/node/workspace", false),
    }),
    emptyDirs: object({
      "runtime-home-emptydir": object({ sizeLimitBytes: literal(1_073_741_824) }),
      "tmp-emptydir": object({ sizeLimitBytes: literal(67_108_864) }),
    }),
    applicationToken: object({
      audience: literal("openclaw-enterprise"),
      expirationSeconds: literal(900),
      relativePath: relativePath("token"),
      defaultMode: unresolved("L08"),
      meaning: literal("application bootstrap only; not SPIRE enrollment or service authority"),
    }),
    sharedStorePolicy: object({
      sizeBytes: literal(42_949_672_960),
      filesystem: literal("ext4"),
      accessMode: literal("ReadWriteOnce"),
      provisioner: literal("kubernetes.io/no-provisioner"),
      volumeBindingMode: literal("WaitForFirstConsumer"),
      reclaimPolicy: literal("Retain"),
      nodeAffinity: literal("exact server-resolved admitted node"),
      sourceDelta: documentary,
    }),
    gatewayPrivateStoreMounts: literal("absent"),
    hostPaths: literal("absent"),
    newIdentityMounts: literal("absent-until-accepted-successor"),
  }),
  resourceEnvelope: object({
    containers: object({
      agent: object({
        requests: resources(500, 1_073_741_824, 1_073_741_824),
        limits: resources(2_000, 4_294_967_296, 4_294_967_296),
      }),
      "prepare-private-state": object({
        requests: resources(100, 67_108_864, 16_777_216),
        limits: resources(500, 268_435_456, 67_108_864),
      }),
    }),
    hostPodTaskCapCandidate: literal(256),
    podAndRuntimeAccounting,
  }),
  serverBindingParameters: object({
    deploymentScope: serverBound(
      "existing OCC management and revision authority",
      "deployment-admission",
      "InstallationId/NamespaceId/AgentId",
    ),
    configuration: serverBound(
      "existing immutable configuration authority",
      "deployment-admission",
      "ConfigurationRef/configurationGeneration/immutable content with secret references only",
    ),
    servicePrincipal: serverBound(
      "existing Agent ServiceAccount authority",
      "deployment-admission",
      "exact existing ServiceAccount/reference association",
    ),
    stores: serverBound(
      "existing store/reservation and preparation authority",
      "preparation-before-mutation",
      "exact Namespace/PVC/PV/store UID/subpath/profile/mode/reservation",
    ),
    providerObjects: serverBound(
      "protected Compute observed effect and owner-chain producer",
      "discovery-and-binding",
      "cluster/Namespace/Deployment/ReplicaSet/Pod UIDs and retained createEffectRef",
    ),
    execution: serverBound(
      "selected protected runsc instance/restart producer",
      "observation-and-binding",
      "runscSandboxId/runtimeInstanceRef/protectedRestartDiscriminator",
    ),
  }),
  beforeAnyWrite: literal(
    "current independent preparation/effect responsibility plus exact store ownership, all old possible writers resolved and actual predecessor execution terminated; includes init, repair and restart",
  ),
});

const claimNames = [
  "admitted-current-profile",
  "authenticated-peer",
  "closed-provider-effects",
  "exact-instance-and-restart",
  "identity-verification",
  "model-mediation",
  "observed-artifact-and-final-shape",
  "prelaunch-artifact-and-profile",
  "prior-writers-and-stores",
  "protected-service-and-preparation",
  "quiet-restore-native-guard",
  "repository-issuance",
] as const;
export type WorkloadProfileManifestClaimV1 = (typeof claimNames)[number];
const producer = <const C extends WorkloadProfileManifestClaimV1>(claim: C) =>
  object({ claim: literal(claim), owner: documentary, required: documentary });

const evidenceRequirements = object({
  requiredClaims: stringSet(claimNames),
  requiredProducers: namedSet("claim", {
    "admitted-current-profile": producer("admitted-current-profile"),
    "authenticated-peer": producer("authenticated-peer"),
    "closed-provider-effects": producer("closed-provider-effects"),
    "exact-instance-and-restart": producer("exact-instance-and-restart"),
    "identity-verification": producer("identity-verification"),
    "model-mediation": producer("model-mediation"),
    "observed-artifact-and-final-shape": producer("observed-artifact-and-final-shape"),
    "prelaunch-artifact-and-profile": producer("prelaunch-artifact-and-profile"),
    "prior-writers-and-stores": producer("prior-writers-and-stores"),
    "protected-service-and-preparation": producer("protected-service-and-preparation"),
    "quiet-restore-native-guard": producer("quiet-restore-native-guard"),
    "repository-issuance": producer("repository-issuance"),
  }),
  mechanismSelection: unresolved("Q01"),
  freshness: object({
    sourceMaxAgeMs: literal(15_000),
    uncertaintyMaxMs: literal(2_000),
    lookupMaxMs: literal(3_000),
    recheckMaxIntervalMs: literal(5_000),
    stricterPurposeBoundsPrevail: literal(true),
  }),
  stop: object({
    gracefulStopMs: literal(30_000),
    observationAttemptMs: literal(120_000),
    deadlineOutcome: literal("observed-complete-or-unknown; no assumed termination"),
  }),
  bindingApplicability: object({
    provider: literal("occ/kubernetes-gvisor"),
    component: literal("harness"),
    openShellFields: literal("forbidden"),
    restartChange: literal(
      "new immutable assignment/runtime generation; never refresh old binding",
    ),
  }),
  measurementStatus: documentary,
});

const prelaunchClaims = [
  "admitted-current-profile",
  "closed-provider-effects",
  "prelaunch-artifact-and-profile",
  "prior-writers-and-stores",
  "protected-service-and-preparation",
] as const;
const identifiedClaims = [
  "admitted-current-profile",
  "authenticated-peer",
  "exact-instance-and-restart",
  "identity-verification",
] as const;
function capability<
  const I extends string,
  const C extends readonly WorkloadProfileManifestClaimV1[],
>(id: I, requiredClaims: C) {
  return object({
    id: literal(id),
    status: literal("non-executable"),
    requiredClaims: stringSet(requiredClaims),
    reason: documentary,
  });
}

const contentRule = object({
  schemaVersion: literal(1),
  target: object({
    harnessId: literal("codex"),
    harnessVersion: literal("1.0.0"),
    placement: literal("dedicated"),
    component: literal("harness"),
    provider: literal("occ/kubernetes-gvisor"),
    architecture: literal("linux/amd64"),
    phase: literal("crawl"),
    fallback: literal("none"),
    gatewayPlacement: literal("separate-trusted-component"),
    permittedOperationScope: literal(
      "one exact server-admitted Installation and Namespace; no scope inheritance",
    ),
  }),
  profileRefs: object({
    provider: role("provider"),
    runtime: role("runtime"),
    identity: role("identity"),
    containment: role("containment"),
    storage: role("storage"),
  }),
  artifactSet: artifacts,
  launchConfiguration,
  containment: object({
    profile: unresolved("C01"),
    kvmRequired: literal(false),
    openShellGatewayRequired: literal(false),
    kataRequired: literal(false),
    privilegedOrAddedCapabilities: literal("denied"),
    longLivedPlatformCredentialsInHarness: literal("denied"),
    gatewayPrivateStateInHarness: literal("denied"),
    nativeGitHubCredential: literal(
      "only scoped short-lived token under its exact current purpose",
    ),
    wholeHarnessIdentity: literal(
      "same-privilege Codex/tools; never human or privileged service authority",
    ),
    supportedRunnableTuple: literal(false),
  }),
  endpoints: object({
    networkFamily: literal("IPv4-only; unsupported IPv6 denied"),
    modelMediator: unresolved("E01"),
    repositoryIssuer: unresolved("E02"),
    nativeGitHub: object({
      authorities: stringSet(["api.github.com:443", "github.com:443"]),
      operations: literal("selected HTTPS API and smart-HTTP only"),
      enforcement: unresolved("E03"),
    }),
    harnessTransport: unresolved("E04"),
    identityAndAuthority: unresolved("E05"),
  }),
  evidenceRequirements,
  capabilities: namedSet("id", {
    "initial-binding": capability("initial-binding", [
      "admitted-current-profile",
      "closed-provider-effects",
      "exact-instance-and-restart",
      "observed-artifact-and-final-shape",
      "protected-service-and-preparation",
    ]),
    "materialize-harness": capability("materialize-harness", prelaunchClaims),
    "model-call": capability("model-call", [...identifiedClaims, "model-mediation"]),
    "native-repository": capability("native-repository", [
      ...identifiedClaims,
      "repository-issuance",
    ]),
    "quiet-completed-context-restore": capability("quiet-completed-context-restore", [
      ...identifiedClaims,
      "prior-writers-and-stores",
      "quiet-restore-native-guard",
    ]),
    readiness: capability("readiness", [
      ...identifiedClaims,
      "observed-artifact-and-final-shape",
      "protected-service-and-preparation",
    ]),
    "serving-runtime-peer": capability("serving-runtime-peer", [
      ...identifiedClaims,
      "observed-artifact-and-final-shape",
    ]),
    "writable-replacement": capability("writable-replacement", prelaunchClaims),
  }),
});

/** Closed normalized definition data. This type carries no operator or runtime authority. */
export type WorkloadProfileManifestContentV1 = Value<typeof contentRule>;
export type WorkloadProfileManifestArtifactV1 =
  WorkloadProfileManifestContentV1["artifactSet"][number];
export type WorkloadProfileManifestProducerV1 =
  WorkloadProfileManifestContentV1["evidenceRequirements"]["requiredProducers"][number];

export interface DecodedWorkloadProfileManifestV1 {
  readonly content: WorkloadProfileManifestContentV1;
  /** Independently allocated; changing these bytes cannot change content. */
  readonly canonicalBytes: Uint8Array;
}

function checkReferences(content: WorkloadProfileManifestContentV1): void {
  const launch = content.launchConfiguration;
  const artifactRoles = new Set<string>(content.artifactSet.map((entry) => entry.role));
  const containerNames = new Set<string>(launch.containers.map((entry) => entry.name));
  const claims = new Set<string>(content.evidenceRequirements.requiredClaims);
  if (
    !artifactRoles.has(launch.runtime.artifactRole) ||
    launch.containers.some((entry) => !artifactRoles.has(entry.imageRole)) ||
    launch.topology.containerOrder.some((name) => !containerNames.has(name)) ||
    launch.mountPolicy.entries.some((entry) => !containerNames.has(entry.container)) ||
    Object.keys(launch.resourceEnvelope.containers).some((name) => !containerNames.has(name)) ||
    content.evidenceRequirements.requiredProducers.some((entry) => !claims.has(entry.claim)) ||
    content.capabilities.some((entry) =>
      entry.requiredClaims.some((claim) => !claims.has(claim)),
    ) ||
    content.target.provider !== content.evidenceRequirements.bindingApplicability.provider ||
    content.target.component !== content.evidenceRequirements.bindingApplicability.component
  )
    reject("invalid-reference");
}

/** Validate the candidate definition and normalize only its declared sets.
 * Missing inputs remain missing, including those in a selected accounting seed.
 * Successful decoding does not
 * authenticate documentary/source claims, admit a profile, resolve server-bound
 * values or establish qualification/currentness. A canonical transport envelope
 * must separately compare these normalized bytes with its claimed content. */
export function decodeWorkloadProfileManifest(input: Uint8Array): DecodedWorkloadProfileManifestV1 {
  const lexical = decodeWorkloadProfileJson(input);
  const content = contentRule(lexical.value);
  checkReferences(content);
  const canonicalBytes = canonicalizeWorkloadProfileJson(content);
  return Object.freeze({ content, canonicalBytes });
}

// Version 2 describes the complete selected pair. Version 1 remains the exact
// non-executable Harness candidate above; no unresolved leaf is promoted in place.
const positiveVersion: Rule<number> = (value) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    reject("invalid-value");
  return value;
};
const referenceName = text(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/, 255);
const selectedRecord = object({
  ref: referenceName,
  version: positiveVersion,
  contentDigest: sha256Digest,
});
const selectedPath = text(/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/, 1024);
function boundedList<T extends Json>(rule: Rule<T>, min: number, max: number): Rule<readonly T[]> {
  return (value) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) reject("invalid-shape");
    return Object.freeze(value.map(rule));
  };
}
function choice<const T extends readonly string[]>(values: T): Rule<T[number]> {
  return (value) => {
    if (typeof value !== "string" || !values.includes(value)) reject("invalid-value");
    return value as T[number];
  };
}
const argumentLiteral = object({ kind: literal("literal"), value: documentary });
const argumentBinding = object({
  kind: literal("binding"),
  name: choice(["configuration-path", "state-path", "bootstrap-socket"] as const),
});
const argument: Rule<Value<typeof argumentLiteral> | Value<typeof argumentBinding>> = (value) =>
  asObject(value).kind === "literal" ? argumentLiteral(value) : argumentBinding(value);
const selectedExecutable = object({ path: selectedPath, contentDigest: sha256Digest });
const selectedImage = object({
  reference: documentary,
  platformDigest: sha256Digest,
  executable: selectedExecutable,
});
const pairArtifacts = object({ gateway: selectedImage, harness: selectedImage });
const moduleDefinition = object({
  id: artifactName,
  kind: choice(["identity", "channel", "harness", "persistence"] as const),
  definition: selectedRecord,
  artifactDigest: sha256Digest,
});
const selectedMount = object({
  name: artifactName,
  path: selectedPath,
  store: selectedRecord,
  access: choice(["read-only", "read-write"] as const),
});
// Application operands only. The selected runtime.implementation below closes
// the complete renderer, including every init/helper, readiness hook, security,
// volume/subPath and accounting-to-container mapping. Nothing is inherited from
// an unbound legacy Pod template.
const processLaunch = object({
  argv: boundedList(argument, 1, 32),
  environmentDefinition: selectedRecord,
  runtimeClass: artifactName,
  protocolVersion: positiveVersion,
  stateSchemaVersion: positiveVersion,
  agentSchemaVersion: positiveVersion,
  mounts: boundedList(selectedMount, 1, 16),
});

export const WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 = Object.freeze([
  "fixed-gateway-start",
  "fixed-harness-start",
  "independent-bootstrap",
  "current-identity",
  "channel-material-delivery",
  "complete-initial-writer-closure",
  "quiet-context-restore",
  "retained-participant-interlock",
  "guarded-serving",
  "model-mediation",
  "repository-issuance",
] as const);
export type WorkloadProfilePairCapabilityV2 =
  (typeof WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2)[number];
const selectedCapability = object({
  id: choice(WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2),
  implementation: selectedRecord,
});
const pairContentRule = object({
  schemaVersion: literal(2),
  target: object({
    component: literal("gateway-harness-pair"),
    provider: literal("occ/kubernetes-gvisor"),
    architecture: literal("linux/amd64"),
    placement: literal("dedicated"),
    fallback: literal("none"),
    subject: literal("installation-namespace-agent"),
  }),
  profileRefs: object({
    provider: role("provider"),
    runtime: role("runtime"),
    identity: role("identity"),
    containment: role("containment"),
    storage: role("storage"),
  }),
  artifactSet: pairArtifacts,
  launchConfiguration: object({
    gateway: processLaunch,
    harness: processLaunch,
    modules: boundedList(moduleDefinition, 1, 16),
    // This is an immutable logical placement, not a future Namespace/Pod UID.
    placement: object({ cluster: selectedRecord, namespaceAllocation: selectedRecord }),
    runtime: object({
      // The original immutable definition binds both the selected runsc setup
      // and Compute's complete fixed renderer. Its original capability producer
      // must resolve and verify that content before this pair can be selected.
      implementation: selectedRecord,
      handler: artifactName,
      platform: literal("systrap"),
    }),
    resourceEnvelope: object({ podAndRuntimeAccounting: selectedAccounting }),
    credentials: object({
      deliveryMode: literal("installation-channel-material-v1"),
      materialSelection: selectedRecord,
      pathCustody: selectedRecord,
      harnessPlatformCredentials: literal("forbidden"),
    }),
  }),
  containment: object({
    definition: selectedRecord,
    kvmRequired: literal(false),
    privileged: literal(false),
    gatewayPrivateStateInHarness: literal("forbidden"),
    supportedRunnableTuple: literal("requires-current-owner-validation"),
  }),
  endpoints: object({
    identity: selectedRecord,
    modelMediator: selectedRecord,
    repositoryIssuer: selectedRecord,
    harnessTransport: selectedRecord,
  }),
  evidenceRequirements: object({
    bootstrap: literal("independent-installation-service"),
    physicalCreator: literal("original-compute-createOriginal"),
    context: literal("initialize-new-or-resume-retained"),
    replacement: literal("exact-replaced-and-retained-participants"),
    capabilities: boundedList(
      selectedCapability,
      WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.length,
      WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.length,
    ),
  }),
});

/** Static complete definition only. Actual source qualification and every use's
 * current admitted association come from protected original participants. */
export type WorkloadProfileManifestContentV2 = Value<typeof pairContentRule>;
export interface DecodedWorkloadProfileManifestV2 {
  readonly content: WorkloadProfileManifestContentV2;
  readonly canonicalBytes: Uint8Array;
}

export function decodeWorkloadProfileManifestV2(
  input: Uint8Array,
): DecodedWorkloadProfileManifestV2 {
  const content = pairContentRule(decodeWorkloadProfileJson(input).value);
  const launch = content.launchConfiguration;
  const unique = (values: readonly string[]) => {
    if (new Set(values).size !== values.length) reject("duplicate-identity");
  };
  unique(launch.modules.map((item) => item.id));
  unique(content.evidenceRequirements.capabilities.map((item) => item.id));
  for (const kind of ["identity", "harness", "persistence"] as const)
    if (launch.modules.filter((item) => item.kind === kind).length !== 1)
      reject("invalid-reference");
  // Channels are selected explicitly by their module entries. An empty channel
  // set still requires the original identity, harness and persistence modules,
  // material/path selection and every capability; source owners verify topology.
  for (const component of ["gateway", "harness"] as const) {
    const process = launch[component];
    unique(process.mounts.map((item) => item.name));
    unique(process.mounts.map((item) => item.path));
    if (
      process.argv[0]?.kind !== "literal" ||
      process.argv[0].value !== content.artifactSet[component].executable.path
    )
      reject("invalid-reference");
    const image = content.artifactSet[component];
    if (!image.reference.endsWith(`@${image.platformDigest}`) || /\s/u.test(image.reference))
      reject("invalid-reference");
    for (const path of [image.executable.path, ...process.mounts.map((item) => item.path)])
      if (path.split("/").some((part) => part === "." || part === "..")) reject("invalid-value");
  }
  // Sharing a writable mount under two components needs the separately qualified
  // interlock and is represented explicitly by the same immutable store identity.
  return Object.freeze({ content, canonicalBytes: canonicalizeWorkloadProfileJson(content) });
}
