import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createServer } from "node:https";
import { createGitHubAppMaterialV1 } from "../../packages/occ/src/github-app-provider-v1/material.ts";
import {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubCustodyErrorV1,
} from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import { ProtectedGitHubTokenStoreV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-token-store.ts";
import {
  ProtectedGitHubTokenCustodyV1,
  protectedGitHubNumericIdV1,
} from "../../packages/occ/src/credential-custody-v1/protected-github-token-custody.ts";

// Real protected filesystem + cryptography + process recovery. This inert lease
// fixture is material provenance only, never an admitted Work or release grant.
function identity() {
  const scope = {
    installationRef: "ins_00000000-0000-4000-8000-000000000001",
    namespaceRef: "ns_00000000-0000-4000-8000-000000000001",
    agentRef: "agt_00000000-0000-4000-8000-000000000001",
    revisionRef: "rev_00000000-0000-4000-8000-000000000001",
  };
  return {
    lease: {
      schemaVersion: 2,
      accessLeaseRef: "lease/1",
      target: {
        installationId: scope.installationRef,
        githubHost: "github.com",
        appId: "100",
        githubInstallationId: "200",
        repositoryId: "300",
      },
      original: {
        operationRef: "original/1",
        requestDigest: "sha256:" + "a".repeat(64),
        invocationRef: "invocation/1",
        scope,
      },
      work: { workRef: "work/1", revision: 1 },
      execution: {
        attempt: {
          installationRef: scope.installationRef,
          namespaceRef: scope.namespaceRef,
          agentRef: scope.agentRef,
          conversationRef: "conversation/1",
          turnRef: "turn/1",
          attemptRef: "attempt/1",
          reservationRef: "reservation/1",
        },
        assignmentRef: "assignment/1",
        assignmentVersion: "1",
        executionIncarnationRef: "incarnation/1",
        executionGeneration: "1",
        receiverRef: "receiver/1",
        protectedOriginRef: "origin/1",
        executionProfile: { ref: "execution/profile", revision: "1" },
        predecessor: { kind: "none" },
      },
      createdAt: "2026-09-10T00:00:00.000Z",
      notAfter: "2026-09-10T00:05:00.000Z",
    },
    key: { clientId: "Iv1.synthetic", bindingRef: "key/1", immutableVersion: "version/1" },
    providerAttemptRef: "mint/1",
    tokenRef: "token/1",
    protectedRevocationRef: "revoke/1",
  };
}
async function fixture(t) {
  const parent = join(homedir(), ".cache");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "oce-github-custody-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "keys"), { mode: 0o700 });
  await mkdir(join(directory, "tokens"), { mode: 0o700 });
  const keyFile = join(directory, "keys", "key");
  const key = randomBytes(32);
  await writeFile(keyFile, key, { mode: 0o600 });
  const keySelection = { keyFile, keySHA256: createHash("sha256").update(key).digest("hex") };
  key.fill(0);
  const storeSelection = {
    kind: "persistent-posix",
    directory: join(directory, "tokens"),
    writerMode: "single",
  };
  const crypto = new ProtectedGitHubCryptoV1(keySelection);
  const store = new ProtectedGitHubTokenStoreV1(storeSelection);
  const selected = identity();
  const custody = new ProtectedGitHubTokenCustodyV1({
    identity: selected,
    crypto,
    store,
    clock: Date.now,
  });
  return { directory, keySelection, storeSelection, crypto, store, selected, custody };
}
const observation = (fields = {}) => ({
  providerAttemptRef: "mint/1",
  expiresAt: undefined,
  scopeAccepted: false,
  ...fields,
});

test("protected custody retains invalid/late tokens and recovers in another process", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("synthetic-private-provider-token-canary");
  const handle = f.custody.capture(bytes, observation());
  bytes.fill(0);
  const retained = f.custody.retain(handle);
  assert.equal(retained.observation.scopeAccepted, false);
  const files = await readdir(f.storeSelection.directory);
  assert.equal(files.length, 1);
  const encoded = await readFile(join(f.storeSelection.directory, files[0]));
  assert.equal(encoded.includes(Buffer.from("synthetic-private-provider-token-canary")), false);
  const modules = Object.fromEntries(
    ["crypto", "token-store", "token-custody"].map((name) => [
      name,
      pathToFileURL(
        join(process.cwd(), `packages/occ/src/credential-custody-v1/protected-github-${name}.ts`),
      ).href,
    ]),
  );
  const code = `
    import { ProtectedGitHubCryptoV1 } from ${JSON.stringify(modules.crypto)};
    import { ProtectedGitHubTokenStoreV1 } from ${JSON.stringify(modules["token-store"])};
    import { ProtectedGitHubTokenCustodyV1 } from ${JSON.stringify(modules["token-custody"])};
    const data = JSON.parse(process.argv[1]);
    const custody = new ProtectedGitHubTokenCustodyV1({identity:data.selected,crypto:new ProtectedGitHubCryptoV1(data.keySelection),store:new ProtectedGitHubTokenStoreV1(data.storeSelection),clock:Date.now});
    const handle = custody.recover();
    if (!handle) process.exit(2);
    process.stdout.write(JSON.stringify(custody.retain(handle)));
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      code,
      JSON.stringify({
        selected: f.selected,
        keySelection: f.keySelection,
        storeSelection: f.storeSelection,
      }),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), JSON.parse(JSON.stringify(retained)));
  assert.throws(() => f.custody.retain({}), ProtectedGitHubCustodyErrorV1);
  const other = new ProtectedGitHubTokenCustodyV1({
    identity: f.selected,
    crypto: f.crypto,
    store: f.store,
    clock: Date.now,
  });
  assert.throws(() => other.retain(handle), ProtectedGitHubCustodyErrorV1);
});

test("capture preserves its owned bytes across key-source failure before retention", async (t) => {
  const f = await fixture(t);
  await chmod(f.keySelection.keyFile, 0o644);
  const bytes = Buffer.from("synthetic-staged-canary");
  const handle = f.custody.capture(bytes, observation());
  bytes.fill(0);
  assert.throws(() => f.custody.retain(handle), ProtectedGitHubCustodyErrorV1);
  assert.deepEqual(await readdir(f.storeSelection.directory), []);
  await chmod(f.keySelection.keyFile, 0o600);
  f.custody.retain(handle);
  const recovered = new ProtectedGitHubTokenCustodyV1({
    identity: f.selected,
    crypto: f.crypto,
    store: f.store,
    clock: Date.now,
  });
  assert.ok(recovered.recover());
});

test("exact capture retries preserve original ciphertext and conflicting capture refuses", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("synthetic-repeat-canary");
  const handle = f.custody.capture(bytes, observation());
  const before = f.custody.retain(handle);
  assert.equal(f.custody.capture(bytes, observation()), handle);
  const restarted = new ProtectedGitHubTokenCustodyV1({
    identity: f.selected,
    crypto: f.crypto,
    store: f.store,
    clock: Date.now,
  });
  const retry = restarted.capture(bytes, observation());
  assert.deepEqual(restarted.retain(retry), before);
  assert.throws(
    () => f.custody.capture(Buffer.from("different-token"), observation()),
    ProtectedGitHubCustodyErrorV1,
  );
  assert.throws(
    () => f.custody.capture(bytes, observation({ scopeAccepted: true })),
    ProtectedGitHubCustodyErrorV1,
  );
  bytes.fill(0);
});

test("material store recovers interrupted pending and linked publication aliases", async (t) => {
  const f = await fixture(t);
  const handle = f.custody.capture(Buffer.from("synthetic-crash-canary"), observation());
  const before = f.custody.retain(handle);
  const [name] = await readdir(f.storeSelection.directory);
  const final = join(f.storeSelection.directory, name);
  const pending = join(f.storeSelection.directory, ".pending-" + name);
  await rename(final, pending);
  const recover = () =>
    new ProtectedGitHubTokenCustodyV1({
      identity: f.selected,
      crypto: f.crypto,
      store: f.store,
      clock: Date.now,
    });
  let resumed = recover();
  assert.deepEqual(resumed.retain(resumed.recover()), before);
  await link(final, pending);
  resumed = recover();
  assert.deepEqual(resumed.retain(resumed.recover()), before);
  assert.deepEqual(await readdir(f.storeSelection.directory), [name]);
});

test("ciphertext, observation, key and target corruption cannot yield recovered material", async (t) => {
  const f = await fixture(t);
  f.custody.capture(Buffer.from("synthetic-authenticated-canary"), observation());
  const [name] = await readdir(f.storeSelection.directory);
  const path = join(f.storeSelection.directory, name);
  const before = await readFile(path);
  const packet = JSON.parse(before.toString());
  packet.observation.scopeAccepted = true;
  await writeFile(path, JSON.stringify(packet));
  const create = (selected = f.selected, crypto = f.crypto) =>
    new ProtectedGitHubTokenCustodyV1({
      identity: selected,
      crypto,
      store: f.store,
      clock: Date.now,
    });
  assert.throws(() => create().recover(), ProtectedGitHubCustodyErrorV1);
  await writeFile(path, before);
  const wrongKey = new ProtectedGitHubCryptoV1({ ...f.keySelection, keySHA256: "0".repeat(64) });
  assert.throws(() => create(f.selected, wrongKey).recover(), ProtectedGitHubCustodyErrorV1);
  const foreign = structuredClone(f.selected);
  foreign.lease.target.repositoryId = "301";
  assert.equal(create(foreign).recover(), undefined);
});

test("provider decimal conversion rejects rounding and material store rejects ephemeral/unsafe roots", async (t) => {
  const f = await fixture(t);
  assert.equal(protectedGitHubNumericIdV1("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const value of ["0", "01", "1.0", "-1", "1e3", "9007199254740992", "9007199254740993"])
    assert.throws(() => protectedGitHubNumericIdV1(value), ProtectedGitHubCustodyErrorV1);
  assert.throws(
    () => new ProtectedGitHubTokenStoreV1({ ...f.storeSelection, directory: "/tmp" }),
    ProtectedGitHubCustodyErrorV1,
  );
  await chmod(f.storeSelection.directory, 0o755);
  assert.throws(
    () => new ProtectedGitHubTokenStoreV1(f.storeSelection),
    ProtectedGitHubCustodyErrorV1,
  );
});

test(
  "actual provider mint and restart revoke use protected custody at the external TLS adapter",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const tlsKey = join(f.directory, "tls-key");
    const tlsCert = join(f.directory, "tls-cert");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        tlsKey,
        "-out",
        tlsCert,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore", timeout: 10000 },
    );
    const cert = await readFile(tlsCert, "utf8");
    const token = "ghs_synthetic_custody_revoke_canary";
    const observed = [];
    const sockets = new Set();
    const server = createServer(
      { key: await readFile(tlsKey), cert },
      async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        observed.push({
          method: request.method,
          path: request.url,
          authorization: request.headers.authorization,
        });
        if (request.method === "POST") {
          assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {
            repository_ids: [300],
            permissions: { metadata: "read", contents: "read" },
          });
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              token,
              expires_at: new Date(Date.now() + 120000).toISOString(),
              permissions: { metadata: "read", contents: "read" },
              repositories: [{ id: 300, full_name: "fixture/repository" }],
            }),
          );
        } else {
          assert.equal(request.url, "/installation/token");
          assert.equal(request.headers.authorization, "Bearer " + token);
          response.writeHead(204);
          response.end();
        }
      },
    );
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
      ca: cert,
    };
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    // Synthetic material/currentness are isolated provider controls. The actual
    // internal storage and crypto remain intact; no State release is fabricated.
    const material = () =>
      createGitHubAppMaterialV1({
        privateKey,
        identity: f.selected.key,
        assertCurrent() {},
        clock: Date.now,
      });
    const options = {
      repositoryFullName: "fixture/repository",
      permissions: { metadata: "read", contents: "read" },
      assertDispatchCurrent() {},
      endpoint,
    };
    const provider = f.custody.createProvider({ ...options, material: material() });
    const attempt = () => ({
      providerAttemptRef: "mint/1",
      bounds: { signal: new AbortController().signal, deadline: Date.now() + 5000 },
    });
    const minted = await provider.mint(attempt());
    assert.equal(minted.kind, "minted");
    f.custody.retain(minted.material);
    assert.equal("providerCustody" in f.custody, false);
    const restarted = new ProtectedGitHubTokenCustodyV1({
      identity: f.selected,
      crypto: new ProtectedGitHubCryptoV1(f.keySelection),
      store: new ProtectedGitHubTokenStoreV1(f.storeSelection),
      clock: Date.now,
    });
    const recovered = restarted.recover();
    assert.ok(recovered);
    const cleanup = restarted.createRevocationProvider({
      providerAttemptRef: "revoke/1",
      endpoint,
      assertRevocationCurrent() {},
    });
    assert.equal("mint" in cleanup, false);
    const revoked = await cleanup.revoke(
      { ...attempt(), providerAttemptRef: "revoke/1" },
      recovered,
    );
    assert.equal(revoked.kind, "confirmed");
    assert.deepEqual(
      observed.map(({ method, path }) => ({ method, path })),
      [
        { method: "POST", path: "/app/installations/200/access_tokens" },
        { method: "DELETE", path: "/installation/token" },
      ],
    );
    // Provider confirmation never silently removes the original retained material.
    assert.ok(restarted.recover());
  },
);

test("custody runtime property replacement cannot change its fixed target or provenance", async (t) => {
  const f = await fixture(t);
  const fixed = structuredClone(f.custody.identity);
  assert.throws(() => {
    f.custody.identity = { ...fixed, providerAttemptRef: "forged/attempt" };
  }, TypeError);
  // Even an own accessor shadow cannot alter any internal material decision.
  Object.defineProperty(f.custody, "identity", {
    value: { ...fixed, providerAttemptRef: "forged/attempt" },
  });
  const handle = f.custody.capture(Buffer.from("synthetic-immutable-canary"), observation());
  assert.deepEqual(f.custody.retain(handle).identity, fixed);
  assert.throws(
    () =>
      f.custody.capture(
        Buffer.from("synthetic-immutable-canary"),
        observation({ providerAttemptRef: "forged/attempt" }),
      ),
    ProtectedGitHubCustodyErrorV1,
  );
});
