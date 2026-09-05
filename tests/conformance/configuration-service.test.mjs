import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { MutationRunner } from "../../packages/occ/src/application/mutation-runner.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { CONFIGURATION_REPOSITORIES } from "../../packages/occ/src/services/configuration/port.ts";
import { ConfigurationService } from "../../packages/occ/src/services/configuration/service.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

function fixture() {
  const installation = { id: id("ins"), name: "Configuration service", createdAt: now() };
  const store = new InMemoryPlatformState();
  const runner = new MutationRunner(installation, store);
  const drivers = new DriverSelection();
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: ["administrator", "reader"].map((principal) => ({
        kind: "principal",
        id: principal,
        issuer: "service-test",
        subject: principal,
      })),
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: "administrator-role",
          permissions: [
            ...["create", "read", "update", "delete"].map((action) => ({
              action,
              resourceKind: "configuration",
            })),
            { action: "operate", resourceKind: "secret" },
          ],
        },
        { id: "reader-role", permissions: [{ action: "read", resourceKind: "configuration" }] },
      ],
      bindings: ["administrator", "reader"].map((principal) => ({
        id: `${principal}-binding`,
        subjectKind: "identity",
        subjectId: principal,
        roleId: `${principal}-role`,
      })),
    }),
  });
  const configurationDriver = createTestConfigurationDriver();
  const secretDriver = createTestSecretDriver();
  for (const driver of [iam, configurationDriver, secretDriver]) {
    drivers.registerDriver(driver);
    drivers.selectDriver(driver.capability, driver.id);
  }
  const service = new ConfigurationService({
    repositories: runner.forRepositories(CONFIGURATION_REPOSITORIES),
    authorization: new ExactAuthorization(() => drivers.selectedDriver("iam")),
    configurationDriver: () => drivers.configurationDriver(),
    assertSecretDriverOwner: (expectedId) => {
      drivers.secretDriver(expectedId);
    },
    createId: () => id("cfg"),
    now,
  });
  async function namespace(overrides = {}) {
    const value = {
      id: id("ns"),
      name: `configuration-${randomUUID()}`,
      status: "provisioning",
      createdAt: now(),
      ...overrides,
    };
    await runner.transact((unit) => unit.namespaces.createNamespace(value));
    return value;
  }
  async function secret(namespaceId) {
    const identity = { id: id("sec"), namespaceId, name: `configuration-secret-${randomUUID()}` };
    const backendRef = await secretDriver.create(identity, "test-value");
    const value = { ...identity, driverId: secretDriver.id, backendRef, createdAt: now() };
    await runner.transact((unit) => unit.secrets.createSecret(value));
    return value;
  }
  return {
    installation,
    store,
    runner,
    drivers,
    configurationDriver,
    secretDriver,
    service,
    namespace,
    secret,
  };
}

const input = (namespaceId, values = { agents: { defaults: { model: "example" } } }) => ({
  namespaceId,
  kind: "agent",
  values,
});

test("Configuration queries preserve lazy Installation and mutations use the same owner", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.getConfiguration("reader", id("ns"), id("cfg")),
    ScopeViolationError,
  );
  assert.equal(await f.store.read((view) => view.installations.getInstallation()), undefined);
  const namespace = await f.namespace();
  const created = await f.service.createConfiguration("administrator", input(namespace.id));
  assert.deepEqual(
    await f.store.read((view) => view.installations.getInstallation()),
    f.installation,
  );
  assert.equal(created.namespaceId, namespace.id);
});

test("Configuration service owns immutable values, exact scope and serialized replacement generations", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const values = { plugins: { entries: { example: { enabled: true } } } };
  const created = await f.service.createConfiguration("administrator", input(namespace.id, values));
  values.plugins.entries.example.enabled = false;
  assert.equal(created.values.plugins.entries.example.enabled, true);
  assert.ok(Object.isFrozen(created.values.plugins.entries.example));
  const other = await f.namespace();
  await assert.rejects(
    f.service.getConfiguration("reader", other.id, created.id),
    ScopeViolationError,
  );
  await assert.rejects(
    f.service.updateConfiguration("reader", {
      namespaceId: namespace.id,
      configurationId: created.id,
      values: {},
    }),
    AuthorizationDeniedError,
  );
  const updated = await Promise.all(
    ["first", "second"].map((model) =>
      f.service.updateConfiguration("administrator", {
        namespaceId: namespace.id,
        configurationId: created.id,
        values: { model },
      }),
    ),
  );
  assert.deepEqual(
    updated.map((configuration) => configuration.generation),
    [2, 3],
  );
  assert.deepEqual((await f.service.getConfiguration("reader", namespace.id, created.id)).values, {
    model: "second",
  });
});

test("Configuration service retains Secret references and requires the current owning Driver", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const secret = await f.secret(namespace.id);
  const bindings = {
    APP_TOKEN: { source: { kind: "secret", id: secret.id, namespaceId: namespace.id } },
  };
  const created = await f.service.createConfiguration("administrator", {
    ...input(namespace.id),
    secretBindings: bindings,
  });
  const updated = await f.service.updateConfiguration("administrator", {
    namespaceId: namespace.id,
    configurationId: created.id,
    values: {},
  });
  assert.deepEqual(updated.secretBindings, created.secretBindings);
  assert.equal(
    await f.runner.transact((view) => view.secrets.hasReferences(namespace.id, secret.id)),
    true,
  );
  const other = await f.namespace();
  await assert.rejects(
    f.service.createConfiguration("administrator", {
      ...input(other.id),
      secretBindings: bindings,
    }),
    ScopeViolationError,
  );
  const replacement = createTestSecretDriver({ id: "another-secret-driver" });
  f.drivers.registerDriver(replacement);
  f.drivers.selectDriver("secret", replacement.id);
  await assert.rejects(
    f.service.updateConfiguration("administrator", {
      namespaceId: namespace.id,
      configurationId: created.id,
      values: {},
    }),
    DependencyUnavailableError,
  );
  assert.equal(
    (await f.service.getConfiguration("reader", namespace.id, created.id)).generation,
    2,
  );
});

test("Configuration admission preserves adopted Namespace readiness and immutable kind", async () => {
  const f = fixture();
  const adopted = await f.namespace({ existingNamespace: "adopted-configuration-tenant" });
  await assert.rejects(
    f.service.createConfiguration("administrator", input(adopted.id)),
    NamespaceNotReadyError,
  );
  const failed = await f.namespace({ status: "failed" });
  await assert.rejects(
    f.service.createConfiguration("administrator", input(failed.id)),
    ResourceConflictError,
  );
  const namespace = await f.namespace();
  const created = await f.service.createConfiguration("administrator", input(namespace.id));
  await assert.rejects(
    f.service.updateConfiguration("administrator", {
      namespaceId: namespace.id,
      configurationId: created.id,
      kind: "agent",
      values: {},
    }),
    ScopeViolationError,
  );
  assert.equal(
    (await f.service.getConfiguration("reader", namespace.id, created.id)).generation,
    1,
  );
});

test("Configuration service compensates its Driver when the enclosing resource transaction fails", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createConfiguration("administrator", input(namespace.id));
  const failure = new Error("enclosing mutation rejected");
  // The service joins the real MutationRunner context; outer failure must undo
  // both its metadata generation and its already-completed storage replacement.
  await assert.rejects(
    f.runner.transact(async () => {
      await f.service.updateConfiguration("administrator", {
        namespaceId: namespace.id,
        configurationId: created.id,
        values: { model: "replacement" },
      });
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await f.service.getConfiguration("reader", namespace.id, created.id), created);
  await assert.rejects(
    f.runner.transact(async () => {
      await f.service.deleteConfiguration("administrator", namespace.id, created.id);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await f.service.getConfiguration("reader", namespace.id, created.id), created);
});

test("Configuration editing preconditions reject stale and malformed generations without replacement", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createConfiguration("administrator", input(namespace.id));
  const update = {
    namespaceId: namespace.id,
    configurationId: created.id,
    values: { model: "new" },
  };
  for (const expectedGeneration of [
    null,
    0,
    -1,
    1.5,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
  ]) {
    await assert.rejects(
      f.service.updateConfiguration("administrator", { ...update, expectedGeneration }),
      ScopeViolationError,
    );
  }
  const updated = await f.service.updateConfiguration("administrator", {
    ...update,
    expectedGeneration: 1,
  });
  assert.equal(updated.generation, 2);
  const metadata = await f.store.read((view) =>
    view.configurations.findConfiguration(namespace.id, created.id),
  );
  await assert.rejects(
    f.service.updateConfiguration("administrator", {
      ...update,
      expectedGeneration: 1,
      values: { model: "stale" },
    }),
    ResourceConflictError,
  );
  assert.deepEqual(await f.service.getConfiguration("reader", namespace.id, created.id), updated);
  assert.deepEqual(await f.configurationDriver.read(created), { ...updated });
  assert.deepEqual(
    await f.store.read((view) => view.configurations.findConfiguration(namespace.id, created.id)),
    metadata,
  );
});

test("only one competing Configuration edit can consume a supplied generation", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createConfiguration("administrator", input(namespace.id));
  const outcomes = await Promise.allSettled(
    ["first", "second"].map((model) =>
      f.service.updateConfiguration("administrator", {
        namespaceId: namespace.id,
        configurationId: created.id,
        expectedGeneration: 1,
        values: { model },
      }),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(rejected.reason instanceof ResourceConflictError);
  const winner = outcomes.find((outcome) => outcome.status === "fulfilled").value;
  assert.equal(winner.generation, 2);
  assert.deepEqual(await f.service.getConfiguration("reader", namespace.id, created.id), winner);
});
