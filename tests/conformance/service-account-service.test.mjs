import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  InMemoryPlatformState,
  OpenClawController,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { ServiceAccountService } from "../../packages/occ/src/services/service-account/service.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const credential = (kind = "api_key") => ({
  kind,
  secretRef: { name: "account-credential", key: "token" },
});

function fixture({ managed = false } = {}) {
  const state = new InMemoryPlatformState();
  const bindings = [
    {
      id: "administrator-binding",
      subjectKind: "identity",
      subjectId: "administrator",
      roleId: "administrator-role",
    },
  ];
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: ["administrator", "reader", "unprivileged"].map((principal) => ({
        kind: "principal",
        id: principal,
        issuer: "service-account-test",
        subject: principal,
      })),
      groups: [],
      memberships: [],
      restrictions: [],
      bindings,
      roles: [
        {
          id: "administrator-role",
          permissions: Object.entries({
            namespace: ["create", "read"],
            service_account: ["create", "read", "update", "delete"],
            configuration: ["create", "read"],
            agent: ["create", "read"],
          }).flatMap(([resourceKind, actions]) =>
            actions.map((action) => ({ action, resourceKind })),
          ),
        },
        {
          id: "reader-role",
          permissions: [
            { action: "read", resourceKind: "namespace" },
            { action: "read", resourceKind: "service_account" },
          ],
        },
      ],
    }),
  });
  const controller = new OpenClawController(
    { id: id("ins"), name: "ServiceAccount service", createdAt: new Date().toISOString() },
    { state, recordOperations: false },
  );
  for (const driver of [iam, createTestConfigurationDriver()]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const externalAccounts = new Set();
  const externalCredentials = new Set();
  const failures = {};
  // Passive external effects make rollback observable while OCC owns all policy and persistence.
  const driver = {
    id: "service-account-test",
    capability: "service_account",
    implementation: "passive-service-account-test",
    async create(account) {
      if (failures.create) throw failures.create;
      externalAccounts.add(account.id);
      controller.registerRollback(async () => {
        externalAccounts.delete(account.id);
      });
    },
    async createCredential(account) {
      if (failures.credential) throw failures.credential;
      externalCredentials.add(account.id);
      controller.registerRollback(async () => {
        externalCredentials.delete(account.id);
      });
      return credential(failures.credentialKind ?? "access_token");
    },
    async delete(account) {
      if (failures.delete) throw failures.delete;
      externalCredentials.delete(account.id);
      externalAccounts.delete(account.id);
    },
  };
  if (managed) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  assert.ok(controller.serviceAccount instanceof ServiceAccountService);
  return {
    controller,
    state,
    bindings,
    externalAccounts,
    externalCredentials,
    failures,
    service: controller.serviceAccount,
    namespace: () =>
      controller.createNamespace("administrator", { name: `tenant-${randomUUID()}` }),
  };
}

const create = (f, namespaceId, name = "service-account") =>
  f.service.createServiceAccount("administrator", { namespaceId, name });

test("ServiceAccount queries preserve lazy Installation and scope-versus-authorization ordering", async () => {
  const f = fixture();
  const namespaceId = id("ns");
  const accountId = id("sa");
  await assert.rejects(
    f.service.getServiceAccount("unprivileged", namespaceId, accountId),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    f.service.getServiceAccount("administrator", namespaceId, accountId),
    ScopeViolationError,
  );
  assert.equal(await f.state.read((view) => view.installations.getInstallation()), undefined);
  // Mutations resolve the Namespace before authorizing the exact account, as the facade did.
  await assert.rejects(
    f.service.updateServiceAccountCredential("unprivileged", namespaceId, accountId, credential()),
    ScopeViolationError,
  );
  const namespace = await f.namespace();
  await assert.rejects(
    f.service.updateServiceAccountCredential("unprivileged", namespace.id, accountId, credential()),
    AuthorizationDeniedError,
  );
  await assert.rejects(create(f, namespace.id, " "), ScopeViolationError);
  await assert.rejects(create(f, namespace.id, "x".repeat(201)), ScopeViolationError);
});

test("ServiceAccount list requires Namespace access and filters each exact account with native IAM", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const first = await create(f, namespace.id, "visible");
  await create(f, namespace.id, "hidden");
  const grant = (kind, resourceId) =>
    f.bindings.push({
      id: id("binding"),
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: "reader",
      roleId: "reader-role",
      resourceKind: kind,
      resourceId,
    });
  grant("service_account", first.id);
  // An exact ServiceAccount binding must carry its Namespace. Its read grant
  // works before the separate Namespace grant needed to enumerate candidates.
  assert.deepEqual(await f.service.getServiceAccount("reader", namespace.id, first.id), first);
  await assert.rejects(
    f.service.listServiceAccounts("reader", namespace.id),
    AuthorizationDeniedError,
  );
  grant("namespace", namespace.id);
  const visible = await f.service.listServiceAccounts("reader", namespace.id);
  assert.deepEqual(visible, [first]);
  assert.ok(Object.isFrozen(visible));
  assert.deepEqual(await f.controller.listServiceAccounts("reader", namespace.id), visible);
});

test("ServiceAccount manual credentials remain exact, immutable and usable without a selected Driver", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const other = await f.namespace();
  const account = await create(f, namespace.id);
  for (const action of [
    () => f.service.getServiceAccount("administrator", other.id, account.id),
    () =>
      f.service.updateServiceAccountCredential("administrator", other.id, account.id, credential()),
    () => f.service.deleteServiceAccount("administrator", other.id, account.id),
  ])
    await assert.rejects(action, ScopeViolationError);
  await assert.rejects(
    f.service.createServiceAccountCredential("administrator", namespace.id, account.id),
    DependencyUnavailableError,
  );
  for (const kind of ["api_key", "oauth_access_token"]) {
    const input = credential(kind);
    const updated = await f.service.updateServiceAccountCredential(
      "administrator",
      namespace.id,
      account.id,
      input,
    );
    input.secretRef.name = "modified-after-write";
    assert.equal(updated.credential.secretRef.name, "account-credential");
    assert.deepEqual(
      await f.controller.getServiceAccount("administrator", namespace.id, account.id),
      updated,
    );
  }
  await assert.rejects(
    f.service.updateServiceAccountCredential(
      "administrator",
      namespace.id,
      account.id,
      credential("access_token"),
    ),
    ResourceConflictError,
  );
  await f.service.deleteServiceAccount("administrator", namespace.id, account.id);
  await assert.rejects(
    f.service.getServiceAccount("administrator", namespace.id, account.id),
    ScopeViolationError,
  );
});

test("ServiceAccount managed issuance serializes concurrent requests and forbids manual replacement", async () => {
  const f = fixture({ managed: true });
  const namespace = await f.namespace();
  const account = await create(f, namespace.id);
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      f.service.createServiceAccountCredential("administrator", namespace.id, account.id),
    ),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(
    results.find((result) => result.status === "rejected").reason instanceof ResourceConflictError,
  );
  assert.deepEqual(
    (await f.service.getServiceAccount("administrator", namespace.id, account.id)).credential,
    credential("access_token"),
  );
  await assert.rejects(
    f.service.updateServiceAccountCredential(
      "administrator",
      namespace.id,
      account.id,
      credential(),
    ),
    ResourceConflictError,
  );
  await f.service.deleteServiceAccount("administrator", namespace.id, account.id);
  assert.equal(f.externalAccounts.has(account.id), false);
  assert.equal(f.externalCredentials.has(account.id), false);
});

test("ServiceAccount Driver failures are sanitized and unsupported credentials roll back", async () => {
  const f = fixture({ managed: true });
  const namespace = await f.namespace();
  f.failures.create = new Error("external provider detail");
  await assert.rejects(create(f, namespace.id), {
    name: "DependencyUnavailableError",
    message: "The selected ServiceAccount Driver is unavailable.",
  });
  assert.deepEqual(await f.service.listServiceAccounts("administrator", namespace.id), []);
  delete f.failures.create;
  const account = await create(f, namespace.id);
  f.failures.credentialKind = "oauth_access_token";
  await assert.rejects(
    f.service.createServiceAccountCredential("administrator", namespace.id, account.id),
    DependencyUnavailableError,
  );
  assert.equal(f.externalCredentials.has(account.id), false);
  assert.equal(
    (await f.service.getServiceAccount("administrator", namespace.id, account.id)).credential,
    undefined,
  );
  f.failures.delete = new ScopeViolationError("Exact provider binding is unavailable.");
  await assert.rejects(
    f.service.deleteServiceAccount("administrator", namespace.id, account.id),
    ScopeViolationError,
  );
  assert.deepEqual(
    await f.service.getServiceAccount("administrator", namespace.id, account.id),
    account,
  );
});

test("ServiceAccount joins the owner transaction and compensates Driver effects on outer failure", async () => {
  const f = fixture({ managed: true });
  const namespace = await f.namespace();
  let aborted;
  await assert.rejects(
    f.controller.transact(async () => {
      aborted = await create(f, namespace.id, "aborted");
      await f.service.createServiceAccountCredential("administrator", namespace.id, aborted.id);
      throw new Error("Required audit append failed.");
    }),
    /Required audit append failed/,
  );
  assert.equal(f.externalAccounts.has(aborted.id), false);
  assert.equal(f.externalCredentials.has(aborted.id), false);
  await assert.rejects(
    f.service.getServiceAccount("administrator", namespace.id, aborted.id),
    ScopeViolationError,
  );
});

test("ServiceAccount deletion rejects live Agent references before Driver effects", async () => {
  const f = fixture({ managed: true });
  const namespace = await f.namespace();
  const account = await create(f, namespace.id);
  const configuration = await f.controller.createConfiguration("administrator", {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
  });
  const agent = await f.controller.createAgent("administrator", {
    namespaceId: namespace.id,
    name: "account-consumer",
    configurationId: configuration.id,
    serviceAccountId: account.id,
  });
  assert.equal(agent.serviceAccountId, account.id);
  await assert.rejects(
    f.service.deleteServiceAccount("administrator", namespace.id, account.id),
    ResourceConflictError,
  );
  assert.equal(f.externalAccounts.has(account.id), true);
  assert.deepEqual(
    await f.service.getServiceAccount("administrator", namespace.id, account.id),
    account,
  );
});
