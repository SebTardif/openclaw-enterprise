import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GoOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let directory;
let binaryPath;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "oce-native-bridge-"));
  binaryPath = process.env.OCC_RUNTIME_SECURITY_BINARY ?? join(directory, "oce-runtime-security");
  if (process.env.OCC_RUNTIME_SECURITY_BINARY === undefined) {
    // Compile the actual native component; these cases never replace it with a
    // scripted executable or a controller-owned reimplementation of gRPC.
    await execute(
      "go",
      ["build", "-trimpath", "-buildvcs=false", "-o", binaryPath, "./cmd/oce-runtime-security"],
      {
        cwd: join(root, "components/runtime-security"),
        timeout: 120_000,
      },
    );
  }
});

after(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

async function invokeNative(input) {
  const child = spawn(binaryPath, ["openshell"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
  const chunks = [];
  const diagnostics = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => diagnostics.push(chunk));
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks).toString(),
        stderr: Buffer.concat(diagnostics).toString(),
      }),
    );
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  return result;
}

test("native CLI rejects malformed, ambiguous, unknown, and oversized wire requests", async () => {
  for (const input of [
    "{",
    "null",
    "{} {}",
    " ".repeat(4 * 1024 * 1024 + 1),
    '{"schemaVersion":1,"schemaVersion":2,"operation":"health","gateway":{"endpoint":"127.0.0.1:9"}}',
    '{"schemaVersion":1,"Operation":"health","gateway":{"endpoint":"127.0.0.1:9"}}',
    '{"schemaVersion":1,"operation":"health","gateway":{"endpoint":"127.0.0.1:9","token":"must-not-echo"}}',
    '{"schemaVersion":1,"operation":"get","gateway":{"endpoint":"127.0.0.1:9"},"sandbox":{"name":"one","Name":"two","workspace":"default"}}',
  ]) {
    const result = await invokeNative(input);
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: 1,
      ok: false,
      error: { code: "invalid_wire_request" },
    });
  }
});

test("actual native CLI bounds incomplete stdin and exits on cancellation before EOF", async () => {
  for (const interrupted of [false, true]) {
    const child = spawn(binaryPath, ["openshell"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    const diagnostics = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => diagnostics.push(chunk));
    const result = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    const start = Date.now();
    child.stdin.write("{");
    if (interrupted) setTimeout(() => child.kill("SIGTERM"), 100);
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const { code, signal } = await result;
      assert.equal(code, 1);
      assert.equal(signal, null);
      assert.ok(Date.now() - start < 7500);
      assert.equal(Buffer.concat(diagnostics).toString(), "");
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
        schemaVersion: 1,
        ok: false,
        error: { code: interrupted ? "cancelled" : "deadline_exceeded" },
      });
    } finally {
      clearTimeout(watchdog);
      child.stdin.destroy();
    }
  }
});

test("thin controller bridge reports absent native binary explicitly", async () => {
  const client = new GoOpenShellGatewayClient({
    endpoint: "127.0.0.1:9",
    binaryPath: join(directory, "absent"),
  });
  await assert.rejects(
    client.health(new AbortController().signal),
    (error) => error.failureCode === "native_binary_missing",
  );
  client.close();
  assert.throws(
    () => new GoOpenShellGatewayClient({ endpoint: "127.0.0.1:9", binaryPath: "./native" }),
    /invalid_binary_path/,
  );
});

test("actual native configuration and credential errors cross the bridge safely", async () => {
  for (const gateway of [
    { endpoint: "https://must-not-echo@example.test" },
    { endpoint: "http://127.0.0.1:9", auth: { mode: "bearerTokenFile", path: "/must-not-echo" } },
    { endpoint: "127.0.0.1:9", requestTimeoutMs: 999 },
    { endpoint: "https://127.0.0.1:9", rootCertificatePath: "/must-not-echo/missing.pem" },
  ]) {
    const client = new GoOpenShellGatewayClient({ ...gateway, binaryPath });
    try {
      await assert.rejects(client.health(new AbortController().signal), (error) => {
        assert.match(
          error.message,
          /^OpenShell native gateway failed \((invalid_configuration|credential_read)\)\.$/,
        );
        assert.doesNotMatch(error.message, /must-not-echo/);
        return true;
      });
    } finally {
      client.close();
    }
  }
});

test("bridge bounds outgoing launch requests before starting the component", async () => {
  const client = new GoOpenShellGatewayClient({
    endpoint: "127.0.0.1:9",
    binaryPath: join(directory, "absent"),
  });
  try {
    await assert.rejects(
      client.createSandbox(
        {
          name: "test",
          workspace: "default",
          labels: {},
          annotations: {},
          spec: { command: ["x".repeat(4 * 1024 * 1024)] },
        },
        new AbortController().signal,
      ),
      (error) => error.failureCode === "invalid_wire_request",
    );
  } finally {
    client.close();
  }
});

test("real native gRPC failure is sanitized and includes only its status code", async () => {
  // Reserve and release a loopback port to obtain a real refused transport.
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const endpoint = `127.0.0.1:${listener.address().port}`;
  await new Promise((resolve) => listener.close(resolve));
  const client = new GoOpenShellGatewayClient({ endpoint, binaryPath, requestTimeoutMs: 1000 });
  try {
    await assert.rejects(client.health(new AbortController().signal), (error) => {
      assert.ok([4, 14].includes(error.code));
      assert.match(
        error.message,
        /^OpenShell native gateway failed \((gateway_rpc|deadline_exceeded)\)\.$/,
      );
      assert.doesNotMatch(error.message, /127\.0\.0\.1|connection|dial|transport/i);
      return true;
    });
  } finally {
    client.close();
  }
});

test("native process deadline, caller cancellation, and close terminate real pending gRPC work", async (t) => {
  const sockets = new Set();
  let observedConnection;
  // A silent TCP peer never completes HTTP/2 setup. It supplies no invented
  // gRPC behavior; pending native transport must obey deadline and cancellation.
  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    observedConnection?.();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => listener.close(resolve));
  });
  const endpoint = `127.0.0.1:${listener.address().port}`;
  const deadlineClient = new GoOpenShellGatewayClient({
    endpoint,
    binaryPath,
    requestTimeoutMs: 1000,
  });
  const start = Date.now();
  try {
    await assert.rejects(
      deadlineClient.health(new AbortController().signal),
      (error) => error.code === 4 || error.failureCode === "deadline_exceeded",
    );
    assert.ok(Date.now() - start < 4000);
  } finally {
    deadlineClient.close();
  }

  for (const mode of ["cancelled", "closed"]) {
    const client = new GoOpenShellGatewayClient({ endpoint, binaryPath, requestTimeoutMs: 60_000 });
    const controller = new AbortController();
    const connected = new Promise((resolve) => {
      observedConnection = resolve;
    });
    const pending = client.health(controller.signal);
    const rejected = assert.rejects(pending, (error) => error.failureCode === mode);
    await connected;
    const stopTime = Date.now();
    if (mode === "cancelled") controller.abort(new Error("must-not-echo"));
    else client.close();
    await rejected;
    assert.ok(Date.now() - stopTime < 2000);
    client.close();
    await assert.rejects(
      client.health(new AbortController().signal),
      (error) => error.failureCode === "closed",
    );
  }
});
