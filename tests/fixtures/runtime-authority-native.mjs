import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { runtimeServiceTrustDigest } from "../../packages/occ/src/index.ts";
import { startRuntimeAuthorityReadback } from "../../apps/controller/src/composition/runtime-authority-readback.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const offlineGo = {
  ...process.env,
  GOTOOLCHAIN: "local",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOMAXPROCS: "2",
};
let executableBuild;
let executableDirectory;

after(async () => {
  if (executableDirectory) await rm(executableDirectory, { recursive: true, force: true });
});

async function buildExecutables(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-readback-binaries-"));
  executableDirectory = directory;
  const binaryPath = join(directory, "oce-runtime-authority");
  const fixturePath = join(directory, "runtime-authority-service");
  // Build actual checked-in Go code. The fixture supplies generated credentials
  // and real TLS only; no executable or context factory grants a synthetic role.
  for (const [output, source] of [
    [binaryPath, "./cmd/oce-runtime-authority"],
    [fixturePath, "../../tests/fixtures/runtime-authority-service/main.go"],
  ]) {
    const started = performance.now();
    await execute(
      "go",
      ["build", "-p=2", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", output, source],
      {
        cwd: join(root, "components/runtime-security"),
        env: offlineGo,
        timeout: 120_000,
      },
    );
    const before = await stat(output);
    const digest = createHash("sha256")
      .update(await readFile(output))
      .digest("hex");
    t.diagnostic(
      `Built ${source} in ${(performance.now() - started).toFixed(1)}ms: mode ${(before.mode & 0o777).toString(8)}, sha256:${digest}; protecting fixture artifact mode 555`,
    );
    await chmod(output, 0o555);
  }
  const nativeExecutableSha256 = `sha256:${createHash("sha256")
    .update(await readFile(binaryPath))
    .digest("hex")}`;
  return Object.freeze({ binaryPath, fixturePath, nativeExecutableSha256 });
}

async function testExecutables(t) {
  // Publish both real binaries only after both builds and artifact protection
  // succeed. Every file invocation still builds current sources with its selected
  // Go toolchain; a rejected build is never exposed as a reusable artifact.
  executableBuild ??= buildExecutables(t);
  const binaries = await executableBuild;
  const directory = await mkdtemp(join(tmpdir(), "occ-authenticated-readback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Only protected executables are shared. Configurations, negative-test copies,
  // child processes, sockets and database fixtures retain their own case lifetime.
  return { ...binaries, directory };
}

function fixtureMessages(child) {
  const queued = [];
  const waiters = new Set();
  let failure;
  const lines = createInterface({ input: child.stdout });
  function stop(error) {
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  }
  lines.on("line", (line) => {
    if (line.length > 262144) return stop(new Error("fixture message exceeded limit"));
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return stop(error);
    }
    if (value.kind === "fatal")
      return stop(new Error(`Controlled native fixture failed: ${value.error}`));
    for (const waiter of waiters) {
      if (waiter.match(value)) {
        waiters.delete(waiter);
        waiter.resolve(value);
        return;
      }
    }
    if (queued.length >= 128) return stop(new Error("fixture message queue exceeded limit"));
    queued.push(value);
  });
  child.on("error", stop);
  child.on("close", () => stop(new Error("fixture process closed before expected message")));
  return (match, timeout = 8000) => {
    const index = queued.findIndex(match);
    if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("fixture message deadline exceeded"));
      }, timeout);
      waiters.add(waiter);
    });
  };
}

async function startFixture(t, fixturePath) {
  // Only the fixture's owned temporary directory is inherited; generated keys
  // remain in memory and the production native child still receives no environment.
  const child = spawn(fixturePath, [], {
    env: { TMPDIR: tmpdir() },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const diagnostics = [];
  child.stderr.on("data", (chunk) => diagnostics.push(chunk));
  child.stdin.on("error", () => {});
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const next = fixtureMessages(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.stdin.end(`${JSON.stringify({ kind: "shutdown" })}\n`);
    const term = setTimeout(() => child.kill("SIGTERM"), 1000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    try {
      const result = await exit;
      assert.equal(result.signal, null, "fixture shutdown required a forced signal");
      assert.equal(result.code, 0);
      assert.equal(Buffer.concat(diagnostics).toString(), "");
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
      child.stdin.destroy();
    }
  });
  const ready = await next((event) => event.kind === "ready");
  assert.match(ready.goVersion, /^go1\./);
  assert.match(ready.trustBundleSha256, /^sha256:[0-9a-f]{64}$/);
  function send(command) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }
  return {
    ready,
    async change(kind) {
      const id = randomUUID();
      send({ kind, id });
      return next((event) => event.kind === "changed" && event.id === id);
    },
    request(address, raw, { alreadyFramed = false, timeoutMs = 6000 } = {}) {
      const id = randomUUID();
      const bytes = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
      const wire = alreadyFramed ? bytes : encodeFrame(bytes);
      send({ kind: "request", id, address, wireBase64: wire.toString("base64"), timeoutMs });
      return {
        id,
        sent: () => next((event) => event.kind === "sent" && event.id === id),
        result: () => next((event) => event.kind === "result" && event.id === id),
        cancel: () => send({ kind: "cancel", id }),
      };
    },
  };
}

function encodeFrame(body) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function decodedResponse(result) {
  assert.equal(result.error, undefined, "actual TLS request failed before a response");
  const wire = Buffer.from(result.wireBase64, "base64");
  assert.ok(wire.length >= 4);
  const size = wire.readUInt32BE();
  assert.ok(size > 0 && size <= 65536);
  assert.equal(wire.length, 4 + size, "response contained trailing or truncated frames");
  return JSON.parse(wire.subarray(4).toString("utf8"));
}

function protectedSource(executables, fixture) {
  return {
    schemaVersion: 1,
    sourceRef: `source/readback-${randomUUID()}`,
    workloadApiSocketPath: fixture.ready.workloadApiSocketPath,
    ownSPIFFEId: fixture.ready.ownSPIFFEId,
    recipientRef: "recipient/authenticated-history",
    recipientSPIFFEId: fixture.ready.ownSPIFFEId,
    trustDomain: fixture.ready.trustDomain,
    trustRootsRef: "roots/generated-readback-fixture",
    trustBundleSha256: fixture.ready.trustBundleSha256,
    verifierProfileRef: "verifier/native-service-peer",
    nativeExecutableSha256: executables.nativeExecutableSha256,
    transportProfileRef: "owned-child-stdio-readback-v1",
    limits: {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 30000,
      maxConnections: 1,
      requestTimeoutMs: 3000,
    },
  };
}

async function availableLoopbackAddress() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = `127.0.0.1:${listener.address().port}`;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address;
}

async function startAdmittedReadback(t, executables, { state, trust, installationId, admission }) {
  const listenAddress = await availableLoopbackAddress();
  const configPath = join(executables.directory, `selected-${randomUUID()}.json`);
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      binaryPath: executables.binaryPath,
      listenAddress,
      recipientRef: admission.profile.recipientRef,
      serviceIdentityRef: admission.configuration.serviceIdentityRef,
    }),
    { mode: 0o600 },
  );
  // Exercise the actual operator-config reader and production composition wrapper,
  // which owns the Go child. An admitted JSON record alone cannot create a context.
  const readback = await startRuntimeAuthorityReadback({
    state,
    trust,
    installationId,
    configPath,
    binaryPath: executables.binaryPath,
  });
  assert.equal(readback.address, listenAddress);
  t.after(() => readback.close());
  return readback;
}

function readRequest(operation, durationMs = 2500) {
  return {
    schemaVersion: 1,
    method: "readOperation",
    deadline: new Date(Date.now() + durationMs).toISOString(),
    operation,
  };
}

function nativeProfile(source, peerSPIFFEId) {
  return {
    ...source,
    operationPolicy: "read-operation-only-v1",
    peerSPIFFEId,
    sourceConfigurationDigest: runtimeServiceTrustDigest(source),
  };
}

async function until(check, message, milliseconds = 1500) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(15);
  }
  assert.fail(message);
}

function assertNoBytes(result) {
  assert.equal(
    Buffer.from(result.wireBase64 ?? "", "base64").length,
    0,
    "retired exchange disclosed bytes",
  );
}

async function applyManagement(f, request) {
  const response = await f.request("POST", "/v1/runtime-service-trust/operations", request);
  assert.equal(
    response.status,
    200,
    `real management admission failed: ${JSON.stringify(response.error ?? response.data)}`,
  );
  assert.equal(response.data.result, "applied");
  return response.data.record;
}

async function heldHistoryLock(t, migratorUrl, table = "runtime_authority_operations") {
  assert.ok(["runtime_authority_operations", "runtime_service_trust_records"].includes(table));
  const pool = new pg.Pool({ connectionString: migratorUrl, max: 1, connectionTimeoutMillis: 250 });
  const client = await pool.connect();
  let released = false;
  async function release() {
    if (released) return;
    released = true;
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
  }
  t.after(release);
  await client.query("BEGIN");
  await client.query(`LOCK TABLE occ.${table} IN ACCESS EXCLUSIVE MODE`);
  return {
    release,
    async retained() {
      assert.equal(
        (
          await client.query(
            "SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND mode='AccessExclusiveLock' AND granted",
          )
        ).rowCount,
        1,
      );
    },
  };
}

async function waitHistoryRead(value, table = "runtime_authority_operations") {
  let pids;
  await until(async () => {
    const result = await value.pool.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",
      [value.applicationName, `%${table}%`],
    );
    pids = result.rows.map((row) => row.pid);
    return pids.length > 0;
  }, "actual repository history SELECT never blocked on the held PostgreSQL table lock");
  return pids;
}

async function assertJoinedHistory(value, pids, table = "runtime_authority_operations") {
  await until(
    async () =>
      (await value.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=ANY($1::int[])", [pids]))
        .rowCount === 0,
    "cancelled actual PostgreSQL history backend remained after native close",
    1500,
  );
  assert.equal(value.pool.waitingCount, 0);
  assert.equal(
    (
      await value.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE $2",
        [value.applicationName, `%${table}%`],
      )
    ).rowCount,
    0,
  );
}

// Test-only process fault injection. Linux ownership and exact disposable
// executable checks identify this test's existing child; no production context,
// process adoption, or PID-based authority is created.
async function ownedNativeChildren(binaryPath) {
  assert.equal(process.platform, "linux");
  const matches = [];
  for (const entry of await readdir("/proc")) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    try {
      const status = await readFile(`/proc/${entry}/status`, "utf8");
      if (!new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(status)) continue;
      if ((await readlink(`/proc/${entry}/exe`)) === binaryPath) matches.push(Number(entry));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
  return matches;
}

async function boundedCompletion(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export {
  root,
  testExecutables,
  startFixture,
  encodeFrame,
  decodedResponse,
  protectedSource,
  availableLoopbackAddress,
  startAdmittedReadback,
  readRequest,
  nativeProfile,
  until,
  assertNoBytes,
  applyManagement,
  heldHistoryLock,
  waitHistoryRead,
  assertJoinedHistory,
  ownedNativeChildren,
  boundedCompletion,
};
