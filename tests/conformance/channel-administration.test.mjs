import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeChannelAdministrationEvidenceV1,
  decodeChannelAdministrationMappingV1,
} from "../../packages/contracts/src/index.ts";
import {
  createAuthPrincipalSeed,
  createBootstrapAdministratorSeed,
  NativeIAMDriver,
} from "../../packages/iam/src/index.ts";
import { ChannelAdministrationStateError } from "../../packages/iam/src/channel-administration.ts";

const installationId = "ins_channel_administration";

function mapping(overrides = {}) {
  return {
    schemaVersion: 1,
    version: 7,
    status: "enabled",
    installationId,
    roleId: "role-channel-administrator",
    semanticClass: "installation-administrator",
    ...overrides,
  };
}

function evidence(mappings = [{ bindingId: "binding-human", roleId: "role-human", version: 7 }]) {
  return { schemaVersion: 1, installationId, mappings };
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function createNativeFixture() {
  const seed = createBootstrapAdministratorSeed(installationId, "https://identity.example.com", {
    id: "channel-administrator-account",
  });
  const state = {
    identities: [seed.principal, seed.servicePrincipal],
    groups: [],
    memberships: [],
    roles: seed.roles,
    bindings: seed.bindings,
    restrictions: [],
  };
  let loads = 0;
  const store = {
    async loadNativeIAMState() {
      loads += 1;
      return state;
    },
  };
  const driver = new NativeIAMDriver(store, { id: "iam-channel-administration" });
  return {
    seed,
    state,
    store,
    driver,
    humanBinding: state.bindings.find(({ subjectId }) => subjectId === seed.principal.id),
    serviceBinding: state.bindings.find(({ subjectId }) => subjectId === seed.servicePrincipal.id),
    get loads() {
      return loads;
    },
  };
}

function administer(fixture, principalId = fixture.seed.principal.id, targetId = installationId) {
  return fixture.driver.authorize({
    principalId,
    action: "administer",
    resource: { kind: "installation", id: targetId },
  });
}

function assertMappings(decision, mappings) {
  assert.deepEqual(decision.evidence.channelAdministration, {
    schemaVersion: 1,
    installationId,
    mappings,
  });
}

test("channel administration decoders accept closed values and return independent deeply frozen copies", () => {
  const inputMapping = mapping();
  const decodedMapping = decodeChannelAdministrationMappingV1(inputMapping);
  assert.equal(decodedMapping.kind, "valid");
  assert.deepEqual(decodedMapping.value, inputMapping);
  assert.notEqual(decodedMapping.value, inputMapping);
  assertDeepFrozen(decodedMapping.value);
  inputMapping.version = 8;
  assert.equal(decodedMapping.value.version, 7);
  assert.throws(() => {
    decodedMapping.value.status = "disabled";
  }, TypeError);

  const inputEvidence = evidence();
  const decodedEvidence = decodeChannelAdministrationEvidenceV1(inputEvidence);
  assert.equal(decodedEvidence.kind, "valid");
  assert.deepEqual(decodedEvidence.value, inputEvidence);
  assert.notEqual(decodedEvidence.value.mappings, inputEvidence.mappings);
  assertDeepFrozen(decodedEvidence.value);
  inputEvidence.mappings[0].version = 8;
  assert.equal(decodedEvidence.value.mappings[0].version, 7);
  assert.throws(() => {
    decodedEvidence.value.mappings.push({});
  }, TypeError);

  const empty = decodeChannelAdministrationEvidenceV1(evidence([]));
  assert.equal(empty.kind, "valid");
  assertDeepFrozen(empty.value);
  const nullPrototype = Object.assign(Object.create(null), mapping());
  assert.equal(decodeChannelAdministrationMappingV1(nullPrototype).kind, "valid");
});

test("channel administration mappings reject unknown fields, malformed references, versions and object shapes", () => {
  const nonenumerable = mapping();
  Object.defineProperty(nonenumerable, "version", { enumerable: false });
  const symbolic = mapping();
  symbolic[Symbol("hidden")] = "unrecognized";
  const cyclic = mapping();
  cyclic.roleId = cyclic;
  const inherited = Object.assign(Object.create({ inherited: "untrusted" }), mapping());
  const candidates = [
    undefined,
    null,
    [],
    new Date(),
    mapping({ unexpected: "field" }),
    mapping({ schemaVersion: 2 }),
    mapping({ semanticClass: "namespace-administrator" }),
    mapping({ status: "unknown" }),
    mapping({ version: 0 }),
    mapping({ version: 1.5 }),
    mapping({ version: Number.MAX_SAFE_INTEGER + 1 }),
    mapping({ roleId: "" }),
    mapping({ roleId: " \t " }),
    mapping({ roleId: "invalid\nreference" }),
    mapping({ roleId: "\ud800" }),
    mapping({ roleId: "x".repeat(1025) }),
    mapping({ installationId: "é".repeat(513) }),
    nonenumerable,
    symbolic,
    cyclic,
    inherited,
  ];
  for (const candidate of candidates) {
    assert.deepEqual(decodeChannelAdministrationMappingV1(candidate), { kind: "invalid" });
  }
  assert.equal(
    decodeChannelAdministrationMappingV1(mapping({ installationId: "é".repeat(512) })).kind,
    "valid",
  );
});

test("channel administration decoders reject accessors without executing them", () => {
  let getterCalls = 0;
  function accessorVersion(value) {
    Object.defineProperty(value, "version", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("An untrusted accessor must not execute.");
      },
    });
    return value;
  }
  assert.deepEqual(decodeChannelAdministrationMappingV1(accessorVersion(mapping())), {
    kind: "invalid",
  });
  assert.deepEqual(
    decodeChannelAdministrationEvidenceV1(
      evidence([accessorVersion({ bindingId: "binding-human", roleId: "role-human", version: 7 })]),
    ),
    { kind: "invalid" },
  );
  const arrayAccessor = evidence();
  Object.defineProperty(arrayAccessor.mappings, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("An untrusted array accessor must not execute.");
    },
  });
  assert.deepEqual(decodeChannelAdministrationEvidenceV1(arrayAccessor), { kind: "invalid" });
  assert.equal(getterCalls, 0);
});

test("channel administration evidence rejects noncanonical arrays, duplicate bindings and excessive entries", () => {
  const arrayExtra = evidence();
  arrayExtra.mappings.extra = "unrecognized";
  const noncanonicalIndex = new Array(1);
  noncanonicalIndex["00"] = evidence().mappings[0];
  const inheritedArray = evidence();
  Object.setPrototypeOf(inheritedArray.mappings, Object.create(Array.prototype));
  const inheritedEntry = Object.assign(
    Object.create({ inherited: "untrusted" }),
    evidence().mappings[0],
  );
  const symbolicArray = evidence();
  symbolicArray.mappings[Symbol("hidden")] = "unrecognized";
  const candidates = [
    Object.assign(Object.create({ inherited: "untrusted" }), evidence()),
    { ...evidence(), unexpected: "field" },
    evidence([{ ...evidence().mappings[0], unexpected: "field" }]),
    evidence([{ bindingId: "binding-human", roleId: "role-human", version: 0 }]),
    evidence([
      { bindingId: "binding-human", roleId: "role-human", version: Number.MAX_SAFE_INTEGER + 1 },
    ]),
    evidence(new Array(1)),
    evidence(noncanonicalIndex),
    evidence([inheritedEntry]),
    arrayExtra,
    inheritedArray,
    symbolicArray,
    evidence([
      { bindingId: "same-binding", roleId: "role-one", version: 1 },
      { bindingId: "same-binding", roleId: "role-two", version: 2 },
    ]),
    evidence(
      Array.from({ length: 65 }, (_, index) => ({
        bindingId: `binding-${index}`,
        roleId: "shared-role",
        version: 1,
      })),
    ),
  ];
  for (const candidate of candidates) {
    assert.deepEqual(decodeChannelAdministrationEvidenceV1(candidate), { kind: "invalid" });
  }
  const boundary = decodeChannelAdministrationEvidenceV1(
    evidence(
      Array.from({ length: 64 }, (_, index) => ({
        bindingId: `binding-${index}`,
        roleId: "shared-role",
        version: 1,
      })),
    ),
  );
  assert.equal(boundary.kind, "valid");
  assert.equal(boundary.value.mappings.length, 64);
  assertDeepFrozen(boundary.value);
});

test("bootstrap registers the human binding explicitly while its same-Role service has no channel authority", async () => {
  const fixture = createNativeFixture();
  const { seed, humanBinding, serviceBinding } = fixture;
  assert.equal(humanBinding.roleId, serviceBinding.roleId);
  assert.deepEqual(humanBinding.channelAdministration, {
    schemaVersion: 1,
    version: 1,
    status: "enabled",
    installationId,
    roleId: humanBinding.roleId,
    semanticClass: "installation-administrator",
  });
  assert.equal(serviceBinding.channelAdministration, undefined);

  const human = await administer(fixture);
  assert.equal(human.allowed, true);
  assertMappings(human, [{ bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 1 }]);
  const service = await administer(fixture, seed.servicePrincipal.id);
  assert.equal(service.allowed, true);
  assert.deepEqual(service.evidence.bindingIds, [serviceBinding.id]);
  assertMappings(service, []);

  // Even a registration on a real service grant cannot supply the required human identity kind.
  serviceBinding.channelAdministration = { ...humanBinding.channelAdministration };
  assertMappings(await administer(fixture, seed.servicePrincipal.id), []);
});

test("native channel evidence joins actual granting bindings and Roles in one current policy snapshot", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding } = fixture;
  const secondRole = {
    id: "role-000-extra",
    permissions: [{ action: "administer", resourceKind: "installation" }],
  };
  const secondBinding = {
    id: "zz-binding-extra",
    subjectKind: "identity",
    subjectId: fixture.seed.principal.id,
    roleId: secondRole.id,
    resourceKind: "installation",
    resourceId: installationId,
    channelAdministration: mapping({ roleId: secondRole.id, version: 9 }),
  };
  state.roles.push(secondRole);
  state.bindings.push(secondBinding);
  const decision = await administer(fixture);
  assert.equal(fixture.loads, 1);
  assert.equal(decision.allowed, true);
  assert.equal(decision.driverId, fixture.driver.id);
  assert.deepEqual(decision.evidence.bindingIds, [humanBinding.id, secondBinding.id].sort());
  assert.deepEqual(decision.evidence.roleIds, [humanBinding.roleId, secondRole.id].sort());
  // Role IDs and Binding IDs sort independently; semantic pairs must come from real relationships.
  assertMappings(decision, [
    { bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 1 },
    { bindingId: secondBinding.id, roleId: secondRole.id, version: 9 },
  ]);
  assertDeepFrozen(decision);
  assert.equal(
    decodeChannelAdministrationEvidenceV1(decision.evidence.channelAdministration).kind,
    "valid",
  );
});

test("Role names and binding an existing administrator Role do not create semantic registration", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding } = fixture;
  state.roles[0].name = "Ordinary collaborator";
  assertMappings(await administer(fixture), [
    { bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 1 },
  ]);
  delete humanBinding.channelAdministration;
  state.roles[0].name = "Installation administrator";
  const renamed = await administer(fixture);
  assert.equal(renamed.allowed, true);
  assertMappings(renamed, []);

  const additional = createAuthPrincipalSeed(
    installationId,
    "https://identity.example.com",
    { id: "additional-human-account" },
    { roleId: humanBinding.roleId },
  );
  state.identities.push(additional.principal);
  state.bindings.push(...additional.bindings);
  assert.equal(additional.bindings[0].channelAdministration, undefined);
  const additionalDecision = await administer(fixture, additional.principal.id);
  assert.equal(additionalDecision.allowed, true);
  assertMappings(additionalDecision, []);
});

test("native channel evidence excludes unmapped, disabled, foreign-Installation and nongranting registrations", async (t) => {
  for (const [name, change] of [
    [
      "unmapped exact grant",
      ({ humanBinding }) => {
        delete humanBinding.channelAdministration;
      },
    ],
    [
      "disabled mapping",
      ({ humanBinding }) => {
        humanBinding.channelAdministration.status = "disabled";
      },
    ],
    [
      "another Installation mapping",
      ({ humanBinding }) => {
        humanBinding.channelAdministration.installationId = "ins_foreign";
      },
    ],
    [
      "mapping only on another subject's granting binding",
      ({ humanBinding, serviceBinding }) => {
        serviceBinding.channelAdministration = { ...humanBinding.channelAdministration };
        delete humanBinding.channelAdministration;
      },
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = createNativeFixture();
      change(fixture);
      const decision = await administer(fixture);
      assert.equal(decision.allowed, true);
      assert.deepEqual(decision.evidence.bindingIds, [fixture.humanBinding.id]);
      assertMappings(decision, []);
    });
  }

  await t.test("semantic registration cannot supply a missing administer permission", async () => {
    const fixture = createNativeFixture();
    fixture.state.roles[0].permissions = [{ action: "read", resourceKind: "installation" }];
    const decision = await administer(fixture);
    assert.equal(decision.allowed, false);
    assert.deepEqual(decision.evidence.bindingIds, []);
    assertMappings(decision, []);
  });
});

test("native IAM treats inconsistent channel mappings as unavailable during authorization and identity lookup", async (t) => {
  for (const [name, change] of [
    [
      "mapping names another Role",
      ({ humanBinding }) => {
        humanBinding.channelAdministration.roleId = "role-foreign";
      },
    ],
    [
      "mapping has an unknown semantic class",
      ({ humanBinding }) => {
        humanBinding.channelAdministration.semanticClass = "namespace-administrator";
      },
    ],
    [
      "binding has Namespace scope",
      ({ humanBinding }) => {
        humanBinding.namespaceId = "namespace-foreign";
      },
    ],
    [
      "Role and bindings have Namespace scope",
      ({ state }) => {
        state.roles[0].namespaceId = "namespace-foreign";
        for (const binding of state.bindings) binding.namespaceId = "namespace-foreign";
      },
    ],
    [
      "binding targets a different Installation than its mapping",
      ({ humanBinding }) => {
        humanBinding.resourceKind = "installation";
        humanBinding.resourceId = "ins_foreign";
      },
    ],
    [
      "binding targets an Agent",
      ({ humanBinding }) => {
        humanBinding.resourceKind = "agent";
        humanBinding.resourceId = "agent-foreign";
      },
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = createNativeFixture();
      change(fixture);
      const unavailable = (error) => {
        assert.ok(error instanceof ChannelAdministrationStateError);
        assert.ok(error instanceof TypeError);
        assert.equal(error.message, "Invalid native IAM channel administration mapping.");
        return true;
      };
      await assert.rejects(administer(fixture), unavailable);
      await assert.rejects(
        fixture.driver.lookupIdentity({
          issuer: fixture.seed.principal.issuer,
          subject: fixture.seed.principal.subject,
        }),
        unavailable,
      );
    });
  }
});

test("native channel group mapping requires the actor's actual current group membership and binding", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding, seed } = fixture;
  const group = { id: "group-channel-administrators", name: "Channel administrators" };
  const groupBinding = {
    id: "binding-channel-administrator-group",
    subjectKind: "group",
    subjectId: group.id,
    roleId: humanBinding.roleId,
    channelAdministration: { ...humanBinding.channelAdministration, version: 11 },
  };
  delete humanBinding.channelAdministration;
  state.groups.push(group);
  state.bindings.push(groupBinding);
  assertMappings(await administer(fixture), []);

  state.memberships.push({ groupId: group.id, principalId: seed.principal.id });
  const member = await administer(fixture);
  assert.equal(member.allowed, true);
  assert.deepEqual(member.evidence.groupIds, [group.id]);
  assert.ok(member.evidence.bindingIds.includes(groupBinding.id));
  assertMappings(member, [
    { bindingId: groupBinding.id, roleId: groupBinding.roleId, version: 11 },
  ]);

  state.memberships.length = 0;
  const formerMember = await administer(fixture);
  assert.equal(formerMember.allowed, true);
  assert.deepEqual(formerMember.evidence.groupIds, []);
  assertMappings(formerMember, []);
  state.memberships.push({ groupId: group.id, principalId: seed.principal.id });
  state.bindings.splice(state.bindings.indexOf(groupBinding), 1);
  assertMappings(await administer(fixture), []);
});

test("native channel evidence honors applicable Restrictions and preserves actual granting evidence", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding } = fixture;
  const restriction = {
    id: "restriction-channel-administration",
    action: "administer",
    resourceKind: "installation",
    resourceId: "ins_other",
    effect: "deny",
  };
  state.restrictions.push(restriction);
  assert.equal((await administer(fixture)).evidence.channelAdministration.mappings.length, 1);
  restriction.resourceId = installationId;
  const denied = await administer(fixture);
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.evidence.bindingIds, [humanBinding.id]);
  assert.deepEqual(denied.evidence.roleIds, [humanBinding.roleId]);
  assert.deepEqual(denied.evidence.restrictionIds, [restriction.id]);
  assertMappings(denied, []);
  state.restrictions.length = 0;
  assertMappings(await administer(fixture), [
    { bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 1 },
  ]);
});

test("native channel evidence reloads changed versions and removed bindings without positive caching", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding } = fixture;
  const first = await administer(fixture);
  humanBinding.channelAdministration.version = 2;
  const changed = await administer(fixture);
  assertMappings(changed, [
    { bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 2 },
  ]);
  assert.equal(first.evidence.channelAdministration.mappings[0].version, 1);
  state.bindings.splice(state.bindings.indexOf(humanBinding), 1);
  const removed = await administer(fixture);
  assert.equal(removed.allowed, false);
  assertMappings(removed, []);
  state.bindings.push(humanBinding);
  humanBinding.channelAdministration.version = 3;
  assertMappings(await administer(fixture), [
    { bindingId: humanBinding.id, roleId: humanBinding.roleId, version: 3 },
  ]);
  assert.equal(fixture.loads, 4);
});

test("native channel authorization rejects excessive mapping evidence and a failed policy store", async () => {
  const fixture = createNativeFixture();
  const { state, humanBinding } = fixture;
  state.bindings = Array.from({ length: 64 }, (_, index) => ({
    ...humanBinding,
    id: `binding-channel-${index}`,
    channelAdministration: { ...humanBinding.channelAdministration, version: index + 1 },
  }));
  const boundary = await administer(fixture);
  assert.equal(boundary.allowed, true);
  assert.equal(boundary.evidence.channelAdministration.mappings.length, 64);
  assert.equal(
    decodeChannelAdministrationEvidenceV1(boundary.evidence.channelAdministration).kind,
    "valid",
  );
  state.bindings.push({
    ...humanBinding,
    id: "binding-channel-overflow",
    channelAdministration: { ...humanBinding.channelAdministration, version: 65 },
  });
  await assert.rejects(administer(fixture), /channel administration evidence exceeds its bound/);
  state.bindings.pop();
  assert.equal((await administer(fixture)).evidence.channelAdministration.mappings.length, 64);

  fixture.store.loadNativeIAMState = async () => {
    throw new Error("The native channel policy store is unavailable.");
  };
  await assert.rejects(administer(fixture), /native channel policy store is unavailable/);
});
