import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import {
  developmentBootstrapEnvironment,
  runBootstrapInstallation,
} from "../helpers/bootstrap-installation.mjs";

const databaseUrl = process.env.OCC_AUTH_FAILURE_DATABASE_URL;
const migratorUrl = process.env.OCC_AUTH_FAILURE_MIGRATOR_URL;
const repository = fileURLToPath(new URL("../..", import.meta.url));

test(
  "actual auth storage failures preserve truthful logout and keep bearer tokens out of dependency diagnostics",
  {
    skip:
      !databaseUrl && !migratorUrl
        ? "Set both OCC_AUTH_FAILURE_DATABASE_URL and OCC_AUTH_FAILURE_MIGRATOR_URL to a fresh owned loopback openclaw_auth_* database."
        : false,
  },
  async (t) => {
    assert.ok(databaseUrl && migratorUrl, "both dedicated database role URLs are required");
    const application = new URL(databaseUrl);
    const migration = new URL(migratorUrl);
    assert.ok(["127.0.0.1", "[::1]"].includes(application.hostname));
    assert.match(application.pathname, /^\/openclaw_auth_[a-z0-9_]+$/);
    assert.equal(application.host, migration.host);
    assert.equal(application.pathname, migration.pathname);
    assert.equal(application.username, "occ_app");
    assert.equal(migration.username, "occ_migrator");
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const recovery = new pg.Pool({ connectionString: migratorUrl, max: 1 });
    t.after(async () => {
      try {
        await recovery.query("GRANT SELECT, DELETE ON occ.session TO occ_app");
      } finally {
        await Promise.all([pool.end(), recovery.end()]);
      }
    });
    const role = await pool.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    assert.deepEqual(role.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM occ.installation")).rows[0].count,
      0,
      "privilege-fault regression requires a fresh dedicated database",
    );
    const artifacts = await mkdtemp(
      join(process.env.OCC_AUTH_FAILURE_ARTIFACTS ?? tmpdir(), "auth-storage-"),
    );
    await chmod(artifacts, 0o700);
    t.diagnostic(`Private test artifacts retained at ${artifacts}`);
    const environment = developmentBootstrapEnvironment({
      databaseUrl,
      directory: artifacts,
      email: `auth-${randomUUID()}@example.test`,
      password: `test-password-${randomUUID()}`,
      authSecret: `test-auth-${randomUUID()}`,
      installationName: "Authentication storage fixture",
    });
    const bootstrap = await runBootstrapInstallation(environment);
    await writeFile(join(artifacts, "bootstrap.stderr.log"), bootstrap.stderr, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(join(artifacts, "bootstrap.stdout.log"), bootstrap.stdout, {
      mode: 0o600,
      flag: "wx",
    });
    assert.equal(bootstrap.ok, true, "bootstrap must succeed; inspect private artifacts locally");

    for (const mode of ["delete", "select-signout", "select-session", "healthy"]) {
      await t.test(mode, async () => {
        const child = spawn(
          process.execPath,
          ["tests/fixtures/auth-storage-failures/child.mjs", mode],
          {
            cwd: repository,
            env: {
              ...environment,
              OCC_AUTH_FAILURE_DATABASE_URL: databaseUrl,
              OCC_AUTH_FAILURE_MIGRATOR_URL: migratorUrl,
              OCC_AUTH_SECRET: `test-auth-${randomUUID()}`,
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        const canaries = [];
        const safeMessages = [];
        const output = { stdout: [], stderr: [] };
        let bytes = 0;
        let oversized = false;
        const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
        for (const stream of ["stdout", "stderr"])
          child[stream].on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
              oversized = true;
              child.kill("SIGKILL");
            } else output[stream].push(chunk);
          });
        child.on("message", (message) => {
          if (message.kind === "canary") canaries.push(message.value);
          else safeMessages.push(message);
        });
        const status = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve(code));
        }).finally(() => clearTimeout(timeout));
        const stdout = Buffer.concat(output.stdout);
        const stderr = Buffer.concat(output.stderr);
        // Restore the owned fixture even if the child timed out before its finally block.
        await recovery.query("GRANT SELECT, DELETE ON occ.session TO occ_app");
        await writeFile(join(artifacts, `${mode}.stdout.log`), stdout, { mode: 0o600, flag: "wx" });
        await writeFile(join(artifacts, `${mode}.stderr.log`), stderr, { mode: 0o600, flag: "wx" });
        const containsBearer = canaries.some(
          (token) => stdout.includes(token) || stderr.includes(token),
        );
        const result = {
          status,
          containsBearer,
          canaryCount: canaries.length,
          oversized,
          stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
          stderrSha256: createHash("sha256").update(stderr).digest("hex"),
          messages: safeMessages,
        };
        await writeFile(
          join(artifacts, `${mode}.result.json`),
          JSON.stringify(result, null, 2) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        assert.equal(oversized, false);
        assert.equal(status, 0, `child must pass; safe phase data is in ${mode}.result.json`);
        assert.equal(canaries.length, 2);
        assert.equal(
          safeMessages.some((r) => r.kind === "result" && r.passed === true),
          true,
        );
        assert.equal(
          safeMessages.some((r) => r.kind === "restored" && r.value === true),
          true,
        );
        assert.equal(
          containsBearer,
          false,
          "synthetic session bearer must not appear in stdout or stderr",
        );
        if (mode !== "healthy") {
          assert.equal(stderr.includes('"event":"authentication.dependency-diagnostic"'), true);
          // Inspect fields, not token-shaped substrings: no upstream message/cause/SQL is retained.
          for (const line of stderr.toString("utf8").trim().split("\n").filter(Boolean)) {
            let diagnostic;
            try {
              diagnostic = JSON.parse(line);
            } catch {
              assert.fail("Dependency diagnostic was not a JSON event; inspect private artifacts.");
            }
            assert.equal(Object.keys(diagnostic).sort().join(",") === "event,level", true);
            assert.equal(["warn", "error"].includes(diagnostic.level), true);
            assert.equal(diagnostic.event === "authentication.dependency-diagnostic", true);
          }
        }
      });
    }
  },
);
