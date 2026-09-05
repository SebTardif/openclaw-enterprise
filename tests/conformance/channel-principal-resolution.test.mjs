import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { ChannelBindingService } from "../../packages/occ/src/channel-bindings.ts";
import { resolveChannelCandidateBindingsV1 } from "../../apps/controller/src/channels/channel-principal-bindings.ts";
import {
  parseReceiptIdentityV1,
  classifyReceiptV1,
} from "../../apps/controller/src/channels/shared-turn-receipt.ts";
import { seedRuntimeOwner } from "./runtime-assignment-store.contract.mjs";
import {
  createAuthenticatedControllerRequest,
  createTestAuthPrincipal,
} from "../helpers/auth-session.mjs";

const channelRoot = "/api/channel-installations";
const controllerApps = new Set();
after(async () => {
  await Promise.all([...controllerApps].map((app) => app.close()));
});

const human = {
  kind: "principal",
  id: "prn_channel-human",
  issuer: "https://identity.example.test",
  subject: "human-a",
};
const secondHuman = { ...human, id: "prn_channel-human-b", subject: "human-b" };

async function fixture(platform = "slack") {
  const auditSink = new InMemoryAuditSink();
  const state = new InMemoryPlatformState({ auditSink });
  const owner = await seedRuntimeOwner(state);
  const scope = owner.scope;
  const authenticated = await createTestAuthPrincipal({ installationId: owner.installation.id });
  const admin = authenticated.seed.principal;
  // Existing provisioned policy is test setup, not a grant-management endpoint.
  const policy = {
    identities: [admin, human, secondHuman],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: [
      {
        id: "rol_install-admin",
        permissions: [{ action: "administer", resourceKind: "installation" }],
      },
      {
        id: "rol_agent-user",
        namespaceId: scope.namespaceId,
        permissions: [
          { action: "read", resourceKind: "agent" },
          { action: "operate", resourceKind: "agent" },
        ],
      },
    ],
    bindings: [
      {
        id: "bnd_admin-installation",
        subjectKind: "identity",
        subjectId: admin.id,
        roleId: "rol_install-admin",
        resourceKind: "installation",
        resourceId: owner.installation.id,
        channelAdministration: {
          schemaVersion: 1,
          version: 1,
          status: "enabled",
          installationId: owner.installation.id,
          roleId: "rol_install-admin",
          semanticClass: "installation-administrator",
        },
      },
      ...[admin, human, secondHuman].map((identity) => ({
        id: `bnd_agent-${identity.id}`,
        subjectKind: "identity",
        subjectId: identity.id,
        roleId: "rol_agent-user",
        namespaceId: scope.namespaceId,
        resourceKind: "agent",
        resourceId: scope.agentId,
      })),
    ],
  };
  const iamStateStore = { loadNativeIAMState: async () => policy };
  const native = new NativeIAMDriver(iamStateStore);
  let selected = native;
  const options = { state, installationId: owner.installation.id, iam: () => selected };
  const service = new ChannelBindingService(options);
  const context = { actorId: admin.id, requestId: `test/${randomUUID()}` };

  // Protected fixture mutations use real request custody; the resolver still supplies no authority.
  const controller = new OpenClawController(owner.installation, { state });
  controller.registerDriver(native);
  controller.selectDriver("iam", native.id);
  const controllerApp = createFastifyApp({
    controller,
    iamDriver: native,
    auth: authenticated.auth,
    auditSink,
    publicOrigin: "http://127.0.0.1",
    development: { enabled: true, installationId: owner.installation.id },
  });
  controllerApps.add(controllerApp);
  await controllerApp.ready();
  const adminRequest = await createAuthenticatedControllerRequest(controllerApp, authenticated);
  async function adminData(method, path, body) {
    const response = await adminRequest(method, path, body);
    assert.equal(response.status, method === "POST" ? 201 : 200, JSON.stringify(response));
    assert.ok(Object.hasOwn(response, "data"));
    return response.data;
  }
  const app = await adminData("POST", channelRoot, {
    platform,
    providerTenantRef: "tenant/Case:opaque",
    recipientAppRef: "app/recipient",
  });
  const person = await adminData("POST", `${channelRoot}/${app.id}/human-bindings`, {
    providerSubjectRef: "sender/external",
    principal: { issuer: human.issuer, subject: human.subject },
  });
  const route = await service.createAgentBinding(context, app.id, {
    channelRef: "channel/private",
    scopeKind: platform === "slack" ? "slack-private-channel" : "msteams-standard-channel",
    ...scope,
  });
  function receipt(changes = {}) {
    const parsed = parseReceiptIdentityV1({
      schemaVersion: 1,
      platform,
      installationRef: owner.installation.id,
      channelInstallationRef: app.id,
      providerTenantRef: app.providerTenantRef,
      recipientAppRef: app.recipientAppRef,
      normalizationProfileRef: "profile/test-v1",
      providerEventRef: "event/original",
      providerMessageRef: "message/original",
      providerSubjectRef: person.providerSubjectRef,
      channelRef: route.channelRef,
      rootThreadRef: "root/opaque:Original",
      eventDigest: `sha256:${"1".repeat(64)}`,
      contentDigest: `sha256:${"2".repeat(64)}`,
      ...changes,
    });
    assert.equal("kind" in parsed, false);
    return parsed;
  }
  return {
    state,
    owner,
    scope,
    policy,
    admin,
    adminRequest,
    adminData,
    native,
    iamStateStore,
    options,
    service,
    context,
    app,
    person,
    route,
    receipt,
    select(driver) {
      selected = driver;
    },
    resolve(identity = receipt()) {
      return resolveChannelCandidateBindingsV1(options, identity);
    },
  };
}

test("real native Agent permissions map Slack and Teams receipts without admission or side effects", async () => {
  for (const platform of ["slack", "msteams"]) {
    const f = await fixture(platform);
    const identity = f.receipt();
    const auditBefore = await f.state.read((s) => s.audit.list());
    const operationsBefore = await f.state.read((s) => s.operations.list());
    const result = await f.resolve(identity);
    assert.equal(result.kind, "candidate-mapped");
    assert.equal(result.authority, "mapping-only");
    assert.equal(result.principalId, human.id);
    assert.equal(result.namespaceId, f.scope.namespaceId);
    assert.equal(result.agentId, f.scope.agentId);
    assert.equal(result.channelInstallationId, f.app.id);
    assert.equal(result.humanBindingId, f.person.id);
    assert.equal(result.agentBindingId, f.route.id);
    assert.deepEqual(result.versions, { installation: 1, human: 1, agent: 1 });
    assert.deepEqual(result.identity, identity);
    assert.deepEqual(
      new Set(result.missingAuthority),
      new Set([
        "verified-delivery",
        "common-workspace-repository-grants",
        "complete-live-audience",
        "conversation-checkpoint",
        "durable-admission",
        "runtime-authority",
        "agent-mutation-fence",
      ]),
    );
    assert.throws(() => {
      result.identity.rootThreadRef = "replacement";
    }, TypeError);
    assert.throws(() => {
      result.versions.agent = 99;
    }, TypeError);
    assert.throws(() => result.missingAuthority.push("replacement"), TypeError);
    assert.deepEqual(await f.state.read((s) => s.audit.list()), auditBefore);
    assert.deepEqual(await f.state.read((s) => s.operations.list()), operationsBefore);
    assert.equal(
      await f.state.read((s) => s.runtimeAssignments.findRuntimeIntentHead(f.scope)),
      undefined,
    );
    assert.deepEqual(classifyReceiptV1(identity), { kind: "new-candidate" });
    const prior = { identity, ownerReceiptRef: "receipt/previous", disposition: "denied" };
    assert.deepEqual(classifyReceiptV1(identity, prior), {
      kind: "duplicate",
      ownerReceiptRef: "receipt/previous",
      disposition: "denied",
    });
    assert.equal(
      classifyReceiptV1(f.receipt({ contentDigest: `sha256:${"3".repeat(64)}` }), prior).kind,
      "conflict",
    );
  }
});

test("sender requires both current exact Agent permissions; Installation grants, restrictions and revocation cannot inflate them", async () => {
  const f = await fixture();
  const binding = f.policy.bindings.find((b) => b.subjectId === human.id);
  f.policy.bindings = f.policy.bindings.filter((b) => b.subjectId !== human.id);
  f.policy.bindings.push({
    ...binding,
    id: "bnd_human-installation",
    roleId: "rol_install-admin",
    namespaceId: undefined,
    resourceKind: "installation",
    resourceId: f.owner.installation.id,
  });
  assert.equal((await f.resolve()).kind, "permission-denied");
  f.policy.bindings = f.policy.bindings.filter((b) => b.subjectId !== human.id);
  f.policy.bindings.push(binding);
  const role = f.policy.roles.find((r) => r.id === binding.roleId);
  for (const action of ["read", "operate"]) {
    role.permissions = [{ action, resourceKind: "agent" }];
    assert.equal((await f.resolve()).kind, "permission-denied");
  }
  role.permissions = [
    { action: "read", resourceKind: "agent" },
    { action: "operate", resourceKind: "agent" },
  ];
  assert.equal((await f.resolve()).kind, "candidate-mapped");
  f.policy.restrictions.push({
    id: "rst_agent-operate",
    namespaceId: f.scope.namespaceId,
    action: "operate",
    resourceKind: "agent",
    resourceId: f.scope.agentId,
    effect: "deny",
  });
  assert.equal((await f.resolve()).kind, "permission-denied");
  f.policy.restrictions = [];
  f.policy.bindings = f.policy.bindings.filter((b) => b.subjectId !== human.id);
  assert.equal((await f.resolve()).kind, "permission-denied");
});

test("every app dimension and nested binding owner must match the exact receipt", async () => {
  const f = await fixture();
  for (const change of [
    { installationRef: "ins_other" },
    { channelInstallationRef: "chi_other" },
    { platform: "msteams" },
    { providerTenantRef: "tenant/case:opaque" },
    { recipientAppRef: "app/other" },
    { providerSubjectRef: "sender/unknown" },
    { channelRef: "channel/other" },
  ])
    assert.equal((await f.resolve(f.receipt(change))).kind, "unmapped");
  const other = await f.adminData("POST", channelRoot, {
    platform: "slack",
    providerTenantRef: f.app.providerTenantRef,
    recipientAppRef: "app/other",
  });
  await f.adminData("POST", `${channelRoot}/${other.id}/human-bindings`, {
    providerSubjectRef: f.person.providerSubjectRef,
    principal: { issuer: secondHuman.issuer, subject: secondHuman.subject },
  });
  await f.service.createAgentBinding(f.context, other.id, {
    channelRef: f.route.channelRef,
    scopeKind: f.route.scopeKind,
    ...f.scope,
  });
  const mapped = await f.resolve(
    f.receipt({ channelInstallationRef: other.id, recipientAppRef: other.recipientAppRef }),
  );
  assert.equal(mapped.kind, "candidate-mapped");
  assert.equal(mapped.principalId, secondHuman.id);
  const hiddenHuman = await f.adminRequest(
    "GET",
    `${channelRoot}/${other.id}/human-bindings/${f.person.id}`,
  );
  assert.equal(hiddenHuman.status, 404);
  assert.equal(hiddenHuman.error.code, "NOT_FOUND");
  assert.equal(hiddenHuman.data, undefined);
  await assert.rejects(f.service.getAgentBinding(f.context, other.id, f.route.id), {
    name: "ChannelBindingNotFoundError",
  });
  assert.equal((await f.resolve({ ...f.receipt(), eventKey: "forged" })).kind, "unmapped");
});

test("disable and re-enable retain original mappings while checking the current identity and target", async () => {
  const f = await fixture();
  for (const [record, disable, enable] of [
    [
      f.app,
      (version) =>
        f.adminData("PATCH", `${channelRoot}/${f.app.id}`, {
          expectedVersion: version,
          status: "disabled",
        }),
      (version) =>
        f.adminData("PATCH", `${channelRoot}/${f.app.id}`, {
          expectedVersion: version,
          status: "enabled",
        }),
    ],
    [
      f.person,
      (version) =>
        f.adminData("PATCH", `${channelRoot}/${f.app.id}/human-bindings/${f.person.id}`, {
          expectedVersion: version,
          status: "disabled",
        }),
      (version) =>
        f.adminData("PATCH", `${channelRoot}/${f.app.id}/human-bindings/${f.person.id}`, {
          expectedVersion: version,
          status: "enabled",
        }),
    ],
    [
      f.route,
      (version) =>
        f.service.setAgentBindingStatus(f.context, f.app.id, f.route.id, {
          expectedVersion: version,
          status: "disabled",
        }),
      (version) =>
        f.service.setAgentBindingStatus(f.context, f.app.id, f.route.id, {
          expectedVersion: version,
          status: "enabled",
        }),
    ],
  ]) {
    const disabled = await disable(record.version);
    assert.equal((await f.resolve()).kind, "disabled");
    const enabled = await enable(disabled.version);
    assert.equal(enabled.id, record.id);
    assert.equal(enabled.version, 3);
    assert.equal((await f.resolve()).kind, "candidate-mapped");
  }
  f.policy.identities = f.policy.identities.filter((identity) => identity.id !== human.id);
  f.policy.bindings = f.policy.bindings.filter((binding) => binding.subjectId !== human.id);
  assert.equal((await f.resolve()).kind, "identity-changed");
  const disabled = await f.adminData(
    "PATCH",
    `${channelRoot}/${f.app.id}/human-bindings/${f.person.id}`,
    {
      expectedVersion: 3,
      status: "disabled",
    },
  );
  const unavailableHuman = await f.adminRequest(
    "PATCH",
    `${channelRoot}/${f.app.id}/human-bindings/${f.person.id}`,
    {
      expectedVersion: disabled.version,
      status: "enabled",
    },
  );
  assert.equal(unavailableHuman.status, 400);
  assert.equal(unavailableHuman.error.code, "INVALID_REQUEST");
  assert.equal(unavailableHuman.data, undefined);
  assert.equal((await f.resolve()).kind, "disabled");
});

test("selected IAM replacement, changed Principal ID and ambiguous identity never reuse a stored mapping", async () => {
  const f = await fixture();
  f.select(
    new NativeIAMDriver(
      { loadNativeIAMState: async () => f.policy },
      { id: "different-selected-iam" },
    ),
  );
  assert.equal((await f.resolve()).kind, "identity-changed");
  f.select(f.native);
  f.policy.identities = f.policy.identities.map((identity) =>
    identity.id === human.id ? { ...identity, id: "prn_replacement" } : identity,
  );
  f.policy.bindings = f.policy.bindings.map((binding) =>
    binding.subjectId === human.id ? { ...binding, subjectId: "prn_replacement" } : binding,
  );
  assert.equal((await f.resolve()).kind, "identity-changed");
  f.policy.bindings = f.policy.bindings.map((binding) =>
    binding.subjectId === "prn_replacement" ? { ...binding, subjectId: human.id } : binding,
  );
  f.policy.identities = [f.admin, human, { ...human, id: "prn_ambiguous" }, secondHuman];
  assert.equal((await f.resolve()).kind, "identity-changed");
});

test("custom IAM boundary rejects nonhumans, mismatched identity and malformed evidence without native fallback or error leakage", async () => {
  const f = await fixture();
  // These Driver doubles test the selected-Driver integration contract; policy
  // grant/restriction results above come exclusively from the real NativeIAMDriver.
  const driver = {
    id: f.native.id,
    capability: "iam",
    lookupIdentity: (input) => f.native.lookupIdentity(input),
    authorize: (request) => f.native.authorize(request),
  };
  f.select(driver);
  for (const identity of [
    { kind: "service_principal", id: human.id },
    { ...human, issuer: "wrong" },
    { ...human, subject: "wrong" },
    undefined,
  ]) {
    driver.lookupIdentity = async () => identity;
    assert.equal((await f.resolve()).kind, "identity-changed");
  }
  driver.lookupIdentity = async () => {
    throw new Error("private provider credential must not escape");
  };
  assert.deepEqual(await f.resolve(), { kind: "dependency-unavailable" });
  driver.lookupIdentity = (input) => f.native.lookupIdentity(input);
  driver.authorize = async (request) => ({
    ...(await f.native.authorize(request)),
    driverId: "wrong-driver",
  });
  assert.deepEqual(await f.resolve(), { kind: "dependency-unavailable" });
  driver.authorize = async (request) => ({
    ...(await f.native.authorize(request)),
    evidence: {
      identityId: "wrong-human",
      groupIds: [],
      bindingIds: [],
      roleIds: [],
      restrictionIds: [],
    },
  });
  assert.deepEqual(await f.resolve(), { kind: "dependency-unavailable" });
});

test(
  "binding or IAM authority changes during asynchronous resolution invalidate the observation",
  { timeout: 10000 },
  async () => {
    for (const change of ["parent", "human", "agent", "driver"]) {
      const f = await fixture();
      let release;
      let entered;
      const arrived = new Promise((resolve) => {
        entered = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let block = true;
      f.iamStateStore.loadNativeIAMState = async () => {
        if (block) {
          block = false;
          entered();
          await gate;
        }
        return f.policy;
      };
      const pending = f.resolve();
      await arrived;
      // Resolve a real persisted mutation while the selected IAM lookup is suspended.
      try {
        if (change === "parent")
          await f.adminData("PATCH", `${channelRoot}/${f.app.id}`, {
            expectedVersion: 1,
            status: "disabled",
          });
        if (change === "human")
          await f.adminData("PATCH", `${channelRoot}/${f.app.id}/human-bindings/${f.person.id}`, {
            expectedVersion: 1,
            status: "disabled",
          });
        if (change === "agent")
          await f.service.setAgentBindingStatus(f.context, f.app.id, f.route.id, {
            expectedVersion: 1,
            status: "disabled",
          });
        if (change === "driver")
          f.select(new NativeIAMDriver(f.iamStateStore, { id: f.native.id }));
      } finally {
        release();
      }
      assert.equal(
        (await pending).kind,
        change === "driver" ? "dependency-unavailable" : "changed-during-resolution",
      );
    }
  },
);

test("current target lifecycle and administrator Agent authority are enforced independently", async () => {
  const f = await fixture();
  f.policy.bindings = f.policy.bindings.filter(
    (binding) => !(binding.subjectId === f.admin.id && binding.resourceKind === "agent"),
  );
  await assert.rejects(
    f.service.createAgentBinding(f.context, f.app.id, {
      channelRef: "other-channel",
      scopeKind: "slack-private-channel",
      ...f.scope,
    }),
    { name: "AuthorizationDeniedError" },
  );
  const disabled = await f.service.setAgentBindingStatus(f.context, f.app.id, f.route.id, {
    expectedVersion: 1,
    status: "disabled",
  });
  await assert.rejects(
    f.service.setAgentBindingStatus(f.context, f.app.id, f.route.id, {
      expectedVersion: disabled.version,
      status: "enabled",
    }),
    { name: "AuthorizationDeniedError" },
  );
  await assert.rejects(
    f.service.listInstallations({ actorId: human.id, requestId: "request/non-admin" }),
    { name: "AuthorizationDeniedError" },
  );
  const active = await fixture();
  await active.state.transact((s) =>
    s.namespaces.transitionNamespaceStatus(active.scope.namespaceId, "ready", "deleting"),
  );
  assert.equal((await active.resolve()).kind, "target-unavailable");
});
