import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createGitHubAppMaterialV1 } from "../../packages/occ/src/index.ts";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppWriteTokenIssuerV1,
} from "../../packages/occ/src/index.ts";

// Synthetic RSA/custody/currentness inputs qualify provider protocol mechanics.
// They do not authenticate an App installation, human, runtime or inventory owner.
const identity = {
  clientId: "Iv1.synthetic",
  bindingRef: "fixture/app-key",
  immutableVersion: "version/1",
};
const selection = {
  key: identity,
  installationId: 41,
  repositories: [{ id: 73, fullName: "fixture/repository" }],
  permissions: { metadata: "read", contents: "read" },
};
const call = (ms = 5000) => ({
  providerAttemptRef: "fixture/attempt",
  bounds: { signal: new AbortController().signal, deadline: Date.now() + ms },
});

for (const [profile, createIssuer, permissions] of [
  ["read", createGitHubAppTokenIssuerV1, { metadata: "read", contents: "read" }],
  [
    "write",
    createGitHubAppWriteTokenIssuerV1,
    { metadata: "read", contents: "write", pull_requests: "write" },
  ],
])
  test(
    `GitHub App ${profile} issuer: actual TLS and RSA protocol boundaries`,
    { timeout: 30000 },
    async (t) => {
      const selected = { ...selection, permissions };
      const home = await mkdtemp(join(tmpdir(), "github-provider-"));
      t.after(() => rm(home, { recursive: true, force: true }));
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
      let response;
      let requests = [];
      const sockets = new Set();
      const server = createServer({ key: tlsKey, cert: ca }, async (request, reply) => {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const observation = {
            method: request.method,
            path: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          };
          requests.push(observation);
          await response(observation, reply);
        } catch {
          reply.destroy();
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      });
      const endpoint = {
        kind: "local-protocol-test",
        origin: `https://127.0.0.1:${server.address().port}`,
        ca,
      };
      function fixture(overrides = {}) {
        requests = [];
        let current = true;
        let keyCurrent = true;
        const stored = new WeakMap();
        const captures = [];
        const material = createGitHubAppMaterialV1({
          privateKey,
          identity,
          clock: Date.now,
          assertCurrent() {
            assert.ok(keyCurrent);
          },
        });
        const custody = {
          capture(bytes, observation) {
            const handle = Object.freeze({});
            stored.set(handle, Buffer.from(bytes));
            captures.push({ handle, observation });
            return handle;
          },
          async withRevocationToken(handle, bounds, consume) {
            assert.ok(!bounds.signal.aborted);
            const bytes = stored.get(handle);
            assert.ok(bytes);
            return consume(bytes);
          },
        };
        const provider = createIssuer({
          selection: selected,
          material,
          custody,
          endpoint,
          clock: Date.now,
          assertDispatchCurrent() {
            assert.ok(current);
          },
          ...overrides,
        });
        const token = `synthetic_${randomBytes(20).toString("hex")}`;
        const packet = () => ({
          token,
          expires_at: new Date(Date.now() + 120000).toISOString(),
          permissions: { ...selected.permissions },
          repositories: selected.repositories.map((r) => ({ id: r.id, full_name: r.fullName })),
        });
        response = (_request, reply) => {
          reply.writeHead(201, { "content-type": "application/json" });
          reply.end(JSON.stringify(packet()));
        };
        return {
          provider,
          material,
          custody,
          captures,
          stored,
          token,
          packet,
          invalidate() {
            current = false;
          },
          invalidateKey() {
            keyCurrent = false;
          },
        };
      }
      await t.test(
        "mint signs selected identity, sends exact scope and captures opaque material",
        async () => {
          const f = fixture();
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "minted");
          assert.equal(requests.length, 1);
          const request = requests[0];
          assert.equal(request.path, "/app/installations/41/access_tokens");
          assert.equal(request.method, "POST");
          assert.deepEqual(JSON.parse(request.body), {
            repository_ids: [73],
            permissions: selected.permissions,
          });
          assert.equal(request.headers["x-github-api-version"], "2026-03-10");
          const parts = request.headers.authorization.slice(7).split(".");
          assert.deepEqual(JSON.parse(Buffer.from(parts[0], "base64url")), {
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
          const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
          assert.equal(claims.iss, identity.clientId);
          assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 600);
          assert.equal(f.stored.get(result.material).toString(), f.token);
          assert.ok(!JSON.stringify(result).includes(f.token));
          assert.equal(f.captures[0].observation.scopeAccepted, true);
        },
      );
      for (const [name, alter] of [
        [
          "expanded permission",
          (p) => {
            p.permissions.contents = profile === "read" ? "write" : "admin";
          },
        ],
        [
          "extra permission",
          (p) => {
            p.permissions.administration = "read";
          },
        ],
        [
          "missing permission",
          (p) => {
            delete p.permissions.contents;
          },
        ],
        [
          "wrong permission profile",
          (p) => {
            p.permissions.contents = profile === "read" ? "admin" : "read";
          },
        ],
        [
          "malformed permissions",
          (p) => {
            p.permissions = { metadata: 17 };
          },
        ],
        [
          "wrong repository name",
          (p) => {
            p.repositories[0].full_name = "fixture/other";
          },
        ],
        [
          "malformed expiry",
          (p) => {
            p.expires_at = "unparseable";
          },
        ],
        [
          "wrong repository",

          (p) => {
            p.repositories[0].id = 74;
          },
        ],
        [
          "missing repository",
          (p) => {
            delete p.repositories;
          },
        ],
        [
          "duplicate repository",
          (p) => {
            p.repositories.push(p.repositories[0]);
          },
        ],
        [
          "expired token",
          (p) => {
            p.expires_at = new Date(Date.now() - 1000).toISOString();
          },
        ],
        [
          "unbounded token expiry",
          (p) => {
            p.expires_at = new Date(Date.now() + 7200000).toISOString();
          },
        ],
      ])
        await t.test(`${name} retains token for mitigation and never accepts scope`, async () => {
          const f = fixture();
          response = (_req, res) => {
            const p = f.packet();
            alter(p);
            res.writeHead(201);
            res.end(JSON.stringify(p));
          };
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "unknown");
          assert.equal(result.nextAction, "reconcile-only");
          assert.equal(requests.length, 1);
          assert.equal(f.captures.length, 1);
          assert.equal(f.captures[0].observation.scopeAccepted, false);
          assert.equal(result.material, f.captures[0].handle);
          const returned = f.packet();
          alter(returned);
          assert.deepEqual(
            f.captures[0].observation.returnedPermissions,
            name === "malformed permissions" ? { kind: "unavailable" } : returned.permissions,
          );
          await f.provider.settleAttempt(result);
        });
      await t.test("malformed or oversized token is never released as material", async () => {
        for (const token of ["", "contains space", "contains\nnewline", "x".repeat(16385)]) {
          const f = fixture();
          response = (_request, reply) => {
            reply.writeHead(201);
            reply.end(JSON.stringify({ ...f.packet(), token }));
          };
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "unknown");
          assert.equal(f.captures.length, 0);
          assert.equal(requests.length, 1);
          await f.provider.settleAttempt(result);
        }
      });
      await t.test("lost mint acknowledgment stays unknown and sends exactly once", async () => {
        const f = fixture();
        response = (_req, res) => res.socket.destroy();
        const result = await f.provider.mint(call());
        assert.equal(result.kind, "unknown");
        assert.equal(requests.length, 1);
        assert.equal(f.captures.length, 0);
      });
      await t.test("redirect is not followed or treated as rejection", async () => {
        const f = fixture();
        response = (_req, res) => {
          res.writeHead(307, { location: "https://example.invalid/elsewhere" });
          res.end();
        };
        assert.equal((await f.provider.mint(call())).kind, "unknown");
        assert.equal(requests.length, 1);
      });
      await t.test("known provider denial contains only bounded status", async () => {
        const f = fixture();
        response = (_req, res) => {
          res.writeHead(403);
          res.end("private diagnostic must not escape");
        };
        const result = await f.provider.mint(call());
        assert.equal(result.kind, "rejected");
        assert.equal(result.status, 403);
        assert.ok(!JSON.stringify(result).includes("diagnostic"));
      });
      await t.test("bounded body and malformed response remain unknown", async () => {
        for (const body of ["{", "x".repeat(262145)]) {
          const f = fixture();
          response = (_req, res) => {
            res.writeHead(201);
            res.end(body);
          };
          assert.equal((await f.provider.mint(call())).kind, "unknown");
          assert.equal(requests.length, 1);
        }
      });
      await t.test("dispatch authority denial prevents network bytes", async () => {
        const f = fixture();
        f.invalidate();
        assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
        assert.equal(requests.length, 0);
      });
      await t.test(
        "late original authority loss preserves captured mitigation material",
        async () => {
          const f = fixture();
          response = (_req, res) => {
            f.invalidate();
            res.writeHead(201);
            res.end(JSON.stringify(f.packet()));
          };
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "unknown");
          assert.equal(result.material, f.captures[0].handle);
        },
      );
      await t.test(
        "immutable key invalidation across response await prevents accepted mint",
        async () => {
          const f = fixture();
          response = (_req, res) => {
            f.invalidateKey();
            res.writeHead(201);
            res.end(JSON.stringify(f.packet()));
          };
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "unknown");
          assert.equal(result.material, f.captures[0].handle);
        },
      );
      await t.test("abort after dispatch settles unknown without replay", async () => {
        const f = fixture();
        const controller = new AbortController();
        response = (_req, res) => {
          controller.abort();
          res.destroy();
        };
        const c = call();
        c.bounds.signal = controller.signal;
        assert.equal((await f.provider.mint(c)).kind, "unknown");
        assert.equal(requests.length, 1);
      });
      await t.test(
        "revoke uses only exact staged token; missing acknowledgment never confirms",
        async () => {
          const f = fixture();
          const minted = await f.provider.mint(call());
          assert.equal(minted.kind, "minted");
          requests = [];
          response = (req, res) => {
            assert.equal(req.path, "/installation/token");
            assert.equal(req.method, "DELETE");
            assert.equal(req.headers.authorization, `Bearer ${f.token}`);
            res.writeHead(204);
            res.end();
          };
          assert.equal((await f.provider.revoke(call(), minted.material)).kind, "confirmed");
          assert.equal(requests.length, 1);
          for (const status of [200, 401, 403, 404, 500]) {
            requests = [];
            response = (_req, res) => {
              res.writeHead(status);
              res.end();
            };
            const result = await f.provider.revoke(call(), minted.material);
            assert.equal(
              result.kind,
              "unknown",
              "only exact 204 confirms retained-token revocation",
            );
            await f.provider.settleAttempt(result);
            assert.equal(requests.length, 1);
          }

          requests = [];
          response = (_req, res) => res.socket.destroy();
          assert.equal((await f.provider.revoke(call(), minted.material)).kind, "unknown");
          assert.equal(requests.length, 1);
        },
      );
      await t.test("asynchronous dispatch assertion cannot authorize network bytes", async () => {
        const f = fixture({ assertDispatchCurrent: async () => {} });
        assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
        assert.equal(requests.length, 0);
      });
      await t.test("rejected asynchronous assertion is contained without dispatch", async () => {
        const f = fixture({
          assertDispatchCurrent: async () => {
            throw new Error("Synthetic assertion rejection");
          },
        });
        assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
        assert.equal(requests.length, 0);
        await new Promise((resolve) => setImmediate(resolve));
      });
      await t.test(
        "custody cannot fabricate revocation acknowledgment without provider execution",
        async () => {
          const f = fixture({
            custody: {
              capture() {
                return Object.freeze({});
              },
              async withRevocationToken() {
                return { kind: "confirmed", providerAttemptRef: "fixture/attempt" };
              },
            },
          });
          assert.equal((await f.provider.revoke(call(), Object.freeze({}))).kind, "not-dispatched");
          assert.equal(requests.length, 0);
        },
      );
      await t.test("revocation custody cannot execute the provider callback twice", async () => {
        const token = Buffer.from("synthetic_duplicate_callback");
        const f = fixture({
          custody: {
            capture() {
              return Object.freeze({});
            },
            async withRevocationToken(_handle, _bounds, consume) {
              await consume(token);
              return consume(token);
            },
          },
        });
        response = (_request, reply) => {
          reply.writeHead(204);
          reply.end();
        };
        assert.equal((await f.provider.revoke(call(), Object.freeze({}))).kind, "unknown");
        assert.equal(requests.length, 1);
      });
      await t.test(
        "early custody return still joins actual HTTP work and cannot confirm",
        async () => {
          const entered = Promise.withResolvers();
          const release = Promise.withResolvers();
          const f = fixture({
            custody: {
              capture() {
                return Object.freeze({});
              },
              async withRevocationToken(_handle, _bounds, consume) {
                void consume(Buffer.from("synthetic_early_custody_return"));
                return { kind: "confirmed", providerAttemptRef: "fixture/attempt" };
              },
            },
          });
          response = async (_request, reply) => {
            entered.resolve();
            await release.promise;
            reply.writeHead(204);
            reply.end();
          };
          const running = f.provider.revoke(call(), Object.freeze({}));
          await entered.promise;
          assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
          assert.equal(requests.length, 1);
          release.resolve();
          assert.equal((await running).kind, "unknown");
        },
      );
      await t.test(
        "noncooperating custody settles caller deadline and retains pending-call capacity",
        async () => {
          const pending = Promise.withResolvers();
          const f = fixture({
            custody: {
              capture() {
                return Object.freeze({});
              },
              async withRevocationToken() {
                return pending.promise;
              },
            },
          });
          const result = await f.provider.revoke(call(50), Object.freeze({}));
          assert.equal(result.kind, "not-dispatched");
          assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
          assert.equal(requests.length, 0);
          pending.reject(new Error("Synthetic custody settlement"));
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal((await f.provider.mint(call())).kind, "minted");
        },
      );
      for (const operation of ["mint", "revoke"])
        await t.test(`${operation} callback result cannot be mutated into success`, async () => {
          let observed;
          const mutate = async (result) => {
            observed = {
              kind: result.kind,
              frozen: Object.isFrozen(result),
              mutationRejected: false,
            };
            try {
              result.kind = operation === "mint" ? "minted" : "confirmed";
            } catch (error) {
              observed.mutationRejected = error instanceof TypeError;
            }
            return result;
          };
          const lease = createGitHubAppMaterialV1({
            privateKey,
            identity,
            clock: Date.now,
            assertCurrent() {},
          });
          const f = fixture(
            operation === "mint"
              ? {
                  material: {
                    close() {
                      lease.close();
                    },
                    withJwt(key, bounds, consume) {
                      return lease.withJwt(key, bounds, async (jwt, check) =>
                        mutate(await consume(jwt, check)),
                      );
                    },
                  },
                }
              : {
                  custody: {
                    capture() {
                      return Object.freeze({});
                    },
                    async withRevocationToken(_handle, _bounds, consume) {
                      return mutate(await consume(Buffer.from("synthetic_result_mutation")));
                    },
                  },
                },
          );
          response = (_request, reply) => {
            reply.writeHead(503);
            reply.end();
          };
          const result =
            operation === "mint"
              ? await f.provider.mint(call())
              : await f.provider.revoke(call(), Object.freeze({}));
          assert.deepEqual(observed, { kind: "unknown", frozen: true, mutationRejected: true });
          assert.equal(result.kind, "unknown");
          assert.equal(requests.length, 1);
        });
      await t.test("fixed-clock JWT claims obey the exact original deadline", async () => {
        const now = 1700000000000;
        const lease = createGitHubAppMaterialV1({
          privateKey,
          identity,
          clock: () => now,
          assertCurrent() {},
        });
        await lease.withJwt(
          identity,
          { signal: new AbortController().signal, deadline: now + 30000 },
          async (jwt, check) => {
            check();
            assert.deepEqual(JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")), {
              iat: now / 1000 - 60,
              exp: now / 1000 + 30,
              iss: identity.clientId,
            });
          },
        );
        lease.close();
      });
      await t.test("key closed by dispatch assertion prevents provider bytes", async () => {
        const f = fixture({
          assertDispatchCurrent() {
            f.material.close();
          },
        });
        assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
        assert.equal(requests.length, 0);
      });
      await t.test(
        "external signer lease is rechecked after asynchronous mint response",
        async () => {
          let current = true;
          const lease = createGitHubAppMaterialV1({
            privateKey,
            identity,
            clock: Date.now,
            assertCurrent() {},
          });
          const f = fixture({
            material: {
              close() {
                lease.close();
              },
              async withJwt(key, bounds, consume) {
                const jwt = await lease.withJwt(key, bounds, async (value) => value);
                return consume(jwt, () => {
                  assert.ok(current);
                });
              },
            },
          });
          response = (_request, reply) => {
            current = false;
            reply.writeHead(201);
            reply.end(JSON.stringify(f.packet()));
          };
          const result = await f.provider.mint(call());
          assert.equal(result.kind, "unknown");
          assert.equal(result.material, f.captures[0].handle);
          assert.equal(requests.length, 1);
        },
      );
      await t.test(
        "material cannot fabricate mint acknowledgment without provider execution",
        async () => {
          const f = fixture({
            material: {
              close() {},
              async withJwt() {
                return {
                  kind: "minted",
                  providerAttemptRef: "fixture/attempt",
                  material: {},
                  expiresAt: new Date().toISOString(),
                };
              },
            },
          });
          assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
          assert.equal(requests.length, 0);
        },
      );
      await t.test("material cannot invoke mint callback twice", async () => {
        const lease = createGitHubAppMaterialV1({
          privateKey,
          identity,
          clock: Date.now,
          assertCurrent() {},
        });
        const f = fixture({
          material: {
            close() {
              lease.close();
            },
            withJwt(key, bounds, consume) {
              return lease.withJwt(key, bounds, async (jwt, check) => {
                await consume(jwt, check);
                return consume(jwt, check);
              });
            },
          },
        });
        const result = await f.provider.mint(call());
        assert.equal(result.kind, "unknown");
        assert.equal(result.material, f.captures[0].handle);
        assert.equal(requests.length, 1);
      });
      await t.test(
        "noncooperating material retains its pending slot after the caller deadline",
        async () => {
          const pending = Promise.withResolvers();
          const f = fixture({
            material: {
              close() {},
              async withJwt() {
                return pending.promise;
              },
            },
          });
          assert.equal((await f.provider.mint(call(50))).kind, "not-dispatched");
          assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
          assert.equal(requests.length, 0);
          pending.reject(new Error("Synthetic material settlement"));
          await new Promise((resolve) => setImmediate(resolve));
        },
      );
      for (const operation of ["mint", "revoke"])
        await t.test(
          `${operation} synchronous owner throw still joins actual HTTP work`,
          async () => {
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            let captured;
            const f = fixture(
              operation === "mint"
                ? {
                    material: {
                      close() {},
                      withJwt(_key, _bounds, consume) {
                        void consume("synthetic.jwt.for.owner-lifetime", () => {});
                        throw new Error("Synthetic synchronous owner throw");
                      },
                    },
                  }
                : {
                    custody: {
                      capture() {
                        return Object.freeze({});
                      },
                      withRevocationToken(_handle, _bounds, consume) {
                        void consume(Buffer.from("synthetic_sync_owner_throw"));
                        throw new Error("Synthetic synchronous owner throw");
                      },
                    },
                  },
            );
            response = async (_request, reply) => {
              entered.resolve();
              await release.promise;
              reply.writeHead(operation === "mint" ? 201 : 204);
              reply.end(operation === "mint" ? JSON.stringify(f.packet()) : undefined);
            };
            const running =
              operation === "mint"
                ? f.provider.mint(call())
                : f.provider.revoke(call(), Object.freeze({}));
            await entered.promise;
            assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
            assert.equal(requests.length, 1);
            release.resolve();
            captured = await running;
            assert.equal(captured.kind, "unknown");
            if (operation === "mint") assert.equal(captured.material, f.captures[0].handle);
          },
        );
      await t.test(
        "missing current authority/key and excessive deadlines refuse before dispatch",
        async () => {
          const f = fixture();
          assert.equal((await f.provider.mint(call(31000))).kind, "not-dispatched");
          f.material.close();
          assert.equal((await f.provider.mint(call())).kind, "not-dispatched");
          assert.equal(requests.length, 0);
          assert.throws(() =>
            createIssuer({
              selection: selected,
              endpoint: { kind: "local-protocol-test", origin: "https://example.invalid", ca },
              clock: Date.now,
              material: f.material,
              custody: f.custody,
              assertDispatchCurrent() {},
            }),
          );
        },
      );
    },
  );
