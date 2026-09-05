import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const evidenceBase = "/home/dev-user/code/oce-gvisor-development-20260904/run-11";

// This loader reads protected operator evidence only. It cannot authorize a retry
// of an unknown create, repeat native initialization, or transfer writer ownership.
export async function loadResumeCheckpoint({ runId, agentImage, gatewayImage, destination }) {
  async function protectedBytes(path) {
    assert.equal(await realpath(path), path);
    const info = await lstat(path);
    assert.ok(info.isFile());
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(info.uid, process.getuid());
    return readFile(path);
  }
  async function boundJson(reference) {
    assert.ok(reference.path.startsWith(`${evidenceBase}/`));
    assert.match(reference.sha256, /^[a-f0-9]{64}$/);
    const bytes = await protectedBytes(reference.path);
    assert.equal(sha256(bytes), reference.sha256);
    return JSON.parse(bytes);
  }
  const allocation = await boundJson({
    path: process.env.OCC_RUN11_RESUME_ALLOCATION,
    sha256: process.env.OCC_RUN11_RESUME_SHA256,
  });
  assert.equal(allocation.schema, "run11-initial-observation-resume-v1");
  assert.equal(allocation.runId, runId);
  assert.equal(allocation.originalRoot, `${evidenceBase}/runs/${runId}`);
  assert.equal(resolve(destination), `${evidenceBase}/runs/${runId}-resume-v1`);
  assert.equal(allocation.resumeAt, "initial-correspondence-before-first-workspace-marker");
  assert.equal(allocation.responsibility, "original RUN-11 operator");
  assert.equal(allocation.originalProcessReturned, true);
  assert.ok(Date.now() < Date.parse(allocation.revalidateBefore));
  assert.ok(Date.parse(allocation.revalidateBefore) <= Date.parse(allocation.expiresAt));
  assert.equal(allocation.expiresAt, "2026-09-05T17:00:00Z");
  const receipt = await boundJson(allocation.originalReceipt);
  assert.equal(receipt.outcome, "returned");
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.cwd, process.cwd());
  assert.deepEqual(receipt.argv, [
    "/home/dev-user/.local/bin/node",
    "--test",
    "tests/integration/gvisor-identity-environment-real.test.mjs",
  ]);
  assert.equal(await realpath(receipt.argv[0]), process.execPath);
  assert.equal(receipt.environment.OCC_RUN11_RUN_ID, runId);
  assert.equal(receipt.environment.OCC_RUN11_EVIDENCE, allocation.originalRoot);
  assert.equal(receipt.environment.OCC_RUN11_AGENT_IMAGE, agentImage);
  assert.equal(receipt.environment.OCC_RUN11_GATEWAY_IMAGE, gatewayImage);
  assert.ok(receipt.stdout.includes("Max open files") && receipt.stdout.includes("ERR_ASSERTION"));
  const root = allocation.originalRoot;
  assert.equal(await realpath(root), root);
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  const files = (await readdir(root)).filter((name) => /^\d{5}-.*\.json$/.test(name)).sort();
  assert.equal(files.length, allocation.journalCount);
  let previous = null;
  const records = [];
  const pending = new Map();
  for (const [index, name] of files.entries()) {
    const bytes = await protectedBytes(join(root, name));
    const record = JSON.parse(bytes);
    assert.equal(record.sequence, index + 1);
    assert.equal(record.previous, previous);
    assert.equal(name, `${String(index + 1).padStart(5, "0")}-${record.kind}.json`);
    assert.notEqual(record.kind, "effect-unknown");
    if (record.kind === "effect-preallocated") {
      assert.ok(!pending.has(record.value.effectId));
      assert.ok(
        [
          "operator create new owned object",
          "create short-lived fixture controller token",
          "Compute ensureNamespace before tenant grant",
          "Compute ensureNamespace",
          "Compute prepareRevision",
        ].includes(record.value.description),
      );
      pending.set(record.value.effectId, record.value);
    } else if (record.kind === "effect-returned") {
      assert.ok(pending.delete(record.value.effectId));
      assert.ok(!record.value.result?.failure);
    }
    previous = sha256(bytes);
    records.push(record);
  }
  assert.equal(previous, allocation.journalFinalSha256);
  assert.equal(pending.size, 0);
  assert.equal(records.at(-1).kind, "command");
  const responsibility = records[0].value;
  for (const [key, value] of Object.entries({ runId, agentImage, gatewayImage }))
    assert.equal(responsibility[key], value);
  const preparations = records.filter(
    (x) => x.kind === "effect-preallocated" && x.value.description === "Compute prepareRevision",
  );
  const revisions = responsibility.agentIds.map((agentId) => {
    const attempts = preparations.filter((x) => x.value.allocation.revision.agentId === agentId);
    assert.ok(attempts.length > 0);
    const original = attempts[0].value.allocation.revision;
    for (const attempt of attempts) assert.deepEqual(attempt.value.allocation.revision, original);
    const last = attempts.at(-1);
    const returned = records.find(
      (x) => x.kind === "effect-returned" && x.value.effectId === last.value.effectId,
    );
    assert.equal(returned.value.result.ready, true);
    return original;
  });
  assert.equal(revisions.length, 2);
  const objects = records
    .filter((x) => x.kind === "effect-returned" && x.value.result?.kind)
    .map((x) => x.value.result);
  objects.push(records.find((x) => x.kind === "namespace-observed").value);
  const pods = records
    .filter((x) => x.kind === "command" && x.value.args.includes("pods"))
    .flatMap((x) => JSON.parse(x.value.stdout).items)
    .filter((x) => x.metadata.labels["openclaw.dev/workload-role"] === "agent");
  assert.equal(pods.length, 2);
  assert.equal(new Set(pods.map((x) => x.metadata.uid)).size, 2);
  for (const pod of pods)
    assert.ok(pod.status.containerStatuses.every((x) => x.restartCount === 0 && x.ready));
  const snapshotResult = await boundJson(allocation.snapshot);
  assert.equal(snapshotResult.exit_code, 0);
  const snapshot = JSON.parse(snapshotResult.output);
  const deployments = snapshot.filter((x) => x.kind === "Deployment");
  const snapshotPods = snapshot.filter((x) => x.kind === "Pod");
  assert.equal(deployments.length, 4);
  assert.equal(snapshotPods.length, 4);
  assert.equal(new Set(deployments.map((x) => x.metadata.uid)).size, 4);
  for (const pod of pods) assert.ok(snapshotPods.some((x) => x.metadata.uid === pod.metadata.uid));
  const controllerKubeconfig = join(root, "controller-kubeconfig.json");
  assert.equal(
    sha256(await protectedBytes(controllerKubeconfig)),
    allocation.controllerKubeconfigSha256,
  );
  return {
    provenance: allocation,
    owner: records.find(
      (x) =>
        x.kind === "effect-preallocated" &&
        x.value.description === "Compute ensureNamespace before tenant grant",
    ).value.allocation.owner,
    nodeUid: records.find((x) => x.kind === "substrate").value.node.metadata.uid,
    revisions,
    objects,
    pods,
    deployments,
    snapshotPods,
    controllerKubeconfig,
  };
}
