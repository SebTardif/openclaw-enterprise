import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import {
  configurationResources,
  configurationBindings,
  seedConfigurationInstallation,
} from "./configuration-repository.contract.mjs";
import { secretRevision } from "./secret-repository.contract.mjs";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";

export const accountCredential = (kind = "api_key") => ({
  kind,
  secretRef: { name: "account.credentials", key: "token" },
});
export function serviceAccountResources(overrides = {}) {
  const resources = configurationResources(overrides);
  const account = { ...resources.account, credential: accountCredential() };
  return { ...resources, account, agent: { ...resources.agent, serviceAccountId: account.id } };
}
export { seedConfigurationInstallation as seedServiceAccountInstallation };
export function serviceAccountRevision(resources, number = 1, withSecret = false) {
  return {
    ...secretRevision(withSecret ? resources : { ...resources, secret: undefined }, number),
    serviceAccount: {
      id: resources.account.id,
      credential: structuredClone(resources.account.credential),
    },
  };
}
export const accountWork = (revision) => ({
  kind: "agent_revision",
  action: "reconcile",
  namespaceId: revision.namespaceId,
  resourceId: revision.id,
  actorId: "service-account-repository",
});
export function accountAudit(installation, account, action = "create") {
  return {
    id: `aud_${randomUUID()}`,
    installationId: installation.id,
    namespaceId: account.namespaceId,
    occurredAt: new Date().toISOString(),
    kind: "mutation",
    actorId: "service-account-repository",
    action,
    resource: { kind: "service_account", id: account.id, namespaceId: account.namespaceId },
    outcome: "success",
  };
}
export async function assertServiceAccountClosed(repository, account, writable = true) {
  const { namespaceId, id } = account;
  const calls = [
    () => repository.findServiceAccount(namespaceId, id),
    () => repository.listServiceAccounts(namespaceId),
    () => repository.findServiceAccountProviderBinding(namespaceId, id),
  ];
  if (writable)
    calls.push(
      () => repository.lockServiceAccount(namespaceId, id),
      () => repository.createServiceAccount(account),
      () => repository.updateCredential(namespaceId, id, accountCredential()),
      () => repository.deleteServiceAccount(namespaceId, id),
    );
  // Retained methods must reject with the exact scope error after owner closure.
  // The outer lifecycle phase or the borrowed repository lifetime can fence the
  // call first; their diagnostic text is not a shared repository contract.
  for (const call of calls)
    await assert.rejects(call(), (error) => {
      assert.equal(error.constructor, ScopeViolationError);
      return true;
    });
}

/** Run first on a fresh store; bootstrap and all its children roll back. */
export async function verifyServiceAccountBootstrap(store) {
  assert.equal(await store.read((s) => s.installations.getInstallation()), undefined);
  const resources = serviceAccountResources();
  const { namespace, account, configuration, agent } = resources;
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "ServiceAccount bootstrap",
    createdAt: namespace.createdAt,
  };
  const rollback = new Error("rollback account bootstrap");
  let retained;
  await assert.rejects(
    store.transact(async (s) => {
      retained = s.serviceAccounts;
      assert.equal(await retained.findServiceAccount(namespace.id, account.id), undefined);
      assert.deepEqual(await retained.listServiceAccounts(namespace.id), []);
      assert.equal(
        await retained.findServiceAccountProviderBinding(namespace.id, account.id),
        undefined,
      );
      assert.equal(await retained.lockServiceAccount(namespace.id, account.id), undefined);
      assert.equal(
        await retained.updateCredential(namespace.id, account.id, accountCredential()),
        undefined,
      );
      assert.equal(await retained.deleteServiceAccount(namespace.id, account.id), false);
      await assert.rejects(retained.createServiceAccount(account), {
        name: "ScopeViolationError",
        message: "The server-owned Installation has not been initialized.",
      });
      // This repository predates Installation; raw Agent validation must see the
      // newly created account through this same transaction and live snapshot.
      await s.installations.createInstallation(installation);
      await s.namespaces.createNamespace(namespace);
      assert.deepEqual(await retained.createServiceAccount(account), account);
      await s.configurations.createConfiguration(configuration);
      assert.deepEqual(await s.agents.createAgent(agent), agent);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  await store.read(async (s) => {
    assert.equal(await s.installations.getInstallation(), undefined);
    assert.equal(await s.namespaces.findNamespace(namespace.id), undefined);
    assert.equal(await s.serviceAccounts.findServiceAccount(namespace.id, account.id), undefined);
    assert.equal(
      await s.configurations.findConfiguration(namespace.id, configuration.id),
      undefined,
    );
    assert.equal(await s.agents.findAgent(namespace.id, agent.id), undefined);
  });
  await assertServiceAccountClosed(retained, account);
}

export async function verifyServiceAccountMetadata(store) {
  await seedConfigurationInstallation(store);
  const owner = serviceAccountResources();
  const foreign = serviceAccountResources();
  const account = { ...owner.account, name: "bravo" };
  const expected = structuredClone(account);
  const peers = ["alpha", "charlie"].map((name) => ({
    ...structuredClone(account),
    id: `sa_${randomUUID()}`,
    name,
  }));
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(owner.namespace);
    await s.namespaces.createNamespace(foreign.namespace);
    const created = await s.serviceAccounts.createServiceAccount(account);
    assert.deepEqual(created, expected);
    for (const value of [created, created.credential, created.credential.secretRef])
      assert.ok(Object.isFrozen(value));
    assert.deepEqual(Object.keys(created).sort(), ["credential", "id", "name", "namespaceId"]);
    for (const peer of peers) await s.serviceAccounts.createServiceAccount(peer);
    await s.serviceAccounts.createServiceAccount({ ...foreign.account, name: expected.name });
  });
  account.credential.secretRef.name = "changed.caller";
  account.name = "changed caller";
  await store.read(async (s) => {
    assert.deepEqual(
      await s.serviceAccounts.findServiceAccount(owner.namespace.id, expected.id),
      expected,
    );
    const listed = await s.serviceAccounts.listServiceAccounts(owner.namespace.id);
    assert.deepEqual(listed, [peers[0], expected, peers[1]]);
    assert.ok(Object.isFrozen(listed));
    assert.ok(listed.every((value) => Object.isFrozen(value.credential.secretRef)));
    assert.equal(
      await s.serviceAccounts.findServiceAccount(foreign.namespace.id, expected.id),
      undefined,
    );
  });
  for (const duplicate of [
    expected,
    { ...expected, id: `sa_${randomUUID()}` },
    { ...expected, namespaceId: foreign.namespace.id, name: `unique-${randomUUID()}` },
  ])
    await assert.rejects(
      store.transact((s) => s.serviceAccounts.createServiceAccount(duplicate)),
      ResourceConflictError,
    );
  await store.transact(async (s) => {
    assert.deepEqual(
      await s.serviceAccounts.lockServiceAccount(owner.namespace.id, expected.id),
      expected,
    );
    assert.equal(
      await s.serviceAccounts.lockServiceAccount(foreign.namespace.id, expected.id),
      undefined,
    );
    assert.equal(
      await s.serviceAccounts.updateCredential(
        foreign.namespace.id,
        expected.id,
        accountCredential(),
      ),
      undefined,
    );
    assert.equal(
      await s.serviceAccounts.deleteServiceAccount(foreign.namespace.id, expected.id),
      false,
    );
    assert.equal(
      await s.serviceAccounts.findServiceAccountProviderBinding(owner.namespace.id, expected.id),
      undefined,
    );
  });
  // Unicode forms remain distinct. Ordering across backends is intentionally
  // checked separately; the shared ordering above uses unique lowercase ASCII.
  const unicode = ["é", "e\u0301"].map((name) => ({ ...expected, id: `sa_${randomUUID()}`, name }));
  for (const value of unicode) {
    await store.transact((s) => s.serviceAccounts.createServiceAccount(value));
    assert.deepEqual(
      await store.read((s) => s.serviceAccounts.findServiceAccount(value.namespaceId, value.id)),
      value,
    );
  }
}

export async function verifyServiceAccountConstraints(store, { backend }) {
  await seedConfigurationInstallation(store);
  const { namespace, account } = serviceAccountResources({ status: "provisioning" });
  await store.transact((s) => s.namespaces.createNamespace(namespace));
  for (const invalid of [
    { id: "sa_invalid" },
    { name: "" },
    { name: " padded " },
    { name: "control\nname" },
    { name: "a".repeat(201) },
    { credential: { kind: "unknown", secretRef: { name: "valid", key: "token" } } },
    { credential: { kind: "api_key", secretRef: { name: "bad_name", key: "token" } } },
    { credential: { kind: "api_key", secretRef: { name: "valid", key: ".." } } },
    { credential: { ...accountCredential(), value: "not-a-reference" } },
  ])
    await assert.rejects(
      store.transact((s) => s.serviceAccounts.createServiceAccount({ ...account, ...invalid })),
      ScopeViolationError,
    );
  await store.transact((s) => s.serviceAccounts.createServiceAccount(account));
  for (const kind of ["api_key", "access_token", "oauth_access_token"]) {
    const next = accountCredential(kind);
    const result = await store.transact((s) =>
      s.serviceAccounts.updateCredential(namespace.id, account.id, next),
    );
    assert.deepEqual(result, { ...account, credential: next });
    next.secretRef.key = "changed";
    assert.deepEqual(
      (await store.read((s) => s.serviceAccounts.findServiceAccount(namespace.id, account.id)))
        .credential,
      accountCredential(kind),
    );
  }
  const invalid = { kind: "unknown", secretRef: { name: "valid", key: "token" } };
  await assert.rejects(
    store.transact((s) => s.serviceAccounts.updateCredential(namespace.id, account.id, invalid)),
    ScopeViolationError,
  );
  const missingUpdate = store.transact((s) =>
    s.serviceAccounts.updateCredential(namespace.id, `sa_${randomUUID()}`, invalid),
  );
  if (backend === "memory") await assert.rejects(missingUpdate, ScopeViolationError);
  else assert.equal(await missingUpdate, undefined);
  // JavaScript counts UTF-16 units; the existing SQL constraint counts characters.
  const astral = { ...account, id: `sa_${randomUUID()}`, name: "😀".repeat(101) };
  if (backend === "memory")
    await assert.rejects(
      store.transact((s) => s.serviceAccounts.createServiceAccount(astral)),
      ScopeViolationError,
    );
  else {
    await store.transact((s) => s.serviceAccounts.createServiceAccount(astral));
    await store.transact((s) => s.serviceAccounts.deleteServiceAccount(namespace.id, astral.id));
  }
  await store.transact(async (s) => {
    assert.equal(await s.namespaces.hasServiceAccounts(namespace.id), true);
    assert.equal(await s.serviceAccounts.deleteServiceAccount(namespace.id, account.id), true);
    assert.equal(await s.serviceAccounts.deleteServiceAccount(namespace.id, account.id), false);
    assert.equal(await s.namespaces.hasServiceAccounts(namespace.id), false);
    // Only an empty Namespace enters deletion; do not synthesize a live account under a tombstone.
    await s.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "deleting");
  });
  await assert.rejects(
    store.transact((s) => s.serviceAccounts.createServiceAccount(account)),
    ScopeViolationError,
  );
  await store.transact(async (s) => {
    await s.namespaces.markNamespaceDeleted(namespace.id, namespace.createdAt);
    assert.deepEqual(await s.serviceAccounts.listServiceAccounts(namespace.id), []);
    assert.equal(await s.serviceAccounts.findServiceAccount(namespace.id, account.id), undefined);
  });
  const unavailable = serviceAccountResources({ status: "failed" });
  await store.transact((s) => s.namespaces.createNamespace(unavailable.namespace));
  await assert.rejects(
    store.transact((s) => s.serviceAccounts.createServiceAccount(unavailable.account)),
    ScopeViolationError,
  );
}

export async function verifyServiceAccountAssociations(store) {
  await seedConfigurationInstallation(store);
  const r = serviceAccountResources();
  const revision = serviceAccountRevision(r);
  const secondAgent = {
    ...r.agent,
    id: `agt_${randomUUID()}`,
    name: "Second account owner",
    servicePrincipalId: randomUUID(),
  };
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(r.namespace);
    await s.serviceAccounts.createServiceAccount(r.account);
    await s.configurations.createConfiguration(r.configuration);
    await s.agents.createAgent(r.agent);
    await s.agents.createAgent(secondAgent);
    await s.revisions.createRevision(revision);
    await s.operations.append(accountWork(revision));
  });
  await assert.rejects(
    store.transact((s) => s.serviceAccounts.deleteServiceAccount(r.namespace.id, r.account.id)),
    ScopeViolationError,
  );
  const changed = { kind: "api_key", secretRef: { name: "replacement.credentials", key: "token" } };
  await store.transact((s) =>
    s.serviceAccounts.updateCredential(r.namespace.id, r.account.id, changed),
  );
  assert.deepEqual(
    await store.read((s) => s.revisions.findRevision(r.namespace.id, r.agent.id, revision.id)),
    revision,
  );
  await store.transact(async (s) => {
    // Detaching one current Agent does not release the other association.
    const detached = await s.agents.updateConfiguration(
      r.namespace.id,
      r.agent.id,
      r.configuration.id,
      undefined,
      null,
    );
    assert.equal(Object.hasOwn(detached, "serviceAccountId"), false);
  });
  await assert.rejects(
    store.transact((s) => s.serviceAccounts.deleteServiceAccount(r.namespace.id, r.account.id)),
    ScopeViolationError,
  );
  await store.transact(async (s) => {
    const detached = await s.agents.updateConfiguration(
      r.namespace.id,
      secondAgent.id,
      r.configuration.id,
      undefined,
      null,
    );
    assert.equal(Object.hasOwn(detached, "serviceAccountId"), false);
    // Historical revision/work snapshots do not become a new deletion guard.
    assert.equal(await s.serviceAccounts.deleteServiceAccount(r.namespace.id, r.account.id), true);
    assert.deepEqual(
      await s.revisions.findRevision(r.namespace.id, r.agent.id, revision.id),
      revision,
    );
    assert.deepEqual(
      (await s.operations.list()).filter((work) => work.resourceId === revision.id),
      [accountWork(revision)],
    );
  });
}

export async function verifyServiceAccountLifetime(store) {
  await seedConfigurationInstallation(store);
  for (const scenario of ["create", "update", "delete", "agent"])
    for (const commit of [true, false]) {
      const r = serviceAccountResources();
      const replacement = accountCredential("access_token");
      await store.transact(async (s) => {
        await s.namespaces.createNamespace(r.namespace);
        if (scenario !== "create") await s.serviceAccounts.createServiceAccount(r.account);
        if (scenario === "agent") await s.configurations.createConfiguration(r.configuration);
      });
      const rollback = new Error("rollback admitted account operation");
      let retained, admitted;
      const result = store.transact(async (s) => {
        retained = s.serviceAccounts;
        const call = {
          create: () => retained.createServiceAccount(r.account),
          update: () => retained.updateCredential(r.namespace.id, r.account.id, replacement),
          delete: () => retained.deleteServiceAccount(r.namespace.id, r.account.id),
          agent: () => s.agents.createAgent(r.agent),
        }[scenario];
        // The accepted operation must finish its raw inward collaborators after
        // the callback closes outward admission on commit and callback failure.
        admitted = Promise.allSettled([call()]);
        if (!commit) throw rollback;
      });
      if (commit) await result;
      else await assert.rejects(result, (error) => error === rollback);
      const value = {
        create: r.account,
        update: { ...r.account, credential: replacement },
        delete: true,
        agent: r.agent,
      }[scenario];
      assert.deepEqual(await admitted, [{ status: "fulfilled", value }]);
      await assertServiceAccountClosed(retained, r.account);
      let read;
      await store.read(async (s) => {
        read = s.serviceAccounts;
        assert.deepEqual(Object.keys(read).sort(), [
          "findServiceAccount",
          "findServiceAccountProviderBinding",
          "listServiceAccounts",
        ]);
        const committedAccounts = {
          create: r.account,
          delete: undefined,
          update: { ...r.account, credential: replacement },
          agent: r.account,
        };
        const original = scenario === "create" ? undefined : r.account;
        const expected = commit ? committedAccounts[scenario] : original;
        assert.deepEqual(await read.findServiceAccount(r.namespace.id, r.account.id), expected);
        assert.deepEqual(
          await s.agents.findAgent(r.namespace.id, r.agent.id),
          scenario === "agent" && commit ? r.agent : undefined,
        );
      });
      await assertServiceAccountClosed(read, r.account, false);
    }
  const r = serviceAccountResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(r.namespace);
    await s.serviceAccounts.createServiceAccount(r.account);
  });
  const signal = new AbortController();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let retained;
  const reading = store.read(
    async (s) => {
      retained = s.serviceAccounts;
      assert.deepEqual(await retained.findServiceAccount(r.namespace.id, r.account.id), r.account);
      entered.resolve();
      await release.promise;
    },
    { signal: signal.signal, timeoutMs: 3000 },
  );
  reading.catch(entered.reject);
  try {
    await entered.promise;
    signal.abort();
    await assert.rejects(reading, DependencyUnavailableError);
    await assertServiceAccountClosed(retained, r.account, false);
  } finally {
    release.resolve();
    await Promise.allSettled([reading]);
  }
  assert.deepEqual(
    await store.read((s) => s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id)),
    r.account,
  );
}

async function writeAccountBundle(s, r, revision, audit) {
  await s.namespaces.createNamespace(r.namespace);
  await s.serviceAccounts.createServiceAccount(r.account);
  await s.secrets.createSecret(r.secret);
  await s.configurations.createConfiguration({
    ...r.configuration,
    secretBindings: configurationBindings(r.secret),
  });
  await s.agents.createAgent(r.agent);
  await s.revisions.createRevision(revision);
  await s.operations.append(accountWork(revision));
  await s.audit.append(audit);
}
async function assertAccountBundle(store, r, revision, audit, committed) {
  await store.read(async (s) => {
    for (const [actual, expected] of [
      [await s.namespaces.findNamespace(r.namespace.id), r.namespace],
      [await s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id), r.account],
      [await s.secrets.findSecret(r.namespace.id, r.secret.id), r.secret],
      [
        await s.configurations.findConfiguration(r.namespace.id, r.configuration.id),
        { ...r.configuration, secretBindings: configurationBindings(r.secret) },
      ],
      [await s.agents.findAgent(r.namespace.id, r.agent.id), r.agent],
      [await s.revisions.findRevision(r.namespace.id, r.agent.id, revision.id), revision],
    ])
      assert.deepEqual(actual, committed ? expected : undefined);
    assert.deepEqual(
      (await s.audit.list()).filter((event) => event.id === audit.id),
      committed ? [audit] : [],
    );
    assert.deepEqual(
      (await s.operations.list()).filter((work) => work.resourceId === revision.id),
      committed ? [accountWork(revision)] : [],
    );
  });
}
export async function verifyServiceAccountAtomicity(store) {
  const installation = await seedConfigurationInstallation(store);
  for (const outcome of ["commit", "callback failure", "audit failure"]) {
    const r = serviceAccountResources();
    const revision = serviceAccountRevision(r, 1, true);
    const audit = accountAudit(installation, r.account);
    const rollback = new Error("account bundle rollback");
    const result = store.transact(async (s) => {
      await writeAccountBundle(s, r, revision, audit);
      if (outcome === "callback failure") throw rollback;
      if (outcome === "audit failure")
        await s.audit.append({
          ...audit,
          id: `aud_${randomUUID()}`,
          installationId: `ins_${randomUUID()}`,
        });
    });
    if (outcome === "commit") await result;
    else
      await assert.rejects(
        result,
        outcome === "callback failure" ? (error) => error === rollback : ScopeViolationError,
      );
    await assertAccountBundle(store, r, revision, audit, outcome === "commit");
  }
  const r = serviceAccountResources();
  await store.transact(async (s) => {
    await s.namespaces.createNamespace(r.namespace);
    await s.serviceAccounts.createServiceAccount(r.account);
  });
  const audit = accountAudit(installation, r.account, "delete");
  const rollback = new Error("account delete audit rollback");
  await assert.rejects(
    store.transact(async (s) => {
      assert.equal(
        await s.serviceAccounts.deleteServiceAccount(r.namespace.id, r.account.id),
        true,
      );
      await s.audit.append(audit);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  assert.deepEqual(
    await store.read((s) => s.serviceAccounts.findServiceAccount(r.namespace.id, r.account.id)),
    r.account,
  );
  assert.equal(
    (await store.read((s) => s.audit.list())).some((event) => event.id === audit.id),
    false,
  );
}
export async function verifyServiceAccountPoison(store) {
  // Exercise the existing persistence guard, not a synthetic poison flag or
  // live runtime/provider authority claim.
  const owner = await seedAuthority(store);
  const before = await owner.record();
  const r = serviceAccountResources();
  const revision = serviceAccountRevision(r, 1, true);
  const audit = accountAudit(owner.installation, r.account);
  const missing = `rev_${randomUUID()}`;
  let returned = false;
  const failure = {
    name: "ScopeViolationError",
    message: "The runtime authority target is unavailable.",
  };
  await assert.rejects(
    store.transact(async (s) => {
      await writeAccountBundle(s, r, revision, audit);
      await s.runtimeAuthority.appendMutation(owner.bind, writer);
      await assert.rejects(
        s.runtimeAuthority.appendMutation(
          {
            ...owner.evidence,
            target: { ...owner.target, revisionId: missing },
            evidence: {
              ...owner.evidence.evidence,
              target: { ...owner.target, revisionId: missing },
            },
          },
          writer,
        ),
        failure,
      );
      returned = true;
    }),
    failure,
  );
  assert.equal(returned, true);
  await assertAccountBundle(store, r, revision, audit, false);
  assert.deepEqual(await owner.record(), before);
  assert.equal(await owner.operation(owner.bind.operationRef), undefined);
}
export const serviceAccountStoreCases = [
  ["preserves immutable metadata, exact identities and list scope", verifyServiceAccountMetadata],
  [
    "retains credential constraints and supported empty Namespace lifecycle",
    verifyServiceAccountConstraints,
  ],
  [
    "blocks current Agent associations while retaining immutable revision snapshots",
    verifyServiceAccountAssociations,
  ],
  [
    "drains admitted create/update/delete and Agent calls and cancels real reads",
    verifyServiceAccountLifetime,
  ],
  [
    "commits or rolls back account, Secret, Configuration, Agent, revision, audit and work together",
    verifyServiceAccountAtomicity,
  ],
  [
    "rolls back account and sibling writes after caught authority poison",
    verifyServiceAccountPoison,
  ],
];
