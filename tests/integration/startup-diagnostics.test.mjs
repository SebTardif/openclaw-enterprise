import assert from "node:assert/strict";
import { assertStartupFailureRecord } from "../helpers/startup-failure-record.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const databaseUrl = process.env.OCC_STARTUP_DIAGNOSTICS_DATABASE_URL;
const safeFailure = "Controller startup failed. Check the configured startup prerequisites.";
const kubeFailure = "Kubernetes client configuration is unavailable or invalid.";

function environment(configPath) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    OCC_CONFIG_PATH: configPath,
    OCC_DATABASE_URL: databaseUrl ?? "postgresql://127.0.0.1:1/unused",
    OCC_HOST: "192.0.2.10",
    OCC_PORT: "8080",
    OCC_AUTH_SECRET: "startup-diagnostics-test-auth-secret-at-least-32-bytes",
    OCC_AUTH_BASE_URL: "http://127.0.0.1:8080",
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-startup-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function launch(component, env) {
  try {
    await run(
      process.execPath,
      [`apps/controller/src/${component === "api" ? "server" : "worker"}.mjs`],
      {
        cwd: repository,
        env,
        timeout: 15_000,
      },
    );
    assert.fail("The invalid startup unexpectedly succeeded.");
  } catch (error) {
    assert.equal(error.code, 1, "Startup must terminate with failure, not time out or signal.");
    assert.equal(error.signal, null);
    return error;
  }
}

function assertOutput(result, component, marker, code, error) {
  // The entire stderr stream must be one fixed diagnostic with only the logger envelope.
  assertStartupFailureRecord(result.stderr, component, { code, error });
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
  assert.doesNotMatch(result.stdout, /"event":"listening"|"event":"worker.started"/);
}

for (const component of ["api", "worker"]) {
  test(`actual ${component} startup suppresses an unknown configuration error`, async (t) => {
    const directory = await fixture(t);
    const marker = `BENIGN_${component.toUpperCase()}_UNKNOWN_FRAGMENT_9183`;
    const path = join(directory, "installation.json");
    const configuration = createInstallationDriverConfiguration();
    configuration[marker] = "unsupported configuration option";
    await writeFile(path, JSON.stringify(configuration));
    await assert.rejects(
      loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: path } }),
      new RegExp(marker),
    );
    const result = await launch(component, environment(path));
    assertOutput(result, component, marker, "STARTUP_FAILED", safeFailure);
  });
}

test(
  "both actual production launchers reach kubeconfig validation after real PostgreSQL bootstrap",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_STARTUP_DIAGNOSTICS_DATABASE_URL to a separately migrated, empty disposable database.",
  },
  async (t) => {
    const parsed = new URL(databaseUrl);
    assert.match(parsed.pathname, /^\/openclaw_startup_[a-z0-9_]+$/);
    const directory = await fixture(t);
    const pool = new pg.Pool({ connectionString: databaseUrl });
    t.after(() => pool.end());
    const role = await pool.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(role.rows, [
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false },
    ]);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM occ.installation")).rows[0].count,
      0,
    );

    // Use the production bootstrap itself, so Installation, IAM and auth prerequisites
    // are real. Generated credentials remain in protected disposable files, never logs.
    const bootstrapConfigurationPath = join(directory, "bootstrap-installation.json");
    await writeFile(
      bootstrapConfigurationPath,
      JSON.stringify(createInstallationDriverConfiguration()),
      { mode: 0o600 },
    );
    const bootstrapped = await run(process.execPath, ["scripts/bootstrap-installation.mjs"], {
      cwd: repository,
      env: {
        ...environment(bootstrapConfigurationPath),
        OCC_BOOTSTRAP_ADMIN_EMAIL: "startup-admin@example.test",
        OCC_BOOTSTRAP_INSTALLATION_NAME: "startup-diagnostics",
        OCC_BOOTSTRAP_PASSWORD_FILE: join(directory, "admin-password"),
        OCC_BOOTSTRAP_SERVICE_KEY_FILE: join(directory, "service-key.json"),
      },
      timeout: 30_000,
    });
    assert.match(bootstrapped.stdout, /installation\.bootstrapped/);

    for (const component of ["api", "worker"]) {
      for (const scenario of ["malformed", "missing", "semantic"]) {
        await t.test(`${component}: ${scenario}`, async () => {
          const marker = `BENIGN_${component.toUpperCase()}_${scenario.toUpperCase()}_FRAGMENT_6247`;
          const kubeconfigPath = join(directory, `${marker}.yaml`);
          if (scenario === "malformed") {
            await writeFile(kubeconfigPath, `apiVersion: v1\nkind: Config\nusers: [${marker}\n`, {
              mode: 0o600,
            });
          } else if (scenario === "semantic") {
            await writeFile(
              kubeconfigPath,
              JSON.stringify({
                apiVersion: "v1",
                kind: "Config",
                clusters: [{ name: marker, cluster: {} }],
              }),
              { mode: 0o600 },
            );
          }
          const configuration = createInstallationDriverConfiguration();
          configuration.drivers.compute.configuration.authentication = {
            mode: "kubeconfig",
            kubeconfigPath,
            context: "selected",
          };
          const path = join(directory, "installation.json");
          await writeFile(path, JSON.stringify(configuration));
          const result = await launch(component, environment(path));
          // Only the real Kubernetes helper can register this category. An earlier
          // database, Installation, auth or IAM failure would instead be STARTUP_FAILED.
          assertOutput(result, component, marker, "KUBERNETES_CONFIGURATION_INVALID", kubeFailure);
          if (component === "worker") {
            // Cleanup emits exactly one safe operational record through the real worker logger.
            const lines = result.stdout.split("\n");
            assert.equal(lines.length, 2);
            assert.equal(lines[1], "");
            const { time, ...record } = JSON.parse(lines[0]);
            assert.equal(typeof time, "string");
            assert.equal(new Date(time).toISOString(), time);
            assert.deepEqual(record, {
              severity: "INFO",
              service: "occ-worker",
              event: "worker.stopped",
            });
          } else assert.equal(result.stdout, "");
        });
      }
    }
  },
);
