import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { PostgresPlatformState, runtimeServiceTrustDigest } from "../../packages/occ/src/index.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  technicalSource,
  signal,
} from "../fixtures/runtime-service-trust.mjs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startRuntimeAuthorityReadback } from "../../apps/controller/src/composition/runtime-authority-readback.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import { exactRuntimeAuthorityOperation } from "../../packages/occ/src/runtime-authority/repository.ts";
import { seedAuthority } from "../fixtures/runtime-authority-state/seed.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const offlineGo = { ...process.env, GOTOOLCHAIN: "local", GOPROXY: "off", GOSUMDB: "off" };
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
      ["build", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", output, source],
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
  const child = spawn(fixturePath, [], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
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

function historicalReceiptFixture(owner) {
  // Seed only existing persistence transitions. The service identity comes from
  // the real management admission receipt; this helper creates no authenticated
  // context or role. Native/registry integration below must prove access itself.
  return {
    owner,
    async commit(serviceIdentityRef) {
      const writer = {
        acceptedServiceIdentityRef: serviceIdentityRef,
        committedAt: new Date().toISOString(),
      };
      const bound = await owner.append(owner.bind, writer);
      await owner.append(owner.retire, writer);
      assert.equal((await owner.record()).authority.assignmentRecordVersion, 3);
      return { receipt: bound.receipt, exact: exactRuntimeAuthorityOperation(owner.bind) };
    },
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

test(
  "actual native validator rejects malformed trailing child output after a valid first frame",
  { timeout: 60000 },
  async (t) => {
    const binaries = await testExecutables(t);
    const source = await technicalSource({}, binaries.binaryPath);
    const profile = nativeProfile(source, "spiffe://example.test/independent-service");
    // This public validator starts no Source. Its actual Go process is the positive
    // control for the exact same framing consumer exercised by the corrupt output.
    await validateNativeRuntimeServiceProfile(binaries.binaryPath, profile, signal());
    for (const suffix of ["partial-prefix", "partial-body", "json", "oversized", "duplicate"]) {
      await t.test(suffix, async () => {
        const path = join(binaries.directory, `invalid-validator-${suffix}`);
        await copyFile(binaries.fixturePath, path);
        const digest = `sha256:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
        // Explicitly named fixture copies only emit protocol-negative output and
        // exit zero. They cannot supply an authenticated connection or context.
        await assert.rejects(
          validateNativeRuntimeServiceProfile(
            path,
            nativeProfile({ ...source, nativeExecutableSha256: digest }, profile.peerSPIFFEId),
            signal(),
          ),
        );
      });
    }
  },
);

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

async function admittedFixture(t, binaries, databaseUrl) {
  const applicationName = `occ_readback_${randomUUID()}`;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 250,
    application_name: applicationName,
  });
  t.after(() => pool.end());
  const state = new PostgresPlatformState(pool);
  const peer = await startFixture(t, binaries.fixturePath);
  const source = await technicalSource(protectedSource(binaries, peer), binaries.binaryPath);
  const f = await createRuntimeServiceTrustFixture({
    state,
    pool,
    source,
    binaryPath: binaries.binaryPath,
    nativeSourceRoot: root,
  });
  t.after(() => f.close());
  await applyManagement(f, sourceRequest(source.sourceRef));
  const admission = await applyManagement(
    f,
    serviceRequest(f, { peerSPIFFEId: peer.ready.peerSPIFFEId }),
  );
  assert.match(admission.subjectRef, /^runtime-service\/[0-9a-f-]{36}$/);
  assert.equal(admission.configuration.serviceIdentityRef, admission.subjectRef);
  assert.equal(admission.configuration.role, "lifecycle-authority");
  const history = await historicalReceiptFixture(f.owner).commit(admission.subjectRef);
  const readback = await startAdmittedReadback(t, binaries, {
    state,
    trust: f.trust,
    installationId: f.owner.installation.id,
    admission,
  });
  const value = { f, pool, state, peer, source, admission, history, readback, applicationName };
  await positiveReadback(value);
  return value;
}

async function positiveReadback(value) {
  const response = decodedResponse(
    await value.peer.request(value.readback.address, readRequest(value.history.exact)).result(),
  );
  assert.equal(response.result, "committed");
  // Network JSON has ordinary object prototypes; compare every retained value
  // after the same JSON serialization, rather than the parser's null prototype.
  assert.deepEqual(
    response.receipt,
    JSON.parse(JSON.stringify(value.history.receipt)),
    "readback did not return the exact retained original receipt",
  );
  assert.equal(
    (await value.f.owner.record()).authority.assignmentRecordVersion,
    3,
    "readback changed current state",
  );
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

const databaseUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL;
const migratorUrl = process.env.OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL;

test(
  "authenticated readback uses real child, TLS, management admission and PostgreSQL history",
  {
    skip:
      databaseUrl && migratorUrl
        ? false
        : "Select the isolated application and migrator PostgreSQL fixture URLs.",
    timeout: 180000,
  },
  async (t) => {
    const appURL = new URL(databaseUrl),
      lockURL = new URL(migratorUrl);
    assert.ok(["127.0.0.1", "[::1]"].includes(appURL.hostname));
    assert.equal(lockURL.hostname, appURL.hostname);
    assert.equal(lockURL.port, appURL.port);
    assert.equal(lockURL.pathname, appURL.pathname);
    const binaries = await testExecutables(t);
    await t.test(
      "historical exact receipt survives head advance, restart, conflicts and foreign scope",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        for (const operation of [
          { ...value.history.exact, canonicalPayloadDigest: `sha256:${"f".repeat(64)}` },
          { ...value.history.exact, operationKind: "retire" },
        ]) {
          assert.equal(
            decodedResponse(
              await value.peer.request(value.readback.address, readRequest(operation)).result(),
            ).result,
            "conflict",
          );
        }
        const foreign = await seedAuthority(value.state);
        const foreignExact = exactRuntimeAuthorityOperation(foreign.bind);
        assert.equal(
          decodedResponse(
            await value.peer.request(value.readback.address, readRequest(foreignExact)).result(),
          ).result,
          "not-visible",
        );
        const absent = { ...value.history.exact, operationRef: randomUUID() };
        assert.equal(
          decodedResponse(
            await value.peer.request(value.readback.address, readRequest(absent)).result(),
          ).result,
          "not-found",
        );
        await value.readback.close();
        await value.readback.closed;
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: value.admission,
        });
        await positiveReadback(value);
        const second = await applyManagement(
          value.f,
          serviceRequest(value.f, { peerSPIFFEId: value.peer.ready.peerSPIFFEId }),
        );
        assert.notEqual(second.subjectRef, value.admission.subjectRef);
        await value.readback.close();
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: second,
        });
        assert.equal(
          decodedResponse(
            await value.peer
              .request(value.readback.address, readRequest(value.history.exact))
              .result(),
          ).result,
          "not-visible",
        );
      },
    );
    await t.test(
      "startup rejects changed recipient, executable selection, digest and exact peer",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        await value.readback.close();
        await value.readback.closed;
        const wrongDigestPath = join(binaries.directory, `wrong-digest-${randomUUID()}`);
        await writeFile(
          wrongDigestPath,
          Buffer.concat([
            await readFile(binaries.binaryPath),
            Buffer.from("changed-test-artifact"),
          ]),
          { mode: 0o555 },
        );
        for (const mismatch of ["recipient", "selection", "digest"]) {
          const listenAddress = await availableLoopbackAddress();
          const binaryPath = mismatch === "digest" ? wrongDigestPath : binaries.binaryPath;
          const configPath = join(binaries.directory, `invalid-${mismatch}.json`);
          await writeFile(
            configPath,
            JSON.stringify({
              schemaVersion: 1,
              binaryPath: mismatch === "selection" ? binaries.fixturePath : binaryPath,
              listenAddress,
              recipientRef:
                mismatch === "recipient" ? "recipient/wrong" : value.admission.profile.recipientRef,
              serviceIdentityRef: value.admission.subjectRef,
            }),
            { mode: 0o600 },
          );
          await assert.rejects(
            startRuntimeAuthorityReadback({
              state: value.state,
              trust: value.f.trust,
              installationId: value.f.owner.installation.id,
              configPath,
              binaryPath,
            }),
          );
          if (process.platform === "linux") {
            assert.deepEqual(await ownedNativeChildren(binaryPath), []);
          }
        }
        const wrongPeer = await applyManagement(
          value.f,
          serviceRequest(value.f, {
            peerSPIFFEId: "spiffe://readback.test/service/different-reader",
          }),
        );
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: wrongPeer,
        });
        const denied = await value.peer
          .request(value.readback.address, readRequest(value.history.exact))
          .result();
        assertNoBytes(denied);
        assert.ok(
          ["tls", "write", "read"].includes(denied.error),
          "wrong exact peer did not fail actual TLS exchange",
        );
        await value.readback.close();
        value.readback = await startAdmittedReadback(t, binaries, {
          state: value.state,
          trust: value.f.trust,
          installationId: value.f.owner.installation.id,
          admission: value.admission,
        });
        await positiveReadback(value);
      },
    );
    await t.test(
      "public forged, copied and malformed inputs do not create authority",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        const request = readRequest(value.history.exact);
        const json = JSON.stringify(request);
        for (const raw of [
          "{",
          json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
          { ...request, method: "bind" },
          { ...request, role: "lifecycle-authority" },
          { ...request, deadline: new Date(Date.now() - 1000).toISOString() },
          { ...request, context: JSON.parse(JSON.stringify(value.admission)) },
          {
            ...request,
            transport: {
              connectionId: "a".repeat(32),
              exchangeId: "b".repeat(32),
              requestDigest: "sha256:" + "c".repeat(64),
            },
          },
          {
            schemaVersion: 1,
            kind: "request",
            incarnation: "a".repeat(32),
            sequence: 1,
            payloadBase64: Buffer.from(json).toString("base64"),
          },
        ])
          assertNoBytes(await value.peer.request(value.readback.address, raw).result());
        for (const wire of [
          Buffer.from([0, 1, 0, 1]),
          Buffer.concat([encodeFrame(Buffer.from(json)), encodeFrame(Buffer.from(json))]),
        ]) {
          assertNoBytes(
            await value.peer
              .request(value.readback.address, wire, { alreadyFramed: true })
              .result(),
          );
        }
        await positiveReadback(value);
      },
    );
    await t.test(
      "remote close during blocked current registry read then reconnect joins all work",
      async (t) => {
        const value = await admittedFixture(t, binaries, databaseUrl);
        const table = "runtime_service_trust_records";
        const lock = await heldHistoryLock(t, migratorUrl, table);
        try {
          const request = value.peer.request(
            value.readback.address,
            readRequest(value.history.exact, 2800),
          );
          await request.sent();
          const pids = await waitHistoryRead(value, table);
          request.cancel();
          const reconnect = value.peer.request(
            value.readback.address,
            readRequest(value.history.exact),
          );
          await boundedCompletion(
            value.readback.close(),
            2500,
            "close retained blocked current registry read",
          );
          await value.readback.closed;
          assertNoBytes(await request.result());
          assertNoBytes(await reconnect.result());
          await assertJoinedHistory(value, pids, table);
          await lock.retained();
        } finally {
          await lock.release();
          await value.readback.close();
        }
      },
    );
    for (const action of [
      "service-withdraw",
      "service-replace",
      "source-withdraw",
      "source-replace",
      "withdraw",
      "rotate-own",
      "rotate-bundle",
      "deadline",
      "remote-close-reconnect",
      "unexpected-child-loss",
    ]) {
      await t.test(
        `${action} during actual blocked history read prevents disclosure and joins`,
        async (t) => {
          const value = await admittedFixture(t, binaries, databaseUrl);
          const lock = await heldHistoryLock(t, migratorUrl);
          try {
            const request = value.peer.request(
              value.readback.address,
              readRequest(value.history.exact, action === "deadline" ? 1000 : 2800),
            );
            await request.sent();
            const pids = await waitHistoryRead(value);
            if (action === "service-withdraw") {
              await applyManagement(value.f, {
                schemaVersion: 1,
                kind: action,
                operationRef: randomUUID(),
                serviceIdentityRef: value.admission.subjectRef,
                expectedVersion: 1,
              });
            } else if (action === "service-replace") {
              await applyManagement(
                value.f,
                serviceRequest(value.f, {
                  peerSPIFFEId: value.peer.ready.peerSPIFFEId,
                  serviceIdentityRef: value.admission.subjectRef,
                  expectedVersion: 1,
                }),
              );
            } else if (action === "source-withdraw") {
              await applyManagement(value.f, {
                schemaVersion: 1,
                kind: action,
                operationRef: randomUUID(),
                sourceRef: value.source.sourceRef,
                expectedVersion: 1,
              });
            } else if (action === "source-replace") {
              await applyManagement(value.f, sourceRequest(value.source.sourceRef, 1));
            } else if (["withdraw", "rotate-own", "rotate-bundle"].includes(action)) {
              await value.peer.change(action);
            } else if (action === "unexpected-child-loss") {
              const children = await ownedNativeChildren(binaries.binaryPath);
              assert.equal(
                children.length,
                1,
                "did not identify exactly this test's existing native child",
              );
              process.kill(children[0], "SIGTERM");
              await boundedCompletion(
                value.readback.closed,
                2500,
                "unexpected native exit did not join readback work",
              );
            } else if (action === "remote-close-reconnect") {
              request.cancel();
              // Immediately drive a second real TLS handshake while the prior actual
              // blocked database read is cancelling. Closing must join every started read.
              const reconnect = value.peer.request(
                value.readback.address,
                readRequest(value.history.exact),
              );
              await value.readback.close();
              await value.readback.closed;
              assertNoBytes(await reconnect.result());
            }
            if (
              ["service-withdraw", "service-replace", "source-withdraw", "source-replace"].includes(
                action,
              )
            ) {
              // Let the real query finish: fresh registry checks at disclosure must
              // suppress its otherwise committed historical result.
              await lock.release();
              assertNoBytes(await request.result());
              await value.readback.close();
              await value.readback.closed;
            } else {
              assertNoBytes(await request.result());
              await value.readback.close();
              await value.readback.closed;
              await assertJoinedHistory(value, pids);
              await lock.retained();
              await lock.release();
            }
          } finally {
            // Release the blocker before pool cleanup even when an assertion fails.
            await lock.release();
            await value.readback.close();
          }
        },
      );
    }
  },
);
