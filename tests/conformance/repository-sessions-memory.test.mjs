import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  seedSessionRevision,
  sessionAttempt,
  verifyRepositorySessions,
} from "./repository-sessions.contract.mjs";

test("in-memory repository sessions preserve admission and transaction semantics", async (t) => {
  await verifyRepositorySessions(t, new InMemoryPlatformState());
});

test("in-memory repository cleanup recovery requires durable teardown evidence", async () => {
  const store = new InMemoryPlatformState();
  const { revision } = await seedSessionRevision(store);
  const opening = await store.transact((unit) =>
    unit.repositorySessions.createAttempt(sessionAttempt(revision)),
  );
  const invalidated = await store.transact((unit) =>
    unit.repositorySessions.advanceAttempt({
      admissionId: opening.admissionId,
      expectedPhase: "opening",
      phase: "invalidated",
      updatedAt: "2030-03-17T17:46:42.000Z",
    }),
  );
  assert.equal(invalidated?.phase, "invalidated");

  await assert.rejects(
    store.transact((unit) =>
      unit.repositorySessions.abandonCleanupAttempts({
        namespaceId: revision.namespaceId,
        agentId: revision.agentId,
        admissionIds: [opening.admissionId],
        updatedAt: "2030-03-17T17:46:43.000Z",
      }),
    ),
    { name: "DependencyUnavailableError" },
  );
});
