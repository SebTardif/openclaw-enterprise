import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

test("generation-bearing HTTP admission stays closed while bodyless deploy preserves its receipt", async (t) => {
  const state = new InMemoryPlatformState();
  const f = await createConsoleAppFixture(t, { state });
  await f.bootstrap();
  const namespace = await f.createNamespace("CAS compatibility", { ready: true });
  const agent = await f.createAgent(namespace.id, "CAS compatibility Agent");
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/deploy`;
  const snapshot = () =>
    state.read(async (view) => ({
      revisions: await view.revisions.listRevisions(namespace.id, agent.id),
      head: await view.runtimeAssignments.findRuntimeIntentHead(scope),
    }));
  const before = await snapshot();
  // Internal CAS does not enable a new HTTP protocol or manufacture the absent
  // current-account, semantic-role, selected-profile, and cutover authorities.
  for (const body of [
    { expectedLifecycleGeneration: null },
    { expectedLifecycleGeneration: 1 },
    { expectedLifecycleGeneration: 0 },
    { expectedLifecycleGeneration: null, role: "administrator" },
    {},
  ]) {
    const response = await f.request("POST", path, { body });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.deepEqual(await snapshot(), before);
  }
  const a = await f.request("POST", path);
  const b = await f.request("POST", path);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.notEqual(a.data.id, b.data.id);
  assert.equal(a.data.revision, 1);
  assert.equal(b.data.revision, 2);
  assert.equal(a.data.operation, undefined);
  assert.equal(a.data.lifecycleGeneration, undefined);
  assert.equal((await snapshot()).head.generation, 2);
});
