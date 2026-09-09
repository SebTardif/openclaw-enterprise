import assert from "node:assert/strict";
import test from "node:test";
import { workloadProfilePairManifestFixture } from "../fixtures/workload-profile-admission-v2.mjs";
import { builderEnvelope } from "../fixtures/kubernetes-resource-plan/driver-values.mjs";
import { decodeSelectedNativeDefinitionV1 } from "../../packages/occ/src/workload-profiles/selected-native-definition.ts";
import { selectedNativeWorkloadV1 } from "../../apps/controller/src/drivers/compute/kubernetes/resources/selected-native-workload.ts";
import { selectedNativeNetworkContributionV1 } from "../../apps/controller/src/drivers/compute/kubernetes/resources/selected-native-network.ts";

const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));
// Synthetic immutable construction data only. These tests install no source,
// qualify no executable/configuration, and invoke no Kubernetes/network API.
function fixture() {
  const manifest = workloadProfilePairManifestFixture();
  const accounting = builderEnvelope();
  for (const component of ["gateway", "harness"])
    accounting.envelope.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  manifest.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope =
    accounting.envelope;
  const definition = {
    schemaVersion: 1,
    containment: {
      definition: manifest.containment.definition,
      networkFamily: "IPv4",
      resolver: { address: "192.0.2.53", port: 53 },
    },
    modelMediator: {
      definition: manifest.endpoints.modelMediator,
      authority: "model.example.invalid",
      port: 443,
      destination: { address: "192.0.2.10", port: 8443 },
    },
    repositoryIssuer: {
      definition: manifest.endpoints.repositoryIssuer,
      authority: "issuer.example.invalid",
      port: 443,
      destination: { address: "192.0.2.11", port: 9443 },
    },
    identity: { definition: manifest.endpoints.identity },
    harnessTransport: { definition: manifest.endpoints.harnessTransport },
  };
  const operands = {
    target: {
      name: "selected-agent",
      namespace: "tenant",
      ownership: {
        namespaceId: "ns_test",
        agentId: "agt_test",
        servicePrincipalId: "prn_test",
        revisionId: "rev_test",
      },
      serviceAccountName: "selected-agent",
    },
    runtimeDefinition: manifest.launchConfiguration.runtime.implementation,
    environmentDefinition: manifest.launchConfiguration.harness.environmentDefinition,
    arguments: { "configuration-path": "/runtime/config.json" },
    environment: [{ name: "HOME", value: "/runtime" }],
    initialization: {
      image: `example.invalid/init@sha256:${"4".repeat(64)}`,
      executable: { path: "/app/initialize", contentDigest: `sha256:${"5".repeat(64)}` },
      argv: ["/app/initialize", "/runtime"],
      environment: [{ name: "HOME", value: "/runtime" }],
    },
    readiness: {
      executable: { path: "/app/ready", contentDigest: `sha256:${"6".repeat(64)}` },
      argv: ["/app/ready", "/runtime/ready"],
      initialDelaySeconds: 0,
      periodSeconds: 5,
      timeoutSeconds: 1,
      failureThreshold: 3,
    },
    processIdentity: { uid: 1000, gid: 1000, fsGroup: 1000 },
    localStorage: { runtimeHome: "/runtime", temporary: "/tmp" },
    mounts: [
      { definition: manifest.launchConfiguration.harness.mounts[0], claimName: "workspace" },
    ],
    accounting: accounting.mapping,
  };
  return { manifest, definition, operands };
}
function render(value) {
  return selectedNativeWorkloadV1(bytes(value.manifest), bytes(value.definition), value.operands);
}

test("selected definition separates TLS authority from exact policy destination", () => {
  const f = fixture();
  const result = decodeSelectedNativeDefinitionV1(bytes(f.definition), bytes(f.manifest));
  assert.equal(result.value.modelMediator.authority, "model.example.invalid");
  assert.deepEqual(
    { ...result.value.modelMediator.destination },
    { address: "192.0.2.10", port: 8443 },
  );
  assert.deepEqual(Object.keys(result.value.identity), ["definition"]);
  f.definition.modelMediator.destination.address = "192.0.2.99";
  result.canonicalBytes.fill(0);
  assert.equal(result.value.modelMediator.destination.address, "192.0.2.10");
  assert.ok(Object.isFrozen(result.value.modelMediator.destination));
});

test("selected constructor owns a complete restricted Pod with explicit native operands", () => {
  const f = fixture();
  const deployment = render(f);
  const pod = deployment.spec.template.spec;
  assert.equal(deployment.kind, "Deployment");
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.selector.matchLabels, deployment.spec.template.metadata.labels);
  assert.deepEqual(
    Object.keys(pod).sort(),
    [
      "automountServiceAccountToken",
      "containers",
      "dnsConfig",
      "dnsPolicy",
      "enableServiceLinks",
      "hostIPC",
      "hostNetwork",
      "hostPID",
      "initContainers",
      "restartPolicy",
      "runtimeClassName",
      "securityContext",
      "serviceAccountName",
      "terminationGracePeriodSeconds",
      "volumes",
    ].sort(),
  );
  assert.deepEqual(pod.securityContext, {
    fsGroup: 1000,
    runAsUser: 1000,
    runAsGroup: 1000,
    supplementalGroups: [],
    supplementalGroupsPolicy: "Strict",
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.equal(pod.runtimeClassName, "selected-runsc");
  assert.equal(pod.restartPolicy, "Always");
  assert.equal(pod.terminationGracePeriodSeconds, 30);
  assert.equal(pod.serviceAccountName, "selected-agent");
  for (const key of [
    "hostIPC",
    "hostPID",
    "hostNetwork",
    "enableServiceLinks",
    "automountServiceAccountToken",
  ])
    assert.equal(pod[key], false);
  assert.equal(pod.dnsPolicy, "None");
  assert.deepEqual(pod.dnsConfig, {
    nameservers: ["192.0.2.53"],
    searches: [],
    options: [{ name: "ndots", value: "1" }],
  });
  assert.equal(pod.containers.length, 1);
  assert.equal(pod.initContainers.length, 1);
  const application = pod.containers[0],
    init = pod.initContainers[0];
  assert.deepEqual(application.command, ["/app/harness"]);
  assert.deepEqual(application.args, ["/runtime/config.json"]);
  assert.deepEqual(application.env, [{ name: "HOME", value: "/runtime" }]);
  assert.deepEqual(init.command, ["/app/initialize"]);
  assert.deepEqual(init.args, ["/runtime"]);
  assert.deepEqual(init.env, [{ name: "HOME", value: "/runtime" }]);
  assert.equal(init.image, f.operands.initialization.image);
  assert.equal(application.image, f.manifest.artifactSet.harness.reference);
  assert.deepEqual(application.readinessProbe, {
    exec: { command: ["/app/ready", "/runtime/ready"] },
    initialDelaySeconds: 0,
    periodSeconds: 5,
    timeoutSeconds: 1,
    failureThreshold: 3,
  });
  for (const container of [application, init]) {
    assert.deepEqual(container.securityContext, {
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      privileged: false,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    assert.deepEqual(Object.keys(container.resources).sort(), ["limits", "requests"]);
  }
  assert.notDeepEqual(application.resources, init.resources);
  assert.deepEqual(
    init.volumeMounts.map((item) => item.name),
    ["runtime-home", "runtime-temporary"],
  );
  assert.deepEqual(application.volumeMounts, [
    { name: "runtime-home", mountPath: "/runtime", readOnly: false },
    { name: "runtime-temporary", mountPath: "/tmp", readOnly: false },
    { name: "harness-state", mountPath: "/state/harness", readOnly: false },
  ]);
  assert.deepEqual(
    pod.volumes.map((item) => Object.keys(item).sort()),
    [
      ["emptyDir", "name"],
      ["emptyDir", "name"],
      ["name", "persistentVolumeClaim"],
    ],
  );
  assert.deepEqual(pod.volumes[2].persistentVolumeClaim, {
    claimName: "workspace",
    readOnly: false,
  });
  assert.ok(Number(pod.volumes[0].emptyDir.sizeLimit) > 0);
  assert.ok(Number(pod.volumes[1].emptyDir.sizeLimit) > 0);
  assert.ok(Object.isFrozen(pod.containers[0].args));
  f.operands.environment[0].value = "changed";
  assert.equal(application.env[0].value, "/runtime");
});

for (const [label, mutate] of [
  [
    "extra field",
    (f) => {
      f.definition.ready = true;
    },
  ],
  [
    "replaced model reference",
    (f) => {
      f.definition.modelMediator.definition = {
        ...f.definition.modelMediator.definition,
        version: 2,
      };
    },
  ],
  [
    "IPv6 resolver",
    (f) => {
      f.definition.containment.resolver.address = "::1";
    },
  ],
  [
    "loopback destination",
    (f) => {
      f.definition.modelMediator.destination.address = "127.0.0.1";
    },
  ],
  [
    "alternate DNS port",
    (f) => {
      f.definition.containment.resolver.port = 853;
    },
  ],
  [
    "wildcard TLS authority",
    (f) => {
      f.definition.modelMediator.authority = "*.example.invalid";
    },
  ],
  [
    "credential URL",
    (f) => {
      f.definition.repositoryIssuer.authority = "user:password@example.invalid";
    },
  ],
  [
    "fractional port",
    (f) => {
      f.definition.repositoryIssuer.destination.port = 1.1;
    },
  ],
  [
    "guessed identity tuple",
    (f) => {
      f.definition.identity.address = "192.0.2.2";
    },
  ],
])
  test(`definition rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => decodeSelectedNativeDefinitionV1(bytes(f.definition), bytes(f.manifest)));
  });

for (const [label, mutate] of [
  [
    "invalid RuntimeClass name",
    (f) => {
      f.manifest.launchConfiguration.harness.runtimeClass = "Bad_Name";
    },
  ],
  [
    "invalid volume name",
    (f) => {
      f.manifest.launchConfiguration.harness.mounts[0].name = "Bad_Name";
    },
  ],
  [
    "invalid application image",
    (f) => {
      f.manifest.artifactSet.harness.reference = `bad?image@${f.manifest.artifactSet.harness.platformDigest}`;
    },
  ],
  [
    "invalid initializer image",
    (f) => {
      f.operands.initialization.image = `bad?image@sha256:${"4".repeat(64)}`;
    },
  ],
  [
    "missing environment",
    (f) => {
      delete f.operands.environment;
    },
  ],
  [
    "missing initializer environment",
    (f) => {
      delete f.operands.initialization.environment;
    },
  ],
  [
    "legacy key",
    (f) => {
      f.operands.environment.push({ name: "OPENAI_API_KEY", value: "synthetic" });
    },
  ],
  [
    "legacy shared token",
    (f) => {
      f.operands.initialization.environment.push({ name: "APP_SERVER_TOKEN", value: "synthetic" });
    },
  ],
  [
    "Secret reference",
    (f) => {
      f.operands.environment[0] = {
        name: "HOME",
        valueFrom: { secretKeyRef: { name: "secret", key: "value" } },
      };
    },
  ],
  [
    "duplicate environment",
    (f) => {
      f.operands.environment.push({ name: "HOME", value: "/other" });
    },
  ],
  [
    "root identity",
    (f) => {
      f.operands.processIdentity.uid = 0;
    },
  ],
  [
    "undeclared field",
    (f) => {
      f.operands.hostNetwork = true;
    },
  ],
  [
    "unbound argument",
    (f) => {
      f.operands.arguments["bootstrap-socket"] = "/tmp/socket";
    },
  ],
  [
    "path alias",
    (f) => {
      f.operands.arguments["configuration-path"] = "/runtime/../config";
    },
  ],
  [
    "unselected environment",
    (f) => {
      f.operands.environmentDefinition = { ...f.operands.environmentDefinition, version: 2 };
    },
  ],
  [
    "unpinned initializer",
    (f) => {
      f.operands.initialization.image = "example.invalid/init:latest";
    },
  ],
  [
    "initializer executable mismatch",
    (f) => {
      f.operands.initialization.argv[0] = "/bin/sh";
    },
  ],
  [
    "readiness executable mismatch",
    (f) => {
      f.operands.readiness.argv[0] = "/bin/sh";
    },
  ],
  [
    "unbounded probe",
    (f) => {
      f.operands.readiness.timeoutSeconds = 999;
    },
  ],
  [
    "undeclared mount",
    (f) => {
      f.operands.mounts.push({ ...f.operands.mounts[0] });
    },
  ],
  [
    "overlapping mount",
    (f) => {
      f.operands.localStorage.runtimeHome = "/state";
    },
  ],
  [
    "hostPath",
    (f) => {
      f.operands.mounts[0].hostPath = "/";
    },
  ],
  [
    "wrong accounting",
    (f) => {
      f.operands.accounting.harness.application = "gateway/app";
    },
  ],
])
  test(`workload rejects ${label}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => render(f));
  });

test("network emits only exact endpoint contributions and retains complete-selection refusal", () => {
  const f = fixture();
  const target = {
    namespace: "tenant",
    ownership: { namespaceId: "ns_test", agentId: "agt_test", revisionId: "rev_test" },
  };
  const result = selectedNativeNetworkContributionV1(
    bytes(f.manifest),
    bytes(f.definition),
    target,
  );
  assert.equal(result.kind, "incomplete");
  assert.deepEqual(result.missing, [
    "native-github-route",
    "identity-bootstrap",
    "harness-transport",
    "aggregate-policy-closure",
  ]);
  assert.equal(result.policies.length, 2);
  assert.deepEqual(result.policies[0].spec, {
    podSelector: {
      matchLabels: {
        "openclaw.dev/workload-role": "agent",
        "openclaw.dev/agent": "agt_test",
        "openclaw.dev/revision": "rev_test",
      },
    },
    policyTypes: ["Ingress", "Egress"],
    ingress: [],
    egress: [],
  });
  assert.deepEqual(result.policies[1].spec.egress, [
    {
      to: [{ ipBlock: { cidr: "192.0.2.53/32" } }],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
    { to: [{ ipBlock: { cidr: "192.0.2.10/32" } }], ports: [{ protocol: "TCP", port: 8443 }] },
    { to: [{ ipBlock: { cidr: "192.0.2.11/32" } }], ports: [{ protocol: "TCP", port: 9443 }] },
  ]);
  assert.ok(Object.isFrozen(result.policies));
});

test("lexical boundaries reject duplicate fields and do not invoke accessors", () => {
  const f = fixture();
  assert.throws(() =>
    decodeSelectedNativeDefinitionV1(
      new TextEncoder().encode('{"schemaVersion":1,"schemaVersion":1}'),
      bytes(f.manifest),
    ),
  );
  let calls = 0;
  Object.defineProperty(f.operands, "environment", {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  assert.throws(() => render(f));
  assert.equal(calls, 0);
});
