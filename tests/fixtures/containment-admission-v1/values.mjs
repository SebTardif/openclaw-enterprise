// Fictional contract data only. No producer is authenticated and no executable
// profile is admitted by these fixtures.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = (n) => `sha256:${String(n).padStart(64, "0")}`;
export const copy = (value) => JSON.parse(JSON.stringify(value));
const roles = ["provider", "runtime", "identity", "containment", "storage"];
export function selection() {
  return {
    manifestRef: id(10),
    manifestDigest: digest(10),
    admissionRef: id(11),
    admissionVersion: 1,
  };
}
export function profileUse() {
  return {
    schemaVersion: 1,
    installationId: `ins_${id(1)}`,
    namespaceId: `ns_${id(2)}`,
    component: "harness",
    ...selection(),
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    profileRefs: Object.fromEntries(
      roles.map((role, i) => [
        role,
        { ref: id(30 + i), version: 1, contentDigest: digest(30 + i) },
      ]),
    ),
    admittedConfigurationDigest: digest(40),
  };
}
export function document() {
  return {
    pod: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        labels: { fixture: "synthetic" },
        annotations: { "fixture.example/diagnostic": "only" },
      },
      spec: {
        containers: [
          {
            name: "agent",
            image: `fixture.invalid/agent@${digest(50)}`,
            imagePullPolicy: "IfNotPresent",
            command: ["node"],
            args: ["entrypoint.js", "first", "second"],
            env: [
              { name: "FIXTURE_SETTING", value: "synthetic" },
              {
                name: "FIXTURE_SOURCE",
                valueFrom: { configMapKeyRef: { name: "fixture-config", key: "setting" } },
              },
            ],
            envFrom: [],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              {
                name: "runtime-state",
                mountPath: "/home/node",
                readOnly: false,
                mountPropagation: "None",
              },
            ],
            resources: {
              requests: { cpu: "250m", memory: "64Mi", "ephemeral-storage": "8Mi" },
              limits: { cpu: "1", memory: "128Mi", "ephemeral-storage": "16Mi" },
            },
            readinessProbe: { exec: { command: ["node", "ready.js"] }, periodSeconds: 2 },
            livenessProbe: null,
            startupProbe: null,
            lifecycle: null,
          },
        ],
        initContainers: [
          {
            name: "prepare-private-state",
            image: `fixture.invalid/agent@${digest(50)}`,
            command: ["node"],
            args: ["prepare.js"],
            resources: { requests: { cpu: "100m", memory: "16Mi" } },
          },
        ],
        ephemeralContainers: [],
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          supplementalGroups: [],
          seccompProfile: { type: "RuntimeDefault" },
        },
        serviceAccountName: "fixture-agent",
        automountServiceAccountToken: false,
        volumes: [{ name: "runtime-state", emptyDir: { sizeLimit: "16Mi" } }],
        resources: {},
        overhead: {},
        dnsPolicy: "None",
        dnsConfig: { nameservers: ["192.0.2.53"], searches: [], options: [] },
        hostAliases: [],
        enableServiceLinks: false,
        restartPolicy: "Always",
        terminationGracePeriodSeconds: 20,
        runtimeClassName: "oce-gvisor-systrap",
        nodeSelector: { "fixture.example/runtime": "synthetic" },
        affinity: {},
        tolerations: [],
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
      },
    },
    controller: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { labels: { fixture: "synthetic" } },
      spec: {
        replicas: 1,
        strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 0, maxUnavailable: 1 } },
        template: { metadata: {}, spec: {} },
      },
    },
  };
}
export const fieldGroups = [
  "images-and-pull-policy",
  "ordered-commands-and-arguments",
  "init-main-ephemeral-containers",
  "probes-and-lifecycle-hooks",
  "environment-and-source-selectors",
  "process-security-and-identity",
  "mounts-volumes-and-propagation",
  "resources-overhead-and-defaults",
  "dns-hosts-and-service-links",
  "restart-termination-and-controller-update",
  "placement-and-runtime",
  "approved-annotations",
];
export function candidate() {
  const supplied = (owner) => ({ status: "supplied", owner, evidenceRef: `fixture/${owner}` });
  return {
    binding: {
      schemaVersion: 1,
      comparisonVersion: 1,
      normalizationVersion: 1,
      comparisonRef: id(12),
      profileContentDomain: "manifestDigest",
      target: {
        installationId: `ins_${id(1)}`,
        namespaceId: `ns_${id(2)}`,
        agentId: `agt_${id(3)}`,
        revisionId: `rev_${id(4)}`,
      },
      selection: selection(),
      profileUse: profileUse(),
      actualContentRef: "fixture/actual/1",
      expectedContentRef: "fixture/expected/1",
      diagnosticExclusions: [],
      subject: { stage: "candidate", requestRef: id(13), operation: "create" },
      serverBindings: {
        deploymentScope: supplied("deployment-authority"),
        configuration: supplied("configuration-authority"),
        servicePrincipal: supplied("service-account-authority"),
        stores: supplied("store-reservation-authority"),
        providerObjects: { status: "not-due", owner: "runtime-observer" },
        execution: { status: "not-due", owner: "runtime-observer" },
      },
    },
    expectation: { status: "available", fieldGroups: [...fieldGroups], document: document() },
    actual: document(),
  };
}
export function unavailableCandidate() {
  const value = candidate();
  value.binding.profileUse = null;
  value.binding.expectedContentRef = null;
  value.expectation = {
    status: "unavailable",
    reasonCode: "expectation-adapter-unavailable",
    missingFieldGroups: [...fieldGroups],
  };
  return value;
}
export function observation() {
  const target = {
    ...candidate().binding.target,
    assignmentRef: { schemaVersion: 1, id: id(60) },
    component: "harness",
    lifecycleGeneration: 2,
    runtimeGeneration: 2,
    createEffectRef: id(61),
  };
  const binding = {
    schemaVersion: 1,
    bindingVersion: 1,
    provider: "occ/kubernetes-gvisor",
    component: "harness",
    clusterRef: "fixture-cluster",
    kubernetesNamespaceUid: "fixture-namespace-uid",
    podUid: "fixture-pod-uid",
    deploymentUid: "fixture-deployment-uid",
    replicaSetUid: "fixture-replica-set-uid",
    imageDigests: [{ name: "agent", digest: digest(50) }],
    policyRevision: "fixture-policy-1",
    admittedConfigurationDigest: digest(40),
    profileDigests: { provider: digest(30), runtime: digest(31), identity: digest(32) },
    runtimeClass: "oce-gvisor-systrap",
    runtimeHandler: "oce-gvisor-systrap",
    runtimeType: "io.containerd.runsc.v1",
    platform: "systrap",
    isolation: "STRICT",
    runscSandboxId: "fixture-sandbox",
    runtimeInstanceRef: "fixture-execution",
    protectedRestartDiscriminator: "fixture-restart",
    runtimeBinaryDigest: digest(70),
    runtimeDistributionDigest: digest(71),
    runtimeFlagsDigest: digest(72),
  };
  const provenance = (ref) => ({
    producerRef: "fixture-producer",
    producerServiceVersion: 1,
    producerProfileRef: "fixture-profile",
    producerProfileDigest: digest(73),
    acceptedPortRef: "fixture-port",
    evidenceRef: `fixture/${ref}`,
    evidenceVersion: 2,
    clock: {
      sourceObservedAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.100Z",
      validUntil: "2026-01-01T00:00:15.000Z",
      uncertaintyMs: 100,
    },
  });
  return copy({
    schemaVersion: 1,
    status: "complete",
    input: {
      schemaVersion: 1,
      kind: "bound-instance",
      target,
      binding,
      expectedEvidenceVersion: 1,
    },
    object: {
      target: {
        targetRef: "fixture-deployment",
        clusterRef: binding.clusterRef,
        kubernetesNamespaceUid: binding.kubernetesNamespaceUid,
        apiKind: "Deployment",
        name: "fixture-deployment",
        ownerAssignmentRef: target.assignmentRef,
        ownerCreateEffectRef: target.createEffectRef,
      },
      uid: binding.deploymentUid,
      resourceVersion: "41",
      fenceEpoch: 2,
    },
    binding,
    observation: provenance("observation"),
    ownerChainEvidence: provenance("owner-chain"),
    executionCorrespondenceEvidence: provenance("execution"),
    profile: {
      desired: { profileRef: "fixture-desired", version: 3, digest: digest(80) },
      delivered: {
        profileRef: "fixture-delivered",
        version: 2,
        digest: digest(81),
        evidence: provenance("delivered"),
      },
      effective: {
        profileRef: "fixture-effective",
        version: 1,
        digest: digest(82),
        evidence: provenance("effective"),
      },
    },
    identityEvidence: null,
    eligibility: "observation-only",
  });
}
export function observed() {
  const value = candidate(),
    runtime = observation();
  value.binding.subject = {
    stage: "observed",
    objectIdentity: {
      clusterRef: runtime.binding.clusterRef,
      kubernetesNamespaceUid: runtime.binding.kubernetesNamespaceUid,
      podUid: runtime.binding.podUid,
      podResourceVersion: "42",
      deploymentUid: runtime.binding.deploymentUid,
      deploymentResourceVersion: runtime.object.resourceVersion,
    },
    observation: runtime,
  };
  for (const key of ["providerObjects", "execution"])
    value.binding.serverBindings[key] = {
      status: "supplied",
      owner: "runtime-observer",
      evidenceRef: `fixture/${key}`,
    };
  Object.assign(value.actual.pod.metadata, { uid: runtime.binding.podUid, resourceVersion: "42" });
  Object.assign(value.actual.controller.metadata, {
    uid: runtime.binding.deploymentUid,
    resourceVersion: "41",
  });
  return value;
}
export function result(input, outcome = "conforming", reasonCode = "stage-binding-unavailable") {
  return {
    binding: copy(input.binding),
    purpose: "comparison-only",
    outcome,
    findings:
      outcome === "conforming"
        ? []
        : [
            {
              reasonCode: outcome === "nonconforming" ? "field-mismatch" : reasonCode,
              fieldPath: "$",
            },
          ],
  };
}

/** Existing Runtime union: observation of an actual preallocated, unbound object. */
export function observedPreallocated(status = "complete", expectedObject = false) {
  const value = observed();
  const runtime = value.binding.subject.observation;
  const responsibility = {
    responsibilityRef: id(91),
    responsibilityVersion: 1,
    kind: "preparation",
  };
  const input = {
    schemaVersion: 1,
    kind: "preallocated-candidate",
    target: runtime.input.target,
    expectedEvidenceVersion: null,
    createEffect: {
      schemaVersion: 1,
      effect: {
        schemaVersion: 1,
        target: runtime.input.target,
        effectRef: id(92),
        effectKind: "reserve-inert",
        responsibility,
        requestDigest: digest(93),
      },
      providerTarget: runtime.object.target,
      expectedObject: expectedObject
        ? { ...runtime.object, resourceVersion: "older-version" }
        : null,
    },
    responsibility,
    preparation: {
      kind: "nonmutating",
      preparationRef: id(94),
      preparationVersion: 1,
      admittedProfileDigest: digest(95),
      retainedStoreAccess: "none",
    },
  };
  value.binding.subject.observation =
    status === "complete"
      ? { ...runtime, input }
      : { schemaVersion: 1, status, input, reasonCode: "unavailable" };
  return copy(value);
}
