import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubAppMaterialV1 } from "../../packages/occ/src/index.ts";
import { createGitHubAppTokenIssuerV1 } from "../../packages/occ/src/index.ts";

export const keyIdentity = {
  clientId: "Iv1.fixture",
  bindingRef: "key/fixture",
  immutableVersion: "1",
};
export const selection = {
  key: keyIdentity,
  installationId: 41,
  repositories: [{ id: 73, fullName: "fixture/repository" }],
  permissions: { metadata: "read", contents: "read" },
};
export const call = (ms = 5000) => ({
  providerAttemptRef: "provider/fixture",
  bounds: { signal: new AbortController().signal, deadline: Date.now() + ms },
});

// This fixture supplies only external material, custody, and GitHub protocol
// inputs. Real provider code, RSA signing and HTTPS execute without replacement.
export async function providerFixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "github-app-provider-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const ca = await readFile(join(directory, "cert.pem"), "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const captured = new Map();
  const captureBuffers = [];
  const requests = [];
  const token = "synthetic_installation_token";
  const packet = () => ({
    token,
    expires_at: new Date(Date.now() + 3500000).toISOString(),
    permissions: { ...selection.permissions },
    repositories: [{ id: 73, full_name: "fixture/repository" }],
  });
  let respond = (_request, reply) => {
    reply.writeHead(201);
    reply.end(JSON.stringify(packet()));
  };
  let current = true;
  const material = createGitHubAppMaterialV1({
    privateKey,
    identity: keyIdentity,
    clock: Date.now,
    assertCurrent() {
      assert.ok(current);
    },
  });
  t.after(() => material.close());
  const custody = {
    capture(bytes, observation) {
      const handle = Object.freeze({});
      captureBuffers.push(bytes);
      captured.set(handle, { bytes: Buffer.from(bytes), observation });
      return handle;
    },
    async withRevocationToken(handle, _bounds, consume) {
      assert.ok(captured.has(handle), "only original handles belong to this custody owner");
      return consume(captured.get(handle).bytes);
    },
  };
  t.after(() => {
    for (const value of captured.values()) value.bytes.fill(0);
  });
  const server = createServer(
    { key: await readFile(join(directory, "key.pem")), cert: ca },
    async (request, reply) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const observed = {
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        };
        requests.push(observed);
        if (request.method !== "DELETE") {
          const [header, payload, signature] = request.headers.authorization.slice(7).split(".");
          assert.ok(
            verify(
              "sha256",
              Buffer.from(`${header}.${payload}`),
              publicKey,
              Buffer.from(signature, "base64url"),
            ),
          );
          assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, keyIdentity.clientId);
        }
        await respond(observed, reply);
      } catch {
        reply.destroy();
      }
    },
  );
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  const options = {
    selection,
    material,
    custody,
    clock: Date.now,
    endpoint: {
      kind: "local-protocol-test",
      origin: `https://127.0.0.1:${server.address().port}`,
      ca,
    },
    assertDispatchCurrent() {
      assert.ok(current);
    },
    ...overrides,
  };
  return {
    options,
    provider: createGitHubAppTokenIssuerV1(options),
    material,
    custody,
    captured,
    captureBuffers,
    requests,
    token,
    packet,
    respond(fn) {
      respond = fn;
    },
    invalidate() {
      current = false;
    },
  };
}
