import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createNativeWorkspaceFilesAccess } from "../../apps/controller/src/gateway/workspace-files-client.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const execute = promisify(execFile);
const hash = (content) => createHash("sha256").update(content).digest("hex");

// Node loads additional TLS roots at process startup. Run the real client/API
// check in a child with only this temporary CA added; never disable TLS checks.
if (!process.env.OCC_WORKSPACE_FILES_TEST_CERT_DIR) {
  test("workspace file HTTP flow preserves native versions and conflicts over WSS", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-workspace-client-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const certificate = join(directory, "cert.pem");
    await execute("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      certificate,
    ]);
    const { stdout } = await execute(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certificate,
        NODE_TEST_CONTEXT: undefined,
        OCC_WORKSPACE_FILES_TEST_CERT_DIR: directory,
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    t.diagnostic(stdout.trim());
  });
} else {
  test("OCC routes native read, conditional save, conflict and uncertain acknowledgements", async (t) => {
    // The WSS peer supplies documented native protocol frames; this checks the
    // real GatewayClient + OCC HTTP adaptation, not the Gateway's disk writes.
    const controllerRequire = createRequire(
      new URL("../../apps/controller/package.json", import.meta.url),
    );
    const gatewayRequire = createRequire(controllerRequire.resolve("@openclaw/gateway-client"));
    const { WebSocketServer } = gatewayRequire("ws");
    const directory = process.env.OCC_WORKSPACE_FILES_TEST_CERT_DIR;
    const server = createServer({
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    });
    const websocket = new WebSocketServer({ server });
    const replies = [];
    let requests = 0;
    websocket.on("connection", (socket, request) => {
      assert.equal(request.headers["x-api-key"], "workspace-test-key");
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "workspace-test", ts: Date.now() },
        }),
      );
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.method === "connect") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                auth: { role: "operator", scopes: ["operator.admin"] },
              },
            }),
          );
          return;
        }
        requests++;
        const reply = replies.shift();
        assert.ok(reply, "Unexpected native file request");
        assert.equal(frame.method, reply.method);
        assert.deepEqual(frame.params, reply.params);
        socket.send(JSON.stringify({ type: "res", id: frame.id, ...reply.response }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const access = createNativeWorkspaceFilesAccess(() => ({
      url: `wss://127.0.0.1:${server.address().port}`,
      nativeAgentId: "main",
      apiKey: "workspace-test-key",
    }));
    const fixture = await createConsoleAppFixture(t, { workspaceFilesAccess: access });
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Workspace versions", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Editable Agent");
    await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const endpoint = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/AGENTS.md`;
    const before = "Initial instructions\n";
    const current = "Harness updated instructions\n";
    const submitted = "Owner submitted instructions\n";
    const nativeParams = { agentId: "main", name: "AGENTS.md" };
    function queueRead(content, extra = {}) {
      replies.push({
        method: "agents.files.get",
        params: nativeParams,
        response: {
          ok: true,
          payload: { file: { name: "AGENTS.md", content, ...extra } },
        },
      });
    }
    function queueWrite(params, response) {
      replies.push({
        method: "agents.files.set",
        params: { ...nativeParams, ...params },
        response,
      });
    }
    function save(body) {
      return fixture.request("PUT", endpoint, { headers: { origin: fixture.origin }, body });
    }

    // A native conflict must remain a known rejection, never become a 503 or
    // trigger a retry that could replace the Harness's newer instructions.
    queueRead(before, { hash: hash(before) });
    const read = await fixture.request("GET", endpoint);
    assert.equal(read.status, 200);
    assert.equal(read.data.hash, hash(before));
    queueWrite(
      { content: submitted, expectedHash: read.data.hash },
      {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "changed",
          details: {
            type: "agent_file_conflict",
            name: "AGENTS.md",
            currentHash: hash(current),
          },
        },
      },
    );
    const conflict = await save({ content: submitted, expectedHash: read.data.hash });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(requests, 2);

    queueRead(current, { hash: hash(current) });
    const reload = await fixture.request("GET", endpoint);
    queueWrite(
      { content: submitted, expectedHash: reload.data.hash },
      {
        ok: true,
        payload: { file: { name: "AGENTS.md", hash: hash(submitted) } },
      },
    );
    const saved = await save({ content: submitted, expectedHash: reload.data.hash });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data, {
      name: "AGENTS.md",
      size: Buffer.byteLength(submitted),
      hash: hash(submitted),
    });

    // hash is optional in the native AgentsFileEntry contract. Unversioned
    // servers keep their existing write contract; OCC must not invent a hash.
    queueRead(before);
    const unversioned = await fixture.request("GET", endpoint);
    assert.equal(unversioned.status, 200);
    assert.equal(unversioned.data.hash, undefined);
    queueWrite({ content: submitted }, { ok: true, payload: { file: { name: "AGENTS.md" } } });
    assert.equal((await save({ content: submitted })).status, 200);

    // A malformed read is unavailable. After dispatch, a versioned save with
    // an absent, invalid or different-content acknowledgement has an unknown outcome.
    queueRead(before, { hash: "invalid" });
    assert.equal((await fixture.request("GET", endpoint)).status, 503);
    for (const extra of [{}, { hash: "invalid" }, { hash: hash(current) }]) {
      queueWrite(
        { content: submitted, expectedHash: hash(before) },
        {
          ok: true,
          payload: { file: { name: "AGENTS.md", ...extra } },
        },
      );
      const uncertain = await save({ content: submitted, expectedHash: hash(before) });
      assert.equal(uncertain.status, 503);
      assert.equal(uncertain.body.error.code, "UNKNOWN_OUTCOME");
    }

    // A first save has no expected version, but a returned hash must still
    // acknowledge the submitted bytes before the Console uses it for another save.
    queueWrite(
      { content: submitted },
      { ok: true, payload: { file: { name: "AGENTS.md", hash: hash(current) } } },
    );
    const uncertainInitialSave = await save({ content: submitted });
    assert.equal(uncertainInitialSave.status, 503);
    assert.equal(uncertainInitialSave.body.error.code, "UNKNOWN_OUTCOME");

    queueWrite(
      { content: submitted },
      { ok: true, payload: { file: { name: "AGENTS.md", hash: hash(submitted).toUpperCase() } } },
    );
    assert.equal((await save({ content: submitted })).status, 200);

    // A native UNAVAILABLE response can follow a committed remote write (for
    // example, the workspace host stops before its acknowledgement arrives).
    // Explicit validation/missing rejections still have a known outcome.
    for (const code of ["UNAVAILABLE", "INVALID_REQUEST", "NOT_FOUND"]) {
      queueWrite(
        { content: submitted, expectedHash: hash(before) },
        { ok: false, error: { code, message: "Native file operation failed" } },
      );
      const beforeFailure = requests;
      const failed = await save({ content: submitted, expectedHash: hash(before) });
      assert.equal(failed.status, 503);
      assert.equal(
        failed.body.error.code,
        code === "UNAVAILABLE" ? "UNKNOWN_OUTCOME" : "DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(requests, beforeFailure + 1, "Failed writes must not be replayed");
    }
    const beforeInvalid = requests;
    assert.equal((await save({ content: submitted, expectedHash: "invalid" })).status, 400);
    assert.equal(requests, beforeInvalid);
    assert.equal(replies.length, 0);
  });
}
