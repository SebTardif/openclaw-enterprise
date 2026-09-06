import assert from "node:assert/strict";
import test from "node:test";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { DriverSelectionError } from "../../packages/occ/src/errors.ts";

// These inert Drivers exercise the real selection coordinator and lifecycle
// installation calls. They supply no account, database, or runtime authority.
function iam(id) {
  return {
    id,
    capability: "iam",
    implementation: "selection-fixture",
    async lookupIdentity() {
      throw new Error("Identity lookup is outside this selection fixture.");
    },
    async authorize() {
      throw new Error("Authorization is outside this selection fixture.");
    },
  };
}

function fixture() {
  const selection = new DriverSelection();
  const original = iam("original");
  const replacement = iam("replacement");
  selection.registerDriver(original);
  selection.registerDriver(replacement);
  selection.selectDriver("iam", original.id);
  return { selection, original, replacement };
}

function compute(id, install) {
  return {
    id,
    capability: "compute",
    implementation: "selection-fixture",
    async ensureNamespace() {},
    async deleteNamespace() {},
    async prepareRevision() {},
    async retireRevision() {},
    setLifecycleDrivers: install,
  };
}

test("a hold preserves its exact registration until explicitly released", async () => {
  const { selection, original, replacement } = fixture();
  const lease = selection.acquireGuardedSelection("iam", original);
  assert.equal(lease.capability, "iam");
  assert.deepEqual(lease.registration, {
    driver: original,
    capability: "iam",
    id: "original",
    implementation: "selection-fixture",
  });
  assert.ok(Object.isFrozen(lease));
  assert.ok(Object.isFrozen(lease.registration));
  lease.assertCurrent();
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  // An ordinary asynchronous continuation does not release the owner's hold.
  // This is process-local lifetime coverage, not a PostgreSQL COMMIT pause.
  await Promise.resolve();
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  lease.assertCurrent();
  lease.release();
  lease.release();
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
});

test("any hold blocks another capability before its lifecycle installation hook", () => {
  const { selection, original } = fixture();
  const installations = [];
  const first = compute("compute-first", (drivers) => installations.push(drivers));
  const second = compute("compute-second", (drivers) => installations.push(drivers));
  selection.registerDriver(first);
  selection.registerDriver(second);
  selection.selectDriver("compute", first.id);
  const before = installations.length;
  const lease = selection.acquireGuardedSelection("iam", original);
  assert.throws(() => selection.selectDriver("compute", second.id), DriverSelectionError);
  assert.equal(installations.length, before);
  assert.equal(selection.selectedDriver("compute"), first);
  assert.equal(selection.selectDriver("compute", first.id), first);
  assert.equal(selection.selectDriver("iam", original.id), original);
  assert.equal(installations.length, before, "exact held no-ops must not invoke hooks");
  lease.release();
  assert.equal(selection.selectDriver("compute", second.id), second);
  assert.equal(installations.length, before + 1);
  // Preserve the existing same-selection hook behavior outside a held unit.
  selection.selectDriver("compute", second.id);
  assert.equal(installations.length, before + 2);
});

test("multiple holders are independent and cannot release one another via a receiver", () => {
  const { selection, original, replacement } = fixture();
  const first = selection.acquireGuardedSelection("iam", original);
  const second = selection.acquireGuardedSelection("iam", original);
  first.release.call(second);
  assert.throws(() => first.assertCurrent(), DriverSelectionError);
  second.assertCurrent();
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  first.release();
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  second.release();
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
});

test("an explicitly captured absent capability also blocks later selection", () => {
  const { selection, original, replacement } = fixture();
  const absent = selection.acquireGuardedSelection("sandbox", undefined);
  assert.equal(absent.registration, undefined);
  absent.assertCurrent();
  const sandbox = {
    id: "sandbox-new",
    capability: "sandbox",
    implementation: "selection-fixture",
    facets: ["process"],
    async cleanup() {},
  };
  // Registration itself does not select the new Driver or run lifecycle hooks.
  selection.registerDriver(sandbox);
  assert.throws(() => selection.selectDriver("sandbox", sandbox.id), DriverSelectionError);
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  assert.equal(selection.selectDriver("iam", original.id), original);
  absent.release();
  assert.equal(selection.selectDriver("sandbox", sandbox.id), sandbox);
});

test("wrong instance, capability, absence and changed registration cannot acquire a hold", () => {
  const { selection, original, replacement } = fixture();
  for (const [capability, expected] of [
    ["iam", replacement],
    ["iam", iam(original.id)],
    ["iam", undefined],
    ["sandbox", original],
    ["invalid-capability", undefined],
  ]) {
    assert.throws(
      () => selection.acquireGuardedSelection(capability, expected),
      DriverSelectionError,
    );
  }
  original.implementation = "changed";
  assert.throws(() => selection.acquireGuardedSelection("iam", original), DriverSelectionError);
  original.implementation = "selection-fixture";
  // A failed acquisition does not leak a hold and block an explicit selection.
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
});

test("immutable registration metadata and private maps cannot be rewritten from public fields", () => {
  const { selection, original, replacement } = fixture();
  const lease = selection.acquireGuardedSelection("iam", original);
  assert.throws(() => {
    lease.registration.id = replacement.id;
  }, TypeError);
  assert.throws(() => {
    lease.registration.driver = replacement;
  }, TypeError);
  assert.throws(() => {
    lease.release = () => {};
  }, TypeError);
  selection.registry = new Map();
  selection.selections = new Map([["iam", { driver: replacement }]]);
  selection.selectionLeases = new Set();
  selection.applyingSelection = false;
  selection.applyDriverSelection = () => replacement;
  assert.equal(selection.selectedDriver("iam"), original);
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  lease.assertCurrent();
  lease.release();
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
  assert.throws(
    () => DriverSelection.prototype.acquireGuardedSelection.call({}, "iam", original),
    TypeError,
  );
});

test("observed Driver corruption invalidates a lease until owning release", () => {
  const { selection, original, replacement } = fixture();
  const lease = selection.acquireGuardedSelection("iam", original);
  original.id = "changed";
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  original.id = "original";
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  lease.release();
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
});

test("selection hooks cannot acquire a hold of the old map or reenter selection", () => {
  const { selection, original, replacement } = fixture();
  let attempts = 0;
  const driver = compute("compute-reentrant", () => {
    attempts += 1;
    assert.throws(() => selection.acquireGuardedSelection("iam", original), DriverSelectionError);
    assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  });
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  assert.equal(attempts, 1);
  const lease = selection.acquireGuardedSelection("iam", original);
  lease.assertCurrent();
  lease.release();
});

test("a failed lifecycle installation releases the transition barrier without selecting", () => {
  const { selection, original } = fixture();
  const failure = new Error("lifecycle installation failed");
  let fail = true;
  const driver = compute("compute-failing", () => {
    if (fail) throw failure;
  });
  selection.registerDriver(driver);
  assert.throws(
    () => selection.selectDriver("compute", driver.id),
    (error) => error === failure,
  );
  assert.throws(() => selection.selectedDriver("compute"), DriverSelectionError);
  const lease = selection.acquireGuardedSelection("iam", original);
  lease.assertCurrent();
  lease.release();
  fail = false;
  assert.equal(selection.selectDriver("compute", driver.id), driver);
});

test("acquisition owns its barrier before reading external Driver properties", () => {
  const { selection, original, replacement } = fixture();
  let reads = 0;
  Object.defineProperty(original, "id", {
    configurable: true,
    get() {
      reads += 1;
      assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
      return "original";
    },
  });
  const lease = selection.acquireGuardedSelection("iam", original);
  assert.ok(reads > 0);
  lease.assertCurrent();
  lease.release();
});

test("current inspection denies release and replacement during an external property read", () => {
  const { selection, original, replacement } = fixture();
  const lease = selection.acquireGuardedSelection("iam", original);
  let entered = false;
  Object.defineProperty(original, "id", {
    configurable: true,
    get() {
      if (!entered) {
        entered = true;
        lease.release();
        selection.selectDriver("iam", replacement.id);
      }
      return "original";
    },
  });
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  assert.ok(entered);
  assert.equal(selection.selectedDriver("iam"), replacement);
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
});

test("current inspection retains a nested validation failure caught by a Driver getter", () => {
  const { selection, original, replacement } = fixture();
  const lease = selection.acquireGuardedSelection("iam", original);
  let entered = false;
  Object.defineProperty(original, "id", {
    configurable: true,
    get() {
      if (!entered) {
        entered = true;
        original.implementation = "changed";
        assert.throws(() => lease.assertCurrent(), DriverSelectionError);
        original.implementation = "selection-fixture";
      }
      return "original";
    },
  });
  // Restoring the property cannot undo the real nested failed inspection.
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  assert.ok(entered);
  assert.throws(() => lease.assertCurrent(), DriverSelectionError);
  assert.throws(() => selection.selectDriver("iam", replacement.id), DriverSelectionError);
  lease.release();
  assert.equal(selection.selectDriver("iam", replacement.id), replacement);
});
