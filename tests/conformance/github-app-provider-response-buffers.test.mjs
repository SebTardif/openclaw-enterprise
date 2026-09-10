import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as actualHttps from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

// The sole transport interposition delegates unchanged to real node:https.
// It retains the exact IncomingMessage chunk objects before the provider sees
// them, without cloning bytes, fabricating responses or changing TLS behavior.
// Requires --experimental-test-module-mocks. Import every owner only after
// installing the wrapper so the provider captures this external boundary.
let observeResponseChunk;
const request = (...args) => {
  const outgoing = actualHttps.request(...args);
  outgoing.prependListener("response", (incoming) => {
    incoming.prependListener("data", (chunk) => observeResponseChunk?.(chunk));
  });
  return outgoing;
};
mock.module("node:https", {
  namedExports: { ...actualHttps, request },
  defaultExport: { ...actualHttps.default, request },
});
const { createServer } = actualHttps;
const { ProtectedGitHubCryptoV1 } =
  await import("../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts");
const { ProtectedGitHubTokenStoreV1 } =
  await import("../../packages/occ/src/credential-custody-v1/protected-github-token-store.ts");
const { ProtectedGitHubTokenCustodyV1 } =
  await import("../../packages/occ/src/credential-custody-v1/protected-github-token-custody.ts");
const {
  createProtectedKubernetesGitHubAppMaterialV1,
  sealProtectedKubernetesGitHubAppKeyV1,
  PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
} =
  await import("../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts");

// Actual provider, protected Kubernetes material, RSA, crypto and token custody
// run unchanged. Only the external Kubernetes API and GitHub TLS endpoint are
// substituted. This inert lease supplies material provenance, never State/Work
// admission or a committed runtime release.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keyIdentity = {
  clientId: "Iv1.settlement",
  bindingRef: "key/settlement",
  immutableVersion: "version/1",
};
function provenance() {
  const scope = {
    installationRef: "ins_00000000-0000-4000-8000-000000000001",
    namespaceRef: "ns_00000000-0000-4000-8000-000000000001",
    agentRef: "agt_00000000-0000-4000-8000-000000000001",
    revisionRef: "rev_00000000-0000-4000-8000-000000000001",
  };
  return {
    lease: {
      schemaVersion: 2,
      accessLeaseRef: "lease/settlement",
      target: {
        installationId: scope.installationRef,
        githubHost: "github.com",
        appId: "100",
        githubInstallationId: "200",
        repositoryId: "300",
      },
      original: {
        operationRef: "original/settlement",
        requestDigest: `sha256:${"a".repeat(64)}`,
        invocationRef: "invocation/settlement",
        scope,
      },
      work: { workRef: "work/settlement", revision: 1 },
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
      createdAt: new Date().toISOString(),
      notAfter: new Date(Date.now() + 60000).toISOString(),
    },
    key: keyIdentity,
    providerAttemptRef: "mint/settlement",
    tokenRef: "token/settlement",
    protectedRevocationRef: "revoke/settlement",
  };
}

async function fixture(t, mode) {
  const directory = await mkdtemp(join(homedir(), ".github-response-buffers-"));
  await chmod(directory, 0o700);
  for (const name of ["keys", "tokens"]) await mkdir(join(directory, name), { mode: 0o700 });
  const master = randomBytes(32);
  const keyFile = join(directory, "keys", "master");
  await writeFile(keyFile, master, { mode: 0o600 });
  const keySelection = { keyFile, keySHA256: sha256(master) };
  const crypto = new ProtectedGitHubCryptoV1(keySelection);
  master.fill(0);
  const storeSelection = {
    kind: "persistent-posix",
    directory: join(directory, "tokens"),
    writerMode: "single",
  };
  const store = new ProtectedGitHubTokenStoreV1(storeSelection);
  const tokenIdentity = provenance();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const locator = {
    driverId: "secret-kubernetes",
    namespaceId: "ns_settlement",
    secretId: "sec_settlement",
    namespaceName: "settlement",
    namespaceUid: "namespace-uid",
    name: "github-app-key",
    key: "key",
    keyIdentity,
  };
  const pem = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  let encoded;
  try {
    encoded = sealProtectedKubernetesGitHubAppKeyV1(crypto, locator, pem);
  } finally {
    pem.fill(0);
  }
  const source = {
    ...locator,
    uid: "secret-uid",
    resourceVersion: "73",
    envelopeSHA256: sha256(encoded),
  };
  const namespace = {
    metadata: {
      name: locator.namespaceName,
      uid: locator.namespaceUid,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": locator.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": locator.namespaceId },
    },
    status: { phase: "Active" },
  };
  const secret = {
    type: "Opaque",
    immutable: true,
    metadata: {
      name: locator.name,
      namespace: locator.namespaceName,
      uid: source.uid,
      resourceVersion: source.resourceVersion,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": locator.namespaceId,
        "openclaw.dev/secret": locator.secretId,
      },
      annotations: {
        "openclaw.dev/namespace-id": locator.namespaceId,
        "openclaw.dev/secret-id": locator.secretId,
        "openclaw.dev/secret-driver-id": locator.driverId,
        "openclaw.dev/protected-material": PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
        "openclaw.dev/github-client-id": keyIdentity.clientId,
        "openclaw.dev/github-binding-ref": keyIdentity.bindingRef,
        "openclaw.dev/github-immutable-version": keyIdentity.immutableVersion,
      },
    },
    data: { key: encoded.toString("base64") },
  };
  encoded.fill(0);
  const client = {
    async readNamespace(request) {
      assert.deepEqual(request, { name: locator.namespaceName });
      return structuredClone(namespace);
    },
    async readNamespacedSecret(request) {
      assert.deepEqual(request, { namespace: locator.namespaceName, name: locator.name });
      return structuredClone(secret);
    },
  };
  const material = createProtectedKubernetesGitHubAppMaterialV1({
    client,
    source,
    crypto,
    clock: Date.now,
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
      join(directory, "tls.key"),
      "-out",
      join(directory, "tls.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const ca = await readFile(join(directory, "tls.crt"), "utf8");
  const tlsKey = await readFile(join(directory, "tls.key"));
  const requests = [];
  const chunks = [];
  const arrivedNonzero = [];
  const abort = new AbortController();
  let firstData;
  const firstReceived = new Promise((resolve) => {
    firstData = resolve;
  });
  observeResponseChunk = (chunk) => {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
    arrivedNonzero.push(chunk.some((byte) => byte !== 0));
    if (chunks.length === 1) firstData();
    // Abort while EventEmitter is delivering a real second TLS response chunk,
    // before the provider's data listener sees it. This exercises both the
    // previously retained chunk cleanup and the late-after-settled data branch.
    if (mode === "abort" && chunks.length === 2) abort.abort();
  };
  const sockets = new Set();
  const server = createServer({ key: tlsKey, cert: ca }, async (request, reply) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/app/installations/200/access_tokens");
      const [header, payload, signature] = request.headers.authorization
        .slice("Bearer ".length)
        .split(".");
      assert.equal(
        verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          pair.publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, keyIdentity.clientId);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {
        repository_ids: [300],
        permissions: { metadata: "read" },
      });
      requests.push({ method: request.method, path: request.url });
      reply.writeHead(201, { "Content-Type": "application/json" });
      const response = JSON.stringify({
        token: "disposable-provider-response-buffer-token",
        expires_at: new Date(Date.now() + 60000).toISOString(),
        permissions: { metadata: "read" },
        repositories: [{ id: 300, full_name: "fixture/repository" }],
      });
      // Wait for the actual client data event before emitting the second half;
      // TLS coalescing cannot turn this scenario into a one-chunk test.
      const split = Math.floor(response.length / 2);
      reply.write(response.slice(0, split));
      await firstReceived;
      reply.end(response.slice(split));
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
  const endpoint = {
    kind: "local-protocol-test",
    origin: `https://127.0.0.1:${server.address().port}`,
    ca,
  };
  const createProvider = () => {
    const custody = new ProtectedGitHubTokenCustodyV1({
      identity: tokenIdentity,
      crypto,
      store,
      clock: Date.now,
    });
    const provider = custody.createProvider({
      material,
      repositoryFullName: "fixture/repository",
      permissions: { metadata: "read" },
      endpoint,
      // This asserts protocol-call liveness only. No State/Work capability is
      // constructed or asserted by this isolated provider lifecycle test.
      assertDispatchCurrent(attempt) {
        assert.equal(attempt.providerAttemptRef, tokenIdentity.providerAttemptRef);
        attempt.bounds.signal.throwIfAborted();
      },
    });
    return { provider, custody };
  };
  const owned = createProvider();
  t.after(async () => {
    observeResponseChunk = undefined;
    material.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    crypto.close();
    tlsKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...owned,
    chunks,
    arrivedNonzero,
    abort,
    createProvider,
    material,
    requests,
    crypto,
    store,
    keySelection,
    storeSelection,
    tokenIdentity,
  };
}

function recoverWithNewOwners(t, f) {
  // Close the original owners before reopening the same actual protected files.
  // Recovery must read authenticated ciphertext, rather than the first owner's
  // in-process handle or a test-supplied decoded observation.
  f.material.close();
  f.store.close();
  f.crypto.close();
  const crypto = new ProtectedGitHubCryptoV1(f.keySelection);
  const store = new ProtectedGitHubTokenStoreV1(f.storeSelection);
  t.after(() => {
    store.close();
    crypto.close();
  });
  const custody = new ProtectedGitHubTokenCustodyV1({
    identity: f.tokenIdentity,
    crypto,
    store,
    clock: Date.now,
  });
  const handle = custody.recover();
  assert.ok(handle);
  return custody.retain(handle);
}

for (const mode of ["success", "abort"]) {
  test(
    `real HTTPS ${mode} wipes received chunk objects after provider settlement`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, mode);
      let result;
      try {
        result = await f.provider.mint({
          providerAttemptRef: f.tokenIdentity.providerAttemptRef,
          bounds: { signal: f.abort.signal, deadline: Date.now() + 5000 },
        });
        await f.provider.settleAttempt(result);
        assert.equal(f.requests.length, 1);
        assert.ok(f.chunks.length >= 2, "must observe separate real transport chunks");
        assert.ok(
          f.arrivedNonzero.every(Boolean),
          "the observed buffers held response bytes on arrival",
        );
        assert.ok(
          f.chunks.every((chunk) => chunk.every((byte) => byte === 0)),
          "every original response chunk must be wiped, including data delivered after abort",
        );
        if (mode === "success") {
          assert.equal(result.kind, "minted");
          assert.ok(result.material);
          const retained = f.custody.retain(result.material);
          assert.equal(retained.observation.scopeAccepted, true);
          assert.deepEqual(
            recoverWithNewOwners(t, f),
            retained,
            "wiping raw chunks must not destroy the independently protected token capture",
          );
        } else {
          assert.equal(f.abort.signal.aborted, true);
          assert.equal(result.kind, "unknown");
          assert.equal(result.nextAction, "reconcile-only");
          assert.equal(
            f.custody.recover(),
            undefined,
            "a partial response cannot produce a protected token capture",
          );
        }
      } finally {
        if (result) await f.provider.settleAttempt(result);
      }
    },
  );
}
