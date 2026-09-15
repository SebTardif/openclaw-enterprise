import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyRuntimeAuthorityState } from "./runtime-authority-state.contract.mjs";
test("runtime authority memory persistence (no service/provider authority)", async (t) =>
  verifyRuntimeAuthorityState(t, new InMemoryPlatformState()));

import { verifySqlShapes } from "../fixtures/runtime-authority-state/sql-shapes.mjs";
test("runtime authority SQL shape snapshots exactly match imported contracts", verifySqlShapes);
