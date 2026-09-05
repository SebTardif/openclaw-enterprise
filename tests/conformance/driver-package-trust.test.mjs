import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createExternalDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages/loader.ts";
import { selected } from "../../apps/controller/src/composition/startup-config/schema.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { withComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const packageName = "@fixture/compute";
const fixturePath = fileURLToPath(
  new URL("../fixtures/trusted-driver-packages/compute/", import.meta.url),
);

async function fixture(t, { owner, manifest } = {}) {
  const root = await mkdtemp(join(tmpdir(), "oce-driver-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules", packageName);
  await mkdir(dirname(installed), { recursive: true });
  // Assemble a real installed package tree. This does not run installation scripts or a package manager.
  await cp(fixturePath, installed, { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(owner ?? { private: true, dependencies: { [packageName]: "1.2.3" } }),
  );
  if (manifest !== undefined) {
    const original = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    await writeFile(join(installed, "package.json"), JSON.stringify({ ...original, ...manifest }));
  }
  return { root, installed };
}

function selection(configuration = { label: "selected" }) {
  return { id: "selected-compute", package: packageName, configuration };
}

test("real compiled package preserves selected identity and explicit operation context", async (t) => {
  const { root } = await fixture(t);
  const loaded = await loadDriverPackage(selection(), "compute", root, false);
  assert.equal(loaded.implementation, "@fixture/compute@1.2.3");
  assert.ok(Object.isFrozen(loaded));
  const configured = selected(selection(), "compute", loaded.implementation, loaded.module);
  assert.deepEqual(configured, { ...selection(), implementation: loaded.implementation });
  assert.ok(Object.isFrozen(configured));
  const controller = new AbortController();
  const driver = createExternalDriver(
    loaded.module,
    configured,
    "compute",
    undefined,
    () => controller.signal,
  );
  assert.equal(driver.id, configured.id);
  assert.equal(driver.implementation, configured.implementation);
  assert.equal(driver.capability, "compute");
  assert.equal(driver.operationAbortSignal(), controller.signal);
  controller.abort();
  assert.equal(driver.operationAbortSignal().aborted, true);
});

test("absent package selection does not require an installed package root", async () => {
  assert.equal(
    await loadDriverPackage({}, "compute", "/unavailable-driver-package-root", false),
    undefined,
  );
});

test("public composition admits a real external package and enforces production lifecycle methods", async (t) => {
  const { root } = await fixture(t);
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.compute = selection();
  const options = {
    environment: {},
    packageRoot: root,
    startupConfiguration: { configuration, logging: { level: "info" } },
  };
  const runtime = await loadInstallationConfiguration({ ...options, mode: "development" });
  assert.equal(runtime.computeDriver.id, "selected-compute");
  assert.equal(runtime.computeDriver.implementation, "@fixture/compute@1.2.3");
  assert.equal(runtime.installation.drivers.compute.package, packageName);
  assert.equal(typeof runtime.computeDriver.operationAbortSignal, "function");
  assert.equal(runtime.computeDriver.operationAbortSignal(), undefined);
  const controller = new AbortController();
  await withComputeAbortSignal(controller.signal, async () => {
    assert.equal(runtime.computeDriver.operationAbortSignal(), controller.signal);
    await Promise.resolve();
    assert.equal(runtime.computeDriver.operationAbortSignal(), controller.signal);
  });
  assert.equal(runtime.computeDriver.operationAbortSignal(), undefined);
  // The fixture has only the base Compute contract, so it cannot satisfy production activation.
  await assert.rejects(
    loadInstallationConfiguration({ ...options, mode: "production" }),
    /Production Compute Drivers must implement activateRevision and deactivateRevision/,
  );
});

for (const [name, owner, expected] of [
  [
    "development-only dependency",
    { devDependencies: { [packageName]: "1.2.3" } },
    /direct controller production dependency/,
  ],
  [
    "optional-only dependency",
    { optionalDependencies: { [packageName]: "1.2.3" } },
    /direct controller production dependency/,
  ],
  ["missing dependency", {}, /direct controller production dependency/],
  [
    "blank dependency",
    { dependencies: { [packageName]: " " } },
    /direct controller production dependency/,
  ],
  [
    "range dependency",
    { dependencies: { [packageName]: "^1.2.3" } },
    /exact installed production version/,
  ],
  [
    "mismatched version",
    { dependencies: { [packageName]: "1.2.4" } },
    /exact installed production version/,
  ],
]) {
  test(`real package admission rejects ${name}`, async (t) => {
    const { root } = await fixture(t, { owner });
    await assert.rejects(loadDriverPackage(selection(), "compute", root, false), expected);
  });
}

test("fixture tarball versions require the explicit fixture allowance", async (t) => {
  const { root } = await fixture(t, {
    owner: { dependencies: { [packageName]: "file:fixture.tgz" } },
  });
  await assert.rejects(
    loadDriverPackage(selection(), "compute", root, false),
    /exact installed production version/,
  );
  assert.equal(
    (await loadDriverPackage(selection(), "compute", root, true)).implementation,
    "@fixture/compute@1.2.3",
  );
});

test("package names cannot select paths or version expressions", async (t) => {
  const { root } = await fixture(t);
  for (const name of [
    "../compute",
    "@fixture/compute@1.2.3",
    "file:compute.tgz",
    "",
    "@fixture/compute/compiled",
  ]) {
    await assert.rejects(
      loadDriverPackage({ ...selection(), package: name }, "compute", root, false),
      /one exact npm package name|nonempty string/,
    );
  }
});

test("package resolution is anchored to the selected controller root", async (t) => {
  const installedRoot = await fixture(t);
  const emptyRoot = await fixture(t);
  await rm(join(emptyRoot.root, "node_modules"), { recursive: true });
  assert.ok(await loadDriverPackage(selection(), "compute", installedRoot.root, false));
  await assert.rejects(
    loadDriverPackage(selection(), "compute", emptyRoot.root, false),
    /unavailable installed Driver package/,
  );
  await rm(join(emptyRoot.root, "package.json"));
  await assert.rejects(
    loadDriverPackage(selection(), "compute", emptyRoot.root, false),
    /cannot read the controller package manifest/,
  );
});

for (const [name, manifest, expected] of [
  ["wrong installed name", { name: "@fixture/unselected" }, /installed npm package name/],
  ["missing installed version", { version: "" }, /installed version must be a nonempty string/],
  ["missing export", { exports: null }, /exported compiled ESM entry/],
  [
    "require-only export",
    { exports: { require: "./compiled/index.mjs" } },
    /exported compiled ESM entry/,
  ],
  ["absolute export", { exports: "/compiled/index.mjs" }, /exported compiled ESM entry/],
  [
    "missing compiled file",
    { exports: "./compiled/missing.mjs" },
    /unavailable compiled ESM entry/,
  ],
  [
    "incomplete module",
    { exports: "./compiled/missing-exports.mjs" },
    /Driver validation and a factory/,
  ],
]) {
  test(`real package admission rejects ${name}`, async (t) => {
    const { root } = await fixture(t, { manifest });
    await assert.rejects(loadDriverPackage(selection(), "compute", root, false), expected);
  });
}

for (const [extension, type, accepted] of [
  ["js", "module", true],
  ["js", "commonjs", false],
  ["cjs", "module", false],
  ["ts", "module", false],
]) {
  test(`compiled entry .${extension} with type ${type} is ${accepted ? "admitted" : "rejected"}`, async (t) => {
    const { root, installed } = await fixture(t, {
      manifest: { type, exports: `./compiled/entry.${extension}` },
    });
    await cp(join(installed, "compiled/index.mjs"), join(installed, `compiled/entry.${extension}`));
    if (accepted) assert.ok(await loadDriverPackage(selection(), "compute", root, false));
    else
      await assert.rejects(
        loadDriverPackage(selection(), "compute", root, false),
        /precompiled JavaScript ESM/,
      );
  });
}

test("realpath containment rejects an exported entry symlink outside its package", async (t) => {
  const { root, installed } = await fixture(t, { manifest: { exports: "./compiled/escape.mjs" } });
  const outside = join(root, "outside.mjs");
  await cp(join(installed, "compiled/index.mjs"), outside);
  await symlink(outside, join(installed, "compiled/escape.mjs"));
  await assert.rejects(
    loadDriverPackage(selection(), "compute", root, false),
    /entry escapes its installed package root/,
  );
});

test("module import failures do not expose module error details", async (t) => {
  const { root } = await fixture(t, { manifest: { exports: "./compiled/import-failure.mjs" } });
  await assert.rejects(loadDriverPackage(selection(), "compute", root, false), (error) => {
    assert.equal(
      error.message,
      "drivers.compute.package failed to load its compiled Driver module.",
    );
    assert.doesNotMatch(error.stack, /BENIGN_DRIVER_IMPORT_FAILURE_DETAIL/);
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  });
});

for (const [entry, configuration, expected] of [
  ["open-schema", { label: "selected" }, /closed configuration schema/],
  ["unsupported-schema", { label: "selected" }, /does not match its Driver configuration schema/],
  ["index", { label: 123 }, /does not match its Driver configuration schema/],
  ["index", { label: "selected", extra: true }, /does not match its Driver configuration schema/],
  ["index", { label: "reject-semantic-value" }, /Fixture semantic validation rejected label/],
]) {
  test(`selected Driver validates the actual ${entry} module with ${JSON.stringify(configuration)}`, async (t) => {
    const { root } = await fixture(t, { manifest: { exports: `./compiled/${entry}.mjs` } });
    const loaded = await loadDriverPackage(selection(), "compute", root, false);
    assert.throws(
      () => selected(selection(configuration), "compute", loaded.implementation, loaded.module),
      expected,
    );
  });
}

for (const [result, expected] of [
  ["wrong-id", /unselected Driver identity/],
  ["wrong-implementation", /unselected Driver identity/],
  ["wrong-capability", /unselected Driver identity/],
  ["missing-method", /invalid Driver contract/],
  ["invalid-lifecycle", /invalid lifecycle Driver wiring/],
  ["null", /factory result must be one object/],
]) {
  test(`factory admission rejects an actual package returning ${result}`, async (t) => {
    const { root } = await fixture(t);
    const loaded = await loadDriverPackage(selection(), "compute", root, false);
    const configured = selected(
      selection({ label: "selected", result }),
      "compute",
      loaded.implementation,
      loaded.module,
    );
    assert.throws(() => createExternalDriver(loaded.module, configured, "compute"), expected);
  });
}
