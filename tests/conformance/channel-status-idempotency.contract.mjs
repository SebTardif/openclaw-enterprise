import assert from "node:assert/strict";
import { ResourceConflictError } from "../../packages/occ/src/errors.ts";
import { channelRecords, seedChannelOwner } from "./channel-binding-store.contract.mjs";

export async function verifyChannelStatusIdempotency(store, kind) {
  const records = channelRecords(await seedChannelOwner(store));
  const { app, human, route } = records;
  await store.transact(async (s) => {
    await s.channelBindings.createChannelInstallation(app);
    await s.channelBindings.createHumanBinding(human);
    await s.channelBindings.createAgentBinding(route);
  });
  const operations = {
    app: {
      find: (r) => r.findChannelInstallation(app.id),
      set: (r, ...args) => r.setChannelInstallationStatus(app.id, ...args),
    },
    human: {
      find: (r) => r.findHumanBinding(app.id, human.id),
      set: (r, ...args) => r.setHumanBindingStatus(app.id, human.id, ...args),
    },
    route: {
      find: (r) => r.findAgentBinding(app.id, route.id),
      set: (r, ...args) => r.setAgentBindingStatus(app.id, route.id, ...args),
    },
  };
  const { find, set } = operations[kind];
  const read = () => store.read((s) => find(s.channelBindings));
  const write = (...args) => store.transact((s) => set(s.channelBindings, ...args));
  let current = records[kind];
  const beforeCreation = new Date(Date.parse(current.createdAt) - 1000).toISOString();
  const transitionAt = new Date(Date.parse(current.createdAt) + 1000).toISOString();

  for (const status of ["enabled", "disabled"]) {
    assert.equal(current.status, status);
    // A valid but earlier request timestamp must be ignored when no state changes.
    // Whole-record equality covers retained version, timestamps, actor and identity.
    const unchanged = await write(current.version, status, "ignored-actor", beforeCreation);
    assert.deepEqual(unchanged, current);
    assert.ok(Object.isFrozen(unchanged));
    assert.deepEqual(await read(), current);

    for (const invalid of [
      [current.version - 1, status, "admin", beforeCreation],
      [current.version + 1, status, "admin", beforeCreation],
      [1.5, status, "admin", beforeCreation],
      [Number.MAX_SAFE_INTEGER + 1, status, "admin", beforeCreation],
      [Number.NaN, status, "admin", beforeCreation],
      [current.version, "unknown", "admin", beforeCreation],
      [current.version, status, "", beforeCreation],
      [current.version, status, "bad\u0000actor", beforeCreation],
      [current.version, status, "admin", "invalid-timestamp"],
    ]) {
      // Same-state handling must not bypass input validation or current-version CAS.
      await assert.rejects(write(...invalid), ResourceConflictError);
      assert.deepEqual(await read(), current);
    }

    const nextStatus = status === "enabled" ? "disabled" : "enabled";
    await assert.rejects(
      write(current.version, nextStatus, "admin", beforeCreation),
      ResourceConflictError,
    );
    assert.deepEqual(await read(), current);

    current = {
      ...current,
      status: nextStatus,
      version: current.version + 1,
      updatedBy: "status-admin",
      updatedAt: transitionAt,
    };
    assert.deepEqual(
      await write(current.version - 1, nextStatus, "status-admin", transitionAt),
      current,
    );
    assert.deepEqual(await read(), current);
  }

  if (kind !== "app") {
    await store.transact((s) =>
      s.channelBindings.setChannelInstallationStatus(
        app.id,
        app.version,
        "disabled",
        "parent-admin",
        transitionAt,
      ),
    );
    // Disabling a parent preserves retained children. A same-state request must
    // remain a no-op, while a real re-enable still requires an enabled parent.
    assert.deepEqual(
      await write(current.version, "enabled", "ignored-actor", beforeCreation),
      current,
    );
    assert.deepEqual(await read(), current);
    current = {
      ...current,
      status: "disabled",
      version: current.version + 1,
      updatedBy: "status-admin",
      updatedAt: transitionAt,
    };
    assert.deepEqual(
      await write(current.version - 1, "disabled", "status-admin", transitionAt),
      current,
    );
    assert.deepEqual(
      await write(current.version, "disabled", "ignored-actor", beforeCreation),
      current,
    );
    assert.deepEqual(await read(), current);
    await assert.rejects(
      write(current.version, "enabled", "status-admin", transitionAt),
      ResourceConflictError,
    );
    assert.deepEqual(await read(), current);
  }
}
