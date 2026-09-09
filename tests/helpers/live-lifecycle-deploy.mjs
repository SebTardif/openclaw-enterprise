import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// These are HTTP client operations, not admission suppliers. The live composition
// must provide the actual account/profile owners and save the Agent's selection.
// Missing setup fails the selected live test; no fixture IDs or positive authority
// are synthesized. Retained files are recovery inputs, never authority evidence.
async function read(request, path, description) {
  const response = await request("GET", path);
  assert.equal(response.status, 200, `${description} requires its own authorized HTTP 200 read`);
  assert.ok(response.data, `${description} is missing`);
  return response;
}

export async function prepareLiveDeployCommand({ request, namespaceId, agentId }) {
  const path = `/namespaces/${namespaceId}/agents/${agentId}`;
  const { data: agent } = await read(request, path, "Saved Agent draft");
  assert.equal(agent.id, agentId);
  assert.equal(agent.namespaceId, namespaceId);
  assert.ok(
    agent.serviceAccountId && agent.workloadProfileSelection,
    "Live V2 deployment requires an applicable ServiceAccount and a genuinely admitted workload profile saved through the Agent update API; the current live-suite setup does not supply these owners",
  );
  const { data: configuration } = await read(
    request,
    `/namespaces/${namespaceId}/configurations/${agent.configurationId}`,
    "Saved Configuration generation",
  );
  assert.equal(configuration.id, agent.configurationId);
  assert.equal(configuration.namespaceId, namespaceId);
  assert.ok(Number.isSafeInteger(configuration.generation) && configuration.generation > 0);
  const { data: lifecycle } = await read(request, `${path}/lifecycle`, "Lifecycle head");
  assert.equal(lifecycle.namespaceId, namespaceId);
  assert.equal(lifecycle.agentId, agentId);
  assert.ok(
    lifecycle.head === null ||
      (Number.isSafeInteger(lifecycle.head?.lifecycleGeneration) &&
        lifecycle.head.lifecycleGeneration > 0),
    "Only an explicitly absent lifecycle head permits a null expectation",
  );
  const selection = agent.workloadProfileSelection;
  for (const field of ["manifestRef", "manifestDigest", "admissionRef"])
    assert.equal(typeof selection[field], "string", `Saved workload profile is missing ${field}`);
  assert.ok(Number.isSafeInteger(selection.admissionVersion) && selection.admissionVersion > 0);
  assert.ok(agent.providerId === null || typeof agent.providerId === "string");
  assert.ok(["embedded", "dedicated"].includes(agent.executionMode));
  const command = {
    schemaVersion: 2,
    operationRef: randomUUID(),
    expectedLifecycleGeneration:
      lifecycle.head === null ? null : lifecycle.head.lifecycleGeneration,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId: agent.configurationId,
      configurationGeneration: configuration.generation,
      providerId: agent.providerId,
      executionMode: agent.executionMode,
      serviceAccountId: agent.serviceAccountId,
      workloadProfileSelection: {
        manifestRef: selection.manifestRef,
        manifestDigest: selection.manifestDigest,
        admissionRef: selection.admissionRef,
        admissionVersion: selection.admissionVersion,
      },
    },
  };
  // Keep the exact command beyond test teardown or an uncertain POST outcome.
  // Changing the saved draft later must not reconstruct an accepted command.
  const directory =
    process.env.OCC_TEST_LIFECYCLE_COMMAND_DIRECTORY ??
    join(homedir(), ".cache", "openclaw-enterprise", "lifecycle-commands");
  assert.ok(isAbsolute(directory), "Lifecycle command retention requires an absolute directory");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  assert.equal(metadata.mode & 0o077, 0, "Lifecycle command directory must be private");
  assert.equal(metadata.uid, process.getuid(), "Lifecycle command directory must be caller-owned");
  // Preserve the exact route scope in the filename alongside the unchanged body.
  const filename = `${encodeURIComponent(namespaceId)}-${encodeURIComponent(agentId)}-${command.operationRef}.json`;
  const file = await open(join(directory, filename), "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(command)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  // Persist the new directory entry as well as the command bytes before POST.
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  Object.freeze(command.expectedDraft.workloadProfileSelection);
  Object.freeze(command.expectedDraft);
  return Object.freeze(command);
}

export async function deployLiveAgentRevision(options) {
  const { request, namespaceId, agentId } = options;
  const path = `/namespaces/${namespaceId}/agents/${agentId}`;
  const command = await prepareLiveDeployCommand(options);
  // Submit once. Transport uncertainty or a denial must fail, not allocate another
  // operation or retry the mutation; the retained command remains available.
  const accepted = await request("POST", `${path}/deploy`, command);
  assert.equal(accepted.status, 202, "Identified V2 deployment must return HTTP 202");
  assert.equal(accepted.data?.disposition, "accepted");
  assert.equal(Object.hasOwn(accepted.data, "id"), false, "Acceptance is not a revision document");
  const receipt = accepted.data.operation;
  assert.equal(receipt?.operationRef, command.operationRef);
  assert.equal(receipt.kind, "deploy");
  assert.equal(receipt.revisionSource, "saved-draft");
  assert.equal(receipt.desiredMode, "running");
  assert.equal(receipt.lifecycleGeneration, (command.expectedLifecycleGeneration ?? 0) + 1);
  assert.equal(typeof receipt.acceptedAt, "string");
  const { data: status } = await read(
    request,
    `${path}/lifecycle/operations/${command.operationRef}`,
    "Original accepted operation",
  );
  const operation = status.operation;
  for (const field of [
    "operationRef",
    "lifecycleGeneration",
    "acceptedAt",
    "kind",
    "revisionSource",
    "desiredMode",
  ])
    assert.equal(operation?.[field], receipt[field], `Original operation differs at ${field}`);
  assert.equal(typeof operation.requestedRevisionId, "string");
  const revision = await read(
    request,
    `${path}/revisions/${operation.requestedRevisionId}`,
    "Original requested AgentRevision",
  );
  assert.equal(revision.data.id, operation.requestedRevisionId);
  assert.equal(revision.data.agentId, agentId);
  assert.equal(revision.data.namespaceId, namespaceId);
  assert.equal(revision.data.configurationId, command.expectedDraft.configurationId);
  assert.equal(
    revision.data.configurationGeneration,
    command.expectedDraft.configurationGeneration,
  );
  return { command, accepted, revision };
}
