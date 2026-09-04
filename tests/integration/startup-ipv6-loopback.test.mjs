import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { promisify } from "node:util";

const developmentEnvironment = {
  PATH: process.env.PATH,
  NODE_ENV: "development",
  OCC_HOST: "127.0.0.1",
  OCC_PORT: "8080",
  OCC_DATABASE_URL: "postgresql://127.0.0.1:1/occ",
};

async function run(path, env) {
  try {
    await promisify(execFile)(process.execPath, [path], {
      cwd: process.cwd(),
      env: { ...developmentEnvironment, ...env },
      timeout: 10_000,
    });
    assert.fail("Startup must fail at the selected boundary.");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.equal(error.signal, null);
    return error;
  }
}

async function databaseConnectionProbe(t) {
  let connections = 0;
  // Connection observation proves configuration reachability, not database behavior.
  const listener = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  return {
    url: `postgresql://127.0.0.1:${listener.address().port}/occ`,
    connections: () => connections,
  };
}

function assertSafeServerFailure(result) {
  assert.deepEqual(JSON.parse(result.stderr), {
    event: "startup-error",
    code: "STARTUP_FAILED",
    error: "Controller startup failed. Check the configured startup prerequisites.",
  });
}

test("development startup accepts bracketed IPv6 loopback auth base URLs", async (t) => {
  const database = await databaseConnectionProbe(t);
  for (const path of ["apps/controller/src/server.mjs", "scripts/bootstrap-installation.mjs"]) {
    const result = await run(path, {
      OCC_AUTH_BASE_URL: "http://[::1]:3000",
      OCC_AUTH_SECRET: "short",
      OCC_DATABASE_URL: database.url,
    });
    assert.equal(database.connections(), 0);
    if (path === "apps/controller/src/server.mjs") assertSafeServerFailure(result);
    else {
      assert.match(result.stderr, /OCC_AUTH_SECRET/);
      assert.doesNotMatch(result.stderr, /loopback host|loopback HTTP\(S\) URL/);
    }
  }
  // Fixing the auth secret lets the real API with an IPv6 auth URL reach persistence.
  assertSafeServerFailure(
    await run("apps/controller/src/server.mjs", {
      OCC_AUTH_BASE_URL: "http://[::1]:3000",
      OCC_AUTH_SECRET: "development-auth-secret-with-at-least-32-characters",
      OCC_DATABASE_URL: database.url,
    }),
  );
  assert.equal(database.connections(), 1);
});

test("development startup still rejects nonloopback auth base URLs", async (t) => {
  const database = await databaseConnectionProbe(t);
  for (const path of ["apps/controller/src/server.mjs", "scripts/bootstrap-installation.mjs"]) {
    const result = await run(path, {
      OCC_AUTH_BASE_URL: "http://192.0.2.10:3000",
      OCC_AUTH_SECRET: "development-auth-secret-with-at-least-32-characters",
      OCC_DATABASE_URL: database.url,
    });
    assert.equal(database.connections(), 0);
    if (path === "apps/controller/src/server.mjs") assertSafeServerFailure(result);
    else assert.match(result.stderr, /loopback host|loopback HTTP\(S\) URL/);
  }
  // Changing only the nonloopback URL permits startup to advance to persistence.
  assertSafeServerFailure(
    await run("apps/controller/src/server.mjs", {
      OCC_AUTH_BASE_URL: "http://127.0.0.1:3000",
      OCC_AUTH_SECRET: "development-auth-secret-with-at-least-32-characters",
      OCC_DATABASE_URL: database.url,
    }),
  );
  assert.equal(database.connections(), 1);
});
