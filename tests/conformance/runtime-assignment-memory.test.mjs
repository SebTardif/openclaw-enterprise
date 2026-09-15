import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyRuntimeAssignmentStore } from "./runtime-assignment-store.contract.mjs";

test("memory runtime assignments preserve scope, immutable history, generations, replay and rollback", async () => {
  await verifyRuntimeAssignmentStore(new InMemoryPlatformState());
});
