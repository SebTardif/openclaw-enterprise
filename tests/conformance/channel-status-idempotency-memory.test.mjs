import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { verifyChannelStatusIdempotency } from "./channel-status-idempotency.contract.mjs";

for (const kind of ["app", "human", "route"]) {
  test(`memory ${kind} status no-ops ignore earlier timestamps while preserving validation and CAS`, async () => {
    await verifyChannelStatusIdempotency(new InMemoryPlatformState(), kind);
  });
}
