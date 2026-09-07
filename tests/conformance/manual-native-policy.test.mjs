import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalManualPolicyCommandV1,
  decodeManualPolicyCommandV1,
  decodeManualPolicyReadV1,
  decodeManualPolicyResultV1,
  decodeManualPolicyRegistrationV1,
  decodeManualPolicyTemplateV1,
} from "../../packages/contracts/src/manual-native-policy-v1.ts";
import {
  classifyManualPolicyRegistrationChangeV1,
  evaluateManualPolicyBindingV1,
  expandManualPolicyTemplateV1,
  manualPolicyRequiredSemanticsV1,
} from "../../packages/occ/src/iam/manual-policy.ts";

const uuid = "12345678-1234-4234-8234-123456789abc";
const installationId = `ins_${uuid}`;
const namespaceId = `ns_${uuid}`;
const agentId = `agt_${uuid}`;
const configurationId = `cfg_${uuid}`;
const serviceAccountId = `sa_${uuid}`;
const secretId = `sec_${uuid}`;
const principalId = "prn_person-a";
const emptyReferences = () => ({ configurationIds: [], serviceAccountIds: [], secretIds: [] });
function spec(template = "agent-operator", operationCeiling = ["agent.status", "agent.stop"]) {
  return {
    template,
    target: { kind: "agent", namespaceId, agentId },
    operationCeiling,
    references: emptyReferences(),
  };
}
const baseline = () => ({
  template: "account-baseline",
  target: { kind: "installation" },
  operationCeiling: ["installation.read"],
  references: emptyReferences(),
});
function command(specification = spec()) {
  return {
    schemaVersion: 1,
    operationRef: "policy-operation-a",
    expectedPolicyVersion: 3,
    change: "create",
    specification,
    principalIds: specification.template === "account-baseline" ? [] : [principalId],
    previousBindings: [],
  };
}
function registration(specification = spec()) {
  return {
    schemaVersion: 1,
    version: 1,
    status: "enabled",
    installationId,
    roleId: "role_operator-a",
    specification,
  };
}
function candidate(specification = spec()) {
  const expansion = expandManualPolicyTemplateV1(specification, installationId);
  assert.equal(expansion.kind, "expanded");
  const scope = specification.target.kind === "agent" ? { namespaceId } : {};
  const primary = expansion.grants.find(
    (grant) => grant.resource.kind === specification.target.kind,
  );
  return {
    installationId,
    registration: registration(specification),
    role: { id: "role_operator-a", ...scope, permissions: expansion.rolePermissions },
    binding: {
      id: "binding_operator-a",
      ...scope,
      subjectKind: "identity",
      subjectId: principalId,
      roleId: "role_operator-a",
      resourceKind: primary.resource.kind,
      resourceId: primary.resource.id,
    },
    request: { principalId, action: "read", resource: primary.resource },
    principalKind: "principal",
  };
}
const permissionKeys = (values) =>
  values.map(({ action, resourceKind }) => `${resourceKind}:${action}`).sort();

// Actual codecs and pure policy contributions only; these fixtures are not authority producers.
test("all five finite templates decode, with no role-name or service template", () => {
  const templates = [
    baseline(),
    spec(),
    spec("agent-administrator", ["agent.administer"]),
    spec("agent-collaborator", ["conversation.read", "turn.admit"]),
    spec("audience-reader", ["conversation.read"]),
  ];
  for (const value of templates)
    assert.equal(decodeManualPolicyCommandV1(command(value)).kind, "valid");
  assert.equal(
    decodeManualPolicyTemplateV1({ ...spec(), template: "Installation administrator" }).kind,
    "invalid",
  );
  assert.equal(
    decodeManualPolicyTemplateV1({ ...spec(), template: "service-operator" }).kind,
    "invalid",
  );
});

test("baseline creates only an existing-role enrollment proposal with exact Installation read", () => {
  const expanded = expandManualPolicyTemplateV1(baseline(), installationId);
  assert.equal(expanded.kind, "expanded");
  assert.deepEqual(permissionKeys(expanded.rolePermissions), ["installation:read"]);
  assert.deepEqual(expanded.grants[0].resource, { kind: "installation", id: installationId });
  assert.equal(
    decodeManualPolicyCommandV1({ ...command(baseline()), principalIds: [principalId] }).kind,
    "invalid",
  );
  assert.equal(expandManualPolicyTemplateV1(baseline(), "ins_foreign-format").kind, "invalid");
});

test("deployment expansion preserves exact reference checks and never gives secret read", () => {
  const value = spec("agent-operator", ["agent.resume"]);
  value.references = {
    configurationIds: [configurationId],
    serviceAccountIds: [serviceAccountId],
    secretIds: [secretId],
  };
  const result = expandManualPolicyTemplateV1(value, installationId);
  assert.equal(result.kind, "expanded");
  assert.deepEqual(permissionKeys(result.rolePermissions), [
    "agent:deploy",
    "agent:operate",
    "agent:read",
    "configuration:read",
    "secret:operate",
    "service_account:read",
  ]);
  assert.equal(result.grants.length, 4);
  for (const grant of result.grants) assert.equal(grant.resource.namespaceId, namespaceId);
  assert.deepEqual(result.grants.find((grant) => grant.resource.kind === "secret").resource, {
    kind: "secret",
    id: secretId,
    namespaceId,
  });
  assert.equal(
    decodeManualPolicyTemplateV1(spec("agent-operator", ["agent.deploy"])).kind,
    "invalid",
  );
});

test("reader and lifecycle operator permissions stay distinct", () => {
  const reader = expandManualPolicyTemplateV1(
    spec("audience-reader", ["conversation.read"]),
    installationId,
  );
  assert.deepEqual(permissionKeys(reader.rolePermissions), ["agent:read"]);
  for (const value of [
    spec("audience-reader", ["turn.admit"]),
    spec("agent-operator", ["conversation.read"]),
    spec("agent-collaborator", ["agent.stop"]),
    spec("agent-administrator", ["turn.cancel.own"]),
  ])
    assert.equal(decodeManualPolicyTemplateV1(value).kind, "invalid");
});

test("recovery requires exact Agent administration and operation while observation does not", () => {
  const recover = expandManualPolicyTemplateV1(
    spec("agent-administrator", ["context.recover-pristine"]),
    installationId,
  );
  assert.deepEqual(permissionKeys(recover.rolePermissions), [
    "agent:administer",
    "agent:operate",
    "agent:read",
  ]);
  const observe = expandManualPolicyTemplateV1(
    spec("agent-operator", ["agent.reconcile-observation"]),
    installationId,
  );
  assert.deepEqual(permissionKeys(observe.rolePermissions), ["agent:operate", "agent:read"]);
  assert.deepEqual(manualPolicyRequiredSemanticsV1("context.accept-residual-workspace"), [
    "agent-administrator",
  ]);
  assert.deepEqual(manualPolicyRequiredSemanticsV1("agent.reconcile-observation"), [
    "lifecycle-manager",
  ]);
  assert.throws(() => manualPolicyRequiredSemanticsV1("agent.purge"));
});

test("collaboration retains separate common-grant and actor predicates", () => {
  assert.deepEqual(manualPolicyRequiredSemanticsV1("turn.admit"), [
    "human-collaborator",
    "conversation-read",
    "conversation-append",
    "common-grant-use",
  ]);
  assert.ok(manualPolicyRequiredSemanticsV1("turn.cancel.own").includes("own-turn-actor"));
  const value = spec("agent-collaborator", ["conversation.read", "model.generate"]);
  assert.equal(decodeManualPolicyTemplateV1(value).kind, "invalid");
  value.references.secretIds.push(secretId);
  assert.equal(decodeManualPolicyTemplateV1(value).kind, "valid");
  assert.equal(
    decodeManualPolicyTemplateV1(spec("agent-collaborator", ["turn.admit"])).kind,
    "invalid",
  );
});

test("closed codecs reject caller authority, unknown action, wildcard and cross-kind IDs", () => {
  const inputs = [
    { ...command(), installationId },
    { ...command(), permissions: ["*"] },
    { ...command(), administrator: true },
    { ...command(), principalIds: ["spn_service"] },
    command({ ...spec(), target: { kind: "agent", namespaceId, agentId: secretId } }),
    command({ ...spec(), operationCeiling: ["agent.stop", "agent.stop"] }),
    command({ ...spec(), operationCeiling: ["*"] }),
    command({ ...spec(), references: { ...emptyReferences(), secretIds: [secretId] } }),
  ];
  for (const value of inputs) assert.equal(decodeManualPolicyCommandV1(value).kind, "invalid");
});

test("versions, immutable binding references and command/read shapes are bounded", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1"])
    assert.equal(
      decodeManualPolicyCommandV1({ ...command(), expectedPolicyVersion: value }).kind,
      "invalid",
    );
  assert.equal(
    decodeManualPolicyCommandV1({ ...command(), expectedPolicyVersion: Number.MAX_SAFE_INTEGER })
      .kind,
    "valid",
  );
  const previous = { bindingId: "binding-old", roleId: "role-old", expectedRegistrationVersion: 1 };
  assert.equal(
    decodeManualPolicyCommandV1({ ...command(), previousBindings: [previous] }).kind,
    "invalid",
  );
  assert.equal(decodeManualPolicyCommandV1({ ...command(), change: "withdraw" }).kind, "invalid");
  assert.equal(
    decodeManualPolicyCommandV1({ ...command(), change: "withdraw", previousBindings: [previous] })
      .kind,
    "valid",
  );
  assert.equal(
    decodeManualPolicyCommandV1({
      ...command(),
      change: "withdraw",
      previousBindings: [previous, previous],
    }).kind,
    "invalid",
  );
  assert.equal(
    decodeManualPolicyReadV1({ schemaVersion: 1, operationRef: "policy-operation-a" }).kind,
    "valid",
  );
  assert.equal(
    decodeManualPolicyReadV1({
      schemaVersion: 1,
      operationRef: "policy-operation-a",
      expectedPolicyVersion: 2,
    }).kind,
    "invalid",
  );
});

test("representation rejects accessors, prototypes, hidden keys, sparse arrays and cycles", () => {
  let called = 0;
  const accessor = command();
  Object.defineProperty(accessor, "administrator", {
    enumerable: true,
    get() {
      called++;
      throw new Error("must not run");
    },
  });
  assert.equal(decodeManualPolicyCommandV1(accessor).kind, "invalid");
  assert.equal(called, 0);
  const hidden = command();
  Object.defineProperty(hidden, "hidden", { value: true });
  const symbol = command();
  symbol[Symbol("extra")] = true;
  const cycle = command();
  cycle.specification = cycle;
  const sparse = command();
  sparse.principalIds = new Array(1);
  const enhanced = command();
  enhanced.principalIds.extra = true;
  const inherited = Object.assign(Object.create({ allowed: true }), command());
  for (const value of [hidden, symbol, cycle, sparse, enhanced, inherited])
    assert.equal(decodeManualPolicyCommandV1(value).kind, "invalid");
});

test("count and encoded command limits reject oversized metadata", () => {
  assert.equal(
    decodeManualPolicyCommandV1({
      ...command(),
      principalIds: Array.from({ length: 9 }, (_, i) => `prn_${i}`),
    }).kind,
    "invalid",
  );
  const value = {
    ...command(),
    change: "withdraw",
    previousBindings: Array.from({ length: 64 }, (_, i) => ({
      bindingId: `binding_${i}_${"a".repeat(170)}`,
      roleId: `role_${i}_${"b".repeat(170)}`,
      expectedRegistrationVersion: 1,
    })),
  };
  assert.ok(new TextEncoder().encode(JSON.stringify(value)).byteLength > 16 * 1024);
  assert.equal(decodeManualPolicyCommandV1(value).kind, "invalid");
});

test("canonical command identity normalizes unordered sets and protects copied values", () => {
  const original = command();
  original.principalIds.push("prn_person-b");
  const other = {
    ...structuredClone(original),
    principalIds: [...original.principalIds].reverse(),
  };
  other.specification.operationCeiling.reverse();
  assert.equal(canonicalManualPolicyCommandV1(original), canonicalManualPolicyCommandV1(other));
  other.expectedPolicyVersion++;
  assert.notEqual(canonicalManualPolicyCommandV1(original), canonicalManualPolicyCommandV1(other));
  const result = decodeManualPolicyCommandV1(original);
  assert.equal(result.kind, "valid");
  original.specification.operationCeiling.push("agent.administer");
  assert.equal(result.value.specification.operationCeiling.includes("agent.administer"), false);
  assert.ok(Object.isFrozen(result.value.specification.operationCeiling));
  assert.throws(() => result.value.specification.operationCeiling.push("agent.administer"));
});

test("binding evaluation returns a contribution, never an operation permit", () => {
  const input = candidate();
  const result = evaluateManualPolicyBindingV1(input);
  assert.deepEqual(result, {
    kind: "eligible",
    scope: "binding-contribution-only",
    bindingId: input.binding.id,
    roleId: input.role.id,
    registrationVersion: 1,
    operationCeiling: ["agent.status", "agent.stop"],
  });
  assert.equal(Object.hasOwn(result, "allowed"), false);
  assert.ok(Object.isFrozen(result.operationCeiling));
});

test("disabled registration contributes neither generic read nor operate", () => {
  const input = candidate();
  input.registration.status = "disabled";
  for (const action of ["read", "operate"]) {
    input.request = { ...input.request, action };
    assert.equal(evaluateManualPolicyBindingV1(input).kind, "denied");
  }
});

test("actual Role and Binding identity, permissions and scope must match registration", () => {
  const changes = [
    (x) => {
      x.role.id = "role-other";
    },
    (x) => {
      x.binding.roleId = "role-other";
    },
    (x) => {
      x.binding.resourceId = "agt_other";
    },
    (x) => {
      delete x.binding.namespaceId;
    },
    (x) => {
      delete x.role.namespaceId;
    },
    (x) => {
      x.role.permissions = [...x.role.permissions, { resourceKind: "secret", action: "read" }];
    },
    (x) => {
      x.role.permissions = x.role.permissions.slice(1);
    },
    (x) => {
      x.role.permissions = [x.role.permissions[0], x.role.permissions[0]];
    },
    (x) => {
      x.binding.channelAdministration = {};
    },
    (x) => {
      x.binding.subjectKind = "group";
    },
    (x) => {
      x.registration.installationId = "ins_other";
    },
  ];
  for (const change of changes) {
    const input = candidate();
    change(input);
    assert.equal(evaluateManualPolicyBindingV1(input).kind, "unavailable");
  }
});

test("foreign actor, Namespace, resource, action and service identity do not contribute", () => {
  const changes = [
    (x) => {
      x.request = { ...x.request, principalId: "prn_other" };
    },
    (x) => {
      x.request = { ...x.request, action: "administer" };
    },
    (x) => {
      x.request = { ...x.request, resource: { ...x.request.resource, namespaceId: "ns_other" } };
    },
    (x) => {
      x.request = { ...x.request, resource: { ...x.request.resource, id: "agt_other" } };
    },
    (x) => {
      x.principalKind = "service_principal";
    },
  ];
  for (const change of changes) {
    const input = candidate();
    change(input);
    assert.equal(evaluateManualPolicyBindingV1(input).kind, "denied");
  }
});

test("whole-role permission union does not grant the wrong action on an exact reference binding", () => {
  const value = spec("agent-operator", ["agent.deploy"]);
  value.references = {
    configurationIds: [configurationId],
    serviceAccountIds: [],
    secretIds: [secretId],
  };
  const input = candidate(value);
  input.binding = { ...input.binding, resourceKind: "secret", resourceId: secretId };
  input.request = {
    principalId,
    action: "operate",
    resource: { kind: "secret", id: secretId, namespaceId },
  };
  assert.equal(evaluateManualPolicyBindingV1(input).kind, "eligible");
  input.request.action = "read";
  assert.equal(evaluateManualPolicyBindingV1(input).kind, "denied");
});

test("withdrawal preserves original metadata, exact version progression and terminal identity", () => {
  const before = registration();
  const after = structuredClone(before);
  after.version++;
  after.status = "disabled";
  assert.equal(classifyManualPolicyRegistrationChangeV1(before, after), "withdraw");
  assert.equal(classifyManualPolicyRegistrationChangeV1(before, before), "unchanged");
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(after, { ...after, version: 3, status: "enabled" }),
    "invalid",
  );
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(before, { ...after, roleId: "role-new" }),
    "invalid",
  );
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(before, { ...after, version: 3 }),
    "invalid",
  );
  assert.equal(classifyManualPolicyRegistrationChangeV1(before, null), "invalid");
  const exhausted = { ...before, version: Number.MAX_SAFE_INTEGER };
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(exhausted, { ...exhausted, status: "disabled" }),
    "invalid",
  );
});

test("semantic narrowing never rewrites an immutable Role into a broader or different grant", () => {
  const before = registration(spec("agent-operator", ["agent.stop", "agent.disable"]));
  const after = structuredClone(before);
  after.version++;
  after.specification.operationCeiling = ["agent.stop"];
  assert.equal(classifyManualPolicyRegistrationChangeV1(before, after), "narrow");
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(after, { ...before, version: 3 }),
    "invalid",
  );
  const removeOperate = structuredClone(before);
  removeOperate.specification.operationCeiling = ["agent.status", "agent.stop"];
  const onlyRead = structuredClone(removeOperate);
  onlyRead.version++;
  onlyRead.specification.operationCeiling = ["agent.status"];
  assert.equal(
    classifyManualPolicyRegistrationChangeV1(removeOperate, onlyRead),
    "replacement-required",
  );
});

test("registration codec preserves the finite field set and positive safe version", () => {
  assert.equal(decodeManualPolicyRegistrationV1(registration()).kind, "valid");
  for (const change of [
    { version: 0 },
    { status: "active" },
    { allowed: true },
    { roleId: "" },
    { installationId: "other" },
  ])
    assert.equal(
      decodeManualPolicyRegistrationV1({ ...registration(), ...change }).kind,
      "invalid",
    );
});

test("safe outcomes retain exact operation and registration identity without diagnostic leakage", () => {
  const committed = {
    schemaVersion: 1,
    kind: "committed",
    operationRef: "policy-operation-a",
    commandDigest: "a".repeat(64),
    policyVersion: 4,
    roleIds: ["role_operator-a"],
    registrations: [
      {
        bindingId: "binding_operator-a",
        roleId: "role_operator-a",
        version: 2,
        status: "disabled",
      },
    ],
  };
  assert.equal(decodeManualPolicyResultV1(committed).kind, "valid");
  assert.equal(
    decodeManualPolicyResultV1({
      ...committed,
      registrations: [{ ...committed.registrations[0], roleId: "role_other" }],
    }).kind,
    "invalid",
  );
  assert.equal(
    decodeManualPolicyResultV1({
      ...committed,
      registrations: [committed.registrations[0], committed.registrations[0]],
    }).kind,
    "invalid",
  );
  assert.equal(
    decodeManualPolicyResultV1({
      schemaVersion: 1,
      kind: "unknown",
      operationRef: "policy-operation-a",
    }).kind,
    "valid",
  );
  for (const kind of ["conflict", "denied", "unavailable"]) {
    assert.equal(decodeManualPolicyResultV1({ schemaVersion: 1, kind }).kind, "valid");
    assert.equal(
      decodeManualPolicyResultV1({ schemaVersion: 1, kind, reason: "private policy" }).kind,
      "invalid",
    );
  }
  assert.equal(
    decodeManualPolicyResultV1({ ...committed, credential: "forbidden" }).kind,
    "invalid",
  );
});

test("accepted principal/reference cross-product fits the complete binding result bound", () => {
  const value = spec("agent-operator", ["agent.deploy"]);
  value.references = {
    configurationIds: [configurationId],
    serviceAccountIds: [serviceAccountId],
    secretIds: Array.from({ length: 5 }, (_, i) => `sec_12345678-1234-4234-8234-123456789ab${i}`),
  };
  const request = {
    ...command(value),
    principalIds: Array.from({ length: 8 }, (_, i) => `prn_person-${i}`),
  };
  assert.equal(
    expandManualPolicyTemplateV1(value, installationId).grants.length * request.principalIds.length,
    64,
  );
  assert.equal(decodeManualPolicyCommandV1(request).kind, "valid");
  value.references.secretIds.push("sec_12345678-1234-4234-8234-123456789ab5");
  assert.equal(decodeManualPolicyCommandV1(request).kind, "invalid");
  value.references.secretIds.pop();
  request.principalIds = [principalId];
  value.references.serviceAccountIds.push("sa_12345678-1234-4234-8234-123456789ab5");
  assert.equal(decodeManualPolicyCommandV1(request).kind, "invalid");
});
