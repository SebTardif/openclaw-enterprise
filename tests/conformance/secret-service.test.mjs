import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { SecretService } from "../../packages/occ/src/services/secret/service.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

const id = (kind) => `${kind}_${randomUUID()}`;
const now = () => new Date().toISOString();

function fixture({ secretDriver = createTestSecretDriver() } = {}) {
  const installation = { id: id("ins"), name: "Secret service", createdAt: now() };
  const store = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, {
    state: store,
    recordOperations: false,
  });
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: ["administrator", "reader"].map((principal) => ({
        kind: "principal",
        id: principal,
        issuer: "secret-service-test",
        subject: principal,
      })),
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: "administrator-role",
          permissions: [
            ...["create", "read", "update", "delete", "operate"].map((action) => ({
              action,
              resourceKind: "secret",
            })),
            ...["create", "read", "update", "delete"].map((action) => ({
              action,
              resourceKind: "configuration",
            })),
          ],
        },
        { id: "reader-role", permissions: [{ action: "read", resourceKind: "secret" }] },
      ],
      bindings: ["administrator", "reader"].map((principal) => ({
        id: `${principal}-binding`,
        subjectKind: "identity",
        subjectId: principal,
        roleId: `${principal}-role`,
      })),
    }),
  });
  for (const driver of [iam, secretDriver, createTestConfigurationDriver()]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  // Use the real composition so the service receives the canonical SDK sanitizer
  // and joins the same transaction owner as Configuration and the retained facade.
  assert.ok(controller.secret instanceof SecretService);
  async function namespace(overrides = {}) {
    const value = {
      id: id("ns"),
      name: `secret-${randomUUID()}`,
      status: "ready",
      createdAt: now(),
      ...overrides,
    };
    await controller.transact((unit) => unit.namespaces.createNamespace(value));
    return value;
  }
  return { installation, store, controller, service: controller.secret, secretDriver, namespace };
}

const input = (namespaceId, value = "synthetic-service-value") => ({
  namespaceId,
  name: "Application token",
  value,
});

test("Secret service queries preserve lazy Installation and return immutable metadata only", async () => {
  const f = fixture();
  await assert.rejects(f.service.readSecret("reader", id("ns"), id("sec")), ScopeViolationError);
  assert.equal(await f.store.read((view) => view.installations.getInstallation()), undefined);
  const namespace = await f.namespace();
  const created = await f.service.createSecret("administrator", input(namespace.id));
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "namespaceId", "ref"]);
  assert.deepEqual(created.ref, { kind: "secret", id: created.id, namespaceId: namespace.id });
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.ref));
  const beforeRead = f.secretDriver.calls.length;
  assert.deepEqual(await f.service.readSecret("reader", namespace.id, created.id), created);
  assert.equal(f.secretDriver.calls.length, beforeRead);
  assert.deepEqual(
    await f.store.read((view) => view.installations.getInstallation()),
    f.installation,
  );
  assert.equal(f.secretDriver.valueFor(created), "synthetic-service-value");
});

test("Secret service preserves value limits, names and ready Namespace admission", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  for (const value of [undefined, null, 0, "", "a\0b", "\uD800", "\uDC00", "é".repeat(32_769)]) {
    await assert.rejects(
      f.service.createSecret("administrator", { ...input(namespace.id), value }),
      ScopeViolationError,
    );
  }
  for (const name of ["", " ", "x".repeat(201)]) {
    await assert.rejects(
      f.service.createSecret("administrator", { ...input(namespace.id), name }),
      ScopeViolationError,
    );
  }
  assert.equal(f.secretDriver.calls.length, 0);
  const created = await f.service.createSecret(
    "administrator",
    input(namespace.id, "😀".repeat(16_384)),
  );
  for (const value of ["", "a\0b", "\uD800", "é".repeat(32_769)]) {
    await assert.rejects(
      f.service.updateSecret("administrator", {
        namespaceId: namespace.id,
        secretId: created.id,
        value,
      }),
      ScopeViolationError,
    );
  }
  assert.equal(f.secretDriver.calls.length, 1);
  for (const status of ["provisioning", "failed", "deleting"]) {
    const unavailable = await f.namespace({ status: "provisioning" });
    if (status !== "provisioning") {
      const transitioned = await f.controller.transact((unit) =>
        unit.namespaces.transitionNamespaceStatus(unavailable.id, "provisioning", status),
      );
      assert.equal(transitioned.status, status);
    }
    await assert.rejects(
      f.service.createSecret("administrator", input(unavailable.id)),
      NamespaceNotReadyError,
    );
    // An empty nonready Namespace is reachable through normal lifecycle transitions.
    // Update rejects its readiness before looking up a Secret from the ready tenant.
    await assert.rejects(
      f.service.updateSecret("administrator", {
        namespaceId: unavailable.id,
        secretId: created.id,
        value: "replacement",
      }),
      NamespaceNotReadyError,
    );
  }
  assert.equal(f.secretDriver.calls.length, 1);
  assert.equal(f.secretDriver.valueFor(created), "😀".repeat(16_384));
  await f.service.deleteSecret("administrator", namespace.id, created.id);
  assert.equal(f.secretDriver.has(created), false);
});

test("Secret service enforces exact Namespace and native IAM before touching Driver storage", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const foreign = await f.namespace();
  const created = await f.service.createSecret("administrator", input(namespace.id));
  const initialCalls = f.secretDriver.calls.length;
  for (const principal of ["reader", "administrator"]) {
    const namespaceId = principal === "reader" ? namespace.id : foreign.id;
    const expected = principal === "reader" ? AuthorizationDeniedError : ScopeViolationError;
    await assert.rejects(
      f.service.updateSecret(principal, { namespaceId, secretId: created.id, value: "forbidden" }),
      expected,
    );
    await assert.rejects(f.service.deleteSecret(principal, namespaceId, created.id), expected);
  }
  await assert.rejects(f.service.readSecret("reader", foreign.id, created.id), ScopeViolationError);
  await assert.rejects(
    f.service.createSecret("reader", input(namespace.id)),
    AuthorizationDeniedError,
  );
  assert.equal(f.secretDriver.calls.length, initialCalls);
  assert.equal(f.secretDriver.valueFor(created), "synthetic-service-value");
});

test("Secret service retains metadata while updating and rejects a substituted storage Driver", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createSecret("administrator", input(namespace.id));
  const stored = await f.store.read((view) => view.secrets.findSecret(namespace.id, created.id));
  assert.deepEqual(
    await f.service.updateSecret("administrator", {
      namespaceId: namespace.id,
      secretId: created.id,
      value: "replacement",
    }),
    created,
  );
  assert.equal(f.secretDriver.valueFor(created), "replacement");
  assert.deepEqual(
    await f.store.read((view) => view.secrets.findSecret(namespace.id, created.id)),
    stored,
  );
  const replacement = createTestSecretDriver({ id: "replacement-driver" });
  f.controller.registerDriver(replacement);
  f.controller.selectDriver("secret", replacement.id);
  await assert.rejects(
    f.service.updateSecret("administrator", {
      namespaceId: namespace.id,
      secretId: created.id,
      value: "wrong-driver",
    }),
    DependencyUnavailableError,
  );
  await assert.rejects(
    f.service.deleteSecret("administrator", namespace.id, created.id),
    DependencyUnavailableError,
  );
  assert.deepEqual(replacement.calls, []);
  assert.deepEqual(await f.service.readSecret("reader", namespace.id, created.id), created);
});

test("Secret deletion shares Configuration binding references and enclosing transaction rollback", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createSecret("administrator", input(namespace.id));
  const configuration = await f.controller.configuration.createConfiguration("administrator", {
    namespaceId: namespace.id,
    kind: "agent",
    values: {},
    secretBindings: { APP_TOKEN: { source: created.ref } },
  });
  await assert.rejects(
    f.service.deleteSecret("administrator", namespace.id, created.id),
    ResourceConflictError,
  );
  assert.equal(f.secretDriver.has(created), true);
  await f.controller.configuration.deleteConfiguration(
    "administrator",
    namespace.id,
    configuration.id,
  );
  await f.service.deleteSecret("administrator", namespace.id, created.id);
  const failure = new Error("enclosing transaction failed");
  let rejected;
  await assert.rejects(
    f.controller.transact(async () => {
      rejected = await f.service.createSecret("administrator", input(namespace.id));
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(f.secretDriver.has(rejected), false);
  assert.equal(
    await f.store.read((view) => view.secrets.findSecret(namespace.id, rejected.id)),
    undefined,
  );
  assert.deepEqual(
    f.secretDriver.calls.slice(-2).map((call) => call.operation),
    ["create", "delete"],
  );
});

test("Secret update never reads or retains a previous value for rollback", async () => {
  const f = fixture();
  const namespace = await f.namespace();
  const created = await f.service.createSecret("administrator", input(namespace.id));
  const failure = new Error("later audit rejected");
  await assert.rejects(
    f.controller.transact(async () => {
      await f.service.updateSecret("administrator", {
        namespaceId: namespace.id,
        secretId: created.id,
        value: "replacement",
      });
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(f.secretDriver.valueFor(created), "replacement");
  assert.deepEqual(await f.service.readSecret("reader", namespace.id, created.id), created);
  assert.deepEqual(
    f.secretDriver.calls.map((call) => call.operation),
    ["create", "update"],
  );
});

test("Secret service uses the canonical SDK sanitizer for every storage mutation", async () => {
  const sentinel = "synthetic-sdk-request-bytes";
  for (const [ErrorClass, expected, message] of [
    [
      Error,
      DependencyUnavailableError,
      "The Secret storage operation failed or its outcome is unknown.",
    ],
    [
      ResourceConflictError,
      ResourceConflictError,
      "The Secret backend identity or concurrency precondition conflicts.",
    ],
    [
      ScopeViolationError,
      ScopeViolationError,
      "The Secret backend ownership could not be verified.",
    ],
  ]) {
    for (const operation of ["create", "update", "delete"]) {
      const original = new ErrorClass(sentinel);
      const f = fixture({
        secretDriver: createTestSecretDriver({ [`${operation}Error`]: original }),
      });
      const namespace = await f.namespace();
      const created =
        operation === "create"
          ? undefined
          : await f.service.createSecret("administrator", input(namespace.id));
      const run = () => {
        if (operation === "create")
          return f.service.createSecret("administrator", input(namespace.id));
        if (operation === "update")
          return f.service.updateSecret("administrator", {
            namespaceId: namespace.id,
            secretId: created.id,
            value: "replacement",
          });
        return f.service.deleteSecret("administrator", namespace.id, created.id);
      };
      await assert.rejects(run, (error) => {
        assert.ok(error instanceof expected);
        assert.notEqual(error, original);
        assert.equal(error.message, message);
        assert.equal(error.cause, undefined);
        assert.equal(String(error).includes(sentinel), false);
        return true;
      });
    }
  }
});
