import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { PostgresCommitOutcomeUnknownError as legacyError } from "../../packages/occ/src/state/postgres-state.ts";
import {
  PostgresCommitOutcomeUnknownError as rootError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { PostgresCommitOutcomeUnknownError } from "@openclaw-enterprise/occ/ports/transaction-errors";
import { RepositoryTransactionLifetime } from "@openclaw-enterprise/occ/ports/transaction";
import { memoryConfigurationReader } from "../fixtures/repository-factories/producer.ts";

const fixture = (kind) => `${kind}_${randomUUID()}`;
const namespace = () => ({
  id: fixture("ns"),
  name: `repository-${randomUUID()}`,
  status: "ready",
  createdAt: new Date().toISOString(),
});
async function initialized(options) {
  const store = new InMemoryPlatformState(options);
  await store.transact((unit) =>
    unit.installations.createInstallation({
      id: fixture("ins"),
      name: "Repository transactions",
      createdAt: new Date().toISOString(),
    }),
  );
  return store;
}

test("independent factory producer and consumer compile through supported package exports", async () => {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./bin/tsc", import.meta.resolve("typescript/package.json"))),
    "--project",
    fileURLToPath(new URL("../fixtures/repository-factories/tsconfig.json", import.meta.url)),
    "--pretty",
    "false",
  ]);
});

test("compatibility imports retain the single unknown-commit runtime constructor", () => {
  assert.equal(legacyError, PostgresCommitOutcomeUnknownError);
  assert.equal(rootError, PostgresCommitOutcomeUnknownError);
  const failure = new legacyError();
  assert.ok(failure instanceof rootError);
  assert.ok(failure instanceof DependencyUnavailableError);
  assert.equal(failure.name, "PostgresCommitOutcomeUnknownError");
  assert.equal(failure.message, "The PostgreSQL transaction commit outcome is unknown.");
});

test("memory read projections hide writes and close cached and ordinary read handles", async () => {
  const store = await initialized();
  let read;
  await store.read(async (view) => {
    read = view;
    assert.deepEqual(Object.keys(view.audit), ["list"]);
    assert.deepEqual(Object.keys(view.operations), ["list"]);
    assert.deepEqual(Object.keys(view.namespaces).sort(), ["findNamespace", "listNamespaces"]);
    assert.equal(Object.hasOwn(view.installations, "createInstallation"), false);
    assert.equal(Object.hasOwn(view.runtimeAuthority, "appendMutation"), false);
    assert.ok(await view.installations.getInstallation());
  });
  await assert.rejects(read.installations.getInstallation(), ScopeViolationError);
  await assert.rejects(read.namespaces.listNamespaces(), ScopeViolationError);
});

test("memory committed and rolled-back units cannot mutate through escaped handles", async () => {
  const store = await initialized();
  let committed;
  await store.transact(async (unit) => {
    committed = unit;
  });
  const candidate = namespace();
  await assert.rejects(committed.namespaces.createNamespace(candidate), ScopeViolationError);
  assert.equal(await store.read((view) => view.namespaces.findNamespace(candidate.id)), undefined);
  let rejected;
  const failure = new Error("rollback");
  await assert.rejects(
    store.transact(async (unit) => {
      rejected = unit;
      await unit.namespaces.createNamespace(candidate);
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(rejected.namespaces.createNamespace(namespace()), ScopeViolationError);
  assert.equal(await store.read((view) => view.namespaces.findNamespace(candidate.id)), undefined);
});

test("accepted serialized channel operations drain before the memory unit is published", async () => {
  const store = await initialized();
  const installation = await store.read((read) => read.installations.getInstallation());
  const now = new Date().toISOString();
  const channel = {
    id: fixture("chi"),
    installationId: installation.id,
    version: 1,
    status: "enabled",
    createdAt: now,
    updatedAt: now,
    createdBy: "actor",
    updatedBy: "actor",
    platform: "slack",
    providerTenantRef: "tenant",
    recipientAppRef: "app",
  };
  let accepted;
  await store.transact(async (unit) => {
    accepted = unit.channelBindings.createChannelInstallation(channel);
  });
  assert.deepEqual(await accepted, channel);
  assert.deepEqual(
    await store.read((read) => read.channelBindings.findChannelInstallation(channel.id)),
    channel,
  );
});

test("memory audit failure rolls back resources and work and closes its unit", async () => {
  const failure = new Error("audit unavailable");
  const store = await initialized({
    auditSink: {
      async append() {
        throw failure;
      },
    },
  });
  const installation = await store.read((read) => read.installations.getInstallation());
  const candidate = namespace();
  let rejected;
  await assert.rejects(
    store.transact(async (unit) => {
      rejected = unit;
      await unit.namespaces.createNamespace(candidate);
      await unit.operations.append({
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: candidate.id,
        resourceId: candidate.id,
        actorId: "actor",
      });
      await unit.audit.append({
        id: fixture("aud"),
        installationId: installation.id,
        namespaceId: candidate.id,
        occurredAt: candidate.createdAt,
        kind: "mutation",
        actorId: "actor",
        action: "create",
        resource: { kind: "namespace", id: candidate.id, namespaceId: candidate.id },
        outcome: "success",
      });
    }),
    DependencyUnavailableError,
  );
  assert.equal(await store.read((read) => read.namespaces.findNamespace(candidate.id)), undefined);
  assert.deepEqual(store.pendingOperations(), []);
  await assert.rejects(rejected.audit.list(), ScopeViolationError);
});

test("cancelled memory reads close retained handles without awaiting the callback", async () => {
  const store = await initialized();
  const controller = new AbortController();
  let retained;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const result = store.read(
    async (read) => {
      retained = read;
      entered();
      await new Promise(() => {});
    },
    { signal: controller.signal, timeoutMs: 1000 },
  );
  await ready;
  controller.abort();
  await assert.rejects(result, DependencyUnavailableError);
  await assert.rejects(retained.installations.getInstallation(), ScopeViolationError);
});

test("independent snapshot factory uses exact immutable scope and the owner's lifetime", async () => {
  const transaction = new RepositoryTransactionLifetime();
  const row = Object.freeze({
    id: fixture("cfg"),
    namespaceId: fixture("ns"),
    kind: "agent",
    generation: 1,
    createdAt: new Date().toISOString(),
  });
  const reader = memoryConfigurationReader({
    transaction,
    scope: Object.freeze({ installationId: fixture("ins"), namespaceId: row.namespaceId }),
    snapshot: { configurations: new Map([[row.id, row]]) },
  });
  assert.deepEqual(await reader.findConfiguration(row.namespaceId, row.id), row);
  assert.equal(await reader.findConfiguration("foreign", row.id), undefined);
  await transaction.finish();
  await assert.rejects(reader.findConfiguration(row.namespaceId, row.id), ScopeViolationError);
});
