import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResourceConflictError } from "../../packages/occ/src/errors.ts";
import { seedRuntimeOwner } from "./runtime-assignment-store.contract.mjs";

export { seedRuntimeOwner as seedChannelOwner };
export function channelRecords(owner) {
  const at = new Date().toISOString();
  const metadata = {
    installationId: owner.installation.id,
    version: 1,
    status: "enabled",
    createdAt: at,
    updatedAt: at,
    createdBy: "channel-test-admin",
    updatedBy: "channel-test-admin",
  };
  const app = {
    ...metadata,
    id: `chi_${randomUUID()}`,
    platform: "slack",
    providerTenantRef: `tenant-${randomUUID()}`,
    recipientAppRef: "app-exact",
  };
  const human = {
    ...metadata,
    id: `chh_${randomUUID()}`,
    channelInstallationId: app.id,
    providerSubjectRef: "Human-É ",
    iamDriverId: "native",
    principalId: randomUUID(),
    principalIssuer: "test",
    principalSubject: randomUUID(),
  };
  const route = {
    ...metadata,
    id: `cha_${randomUUID()}`,
    channelInstallationId: app.id,
    channelRef: "Channel-É ",
    scopeKind: "slack-private-channel",
    namespaceId: owner.namespace.id,
    agentId: owner.agent.id,
  };
  return { app, human, route };
}
export function channelAudit(owner) {
  return {
    id: `aud_${randomUUID()}`,
    installationId: owner.installation.id,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "channel-test-admin",
    action: "administer",
    resource: { kind: "installation", id: owner.installation.id },
    outcome: "success",
  };
}

export async function verifyChannelBindingStore(store) {
  const owner = await seedRuntimeOwner(store);
  const foreign = await seedRuntimeOwner(store);
  const { app, human, route } = channelRecords(owner);
  const write = (fn) => store.transact((s) => fn(s.channelBindings));
  const read = (fn) => store.read((s) => fn(s.channelBindings));
  assert.equal(await read((r) => r.findChannelInstallation(app.id)), undefined);
  await assert.rejects(
    write((r) => r.createChannelInstallation({ ...app, installationId: `ins_${randomUUID()}` })),
    ResourceConflictError,
  );
  for (const invalid of ["", "bad\u0000", "bad\u009f", "\ud800", "é".repeat(513)]) {
    await assert.rejects(
      write((r) => r.createChannelInstallation({ ...app, providerTenantRef: invalid })),
      ResourceConflictError,
    );
  }
  for (const invalid of [
    { version: 0 },
    { version: 2 },
    { status: "disabled" },
    { updatedBy: "different" },
  ]) {
    await assert.rejects(
      write((r) => r.createChannelInstallation({ ...app, ...invalid })),
      ResourceConflictError,
    );
  }
  const created = await write((r) => r.createChannelInstallation(app));
  assert.deepEqual(created, app);
  assert.ok(Object.isFrozen(created));
  await assert.rejects(
    write((r) => r.createChannelInstallation({ ...app, id: `chi_${randomUUID()}` })),
    ResourceConflictError,
  );
  await write((r) => r.createHumanBinding(human));
  await write((r) => r.createAgentBinding(route));
  assert.deepEqual(
    await read((r) => r.findHumanBindingBySubject(app.id, human.providerSubjectRef)),
    human,
  );
  assert.equal(
    await read((r) => r.findHumanBindingBySubject(app.id, human.providerSubjectRef.trim())),
    undefined,
  );
  assert.deepEqual(await read((r) => r.findAgentBindingByChannel(app.id, route.channelRef)), route);
  const second = channelRecords(owner).app;
  await write((r) => r.createChannelInstallation(second));
  assert.equal(await read((r) => r.findHumanBinding(second.id, human.id)), undefined);
  assert.equal(await read((r) => r.findAgentBinding(second.id, route.id)), undefined);
  assert.deepEqual(await read((r) => r.listHumanBindings(second.id, { limit: 101 })), []);
  assert.equal(
    await write((r) =>
      r.setHumanBindingStatus(
        second.id,
        human.id,
        1,
        "disabled",
        "admin",
        new Date().toISOString(),
      ),
    ),
    undefined,
  );
  await assert.rejects(
    write((r) =>
      r.createAgentBinding({
        ...route,
        id: `cha_${randomUUID()}`,
        channelRef: "foreign",
        namespaceId: foreign.namespace.id,
      }),
    ),
    ResourceConflictError,
  );
  await assert.rejects(
    write((r) =>
      r.createAgentBinding({
        ...route,
        id: `cha_${randomUUID()}`,
        channelRef: "scope",
        scopeKind: "msteams-standard-channel",
      }),
    ),
    ResourceConflictError,
  );
  const otherHuman = { ...human, id: `chh_${randomUUID()}`, channelInstallationId: second.id };
  await write((r) => r.createHumanBinding(otherHuman));
  assert.deepEqual(
    await read((r) => r.findHumanBindingBySubject(second.id, human.providerSubjectRef)),
    otherHuman,
  );

  const disabledHuman = await write((r) =>
    r.setHumanBindingStatus(app.id, human.id, 1, "disabled", "admin", new Date().toISOString()),
  );
  assert.equal(disabledHuman.version, 2);
  assert.deepEqual(
    await write((r) =>
      r.setHumanBindingStatus(
        app.id,
        human.id,
        2,
        "disabled",
        "ignored-actor",
        new Date().toISOString(),
      ),
    ),
    disabledHuman,
  );
  await assert.rejects(
    write((r) =>
      r.setHumanBindingStatus(app.id, human.id, 1, "disabled", "admin", new Date().toISOString()),
    ),
    ResourceConflictError,
  );
  await assert.rejects(
    write((r) =>
      r.createHumanBinding({ ...human, id: `chh_${randomUUID()}`, principalId: randomUUID() }),
    ),
    ResourceConflictError,
  );
  const disabledRoute = await write((r) =>
    r.setAgentBindingStatus(app.id, route.id, 1, "disabled", "admin", new Date().toISOString()),
  );
  await assert.rejects(
    write((r) =>
      r.createAgentBinding({
        ...route,
        id: `cha_${randomUUID()}`,
        agentId: foreign.agent.id,
        namespaceId: foreign.namespace.id,
      }),
    ),
    ResourceConflictError,
  );
  await write((r) =>
    r.setChannelInstallationStatus(app.id, 1, "disabled", "admin", new Date().toISOString()),
  );
  await assert.rejects(
    write((r) =>
      r.setHumanBindingStatus(app.id, human.id, 2, "enabled", "admin", new Date().toISOString()),
    ),
    ResourceConflictError,
  );
  await assert.rejects(
    write((r) =>
      r.setAgentBindingStatus(app.id, route.id, 2, "enabled", "admin", new Date().toISOString()),
    ),
    ResourceConflictError,
  );
  await assert.rejects(
    write((r) =>
      r.createHumanBinding({
        ...human,
        id: `chh_${randomUUID()}`,
        providerSubjectRef: "new-human",
      }),
    ),
    ResourceConflictError,
  );
  await assert.rejects(
    write((r) => r.createChannelInstallation({ ...app, id: `chi_${randomUUID()}` })),
    ResourceConflictError,
  );
  assert.deepEqual(await read((r) => r.findAgentBinding(app.id, route.id)), disabledRoute);
  await write((r) =>
    r.setChannelInstallationStatus(app.id, 2, "enabled", "admin", new Date().toISOString()),
  );
  await write((r) =>
    r.setHumanBindingStatus(app.id, human.id, 2, "enabled", "admin", new Date().toISOString()),
  );

  // Retained records are sorted by opaque generated ID; continuation excludes the last row.
  const sorted = await read((r) => r.listChannelInstallations({ limit: 101 }));
  assert.deepEqual(
    sorted.map((r) => r.id),
    sorted.map((r) => r.id).sort(),
  );
  const first = await read((r) => r.listChannelInstallations({ limit: 1 }));
  const rest = await read((r) => r.listChannelInstallations({ limit: 101, afterId: first[0].id }));
  assert.ok(rest.every((r) => r.id > first[0].id));
  for (const limit of [0, 102, 1.5])
    await assert.rejects(
      read((r) => r.listChannelInstallations({ limit })),
      ResourceConflictError,
    );

  // The same transaction can contain competing asynchronous calls: CAS still has one winner.
  const outcomes = await store.transact((s) =>
    Promise.allSettled([
      s.channelBindings.setChannelInstallationStatus(
        second.id,
        1,
        "disabled",
        "a",
        new Date().toISOString(),
      ),
      s.channelBindings.setChannelInstallationStatus(
        second.id,
        1,
        "disabled",
        "b",
        new Date().toISOString(),
      ),
    ]),
  );
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((x) => x.status === "rejected").length, 1);
  const rollbackApp = channelRecords(owner).app;
  const audit = channelAudit(owner);
  await assert.rejects(
    store.transact(async (s) => {
      await s.channelBindings.createChannelInstallation(rollbackApp);
      await s.audit.append(audit);
      throw new Error("transaction rollback");
    }),
    /transaction rollback/,
  );
  assert.equal(await read((r) => r.findChannelInstallation(rollbackApp.id)), undefined);
  assert.equal(
    (await store.transact((s) => s.audit.list())).some((e) => e.id === audit.id),
    false,
  );
  const auditFailureApp = channelRecords(owner).app;
  await assert.rejects(
    store.transact(async (s) => {
      await s.channelBindings.createChannelInstallation(auditFailureApp);
      await s.audit.append({ ...channelAudit(owner), installationId: `ins_${randomUUID()}` });
    }),
  );
  assert.equal(await read((r) => r.findChannelInstallation(auditFailureApp.id)), undefined);
  return { owner, app, human, route };
}

/** A handled duplicate must not discard a successful sibling in the same unit of work. */
export async function verifyChannelBindingSameUnitDuplicate(store, kind) {
  const owner = await seedRuntimeOwner(store);
  const records = channelRecords(owner);
  const definitions = {
    app: {
      method: "createChannelInstallation",
      prefix: "chi",
      find: (r, id) => r.findChannelInstallation(id),
    },
    human: {
      method: "createHumanBinding",
      prefix: "chh",
      find: (r, id) => r.findHumanBinding(records.app.id, id),
    },
    route: {
      method: "createAgentBinding",
      prefix: "cha",
      find: (r, id) => r.findAgentBinding(records.app.id, id),
    },
  };
  const definition = definitions[kind];
  assert.ok(definition);
  if (kind !== "app")
    await store.transact((s) => s.channelBindings.createChannelInstallation(records.app));
  const candidates = [
    records[kind],
    { ...records[kind], id: `${definition.prefix}_${randomUUID()}` },
  ];
  // No SQL-client fake or nested independent transaction: both calls share the
  // actual adapter unit of work, and the caller intentionally handles conflicts.
  const results = await store.transact((s) =>
    Promise.allSettled(candidates.map((record) => s.channelBindings[definition.method](record))),
  );
  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof ResourceConflictError);
  assert.deepEqual(
    await store.read((s) => definition.find(s.channelBindings, winners[0].value.id)),
    winners[0].value,
    "the reported successful create must remain persisted after the handled duplicate",
  );
  const loser = candidates[results.findIndex((result) => result.status === "rejected")];
  assert.equal(await store.read((s) => definition.find(s.channelBindings, loser.id)), undefined);
  const naturalField = {
    app: "providerTenantRef",
    human: "providerSubjectRef",
    route: "channelRef",
  }[kind];
  const auditedRecord = {
    ...records[kind],
    id: `${definition.prefix}_${randomUUID()}`,
    [naturalField]: `audited-${randomUUID()}`,
  };
  const audit = channelAudit(owner);
  // A success audit and its row remain atomic even if a later duplicate is
  // deliberately caught in that same transaction callback.
  await store.transact(async (s) => {
    await s.channelBindings[definition.method](auditedRecord);
    await s.audit.append(audit);
    await assert.rejects(
      s.channelBindings[definition.method]({
        ...auditedRecord,
        id: `${definition.prefix}_${randomUUID()}`,
      }),
      ResourceConflictError,
    );
  });
  assert.deepEqual(
    await store.read((s) => definition.find(s.channelBindings, auditedRecord.id)),
    auditedRecord,
  );
  assert.equal(
    (await store.transact((s) => s.audit.list())).filter((event) => event.id === audit.id).length,
    1,
  );
}
