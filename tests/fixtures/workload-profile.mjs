import { randomUUID } from "node:crypto";
import {
  canonicalizeWorkloadProfileJson,
  workloadProfileDigest,
} from "../../packages/occ/src/workload-profiles/canonical.ts";
import { createMemoryWorkloadProfile } from "../../packages/occ/src/state/memory/workload-profile.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";

/** Synthetic dictionary fixture. Digests and source identities are test data;
 * every missing input and capability remains explicitly unavailable. */
export function workloadProfileManifestFixture() {
  const raw = (n) => n.repeat(64);
  const digest = (n) => `sha256:${raw(n)}`;
  const missing = (code) => ({
    status: "unresolved",
    code,
    owner: "fixture input producer",
    required: "The required definition or artifact has not been supplied.",
  });
  const source = () => ({
    commit: "1".repeat(40),
    tree: "2".repeat(40),
    receiptSha256: raw("3"),
    availability: "accepted-local-source",
    qualification: "no-image-or-execution-claim",
  });
  const bound = (authority, stage, valueType) => ({
    status: "server-bound",
    authority,
    stage,
    valueType,
  });
  const resources = (cpuMilli, memoryBytes, ephemeralStorageBytes) => ({
    cpuMilli,
    memoryBytes,
    ephemeralStorageBytes,
  });
  const security = () => ({
    runAsUser: 1000,
    runAsGroup: 1000,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilitiesDrop: ["ALL"],
    capabilitiesAdd: [],
    seccompProfile: "RuntimeDefault",
  });
  const claims = [
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
  ];
  const capability = (id, requiredClaims) => ({
    id,
    status: "non-executable",
    requiredClaims: [...requiredClaims].sort(),
    reason: "Required inputs are unavailable; this fixture grants no capability.",
  });
  const prelaunch = [
    "admitted-current-profile",
    "closed-provider-effects",
    "prelaunch-artifact-and-profile",
    "prior-writers-and-stores",
    "protected-service-and-preparation",
  ];
  const identified = [
    "admitted-current-profile",
    "authenticated-peer",
    "exact-instance-and-restart",
    "identity-verification",
  ];
  return {
    schemaVersion: 1,
    target: {
      harnessId: "codex",
      harnessVersion: "1.0.0",
      placement: "dedicated",
      component: "harness",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      phase: "crawl",
      fallback: "none",
      gatewayPlacement: "separate-trusted-component",
      permittedOperationScope:
        "one exact server-admitted Installation and Namespace; no scope inheritance",
    },
    profileRefs: Object.fromEntries(
      ["provider", "runtime", "identity", "containment", "storage"].map((role) => [
        role,
        bound(
          "same canonical operator manifest/admission unit",
          "preallocated-once-before-final-admission; actual IDs live in envelope",
          `immutable role ref/version/contentDigest for ${role} projection; no independent role registry`,
        ),
      ]),
    ),
    artifactSet: [
      { role: "enterprise-controller", source: source(), image: missing("A01") },
      {
        role: "gateway",
        source: source(),
        packageArchive: {
          name: "fixture-gateway.tgz",
          sha256: raw("4"),
          sourceUnion: "5".repeat(40),
          correspondence: "Synthetic package correspondence; no image or execution evidence.",
        },
        image: missing("A02"),
        selectedExternalResourceEnvelope: {
          requests: resources(250, 536870912, 268435456),
          limits: resources(1000, 1073741824, 1073741824),
          scope: "separate trusted gateway; excluded from Harness image/resource projection",
        },
      },
      {
        role: "gateway-msteams-package",
        archive: { name: "fixture-teams.tgz", sha256: raw("6") },
        provenance: "Synthetic archive identity.",
      },
      {
        role: "gateway-slack-package",
        archive: { name: "fixture-slack.tgz", sha256: raw("7") },
        provenance: "Synthetic archive identity.",
      },
      {
        role: "gvisor-node-distribution",
        sourceCommit: "8".repeat(40),
        version: "release-20260831.0",
        archiveSha256: raw("9"),
        members: [
          "containerd-shim-runsc-v1",
          "gvisor-bin/checkpointgofer",
          "gvisor-bin/gvisor-sentry-prewarmer",
          "gvisor-bin/gvisor_sentry",
          "gvisor-bin/runsc-metric-server",
          "runsc",
        ].map((name) => ({ name, sha256: raw("a") })),
        runscVersion: "release-20260831.0",
        shimVersion: "2.1.5+unknown",
        provenance: "Synthetic distribution identities; no installed-runtime evidence.",
        installedConfiguration: missing("A03"),
      },
      {
        role: "harness-native",
        source: source(),
        officialBaseline: {
          version: "0.153.0",
          sourceCommit: "b".repeat(40),
          archiveDigest: digest("c"),
          executableSha256: raw("d"),
          correspondence: "Synthetic baseline only; no correspondence to a modified executable.",
        },
        executable: missing("A04"),
        image: missing("A05"),
      },
      {
        role: "kubernetes-node",
        version: "v1.34.11+k3s1",
        sourceCommit: "e".repeat(40),
        ociIndexDigest: digest("f"),
        linuxAmd64ManifestDigest: digest("0"),
        kubernetes: "1.34.11",
        containerd: "2.2.7-k3s1",
        runc: "1.4.2",
        flannel: "0.28.4",
        provenance: "Synthetic node identities; no node qualification.",
        hostAndAddonClosure: missing("A06"),
      },
      { role: "model-mediator", imageAndConfiguration: missing("A07") },
      {
        role: "pod-sandbox-image",
        selectedName: "rancher/mirrored-pause:3.10.2",
        platformDigest: missing("A08"),
      },
      { role: "repository-issuer", imageAndConfiguration: missing("A09") },
      {
        role: "spire",
        selectedVersion: "1.15.3",
        selectedSourceCommit: "1".repeat(40),
        releaseMetadataDigest: digest("2"),
        provenance: "Synthetic identity-provider metadata; no deployed mechanism.",
        imageAndConfiguration: missing("A10"),
      },
    ],
    launchConfiguration: {
      topology: {
        kind: "Deployment",
        replicas: 1,
        strategy: "Recreate",
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 30,
        containerOrder: ["prepare-private-state", "agent"],
        selection: "Synthetic selected definition; not an installed guarantee.",
      },
      runtime: {
        runtimeClass: "oce-gvisor-systrap",
        handler: "oce-gvisor-systrap",
        type: "io.containerd.runsc.v1",
        platform: "systrap",
        sidecarUsagePolicy: "STRICT",
        sidecarReleaseEnforcementPolicy: "ALWAYS",
        artifactRole: "gvisor-node-distribution",
        installedPrefix: "/opt/openclaw-enterprise/runtime/gvisor/release-20260831.0",
        effectiveConfiguration: missing("L01"),
      },
      pod: {
        fsGroup: 1000,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        automountServiceAccountToken: false,
        ephemeralContainers: "denied",
        additionalContainers: "denied",
        namespacePolicy: "Restricted; no exception",
        supplementalGroups: missing("L02"),
      },
      containers: [
        {
          name: "agent",
          kind: "main",
          imageRole: "harness-native",
          imagePlatformDigest: missing("L03"),
          argv: missing("L04"),
          environment: missing("L05"),
          security: security(),
        },
        {
          name: "prepare-private-state",
          kind: "init",
          imageRole: "harness-native",
          imagePlatformDigest: missing("L06"),
          argv: missing("L07"),
          environment: missing("L09"),
          security: security(),
          allowedWork:
            "mkdir-only on owned runtime home; no shared store, network, package, identity, login, hook, restore or user work",
        },
      ],
      mountPolicy: {
        entries: [
          {
            name: "bundled-skills",
            container: "agent",
            source: "shared-retained-store",
            subpath: "bundled-skills",
            path: "/home/node/openclaw-runtime-assets/bundled-skills",
            readOnly: true,
          },
          {
            name: "generated-images",
            container: "agent",
            source: "shared-retained-store",
            subpath: "generated-images",
            path: "/home/node/.codex/generated_images",
            readOnly: false,
          },
          {
            name: "home-agent",
            container: "agent",
            source: "runtime-home-emptydir",
            path: "/home/node",
            readOnly: false,
          },
          {
            name: "home-init",
            container: "prepare-private-state",
            source: "runtime-home-emptydir",
            path: "/home/node",
            readOnly: false,
          },
          {
            name: "plugin-skills",
            container: "agent",
            source: "shared-retained-store",
            subpath: "plugin-skills",
            path: "/home/node/openclaw-runtime-assets/plugin-skills",
            readOnly: true,
          },
          {
            name: "service-principal",
            container: "agent",
            source: "application-token-projection",
            path: "/var/run/secrets/openclaw/service-principal",
            readOnly: true,
          },
          {
            name: "sessions",
            container: "agent",
            source: "shared-retained-store",
            subpath: "sessions",
            path: "/home/node/.openclaw/agents/main/sessions",
            readOnly: true,
          },
          {
            name: "tmp",
            container: "agent",
            source: "tmp-emptydir",
            path: "/tmp",
            readOnly: false,
          },
          {
            name: "workspace",
            container: "agent",
            source: "shared-retained-store",
            subpath: "workspace",
            path: "/home/node/workspace",
            readOnly: false,
          },
        ],
        emptyDirs: {
          "runtime-home-emptydir": { sizeLimitBytes: 1073741824 },
          "tmp-emptydir": { sizeLimitBytes: 67108864 },
        },
        applicationToken: {
          audience: "openclaw-enterprise",
          expirationSeconds: 900,
          relativePath: "token",
          defaultMode: missing("L08"),
          meaning: "application bootstrap only; not SPIRE enrollment or service authority",
        },
        sharedStorePolicy: {
          sizeBytes: 42949672960,
          filesystem: "ext4",
          accessMode: "ReadWriteOnce",
          provisioner: "kubernetes.io/no-provisioner",
          volumeBindingMode: "WaitForFirstConsumer",
          reclaimPolicy: "Retain",
          nodeAffinity: "exact server-resolved admitted node",
          sourceDelta: "Synthetic selected store policy; no mounted-store evidence.",
        },
        gatewayPrivateStoreMounts: "absent",
        hostPaths: "absent",
        newIdentityMounts: "absent-until-accepted-successor",
      },
      resourceEnvelope: {
        containers: {
          agent: {
            requests: resources(500, 1073741824, 1073741824),
            limits: resources(2000, 4294967296, 4294967296),
          },
          "prepare-private-state": {
            requests: resources(100, 67108864, 16777216),
            limits: resources(500, 268435456, 67108864),
          },
        },
        hostPodTaskCapCandidate: 256,
        podAndRuntimeAccounting: missing("L10"),
      },
      serverBindingParameters: {
        deploymentScope: bound(
          "existing OCC management and revision authority",
          "deployment-admission",
          "InstallationId/NamespaceId/AgentId",
        ),
        configuration: bound(
          "existing immutable configuration authority",
          "deployment-admission",
          "ConfigurationRef/configurationGeneration/immutable content with secret references only",
        ),
        servicePrincipal: bound(
          "existing Agent ServiceAccount authority",
          "deployment-admission",
          "exact existing ServiceAccount/reference association",
        ),
        stores: bound(
          "existing store/reservation and preparation authority",
          "preparation-before-mutation",
          "exact Namespace/PVC/PV/store UID/subpath/profile/mode/reservation",
        ),
        providerObjects: bound(
          "protected Compute observed effect and owner-chain producer",
          "discovery-and-binding",
          "cluster/Namespace/Deployment/ReplicaSet/Pod UIDs and retained createEffectRef",
        ),
        execution: bound(
          "selected protected runsc instance/restart producer",
          "observation-and-binding",
          "runscSandboxId/runtimeInstanceRef/protectedRestartDiscriminator",
        ),
      },
      beforeAnyWrite:
        "current independent preparation/effect responsibility plus exact store ownership, all old possible writers resolved and actual predecessor execution terminated; includes init, repair and restart",
    },
    containment: {
      profile: missing("C01"),
      kvmRequired: false,
      openShellGatewayRequired: false,
      kataRequired: false,
      privilegedOrAddedCapabilities: "denied",
      longLivedPlatformCredentialsInHarness: "denied",
      gatewayPrivateStateInHarness: "denied",
      nativeGitHubCredential: "only scoped short-lived token under its exact current purpose",
      wholeHarnessIdentity:
        "same-privilege Codex/tools; never human or privileged service authority",
      supportedRunnableTuple: false,
    },
    endpoints: {
      networkFamily: "IPv4-only; unsupported IPv6 denied",
      modelMediator: missing("E01"),
      repositoryIssuer: missing("E02"),
      nativeGitHub: {
        authorities: ["api.github.com:443", "github.com:443"],
        operations: "selected HTTPS API and smart-HTTP only",
        enforcement: missing("E03"),
      },
      harnessTransport: missing("E04"),
      identityAndAuthority: missing("E05"),
    },
    evidenceRequirements: {
      requiredClaims: claims,
      requiredProducers: claims.map((claim) => ({
        claim,
        owner: "fixture evidence producer",
        required: "Actual stage-specific evidence is required from its owning authority.",
      })),
      mechanismSelection: missing("Q01"),
      freshness: {
        sourceMaxAgeMs: 15000,
        uncertaintyMaxMs: 2000,
        lookupMaxMs: 3000,
        recheckMaxIntervalMs: 5000,
        stricterPurposeBoundsPrevail: true,
      },
      stop: {
        gracefulStopMs: 30000,
        observationAttemptMs: 120000,
        deadlineOutcome: "observed-complete-or-unknown; no assumed termination",
      },
      bindingApplicability: {
        provider: "occ/kubernetes-gvisor",
        component: "harness",
        openShellFields: "forbidden",
        restartChange: "new immutable assignment/runtime generation; never refresh old binding",
      },
      measurementStatus: "Synthetic data only; no measurements or runtime conformance.",
    },
    capabilities: [
      capability("initial-binding", [
        "admitted-current-profile",
        "closed-provider-effects",
        "exact-instance-and-restart",
        "observed-artifact-and-final-shape",
        "protected-service-and-preparation",
      ]),
      capability("materialize-harness", prelaunch),
      capability("model-call", [...identified, "model-mediation"]),
      capability("native-repository", [...identified, "repository-issuance"]),
      capability("quiet-completed-context-restore", [
        ...identified,
        "prior-writers-and-stores",
        "quiet-restore-native-guard",
      ]),
      capability("readiness", [
        ...identified,
        "observed-artifact-and-final-shape",
        "protected-service-and-preparation",
      ]),
      capability("serving-runtime-peer", [...identified, "observed-artifact-and-final-shape"]),
      capability("writable-replacement", prelaunch),
    ],
  };
}

/** Closed, unresolved content for inert storage; no actual approval or artifact. */
export function inertProfileRequest(overrides = {}) {
  const content = workloadProfileManifestFixture();
  return {
    schemaVersion: 1,
    operationRef: randomUUID(),
    namespaceId: `ns_${randomUUID()}`,
    component: "harness",
    action: "admit",
    expectedAdmission: null,
    manifest: {
      format: "oce.workload-profile.canonical-json.v1",
      canonicalUtf8: new TextDecoder().decode(canonicalizeWorkloadProfileJson(content)),
      manifestDigest: workloadProfileDigest("manifestDigest", content),
    },
    ...overrides,
  };
}
export function profileActorFixture() {
  return { accountRef: `account/${randomUUID()}`, principalRef: `principal/${randomUUID()}` };
}
/** Adapter test owner: isolated working snapshots and actual repository lifetime.
 * This does not implement the production account/IAM/platform transaction guard. */
export function profileStorageFixture(namespaceLifecycle = {}) {
  const installationId = `ins_${randomUUID()}`;
  const request = inertProfileRequest();
  const actor = profileActorFixture();
  let snapshot = {
    operations: new Map(),
    capacities: new Map(),
    namespaces: new Map([
      [
        request.namespaceId,
        {
          id: request.namespaceId,
          name: "Profile storage fixture",
          status: "ready",
          createdAt: "2026-09-06T00:00:00.000Z",
          ...namespaceLifecycle,
        },
      ],
    ]),
  };
  let allocations = 0;
  let clockReads = 0;
  let next = Promise.resolve();
  return {
    installationId,
    request,
    actor,
    locator: (
      operationRef = request.operationRef,
      acting = actor,
      installation = installationId,
    ) => ({ installationId: installation, actor: acting, operationRef }),
    get allocations() {
      return allocations;
    },
    get clockReads() {
      return clockReads;
    },
    get snapshot() {
      return structuredClone(snapshot);
    },
    transact(work) {
      const result = next.then(async () => {
        const working = structuredClone(snapshot);
        const lifetime = new RepositoryTransactionLifetime();
        const guard = new WorkloadProfileTransactionGuard();
        const repository = createMemoryWorkloadProfile(
          { scope: { installationId }, transaction: lifetime, snapshot: working },
          guard,
          {
            allocate() {
              allocations++;
              return randomUUID();
            },
          },
          () => {
            clockReads++;
            return "2026-09-06T00:00:00.000Z";
          },
        );
        try {
          const value = await work(repository);
          await guard.finish();
          await lifetime.finish();
          snapshot = working;
          return value;
        } finally {
          lifetime.close();
        }
      });
      next = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
