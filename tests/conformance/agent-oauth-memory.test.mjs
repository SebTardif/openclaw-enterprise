import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyAgentOAuthState } from "./agent-oauth-state.contract.mjs";

test("Agent OAuth memory repository preserves custody and generation boundaries", async (t) => {
  await verifyAgentOAuthState(t, new InMemoryPlatformState());
});
