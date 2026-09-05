import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilesystemConfigurationDriver } from "../../apps/controller/src/drivers/configuration/filesystem/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";

const actor = "configuration-editor";
const id = (kind) => `${kind}_${randomUUID()}`;

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), "oce-configuration-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installation = {
    id: id("ins"),
    name: "Configuration JSON conformance",
    createdAt: new Date().toISOString(),
  };
  const state = new InMemoryPlatformState();
  const controller = new OpenClawController(installation, { state });
  const driver = new FilesystemConfigurationDriver(root);
  const iam = new NativeIAMDriver({
    loadNativeIAMState: async () => ({
      identities: [{ kind: "principal", id: actor, issuer: "configuration-test", subject: actor }],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        {
          id: "configuration-editor-role",
          permissions: ["create", "read", "update"].map((action) => ({
            action,
            resourceKind: "configuration",
          })),
        },
      ],
      bindings: [
        {
          id: "configuration-editor-binding",
          subjectKind: "identity",
          subjectId: actor,
          roleId: "configuration-editor-role",
        },
      ],
    }),
  });
  for (const selected of [iam, driver]) {
    controller.registerDriver(selected);
    controller.selectDriver(selected.capability, selected.id);
  }
  // A provisioning Namespace accepts drafts before any runtime is deployed.
  const namespace = {
    id: id("ns"),
    name: `configuration-json-${randomUUID()}`,
    status: "provisioning",
    createdAt: installation.createdAt,
  };
  await controller.transact((unit) => unit.namespaces.createNamespace(namespace));
  return { root, state, controller, driver, namespace };
}

function invalidDocuments(accessorReads) {
  const cyclic = {};
  cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      accessorReads.count += 1;
      return true;
    },
  });
  const sparse = [true, , false];
  const extraArrayProperty = Object.assign([true], { extra: "would be omitted" });
  return [
    ["top-level null", null],
    ["top-level array", []],
    ["top-level primitive", "configuration"],
    ["nested positive infinity", { plugins: { retry: Infinity } }],
    ["nested negative infinity", { list: [false, { retry: -Infinity }] }],
    ["nested NaN", { list: [NaN] }],
    ["undefined property", { optional: undefined }],
    ["undefined array entry", { list: [undefined] }],
    ["bigint", { count: 1n }],
    ["function", { callback() {} }],
    ["symbol value", { value: Symbol("value") }],
    ["symbol property", { [Symbol("property")]: true }],
    ["date", { date: new Date("2026-01-01T00:00:00.000Z") }],
    ["map", { entries: new Map([["key", "value"]]) }],
    [
      "custom prototype",
      { options: Object.assign(Object.create({ inherited: true }), { own: true }) },
    ],
    ["non-enumerable property", { options: Object.defineProperty({}, "hidden", { value: true }) }],
    ["accessor", { options: accessor }],
    ["sparse array", { list: sparse }],
    ["extra array property", { list: extraArrayProperty }],
    ["cycle", cyclic],
  ];
}

test("Configuration rejects non-JSON drafts before Driver or state mutation", async (t) => {
  const f = await fixture(t);
  const beforeAudit = await f.state.read((view) => view.audit.list());
  // Spies call the original implementations; persisted outcomes remain the real oracle.
  const mutations = t.mock.method(f.state, "transact");
  const driverMethods = ["validate", "create", "read", "update", "delete"].map((method) =>
    t.mock.method(f.driver, method),
  );
  const accessorReads = { count: 0 };
  for (const [label, values] of invalidDocuments(accessorReads)) {
    await assert.rejects(
      f.controller.createConfiguration(actor, {
        namespaceId: f.namespace.id,
        kind: "agent",
        values,
      }),
      { name: ScopeViolationError.name, message: "Configuration values must be a JSON object." },
      label,
    );
  }
  assert.equal(accessorReads.count, 0, "Configuration admission must not evaluate getters.");
  assert.equal(mutations.mock.callCount(), 0);
  for (const method of driverMethods) assert.equal(method.mock.callCount(), 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(await f.state.read((view) => view.audit.list()), beforeAudit);
});

test("Configuration rejects non-JSON replacements without changing persisted state", async (t) => {
  const f = await fixture(t);
  const created = await f.controller.createConfiguration(actor, {
    namespaceId: f.namespace.id,
    kind: "agent",
    values: { retained: { entries: [true, null, 1.5] } },
  });
  const path = join(f.root, f.namespace.id, `${created.id}.json`);
  const beforeBytes = await readFile(path, "utf8");
  const beforeState = await f.state.read(async (view) => ({
    metadata: await view.configurations.findConfiguration(f.namespace.id, created.id),
    audit: await view.audit.list(),
  }));
  const mutations = t.mock.method(f.state, "transact");
  const driverMethods = ["validate", "create", "read", "update", "delete"].map((method) =>
    t.mock.method(f.driver, method),
  );
  const accessorReads = { count: 0 };
  for (const [label, values] of invalidDocuments(accessorReads)) {
    await assert.rejects(
      f.controller.updateConfiguration(actor, {
        namespaceId: f.namespace.id,
        configurationId: created.id,
        expectedGeneration: created.generation,
        values,
      }),
      { name: ScopeViolationError.name, message: "Configuration values must be a JSON object." },
      label,
    );
  }
  assert.equal(accessorReads.count, 0, "Configuration admission must not evaluate getters.");
  assert.equal(mutations.mock.callCount(), 0);
  for (const method of driverMethods) assert.equal(method.mock.callCount(), 0);
  assert.equal(await readFile(path, "utf8"), beforeBytes);
  assert.deepEqual(await readdir(join(f.root, f.namespace.id)), [`${created.id}.json`]);
  assert.deepEqual(
    await f.state.read(async (view) => ({
      metadata: await view.configurations.findConfiguration(f.namespace.id, created.id),
      audit: await view.audit.list(),
    })),
    beforeState,
  );
  assert.deepEqual(await f.controller.getConfiguration(actor, f.namespace.id, created.id), created);
});

test("Configuration preserves native JSON documents through filesystem create and replacement", async (t) => {
  const f = await fixture(t);
  const shared = { enabled: true, nullable: null };
  const values = {
    agents: { defaults: { model: "example/model" } },
    models: {
      providers: { example: { apiKey: { source: "env", provider: "default", id: "MODEL_KEY" } } },
    },
    extensions: [shared, shared, [], {}, "", false, 0, -1.5, Number.MIN_VALUE, Number.MAX_VALUE],
    options: Object.assign(Object.create(null), { enabled: true }),
    ...JSON.parse('{"__proto__":{"retained":true},"constructor":"native-field","prototype":null}'),
  };
  const expected = JSON.parse(JSON.stringify(values));
  const created = await f.controller.createConfiguration(actor, {
    namespaceId: f.namespace.id,
    kind: "agent",
    values,
  });
  shared.enabled = false;
  values.models.providers.example.apiKey.id = "CHANGED";
  assert.deepEqual(created.values, expected);
  assert.ok(Object.isFrozen(created.values.extensions[0]));
  assert.ok(Object.isFrozen(created.values.models.providers.example.apiKey));
  assert.deepEqual(
    (await f.controller.getConfiguration(actor, f.namespace.id, created.id)).values,
    expected,
  );
  assert.deepEqual(
    (await new FilesystemConfigurationDriver(f.root).read(created)).values,
    expected,
  );

  const replacement = { nested: { array: [null, true, "text", 2.5] } };
  const updated = await f.controller.updateConfiguration(actor, {
    namespaceId: f.namespace.id,
    configurationId: created.id,
    expectedGeneration: created.generation,
    values: replacement,
  });
  replacement.nested.array.push("later change");
  assert.equal(updated.generation, 2);
  assert.deepEqual(updated.values, { nested: { array: [null, true, "text", 2.5] } });
  assert.ok(Object.isFrozen(updated.values.nested.array));
  assert.deepEqual(await f.controller.getConfiguration(actor, f.namespace.id, created.id), updated);
  assert.deepEqual(await new FilesystemConfigurationDriver(f.root).read(updated), updated);
  const empty = await f.controller.updateConfiguration(actor, {
    namespaceId: f.namespace.id,
    configurationId: created.id,
    values: {},
  });
  assert.equal(empty.generation, 3);
  assert.deepEqual(
    (await f.controller.getConfiguration(actor, f.namespace.id, created.id)).values,
    {},
  );
});
