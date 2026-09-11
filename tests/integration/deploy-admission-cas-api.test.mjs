import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

// TODO: Add successful V2 admission, CAS, and exact-command replay coverage when
// this Fastify fixture has genuine request custody, a saved admitted workload
// profile, and its required owners. Schema rejection does not prove deploy IAM.
test("HTTP deploy rejects legacy and incomplete V2 commands without creating revisions or runtime intent", async (t) => {
  const state = new InMemoryPlatformState();
  const f = await createConsoleAppFixture(t, { state });
  await f.bootstrap();
  const namespace = await f.createNamespace("Closed deployment admission", { ready: true });
  const agent = await f.createAgent(namespace.id, "Unadmitted Agent");
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  const snapshot = () =>
    state.read(async (view) => ({
      revisions: await view.revisions.listRevisions(namespace.id, agent.id),
      head: await view.runtimeAssignments.findRuntimeIntentHead(scope),
    }));
  const before = await snapshot();
  assert.deepEqual(before.revisions, []);
  assert.equal(before.head, undefined);
  // A generation alone is not a V2 command. An operation identity also cannot
  // replace the required saved draft and its genuinely admitted profile.
  for (const body of [
    { expectedLifecycleGeneration: null },
    { expectedLifecycleGeneration: 1 },
    { expectedLifecycleGeneration: 0 },
    { expectedLifecycleGeneration: null, role: "administrator" },
    {},
    {
      schemaVersion: 2,
      operationRef: randomUUID(),
      expectedLifecycleGeneration: null,
      revisionSource: "saved-draft",
    },
  ]) {
    const response = await f.request("POST", path, { body });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(await snapshot(), before);
  }
  // Repeating the retired bodyless request must not mint revisions or advance
  // runtime intent. These are repeated syntax failures, not operation replay.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await f.request("POST", path);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(await snapshot(), before);
  }
});
