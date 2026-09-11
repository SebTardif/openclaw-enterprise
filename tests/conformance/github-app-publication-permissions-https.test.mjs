import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitHubAppMaterialV1 } from "../../packages/occ/src/github-app-provider-v1/material.ts";
import { createGitHubAppProviderV1 } from "../../packages/occ/src/github-app-provider-v1/provider.ts";

// GHC-01: real loopback TLS, RSA signing and the original sole provider.
// Fixture mechanics follow github-app-provider-v1.test.mjs. The synthetic
// custody/currentness peers are explicit protocol inputs; they do not establish
// State, Work, App-key authority, protected storage, native use or live GitHub.
const identity = Object.freeze({
  clientId: "Iv1.synthetic",
  bindingRef: "fixture/app-key",
  immutableVersion: "version/1",
});
const prPermissions = Object.freeze({ metadata: "read", pull_requests: "write" });
const expectedBody =
  '{"repository_ids":[73],"permissions":{"metadata":"read","pull_requests":"write"}}';
const attempt = (name) => ({
  providerAttemptRef: `fixture/publication/${name}`,
  bounds: { signal: new AbortController().signal, deadline: Date.now() + 5000 },
});

test(
  "GitHub App publication permissions: actual HTTPS request and returned scope",
  { timeout: 120000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), "github-publication-permissions-"));
    const sockets = new Set();
    let server;
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    });
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(home, "tls.key"),
        "-out",
        join(home, "tls.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    const ca = await readFile(join(home, "tls.crt"), "utf8");
    const tlsKey = await readFile(join(home, "tls.key"));
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let respond;
    let requests = [];
    let serverErrors = [];
    server = createServer({ key: tlsKey, cert: ca }, async (request, reply) => {
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          assert.ok(length <= 16384, "provider request exceeded fixture request bound");
          chunks.push(chunk);
        }
        const observation = {
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          encrypted: request.socket.encrypted,
        };
        requests.push(observation);
        await respond(observation, reply);
      } catch (error) {
        serverErrors.push(error);
        reply.destroy();
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const host = `127.0.0.1:${server.address().port}`;

    function fixture(st) {
      requests = [];
      serverErrors = [];
      let current = true;
      let keyCurrent = true;
      const captures = [];
      const retained = new Map();
      const revocationHandles = [];
      const token = `synthetic_publication_${randomBytes(20).toString("hex")}`;
      const material = createGitHubAppMaterialV1({
        privateKey,
        identity,
        clock: Date.now,
        assertCurrent() {
          assert.ok(keyCurrent, "synthetic immutable key lease is no longer current");
        },
      });
      const custody = {
        capture(bytes, observation) {
          const handle = Object.freeze({});
          retained.set(handle, Buffer.from(bytes));
          captures.push({
            handle,
            observation,
            // Retain the actual provider-owned argument, not a copied buffer:
            // its wipe is observable without intercepting crypto or transport.
            borrowedBytes: bytes,
            arrivedWithToken: Buffer.from(bytes).toString("utf8") === token,
          });
          return handle;
        },
        async withRevocationToken(handle, bounds, consume) {
          assert.ok(!bounds.signal.aborted && Date.now() < bounds.deadline);
          const bytes = retained.get(handle);
          assert.ok(bytes, "revocation must consume the exact captured handle");
          revocationHandles.push(handle);
          return consume(bytes);
        },
      };
      const selectionInput = {
        key: { ...identity },
        installationId: 41,
        repositories: [{ id: 73, fullName: "fixture/repository" }],
        permissions: { ...prPermissions },
      };
      const endpointInput = { kind: "local-protocol-test", origin: `https://${host}`, ca };
      const provider = createGitHubAppProviderV1({
        selection: selectionInput,
        material,
        custody,
        endpoint: endpointInput,
        clock: Date.now,
        assertDispatchCurrent() {
          assert.ok(current, "synthetic dispatch currentness was withdrawn");
        },
      });
      const packet = () => ({
        token,
        expires_at: new Date(Date.now() + 120000).toISOString(),
        permissions: { metadata: "read", pull_requests: "write" },
        repositories: [{ id: 73, full_name: "fixture/repository" }],
      });
      respond = (_request, reply) => {
        reply.writeHead(201, { "content-type": "application/json" });
        reply.end(JSON.stringify(packet()));
      };
      st.after(() => {
        material.close();
        // This is fixture cleanup only, not proof of protected-store deletion.
        for (const bytes of retained.values()) bytes.fill(0);
        retained.clear();
        assert.deepEqual(serverErrors, [], "HTTPS fixture handler must not hide failures");
      });
      return {
        provider,
        material,
        captures,
        retained,
        revocationHandles,
        token,
        packet,
        selectionInput,
        endpointInput,
        invalidate() {
          current = false;
        },
        invalidateKey() {
          keyCurrent = false;
        },
      };
    }

    async function mint(f, name) {
      const call = attempt(name);
      const result = await f.provider.mint(call);
      await f.provider.settleAttempt(result);
      assert.equal(result.providerAttemptRef, call.providerAttemptRef);
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(serverErrors, []);
      return result;
    }

    function assertMintRequest() {
      assert.equal(requests.length, 1, "mint must dispatch exactly one request");
      const request = requests[0];
      assert.equal(request.encrypted, true);
      assert.equal(request.headers.host, host);
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/app/installations/41/access_tokens");
      assert.equal(request.body, expectedBody);
      assert.deepEqual(JSON.parse(request.body), {
        repository_ids: [73],
        permissions: { metadata: "read", pull_requests: "write" },
      });
      assert.equal(request.headers["content-length"], String(Buffer.byteLength(expectedBody)));
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers.accept, "application/vnd.github+json");
      assert.equal(request.headers["x-github-api-version"], "2026-03-10");
      assert.equal(request.headers["user-agent"], "openclaw-enterprise-github-app");
      assert.equal(request.headers.connection, "close");
      assert.match(request.headers.authorization, /^Bearer /);
      const parts = request.headers.authorization.slice(7).split(".");
      assert.equal(parts.length, 3);
      assert.deepEqual(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")), {
        alg: "RS256",
        typ: "JWT",
      });
      assert.ok(
        verify(
          "sha256",
          Buffer.from(parts.slice(0, 2).join(".")),
          publicKey,
          Buffer.from(parts[2], "base64url"),
        ),
      );
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      assert.equal(claims.iss, identity.clientId);
      assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 600);
    }

    function assertCapture(f, result, scopeAccepted, returnedPermissions) {
      assert.equal(f.captures.length, 1);
      const captured = f.captures[0];
      assert.equal(result.material, captured.handle);
      assert.equal(captured.arrivedWithToken, true);
      assert.ok(captured.borrowedBytes.length > 0);
      assert.ok(
        captured.borrowedBytes.every((byte) => byte === 0),
        "the provider must wipe the token buffer passed into synchronous capture",
      );
      assert.equal(
        f.retained.get(result.material).toString("utf8"),
        f.token,
        "wiping the provider argument must preserve the independently captured token",
      );
      assert.equal(captured.observation.providerAttemptRef, result.providerAttemptRef);
      assert.equal(captured.observation.scopeAccepted, scopeAccepted);
      assert.deepEqual(captured.observation.returnedPermissions, returnedPermissions);
      assert.ok(Object.isFrozen(captured.observation));
      assert.ok(Object.isFrozen(captured.observation.returnedPermissions));
      assert.ok(!JSON.stringify({ result, observation: captured.observation }).includes(f.token));
    }

    async function assertMitigation(f, minted, name, acknowledge = true) {
      // A refused scope can still carry a live credential. Close the signing
      // lease and prove the original provider can revoke that exact retained
      // token without minting again or asking for an App JWT.
      f.material.close();
      respond = (_request, reply) => {
        if (acknowledge) {
          reply.writeHead(204);
          reply.end();
        } else reply.destroy();
      };
      const call = attempt(`${name}/revoke`);
      const result = await f.provider.revoke(call, minted.material);
      await f.provider.settleAttempt(result);
      assert.deepEqual(serverErrors, []);
      assert.equal(result.providerAttemptRef, call.providerAttemptRef);
      assert.equal(result.kind, acknowledge ? "confirmed" : "unknown");
      if (!acknowledge) assert.equal(result.nextAction, "reconcile-only");
      assert.equal(requests.length, 2, "mitigation sends one DELETE and does not replay mint");
      const request = requests[1];
      assert.equal(request.encrypted, true);
      assert.equal(request.headers.host, host);
      assert.equal(request.method, "DELETE");
      assert.equal(request.path, "/installation/token");
      assert.equal(request.body, "");
      assert.equal(request.headers["content-length"], "0");
      assert.equal(request.headers.authorization, `Bearer ${f.token}`);
      assert.equal(f.revocationHandles.length, 1);
      assert.equal(f.revocationHandles[0], minted.material);
      assert.equal(
        f.retained.get(minted.material).toString("utf8"),
        f.token,
        "provider acknowledgment is not authority to delete custody-owned bytes",
      );
      assert.ok(!JSON.stringify(result).includes(f.token));
    }

    await t.test(
      "exact PR-only mint fixes one repository, request and signer",
      { timeout: 15000 },
      async (st) => {
        const f = fixture(st);
        // Caller-owned constructor DTOs cannot change an already selected route,
        // installation, repository, grant or key identity before actual dispatch.
        f.selectionInput.installationId = 42;
        f.selectionInput.repositories[0] = { id: 74, fullName: "fixture/other" };
        f.selectionInput.permissions.contents = "write";
        f.selectionInput.permissions.pull_requests = "read";
        f.selectionInput.key.clientId = "Iv1.changed";
        f.endpointInput.origin = "https://127.0.0.1:1";
        f.endpointInput.ca = "";
        const result = await mint(f, "exact");
        assert.equal(result.kind, "minted");
        assert.ok(Date.parse(result.expiresAt) > Date.now());
        assertMintRequest();
        assertCapture(f, result, true, prPermissions);
        await assertMitigation(f, result, "exact");
      },
    );

    const refusedScopes = [
      [
        "missing-metadata",
        (p) => {
          delete p.permissions.metadata;
        },
        { pull_requests: "write" },
      ],
      [
        "missing-pr-grant",
        (p) => {
          delete p.permissions.pull_requests;
        },
        { metadata: "read" },
      ],
      [
        "weaker-pr-grant",
        (p) => {
          p.permissions.pull_requests = "read";
        },
        { metadata: "read", pull_requests: "read" },
      ],
      [
        "changed-metadata-grant",
        (p) => {
          p.permissions.metadata = "write";
        },
        { metadata: "write", pull_requests: "write" },
      ],
      [
        "extra-contents-read",
        (p) => {
          p.permissions.contents = "read";
        },
        { ...prPermissions, contents: "read" },
      ],
      [
        "extra-contents-write",
        (p) => {
          p.permissions.contents = "write";
        },
        { ...prPermissions, contents: "write" },
      ],
      [
        "extra-administration",
        (p) => {
          p.permissions.administration = "read";
        },
        { ...prPermissions, administration: "read" },
      ],
      [
        "missing-permissions",
        (p) => {
          delete p.permissions;
        },
        { kind: "unavailable" },
      ],
      [
        "malformed-permission-grant",
        (p) => {
          p.permissions.pull_requests = true;
        },
        { kind: "unavailable" },
      ],
      [
        "permissions-array",
        (p) => {
          p.permissions = ["metadata", "pull_requests"];
        },
        { kind: "unavailable" },
      ],
      [
        "missing-repositories",
        (p) => {
          delete p.repositories;
        },
        prPermissions,
      ],
      [
        "empty-repositories",
        (p) => {
          p.repositories = [];
        },
        prPermissions,
      ],
      [
        "changed-repository-id",
        (p) => {
          p.repositories[0].id = 74;
        },
        prPermissions,
      ],
      [
        "changed-repository-name",
        (p) => {
          p.repositories[0].full_name = "fixture/other";
        },
        prPermissions,
      ],
      [
        "extra-repository",
        (p) => {
          p.repositories.push({ id: 74, full_name: "fixture/other" });
        },
        prPermissions,
      ],
      [
        "duplicate-repository",
        (p) => {
          p.repositories.push({ ...p.repositories[0] });
        },
        prPermissions,
      ],
    ];
    for (const [name, alter, returnedPermissions] of refusedScopes) {
      await t.test(
        `${name}: refuse returned scope and revoke retained token`,
        { timeout: 15000 },
        async (st) => {
          const f = fixture(st);
          respond = (_request, reply) => {
            const packet = f.packet();
            alter(packet);
            reply.writeHead(201, { "content-type": "application/json" });
            reply.end(JSON.stringify(packet));
          };
          const result = await mint(f, name);
          assert.equal(result.kind, "unknown");
          assert.equal(result.nextAction, "reconcile-only");
          assertMintRequest();
          assertCapture(f, result, false, returnedPermissions);
          await assertMitigation(f, result, name);
        },
      );
    }

    await t.test(
      "scope-refused token with lost DELETE acknowledgment stays retained and unknown",
      { timeout: 15000 },
      async (st) => {
        const f = fixture(st);
        respond = (_request, reply) => {
          const packet = f.packet();
          packet.permissions.contents = "write";
          reply.writeHead(201);
          reply.end(JSON.stringify(packet));
        };
        const result = await mint(f, "lost-revoke-ack");
        assert.equal(result.kind, "unknown");
        assert.equal(result.nextAction, "reconcile-only");
        assertMintRequest();
        assertCapture(f, result, false, { ...prPermissions, contents: "write" });
        await assertMitigation(f, result, "lost-revoke-ack", false);
      },
    );

    for (const [name, invalidate] of [
      ["dispatch-currentness", (f) => f.invalidate()],
      ["immutable-key-currentness", (f) => f.invalidateKey()],
    ]) {
      await t.test(
        `${name}: denial before PR mint emits no provider request`,
        { timeout: 10000 },
        async (st) => {
          const f = fixture(st);
          invalidate(f);
          const result = await mint(f, `early-${name}`);
          assert.equal(result.kind, "not-dispatched");
          assert.equal(requests.length, 0);
          assert.equal(f.captures.length, 0);
        },
      );
      await t.test(
        `${name}: loss during PR response retains token without accepting mint`,
        { timeout: 10000 },
        async (st) => {
          const f = fixture(st);
          respond = (_request, reply) => {
            invalidate(f);
            reply.writeHead(201);
            reply.end(JSON.stringify(f.packet()));
          };
          const result = await mint(f, `late-${name}`);
          assert.equal(result.kind, "unknown");
          assert.equal(result.nextAction, "reconcile-only");
          assertMintRequest();
          // scopeAccepted records the packet's exact scope. The later original
          // currentness failure still prevents a minted result and retains bytes.
          assertCapture(f, result, true, prPermissions);
          assert.equal(requests.length, 1);
        },
      );
    }
  },
);
