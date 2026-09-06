import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  serviceAccountResources,
  serviceAccountRevision,
  seedServiceAccountInstallation,
  accountCredential,
} from "./service-account-repository.contract.mjs";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";

export {
  serviceAccountResources as revisionResources,
  seedServiceAccountInstallation as seedRevisionInstallation,
};
export const revisionRecord = (resources, number = 1) =>
  serviceAccountRevision(resources, number, true);
export async function writeRevisionOwner(unit, resources) {
  await unit.namespaces.createNamespace(resources.namespace);
  await unit.secrets.createSecret(resources.secret);
  await unit.serviceAccounts.createServiceAccount(resources.account);
  await unit.configurations.createConfiguration(resources.configuration);
  await unit.agents.createAgent(resources.agent);
}
export async function seedRevisionOwner(store, resources = serviceAccountResources()) {
  await seedServiceAccountInstallation(store);
  await store.transact((unit) => writeRevisionOwner(unit, resources));
  return resources;
}
export async function assertRevisionClosed(
  repository,
  revision,
  writable = true,
  owner = "platform",
) {
  const calls = [
    () => repository.findRevision(revision.namespaceId, revision.agentId, revision.id),
    () => repository.listRevisions(revision.namespaceId, revision.agentId),
  ];
  if (writable) calls.push(() => repository.createRevision(revision));
  for (const call of calls)
    await assert.rejects(call(), {
      name: "ScopeViolationError",
      message: `The ${owner} transaction is closed.`,
    });
}

/** Run first on an empty store; the repository exists before bootstrap. */
export async function verifyRevisionBootstrap(store) {
  const resources = serviceAccountResources();
  const revision = revisionRecord(resources);
  const rollback = new Error("revision bootstrap rollback");
  let retained;
  assert.equal(await store.read((unit) => unit.installations.getInstallation()), undefined);
  await assert.rejects(
    store.transact(async (unit) => {
      retained = unit.revisions;
      assert.equal(
        await retained.findRevision(revision.namespaceId, revision.agentId, revision.id),
        undefined,
      );
      assert.deepEqual(await retained.listRevisions(revision.namespaceId, revision.agentId), []);
      await assert.rejects(retained.createRevision(revision), {
        name: "ScopeViolationError",
        message: "The server-owned Installation has not been initialized.",
      });
      await unit.installations.createInstallation({
        id: `ins_${randomUUID()}`,
        name: "Revision bootstrap",
        createdAt: resources.namespace.createdAt,
      });
      await writeRevisionOwner(unit, resources);
      assert.deepEqual(await retained.createRevision(revision), revision);
      assert.deepEqual(
        await retained.findRevision(revision.namespaceId, revision.agentId, revision.id),
        revision,
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.read(async (unit) => {
    assert.equal(await unit.installations.getInstallation(), undefined);
    assert.equal(await unit.namespaces.findNamespace(resources.namespace.id), undefined);
    assert.equal(await unit.agents.findAgent(revision.namespaceId, revision.agentId), undefined);
    assert.deepEqual(
      await unit.revisions.listRevisions(revision.namespaceId, revision.agentId),
      [],
    );
  });
  await assertRevisionClosed(retained, revision, true, "lifecycle");
}

async function metadata(store) {
  const resources = await seedRevisionOwner(store);
  const first = revisionRecord(resources);
  const expected = structuredClone(first);
  const saved = await store.transact((unit) => unit.revisions.createRevision(first));
  first.configuration.models.providers.openai.changed = true;
  first.serviceAccount.credential.secretRef.key = "changed";
  assert.deepEqual(saved, expected);
  assert.throws(() => {
    saved.configuration.models.providers.openai.changed = true;
  }, TypeError);
  const second = revisionRecord(resources, 2);
  await store.transact((unit) => unit.revisions.createRevision(second));
  // Existing admitted revisions keep their Configuration/credential snapshots
  // when the current account and configuration metadata subsequently advance.
  await store.transact(async (unit) => {
    await unit.serviceAccounts.updateCredential(
      resources.namespace.id,
      resources.account.id,
      accountCredential("access_token"),
    );
    await unit.configurations.advanceConfigurationGeneration(
      resources.namespace.id,
      resources.configuration.id,
      1,
    );
  });
  await store.read(async (unit) => {
    assert.deepEqual(await unit.revisions.listRevisions(expected.namespaceId, expected.agentId), [
      expected,
      second,
    ]);
    const read = await unit.revisions.findRevision(
      expected.namespaceId,
      expected.agentId,
      expected.id,
    );
    assert.deepEqual(read, expected);
    assert.notEqual(read, saved);
    assert.equal(
      await unit.revisions.findRevision(`ns_${randomUUID()}`, expected.agentId, expected.id),
      undefined,
    );
    assert.equal(
      await unit.revisions.findRevision(expected.namespaceId, `agt_${randomUUID()}`, expected.id),
      undefined,
    );
    assert.deepEqual(
      await unit.revisions.listRevisions(expected.namespaceId, `agt_${randomUUID()}`),
      [],
    );
  });
}

async function constraints(store) {
  const resources = await seedRevisionOwner(store);
  const revision = revisionRecord(resources);
  const invalid = [
    { ...revision, servicePrincipalId: randomUUID() },
    { ...revision, agentId: `agt_${randomUUID()}` },
    { ...revision, serviceAccount: { ...revision.serviceAccount, id: `sa_${randomUUID()}` } },
    { ...revision, providerId: "different-provider" },
    {
      ...revision,
      secretBindings: {
        TOKEN: {
          source: { kind: "secret", namespaceId: revision.namespaceId, id: `sec_${randomUUID()}` },
        },
      },
    },
    {
      ...revision,
      secretBindings: {
        TOKEN: {
          source: { kind: "secret", namespaceId: `ns_${randomUUID()}`, id: resources.secret.id },
        },
      },
    },
  ];
  for (const value of invalid) {
    await assert.rejects(
      store.transact((unit) => unit.revisions.createRevision(value)),
      ScopeViolationError,
    );
    assert.deepEqual(
      await store.read((unit) =>
        unit.revisions.listRevisions(revision.namespaceId, revision.agentId),
      ),
      [],
    );
  }
  await store.transact((unit) => unit.revisions.createRevision(revision));
  await assert.rejects(
    store.transact((unit) => unit.revisions.createRevision(revision)),
    ResourceConflictError,
  );
  assert.deepEqual(
    await store.read((unit) =>
      unit.revisions.listRevisions(revision.namespaceId, revision.agentId),
    ),
    [revision],
  );
}

async function optionalBindings(store) {
  const resources = await seedRevisionOwner(store);
  const base = revisionRecord(resources);
  const { secretBindings: _bindings, ...omitted } = base;
  const empty = { ...omitted, id: `rev_${randomUUID()}`, revision: 2, secretBindings: {} };
  await store.transact(async (unit) => {
    assert.deepEqual(await unit.revisions.createRevision(omitted), omitted);
    const saved = await unit.revisions.createRevision(empty);
    assert.equal(Object.hasOwn(saved, "secretBindings"), false);
  });
  const items = await store.read((unit) =>
    unit.revisions.listRevisions(base.namespaceId, base.agentId),
  );
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => !Object.hasOwn(item, "secretBindings")));
}

async function lifetime(store) {
  const resources = await seedRevisionOwner(store);
  const revision = revisionRecord(resources);
  let retained, pending;
  // The outer callback stops admitting work before this create finishes its raw
  // Agent/Secret calls. The accepted create must drain and commit completely.
  await store.transact(async (unit) => {
    retained = unit.revisions;
    pending = retained.createRevision(revision);
  });
  assert.deepEqual(await pending, revision);
  await assertRevisionClosed(retained, revision, true, "lifecycle");
  let read;
  await store.read(async (unit) => {
    read = unit.revisions;
    assert.deepEqual(
      await read.findRevision(revision.namespaceId, revision.agentId, revision.id),
      revision,
    );
  });
  await assertRevisionClosed(read, revision, false);
  const abort = new AbortController();
  let cancelled;
  await assert.rejects(
    store.read(
      async (unit) => {
        cancelled = unit.revisions;
        await cancelled.listRevisions(revision.namespaceId, revision.agentId);
        abort.abort(new Error("revision read cancelled"));
        await cancelled.listRevisions(revision.namespaceId, revision.agentId);
      },
      { signal: abort.signal, timeoutMs: 1000 },
    ),
    { name: "DependencyUnavailableError", message: "The platform read expired." },
  );
  await assertRevisionClosed(cancelled, revision, false);
  assert.deepEqual(
    await store.read((unit) =>
      unit.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
    ),
    revision,
  );
}

function revisionAudit(installation, revision) {
  return {
    id: `aud_${randomUUID()}`,
    installationId: installation.id,
    namespaceId: revision.namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "revision-repository",
    action: "create",
    resource: { kind: "agent", id: revision.agentId, namespaceId: revision.namespaceId },
    outcome: "success",
  };
}
async function writeBundle(unit, resources, revision, audit) {
  await writeRevisionOwner(unit, resources);
  await unit.revisions.createRevision(revision);
  await unit.agents.compareAndSetActiveRevision(
    revision.namespaceId,
    revision.agentId,
    undefined,
    revision.id,
  );
  await unit.operations.append({
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: revision.namespaceId,
    resourceId: revision.id,
    actorId: "revision-repository",
  });
  await unit.audit.append(audit);
}
async function assertBundleAbsent(store, resources, revision, audit) {
  await store.read(async (unit) => {
    assert.equal(await unit.namespaces.findNamespace(resources.namespace.id), undefined);
    assert.equal(
      await unit.secrets.findSecret(resources.namespace.id, resources.secret.id),
      undefined,
    );
    assert.equal(
      await unit.serviceAccounts.findServiceAccount(resources.namespace.id, resources.account.id),
      undefined,
    );
    assert.equal(
      await unit.configurations.findConfiguration(
        resources.namespace.id,
        resources.configuration.id,
      ),
      undefined,
    );
    assert.equal(await unit.agents.findAgent(revision.namespaceId, revision.agentId), undefined);
    assert.equal(
      await unit.revisions.findRevision(revision.namespaceId, revision.agentId, revision.id),
      undefined,
    );
    assert.equal(
      (await unit.operations.list()).some((item) => item.resourceId === revision.id),
      false,
    );
    assert.equal(
      (await unit.audit.list()).some((item) => item.id === audit.id),
      false,
    );
  });
}
async function atomicity(store) {
  const installation = await seedServiceAccountInstallation(store);
  for (const failure of ["callback", "audit"]) {
    const resources = serviceAccountResources();
    const revision = revisionRecord(resources);
    const audit = revisionAudit(installation, revision);
    const rollback = new Error("revision bundle rollback");
    await assert.rejects(
      store.transact(async (unit) => {
        await writeBundle(unit, resources, revision, audit);
        if (failure === "callback") throw rollback;
        await unit.audit.append({
          ...audit,
          id: `aud_${randomUUID()}`,
          installationId: `ins_${randomUUID()}`,
        });
      }),
      failure === "callback" ? (error) => error === rollback : ScopeViolationError,
    );
    await assertBundleAbsent(store, resources, revision, audit);
  }
}
async function poison(store) {
  // Reuse the existing persistence fixture and real guard. This proves rollback,
  // not live runtime observation or an invented authority issuer.
  const owner = await seedAuthority(store);
  const before = await owner.record();
  const resources = serviceAccountResources();
  const revision = revisionRecord(resources);
  const audit = revisionAudit(owner.installation, revision);
  const target = { ...owner.target, revisionId: `rev_${randomUUID()}` };
  const failure = {
    name: "ScopeViolationError",
    message: "The runtime authority target is unavailable.",
  };
  let returned = false;
  await assert.rejects(
    store.transact(async (unit) => {
      await writeBundle(unit, resources, revision, audit);
      await unit.runtimeAuthority.appendMutation(owner.bind, writer);
      await assert.rejects(
        unit.runtimeAuthority.appendMutation(
          { ...owner.evidence, target, evidence: { ...owner.evidence.evidence, target } },
          writer,
        ),
        failure,
      );
      returned = true;
    }),
    failure,
  );
  assert.equal(returned, true);
  await assertBundleAbsent(store, resources, revision, audit);
  assert.deepEqual(await owner.record(), before);
  assert.equal(await owner.operation(owner.bind.operationRef), undefined);
}
export const revisionStoreCases = [
  ["preserves admitted snapshots, immutable copies and exact history scope", metadata],
  ["rejects mismatched ownership, missing Secrets and duplicate identity", constraints],
  ["preserves omitted and empty Secret binding normalization", optionalBindings],
  ["drains admitted creates and closes escaped or cancelled handles", lifetime],
  ["rolls revision, active pointer, Secret, account, work and audit back together", atomicity],
  ["retains authority poisoning across the revision transaction", poison],
];
