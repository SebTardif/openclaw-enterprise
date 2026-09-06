import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyRuntimePreparation } from "../fixtures/runtime-preparation.mjs";

test("runtime preparation: real memory retention without live admission authority", async (t) =>
  verifyRuntimePreparation(t, new InMemoryPlatformState()));
