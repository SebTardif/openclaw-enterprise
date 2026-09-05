import assert from "node:assert/strict";
import test from "node:test";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ExactAuthorization } from "../../packages/occ/src/application/authorization.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
} from "../../packages/occ/src/errors.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";

const principalId = "principal-exact-reader";
const resource = Object.freeze({
  kind: "configuration",
  namespaceId: "namespace-selected",
  id: "configuration-selected",
});

function fixture(options = {}) {
  const policy = {
    identities: [
      {
        kind: "principal",
        id: principalId,
        issuer: "https://identity.example.test",
        subject: "reader",
      },
    ],
    groups: [],
    memberships: [],
    roles: [
      {
        id: "role-exact-reader",
        namespaceId: resource.namespaceId,
        permissions: [{ action: "read", resourceKind: resource.kind }],
      },
    ],
    bindings: [
      {
        id: "binding-exact-reader",
        namespaceId: resource.namespaceId,
        subjectKind: "identity",
        subjectId: principalId,
        roleId: "role-exact-reader",
        resourceKind: resource.kind,
        resourceId: resource.id,
      },
    ],
    restrictions: [],
  };
  const store = { loadNativeIAMState: options.load ?? (async () => policy) };
  const iam = new NativeIAMDriver(store, { id: "iam-selected" });
  const selection = new DriverSelection();
  selection.registerDriver(iam);
  selection.selectDriver("iam", iam.id);
  const authorization = new ExactAuthorization(
    () => selection.selectedDriver("iam"),
    options.authorize,
  );
  return { policy, iam, selection, authorization };
}

function unavailable(error) {
  assert.equal(error.constructor, DependencyUnavailableError);
  assert.equal(error.cause, undefined);
  return true;
}

test("selected lookup retains exact object identity, capability and implementation", () => {
  const { iam, selection, policy } = fixture();
  assert.equal(selection.selectedDriver("iam"), iam);
  assert.throws(() => selection.selectDriver("configuration", iam.id), DriverSelectionError);
  assert.throws(() => selection.selectedDriver("not-a-capability"), DriverSelectionError);
  assert.throws(() => selection.registerDriver(iam), DriverSelectionError);
  assert.throws(
    () => selection.registerDriver({ id: "broken", implementation: "broken", capability: "iam" }),
    DriverSelectionError,
  );
  const invalidHooks = new NativeIAMDriver(
    { loadNativeIAMState: async () => policy },
    { id: "invalid-hooks" },
  );
  invalidHooks.computeLifecycleHooks = { unknownPhase() {} };
  assert.throws(() => selection.registerDriver(invalidHooks), DriverSelectionError);

  const configuration = createTestConfigurationDriver({ id: iam.id });
  selection.registerDriver(configuration);
  assert.equal(selection.selectDriver("configuration", configuration.id), configuration);
  assert.equal(selection.configurationDriver(), configuration);
  assert.equal(selection.selectedDriver("iam"), iam);

  configuration.implementation = "changed-after-registration";
  assert.throws(() => selection.selectedDriver("configuration"), DriverSelectionError);
  assert.throws(() => selection.configurationDriver(), unavailable);
});

test("optional capability absence differs from a corrupted selected capability", () => {
  const selection = new DriverSelection();
  assert.equal(selection.serviceAccountDriver(), undefined);
  assert.equal(selection.sandboxDriver(), undefined);
  assert.throws(() => selection.secretDriver(), unavailable);

  // These inert Driver contracts exercise lookup validation only; no provider effect is claimed.
  const account = {
    id: "account-selected",
    capability: "service_account",
    implementation: "test-contract",
    async create() {},
    async createCredential() {},
    async delete() {},
  };
  const sandbox = {
    id: "sandbox-selected",
    capability: "sandbox",
    implementation: "test-contract",
    facets: ["process"],
    async cleanup() {},
  };
  selection.registerDriver(account);
  selection.selectDriver("service_account", account.id);
  assert.equal(selection.serviceAccountDriver(), account);
  account.createCredential = undefined;
  assert.throws(() => selection.serviceAccountDriver(), unavailable);

  selection.registerDriver(sandbox);
  // The invalid account must also prevent a newly proposed lifecycle selection.
  assert.throws(() => selection.selectDriver("sandbox", sandbox.id), DriverSelectionError);
  account.createCredential = async () => {};
  selection.selectDriver("sandbox", sandbox.id);
  assert.equal(selection.sandboxDriver(), sandbox);
  sandbox.id = "sandbox-replaced";
  assert.throws(() => selection.sandboxDriver(), unavailable);
});

test("Secret selection enforces the resource's exact owning Driver", () => {
  const selection = new DriverSelection();
  const secret = {
    id: "secret-selected",
    capability: "secret",
    implementation: "test-contract",
    async create() {},
    async update() {},
    async delete() {},
    async resolve() {},
  };
  selection.registerDriver(secret);
  selection.selectDriver("secret", secret.id);
  assert.equal(selection.secretDriver(secret.id), secret);
  assert.throws(() => selection.secretDriver("another-secret-driver"), unavailable);
  secret.resolve = undefined;
  assert.throws(() => selection.secretDriver(), unavailable);
});

test("native authorization preserves exact scope and validated denial attribution", async () => {
  const { authorization, policy } = fixture();
  const decision = await authorization.authorizationDecision(principalId, "read", resource);
  assert.equal(decision.allowed, true);
  assert.equal(decision.driverId, "iam-selected");
  assert.deepEqual(decision.evidence.bindingIds, ["binding-exact-reader"]);
  assert.deepEqual(decision.evidence.roleIds, ["role-exact-reader"]);
  await authorization.authorize(principalId, "read", resource);
  assert.equal(await authorization.canRead(principalId, resource), true);

  for (const deniedResource of [
    { ...resource, namespaceId: "namespace-other" },
    { ...resource, id: "configuration-other" },
  ]) {
    assert.equal(await authorization.canRead(principalId, deniedResource), false);
    await assert.rejects(authorization.authorize(principalId, "read", deniedResource), (error) => {
      assert.equal(error.constructor, AuthorizationDeniedError);
      assert.equal(error.evidence.identityId, principalId);
      assert.deepEqual(error.authorization, { action: "read", resource: deniedResource });
      assert.ok(Object.isFrozen(error.authorization.resource));
      return true;
    });
  }
  policy.restrictions.push({
    id: "restriction-selected",
    namespaceId: resource.namespaceId,
    action: "read",
    resourceKind: resource.kind,
    resourceId: resource.id,
    effect: "deny",
  });
  await assert.rejects(authorization.authorize(principalId, "read", resource), (error) => {
    assert.equal(error.constructor, AuthorizationDeniedError);
    assert.deepEqual(error.evidence.restrictionIds, ["restriction-selected"]);
    return true;
  });
});

test("authorization freezes the exact request before handing it to the existing callback", async () => {
  const original = fixture();
  let observed;
  const authorization = new ExactAuthorization(
    () => original.selection.selectedDriver("iam"),
    async (request) => {
      observed = request;
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.resource));
      return original.iam.authorize(request);
    },
  );
  const input = { ...resource };
  await authorization.authorize(principalId, "read", input);
  assert.notEqual(observed.resource, input);
  assert.deepEqual(observed, { principalId, action: "read", resource });
  input.id = "configuration-mutated-later";
  assert.equal(observed.resource.id, resource.id);
});

test("missing identity, missing selected IAM and native policy outages fail closed", async () => {
  const { authorization } = fixture();
  await assert.rejects(
    authorization.authorize("", "read", resource),
    (error) => error.constructor === AuthorizationDeniedError,
  );
  const missing = new ExactAuthorization(() => new DriverSelection().selectedDriver("iam"));
  await assert.rejects(missing.authorize(principalId, "read", resource), unavailable);
  const outage = fixture({
    load: async () => {
      throw new Error("private-policy-store-details");
    },
  });
  await assert.rejects(outage.authorization.authorize(principalId, "read", resource), (error) => {
    unavailable(error);
    assert.doesNotMatch(error.message, /private-policy-store-details/);
    return true;
  });
});

test("malformed and foreign decisions from the supported callback cannot authorize", async (t) => {
  const { iam, selection } = fixture();
  const mutations = [
    ["missing decision", () => undefined],
    ["nonboolean allow", (decision) => ({ ...decision, allowed: "true" })],
    ["empty Driver ID", (decision) => ({ ...decision, driverId: "" })],
    ["foreign Driver ID", (decision) => ({ ...decision, driverId: "iam-other" })],
    ["missing evidence", (decision) => ({ ...decision, evidence: undefined })],
    [
      "invalid identity evidence",
      (decision) => ({ ...decision, evidence: { ...decision.evidence, identityId: "" } }),
    ],
    ...["groupIds", "bindingIds", "roleIds", "restrictionIds"].flatMap((key) => [
      [
        `nonarray ${key}`,
        (decision) => ({ ...decision, evidence: { ...decision.evidence, [key]: "evidence" } }),
      ],
      [
        `empty entry ${key}`,
        (decision) => ({ ...decision, evidence: { ...decision.evidence, [key]: [""] } }),
      ],
    ]),
  ];
  for (const [name, corrupt] of mutations)
    await t.test(name, async () => {
      // Corrupt a real native decision at the supported callback boundary to test consumer validation.
      const authorization = new ExactAuthorization(
        () => selection.selectedDriver("iam"),
        async (request) => corrupt(await iam.authorize(request)),
      );
      await assert.rejects(authorization.authorize(principalId, "read", resource), unavailable);
    });
});

test("an unchanged Driver ID cannot hide replacement of the selected IAM object during await", async () => {
  const { iam, policy } = fixture();
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const original = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => {
        entered.resolve();
        await pending.promise;
        return policy;
      },
    },
    { id: iam.id },
  );
  let current = original;
  const authorization = new ExactAuthorization(() => current);
  const result = authorization.authorize(principalId, "read", resource);
  const rejected = assert.rejects(result, unavailable);
  await entered.promise;
  // The narrow lookup producer now returns a different native object with the same public ID.
  current = iam;
  pending.resolve();
  await rejected;
});

test("the narrow IAM lookup pins its selected object's original ID across the policy await", async () => {
  const { policy } = fixture();
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const iam = new NativeIAMDriver(
    {
      loadNativeIAMState: async () => {
        entered.resolve();
        await pending.promise;
        return policy;
      },
    },
    { id: "iam-original" },
  );
  const authorization = new ExactAuthorization(() => iam);
  const result = authorization.authorize(principalId, "read", resource);
  const rejected = assert.rejects(result, unavailable);
  await entered.promise;
  // Native IAM reads its ID after the dependency await. Matching that changed
  // decision ID must not make the original selection current again.
  iam.id = "iam-changed";
  pending.resolve();
  await rejected;
});
