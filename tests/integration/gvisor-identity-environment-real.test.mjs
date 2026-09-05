import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadResumeCheckpoint } from "../fixtures/gvisor-identity-environment/resume-checkpoint.mjs";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createKubernetesClientConfiguration } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

// Actual direct Compute/native initialization environment. No production runtime,
// model turn, projected identity, enrollment or production authority is exercised.
const optedIn = process.env.OCC_TEST_RUN11_REAL === "1";
const execute = promisify(execFile);
const nodeName = "k3d-oce-gvisor-alpha-server-0";
const runtimeClass = "oce-gvisor-systrap";
const kube = [
  "--kubeconfig",
  "/home/dev-user/.cache/oce-gvisor-cluster/kubeconfig",
  "--context",
  "k3d-oce-gvisor-alpha",
  "--request-timeout=10s",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const nameFor = (role, id) => `${role}-${hash(id).slice(0, 12)}`;
const deploymentFor = (revision) =>
  `${nameFor("agent", revision.agentId)}-rev-${hash(revision.id).slice(0, 12)}`;
const observer = resolve("tests/fixtures/gvisor-identity-environment/node-observer.mjs");

test(
  "RUN-11 actual Compute-owned native gVisor environment",
  {
    skip: optedIn
      ? false
      : "Select OCC_TEST_RUN11_REAL=1 with a reviewed immutable RUN-11 execution packet.",
    timeout: 1_200_000,
  },
  async () => {
    const root = process.env.OCC_RUN11_EVIDENCE;
    assert.ok(root?.startsWith("/home/dev-user/code/oce-gvisor-development-20260904/run-11/runs/"));
    const agentImage = process.env.OCC_RUN11_AGENT_IMAGE;
    const gatewayImage = process.env.OCC_RUN11_GATEWAY_IMAGE;
    for (const image of [agentImage, gatewayImage])
      assert.match(
        image ?? "",
        /^docker\.io\/library\/oce-run11-(agent|gateway)@sha256:[a-f0-9]{64}$/,
      );
    const runId = process.env.OCC_RUN11_RUN_ID;
    assert.match(runId ?? "", /^[a-f0-9]{12}$/);
    const resume = process.env.OCC_RUN11_RESUME_ALLOCATION
      ? await loadResumeCheckpoint({ runId, agentImage, gatewayImage, destination: root })
      : undefined;
    await mkdir(root, { mode: 0o700 }); // Refuse reuse: uncertain effects retain their original owner.
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    let sequence = 0;
    let previous = null;
    async function record(kind, value) {
      const body =
        JSON.stringify(
          { sequence: ++sequence, kind, at: new Date().toISOString(), previous, value },
          null,
          2,
        ) + "\n";
      const file = await open(
        join(root, `${String(sequence).padStart(5, "0")}-${kind}.json`),
        "wx",
        0o600,
      );
      try {
        await file.writeFile(body);
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      previous = hash(body);
    }
    async function command(file, args, { secret = false, timeout = 15_000 } = {}) {
      const at = new Date().toISOString();
      try {
        const result = await execute(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
        await record("command", {
          file,
          args,
          at,
          exitCode: 0,
          ...(secret
            ? { output: "protected-not-recorded" }
            : { stdout: result.stdout, stderr: result.stderr }),
        });
        return result.stdout;
      } catch (error) {
        await record("command-failed", {
          file,
          args,
          at,
          code: error.code,
          message: secret ? "protected operation failed" : String(error.message).slice(0, 4096),
          ...(secret
            ? {}
            : {
                stdout: String(error.stdout ?? "").slice(0, 4 * 1024 * 1024),
                stderr: String(error.stderr ?? "").slice(0, 4 * 1024 * 1024),
              }),
        });
        throw new Error(`${file} operation failed; exact bounded evidence retained`, {
          cause: secret ? undefined : error,
        });
      }
    }
    const kubectl = (...args) => command("kubectl", [...kube, ...args]);
    const get = async (kind, name, namespace) =>
      JSON.parse(
        await kubectl("get", kind, name, ...(namespace ? ["-n", namespace] : []), "-o", "json"),
      );
    const list = async (kind, namespace, ...args) =>
      JSON.parse(
        await kubectl("get", kind, ...(namespace ? ["-n", namespace] : []), ...args, "-o", "json"),
      ).items;
    async function wait(description, operation, timeout = 120_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await operation();
        if (value) return value;
        await delay(750);
      }
      throw new Error(`Timed out: ${description}; ownership retained`);
    }
    async function effect(description, allocation, operation) {
      const effectId = randomUUID();
      await record("effect-preallocated", {
        effectId,
        description,
        allocation,
        responsibility: "RUN-11 external operator",
        authority: "experimental fixture; not production OCC authority",
      });
      try {
        const result = await operation();
        if (result?.failure)
          throw new Error(`Returned provider failure: ${JSON.stringify(result.failure)}`);
        await record("effect-returned", { effectId, result });
        return result;
      } catch (error) {
        await record("effect-unknown", {
          effectId,
          error: error.message,
          responsibilityRetained: true,
        });
        throw error;
      }
    }
    async function create(document) {
      return effect(
        "operator create new owned object",
        document,
        () =>
          new Promise((resolvePromise, reject) => {
            const child = spawn("kubectl", [...kube, "create", "-f", "-", "-o", "json"], {
              stdio: ["pipe", "pipe", "pipe"],
            });
            let diagnostic = "";
            let output = "";
            child.stdout.on("data", (data) => {
              output += data;
              if (output.length > 4 * 1024 * 1024) child.kill("SIGKILL");
            });
            const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
            child.stderr.on("data", (data) => {
              diagnostic = (diagnostic + data).slice(-4096);
            });
            child.once("error", reject);
            child.once("close", (code) => {
              clearTimeout(timer);
              if (code !== 0) return reject(new Error(`create exited ${code}: ${diagnostic}`));
              try {
                resolvePromise(JSON.parse(output));
              } catch (error) {
                reject(error);
              }
            });
            child.stdin.on("error", reject);
            child.stdin.end(JSON.stringify(document));
          }),
      );
    }
    const objectRef = (object) => ({
      kind: object.kind,
      name: object.metadata.name,
      uid: object.metadata.uid,
      resourceVersion: object.metadata.resourceVersion,
      namespace: object.metadata.namespace,
    });
    const operator = await createKubernetesClientConfiguration(
      { mode: "kubeconfig", kubeconfigPath: kube[1], context: kube[3] },
      (message) => new Error(message),
    );
    const operatorCore = new operator.sdk.CoreV1Api(operator.clientConfiguration);
    const operatorObjects = new operator.sdk.KubernetesObjectApi(operator.clientConfiguration);
    async function deleteOwned(original) {
      const object = await get(original.kind, original.metadata.name, original.metadata.namespace);
      assert.equal(
        object.metadata.uid,
        original.metadata.uid,
        "refuse to delete a replacement object",
      );
      return effect("operator conditional delete", objectRef(object), () =>
        withComputeAbortSignal(AbortSignal.timeout(10_000), async () => {
          const body = {
            preconditions: {
              uid: object.metadata.uid,
              resourceVersion: object.metadata.resourceVersion,
            },
          };
          if (object.kind === "Pod") {
            await operatorCore.deleteNamespacedPod({
              name: object.metadata.name,
              namespace: object.metadata.namespace,
              body,
            });
          } else {
            assert.equal(object.kind, "RuntimeClass");
            await operatorObjects.delete(
              object,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              body,
            );
          }
          return { deletionRequested: true };
        }),
      );
    }
    const owner = resume?.owner ?? {
      id: `run11-${runId}`,
      name: "run11-identity-environment",
      status: "provisioning",
      createdAt: new Date().toISOString(),
    };
    const namespace = kubernetesNamespaceName(owner.id);
    const platform = `oce-run11-management-${runId}`;
    const controllerName = `oce-run11-${runId}`;
    const missingClass = `oce-run11-missing-${runId}`;
    const agentIds = [`run11-${runId}-a`, `run11-${runId}-b`];
    await record("responsibility", {
      runId,
      root,
      ...(resume ? { originalResponsibility: resume.provenance } : {}),
      source: "4c39a66c861365840aaac9a55fdfa505fbdb6efb",
      observerSha256: hash(await readFile(observer)),
      namespace,
      platform,
      nodeName,
      agentImage,
      gatewayImage,
      agentIds,
      unresolvedEffectsFailClosed: true,
      retainOnFailure: true,
      productionAuthority: false,
      identityEnrollment: false,
    });
    assert.equal(
      (await command("git", ["rev-parse", "HEAD"])).trim(),
      "4c39a66c861365840aaac9a55fdfa505fbdb6efb",
    );
    const nodes = await list("nodes");
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].metadata.name, nodeName);
    assert.ok(
      nodes[0].status.conditions.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
    );
    const selectedClass = await get("runtimeclass", runtimeClass);
    assert.equal(selectedClass.handler, runtimeClass);
    await record("substrate", { node: nodes[0], runtimeClass: selectedClass });
    if (!resume) {
      assert.equal(
        (await list("namespaces")).some((item) =>
          [namespace, platform].includes(item.metadata.name),
        ),
        false,
      );
      for (const [kind, name] of [
        ["clusterrole", controllerName],
        ["clusterrolebinding", controllerName],
        ["runtimeclass", missingClass],
      ]) {
        assert.ok(
          !(await list(kind)).some((item) => item.metadata.name === name),
          `refuse existing ${kind}/${name}`,
        );
      }
      await create({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: platform,
          labels: { "oce-run11-owner": runId, "pod-security.kubernetes.io/enforce": "restricted" },
        },
      });
      await create({
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: controllerName, namespace: platform },
        automountServiceAccountToken: false,
      });
      await create({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        metadata: { name: controllerName },
        rules: [
          {
            apiGroups: [""],
            resources: ["namespaces"],
            verbs: ["get", "list", "create", "patch", "delete"],
          },
          {
            apiGroups: ["node.k8s.io"],
            resources: ["runtimeclasses"],
            resourceNames: [runtimeClass],
            verbs: ["get"],
          },
        ],
      });
      await create({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        metadata: { name: controllerName },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: controllerName,
        },
        subjects: [{ kind: "ServiceAccount", name: controllerName, namespace: platform }],
      });
      const token = await effect(
        "create short-lived fixture controller token",
        { platform, controllerName, duration: "6h" },
        async () => {
          const value = await command(
            "kubectl",
            [...kube, "create", "token", controllerName, "-n", platform, "--duration=6h"],
            { secret: true },
          );
          const cluster = JSON.parse(
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
          assert.equal(cluster.server, "https://127.0.0.1:6445");
          const file = await open(join(root, "controller-kubeconfig.json"), "wx", 0o600);
          try {
            await file.writeFile(
              JSON.stringify({
                apiVersion: "v1",
                kind: "Config",
                clusters: [{ name: "run11", cluster }],
                users: [{ name: controllerName, user: { token: value.trim() } }],
                contexts: [{ name: "run11", context: { cluster: "run11", user: controllerName } }],
                "current-context": "run11",
              }),
            );
            await file.sync();
          } finally {
            await file.close();
          }
          return { protectedKubeconfig: "controller-kubeconfig.json" };
        },
      );
      assert.equal(token.protectedKubeconfig, "controller-kubeconfig.json");
    }
    const resources = {
      gateway: {
        requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "256Mi" },
        limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
      },
      agent: {
        requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
        limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
      },
      namespace: {
        quota: {
          pods: "10",
          "requests.cpu": "4",
          "requests.memory": "8Gi",
          "limits.cpu": "10",
          "limits.memory": "16Gi",
          "requests.ephemeral-storage": "8Gi",
          "limits.ephemeral-storage": "20Gi",
        },
        containerDefaults: {
          requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" },
          limits: { cpu: "500m", memory: "256Mi", "ephemeral-storage": "128Mi" },
        },
      },
    };
    const driver = new KubernetesComputeDriver(
      {
        authentication: {
          mode: "kubeconfig",
          kubeconfigPath: resume?.controllerKubeconfig ?? join(root, "controller-kubeconfig.json"),
          context: "run11",
        },
        isolationProfile: "gvisor-systrap",
        images: { gateway: gatewayImage, agent: agentImage, requireImmutableDigest: true },
        resources,
        network: {
          dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
          gatewayPort: 8080,
          gatewayClients: [
            { namespace: platform, podLabels: { "oce-run11-role": "receiver-allowed" } },
          ],
        },
        servicePrincipalCredentials: { mode: "disabled" },
      },
      { id: `run11-compute-${runId}` },
    );
    if (!resume) {
      await effect("Compute ensureNamespace before tenant grant", { owner, namespace }, () =>
        driver.ensureNamespace(owner),
      );
      const verbs = ["get", "list", "create", "patch", "delete"];
      await create({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name: controllerName, namespace },
        rules: [
          {
            apiGroups: [""],
            resources: [
              "configmaps",
              "serviceaccounts",
              "services",
              "resourcequotas",
              "limitranges",
              "persistentvolumeclaims",
            ],
            verbs,
          },
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
          { apiGroups: ["apps"], resources: ["deployments"], verbs },
          { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs },
          {
            apiGroups: ["discovery.k8s.io"],
            resources: ["endpointslices"],
            verbs: ["get", "list"],
          },
        ],
      });
      await create({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: controllerName, namespace },
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: controllerName },
        subjects: [{ kind: "ServiceAccount", name: controllerName, namespace: platform }],
      });
      await wait(
        "Compute namespace backing resources",
        async () =>
          (
            await effect("Compute ensureNamespace", { owner, namespace }, () =>
              driver.ensureNamespace(owner),
            )
          ).namespaceReady,
      );
    } else {
      await verifyResumeOwnership();
    }
    owner.status = "ready";
    await record("namespace-observed", await get("namespace", namespace));
    const revisions =
      resume?.revisions ??
      agentIds.map((agentId) => ({
        id: `run11-rev-${randomUUID()}`,
        namespaceId: owner.id,
        agentId,
        revision: 1,
        configurationId: `run11-cfg-${randomUUID()}`,
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: admitLoggingConfiguration(
          { gateway: { controlUi: { enabled: false } } },
          "info",
        ),
        harness: { id: "codex", version: "0.153.0", mode: "dedicated" },
        compute: { id: driver.id, implementation: driver.implementation },
        servicePrincipalId: `fixture-service-${agentId}`,
        createdAt: new Date().toISOString(),
      }));
    // A resume continues only the exact ready incarnations from the completed failed observer.
    // It never repeats preparation or adopts a replacement by Kubernetes name.
    async function verifyResumeOwnership() {
      assert.ok(Date.now() < Date.parse(resume.provenance.revalidateBefore));
      assert.equal(nodes[0].metadata.uid, resume.nodeUid);
      for (const original of resume.objects) {
        const current = await get(
          original.kind,
          original.metadata.name,
          original.metadata.namespace,
        );
        assert.equal(current.metadata.uid, original.metadata.uid);
        assert.ok(!current.metadata.deletionTimestamp);
        assert.deepEqual(current.metadata.labels ?? {}, original.metadata.labels ?? {});
        for (const key of ["rules", "roleRef", "subjects", "automountServiceAccountToken"])
          if (key in original) assert.deepEqual(current[key], original[key]);
      }
      const deployments = await list("deployments", namespace);
      assert.deepEqual(
        deployments.map((x) => x.metadata.uid).sort(),
        resume.deployments.map((x) => x.metadata.uid).sort(),
      );
      for (const current of deployments) {
        const original = resume.deployments.find((x) => x.metadata.uid === current.metadata.uid);
        assert.equal(current.metadata.name, original.metadata.name);
        assert.ok(!current.metadata.deletionTimestamp);
        assert.deepEqual(current.metadata.labels, original.metadata.labels);
        assert.deepEqual(current.spec.template.metadata.labels, original.templateLabels);
        assert.equal(current.spec.replicas, 1);
        assert.equal(current.status.readyReplicas, 1);
      }
      const pods = await list("pods", namespace);
      assert.deepEqual(
        pods.map((x) => x.metadata.uid).sort(),
        resume.snapshotPods.map((x) => x.metadata.uid).sort(),
      );
      for (const current of pods) {
        const original = resume.snapshotPods.find((x) => x.metadata.uid === current.metadata.uid);
        assert.equal(current.metadata.name, original.metadata.name);
        assert.ok(!current.metadata.deletionTimestamp);
        assert.equal(current.spec.nodeName, nodeName);
        for (const key of ["containerStatuses", "initContainerStatuses"])
          assert.deepEqual(
            (current.status[key] ?? []).map((x) => [x.name, x.containerID, x.restartCount]),
            (original.status[key] ?? []).map((x) => [x.name, x.containerID, x.restartCount]),
          );
      }
      await record("resume-ownership-confirmed", {
        provenance: resume.provenance,
        deployments,
        pods,
      });
    }
    async function resumedPod(revision) {
      const original = resume.pods.find(
        (x) => x.metadata.labels["openclaw.dev/agent"] === revision.agentId,
      );
      assert.ok(original);
      const pod = await get("pod", original.metadata.name, namespace);
      assert.equal(pod.metadata.uid, original.metadata.uid);
      assert.ok(!pod.metadata.deletionTimestamp);
      assert.equal(pod.status.phase, "Running");
      assert.ok(pod.status.conditions.some((x) => x.type === "Ready" && x.status === "True"));
      for (const key of ["containerStatuses", "initContainerStatuses"])
        assert.deepEqual(
          (pod.status[key] ?? []).map((x) => [x.name, x.containerID, x.restartCount]),
          (original.status[key] ?? []).map((x) => [x.name, x.containerID, x.restartCount]),
        );
      return pod;
    }
    async function readyPod(deployment, ns = namespace) {
      return wait(`ready Pod for ${deployment}`, async () =>
        (await list("pods", ns, "-l", `app.kubernetes.io/name=${deployment}`)).find(
          (pod) =>
            !pod.metadata.deletionTimestamp &&
            pod.status.phase === "Running" &&
            pod.status.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        ),
      );
    }
    async function prepare(revision) {
      await wait(
        `Compute prepares ${revision.id}`,
        async () =>
          (
            await effect(
              "Compute prepareRevision",
              {
                revision,
                expectedNamespace: namespace,
                expectedDeployment: deploymentFor(revision),
                nodeUid: nodes[0].metadata.uid,
              },
              () => driver.prepareRevision(revision),
            )
          ).ready,
        300_000,
      );
      return readyPod(deploymentFor(revision));
    }
    async function execNode(pod, script, ...args) {
      return kubectl(
        "exec",
        "-n",
        pod.metadata.namespace,
        pod.metadata.name,
        "-c",
        pod.spec.containers[0].name,
        "--",
        "node",
        "-e",
        script,
        ...args,
      );
    }
    async function observe(pod, revision) {
      assert.equal(pod.spec.nodeName, nodeName);
      assert.equal(pod.spec.runtimeClassName, runtimeClass);
      assert.equal(pod.spec.automountServiceAccountToken, false);
      assert.equal(pod.spec.securityContext.runAsNonRoot, true);
      assert.equal(pod.spec.securityContext.runAsUser, 1000);
      assert.ok(
        !pod.spec.volumes.some((volume) => volume.projected || volume.hostPath || volume.secret),
      );
      for (const container of [...pod.spec.initContainers, ...pod.spec.containers]) {
        assert.equal(container.securityContext.allowPrivilegeEscalation, false);
        assert.equal(container.securityContext.readOnlyRootFilesystem, true);
        assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
        assert.ok(
          container.resources.limits.cpu &&
            container.resources.limits.memory &&
            container.resources.limits["ephemeral-storage"],
        );
        assert.ok(
          !(container.env ?? []).some(
            (variable) =>
              variable.valueFrom?.secretKeyRef || /API_KEY|TOKEN|PASSWORD/.test(variable.name),
          ),
        );
      }
      const replicaSetRef = pod.metadata.ownerReferences.find(
        (item) => item.kind === "ReplicaSet" && item.controller,
      );
      const replicaSet = await get("replicaset", replicaSetRef.name, namespace);
      assert.equal(replicaSet.metadata.uid, replicaSetRef.uid);
      const deploymentRef = replicaSet.metadata.ownerReferences.find(
        (item) => item.kind === "Deployment" && item.controller,
      );
      const deployment = await get("deployment", deploymentFor(revision), namespace);
      assert.equal(deployment.metadata.uid, deploymentRef.uid);
      assert.equal(deployment.metadata.labels["openclaw.dev/revision"], revision.id);
      const native = JSON.parse(
        await execNode(
          pod,
          "fetch('http://127.0.0.1:8080/evidence',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('native evidence unavailable');process.stdout.write(await r.text())}).catch(()=>process.exit(1))",
        ),
      );
      assert.equal(
        native.binary.sha256,
        "fce635028842bfe9257140e8b7d53162732945e2f356fc35225be0702b4974be",
      );
      assert.equal(native.binary.version, "0.153.0");
      assert.match(native.responseVersion, /0\.153\.0/);
      assert.equal(native.initializeCount, 1);
      assert.ok(native.initializeNotifications.includes("remote-control-disabled"));
      assert.ok(native.initializeNotifications.length <= 2);
      assert.ok(
        native.initializeNotifications.every((code) =>
          ["remote-control-disabled", "codex-system-bwrap-missing"].includes(code),
        ),
      );
      assert.equal(native.unauthenticatedStatus, 401);
      assert.equal(native.wrongTokenStatus, 401);
      assert.equal(native.nativeLive, true);
      assert.equal(native.modelCredentials, false);
      for (const key of ["threadRequests", "turnRequests", "toolRequests"])
        assert.equal(native[key], 0);
      assert.equal(native.protectedIdentityProved, false);
      assert.match(native.native.limits, /^Max open files[ \t]+256[ \t]+256[ \t]+files[ \t]*$/m);
      const nodeObservation = JSON.parse(
        await command(
          process.execPath,
          [observer, "observe", nodeName, namespace, pod.metadata.name, pod.metadata.uid],
          { timeout: 90_000 },
        ),
      );
      assert.equal(nodeObservation.cgroups.pod["pids.max"], "256");
      assert.notEqual(nodeObservation.cgroups.pod["memory.max"], "max");
      assert.notEqual(nodeObservation.cgroups.pod["cpu.max"].split(" ")[0], "max");
      const route = await get("service", nameFor("agent", revision.agentId), namespace);
      assert.equal(
        route.spec.selector["app.kubernetes.io/name"],
        `${nameFor("agent", revision.agentId)}-inactive`,
      );
      const claim = await get("pvc", nameFor("workspace", revision.agentId), namespace);
      assert.equal(claim.status.phase, "Bound");
      const observation = {
        namespace: objectRef(await get("namespace", namespace)),
        revision,
        deployment,
        replicaSet,
        pod,
        native,
        nodeObservation,
        workspace: claim,
        route,
        observedAt: new Date().toISOString(),
      };
      await record("actual-correspondence", observation);
      return observation;
    }
    const firstPod = resume ? await resumedPod(revisions[0]) : await prepare(revisions[0]);
    const secondPod = resume ? await resumedPod(revisions[1]) : await prepare(revisions[1]);
    const first = await observe(firstPod, revisions[0]);
    const second = await observe(secondPod, revisions[1]);
    assert.notEqual(first.workspace.metadata.uid, second.workspace.metadata.uid);
    assert.notEqual(first.pod.metadata.uid, second.pod.metadata.uid);
    assert.notEqual(first.nodeObservation.sandboxes[0].id, second.nodeObservation.sandboxes[0].id);
    assert.equal(first.nodeObservation.nodeIdentity.id, second.nodeObservation.nodeIdentity.id);
    assert.equal(
      first.nodeObservation.nodeIdentity.startedAt,
      second.nodeObservation.nodeIdentity.startedAt,
    );
    for (const [pod, agentId] of [
      [firstPod, agentIds[0]],
      [secondPod, agentIds[1]],
    ]) {
      await effect(
        "write harmless per-Agent workspace marker",
        { pod: objectRef(pod), path: "/home/node/workspace/run11-marker", agentId },
        () =>
          execNode(
            pod,
            "const fs=require('fs');if(fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token'))throw Error('unexpected token');fs.writeFileSync('/home/node/workspace/run11-marker',process.argv[1],{flag:'wx',mode:0o600});process.stdout.write(fs.readFileSync('/home/node/workspace/run11-marker','utf8'));",
            agentId,
          ),
      );
    }

    // Both receivers run a real listener. The sole allowed selector must determine reachability.
    await create({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "run11-management-deny", namespace: platform },
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    });
    const createdReceivers = new Map();
    for (const role of ["receiver-allowed", "receiver-denied"]) {
      const createdReceiver = await create({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: role,
          namespace: platform,
          labels: { "oce-run11-role": role, "app.kubernetes.io/name": role },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: "Never",
          activeDeadlineSeconds: 1800,
          terminationGracePeriodSeconds: 10,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "receiver",
              image: gatewayImage,
              imagePullPolicy: "Never",
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: resources.gateway,
              readinessProbe: { httpGet: { path: "/readyz", port: 8080 } },
            },
          ],
        },
      });
      createdReceivers.set(role, createdReceiver);
      assert.equal((await readyPod(role, platform)).metadata.uid, createdReceiver.metadata.uid);
    }
    await create({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "run11-receiver-ingress", namespace: platform },
      spec: {
        podSelector: { matchLabels: { "oce-run11-role": "receiver-allowed" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
                podSelector: { matchLabels: { "openclaw.dev/workload-role": "agent" } },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      },
    });
    await create({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "run11-controlled-receiver", namespace },
      spec: {
        podSelector: { matchLabels: { "openclaw.dev/workload-role": "agent" } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": platform } },
                podSelector: { matchLabels: { "oce-run11-role": "receiver-allowed" } },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      },
    });
    const allowed = await get("pod", "receiver-allowed", platform);
    const denied = await get("pod", "receiver-denied", platform);
    const kubernetesService = await get("service", "kubernetes", "default");
    const probe =
      "const net=require('net');const host=process.argv[1];const port=Number(process.argv[2]);const s=net.connect({host,port});let done=false;const finish=x=>{if(done)return;done=true;s.destroy();process.stdout.write(JSON.stringify(x))};s.setTimeout(2000,()=>finish({connected:false,reason:'timeout'}));s.once('error',e=>finish({connected:false,reason:e.code}));s.once('connect',()=>finish({connected:true}));";
    assert.equal(JSON.parse(await execNode(denied, probe, "127.0.0.1", "8080")).connected, true);
    const network = [];
    for (const pod of [firstPod, secondPod]) {
      for (const [target, port, expected] of [
        [allowed.status.podIP, 8080, true],
        [denied.status.podIP, 8080, false],
        [kubernetesService.spec.clusterIP, 443, false],
        ["169.254.169.254", 80, false],
        [nodes[0].status.addresses.find((item) => item.type === "InternalIP").address, 6443, false],
      ]) {
        const result = JSON.parse(await execNode(pod, probe, target, String(port)));
        network.push({ podUid: pod.metadata.uid, target, port, expected, result });
        await record("network-probe", network.at(-1));
        assert.equal(result.connected, expected);
      }
    }

    // Fail on an unobserved incarnation; an API name alone cannot authorize a writable successor.
    const deployment = await get("deployment", deploymentFor(revisions[0]), namespace);
    assert.equal(deployment.metadata.uid, first.deployment.metadata.uid);
    const predecessorSelector = `app.kubernetes.io/name=${deployment.metadata.name}`;
    async function predecessorPods() {
      const pods = await list("pods", namespace, "-l", predecessorSelector);
      for (const pod of pods) {
        assert.equal(
          pod.metadata.uid,
          firstPod.metadata.uid,
          "unexpected predecessor incarnation retains responsibility",
        );
        const ownerRef = pod.metadata.ownerReferences.find(
          (item) => item.kind === "ReplicaSet" && item.controller,
        );
        assert.equal(ownerRef?.uid, first.replicaSet.metadata.uid);
        for (const key of ["containerStatuses", "initContainerStatuses"]) {
          for (const status of pod.status[key] ?? []) {
            const initial = firstPod.status[key]?.find((item) => item.name === status.name);
            assert.ok(initial);
            assert.equal(
              status.restartCount,
              initial.restartCount,
              "predecessor restart is unresolved",
            );
            assert.equal(status.containerID, initial.containerID, "predecessor container changed");
          }
        }
      }
      await record("predecessor-pod-inventory", pods);
      return pods;
    }
    const beforeStop = await predecessorPods();
    assert.equal(beforeStop.length, 1);
    assert.ok(!beforeStop[0].metadata.deletionTimestamp);
    const beforeStopObservation = await observe(beforeStop[0], revisions[0]);
    assert.equal(beforeStopObservation.native.executionId, first.native.executionId);
    assert.deepEqual(
      beforeStopObservation.nodeObservation.sandboxes.map((item) => item.id).sort(),
      first.nodeObservation.sandboxes.map((item) => item.id).sort(),
    );
    await effect(
      "guarded predecessor scale to zero",
      { deployment: objectRef(deployment), predecessorPod: objectRef(firstPod) },
      () =>
        kubectl(
          "patch",
          "deployment",
          deployment.metadata.name,
          "-n",
          namespace,
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: deployment.metadata.uid },
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: deployment.metadata.resourceVersion,
            },
            { op: "replace", path: "/spec/replicas", value: 0 },
          ]),
        ),
    );
    await wait(
      "exact predecessor Agent Pods disappear",
      async () => (await predecessorPods()).length === 0,
    );
    const termination = JSON.parse(
      await command(
        process.execPath,
        [
          observer,
          "terminated",
          nodeName,
          namespace,
          firstPod.metadata.name,
          firstPod.metadata.uid,
          first.nodeObservation.sandboxes.find((item) => item.state === "SANDBOX_READY").id,
          deployment.metadata.name,
        ],
        { timeout: 45_000 },
      ),
    );
    await record("predecessor-termination-barrier", termination);
    assert.equal(termination.terminationObserved, true);
    const stoppedDeployment = await get("deployment", deployment.metadata.name, namespace);
    assert.equal(stoppedDeployment.metadata.uid, deployment.metadata.uid);
    assert.equal(stoppedDeployment.spec.replicas, 0);
    assert.equal(stoppedDeployment.status.replicas ?? 0, 0);
    assert.ok(stoppedDeployment.status.observedGeneration >= stoppedDeployment.metadata.generation);
    assert.equal((await predecessorPods()).length, 0);
    await record("predecessor-zero-confirmed", stoppedDeployment);
    const replacement = {
      ...revisions[0],
      id: `run11-rev-${randomUUID()}`,
      revision: 2,
      configurationGeneration: 2,
      createdAt: new Date().toISOString(),
    };
    const replacementPod = await prepare(replacement);
    const replaced = await observe(replacementPod, replacement);
    assert.equal(replaced.workspace.metadata.uid, first.workspace.metadata.uid);
    assert.notEqual(replaced.pod.metadata.uid, first.pod.metadata.uid);
    assert.notEqual(replaced.native.executionId, first.native.executionId);
    assert.equal(
      await execNode(
        replacementPod,
        "process.stdout.write(require('fs').readFileSync('/home/node/workspace/run11-marker','utf8'))",
      ),
      agentIds[0],
    );
    assert.equal(
      await execNode(
        secondPod,
        "process.stdout.write(require('fs').readFileSync('/home/node/workspace/run11-marker','utf8'))",
      ),
      agentIds[1],
    );
    await effect(
      "Compute retire already terminated predecessor",
      {
        revision: revisions[0],
        predecessorTermination: termination,
        replacementPod: objectRef(replacementPod),
      },
      () => driver.retireRevision(revisions[0]),
    );

    // Fresh unconfigured handler: native code must never start; no unsafe native runc control is run.
    const denial = structuredClone(replacementPod);
    denial.metadata = {
      name: "run11-handler-denial",
      namespace,
      labels: { "oce-run11-owner": runId },
    };
    delete denial.status;
    delete denial.spec.nodeName;
    denial.spec.runtimeClassName = missingClass;
    denial.spec.restartPolicy = "Never";
    denial.spec.activeDeadlineSeconds = 60;
    // No shared workspace or init writer is needed for a runtime that must not start.
    delete denial.spec.initContainers;
    denial.spec.volumes = [];
    denial.spec.containers[0].volumeMounts = [];
    await effect("actual missing RuntimeClass admission denial", denial, async () => {
      try {
        await withComputeAbortSignal(AbortSignal.timeout(10_000), () =>
          operatorCore.createNamespacedPod({ namespace, body: denial }),
        );
      } catch (error) {
        assert.ok(
          [403, 404].includes(error.code),
          "only definitive API rejection is denial evidence",
        );
        const body = typeof error.body === "string" ? JSON.parse(error.body) : error.body;
        assert.ok(body.message.includes(missingClass) && /not found/i.test(body.message));
        return { rejected: true, code: error.code, reason: body.reason, message: body.message };
      }
      throw new Error("missing RuntimeClass unexpectedly admitted a Pod; ownership retained");
    });
    assert.ok(
      !(await list("pods", namespace)).some((pod) => pod.metadata.name === denial.metadata.name),
    );
    const createdClass = await create({
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: missingClass, labels: { "oce-run11-owner": runId } },
      handler: `oce-run11-unconfigured-${runId}`,
    });
    const deniedPod = await create(denial);
    const handlerEvents = await wait("actual missing handler denial", async () => {
      const events = await list(
        "events",
        namespace,
        "--field-selector",
        `involvedObject.uid=${deniedPod.metadata.uid}`,
      );
      return events.some(
        (event) =>
          event.message?.includes(`oce-run11-unconfigured-${runId}`) &&
          event.message.includes("no runtime"),
      )
        ? events
        : undefined;
    });
    const finalDenial = await get("pod", deniedPod.metadata.name, namespace);
    assert.equal(finalDenial.metadata.uid, deniedPod.metadata.uid);
    assert.ok(
      !(finalDenial.status.containerStatuses ?? []).some(
        (item) => item.containerID || item.started,
      ),
    );
    await record("handler-denial", { pod: finalDenial, events: handlerEvents });
    await deleteOwned(deniedPod);
    await wait(
      "denial Pod removed",
      async () =>
        !(await list("pods", namespace)).some(
          (pod) => pod.metadata.uid === finalDenial.metadata.uid,
        ),
    );
    await deleteOwned(createdClass);
    for (const pod of [allowed, denied]) {
      await deleteOwned(createdReceivers.get(pod.metadata.name));
      await wait(
        "receiver removed",
        async () =>
          !(await list("pods", platform)).some((item) => item.metadata.uid === pod.metadata.uid),
      );
    }
    const retainedA = await observe(
      await get("pod", replacementPod.metadata.name, namespace),
      replacement,
    );
    const retainedB = await observe(
      await get("pod", secondPod.metadata.name, namespace),
      revisions[1],
    );
    await record("handoff", {
      status:
        "native-compute-environment-passed-awaiting-independent-acceptance-and-SPIRE-composition",
      runId,
      namespace,
      platform,
      controllerName,
      nodeName,
      retained: [retainedA, retainedB].map((item) => ({
        revision: item.revision,
        pod: objectRef(item.pod),
        workspace: objectRef(item.workspace),
        native: item.native,
        observedAt: item.observedAt,
        nodeObservation: item.nodeObservation,
      })),
      network,
      noModelWork: true,
      identityQualification: false,
      exclusiveConsumer: "original IDN-02 owner after root acceptance",
      revalidateBeforeUse: true,
      cleanupRequiresOwnedObjectChecks: true,
    });
  },
);
