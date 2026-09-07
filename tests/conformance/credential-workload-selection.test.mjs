import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCredentialWorkloadSelectionV1 as decode,
  CREDENTIAL_WORKLOAD_SELECTION_LIMITS_V1 as limits,
} from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import { createAdmittedCredentialWorkloadInspectorV1 as create } from "../../apps/controller/src/credentials/admitted-workload-selection.ts";
import { exampleCredentialWorkloadSelectionV1 as make } from "../fixtures/credential-workload-selection-v1/producer.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));
const invalid = (value) => assert.deepEqual(decode(value), { kind: "invalid" });
const digest = (character) => `sha256:${character.repeat(64)}`;

function binding(value = make()) {
  return {
    startup: {
      installationId: value.scope.installationId,
      processRef: "process/example",
      processGeneration: 1,
      operationRef: "operation/example",
      operationDigest: "b".repeat(64),
    },
    createEffectRef: "create/example",
    selection: { ...value.materialSelection },
    configurationRef: "configuration/example",
    configurationVersion: 1,
    profileRef: "gateway-profile/example",
    profileVersion: 1,
    namespaceRef: value.scope.namespaceId,
    agentRef: value.scope.agentId,
    admittedRevisionRef: value.revisionId,
    gatewayAssignmentRef: "assignment/example",
    hostRuntimeGeneration: 1,
    nativeConfigRef: "native-config/example",
    // Native configuration and admitted whole-configuration digests are distinct domains.
    configDigest: "native-config-digest/example",
    stateOwnership: { recordRef: "state/example", recordVersion: 1 },
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      {
        id: "identity/example",
        kind: "identity",
        profileRef: "identity/profile",
        requiredCapabilities: ["current"],
      },
      ...value.channels.map((channel) => ({
        id: channel.moduleId,
        kind: "channel",
        profileRef: channel.profileRef,
        requiredCapabilities: ["shared-session"],
      })),
    ],
    startupDeadlineMs: 5000,
    shutdownDeadlineMs: 5000,
  };
}
/** Synthetic boundary double only. Passing this comparison does not qualify Runtime authority. */
function held(b = binding(), guard = () => undefined) {
  const { startup, createEffectRef, ...selected } = b;
  return {
    selected,
    assertCurrent: guard,
    async release() {
      throw new Error("Inspector must not release");
    },
  };
}
function setup() {
  const value = make();
  const fixed = binding(value);
  const inspector = create(value, fixed);
  assert.ok(inspector);
  return { value, fixed, inspector, lease: held(fixed) };
}
function objectPaths(value, path = []) {
  if (!value || typeof value !== "object") return [];
  return [
    ...(Array.isArray(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((node, key) => node[key], value);
}
function frozen(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(frozen);
}

test("public subsection reuses admitted selected4, five roles and protected values without authority", () => {
  const original = make();
  const result = decode(original);
  assert.equal(result.kind, "valid");
  assert.deepEqual(result.value, original);
  assert.notEqual(result.value, original);
  frozen(result.value);
  original.association.selection.admissionVersion = 8;
  original.model.binding.secretVersion = 7;
  assert.equal(result.value.association.selection.admissionVersion, 1);
  assert.equal(result.value.model.binding.secretVersion, 1);
  assert.equal("handle" in result, false);
  assert.equal("ready" in result, false);
});

test("all nested dictionaries reject extra secret, physical, callback or future fields", () => {
  for (const path of objectPaths(make())) {
    const value = make();
    at(value, path).unrecognized = "extra";
    invalid(value);
  }
  for (const key of ["token", "secretBytes", "sha256", "resourceVersion", "uid"]) {
    const value = make();
    value.channels[0][key] = "not-material";
    invalid(value);
  }
  const value = make();
  value.channels[0].withMaterial = () => undefined;
  invalid(value);
  invalid({ ...make(), schemaVersion: 2 });
});

test("plain-data boundary refuses getters and proxy traps without executing them", () => {
  let calls = 0;
  const getter = make();
  Object.defineProperty(getter.model, "scope", {
    enumerable: true,
    get() {
      calls++;
      throw new Error("secret");
    },
  });
  invalid(getter);
  invalid(
    new Proxy(make(), {
      ownKeys() {
        calls++;
        throw new Error("secret");
      },
    }),
  );
  const nested = make();
  nested.repository.binding = new Proxy(nested.repository.binding, {
    getPrototypeOf() {
      calls++;
      throw new Error("secret");
    },
  });
  invalid(nested);
  assert.equal(calls, 0);
});

test("shape and resource ceilings reject cycles, holes, symbols, prototype and oversized strings", () => {
  const cycle = make();
  cycle.model.scope = cycle;
  invalid(cycle);
  const sparse = make();
  delete sparse.channels[0];
  invalid(sparse);
  const symbol = make();
  symbol[Symbol("data")] = 1;
  invalid(symbol);
  const inherited = Object.assign(Object.create({ inherited: true }), make());
  invalid(inherited);
  const long = make();
  long.model.upstreamWorkspaceRef = "x".repeat(limits.maxEncodedBytes + 1);
  invalid(long);
  const deep = make();
  let node = deep;
  for (let i = 0; i <= limits.maxDepth; i++) {
    node.extra = {};
    node = node.extra;
  }
  invalid(deep);
  for (const n of [-0, -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const value = make();
    value.association.selection.admissionVersion = n;
    invalid(value);
  }
  const unicode = make();
  unicode.model.upstreamWorkspaceRef = "\ud800";
  invalid(unicode);
});

test("null-prototype JSON records normalize without changing admitted content", () => {
  const value = make();
  Object.setPrototypeOf(value, null);
  const result = decode(value);
  assert.equal(result.kind, "valid");
  assert.deepEqual(result.value, make());
});

test("model setup retains distinct API-key, trusted-login and federation classes", () => {
  for (const kind of ["trusted-login", "workload-federation"]) {
    const value = make();
    value.model.profile.credentialClass = kind;
    value.model.setup = {
      kind,
      invocationMaterial: "access-token-and-account-context",
      refreshOwnerRef: "refresh/example",
      lifecycleProfile: { ref: "lifecycle/model", version: 1, digest: digest("a") },
    };
    assert.equal(decode(value).kind, "valid");
    value.model.setup.kind = kind === "trusted-login" ? "workload-federation" : "trusted-login";
    invalid(value);
  }
});

test("existing model/binding and repository/account/grant semantic relations remain closed", () => {
  const changes = [
    (v) => {
      v.model.binding.account.version++;
    },
    (v) => {
      v.model.profile.credentialClass = "workload-federation";
    },
    (v) => {
      v.repository.binding.providerId = "different";
    },
    (v) => {
      v.repository.binding.account.version++;
    },
    (v) => {
      v.repository.binding.scope.agentId = "agt_00000000-0000-4000-8000-000000000099";
    },
    (v) => {
      v.model.scope.namespaceId = "ns_00000000-0000-4000-8000-000000000099";
    },
    (v) => {
      v.repository.grant.providerInstallationRef = "different";
    },
    (v) => {
      v.repository.grant.permissionProfile.version++;
    },
    (v) => {
      v.repository.grant.permissions[1].access = "write";
    },
    (v) => {
      v.repository.grant.repositoryIds = ["202", "101"];
    },
    (v) => {
      v.repository.grant.permissions.reverse();
    },
    (v) => {
      v.repository.binding.secretVersion = "123";
    },
  ];
  for (const change of changes) {
    const value = make();
    change(value);
    invalid(value);
  }
});

test("role/channel identities and canonical channel order cannot be ambiguous", () => {
  const role = make();
  role.association.profileRefs.storage.ref = role.association.profileRefs.runtime.ref;
  invalid(role);
  const channel = make();
  channel.channels[1] = clone(channel.channels[0]);
  invalid(channel);
  const module = make();
  module.channels[1].moduleId = module.channels[0].moduleId;
  invalid(module);
  const credentials = make();
  credentials.channels[0].app.ref = credentials.channels[0].bot.ref;
  invalid(credentials);
  const order = make();
  order.channels.reverse();
  invalid(order);
  const empty = make();
  empty.channels = [];
  invalid(empty);
});

test("ordinary comparison accepts exact immutable correspondence and preserves digest domains", () => {
  const { value, fixed, inspector, lease } = setup();
  assert.notEqual(fixed.configDigest, value.association.admittedConfigurationDigest);
  assert.deepEqual(inspector.inspect(lease, value), { kind: "corresponds" });
  assert.deepEqual(Object.keys(inspector.inspect(lease, value)), ["kind"]);
});

test("fixed invalid expectations are unavailable before any original lease use", () => {
  const value = make();
  const wrong = binding(value);
  wrong.startup.installationId = "other-installation";
  assert.equal(create(value, wrong), undefined);
  const module = binding(value);
  module.modules[1].profileRef = "other-profile";
  assert.equal(create(value, module), undefined);
  const duplicate = binding(value);
  duplicate.modules.push(clone(duplicate.modules[1]));
  assert.equal(create(value, duplicate), undefined);
  const selection = binding(value);
  selection.selection.recordVersion++;
  assert.equal(create(value, selection), undefined);
  assert.equal(create({ ...value, token: "not-material" }, binding(value)), undefined);
});

test("all selected4 and five-role changes remain mismatches against the captured original", () => {
  const { value, inspector, lease } = setup();
  for (const key of ["manifestRef", "admissionRef"]) {
    const changed = clone(value);
    changed.association.selection[key] = "00000000-0000-4000-8000-000000000098";
    assert.deepEqual(inspector.inspect(lease, changed), {
      kind: "mismatch",
      reason: "admitted-selection",
    });
  }
  for (const change of [
    (v) => {
      v.association.selection.admissionVersion++;
    },
    (v) => {
      v.association.selection.manifestDigest = digest("c");
    },
    (v) => {
      v.association.admittedConfigurationDigest = digest("c");
    },
    ...Object.keys(value.association.profileRefs).map((role) => (v) => {
      v.association.profileRefs[role].version++;
    }),
    (v) => {
      v.model.invocationProfile.version++;
    },
    (v) => {
      v.repository.binding.secretVersion++;
    },
    (v) => {
      v.materialSelection.recordVersion++;
    },
    (v) => {
      v.channels[0].bot.version++;
    },
  ]) {
    const changed = clone(value);
    change(changed);
    assert.deepEqual(inspector.inspect(lease, changed), {
      kind: "mismatch",
      reason: "admitted-selection",
    });
  }
});

test("native versus optional repository mode correspondence grants no optional implementation", () => {
  const { value, inspector, lease } = setup();
  for (const mode of ["mediated", "history-isolated"]) {
    const changed = clone(value);
    changed.repository.profile.mode = mode;
    assert.equal(decode(changed).kind, "valid");
    assert.deepEqual(inspector.inspect(lease, changed), {
      kind: "mismatch",
      reason: "admitted-selection",
    });
  }
});

test("actual held startup binding changes cannot be hidden by equal credential metadata", () => {
  const { value, inspector, fixed } = setup();
  for (const change of [
    (v) => {
      v.gatewayAssignmentRef = "other-assignment";
    },
    (v) => {
      v.hostRuntimeGeneration++;
    },
    (v) => {
      v.selection.recordVersion++;
    },
    (v) => {
      v.nativeConfigRef = "other-native-config";
    },
    (v) => {
      v.configDigest = "other-native-digest";
    },
    (v) => {
      v.modules[1].requiredCapabilities.push("other-capability");
    },
    (v) => {
      v.stateOwnership.recordVersion++;
    },
  ]) {
    const changed = clone(fixed);
    change(changed);
    assert.deepEqual(inspector.inspect(held(changed), value), {
      kind: "mismatch",
      reason: "runtime-selection",
    });
  }
});

test("original synchronous fences bracket comparison without taking release ownership", () => {
  const { value, inspector, fixed } = setup();
  let calls = 0,
    releases = 0;
  const lease = held(fixed, () => {
    calls++;
    return undefined;
  });
  lease.release = async () => {
    releases++;
  };
  assert.deepEqual(inspector.inspect(lease, value), { kind: "corresponds" });
  assert.equal(calls, 2);
  assert.equal(releases, 0);
  for (const guard of [
    () => true,
    () => {
      throw new Error("private detail");
    },
    async () => undefined,
  ]) {
    assert.deepEqual(inspector.inspect(held(fixed, guard), value), { kind: "unavailable" });
  }
});

test("late invalidation and changed selected bytes keep original uncertainty and custody", () => {
  const { value, inspector, fixed } = setup();
  let calls = 0;
  const invalidated = held(fixed, () => {
    if (++calls === 2) throw new Error("revoked");
  });
  assert.deepEqual(inspector.inspect(invalidated, value), { kind: "unavailable" });
  calls = 0;
  const changed = held(clone(fixed), () => {
    if (++calls === 2) changed.selected.hostRuntimeGeneration++;
  });
  assert.deepEqual(inspector.inspect(changed, value), { kind: "unavailable" });
});

test("malformed original getter/proxy boundaries do not become data proof", () => {
  const { value, inspector, fixed } = setup();
  let reads = 0;
  const lease = held(fixed);
  Object.defineProperty(lease, "assertCurrent", {
    get() {
      reads++;
      return () => undefined;
    },
  });
  assert.deepEqual(inspector.inspect(lease, value), { kind: "unavailable" });
  const selected = held(fixed);
  Object.defineProperty(selected, "selected", {
    get() {
      reads++;
      return {};
    },
  });
  assert.deepEqual(inspector.inspect(selected, value), { kind: "unavailable" });
  assert.deepEqual(
    inspector.inspect(
      new Proxy(held(fixed), {
        get() {
          reads++;
          return {};
        },
      }),
      value,
    ),
    { kind: "unavailable" },
  );
  assert.equal(reads, 0);
});

test("mutating constructor inputs cannot retarget captured borrower expectations", () => {
  const { value, fixed, inspector } = setup();
  value.association.selection.admissionVersion = 99;
  fixed.hostRuntimeGeneration = 99;
  const original = make();
  assert.deepEqual(inspector.inspect(held(binding(original)), original), { kind: "corresponds" });
  assert.deepEqual(inspector.inspect(held(fixed), original), {
    kind: "mismatch",
    reason: "runtime-selection",
  });
});

test("invalid admitted data remains distinct from unavailable original currentness", () => {
  const { value, inspector, lease, fixed } = setup();
  assert.deepEqual(inspector.inspect(lease, { ...value, extra: true }), {
    kind: "mismatch",
    reason: "invalid-selection",
  });
  assert.deepEqual(
    inspector.inspect(
      held(fixed, () => {
        throw new Error("outage");
      }),
      value,
    ),
    { kind: "unavailable" },
  );
});

for (const rejectingFence of [1, 2]) {
  test(
    "ordinary guard rejected Promise at fence " + rejectingFence + " is observed and denied",
    async () => {
      const { value, inspector, fixed } = setup();
      let calls = 0;
      let releases = 0;
      const lease = held(fixed, function () {
        calls++;
        if (calls === rejectingFence)
          return Promise.reject(new Error("private currentness failure"));
        return undefined;
      });
      lease.release = async () => {
        releases++;
      };
      assert.deepEqual(inspector.inspect(lease, value), { kind: "unavailable" });
      assert.equal(calls, rejectingFence);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(releases, 0);
    },
  );
}
