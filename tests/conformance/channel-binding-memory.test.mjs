import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  channelAudit,
  channelRecords,
  seedChannelOwner,
  verifyChannelBindingStore,
  verifyChannelBindingSameUnitDuplicate,
} from "./channel-binding-store.contract.mjs";

test("memory channel bindings enforce exact identity, retained ownership, status CAS and rollback", async () => {
  await verifyChannelBindingStore(new InMemoryPlatformState());
});
test("memory channel metadata is not published when the actual audit sink rejects commit", async () => {
  const store = new InMemoryPlatformState({
    auditSink: {
      append: async () => {
        throw new Error("audit unavailable");
      },
    },
  });
  const owner = await seedChannelOwner(store);
  const { app } = channelRecords(owner);
  await assert.rejects(
    store.transact(async (s) => {
      await s.channelBindings.createChannelInstallation(app);
      await s.audit.append(channelAudit(owner));
    }),
  );
  assert.equal(
    await store.read((s) => s.channelBindings.findChannelInstallation(app.id)),
    undefined,
  );
});

for (const kind of ["app", "human", "route"]) {
  test(`memory retains the ${kind} winner after a handled same-unit duplicate`, async () => {
    await verifyChannelBindingSameUnitDuplicate(new InMemoryPlatformState(), kind);
  });
}
