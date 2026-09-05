import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot as publicSnapshot,
  loadOperationalLoggingConfiguration as publicLogging,
} from "../../apps/controller/src/composition/installation-config.ts";
import {
  loadStartupConfigurationSnapshot,
  loadOperationalLoggingConfiguration,
} from "../../apps/controller/src/composition/startup-config/read.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

async function fixture(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), "oce-startup-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "installation.yaml");
  if (contents !== undefined) await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function options(path, mode = "production") {
  return { mode, environment: { OCC_CONFIG_PATH: path } };
}

test("the extracted reader and public facade load actual YAML with identical logging", async (t) => {
  const path = await fixture(t, "logging:\n  level: debug\n");
  const snapshot = await loadStartupConfigurationSnapshot(options(path, "development"));
  assert.deepEqual(snapshot, {
    configuration: { logging: { level: "debug" } },
    logging: { level: "debug" },
  });
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(await publicSnapshot(options(path, "development")), snapshot);
  assert.deepEqual(await loadOperationalLoggingConfiguration(options(path)), snapshot.logging);
  assert.deepEqual(await publicLogging(options(path)), snapshot.logging);
  assert.equal(await loadInstallationConfiguration(options(path, "development")), undefined);
});

test("development can omit startup YAML while production snapshot requires it", async () => {
  assert.deepEqual(
    await loadStartupConfigurationSnapshot({ mode: "development", environment: {} }),
    { logging: { level: "info" } },
  );
  assert.equal(
    await loadInstallationConfiguration({ mode: "development", environment: {} }),
    undefined,
  );
  await assert.rejects(
    loadStartupConfigurationSnapshot({ mode: "production", environment: {} }),
    /OCC_CONFIG_PATH must identify/,
  );
  // The early logging reader intentionally remains usable before required production configuration admission.
  assert.deepEqual(
    await loadOperationalLoggingConfiguration({ mode: "production", environment: {} }),
    { level: "info" },
  );
});

for (const path of ["", "   ", "relative/installation.yaml"]) {
  test(`startup rejects invalid configured path ${JSON.stringify(path)}`, async () => {
    await assert.rejects(
      loadStartupConfigurationSnapshot(options(path)),
      /OCC_CONFIG_PATH must identify/,
    );
  });
}

for (const [name, contents, expected] of [
  ["unavailable file", undefined, /startup YAML is unavailable/],
  ["malformed YAML", "logging: [unterminated\n", /must contain valid YAML/],
  ["scalar YAML", "just-a-string\n", /must be one object/],
  ["array YAML", "- logging\n", /must be one object/],
  ["empty YAML", "", /must contain valid YAML/],
  ["unknown top-level key", "unknown: true\n", /unsupported option unknown/],
  ["retired integrations", "integrations: {}\n", /integrations is retired/],
  [
    "unknown logging option",
    "logging:\n  destination: stdout\n",
    /logging contains an unsupported option/,
  ],
]) {
  test(`actual startup reader rejects ${name}`, async (t) => {
    await assert.rejects(
      loadStartupConfigurationSnapshot(options(await fixture(t, contents))),
      expected,
    );
  });
}

for (const [name, nested, expected] of [
  ["Installation ID", { installationId: "caller-selected" }, /must not contain an Installation ID/],
  [
    "snake-case Installation ID",
    { installation_id: "caller-selected" },
    /must not contain an Installation ID/,
  ],
  ["unsafe integer", { count: Number.MAX_SAFE_INTEGER + 1 }, /must be a safe integer/],
  ["credential key", { password: "fixture-password" }, /must not contain a plaintext credential/],
  [
    "credential value",
    { description: "Bearer fixture-credential-value" },
    /must not contain a plaintext credential/,
  ],
  ["installation Secret reference", { secretRef: "secret-reference" }, /cannot be resolved safely/],
  ["prototype key", JSON.parse('{"__proto__":{"polluted":true}}'), /unsafe configuration key/],
]) {
  test(`startup recursively rejects ${name} inside Driver configuration arrays`, async (t) => {
    const configuration = { drivers: { compute: { configuration: { nested: [nested] } } } };
    const path = await fixture(t, JSON.stringify(configuration));
    await assert.rejects(loadStartupConfigurationSnapshot(options(path)), expected);
    assert.equal(Object.prototype.polluted, undefined);
  });
}

test("public composition consumes a captured snapshot without rereading changed YAML", async (t) => {
  const configuration = createInstallationDriverConfiguration();
  configuration.logging = { level: "warn" };
  // JSON is YAML; this goes through the real SDK parser and the bundled constructors without contacting Kubernetes.
  const path = await fixture(t, JSON.stringify(configuration));
  const startupConfiguration = await publicSnapshot(options(path));
  await writeFile(path, "broken: [\n");
  const runtime = await loadInstallationConfiguration({ ...options(path), startupConfiguration });
  assert.equal(runtime.installation.occ.cluster, "production-west");
  assert.deepEqual(runtime.installation.logging, { level: "warn" });
  assert.equal(runtime.computeDriver.id, "compute-kubernetes");
  assert.equal(runtime.computeDriver.implementation, "occ/kubernetes");
  assert.equal(runtime.configurationDriver.id, "config-kubernetes");
  assert.equal(runtime.secretDriver.id, "secret-kubernetes");
  assert.ok(Object.isFrozen(runtime.installation));
  await assert.rejects(publicSnapshot(options(path)), /must contain valid YAML/);
});

test("public composition rejects a relative trusted package root", async (t) => {
  const path = await fixture(t, JSON.stringify(createInstallationDriverConfiguration()));
  await assert.rejects(
    loadInstallationConfiguration({ ...options(path), packageRoot: "relative-root" }),
    /trusted controller package root must be absolute/,
  );
});

test("public composition resolves the default trusted root to the controller manifest", async (t) => {
  const configuration = createInstallationDriverConfiguration();
  configuration.drivers.compute.package = "@fixture/compute";
  const path = await fixture(t, JSON.stringify(configuration));
  // This valid package name is not a controller dependency. Reading a misplaced default root
  // would fail to read its manifest instead of reaching the actual dependency admission check.
  await assert.rejects(
    loadInstallationConfiguration(options(path)),
    /drivers\.compute\.package must be a direct controller production dependency/,
  );
});

for (const name of [
  "OCC_INSTALLATION_ID",
  "OCC_COMPUTE_DRIVER",
  "OCC_KUBERNETES_CONFIG_PATH",
  "OCC_NATIVE_IAM_DRIVER_ID",
]) {
  test(`public composition rejects retired environment selection ${name}`, async () => {
    await assert.rejects(
      loadInstallationConfiguration({ mode: "development", environment: { [name]: "retired" } }),
      new RegExp(`${name} is unsupported`),
    );
  });
}

for (const [name, mutate, expected] of [
  [
    "unknown occ key",
    (value) => {
      value.occ.extra = true;
    },
    /occ contains unsupported option extra/,
  ],
  [
    "unknown Driver capability",
    (value) => {
      value.drivers.extra = {};
    },
    /drivers contains unsupported option extra/,
  ],
  [
    "caller-selected implementation",
    (value) => {
      value.drivers.compute.implementation = "other/compute";
    },
    /unsupported option implementation/,
  ],
  [
    "external Secret package",
    (value) => {
      value.drivers.secret.package = "@fixture/secret";
    },
    /unsupported option package/,
  ],
  [
    "unowned ServiceAccount",
    (value) => {
      value.drivers.service_account = { id: "unowned", configuration: {} };
    },
    /requires an owning provider/,
  ],
  [
    "invalid runtime sources",
    (value) => {
      value.runtimeAuthoritySources = {};
    },
    /at most 32 protected technical sources/,
  ],
  [
    "mutable production images",
    (value) => {
      value.drivers.compute.configuration.images.requireImmutableDigest = false;
    },
    /immutable image digests/,
  ],
  [
    "missing production runtime",
    (value) => {
      delete value.drivers.compute.configuration.runtime;
    },
    /explicitly configured Codex runtime/,
  ],
]) {
  test(`public composition rejects ${name} through actual startup admission`, async (t) => {
    const configuration = createInstallationDriverConfiguration();
    mutate(configuration);
    const path = await fixture(t, JSON.stringify(configuration));
    await assert.rejects(loadInstallationConfiguration(options(path)), expected);
  });
}
