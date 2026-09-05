// Operator-side observer. Never copy this program or its Docker access into an image.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [action, node, namespace, podName, podUid, predecessorSandboxId, predecessorDeploymentName] =
  process.argv.slice(2);
assert.ok(["observe", "terminated"].includes(action));
assert.equal(node, "k3d-oce-gvisor-alpha-server-0");
assert.match(namespace, /^oce-run11-[a-z0-9-]+$/);
assert.match(podName, /^[a-z0-9-]+$/);
assert.match(podUid, /^[a-f0-9-]{36}$/);
if (action === "terminated") {
  assert.match(predecessorSandboxId ?? "", /^[a-f0-9]{64}$/);
  assert.match(predecessorDeploymentName ?? "", /^agent-[a-f0-9]{12}-rev-[a-f0-9]{12}$/);
}
async function docker(...args) {
  return (
    await execute("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
}
const startedAt = new Date().toISOString();
const nodeIdentity = JSON.parse(
  await docker(
    "inspect",
    node,
    "--format",
    '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
  ),
);
assert.equal(nodeIdentity.running, true);
// Preserve the initial observation path. Termination takes its process snapshot
// after CRI so later or API-deleted predecessor incarnations remain in scope.
let lines =
  action === "observe" ? (await docker("exec", node, "ps", "-eo", "pid,args")).split("\n") : [];
const marker = `${namespace}_${podName}_${podUid}/`;
const sandboxes = JSON.parse(
  await docker("exec", node, "crictl", "pods", "-o", "json"),
).items.filter(
  (item) =>
    item.metadata?.uid === podUid ||
    item.labels?.["io.kubernetes.pod.uid"] === podUid ||
    (action === "terminated" &&
      (item.id === predecessorSandboxId ||
        (item.metadata?.namespace === namespace &&
          item.labels?.["app.kubernetes.io/name"] === predecessorDeploymentName))),
);
const sandboxesReadAt = new Date().toISOString();
const scopedPodUids = new Set([
  podUid,
  ...sandboxes
    .flatMap((item) => [item.metadata?.uid, item.labels?.["io.kubernetes.pod.uid"]])
    .filter((uid) => typeof uid === "string" && uid.length > 0),
]);
const scopedSandboxIds = new Set([
  ...sandboxes.map((item) => item.id),
  ...(predecessorSandboxId ? [predecessorSandboxId] : []),
]);
const containers = JSON.parse(
  await docker("exec", node, "crictl", "ps", "-a", "-o", "json"),
).containers.filter((item) => {
  if (action === "observe") return item.labels?.["io.kubernetes.pod.uid"] === podUid;
  return (
    scopedSandboxIds.has(item.podSandboxId) ||
    scopedPodUids.has(item.labels?.["io.kubernetes.pod.uid"])
  );
});
const containersReadAt = new Date().toISOString();
if (action === "terminated") {
  // Container records can outlive their sandbox listing. Retain their own
  // sandbox and Pod identities when matching the subsequent process snapshot.
  for (const item of containers) {
    if (typeof item.podSandboxId === "string" && item.podSandboxId.length > 0) {
      scopedSandboxIds.add(item.podSandboxId);
    }
    const uid = item.labels?.["io.kubernetes.pod.uid"];
    if (typeof uid === "string" && uid.length > 0) scopedPodUids.add(uid);
  }
}
const ids = [
  ...(action === "terminated" ? [...scopedSandboxIds] : sandboxes.map((item) => item.id)),
  ...containers.map((item) => item.id),
  ...(predecessorSandboxId ? [predecessorSandboxId] : []),
];
if (action === "terminated") {
  lines = (await docker("exec", node, "ps", "-eo", "pid,args")).split("\n");
}
const processesReadAt = new Date().toISOString();
const deploymentPodPrefix = `${namespace}_${predecessorDeploymentName}-`;
const processes = lines.filter(
  (line) =>
    (line.includes(marker) ||
      ids.some((id) => line.includes(id)) ||
      (action === "terminated" &&
        (line.includes(deploymentPodPrefix) ||
          [...scopedPodUids].some((uid) => line.includes(uid))))) &&
    /runsc-sandbox|runsc-gofer|gvisor_sentry|containerd-shim-runsc/.test(line),
);
const result = {
  startedAt,
  nodeIdentity,
  namespace,
  podName,
  podUid,
  processes,
  sandboxes,
  containers,
};
if (action === "observe") {
  const sentries = processes.filter((line) => line.includes("runsc-sandbox "));
  assert.equal(sentries.length, 1, "exactly one real sentry must correspond to the owned Pod");
  assert.ok(sentries[0].includes("--platform=systrap"));
  assert.ok(sentries[0].includes("--sidecar-usage-policy=STRICT"));
  const pid = sentries[0].trim().split(/\s+/)[0];
  assert.match(pid, /^\d+$/);
  const cgroup = (await docker("exec", node, "cat", `/proc/${pid}/cgroup`)).replace(/^0::/, "");
  assert.ok(cgroup.includes(`/pod${podUid}/`));
  assert.match(cgroup, /^\/[a-zA-Z0-9_./-]+$/);
  result.sentry = {
    pid,
    stat: await docker("exec", node, "cat", `/proc/${pid}/stat`),
    cgroup,
    executable: await docker("exec", node, "sha256sum", `/proc/${pid}/exe`),
  };
  assert.equal(
    result.sentry.executable.split(/\s+/)[0],
    "66f1e15d15424a87fc883df4597c5d0cfcd442ce3f82e208a69110f0949613c1",
  );
  result.cgroups = {};
  for (const [label, path] of [
    ["sentry", cgroup],
    ["pod", cgroup.slice(0, cgroup.lastIndexOf("/"))],
  ]) {
    result.cgroups[label] = {};
    for (const field of [
      "cpu.max",
      "cpu.stat",
      "memory.max",
      "memory.current",
      "memory.events",
      "pids.max",
      "pids.current",
      "pids.events",
    ]) {
      result.cgroups[label][field] = await docker(
        "exec",
        node,
        "cat",
        `/sys/fs/cgroup${path}/${field}`,
      );
    }
  }
  assert.ok(sandboxes.some((item) => item.state === "SANDBOX_READY"));
  assert.ok(
    sandboxes
      .filter((item) => item.state === "SANDBOX_READY")
      .every((item) => item.runtimeHandler === "oce-gvisor-systrap"),
  );
  assert.ok(containers.some((item) => item.state === "CONTAINER_RUNNING"));
} else {
  // All correlated incarnations must be inactive, including records whose API
  // Pods disappeared. Created/unknown CRI states remain unresolved, not stopped.
  const unresolvedSandboxes = sandboxes.filter((item) => item.state !== "SANDBOX_NOTREADY");
  const unresolvedContainers = containers.filter((item) => item.state !== "CONTAINER_EXITED");
  result.terminationScope = {
    predecessorDeploymentName,
    predecessorSandboxId,
    deploymentPodPrefix,
    podUids: [...scopedPodUids],
    sandboxIds: [...scopedSandboxIds],
    containerIds: containers.map((item) => item.id),
    sandboxesReadAt,
    containersReadAt,
    processesReadAt,
  };
  result.unresolved = {
    processCount: processes.length,
    sandboxIds: unresolvedSandboxes.map((item) => item.id),
    containerIds: unresolvedContainers.map((item) => item.id),
  };
  result.terminationObserved =
    processes.length === 0 && unresolvedSandboxes.length === 0 && unresolvedContainers.length === 0;
}
result.finishedAt = new Date().toISOString();
if (action === "terminated") {
  // Emit the full scoped observations before failing so retained responsibility
  // includes evidence of every still-active or unresolved predecessor instance.
  writeFileSync(1, `${JSON.stringify(result)}\n`);
  assert.equal(result.terminationObserved, true, "all predecessor runtime incarnations must exit");
} else {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
