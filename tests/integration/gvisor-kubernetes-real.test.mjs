import assert from "node:assert/strict";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  createKubernetesClient,
  kubectlArguments,
  kubernetesHash,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

// This suite executes the HTTP fixture in real gVisor sandboxes through the Kubernetes
// Compute Driver. It does not verify a real OpenClaw gateway, Codex transport, or model turn.
// Without real runtime configuration this fixture prepares and retires revisions;
// it does not activate the Agent Service, which must remain unpublished throughout.
// Prepare the disposable cluster's runsc handler, exact RuntimeClass, imported fixture
// image, and local-path shared filesystem before opting in. The suite changes only its
// own namespaces and scoped RBAC; it never changes a RuntimeClass or node configuration.
const selection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};
const fixtureImage = process.env.OCC_TEST_KUBERNETES_IMAGE;
const execute = promisify(execFile);
const runtimeClass = "oce-gvisor-systrap";
const implementation = "occ/kubernetes-gvisor";
const optedIn = process.env.OCC_TEST_GVISOR_K3D_REAL === "1";
const namespaceAccess = ["get", "list", "create", "patch", "delete"];
const workloadAccess = ["get", "list", "create", "patch", "delete"];

async function kubectl(...args) {
  const { stdout } = await execute("kubectl", kubectlArguments(selection, args), {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

const cluster = createKubernetesClient({ selection, kubectl, waitTimeoutMs: 180_000 });
const { resource, resources, waitFor } = cluster;
const apply = (document) => cluster.applyManifest(JSON.stringify(document));
const agentName = (agentId) => `agent-${kubernetesHash(agentId)}`;
const gatewayName = (agentId) => `gateway-${kubernetesHash(agentId)}`;
const revisionName = (revision) =>
  `${agentName(revision.agentId)}-rev-${kubernetesHash(revision.id)}`;
const workspaceName = (agentId) => `workspace-${kubernetesHash(agentId)}`;

async function missing(kind, name, namespace) {
  const args = ["get", kind, name, "--ignore-not-found=true", "-o", "name"];
  if (namespace !== undefined) args.push("--namespace", namespace);
  return (await kubectl(...args)).trim() === "";
}

async function execNode(namespace, pod, script, ...args) {
  return kubectl("exec", pod, "--namespace", namespace, "--", "node", "-e", script, ...args);
}

function ready(pod) {
  return (
    pod.metadata.deletionTimestamp === undefined &&
    pod.status.phase === "Running" &&
    pod.status.conditions?.some(({ type, status }) => type === "Ready" && status === "True")
  );
}

async function readyPod(namespace, deployment) {
  return waitFor(`ready Pod for ${deployment}`, async () => {
    const pods = await resources(
      "pods",
      namespace,
      "--selector",
      `app.kubernetes.io/name=${deployment}`,
    );
    return pods.find(ready);
  });
}

async function assertRuntime(namespace, pod, context) {
  assert.equal(pod.spec.runtimeClassName, runtimeClass);
  const observation = JSON.parse(
    await execNode(
      namespace,
      pod.metadata.name,
      `const fs = require('node:fs');
       (async () => {
         const response = await fetch('http://127.0.0.1:8080/readyz', { signal: AbortSignal.timeout(5000) });
         process.stdout.write(JSON.stringify({
           version: process.version,
           platform: process.platform,
           kernel: fs.readFileSync('/proc/version', 'utf8'),
           command: fs.readFileSync('/proc/1/cmdline', 'utf8'),
           status: response.status,
           body: await response.json(),
         }));
       })().catch(error => { console.error(error.message); process.exitCode = 1; });`,
    ),
  );
  assert.match(
    observation.version,
    /^v24\./,
    "the selected fixture must execute its real Node binary",
  );
  assert.equal(observation.platform, "linux");
  assert.match(
    observation.command,
    /node\u0000\/fixture\/server\.mjs/,
    "PID 1 must be the fixture HTTP process",
  );
  assert.equal(observation.status, 200);
  assert.deepEqual(observation.body, { ready: true });
  assert.match(observation.kernel, /^Linux version /);

  // RuntimeClass metadata alone does not prove the handler executed gVisor. Read its
  // kernel boot evidence through the image's actual dmesg binary inside the sandbox.
  const boot = await kubectl("exec", pod.metadata.name, "--namespace", namespace, "--", "dmesg");
  assert.match(boot, /Starting gVisor/i, "the running process must observe a real gVisor kernel");
  context.diagnostic(`Observed gVisor kernel: ${observation.kernel.trim()}`);
  return observation;
}

async function grantController(context, platformNamespace, tenantNamespace, kubeconfig) {
  const name = `oce-gvisor-${kubernetesHash(platformNamespace)}`;
  const account = "gvisor-fixture-controller";
  const directory = await mkdtemp(join(tmpdir(), "oce-gvisor-controller-"));
  context.after(async () => {
    try {
      await kubectl("delete", "clusterrolebinding", name, "--ignore-not-found=true");
      await kubectl("delete", "clusterrole", name, "--ignore-not-found=true");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await kubectl("create", "serviceaccount", account, "--namespace", platformNamespace);
  await apply({
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: { name },
    rules: [
      { apiGroups: [""], resources: ["namespaces"], verbs: namespaceAccess },
      {
        apiGroups: ["node.k8s.io"],
        resources: ["runtimeclasses"],
        resourceNames: [runtimeClass],
        verbs: ["get"],
      },
    ],
  });
  await kubectl(
    "create",
    "clusterrolebinding",
    name,
    `--clusterrole=${name}`,
    `--serviceaccount=${platformNamespace}:${account}`,
  );
  const token = (
    await kubectl("create", "token", account, "--namespace", platformNamespace)
  ).trim();
  // The validation helper intentionally omits raw credentials. Extract only the
  // selected cluster's public CA and endpoint, never the administrator's user entry.
  const authenticatedCluster = JSON.parse(
    await kubectl(
      "config",
      "view",
      "--raw",
      "--minify",
      "--flatten",
      "-o",
      "jsonpath={.clusters[0].cluster}",
    ),
  );
  assert.equal(authenticatedCluster.server, kubeconfig.clusters[0].cluster.server);
  const path = join(directory, "kubeconfig.json");
  await writeFile(
    path,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "disposable", cluster: authenticatedCluster }],
      users: [{ name: account, user: { token } }],
      contexts: [{ name, context: { cluster: "disposable", user: account } }],
      "current-context": name,
    }),
    { mode: 0o600 },
  );

  return {
    authentication: { mode: "kubeconfig", kubeconfigPath: path, context: name },
    async grantTenant() {
      await apply({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name, namespace: tenantNamespace },
        rules: [
          {
            apiGroups: [""],
            resources: [
              "configmaps",
              "serviceaccounts",
              "services",
              "resourcequotas",
              "limitranges",
            ],
            verbs: workloadAccess,
          },
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
          {
            apiGroups: [""],
            resources: ["persistentvolumeclaims"],
            verbs: ["get", "create", "patch", "delete"],
          },
          { apiGroups: ["apps"], resources: ["deployments"], verbs: workloadAccess },
          {
            apiGroups: ["networking.k8s.io"],
            resources: ["networkpolicies"],
            verbs: workloadAccess,
          },
          {
            apiGroups: ["discovery.k8s.io"],
            resources: ["endpointslices"],
            verbs: ["get", "list"],
          },
        ],
      });
      await kubectl(
        "create",
        "rolebinding",
        name,
        "--namespace",
        tenantNamespace,
        `--role=${name}`,
        `--serviceaccount=${platformNamespace}:${account}`,
      );
    },
  };
}

function revisionFor(driver, owner, agentId, configurationId, number) {
  return {
    id: `rev_${randomUUID()}`,
    namespaceId: owner.id,
    agentId,
    revision: number,
    configurationId,
    configurationKind: "agent",
    configurationGeneration: number,
    configuration: admitLoggingConfiguration(
      { gateway: { controlUi: { enabled: false } } },
      "info",
    ),
    harness: { id: "codex", version: "1.0.0", mode: "dedicated" },
    compute: { id: driver.id, implementation: driver.implementation },
    servicePrincipalId: `service-agent-${agentId}`,
    createdAt: new Date().toISOString(),
  };
}

async function prepare(driver, revision) {
  return waitFor(`prepared revision ${revision.id}`, async () => {
    const observation = await driver.prepareRevision(revision);
    assert.equal(observation.namespaceId, revision.namespaceId);
    assert.equal(observation.agentId, revision.agentId);
    assert.equal(observation.revisionId, revision.id);
    return observation.ready ? observation : undefined;
  });
}

async function readyEndpoints(namespace, service) {
  const slices = await resources(
    "endpointslices",
    namespace,
    "--selector",
    `kubernetes.io/service-name=${service}`,
  );
  return slices.flatMap((slice) =>
    (slice.endpoints ?? []).filter((endpoint) => endpoint.conditions?.ready === true),
  );
}

async function assertUnpublishedAgentRoute(namespace, agentId) {
  assert.deepEqual(
    (await resource("service", agentName(agentId), namespace)).spec.selector,
    {
      "app.kubernetes.io/name": `${agentName(agentId)}-inactive`,
    },
    "the HTTP fixture must preserve the unactivated Agent Service selector",
  );
  assert.deepEqual(
    await readyEndpoints(namespace, agentName(agentId)),
    [],
    "prepared fixture revisions must not publish an Agent route",
  );
}

async function assertWorkspace(namespace, agentId, uid, pod, marker) {
  const claim = await resource("persistentvolumeclaim", workspaceName(agentId), namespace);
  assert.equal(
    claim.metadata.uid,
    uid,
    "revision transitions must preserve the exact shared workspace claim",
  );
  assert.equal(claim.status.phase, "Bound");
  const actual = await execNode(
    namespace,
    pod,
    "process.stdout.write(require('node:fs').readFileSync('/home/node/workspace/gvisor-retention.txt', 'utf8'))",
  );
  assert.equal(
    actual,
    marker,
    "the shared workspace must retain bytes written by the earlier gVisor process",
  );
}

test(
  "real gVisor Kubernetes fixture prepares replacement revisions, preserves workspace, and contains unsafe placement",
  {
    skip: optedIn
      ? false
      : "Set OCC_TEST_GVISOR_K3D_REAL=1 with an explicit disposable k3d kubeconfig, context, and imported OCC_TEST_KUBERNETES_IMAGE.",
    timeout: 600_000,
  },
  async (context) => {
    assert.ok(
      fixtureImage,
      "OCC_TEST_KUBERNETES_IMAGE must select the imported HTTP fixture image.",
    );
    const kubeconfig = await validateExplicitK3dLoopbackContext(selection);
    const selectedClass = await resource("runtimeclass", runtimeClass);
    assert.equal(selectedClass.handler, runtimeClass);
    assert.equal(selectedClass.metadata.deletionTimestamp, undefined);
    const { KubernetesComputeDriver, kubernetesNamespaceName } =
      await import("../../apps/controller/src/drivers/compute/kubernetes/index.ts");
    const owner = {
      id: `ns_${randomUUID()}`,
      name: "gvisor-fixture",
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const namespace = kubernetesNamespaceName(owner.id);
    const platformNamespace = `oce-gvisor-platform-${kubernetesHash(owner.id)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(async () => {
      await kubectl(
        "delete",
        "namespace",
        namespace,
        platformNamespace,
        "--ignore-not-found=true",
        "--wait=false",
      );
      await waitFor(
        "owned fixture namespaces to be removed",
        async () =>
          (await missing("namespace", namespace)) &&
          (await missing("namespace", platformNamespace)),
      );
    });
    const controller = await grantController(context, platformNamespace, namespace, kubeconfig);
    const limits = {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    };
    const driver = new KubernetesComputeDriver({
      authentication: controller.authentication,
      isolationProfile: "gvisor-systrap",
      images: { gateway: fixtureImage, agent: fixtureImage, requireImmutableDigest: false },
      resources: {
        gateway: limits,
        agent: limits,
        namespace: {
          quota: {
            pods: "12",
            "requests.cpu": "2",
            "requests.memory": "2Gi",
            "limits.cpu": "8",
            "limits.memory": "4Gi",
          },
          containerDefaults: limits,
        },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
        gatewayPort: 8080,
        gatewayClients: [
          {
            namespace: platformNamespace,
            podLabels: { "app.kubernetes.io/name": "approved-client" },
          },
        ],
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-enterprise",
        expirationSeconds: 3600,
      },
    });
    assert.equal(driver.implementation, implementation);

    // Namespace creation precedes the operator's tenant grant. Readiness cannot be
    // reported while this controller lacks its exact namespaced resource access.
    const pending = await driver.ensureNamespace(owner);
    assert.equal(pending.namespaceReady, false);
    assert.equal(pending.failure, undefined);
    await controller.grantTenant();
    await waitFor("tenant backing infrastructure", async () => {
      const observation = await driver.ensureNamespace(owner);
      assert.equal(observation.failure, undefined);
      return observation.namespaceReady;
    });
    owner.status = "ready";
    const agentId = `agt_${randomUUID()}`;
    const configurationId = `cfg_${randomUUID()}`;
    const first = revisionFor(driver, owner, agentId, configurationId, 1);
    const second = revisionFor(driver, owner, agentId, configurationId, 2);
    await prepare(driver, first);
    const firstPod = await readyPod(namespace, revisionName(first));
    const firstRuntime = await assertRuntime(namespace, firstPod, context);
    assert.equal(
      (await resource("deployment", revisionName(first), namespace)).spec.template.spec
        .runtimeClassName,
      runtimeClass,
    );
    const gatewayPod = await readyPod(namespace, gatewayName(agentId));
    assert.equal(
      gatewayPod.spec.runtimeClassName,
      undefined,
      "the dedicated gateway retains ordinary Kubernetes execution",
    );
    await assertUnpublishedAgentRoute(namespace, agentId);

    // The configured platform peer must reach this exact gateway Pod over HTTP.
    // This positive control prevents an absent listener or broken destination from
    // being mistaken for denial of the Agent's connection to the same IP and port.
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "approved-client",
        namespace: platformNamespace,
        labels: { "app.kubernetes.io/name": "approved-client" },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "client",
            image: fixtureImage,
            imagePullPolicy: "IfNotPresent",
            resources: limits,
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            readinessProbe: { httpGet: { path: "/readyz", port: 8080 } },
          },
        ],
      },
    });
    const approvedClient = await readyPod(platformNamespace, "approved-client");
    const gatewayHost = gatewayPod.status.podIP.includes(":")
      ? `[${gatewayPod.status.podIP}]`
      : gatewayPod.status.podIP;
    const assertApprovedConnection = async () => {
      const allowedResponse = JSON.parse(
        await execNode(
          platformNamespace,
          approvedClient.metadata.name,
          `(async () => {
         const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(5000) });
         process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
       })().catch(error => { console.error(error.message); process.exitCode = 1; });`,
          `http://${gatewayHost}:8080/readyz`,
        ),
      );
      assert.deepEqual(
        allowedResponse,
        { status: 200, body: { ready: true } },
        "the explicitly approved peer must reach the exact gateway Pod IP and port",
      );
    };

    // Prove DNS and permitted cross-Pod TCP from the gVisor sandbox itself before
    // checking its denied connection to the gateway reached by the approved client.
    const dns = JSON.parse(
      await kubectl(
        "exec",
        firstPod.metadata.name,
        "--namespace",
        namespace,
        "--",
        "node",
        "/fixture/probe.mjs",
        "dns",
        "kubernetes.default.svc.cluster.local",
      ),
    );
    assert.ok(dns.address);
    const dnsTcp = JSON.parse(
      await kubectl(
        "exec",
        firstPod.metadata.name,
        "--namespace",
        namespace,
        "--",
        "node",
        "/fixture/probe.mjs",
        "tcp",
        "kube-dns.kube-system.svc.cluster.local",
        "53",
      ),
    );
    assert.equal(
      dnsTcp.connected,
      true,
      "the same sandbox must establish a permitted cross-Pod TCP connection",
    );
    await assertApprovedConnection();
    await assert.rejects(
      kubectl(
        "exec",
        firstPod.metadata.name,
        "--namespace",
        namespace,
        "--",
        "node",
        "/fixture/probe.mjs",
        "tcp",
        gatewayPod.status.podIP,
        "8080",
      ),
      (error) => {
        assert.equal(
          error.code,
          1,
          "live forbidden traffic must fail under enforcing NetworkPolicies",
        );
        // An enforcing provider may DROP traffic (timeout) or actively REJECT it
        // (ECONNREFUSED). The successful controls above establish both a working
        // sandbox TCP stack and a reachable HTTP listener at this exact destination.
        const failureLine = (error.stderr ?? "")
          .split(/\r?\n/)
          .find((line) => line.startsWith('{"error":'));
        assert.ok(failureLine, "the fixture must report its connection failure");
        const failure = JSON.parse(failureLine);
        assert.ok(
          failure.error === "connection timed out" ||
            failure.error === `connect ECONNREFUSED ${gatewayPod.status.podIP}:8080`,
          `Unexpected connection failure: ${failure.error}`,
        );
        return true;
      },
    );
    // The same allowed destination must remain reachable after the denied probe.
    await assertApprovedConnection();
    const claim = await resource("persistentvolumeclaim", workspaceName(agentId), namespace);
    assert.deepEqual(claim.spec.accessModes, ["ReadWriteMany"]);
    const marker = `gvisor-workspace-${randomUUID()}`;
    await execNode(
      namespace,
      firstPod.metadata.name,
      "require('node:fs').writeFileSync('/home/node/workspace/gvisor-retention.txt', process.argv[1])",
      marker,
    );

    // A replacement fixture revision must prepare in a fresh sandbox and reuse the
    // Agent's workspace. No runtime is configured, so readiness cannot publish a route.
    await prepare(driver, second);
    const secondPod = await readyPod(namespace, revisionName(second));
    await assertRuntime(namespace, secondPod, context);
    assert.notEqual(secondPod.metadata.uid, firstPod.metadata.uid);
    await assertUnpublishedAgentRoute(namespace, agentId);
    // Preparing the replacement advances the fixture gateway's revision ownership.
    // Retiring the predecessor must now preserve that gateway and shared workspace.
    const replacementGateway = await resource("deployment", gatewayName(agentId), namespace);
    assert.equal(
      replacementGateway.metadata.annotations["openclaw.dev/agent-revision-id"],
      second.id,
    );
    await driver.retireRevision(first);
    await waitFor(
      "retired revision and Pod deletion",
      async () =>
        (await missing("deployment", revisionName(first), namespace)) &&
        (await missing("pod", firstPod.metadata.name, namespace)),
    );
    await assertWorkspace(namespace, agentId, claim.metadata.uid, secondPod.metadata.name, marker);
    assert.equal(
      (await resource("deployment", gatewayName(agentId), namespace)).metadata.uid,
      replacementGateway.metadata.uid,
      "retiring the predecessor must preserve the replacement's fixture gateway",
    );
    await assertUnpublishedAgentRoute(namespace, agentId);

    // Simulate external placement drift only inside the owned namespace. The real
    // unsafe Pod keeps the revision's ownership labels and Deployment owner reference,
    // while the Deployment template and its original ready gVisor Pod remain intact.
    const deployment = await resource("deployment", revisionName(second), namespace);
    const unsafeName = `unsafe-placement-${kubernetesHash(second.id)}`;
    const unsafeSpec = structuredClone(deployment.spec.template.spec);
    delete unsafeSpec.runtimeClassName;
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: unsafeName,
        namespace,
        labels: deployment.spec.template.metadata.labels,
        annotations: deployment.spec.template.metadata.annotations,
        ownerReferences: [
          {
            apiVersion: "apps/v1",
            kind: "Deployment",
            name: deployment.metadata.name,
            uid: deployment.metadata.uid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      spec: unsafeSpec,
    });
    await waitFor("unsafe fixture Pod to execute", async () =>
      ready(await resource("pod", unsafeName, namespace)),
    );
    const unsafeKernel = await execNode(
      namespace,
      unsafeName,
      "process.stdout.write(require('node:fs').readFileSync('/proc/version', 'utf8'))",
    );
    assert.notEqual(
      unsafeKernel,
      firstRuntime.kernel,
      "the unsafe Pod must actually execute outside the observed gVisor kernel",
    );
    const gatewayBefore = await resource("deployment", gatewayName(agentId), namespace);
    await assert.rejects(
      driver.prepareRevision(second),
      /required RuntimeClass; refusing fallback/,
    );
    await assertUnpublishedAgentRoute(namespace, agentId);
    await waitFor("confirmed containment of all owned revision Pods", async () => {
      const remaining = await resources(
        "pods",
        namespace,
        "--selector",
        `openclaw.dev/agent=${agentId},openclaw.dev/revision=${second.id},openclaw.dev/workload-role=agent`,
      );
      return (
        remaining.length === 0 && (await missing("deployment", revisionName(second), namespace))
      );
    });
    await assertUnpublishedAgentRoute(namespace, agentId);
    assert.equal(
      (await resource("deployment", gatewayName(agentId), namespace)).metadata.uid,
      gatewayBefore.metadata.uid,
      "containment must preserve the separate owner gateway",
    );
    const survivingGateway = await readyPod(namespace, gatewayName(agentId));
    await assertWorkspace(
      namespace,
      agentId,
      claim.metadata.uid,
      survivingGateway.metadata.name,
      marker,
    );
    assert.equal(
      (await resource("runtimeclass", runtimeClass)).metadata.uid,
      selectedClass.metadata.uid,
      "the test must preserve the operator-owned RuntimeClass",
    );
  },
);
